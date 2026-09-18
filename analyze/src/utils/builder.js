'use strict';
/**
 * 图谱构建器：扫描目录 → 逐文件解析 → 组装知识图谱
 *
 * 职责边界：
 *   builder 只负责"把磁盘上的代码变成 Graph 对象"，
 *   至于怎么存、怎么查、怎么呈现，那是 graph.js 和 tools/ 的事。
 */

const fs = require('fs');
const path = require('path');
const { Graph } = require('./graph');
const L = require('../lang/index.js');

/** 默认跳过的目录：版本库、依赖、构建产物、缓存 */
const DEFAULT_SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'target', 'bin', 'obj',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.venv', 'venv', 'env', '.tox', '.idea', '.vscode', '.vs',
  'coverage', '.nyc_output', '.next', '.nuxt', '.cache', '.parcel-cache',
  'Pods', 'DerivedData', '.terraform'
]);

/** 明显不是源码的文件，直接跳过（避免图里塞满图片/压缩包） */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.mkv', '.webm',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.lib', '.pdb',
  '.pyc', '.pyo', '.class', '.jar', '.war', '.wasm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3', '.lock', '.map'
]);

/** 单文件大小上限：超过就跳过（图里放不下，也不像人手写的） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 构建知识图谱
 * @param {string} root         要分析的根目录（绝对路径）
 * @param {object} opts
 *   - skipDirs  额外的跳过目录名
 *   - include   只分析匹配这些子串的路径
 *   - exclude   跳过匹配这些子串的路径
 *   - maxFiles  文件数上限（默认 20000）
 *   - onProgress(cur, total, file)
 * @returns {Graph}
 */
function buildGraph(root, opts = {}) {
  root = path.resolve(root);
  if (!fs.existsSync(root)) throw new Error('路径不存在: ' + root);

  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(opts.skipDirs || [])]);
  const maxFiles = opts.maxFiles || 20000;
  const graph = new Graph();
  graph.root = root;

  const files = collectFiles(root, { skipDirs, maxFiles, ...opts });
  const total = files.length;

  files.forEach((abs, i) => {
    if (opts.onProgress && (i % 50 === 0 || i === total - 1)) opts.onProgress(i + 1, total, abs);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    try {
      const src = fs.readFileSync(abs, 'utf8');
      const lang = L.langOf(abs);
      const parsed = parseSource(src, lang, rel);
      parsed.size = Buffer.byteLength(src, 'utf8');
      parsed.lineCount = parsed.lineCount || src.split('\n').length;
      graph.addFile(rel, parsed);
    } catch (e) {
      graph.errors.push({ file: rel, error: e.message });
      // 单个文件读失败不应拖垮整个建图，记下来继续
      graph.files.set(rel, { rel, lang: null, symbolCount: 0, lineCount: 0, size: 0, error: e.message });
    }
  });

  graph.finalize(makeFileResolver(root, graph));
  return graph;
}

/** 解析单个源码文本（导出以便单测直接调用） */
function parseSource(src, lang, rel) {
  const lineCount = src.split('\n').length;
  if (!lang) {
    // 未知语言：退化为"仅文件级依赖图"，靠文件名索引与常见相对路径启发
    return { symbols: [], imports: sniffImports(src, rel), calls: [], refs: [], lang: null, lineCount };
  }
  const ext = L.extractorFor(lang);
  if (!ext || typeof ext.extract !== 'function') {
    return { symbols: [], imports: [], calls: [], refs: [], lang, lineCount };
  }
  // transaction：给提取器一个会话上下文，用于（a）收集函数体，
  // 好在事后把"局部变量"从符号表里剔掉（b）登记本文件声明的名字
  const transaction = { bodies: [], declared: new Set(), lang };
  const parsed = ext.extract(src, { file: rel, lang, transaction });
  parsed.lang = lang;
  parsed.lineCount = lineCount;
  parsed.transaction = transaction;

  // 把裸调用点归属到所属函数：调用链（谁调了谁）全靠这一步。
  // 提取器只知道自己看到的 `foo(`，不知道它在哪个函数体里；
  // bodies 是提取器回填的函数区间，这里统一按位置归属。
  // 放在 builder 层做（而不是每个语言提取器各写一遍）的原因：
  //   所有语言都用同一套 {bodies:[{name,start,end,headerEnd}]} 契约，
  //   归属逻辑与语言无关，写一次就够，也不会漏。
  if (Array.isArray(parsed.calls)) {
    parsed.calls = attributeCalls(parsed.calls, transaction.bodies);
  }
  return parsed;
}

