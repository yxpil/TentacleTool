'use strict';
/**
 * fsx_read —— 读文件（行范围 / 编码 / 大文件分页 / 二进制检测 / 续读提示）
 */
const fs = require('fs');
const path = require('path');
const { detectEncoding, isBinaryBuffer, countLines, fmtTime } = require('../utils/fsutil');

const DEFAULT_LIMIT = 500;

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要读取的文件路径（绝对路径或相对于 cwd 的相对路径）' },
    encoding: { type: 'string', description: '文本解码编码，默认 auto（按 BOM/内容猜测，优先 UTF-8）；也可显式传 utf8/utf16le/latin1 等。二进制一律拒绝回显' },
    startLine: { type: 'number', description: '起始行号（1 基，含），默认 1' },
    endLine: { type: 'number', description: '结束行号（1 基，含）；不传则按 limit 自动翻页' },
    limit: { type: 'number', description: '未指定 endLine 时每页显示行数，默认 500；超出给出续读提示' }
  },
  required: ['path']
};

function run(args) {
  const p = path.resolve(args.path || '');
  if (!fs.existsSync(p)) throw new Error('文件不存在：' + p);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error('这是一个目录，不是文件：' + p + '（用 fsx_list / fsx_tree 查看目录）');

  const buf = fs.readFileSync(p);
  const encInfo = detectEncoding(buf);

  // 二进制：宁可明确提示，也不吐乱码
  if (encInfo.encoding === 'binary') {
    const head = buf.slice(0, 16);
    const hex = Array.from(head).map(b => b.toString(16).padStart(2, '0')).join(' ');
    return {
      _text:
        `▸ 文件疑似二进制（含 NUL 字节），已停止按文本回显以避免乱码\n` +
        `  路径: ${p}\n` +
        `  大小: ${buf.length} 字节  编码判定: ${encInfo.label}\n` +
        `  前 16 字节 (hex): ${hex}${buf.length > 16 ? ' …' : ''}\n` +
        `  提示：若需查看内容，请用十六进制查看器，或在确定真实编码后显式传入 encoding 参数。`,
      path: p,
      exists: true,
      binary: true,
      encoding: 'binary',
      bytes: buf.length
    };
  }

  // 编码选择：auto 用猜测结果，否则用用户指定
  let encoding = 'utf8';
  if (args.encoding && args.encoding !== 'auto') encoding = args.encoding;
  else encoding = encInfo.encoding === 'binary' ? 'utf8' : encInfo.encoding;

  let text;
  try {
    text = buf.toString(encoding);
  } catch (e) {
    text = buf.toString('latin1');
    encoding = encoding + '→latin1(回退)';
  }

  // 按 \n 切分并去掉行尾 \r
  let lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;

  const limit = Math.max(1, parseInt(args.limit, 10) || DEFAULT_LIMIT);
  let startLine = Math.max(1, parseInt(args.startLine, 10) || 1);
  let endLine;
  if (args.endLine != null && args.endLine !== '') {
    endLine = parseInt(args.endLine, 10);
  } else {
    endLine = startLine + limit - 1;
  }
  startLine = Math.min(startLine, Math.max(1, totalLines));
  endLine = Math.max(startLine, Math.min(endLine, totalLines));

  const shown = lines.slice(startLine - 1, endLine);
  const truncated = endLine < totalLines;

  const L = [];
  L.push(`▸ 已读取 ${p}`);
  L.push(`  编码: ${encoding}  字节: ${buf.length}  总行数: ${totalLines}  显示: 第 ${startLine}–${endLine} 行` +
    (truncated ? `（后续还有 ${totalLines - endLine} 行）` : ''));
  for (let i = 0; i < shown.length; i++) {
    const n = startLine + i;
    L.push(String(n).padStart(String(totalLines).length, ' ') + ' │ ' + shown[i]);
  }
  if (truncated) {
    L.push('');
    L.push(`  续读: fsx_read(path="${p}", startLine=${endLine + 1})`);
  } else if (startLine > 1) {
    L.push('');
    L.push(`  回到首页: fsx_read(path="${p}", startLine=1)`);
  }
  L.push('');
  L.push('■ 下一步');
  L.push('  · 继续读：调整 startLine / endLine');
  L.push('  · 改内容：fsx_edit / fsx_write');
  L.push('  · 看属性：fsx_stat(path="' + p + '")');

  return {
    _text: L.join('\n'),
    path: p,
    exists: true,
    binary: false,
    encoding,
    bytes: buf.length,
    totalLines,
    startLine,
    endLine,
    truncated,
    lines: shown
  };
}

module.exports = {
  name: 'fsx_read',
  title: '读文件（行范围/编码/分页/二进制检测）',
  description:
    '读取一个文本文件的内容。支持：startLine/endLine 指定行范围；encoding 指定或自动猜测（UTF-8/UTF-16/Latin-1）' +
    '；大文件按 limit（默认 500 行）自动分页并显示续读提示；自动检测二进制（含 NUL），不回显乱码而是给出大小与 hex 预览。' +
    '返回总行数、字节数、编码与所显示行。',
  inputSchema,
  run
};
