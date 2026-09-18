'use strict';
/**
 * fsx_edit —— 精确文本替换（匹配数校验，避免静默改错）
 */
const fs = require('fs');
const path = require('path');
const { countLines } = require('../utils/fsutil');

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要修改的文件路径' },
    oldText: { type: 'string', description: '要被替换掉的原文（必须非空；区分大小写、按字面量匹配，不是正则）' },
    newText: { type: 'string', description: '替换为的文本（默认空串，即删除原片段）' },
    replaceAll: { type: 'boolean', description: 'true=替换全部匹配；false=只替换第一处且要求恰好一处匹配（默认 false）' }
  },
  required: ['path', 'oldText']
};

function lineNumberOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function run(args) {
  const p = path.resolve(args.path || '');
  if (!fs.existsSync(p)) throw new Error('文件不存在：' + p);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error('这是一个目录，不是文件：' + p);

  const oldText = args.oldText;
  if (oldText == null || oldText === '') throw new Error('oldText 不能为空，无法定位要替换的内容');

  const original = fs.readFileSync(p, 'utf8');
  const newText = (args.newText == null ? '' : String(args.newText));
  const replaceAll = !!args.replaceAll;

  // 统计所有非重叠匹配位置
  const positions = [];
  let idx = 0;
  while ((idx = original.indexOf(oldText, idx)) !== -1) {
    positions.push(idx);
    idx += oldText.length;
  }
  const count = positions.length;

  if (count === 0) {
    throw new Error('未找到匹配文本：\n' + oldText.slice(0, 80) + (oldText.length > 80 ? '…' : '') +
      '\n（提示：oldText 按字面量精确匹配，区分大小写与空白；也可用 fsx_read 先确认实际内容）');
  }
  if (count > 1 && !replaceAll) {
    throw new Error(`找到 ${count} 处匹配，但 replaceAll=false。为避免静默改错，已拒绝执行。` +
      `请让 oldText 更精确以唯一匹配，或显式传 replaceAll=true 替换全部 ${count} 处。`);
  }

  let result, replaced;
  if (replaceAll) {
    result = original.split(oldText).join(newText);
    replaced = count;
  } else {
    const i = positions[0];
    result = original.slice(0, i) + newText + original.slice(i + oldText.length);
    replaced = 1;
  }

  fs.writeFileSync(p, result, 'utf8');

  const changedLineSet = new Set();
  const usePos = replaceAll ? positions : [positions[0]];
  for (const pos of usePos) changedLineSet.add(lineNumberOf(original, pos));
  const changedLines = Array.from(changedLineSet).sort((a, b) => a - b);

  const newSt = fs.statSync(p);
  const mode = replaceAll ? `全部替换(${replaced} 处)` : '唯一替换(第 1 处)';

  return {
    _text:
      `▸ 已替换 ${p}\n` +
      `  匹配数: ${count}  实际替换: ${replaced}\n` +
      `  改动行: ${changedLines.join(', ')}\n` +
      `  字节: ${newSt.size}  行数: ${countLines(result)}  模式: ${mode}`,
    path: p,
    matches: count,
    replaced,
    changedLines,
    bytes: newSt.size,
    lines: countLines(result)
  };
}

module.exports = {
  name: 'fsx_edit',
  title: '精确文本替换（匹配数校验）',
  description:
    '在文件内做字面量精确替换（区分大小写与空白，不是正则）。oldText/newText 必填 oldText。' +
    '关键安全：匹配 0 处会报错；匹配多处且 replaceAll=false 会拒绝执行（避免静默改错），' +
    '需让 oldText 更精确或显式 replaceAll=true。返回匹配数、实际替换数、改动行号、字节与行数。',
  inputSchema,
  run
};