/**
 * 给每个调用点标上"发起它的函数"。
 * @param {Array} calls  [{name, line, pos, member, arrow, from?}]
 * @param {Array} bodies [{name, start, end, headerEnd}]
 */
function attributeCalls(calls, bodies) {
  if (!bodies || !bodies.length) return calls;
  const out = [];
  const seen = new Set();
  for (const c of calls) {
    if (c.from) { out.push(c); continue; }      // 提取器已经标好了，尊重它
    if (typeof c.pos !== 'number') { out.push(c); continue; }
    // 落在哪个函数体里？（取最内层，即区间最小者）
    let owner = null;
    for (const b of bodies) {
      if (c.pos > b.start && c.pos < b.end) {
        if (!owner || (b.end - b.start) < (owner.end - owner.start)) owner = b;
      }
    }
    // 调用点就写在函数签名行上（如 `function f(g())`）→ 那更像声明而非调用，跳过归属
    if (owner && owner.headerEnd && c.pos <= owner.headerEnd) owner = null;
    const key = (owner ? owner.name : '') + '|' + c.name + '|' + c.line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.assign({}, c, { from: owner ? owner.name : null }));
  }
  return out;
}

/**
 * 未知语言的兜底：从文本里嗅探常见的依赖指令。
 * 只做最保守的匹配，宁可漏也不要错。
 */
