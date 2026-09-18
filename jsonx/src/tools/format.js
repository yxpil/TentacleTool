'use strict';
/**
 * 输出格式化：jsonx 各工具共用的紧凑文本 / 表格 / 截断逻辑
 *
 * 与 kb / calc 等工具集保持同一套约定，便于 Agent 形成稳定的阅读预期：
 *  - 结果以 Markdown 表格或紧凑列表给出，一行一条
 *  - 单元格与总输出双重截断，宁可提示"已截断"也不要把上下文撑爆
 *  - 顶部给结论，底部给"下一步能做什么"
 */

const DEFAULT_CELL = 500;
const DEFAULT_TOTAL = 24000;

/** 值 → 单元格字符串（处理 null / 对象 / 长文本截断） */
function cell(v, maxChars = DEFAULT_CELL) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    try { v = JSON.stringify(v); } catch (e) { v = String(v); }
  }
  let s = String(v);
  // 换行会破坏表格结构
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
    let dropped = 0;
    while (out.length > totalMax && lines.length > 3) {
      lines.pop(); dropped++;
      out = lines.join('\n');
    }
    out += `\n\n（表格已截断：省略 ${dropped} 行，输出上限 ${totalMax} 字符）`;
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
  const suffix = '\n\n（输出已截断：' + (hint || '请缩小范围') + '）';
  return text.slice(0, max - suffix.length) + suffix;
}

/** 列表渲染（一行一条，带序号） */
function list(items, start = 1) {
  return items.map((it, i) => `${start + i}. ${it}`).join('\n');
}

/** 时长（毫秒）→ 人类可读，带秒/毫秒双精度 */
function ms(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return n + 'ms';
  if (abs < 60000) return (n / 1000).toFixed(3).replace(/\.?0+$/, '') + 's';
  return (n / 60000).toFixed(3).replace(/\.?0+$/, '') + 'min';
}

/* ======================== jsonx 专用格式化辅助 ======================== */

/** 值的类型名（面向用户的中文/英文混合表述） */
function typeName(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'number(整数)' : 'number';
  if (typeof v === 'boolean') return 'boolean';
  return typeof v;
}

/** 一个值的规模描述：数组"12 个元素"、对象"5 个键"、标量给出值 */
function describeSize(v) {
  if (v === null || v === undefined) return '空';
  if (Array.isArray(v)) return `${v.length} 个元素`;
  if (typeof v === 'object') return `${Object.keys(v).length} 个键`;
  if (typeof v === 'string') return `${v.length} 字符`;
  return String(v).slice(0, 60);
}

/** 表格形状描述 */
function describeTabular(meta) {
  if (!meta) return '—';
  const parts = [`${meta.rowCount} 行 × ${meta.columns} 列`];
  if (meta.raggedRows > 0) parts.push(`${meta.raggedRows} 行列数不齐`);
  if (meta.truncated) parts.push(`已截断 ${meta.truncated} 行`);
  return parts.join('，');
}

/** 安全 JSON 字符串化：循环引用 / BigInt / undefined 都不崩 */
function safeStringify(v, maxLen = 0) {
  const seen = new WeakSet();
  let out;
  try {
    out = JSON.stringify(v, (key, val) => {
      if (typeof val === 'bigint') return String(val) + 'n';
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[循环引用]';
        seen.add(val);
      }
      return val;
    }, 2);
  } catch (e) {
    out = String(v);
  }
  if (out === undefined) out = String(v);
  if (maxLen > 0 && out.length > maxLen) {
    out = out.slice(0, maxLen) + `\n…（截断，共 ${out.length} 字符；用 jsonx_convert 取完整内容）`;
  }
  return out;
}

/** 缩进一个多行文本块 */
function indentBlock(text, indent = '  ') {
  return String(text).split('\n').map(l => indent + l).join('\n');
}

/**
 * 记录数组的紧凑预览：一行一条，把字段名略去（首条给出表头说明）
 * 这比 JSON 缩进输出省 3-5 倍上下文。
 */
function previewRows(rows, limit = 5) {
  const items = rows.slice(0, limit);
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    if (r === null || typeof r !== 'object') { lines.push(`${i}. ${cell(r)}`); continue; }
    if (Array.isArray(r)) { lines.push(`${i}. [${r.map(x => cell(x, 60)).join(', ')}]`); continue; }
    const parts = Object.entries(r).map(([k, v]) => `${k}=${cell(v, 80)}`);
    const oneLine = `${i}. ` + parts.join('  ');
    if (oneLine.length > 200) {
      lines.push(`${i}.`);
      for (const p of parts) lines.push('     ' + p);
    } else {
      lines.push(oneLine);
    }
  }
  if (rows.length > limit) lines.push(`   …（另有 ${rows.length - limit} 条）`);
  return lines.join('\n');
}

module.exports = {
  cell, table, kv, section, clip, list, ms, displayWidth, pad,
  typeName, describeSize, describeTabular, safeStringify, indentBlock, previewRows
};
