'use strict';
/**
 * 输出格式化：所有工具共用，保证 Agent 读到的东西省上下文又好用。
 *
 * 三条原则：
 *   1) 先给"一句话结论"，再给明细——Agent 常常只需要结论就知道下一步
 *   2) 明细必须**截断且可追溯**：给出总数 + 已显示数，并用 file:line 定位
 *   3) 空结果也要说清"为什么空"，而不是干瘪的 0——不然 Agent 无法判断
 *      是没找到还是工具没生效
 */

/** 相对路径显示：优先短路径，方便 Agent 直接拿去 Read */
function rel(root, abs) {
  if (!abs) return '';
  let p = String(abs).replace(/\\/g, '/');
  const r = String(root || '').replace(/\\/g, '/');
  if (r && p.startsWith(r)) p = p.slice(r.length);
  return p.replace(/^\/+/, '');
}

/** 符号的展示名：带容器，如 Walker.scan */
function label(card) {
  if (!card) return '(unknown)';
  if (card.kind === 'file') return card.file;
  return card.container ? card.container + '.' + card.name : card.name;
}

/** 位置串：file:line */
function loc(card) {
  if (!card) return '';
  return card.file + ':' + card.line;
}

/** 一行符号摘要：用于列表输出 */
function symbolLine(card, extra) {
  const bits = [card.kind, label(card), loc(card)];
  if (card.exported) bits.push('exported');
  if (card.doc) bits.push('— ' + card.doc.slice(0, 80));
  return bits.join(' | ') + (extra ? ' ' + extra : '');
}

/**
 * 截断列表并附上计数说明
 * @returns {{ items: Array, note: string }}
 */
function take(list, limit) {
  const n = list.length;
  if (n <= limit) return { items: list, note: '' };
  return {
    items: list.slice(0, limit),
    note: `（共 ${n} 条，已显示前 ${limit} 条；可用 limit 参数调大）`
  };
}

/** 按字段分组计数，返回 [ [key, count], ... ] 按数量降序 */
function tally(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x) || '(none)';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** 人类可读的计数行 */
function countLine(label, n) {
  return `${label}: ${n}`;
}

module.exports = { rel, label, loc, symbolLine, take, tally, countLine };