function sniffImports(src, rel) {
  const out = [];
  const lines = src.split('\n');
  // 只扫前 200 行：依赖声明基本都在文件头部，全扫纯属浪费
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    const t = lines[i].trim();
    let m;
    if ((m = /^#\s*include\s*"([^"]+)"/.exec(t))) out.push({ name: m[1], from: m[1], line: i + 1, kind: 'include-local' });
    else if ((m = /^#\s*include\s*<([^>]+)>/.exec(t))) out.push({ name: m[1], from: m[1], line: i + 1, kind: 'include-system' });
    else if ((m = /^\s*import\s+["']([^"']+)["']/.exec(t))) out.push({ name: m[1], from: m[1], line: i + 1, kind: 'import' });
    else if ((m = /^\s*(?:require|require_once|include|include_once)\s*[( ]*["']([^"']+)["']/.exec(t))) out.push({ name: m[1], from: m[1], line: i + 1, kind: 'require' });
    else if ((m = /^\s*use\s+([\w:.\\]+)/.exec(t))) out.push({ name: m[1], from: m[1], line: i + 1, kind: 'use' });
  }
  return out;
}

/** 收集待分析文件（绝对路径列表），跳过目录/二进制/超大文件 */
function collectFiles(root, opts) {
  // 防御：这些参数可能由调用方直接传入，缺省时必须有合理默认，
  // 否则 skipDirs.has(...) 会在第一层目录上就抛 TypeError。
  opts = opts || {};
  const skipDirs = opts.skipDirs instanceof Set ? opts.skipDirs : new Set(opts.skipDirs || []);
  const out = [];
  const maxFiles = opts.maxFiles || 20000;
  const include = opts.include ? String(opts.include) : null;
  const exclude = opts.exclude ? String(opts.exclude) : null;

  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;   // 权限不足等，跳过
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        if (ent.name.startsWith('.') && ent.name !== '.') {
          // 隐藏目录一般不是源码（.github 除外，那里面有 workflow 值得看）
          if (ent.name !== '.github') continue;
        }
        walk(abs);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (BINARY_EXT.has(ext)) continue;
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (include && !rel.includes(include)) continue;
        if (exclude && rel.includes(exclude)) continue;
        try {
          const st = fs.statSync(abs);
          if (st.size > MAX_FILE_BYTES) continue;
          if (st.size === 0) continue;
        } catch { continue; }
        out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 生成"import 串 → 真实文件"的解析器。
 * 这是把文件级依赖接对的关键：`./path-utils` 到底对应哪个文件？
 */
function makeFileResolver(root, graph) {
  // 建立 相对路径 → 文件节点 的快速查找，并预生成"去扩展名"索引
  const byRel = new Set(graph.files.keys());
  const byNoExt = new Map();   // 去掉扩展名的路径 → 真实相对路径（可能多个）
  const byBase = new Map();    // 文件名 → 真实相对路径列表
  for (const rel of graph.files.keys()) {
    const noExt = rel.replace(/\.[^./]+$/, '');
    if (!byNoExt.has(noExt)) byNoExt.set(noExt, []);
    byNoExt.get(noExt).push(rel);
    const base = rel.split('/').pop();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(rel);
  }

  const candidates = (target) => {
    // 与某扩展名同名的文件，视为可能的目标
    const exts = ['', ...L.knownExtensions()];
    return exts.map(e => target + e);
  };

  return function resolve(fromRel, target) {
    if (!target) return null;
    // 系统头文件/包名（无路径分隔符且非相对路径）→ 不连到项目内文件
    const isRelative = target.startsWith('./') || target.startsWith('../');
    const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';

    // 1) 相对路径：基于当前文件目录解析
    if (isRelative) {
      const joined = normalizeJoin(fromDir, target);
      for (const cand of candidates(joined)) {
        if (byRel.has(cand)) return cand;
      }
      // 目录 + index
      for (const idxName of ['index.js', 'index.ts', 'index.jsx', 'index.tsx', '__init__.py', 'mod.rs', 'index.ts']) {
        const c = joined + '/' + idxName;
        if (byRel.has(c)) return c;
      }
      // 后缀模糊：路径尾部匹配
      const tail = joined.split('/').filter(Boolean).slice(-2).join('/');
      for (const rel of graph.files.keys()) {
        if (rel.endsWith(joined) || rel.includes(joined)) return rel;
      }
      return null;
    }

    // 2) Python 风格的点号相对导入：.models / ..util
    if (/^\.+\w/.test(target) || target === '.' || target === '..') {
      const dots = /^\.+/.exec(target)[0].length;
      const rest = target.slice(dots).replace(/\./g, '/');
      let dir = fromDir;
      for (let k = 1; k < dots; k++) dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
      const joined = normalizeJoin(dir, rest);
      for (const cand of [...candidates(joined), joined + '/__init__.py']) {
        if (byRel.has(cand)) return cand;
      }
      return null;
    }

    // 3) 裸模块名（node:fs / fmt / std::x）→ 先试项目内同名文件，再放弃
    const norm = target.replace(/\\/g, '/').replace(/::/g, '/');
    for (const cand of candidates(norm)) {
      if (byRel.has(cand)) return cand;
    }
    // 试当前目录下的同名文件（Python 的 `from typing import` 之类虽然多半是标准库，
    // 但项目里若有同名文件，那是真的依赖）
    const local = normalizeJoin(fromDir, norm);
    for (const cand of candidates(local)) {
      if (byRel.has(cand)) return cand;
    }
    // 只按最后一段找同名源文件（如 Rust 的 crate::models::User → models.rs）
    const seg = norm.split('/').filter(Boolean).pop();
    if (seg && seg.length > 2) {
      for (const cand of candidates(seg)) {
        if (byRel.has(cand)) return cand;
      }
      if (byBase.has(seg)) {
        const list = byBase.get(seg);
        if (list.length === 1) return list[0];
      }
    }
    return null;
  };
}

/** 拼接相对路径并规范化（不用 path.join，避免把 Windows 反斜杠带进来） */
function normalizeJoin(dir, rel) {
  const parts = (dir ? dir.split('/') : []).concat(rel.split('/'));
  const stack = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { stack.pop(); continue; }
    stack.push(p);
  }
  return stack.join('/');
}

module.exports = { buildGraph, parseSource, collectFiles, DEFAULT_SKIP_DIRS, BINARY_EXT, MAX_FILE_BYTES };
