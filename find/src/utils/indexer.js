'use strict';
/**
 * 本机文件索引器（零依赖）
 *
 * 两级实现，原生优先、JS 兜底：
 *   - **原生（推荐）**：src/native/findidx.exe（C + Win32 FindFirstFileW + 多线程），
 *     一次系统调用拿全元数据、\\?\ 长路径、无 JS 开销 —— 实测 19 万条约 1.3 秒。
 *     由 Node 以子进程方式调用，产出与本文件 saveCache 完全一致的 TSV。
 *   - **JS 兜底**：本文件内的 buildIndex()，纯 Node 遍历（readdir + 并发 stat）。
 *     exe 不存在（未编译/其他平台）或执行失败时自动回退，行为一致。
 *
 * 三层成本控制（两版共用同一套规则）：
 *   1. 跳过名单：node_modules / .git / AppData / Windows / Program Files 等噪声目录整棵跳过
 *   2. 双上限：最大深度 12 层 + 最大条目 25 万条，超限即停并标记 truncated
 *   3. 磁盘缓存：cache/index.tsv，TTL 默认 6 小时；服务启动即后台预热，查询零等待
 *
 * 索引条目只记 4 个字段（路径/大小/mtime/是否目录），TSV 存储足够紧凑。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const logger = require('./logger');

const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'index.tsv');
const NATIVE_EXE = path.join(__dirname, '..', 'native', 'findidx.exe');
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;   // 6 小时
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ENTRIES = 250000;
const STAT_CHUNK = 64;                        // 并发 stat 分块大小
const NATIVE_TIMEOUT_MS = 10 * 60 * 1000;     // 原生索引器超时上限

/** 目录跳过名单（任意层级命中即整棵跳过，含 junction 循环源与包管理器缓存） */
const SKIP_DIRS = new Set([
  // 开发噪声
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.idea', '.vs', '.gradle', '.m2', '.nuget', '.npm', '.yarn', '.pnpm-store',
  '.cargo', '.rustup', 'venv', '.venv', 'site-packages', 'dist-packages', 'vendor',
  'coverage', 'target', 'build', '.next', '.nuxt', '.turbo',
  // 系统区域
  'AppData', 'Application Data', 'Local Settings', 'SendTo', 'Recent', 'My Documents',
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
  'Recovery', 'PerfLogs', 'System Volume Information',
  // 常见缓存/临时（减小索引体积，这些目录几乎不会放"要找的工具"）
  'Temp', 'tmp', 'cache', 'Cache', 'Packages', 'Google', 'Microsoft', 'Docker',
  'CrashDumps', 'MicrosoftEdgeBackups'
]);

function isSkippedDirName(name) {
  if (SKIP_DIRS.has(name)) return true;
  if (name.startsWith('$')) return true;          // $Recycle.Bin / $GetCurrent 等
  if (name.endsWith('.tmp')) return true;
  return false;
}

/**
 * home 根目录下的额外跳过规则：
 *   - 点目录：IDE/Agent 的内部状态（.trae-cn/.workbuddy/.codebuddy...，动辄几万条缓存文件，
 *     实测一个 WPS Cloud 目录就能吃掉 16 万条目把索引撑爆）
 *   - 云同步缓存目录
 * 只对"home 的直接子项"生效，不影响项目内部的点目录（如 .vscode/.github）。
 */
function isSkippedAtHomeLevel(name, homeRootLc, dirLc) {
  if (dirLc !== homeRootLc) return false;
  if (name.startsWith('.')) return true;
  if (name === 'WPS Cloud') return true;
  return false;
}

/**
 * 默认扫描根：
 *   - 用户主目录（AppData 等由跳过名单排除）
 *   - 所有存在的固定盘符根目录；已被更早扫描根覆盖的子树在遍历时自动去重
 */
function defaultRoots() {
  const roots = [];
  const home = os.homedir();
  if (home) { try { if (fs.statSync(home).isDirectory()) roots.push(path.resolve(home)); } catch (e) {} }
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = letter + ':\\';
    try {
      if (fs.statSync(drive).isDirectory()) {
        const rp = path.resolve(drive);
        if (!roots.some(r => r.toLowerCase() === rp.toLowerCase())) roots.push(rp);
      }
    } catch (e) { /* 盘符不存在/不可读，跳过 */ }
  }
  return roots;
}

function readdirSafe(dir) {
  return fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
}

/** 并发 stat 填充 size/mtime（分块 Promise.all，依赖 libuv 线程池限流） */
async function statFill(entryObjs) {
  for (let i = 0; i < entryObjs.length; i += STAT_CHUNK) {
    const chunk = entryObjs.slice(i, i + STAT_CHUNK);
    const stats = await Promise.all(chunk.map(e => fs.promises.stat(e.p).catch(() => null)));
    for (let j = 0; j < chunk.length; j++) {
      const st = stats[j];
      if (st) { chunk[j].s = st.size || 0; chunk[j].m = st.mtimeMs || 0; }
    }
  }
}

