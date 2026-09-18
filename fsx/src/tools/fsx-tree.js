'use strict';
/**
 * fsx_tree —— 目录树（可视树形、深度限制、默认忽略噪声目录）
 */
const fs = require('fs');
const path = require('path');
const { safeStat } = require('../utils/fsutil');

const DEFAULT_IGNORE = ['node_modules', '.git', '.svn', 'dist', 'build', '.idea', '.vscode', '__pycache__', 'target', '.next', 'out'];

const MAX_NODES = 6000;

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要生成树的根目录（默认当前工作目录）' },
    depth: { type: 'number', description: '最大展开深度，默认 3（0 表示只显示根）' },
    ignore: { type: 'array', items: { type: 'string' }, description: '要忽略的目录/文件名（不展开也不显示），默认含 node_modules/.git/dist 等噪声项；传 [] 关闭忽略' }
  }
};

function run(args) {
  const root = path.resolve(args.path || '.');
  if (!fs.existsSync(root)) throw new Error('目录不存在：' + root);
  if (!fs.statSync(root).isDirectory()) throw new Error('这不是一个目录：' + root);

  const maxDepth = Math.max(0, Math.min(parseInt(args.depth, 10) == null ? 3 : parseInt(args.depth, 10), 20));
  let ignoreSet;
  if (args.ignore === undefined) ignoreSet = new Set(DEFAULT_IGNORE);
  else if (Array.isArray(args.ignore)) ignoreSet = new Set(args.ignore);
  else ignoreSet = new Set();

  const nodes = [];
  let capped = false;

  // 层级语义：root = 第 0 层；展开到 maxDepth 层（含）。depth=0 只显示根。
  function walk(dir, prefix, level) {
    if (capped) return;
    if (level >= maxDepth) return; // 不展开超过 maxDepth 的层级
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    const items = [];
    for (const n of names) {
      if (capped) break;
      if (ignoreSet.has(n)) continue;
      const full = path.join(dir, n);
      const st = safeStat(full);
      items.push({ n, full, isDir: st ? st.isDirectory() : false });
    }
    items.sort((a, b) => (a.isDir === b.isDir ? a.n.localeCompare(b.n) : (a.isDir ? -1 : 1)));
    const lastIdx = items.length - 1;
    for (let i = 0; i < items.length; i++) {
      if (capped) break;
      const it = items[i];
      const isLast = i === lastIdx;
      const connector = isLast ? '└── ' : '├── ';
      const label = it.n + (it.isDir ? '/' : '');
      nodes.push({ relPath: path.relative(root, it.full), type: it.isDir ? 'dir' : 'file' });
      if (nodes.length >= MAX_NODES) { capped = true; return; }
      const line = prefix + connector + label;
      lines.push(line);
      if (it.isDir) {
        walk(it.full, prefix + (isLast ? '    ' : '│   '), level + 1);
      }
    }
  }

  const rootName = path.basename(root) || root;
  const lines = [rootName + '/'];
  nodes.push({ relPath: '.', type: 'dir' });
  walk(root, '', 0);

  const L = [];
  L.push(`▸ 目录树 ${root}`);
  L.push(`  深度: ${maxDepth}  忽略项: ${ignoreSet.size ? Array.from(ignoreSet).join(', ') : '（无）'}`);
  L.push('');
  L.push(lines.join('\n'));
  if (capped) L.push(`\n（节点过多，已截断显示，最多 ${MAX_NODES} 个节点）`);

  return {
    _text: L.join('\n'),
    root,
    depth: maxDepth,
    ignored: Array.from(ignoreSet),
    nodeCount: nodes.length,
    truncated: capped,
    nodes
  };
}

module.exports = {
  name: 'fsx_tree',
  title: '目录树（可视树形/深度限制/忽略噪声目录）',
  description:
    '生成目录的可视树形结构。depth 控制展开深度（默认 3）；ignore 指定要完全跳过不显示的目录/文件（' +
    '默认含 node_modules/.git/dist/build 等噪声项，传 [] 可关闭）。返回树文本与节点列表。',
  inputSchema,
  run
};
