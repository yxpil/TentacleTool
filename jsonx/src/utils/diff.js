'use strict';
/**
 * 结构化 diff：递归比较两个已解析的数据结构
 *
 * 为什么不用文本 diff：JSON 的键顺序与缩进都会产生假差异。
 * `{"a":1,"b":2}` 与 `{"b":2,"a":1}` 在文本 diff 下是"整行改动"，
 * 在结构化 diff 下才是"完全相等"（正确的答案）。
 *
 * 三类容器各自分支：
 *   对象 → 按 key 集合的并集分类 added / removed / changed / unchanged
 *   数组 → 默认按索引比较（JSON 语义），可选 byKey 按元素内某字段匹配，
 *          可选 ignoreArrayOrder 无视顺序做多重集比较
 *   标量 → 直接比较（数值 1 与 1.0 在 JSON 语义上相等）
 *
 * 输出带 JSONPath 风格的位置，便于模型引用具体改动点。
 */

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isArr = v => Array.isArray(v);

/** 值类型标签 */
function typeTag(v) {
  if (v === null) return 'null';
  if (isArr(v)) return 'array';
  if (isObj(v)) return 'object';
  return typeof v;
}

/** 标量比较：数值型统一按 Number 比（1 vs 1.0 相等），其余按严格相等 */
function scalarEqual(a, b) {
  const ta = typeTag(a), tb = typeTag(b);
  if (ta !== tb) {
    // 数值的 integer/number 在 JS 里都是 'number'，无需特判
    return false;
  }
  if (ta === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return a === b;
}

/** 稳定的值摘要（用于报告展示，长值截断） */
function summarize(v, maxLen = 120) {
  let s;
  if (v === undefined) s = 'undefined';
  else if (typeof v === 'string') s = JSON.stringify(v);
  else {
    try { s = JSON.stringify(v); } catch (e) { s = String(v); }
  }
  if (s === undefined) s = String(v);
  if (s.length > maxLen) s = s.slice(0, maxLen) + `…(+${s.length - maxLen})`;
  return s;
}

/**
 * 键名 → JSONPath 片段
 *
 * 安全标识符走点号，其余走括号 + 引号。
 *
 * 引号内的转义**必须与 jsonpath.js 的 parseQuotedKey 严格互逆**。
 * 踩过的坑：最初直接用 JSON.stringify(key) 拼括号形式，而 JSON.stringify 的转义
 * 词表（\b \f \v 等）与解析器的词表不一致 —— 键名 `a\b`（反斜杠+b）被写成
 * $["a\b"]，解析时 `\b` 被当成退格转义吃掉反斜杠，键名变成 `ab` 找不到。
 * 所以这里只用一套最小、明确的转义：\ " 以及控制字符。
 */
function escapeKeyForPath(key) {
  let out = '';
  for (const ch of String(key)) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out;
}

function renderPath(base, key) {
  const k = String(key);
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) return base + '.' + k;
  return base + '["' + escapeKeyForPath(k) + '"]';
}

/**
 * 主入口
 * @param {any} a 左（older / expected）
 * @param {any} b 右（newer / actual）
 * @param {object} opts
 *   arrayMode        'index'（默认）| 'byKey' | 'ignoreOrder'
 *   arrayKey         当 arrayMode='byKey' 时用于匹配元素的字段名（默认 'id'）
 *   ignoreArrayOrder 等价于 arrayMode='ignoreOrder'
 *   ignoreKeys       路径前缀黑名单（如 ['updatedAt']），这些键整体跳过
 *   maxChanges       改动条数上限（默认 500），超出后停止收集并标记 truncated
 *   numericTolerance 数值容差（默认 0，严格相等）
 * @returns {{ equal, changes, stats, truncated }}
 */
