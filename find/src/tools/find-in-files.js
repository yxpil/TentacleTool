'use strict';
/**
 * find_in_files：在文件内容里搜索关键词/正则（grep 风格）
 *
 * 成本控制（防止一次调用扫穿全盘）：
 *   - 只扫文本类扩展名白名单（或调用方指定的 ext）
 *   - 单文件 ≤1MB；前 8KB 出现 \0 判定为二进制直接跳过
 *   - 每文件最多 5 处命中、总计默认 50 处、最多扫 4000 个候选、10 秒时间预算
 *   - 候选按 mtime 新→旧优先扫描（最近改动的文件最可能是"要找的"）
 */
const fs = require('fs');
const { getIndex, status } = require('../utils/indexer');
const { extOf, fmtSize, fmtTime, relTime } = require('../utils/format');
const { parseExt } = require('./find-files');

const DEFAULT_TEXT_EXTS = [
  'txt', 'md', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
  'py', 'rb', 'php', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs',
  'sql', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'psm1', 'dockerfile',
  'gitignore', 'gitattributes', 'editorconfig', 'properties', 'gradle', 'lock', 'log'
];
const MAX_FILE_SIZE_DEFAULT = 1024 * 1024;   // 1MB
const PER_FILE_CAP = 5;
const TOTAL_CAP = 50;
const MAX_FILES_SCAN = 4000;
const TIME_BUDGET_MS = 10000;
const CONCURRENCY = 8;
const LINE_SNIPPET_LEN = 200;

/** 单文件内容扫描：返回 [{n, text}]（最多 perFile 处） */
function findLines(text, needle, re, perFile) {
  const out = [];
  let start = 0, lineNo = 0;
  while (start <= text.length && out.length < perFile) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    lineNo++;
    const line = text.slice(start, end);
    const hit = re ? re.test(line) : line.toLowerCase().includes(needle);
    if (hit) out.push({ n: lineNo, text: line.trim().slice(0, LINE_SNIPPET_LEN) });
    if (nl < 0) break;
    start = nl + 1;
  }
  return out;
}

async function scanOne(entry, needle, re, perFile) {
  const buf = await fs.promises.readFile(entry.p);
  if (buf.length === 0) return null;
  const sniffLen = Math.min(buf.length, 8192);
  let binary = false;
  for (let i = 0; i < sniffLen; i++) {
    if (buf[i] === 0) { binary = true; break; }
  }
  if (binary) return null;
  const text = buf.toString('utf8');
  return findLines(text, needle, re, perFile);
}

async function run(args = {}) {
  const query = String(args.query || '');
  if (!query.trim()) {
    return '用法: find_in_files(query="内容关键词或正则", root="C:\\\\path", ext="js,ts", mode="sub|regex", caseSensitive=false, limit=50)\n'
      + '示例: find_in_files("createServer", root="C:\\\\Users\\\\me\\\\proj", ext="js,ts")';
  }
  const mode = args.mode === 'regex' ? 'regex' : 'sub';
  const caseSensitive = !!args.caseSensitive;
  let re = null;
  if (mode === 'regex') {
    try { re = new RegExp(query, caseSensitive ? '' : 'i'); } catch (e) {
      return '正则表达式无效: ' + e.message;
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  const maxFileSize = Math.min(Math.max(parseInt(args.maxFileSize, 10) || MAX_FILE_SIZE_DEFAULT, 1024), 5 * 1024 * 1024);
  const ext = parseExt(args.ext) || DEFAULT_TEXT_EXTS;
  const perFile = Math.min(Math.max(parseInt(args.perFile, 10) || PER_FILE_CAP, 1), 20);
  const totalCap = Math.min(Math.max(parseInt(args.limit, 10) || TOTAL_CAP, 1), 200);
  const root = args.root ? String(args.root) : null;
  const rootLc = root ? root.replace(/[/\\]+$/, '').toLowerCase() : null;

  const index = await getIndex({ refresh: !!args.refresh });

  // 圈定候选：文件 + 文本扩展名 + 大小上限 + root 子树；mtime 新→旧
  const candidates = [];
  for (let i = 0; i < index.entries.length; i++) {
    const e = index.entries[i];
    if (e.d) continue;
    if (!ext.includes(extOf(e.p))) continue;
    if (e.s > maxFileSize) continue;
    if (rootLc) {
      const lp = e.p.toLowerCase();
      if (lp !== rootLc && !lp.startsWith(rootLc + '\\')) continue;
    }
    candidates.push(e);
  }
  candidates.sort((a, b) => b.m - a.m);

  // 并发扫描（8 路），满足任一上限即停
  const t0 = Date.now();
  const results = [];
  let scanned = 0;
  let cursor = 0;
  let stopReason = null;

  const shouldStop = () => {
    if (results.reduce((n, r) => n + r.lines.length, 0) >= totalCap) { stopReason = stopReason || '命中数达到上限'; return true; }
    if (scanned >= MAX_FILES_SCAN) { stopReason = stopReason || '扫描文件数达到上限'; return true; }
    if (Date.now() - t0 > TIME_BUDGET_MS) { stopReason = stopReason || '时间预算用尽'; return true; }
    return false;
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      if (shouldStop()) return;
      const i = cursor++;
      if (i >= candidates.length) return;
      const e = candidates[i];
      scanned++;
      try {
        const lines = await scanOne(e, needle, re, perFile);
        if (lines && lines.length) results.push({ e, lines });
      } catch (err) { /* 无权限/被占用等，跳过 */ }
    }
  }));
  results.sort((a, b) => b.e.m - a.e.m);
  const totalHits = results.reduce((n, r) => n + r.lines.length, 0);

  // 渲染
  const lines = [];
  const head = [`mode=${mode}`];
  if (root) head.push(`root=${root}`);
  if (args.ext) head.push(`ext=${ext.join('/')}`);
  if (caseSensitive) head.push('case-sensitive');
  lines.push(`## find_in_files: "${query}" (${head.join(', ')})`);
  lines.push('');
  if (!totalHits) {
    lines.push('没有命中。可以尝试：');
    lines.push('- 收窄 root 到目标项目目录（否则只能扫到索引覆盖范围）');
    lines.push('- 用 ext 指定扩展名（默认只扫文本类白名单，单文件 ≤1MB）');
    lines.push('- mode="regex" 处理变体拼写（如 find_in_files("create[-_]?server", mode="regex")）');
  } else {
    lines.push(`共 ${totalHits} 处命中，涉及 ${results.length} 个文件（每文件最多 ${perFile} 处）`);
    lines.push('');
    let no = 0;
    for (const r of results) {
      no++;
      lines.push(`${no}. ${r.e.p}  (${fmtSize(r.e.s)}, ${fmtTime(r.e.m)})`);
      for (const l of r.lines) {
        lines.push(`   L${l.n}: ${l.text}`);
      }
    }
  }
  const st = status();
  lines.push('');
  const scanNote = stopReason
    ? `已扫描 ${scanned} 个候选文件（${stopReason}，候选共 ${candidates.length} 个，可能未扫完）`
    : `已扫描全部 ${scanned} 个候选文件`;
  lines.push(`> ${scanNote} | 单文件≤${Math.round(maxFileSize / 1024)}KB、文本类扩展名、二进制跳过`);
  if (st) {
    lines.push(`> 索引: ${st.count} 项，构建于 ${fmtTime(st.builtAt)}（${relTime(st.builtAt)}）。索引未收录的文件（如新建/被跳过目录内）不在扫描范围`);
  }
  return lines.join('\n');
}

module.exports = { run, DEFAULT_TEXT_EXTS };
