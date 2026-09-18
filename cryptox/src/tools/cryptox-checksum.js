'use strict';
/** cryptox_checksum —— 文件 / 目录的校验和，可与期望值比对 */
const fs = require('fs');
const path = require('path');
const A = require('../utils/algo');
const F = require('../utils/format');

const DEFAULT_SKIP = ['node_modules', '.git', 'logs', 'cache', '.analyze-cache'];
const DEFAULT_LIMIT = 200;

/** 收集待计算的文件（目录递归，带极简过滤与上限保护） */
function collect(target, opts, out, skipped) {
  const st = fs.statSync(target);
  if (st.isFile()) { out.push(target); return; }
  if (!st.isDirectory()) return;
  if (!opts.recursive) {
    for (const name of fs.readdirSync(target)) {
      const full = path.join(target, name);
      try { if (fs.statSync(full).isFile()) out.push(full); } catch (_) { /* 跳过读不到的 */ }
    }
    return;
  }
  for (const name of fs.readdirSync(target)) {
    if (out.length >= opts.limit) { skipped.push(name); continue; }
    if (DEFAULT_SKIP.includes(name)) continue;
    const full = path.join(target, name);
    let s;
    try { s = fs.statSync(full); } catch (_) { continue; }
    if (s.isDirectory()) collect(full, opts, out, skipped);
    else if (s.isFile()) out.push(full);
  }
}

module.exports = {
  name: 'cryptox_checksum',
  title: '文件校验和',
  description: '计算文件（或目录递归）的校验和，可与期望值比对，常用于校验下载包是否被篡改。'
    + '参数：path（文件或目录，必填）、algorithm（默认 sha256）、expected（可选，仅单文件时有意义）、'
    + 'ext（可选，按扩展名过滤，如 ".js,.md"）、recursive（目录是否递归，默认 true）、limit（最多计算多少个文件，默认 200）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件或目录路径（必填）' },
      algorithm: { type: 'string', description: `哈希算法，默认 sha256。可用：${A.HASH_ALGOS.join(', ')}` },
      expected: { type: 'string', description: '可选：期望的校验和（单文件时用于比对）' },
      ext: { type: 'string', description: '可选：扩展名过滤，逗号分隔，如 ".js,.md"（不区分大小写）' },
      recursive: { type: 'boolean', description: '目录是否递归，默认 true' },
      limit: { type: 'number', description: `最多计算多少个文件，默认 ${DEFAULT_LIMIT}` }
    },
    required: ['path'],
    additionalProperties: false
  },

  run(args = {}) {
    if (typeof args.path !== 'string' || args.path.length === 0) {
      throw new Error('必须提供 path（文件或目录路径）');
    }
    const algo = A.normalizeAlgo(args.algorithm);
    const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;
    const recursive = args.recursive !== false;

    let st;
    try {
      st = fs.statSync(args.path);
    } catch (e) {
      throw new Error(`路径不可访问 "${args.path}"：${e.code === 'ENOENT' ? '不存在' : e.message}`);
    }

    const skipped = [];
    const files = [];
    collect(args.path, { recursive, limit }, files, skipped);

    // 扩展名过滤
    const exts = typeof args.ext === 'string' && args.ext.trim()
      ? args.ext.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).map(s => (s.startsWith('.') ? s : '.' + s))
      : null;
    const filtered = exts ? files.filter(f => exts.some(e => f.toLowerCase().endsWith(e))) : files;

    const results = filtered.slice(0, limit).map(f => {
      const buf = fs.readFileSync(f);
      return {
        file: f,
        bytes: buf.length,
        hash: A.digest(algo, buf, 'hex')
      };
    });

    const expected = typeof args.expected === 'string' && args.expected.trim() ? args.expected.trim().toLowerCase() : null;
    let matched = null;
    if (expected && results.length === 1) {
      matched = results[0].hash.toLowerCase() === expected;
    }

    const lines = [`校验和 · ${algo} · ${results.length} 个文件${st.isDirectory() ? '（目录）' : ''}`, ''];
    lines.push(F.table(
      ['文件', '字节', '校验和'],
      results.map(r => [r.file, r.bytes, r.hash]),
      { cellMax: 200 }
    ));

    if (expected) {
      lines.push('');
      if (results.length === 1) {
        lines.push(matched ? '✓ 与期望值一致' : '✗ 与期望值不一致');
      } else {
        lines.push('（提供了 expected 但匹配到多个文件，未做比对）');
      }
    }
    if (skipped.length > 0 || files.length > limit) {
      lines.push('');
      lines.push(`（已达上限 ${limit} 个文件，未处理的文件已省略；可用 ext 过滤或提高 limit）`);
    }

    return {
      _text: F.clip(lines.join('\n'), 24000, '请用 ext 过滤或缩小 path 范围'),
      algorithm: algo,
      count: results.length,
      expectedMatched: matched,
      results
    };
  }
};