/**
 * 构建索引（BFS 逐层并发遍历）
 * opts: maxDepth, maxEntries, roots[], （构建参数一般不需要外部传，测试用）
 */
async function buildIndex(opts = {}) {
  const maxDepth = opts.maxDepth || DEFAULT_MAX_DEPTH;
  const maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
  const roots = (Array.isArray(opts.roots) && opts.roots.length ? opts.roots : defaultRoots())
    .map(r => path.resolve(String(r)));
  const t0 = Date.now();

  // 已覆盖根（小写）：C:\ 全盘扫描时跳过排在前面的根（如 home）已覆盖的子树。
  // 注意只检查"排在自己之前"的根——否则 home 遍历时会把自家子树全跳掉。
  const covered = roots.map(r => r.toLowerCase());
  const isCoveredBefore = (p, rootIdx) => {
    const d = p.toLowerCase();
    for (let i = 0; i < rootIdx; i++) {
      const r = covered[i];
      if (d === r || d.startsWith(r + '\\') || d.startsWith(r + '/')) return true;
    }
    return false;
  };
  const homeRootLc = path.resolve(os.homedir()).toLowerCase();

  const entries = [];
  const push = (p, s, m, d) => {
    if (entries.length >= maxEntries) return null;
    const e = { p, s: s || 0, m: m || 0, d: d ? 1 : 0 };
    entries.push(e);
    return e;
  };

  // 记录根目录本身
  for (const r of roots) {
    try {
      const st = fs.statSync(r);
      push(r, st.isDirectory() ? 0 : st.size, st.mtimeMs, st.isDirectory() ? 1 : 0);
    } catch (e) { /* 根不可读，跳过 */ }
  }

  let level = roots.map((r, i) => ({ dir: r, depth: 0, rootIdx: i }));
  let truncated = false;

  while (level.length && !truncated) {
    // 1) 并发 readdir 本层全部目录
    const listings = await Promise.all(level.map(it => readdirSafe(it.dir)));

    // 2) 归集：文件记入索引并排队 stat；目录判断跳过/覆盖/下探
    const nextLevel = [];
    const needStat = [];
    outer:
    for (let i = 0; i < level.length; i++) {
      const { dir, depth, rootIdx } = level[i];
      const list = listings[i];
      const dirLc = dir.toLowerCase();
      for (let j = 0; j < list.length; j++) {
        const ent = list[j];
        if (ent.isSymbolicLink()) continue;                 // junction/符号链接一律跳过，防循环
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (isSkippedDirName(ent.name)) continue;
          if (isSkippedAtHomeLevel(ent.name, homeRootLc, dirLc)) continue;
          if (isCoveredBefore(full, rootIdx)) continue;     // 已被更早的扫描根覆盖（如 home ⊂ C:\）
          if (!push(full, 0, 0, 1)) { truncated = true; break outer; }
          if (depth + 1 <= maxDepth) nextLevel.push({ dir: full, depth: depth + 1, rootIdx });
        } else if (ent.isFile()) {
          const e = push(full, 0, 0, 0);
          if (!e) { truncated = true; break outer; }
          needStat.push(e);
        }
      }
    }

    // 3) 并发 stat 本层文件（size/mtime）
    if (!truncated) await statFill(needStat);
    level = nextLevel;
  }

  // 按路径排序：翻页(offset/limit)在多次调用间保持稳定
  entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));

  return {
    builtAt: Date.now(),
    tookMs: Date.now() - t0,
    count: entries.length,
    truncated,
    roots,
    entries
  };
}

/* ======================== 原生索引器（C） ======================== */

/**
 * 用原生 exe 构建索引：等价于 buildIndex() + saveCache()，但快约 3 倍。
 * 成功返回并发写好的缓存文件路径；不可用/失败返回 null（调用方回退 JS 版）。
 */
function buildIndexNative(opts = {}) {
  return new Promise(resolve => {
    let exeAvailable = false;
    try { exeAvailable = fs.statSync(NATIVE_EXE).isFile(); } catch (e) { exeAvailable = false; }
    if (!exeAvailable) { resolve(null); return; }

    const roots = (Array.isArray(opts.roots) && opts.roots.length ? opts.roots : defaultRoots())
      .map(r => path.resolve(String(r)));
    if (!roots.length) { resolve(null); return; }

    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { resolve(null); return; }

    const args = [
      '--out', CACHE_FILE,
      '--max-entries', String(opts.maxEntries || DEFAULT_MAX_ENTRIES),
      '--max-depth', String(opts.maxDepth || DEFAULT_MAX_DEPTH),
      '--threads', String(opts.threads || 8),
      '--home', os.homedir(),
      '--roots', ...roots
    ];

    let child;
    try {
      child = spawn(NATIVE_EXE, args, { windowsHide: true });
    } catch (e) {
      resolve(null);
      return;
    }

    let stderr = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      done(null);
    }, opts.timeoutMs || NATIVE_TIMEOUT_MS);

    child.stderr && child.stderr.on('data', d => { stderr += d.toString().slice(0, 500); });
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        if (stderr) { try { require('./logger').warn('[native-indexer] exit=' + code + ' ' + stderr.trim()); } catch (e) {} }
        done(null);
        return;
      }
      done(CACHE_FILE);
    });
  });
}