function diff(a, b, opts = {}) {
  const maxChanges = opts.maxChanges || 500;
  const ignoreKeys = opts.ignoreKeys || [];
  const numericTolerance = opts.numericTolerance || 0;
  // 接受两种写法：arrayMode 是正规名，ignoreOrder / ignoreArrayOrder 是便捷布尔开关
  // （踩过：最初只读 ignoreArrayOrder，用户按文档写 ignoreOrder 时静默无效）
  const ignoreOrderFlag = opts.ignoreOrder !== undefined ? opts.ignoreOrder : opts.ignoreArrayOrder;
  let arrayMode = opts.arrayMode || (ignoreOrderFlag ? 'ignoreOrder' : 'index');
  if (!['index', 'byKey', 'ignoreOrder'].includes(arrayMode)) {
    throw new Error(`arrayMode 只能是 index / byKey / ignoreOrder，收到 ${JSON.stringify(opts.arrayMode)}`);
  }
  const arrayKey = opts.arrayKey || 'id';

  const changes = [];
  const stats = { added: 0, removed: 0, changed: 0, unchanged: 0, typeChanges: 0, compared: 0 };
  let truncated = false;

  const ignored = (path) => ignoreKeys.some(k => path === k || path.startsWith(k + '.') || path.startsWith(k + '['));

  function record(kind, path, va, vb, extra) {
    if (changes.length >= maxChanges) { truncated = true; return; }
    changes.push({ kind, path, ...(extra || {}), ...(kind === 'removed' ? { left: summarize(va) } : {}), ...(kind === 'added' ? { right: summarize(vb) } : {}), ...(kind === 'changed' ? { left: summarize(va), right: summarize(vb) } : {}) });
  }

  function walk(va, vb, path) {
    if (ignored(path)) return;
    stats.compared++;

    const ta = typeTag(va), tb = typeTag(vb);
    if (ta !== tb) {
      stats.typeChanges++;
      record('changed', path, va, vb, { reason: `类型变化 ${ta} → ${tb}` });
      return;
    }

    if (ta === 'object') {
      const ka = Object.keys(va), kb = Object.keys(vb);
      const setA = new Set(ka), setB = new Set(kb);
      for (const k of ka) {
        const p = renderPath(path, k);
        if (!setB.has(k)) { stats.removed++; record('removed', p, va[k]); }
      }
      for (const k of kb) {
        const p = renderPath(path, k);
        if (!setA.has(k)) { stats.added++; record('added', p, undefined, vb[k]); }
      }
      for (const k of ka) {
        if (!setB.has(k)) continue;
        walk(va[k], vb[k], renderPath(path, k));
      }
      return;
    }

    if (ta === 'array') {
      if (arrayMode === 'index') { walkArrayByIndex(va, vb, path); return; }
      if (arrayMode === 'byKey') { walkArrayByKey(va, vb, path); return; }
      walkArrayIgnoreOrder(va, vb, path);
      return;
    }

    // 标量
    if (typeof va === 'number' && typeof vb === 'number' && numericTolerance > 0) {
      const d = Math.abs(va - vb);
      if (d <= numericTolerance) { stats.unchanged++; return; }
      stats.changed++;
      record('changed', path, va, vb, { reason: `差值 ${d} 超过容差 ${numericTolerance}` });
      return;
    }
    if (scalarEqual(va, vb)) { stats.unchanged++; return; }
    stats.changed++;
    record('changed', path, va, vb);
  }

  function walkArrayByIndex(va, vb, path) {
    const n = Math.max(va.length, vb.length);
    const common = Math.min(va.length, vb.length);
    for (let i = 0; i < common; i++) walk(va[i], vb[i], path + '[' + i + ']');
    for (let i = common; i < va.length; i++) { stats.removed++; record('removed', path + '[' + i + ']', va[i]); }
    for (let i = common; i < vb.length; i++) { stats.added++; record('added', path + '[' + i + ']', undefined, vb[i]); }
    if (va.length !== vb.length) {
      record('changed', path + '.length', va.length, vb.length, { reason: '数组长度变化' });
      stats.changed++;
    }
  }

  function walkArrayByKey(va, vb, path) {
    const keyOf = (el, i) => {
      if (isObj(el) && Object.prototype.hasOwnProperty.call(el, arrayKey)) return String(el[arrayKey]);
      // 缺 key 的元素退回索引匹配，并明确标注
      return null;
    };
    const mapA = new Map(), mapB = new Map();
    const noKeyA = [], noKeyB = [];
    va.forEach((el, i) => { const k = keyOf(el, i); if (k === null) noKeyA.push({ el, i }); else mapA.set(k, { el, i }); });
    vb.forEach((el, i) => { const k = keyOf(el, i); if (k === null) noKeyB.push({ el, i }); else mapB.set(k, { el, i }); });

    for (const [k, item] of mapA) {
      if (!mapB.has(k)) { stats.removed++; record('removed', path + `[${arrayKey}=${k}]`, item.el); }
    }
    for (const [k, item] of mapB) {
      if (!mapA.has(k)) { stats.added++; record('added', path + `[${arrayKey}=${k}]`, undefined, item.el); }
    }
    for (const [k, item] of mapA) {
      const other = mapB.get(k);
      if (other) walk(item.el, other.el, path + `[${arrayKey}=${k}]`);
    }
    for (let i = 0; i < Math.max(noKeyA.length, noKeyB.length); i++) {
      const a = noKeyA[i], b = noKeyB[i];
      if (a && b) walk(a.el, b.el, path + `[#${i}]`);
      else if (a) { stats.removed++; record('removed', path + `[#${i}]`, a.el); }
      else { stats.added++; record('added', path + `[#${i}]`, undefined, b.el); }
    }
  }

  function walkArrayIgnoreOrder(va, vb, path) {
    const used = new Array(vb.length).fill(false);
    const unmatchedA = [];
    for (const ea of va) {
      const key = summarize(ea, 1e9);
      let found = -1;
      for (let j = 0; j < vb.length; j++) {
        if (used[j]) continue;
        if (summarize(vb[j], 1e9) === key) { found = j; break; }
      }
      if (found >= 0) { used[found] = true; stats.unchanged++; }
      else unmatchedA.push(ea);
    }
    const unmatchedB = [];
    for (let j = 0; j < vb.length; j++) if (!used[j]) unmatchedB.push(vb[j]);
    unmatchedA.forEach(el => { stats.removed++; record('removed', path + '[?]', el); });
    unmatchedB.forEach(el => { stats.added++; record('added', path + '[?]', undefined, el); });
  }

  walk(a, b, '$');

  return {
    equal: changes.length === 0,
    changes,
    stats,
    truncated,
    options: { arrayMode, arrayKey, numericTolerance, ignoreKeys }
  };
}

module.exports = { diff, summarize, scalarEqual, typeTag, renderPath };
