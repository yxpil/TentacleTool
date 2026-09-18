'use strict';
/**
 * 输出格式化工具（面向模型的紧凑文本 + CJK 列宽对齐）
 */

/** 显示宽度：CJK 及全角字符计 2 列，其余计 1 列 */
function displayWidth(str) {
  const s = String(str);
  let w = 0;
  for (const ch of s) {
    if (/[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿　-〿＀-￯＀-￯]/.test(ch)) w += 2;
    else w += 1;
  }
  return w;
}

/** 字节数人类可读 */
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let u = 0;
  let v = n / 1024;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[u];
}

/** 按显示宽度右侧补齐到 width */
function padEndDisplay(str, width) {
  str = String(str);
  const pad = Math.max(0, width - displayWidth(str));
  return str + ' '.repeat(pad);
}

/** 按显示宽度截断文本，超出追加提示 */
function truncateText(str, max, note) {
  str = String(str == null ? '' : str);
  if (displayWidth(str) <= max) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = displayWidth(ch);
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out + (note != null ? note : '…(已截断)');
}

/**
 * 渲染对齐表格（CJK 计 2 列）
 * @param {string[]} headers   表头
 * @param {string[][]} rows    行（每行数组长度需与 headers 一致）
 * @param {object} [opts]      { align?: ('l'|'r')[], note?: boolean }
 */
function renderTable(headers, rows, opts) {
  opts = opts || {};
  const aligns = opts.align || headers.map(() => 'l');
  const cols = headers.length;
  const widths = new Array(cols).fill(0);
  const grid = [headers].concat(rows || []);
  for (const row of grid) {
    for (let i = 0; i < cols; i++) {
      const w = displayWidth(row[i] == null ? '' : row[i]);
      if (w > widths[i]) widths[i] = w;
    }
  }
  const line = '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|';
  const fmtRow = (row) => {
    const cells = [];
    for (let i = 0; i < cols; i++) {
      const cell = row[i] == null ? '' : String(row[i]);
      const w = widths[i];
      if (aligns[i] === 'r') {
        const pad = Math.max(0, w - displayWidth(cell));
        cells.push(' ' + ' '.repeat(pad) + cell + ' ');
      } else {
        cells.push(' ' + padEndDisplay(cell, w) + ' ');
      }
    }
    return '|' + cells.join('|') + '|';
  };
  const out = [line, fmtRow(headers), line];
  for (const r of (rows || [])) out.push(fmtRow(r));
  if ((rows || []).length) out.push(line);
  return out.join('\n');
}

/** 耗时毫秒紧凑显示 */
function fmtMs(ms) {
  ms = Number(ms) || 0;
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

module.exports = { displayWidth, fmtSize, padEndDisplay, truncateText, renderTable, fmtMs };