/* ======================== 磁盘缓存（TSV） ======================== */

function saveCache(index) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const meta = {
      version: 1,
      engine: index.engine || 'js',
      builtAt: index.builtAt,
      tookMs: index.tookMs,
      count: index.count,
      truncated: index.truncated,
      roots: index.roots
    };
    const lines = ['#' + JSON.stringify(meta)];
    for (let i = 0; i < index.entries.length; i++) {
      const e = index.entries[i];
      lines.push(e.p + '\t' + e.s + '\t' + Math.round(e.m) + '\t' + e.d);
    }
    fs.writeFileSync(CACHE_FILE, lines.join('\n'), 'utf8');
  } catch (e) { /* 缓存写失败不影响主流程 */ }
}

function loadCache(ttlMs) {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const nl = raw.indexOf('\n');
    if (nl < 0 || raw.charCodeAt(0) !== 35) return null;   // '#'
    const meta = JSON.parse(raw.slice(1, nl));
    if (!meta || Date.now() - meta.builtAt > (ttlMs || DEFAULT_TTL_MS)) return null;
    const entries = [];
    const parts = raw.slice(nl + 1).split('\n');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      const i1 = line.indexOf('\t');
      const i2 = line.indexOf('\t', i1 + 1);
      const i3 = line.indexOf('\t', i2 + 1);
      if (i1 < 0 || i2 < 0 || i3 < 0) continue;
      entries.push({
        p: line.slice(0, i1),
        s: +line.slice(i1 + 1, i2) || 0,
        m: +line.slice(i2 + 1, i3) || 0,
        d: line.slice(i3 + 1) === '1' ? 1 : 0
      });
    }
    if (!entries.length) return null;
    return { meta, entries };
  } catch (e) {
    return null;
  }
}

/* ======================== 对外入口 ======================== */

let currentIndex = null;
let indexPromise = null;

/**
 * 获取索引：有缓存用缓存，过期/缺失则重建。
 * opts: refresh(true 强制重建), roots[](重建时限定扫描根), ttlMs
 */
async function getIndex(opts = {}) {
  if (opts.refresh) {
    currentIndex = null;
    indexPromise = null;
  }
  if (currentIndex) return currentIndex;
  if (!indexPromise) {
    indexPromise = (async () => {
      if (!opts.refresh) {
        const cached = loadCache(opts.ttlMs);
        if (cached) {
          currentIndex = {
            engine: cached.meta.engine || 'js',
            builtAt: cached.meta.builtAt,
            tookMs: cached.meta.tookMs || 0,
            count: cached.entries.length,
            truncated: !!cached.meta.truncated,
            roots: cached.meta.roots || [],
            entries: cached.entries
          };
          return currentIndex;
        }
      }

      // 1) 原生优先：exe 直接写好缓存文件，再统一从缓存加载（省一次内存转运）
      if (!opts.noNative) {
        const wrote = await buildIndexNative(opts);
        if (wrote) {
          const cached = loadCache(0);      // 刚生成，不做 TTL 判断
          if (cached) {
            currentIndex = {
              engine: cached.meta.engine || 'native-c',
              builtAt: cached.meta.builtAt,
              tookMs: cached.meta.tookMs || 0,
              count: cached.entries.length,
              truncated: !!cached.meta.truncated,
              roots: cached.meta.roots || [],
              entries: cached.entries
            };
            logger.log('[index] native engine ok count=' + currentIndex.count + ' took=' + currentIndex.tookMs + 'ms');
            return currentIndex;
          }
          logger.warn('[index] native engine wrote cache but load failed, fallback to JS');
        }
      }

      // 2) JS 兜底
      const idx = await buildIndex(opts);
      idx.engine = 'js';
      currentIndex = idx;
      saveCache(idx);
      logger.log('[index] js engine ok count=' + idx.count + ' took=' + idx.tookMs + 'ms');
      return idx;
    })();
    indexPromise.catch(() => { indexPromise = null; });
  }
  return indexPromise;
}

/** 当前索引状态（未就绪返回 null）；供工具输出页脚展示索引新鲜度 */
function status() {
  if (!currentIndex) return null;
  return {
    engine: currentIndex.engine || 'js',
    builtAt: currentIndex.builtAt,
    tookMs: currentIndex.tookMs,
    count: currentIndex.count,
    truncated: currentIndex.truncated,
    roots: currentIndex.roots,
    ageMs: Date.now() - currentIndex.builtAt
  };
}

module.exports = {
  getIndex, buildIndex, buildIndexNative, status,
  invalidate: () => { currentIndex = null; indexPromise = null; },
  DEFAULT_TTL_MS, NATIVE_EXE
};
