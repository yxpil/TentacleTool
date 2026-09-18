'use strict';
/**
 * fsx_grep —— 内容搜索（正则/字面量、文件类型过滤、上下文行、命中行号、limit + 翻页）
 */
const fs = require('fs');
const path = require('path');
const { globToRegex, isBinaryBuffer, safeStat } = require('../utils/fsutil');

const MAX_FILES = 5000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const inputSchema = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: '要搜索的内容：正则（mode="regex"）或字面量关键词（默认）' },
    path: { type: 'string', description: '搜索目标：单个文件，或目录（目录时递归搜索内部文件）' },
    mode: { type: 'string', enum: ['literal', 'regex'], description: 'literal=字面量（默认），regex=正则' },
    caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false（不区分）' },
    include: { type: 'string', description: '文件类型过滤（glob，逗号分隔，对文件名生效），如 "*.js,*.ts"；不填搜所有文本文件' },
    recursive: { type: 'boolean', description: '目标是目录时是否递归子目录，默认 true' },
    context: { type: 'number', description: '每个命中前后各显示多少行上下文，默认 0' },
    limit: { type: 'number', description: '最多返回的命中条数（默认 50，上限 500）' },
    offset: { type: 'number', description: '翻页偏移' }
  },
  required: ['pattern', 'path']
};

function buildRegex(pattern, mode, caseSensitive) {
  const flags = caseSensitive ? '' : 'i';
  if (mode === 'regex') return new RegExp(pattern, flags);
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, flags);
}

function searchInFile(full, re, context) {
  let buf;
  try { buf = fs.readFileSync(full); } catch (e) { return null; }
  if (isBinaryBuffer(buf)) return null; // 二进制文件跳过
  if (buf.length > MAX_FILE_SIZE) return null;
  const content = buf.toString('utf8');
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      const before = [], after = [];
      for (let k = 1; k <= context; k++) {
        if (i - k >= 0) before.unshift(lines[i - k]);
        if (i + k < lines.length) after.push(lines[i + k]);
      }
      hits.push({ line: i + 1, text: lines[i], before, after });
    }
  }
  return hits;
}

function collectFiles(dir, recursive, includeReList, out) {
  if (out.length >= MAX_FILES) return;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (const n of names) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, n);
    const st = safeStat(full);
    if (!st) continue;
    if (st.isDirectory()) {
      if (recursive) collectFiles(full, recursive, includeReList, out);
    } else {
      if (includeReList.length && !includeReList.some(re => re.test(n))) continue;
      out.push(full);
    }
  }
}

function run(args) {
  const pattern = args.pattern;
  if (pattern == null || pattern === '') throw new Error('pattern 不能为空');
  const target = path.resolve(args.path || '');
  if (!fs.existsSync(target)) throw new Error('路径不存在：' + target);

  const mode = args.mode === 'regex' ? 'regex' : 'literal';
  const caseSensitive = !!args.caseSensitive;
  const recursive = args.recursive !== false;
  const context = Math.max(0, parseInt(args.context, 10) || 0);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
  const includeReList = args.include
    ? String(args.include).split(',').map(s => s.trim()).filter(Boolean).map(globToRegex)
    : [];

  const re = buildRegex(pattern, mode, caseSensitive);

  const isDir = fs.statSync(target).isDirectory();
  const files = [];
  if (isDir) {
    collectFiles(target, recursive, includeReList, files);
  } else {
    if (includeReList.length && !includeReList.some(re => re.test(path.basename(target)))) {
      // 文件不匹配 include 过滤
    } else {
      files.push(target);
    }
  }

  const allMatches = [];
  let filesScanned = 0;
  for (const f of files) {
    if (allMatches.length >= offset + limit) break;
    const hits = searchInFile(f, re, context);
    if (hits) {
      filesScanned++;
      if (hits.length) {
        for (const h of hits) allMatches.push({ file: f, ...h });
      }
    }
  }

  const total = allMatches.length;
  const page = allMatches.slice(offset, offset + limit);
  const truncated = offset + limit < total;

  const L = [];
  L.push(`▸ 内容搜索 "${pattern}"  ${mode === 'regex' ? '(正则)' : '(字面量)'}${caseSensitive ? ' 区分大小写' : ''}`);
  L.push(`  目标: ${target}${isDir ? (recursive ? ' (递归)' : ' (仅当前层)') : ''}  扫描文件: ${filesScanned}/${files.length}`);
  L.push(`  命中 ${total} 处，显示第 ${offset + 1}–${offset + page.length} 处` + (truncated ? `（还有 ${total - offset - limit} 处）` : ''));
  for (const m of page) {
    L.push('');
    L.push(`  ${m.file}:${m.line}`);
    for (const b of m.before) L.push(`    ${m.line - m.before.length + m.before.indexOf(b)} │ ${b}`);
    L.push(`  › ${m.line} │ ${m.text}`);
    for (const a of m.after) L.push(`    ${m.line + m.after.indexOf(a) + 1} │ ${a}`);
  }
  if (page.length === 0) L.push('\n  （无命中）');
  if (truncated) {
    L.push('');
    L.push(`  翻页: fsx_grep(pattern="${pattern}", path="${target}", offset=${offset + limit}, limit=${limit}` +
      (mode === 'regex' ? ', mode="regex"' : '') + (caseSensitive ? ', caseSensitive=true' : '') + ')');
  }
  L.push('');
  L.push('■ 下一步');
  L.push('  · 看全文：fsx_read(path="<命中文件>", startLine=...)');
  L.push('  · 改内容：fsx_edit');

  return {
    _text: L.join('\n'),
    pattern,
    mode,
    caseSensitive,
    target,
    filesScanned,
    filesTotal: files.length,
    total,
    shown: page.length,
    truncated,
    offset,
    limit,
    matches: page.map(m => ({
      file: m.file, line: m.line, text: m.text,
      contextBefore: m.before, contextAfter: m.after
    }))
  };
}

module.exports = {
  name: 'fsx_grep',
  title: '内容搜索（正则/字面量/上下文/翻页）',
  description:
    '在文件或目录内搜索文本内容。mode=literal 关键字（默认）或 regex 正则；caseSensitive 控制大小写；' +
    'include 用 glob 过滤文件类型（如 "*.js,*.ts"）；context 显示命中上下文行数；命中带文件名与行号；' +
    'limit/offset 分页。二进制文件与大文件自动跳过。',
  inputSchema,
  run,
  buildRegex,
  searchInFile
};
