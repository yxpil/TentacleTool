'use strict';
/**
 * 输出格式化：所有 kb 工具共用的紧凑文本 / 表格 / 截断逻辑
 *
 * 设计原则（Agent 上下文经济）：
 *  - 结果以 Markdown 表格或紧凑列表给出，一行一条
 *  - 单元格与总输出双重截断，宁可提示"已截断"也不要把上下文撑爆
 *  - 页脚给"下一步能做什么"的提示（如翻页 / 看 schema），让 Agent 自己决定深挖
 */

const DEFAULT_CELL = 500;
const DEFAULT_TOTAL = 24000;

/** 值 → 单元格字符串（处理 null / 对象 / 长文本截断） */
function cell(v, maxChars = DEFAULT_CELL) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.$binary) return `<binary ${v.bytes}B>`;
    try { v = JSON.stringify(v); } catch (e) { v = String(v); }
  }
  let s = String(v);
  // 换行会破坏表格结构，统一转成可见的 ␤
  s = s.replace(/\r\n/g, '\n').replace(/\n/g, '␤').replace(/\t/g, ' ');
  if (maxChars > 0 && s.length > maxChars) {
    s = s.slice(0, maxChars) + `…(+${s.length - maxChars})`;
  }
  return s;
}

/** 计算字符串的显示宽度（CJK 算 2 列） */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1100 && (
      cp <= 0x115f ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )) w += 2;
    else w += 1;
  }
  return w;
}

function pad(s, width) {
  const w = displayWidth(s);
  return s + ' '.repeat(Math.max(0, width - w));
}

/**
 * 渲染 Markdown 表格（对齐用等宽显示宽度计算）
 * @param {string[]} headers
 * @param {Array<Array<any>>} rows
 */
function table(headers, rows, opts = {}) {
  const cellMax = opts.cellMax || DEFAULT_CELL;
  const totalMax = opts.totalMax || DEFAULT_TOTAL;
  const body = rows.map(r => r.map(v => cell(v, cellMax)));

  const widths = headers.map((h, i) => {
    let w = displayWidth(h);
    for (const r of body) w = Math.max(w, displayWidth(r[i] ?? ''));
    return Math.min(w, opts.colMax || 60);
  });

  const truncate = (s) => {
    const max = opts.colMax || 60;
    if (displayWidth(s) <= max) return s;
    let out = '', w = 0;
    for (const ch of s) {
      const cw = displayWidth(ch);
      if (w + cw > max - 1) break;
      out += ch; w += cw;
    }
    return out + '…';
  };

  const lines = [];
  lines.push('| ' + headers.map((h, i) => pad(truncate(h), widths[i])).join(' | ') + ' |');
  lines.push('|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|');
  for (const r of body) {
    lines.push('| ' + headers.map((_, i) => pad(truncate(r[i] ?? ''), widths[i])).join(' | ') + ' |');
  }

  let out = lines.join('\n');
  if (out.length > totalMax && opts.allowTruncate !== false) {
    // 从末尾丢行，直到进预算，并明确告知丢了多少
    let dropped = 0;
    while (out.length > totalMax && lines.length > 3) {
      lines.pop(); dropped++;
      out = lines.join('\n');
    }
    out += `\n\n（表格已截断：省略 ${dropped} 行，输出上限 ${totalMax} 字符。请加 LIMIT 或缩小查询范围）`;
  }
  return out;
}

/** 紧凑的 key: value 列表 */
function kv(pairs, indent = '  ') {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => indent + k + ': ' + cell(v))
    .join('\n');
}

/** 分节标题 */
function section(title) {
  return '\n■ ' + title;
}

/** 通用截断保护 */
function clip(text, max = DEFAULT_TOTAL, hint) {
  if (text.length <= max) return text;
  const suffix = '\n\n（输出已截断：' + (hint || '请加 LIMIT 或缩小范围') + '）';
  return text.slice(0, max - suffix.length) + suffix;
}

/** 列表渲染（一行一条，带序号） */
function list(items, start = 1) {
  return items.map((it, i) => `${start + i}. ${it}`).join('\n');
}

/** 把毫秒格式化成人类可读 */
function ms(n) {
  if (n < 1000) return n + 'ms';
  return (n / 1000).toFixed(2) + 's';
}

/** 把字符数格式化 */
function chars(n) {
  if (n < 1000) return n + ' 字符';
  return (n / 1000).toFixed(1) + 'k 字符';
}

module.exports = { cell, table, kv, section, clip, list, ms, chars, displayWidth, pad };
