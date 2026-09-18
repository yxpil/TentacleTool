'use strict';
/**
 * fsx_list —— 列目录（递归/深度/glob 过滤/排序/limit + 翻页提示）
 */
const fs = require('fs');
const path = require('path');
const { globToRegex, safeStat, fmtTime } = require('../utils/fsutil');
const F = require('../utils/format');

const MAX_ENTRIES = 20000;

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要列出的目录路径（默认当前工作目录）' },
    recursive: { type: 'boolean', description: '是否递归子目录，默认 false（只列当前层）' },
    depth: { type: 'number', description: '递归时的最大下钻层数（默认 5，上限 20）；仅 recursive=true 时生效' },
    pattern: { type: 'string', description: 'glob 过滤（对文件名生效，如 "*.js"、"data?.csv"），大小写不敏感' },
    sort: { type: 'string', enum: ['name', 'size', 'mtime'], description: '排序字段，默认 name' },
    order: { type: 'string', enum: ['asc', 'desc'], description: '排序方向，默认 asc' },
    limit: { type: 'number', description: '返回条数上限（默认 100，上限 2000）' },
    offset: { type: 'number', description: '翻页偏移（配合返回值中的翻页提示）' }
  }
};

function run(args) {
  const dir = path.resolve(args.path || '.');
  if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error('这不是一个目录：' + dir);

  const recursive = !!args.recursive;
  const levels = recursive ? Math.min(parseInt(args.depth, 10) || 5, 20) : 1;
  const pattern = args.pattern ? globToRegex(args.pattern) : null;
  const sort = args.sort || 'name';
  const order = args.order === 'desc' ? 'desc' : 'asc';
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 2000);
  const offset = Math.max(parseInt(args.offset, 10) || 0, 0);

  const entries = [];
  let capped = false;

  function walk(d, remaining) {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { return; }
    for (const e of names) {
      if (entries.length >= MAX_ENTRIES) { capped = true; return; }
      const full = path.join(d, e.name);
      const st = safeStat(full);
      const type = e.isDirectory() ? 'dir' : (e.isSymbolicLink() ? 'symlink' : 'file');
      const rel = path.relative(dir, full);
      if (pattern && !pattern.test(e.name)) {
        // glob 只过滤文件本身；目录即使不匹配也继续下钻（否则会漏掉里面的匹配项）
      } else {
        entries.push({
          name: e.name,
          relPath: rel,
          path: full,
          type,
          size: st ? st.size : 0,
          mtime: st ? st.mtimeMs : 0
        });
      }
      if (e.isDirectory() && remaining > 1 && !capped) {
        walk(full, remaining - 1);
      }
    }
  }
  walk(dir, levels);

  // 过滤（glob 对未匹配且是目录的条目：上面已跳过入列，但仍下钻过；这里对已入列再滤一次确保一致）
  let filtered = pattern ? entries.filter(e => pattern.test(e.name)) : entries;
  // 排序
  const dirRank = (e) => (e.type === 'dir' ? 0 : 1);
  filtered.sort((a, b) => {
    let c = 0;
    if (sort === 'size') c = a.size - b.size;
    else if (sort === 'mtime') c = a.mtime - b.mtime;
    else c = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    if (c === 0) c = a.name.localeCompare(b.name);
    return order === 'desc' ? -c : c;
  });

  const total = filtered.length;
  const pageItems = filtered.slice(offset, offset + limit);
  const truncated = offset + limit < total;

  const rows = pageItems.map(e => [
    (recursive ? e.relPath : e.name) + (e.type === 'dir' ? '/' : ''),
    e.type,
    e.type === 'dir' ? '—' : F.size(e.size),
    fmtTime(e.mtime ? new Date(e.mtime) : null)
  ]);

  const L = [];
  L.push(`▸ 目录 ${dir}`);
  L.push(`  递归: ${recursive ? '是(深度 ' + levels + ')' : '否'}  排序: ${sort} ${order}  过滤: ${pattern ? args.pattern : '无'}`);
  L.push(`  共 ${total} 项，显示第 ${offset + 1}–${offset + pageItems.length} 项` + (capped ? '（已达上限，可能不完整）' : '') + (truncated ? `（还有 ${total - offset - limit} 项）` : ''));
  if (rows.length) {
    L.push('');
    L.push(F.table(['名称', '类型', '大小', '修改时间'], rows));
  } else {
    L.push('');
    L.push('  （空目录或无匹配项）');
  }
  if (truncated) {
    L.push('');
    L.push(`  翻页: fsx_list(path="${dir}", offset=${offset + limit}, limit=${limit}` +
      (recursive ? `, recursive=true` : '') + (pattern ? `, pattern="${args.pattern}"` : '') + ')');
  }
  L.push('');
  L.push('■ 下一步');
  L.push('  · 看内容：fsx_read / fsx_grep');
  L.push('  · 看结构：fsx_tree');

  return {
    _text: L.join('\n'),
    dir,
    recursive,
    depth: levels,
    sort,
    order,
    total,
    shown: pageItems.length,
    truncated,
    offset,
    limit,
    entries: pageItems.map(e => ({
      name: e.name, relPath: e.relPath, type: e.type, size: e.size,
      mtime: e.mtime ? new Date(e.mtime).toISOString() : null
    }))
  };
}

module.exports = {
  name: 'fsx_list',
  title: '列目录（递归/过滤/排序/翻页）',
  description:
    '列出目录内容。recursive 递归子目录（depth 控制层数，默认 5）；pattern 用 glob 过滤文件名（如 "*.js"）；' +
    'sort 按 name/size/mtime 排序（order 定方向）；limit/offset 分页并给出翻页提示。返回每项类型/大小/修改时间。',
  inputSchema,
  run
};
