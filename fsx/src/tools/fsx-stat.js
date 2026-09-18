'use strict';
/**
 * fsx_stat —— 文件属性（大小/时间/类型/权限/行数/编码猜测，支持批量多路径）
 */
const fs = require('fs');
const path = require('path');
const { detectEncoding, countLines, permString, permOctal, safeStat, fmtTime } = require('../utils/fsutil');
const F = require('../utils/format');

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '单个路径（与 paths 二选一）' },
    paths: { type: 'array', items: { type: 'string' }, description: '多个路径批量查询（与 path 二选一）' }
  }
};

function statOne(p) {
  const resolved = path.resolve(p || '');
  const st = safeStat(resolved);
  if (!st) {
    return { path: resolved, exists: false };
  }
  const type = st.isDirectory() ? 'dir' : (st.isSymbolicLink ? (fs.lstatSync(resolved).isSymbolicLink() ? 'symlink' : 'file') : 'file');
  const item = {
    path: resolved,
    exists: true,
    type,
    size: st.size,
    permissions: permString(st.mode) + ' (' + permOctal(st.mode) + ')',
    mtime: st.mtime.toISOString(),
    ctime: st.ctime.toISOString(),
    atime: st.atime.toISOString(),
    birthtime: st.birthtime.toISOString()
  };
  if (type === 'file') {
    try {
      const head = fs.readFileSync(resolved).slice(0, 65536);
      const enc = detectEncoding(head);
      item.encoding = enc.label;
      item.binary = enc.encoding === 'binary';
      item.lines = countLines(head.toString(enc.encoding === 'binary' ? 'latin1' : enc.encoding));
    } catch (e) {
      item.encoding = '读取失败';
      item.lines = null;
    }
  }
  return item;
}

function run(args) {
  let list = [];
  if (Array.isArray(args.paths) && args.paths.length) list = args.paths;
  else if (args.path) list = [args.path];
  else throw new Error('需要提供 path（单路径）或 paths（多路径数组）');

  const items = list.map(statOne);
  const found = items.filter(i => i.exists).length;

  const rows = items.map(it => [
    it.exists ? path.basename(it.path) : path.basename(it.path) + ' (缺失)',
    it.exists ? it.type : '—',
    it.exists ? (it.type === 'dir' ? '—' : F.size(it.size)) : '—',
    it.exists ? it.permissions : '—',
    it.exists ? fmtTime(it.mtime) : '—'
  ]);

  const L = [];
  L.push(`▸ 文件属性（共 ${items.length} 项，存在 ${found} 项）`);
  if (rows.length) {
    L.push('');
    L.push(F.table(['名称', '类型', '大小', '权限', '修改时间'], rows));
  }
  // 详细信息（编码/行数/各时间戳）
  const detailed = items.filter(i => i.exists && i.type === 'file');
  if (detailed.length) {
    L.push('');
    L.push('■ 文件详情');
    for (const it of detailed) {
      L.push(`  · ${it.path}`);
      L.push(`      编码: ${it.encoding}${it.binary ? '（二进制）' : ''}  行数: ${it.lines == null ? '—' : it.lines}`);
      L.push(`      创建: ${fmtTime(it.birthtime)}  变更: ${fmtTime(it.mtime)}  状态变更: ${fmtTime(it.ctime)}`);
    }
  }
  L.push('');
  L.push('■ 下一步');
  L.push('  · 看内容：fsx_read / fsx_grep');
  L.push('  · 改内容：fsx_edit / fsx_write');

  return {
    _text: L.join('\n'),
    items
  };
}

module.exports = {
  name: 'fsx_stat',
  title: '文件属性（大小/时间/权限/编码/批量）',
  description:
    '查询文件或目录的属性：大小、类型（file/dir/symlink）、权限（rwx + 八进制）、' +
    '创建/修改/访问时间；对文件额外猜测编码（UTF-8/UTF-16/Latin-1/二进制）并统计行数。' +
    '支持批量：传 path（单路径）或 paths（数组）。',
  inputSchema,
  run,
  statOne
};
