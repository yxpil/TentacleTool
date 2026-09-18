'use strict';
/**
 * JSONPath 子集查询引擎（零依赖）
 *
 * 支持的语法（其余一律明确报错，不静默返回空数组）：
 *   $                  根
 *   .key  /  ['key']   成员访问（后者可含任意字符）
 *   [n]                数组下标（支持负数，-1 = 最后一个）
 *   [*]  /  .*         通配（数组元素或对象全部值）
 *   ..key  /  ..['k']  递归下降
 *   [start:end:step]   数组切片（支持负数、省略端点）
 *   [a,b]              多选（键或下标混用）
 *   .length            数组长度 / 字符串长度（便捷伪属性，非标准但极常用）
 *
 * 明确不支持（抛错并说明）：
 *   [?(...)]  过滤器表达式
 *   [?(...)]  中的比较/逻辑运算
 *   函数扩展（$.sum() 等）
 *
 * 返回带 path 定位的结果集，便于模型引用具体位置。
 */

class JsonPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonPathError';
  }
}

/** 把路径字符串切成一串 token */
function tokenize(path) {
  const s = String(path === undefined || path === null ? '' : path).trim();
  if (s === '') throw new JsonPathError('路径不能为空。请传入如 "$.users[0].name" 或 "$..id" 的 JSONPath。');
  const tokens = [];
  let i = 0;

  if (s[i] === '$') i++;
  else if (s[i] === '@') throw new JsonPathError('不支持以 @ 开头的路径（当前根节点只能用 $）。');

  // 以裸 key 开头也接受（如 "users[0]"），宽容一点
  while (i < s.length) {
    const ch = s[i];

    if (ch === '.') {
      // 递归下降
      if (s[i + 1] === '.') {
        i += 2;
        if (s[i] === '[') {
          const { token, next } = readBracket(s, i, true);
          if (token.type !== 'union' || token.items.length !== 1) {
            throw new JsonPathError('递归下降 ..[...] 只支持单个键或通配，如 ..[\'key\'] 或 ..[*]。');
          }
          tokens.push({ type: 'recursive', sel: token.items[0] });
          i = next;
          continue;
        }
        const { name, next } = readDotName(s, i);
        if (name === '') throw new JsonPathError('递归下降 ".." 后面缺少键名。');
        tokens.push({ type: 'recursive', sel: name === '*' ? { kind: 'wildcard' } : { kind: 'key', key: name } });
        i = next;
        continue;
      }
      i++;
      if (s[i] === '*') { tokens.push({ type: 'wildcard' }); i++; continue; }
      const { name, next } = readDotName(s, i);
      if (name === '') throw new JsonPathError(`位置 ${i} 的 "." 后面缺少键名（连续两个点请用 ".." 表示递归下降）。`);
      tokens.push({ type: 'key', key: name });
      i = next;
      continue;
    }

    if (ch === '[') {
      const { token, next } = readBracket(s, i, false);
      tokens.push(token);
      i = next;
      continue;
    }

    // 裸标识符（无点开头）
    const { name, next } = readDotName(s, i);
    if (name === '') throw new JsonPathError(`无法解析路径片段：${JSON.stringify(s.slice(i))}。`);
    tokens.push({ type: 'key', key: name });
    i = next;
  }

  if (tokens.length === 0) throw new JsonPathError('路径 " $ " 之后没有任何选择器。若要取整个文档请直接用 "$"。');
  return tokens;
}

/**
 * 点号后允许的标识符字符。
 * 刻意**不含 `-`** —— 虽然 `$.a-b` 在本实现里能解析，但含横杠的键名写成括号形式
 * 更不容易误读（也与 diff.js 的 renderPath 保持一致，两者必须同规则才能互逆）。
 * 为兼容手写路径，仍保留对 `-` 的接受：见 IDENT_RE。
 */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*/;

function readDotName(s, i) {
  if (s[i] === '*') return { name: '*', next: i + 1 };
  const m = IDENT_RE.exec(s.slice(i));
  if (!m) return { name: '', next: i };
  return { name: m[0], next: i + m[0].length };
}

/** 读取一个 [...] 选择器，返回 token 与结束位置 */
function readBracket(s, i, _afterDots) {
  const start = i;
  i++;   // 吃掉 [
  // 找到配对的 ]
  let depth = 1, inS = null;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (inS) {
      if (c === '\\') { j += 2; continue; }
      if (c === inS) inS = null;
      j++;
      continue;
    }
    if (c === '"' || c === "'") { inS = c; j++; continue; }
    if (c === '[') depth++;
    if (c === ']') { depth--; if (depth === 0) break; }
    j++;
  }
  if (j >= s.length) throw new JsonPathError(`路径里的 "[" 没有配对的 "]"（从位置 ${start} 开始）。`);

  const inner = s.slice(i, j);
  const next = j + 1;
  const trimmed = inner.trim();

  if (trimmed === '') throw new JsonPathError('空的下标 [] 无意义，请写 [0] 或 [*]。');

  // 过滤器明确拒绝
  if (trimmed.startsWith('?')) {
    throw new JsonPathError(
      '不支持过滤器表达式 [?(...)]。本实现对 JSONPath 的支持是子集（根 $ / .key / [n] / [*] / ..key / 切片 / 多选）。\n' +
      '若需要"筛选出满足条件的元素"，请改用 jsonx_query 取出数组后用 jsonx_aggregate 统计，或对结果自行判断。'
    );
  }
  if (trimmed.startsWith('(')) {
    throw new JsonPathError('不支持脚本表达式 [(...)]。');
  }

  if (trimmed === '*') return { token: { type: 'wildcard' }, next };

  // 切片：含 ':' 且不在引号内
  if (trimmed.includes(':')) {
    const parts = splitTop(trimmed, ':');
    if (parts.length > 3) throw new JsonPathError(`切片最多三段 [start:end:step]，收到 ${parts.length} 段：${JSON.stringify(trimmed)}`);
    const step = parts[2] !== undefined && parts[2].trim() !== '' ? toInt(parts[2], 'step') : 1;
    if (step === 0) throw new JsonPathError('切片的 step 不能为 0。');
    return {
      token: {
        type: 'slice',
        start: parts[0].trim() === '' ? null : toInt(parts[0], 'start'),
        end: parts[1] === undefined || parts[1].trim() === '' ? null : toInt(parts[1], 'end'),
        step
      },
      next
    };
  }

  // 多选 / 单键 / 单下标
  const items = splitTop(trimmed, ',').map(part => parseItem(part.trim()));
  return { token: { type: 'union', items }, next };
}

function splitTop(s, sep) {
  const out = [];
  let buf = '', inS = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inS) {
      if (c === '\\') { buf += c + (s[++i] || ''); continue; }
      if (c === inS) inS = null;
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") { inS = c; buf += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}

function parseItem(part) {
  if (part === '') throw new JsonPathError('多选 [a,b] 里有空项，请检查逗号位置。');
  if (part === '*') return { kind: 'wildcard' };
  if (part[0] === '"' || part[0] === "'") {
    // 必须走 parseQuotedKey 解转义：键名里可以含引号（如 a"b → $["a\"b"]），
    // 直接 slice(1,-1) 会把反斜杠原样留下，导致键名对不上。
    return { kind: 'key', key: parseQuotedKey(part) };
  }
  if (/^-?\d+$/.test(part)) return { kind: 'index', index: parseInt(part, 10) };
  // 裸键（YAML 风格的多选 [a, b]）
  return { kind: 'key', key: part };
}

/**
 * 解析括号里的引号键，处理 \" \\ \' \n \t \uXXXX 等转义。
 * 这是 renderPath 的反函数 —— 两者必须互逆，否则 diff 报出的路径无法被 query 使用。
 */
function parseQuotedKey(s) {
  const q = s[0];
  if (q !== '"' && q !== "'") throw new JsonPathError(`内部错误：parseQuotedKey 收到非引号开头的内容 ${JSON.stringify(s)}`);
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i];
      switch (n) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'u': {
          const hex = s.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
          else out += 'u';
          break;
        }
        default: out += n;
      }
      continue;
    }
    if (c === q) break;   // 遇到闭合引号，键名结束
    out += c;
  }
  return out;
}

function toInt(s, label) {
  const t = String(s).trim();
  if (!/^-?\d+$/.test(t)) throw new JsonPathError(`切片的 ${label} 必须是整数，收到 ${JSON.stringify(s)}。`);
  return parseInt(t, 10);
}

/* ============================== 求值 ============================== */

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isArr = v => Array.isArray(v);

/** 便捷伪属性：.length（数组长度 / 字符串长度）、.keys（对象键数组）、.values（对象值数组） */
const PSEUDO = new Set(['length', 'keys', 'values']);

function pseudoValue(node, key) {
  if (key === 'length') {
    if (isArr(node)) return node.length;
    if (typeof node === 'string') return node.length;
    if (isObj(node)) return Object.keys(node).length;
    return undefined;
  }
  if (key === 'keys') return isObj(node) ? Object.keys(node) : undefined;
  if (key === 'values') return isObj(node) ? Object.values(node) : undefined;
  return undefined;
}

function renderPath(base, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) return base + '.' + key;
  return base + '[' + JSON.stringify(key) + ']';
}

/**
 * 在 value 上求值 token 序列
 * @returns {Array<{ value, path }>}
 */
function evaluate(value, tokens) {
  let cur = [{ value, path: '$' }];
  for (const tk of tokens) {
    const next = [];
    for (const node of cur) {
      switch (tk.type) {
        case 'key': {
          const v = getKey(node.value, tk.key);
          if (v !== undefined) next.push({ value: v, path: renderPath(node.path, tk.key) });
          break;
        }
        case 'wildcard': {
          if (isArr(node.value)) {
            node.value.forEach((v, idx) => next.push({ value: v, path: node.path + '[' + idx + ']' }));
          } else if (isObj(node.value)) {
            for (const k of Object.keys(node.value)) next.push({ value: node.value[k], path: renderPath(node.path, k) });
          }
          break;
        }
        case 'union': {
          for (const item of tk.items) {
            if (item.kind === 'wildcard') {
              if (isArr(node.value)) node.value.forEach((v, idx) => next.push({ value: v, path: node.path + '[' + idx + ']' }));
              else if (isObj(node.value)) for (const k of Object.keys(node.value)) next.push({ value: node.value[k], path: renderPath(node.path, k) });
            } else if (item.kind === 'index') {
              if (isArr(node.value)) {
                const idx = item.index < 0 ? node.value.length + item.index : item.index;
                if (idx >= 0 && idx < node.value.length) next.push({ value: node.value[idx], path: node.path + '[' + idx + ']' });
              }
            } else {
              const v = getKey(node.value, item.key);
              if (v !== undefined) next.push({ value: v, path: renderPath(node.path, item.key) });
            }
          }
          break;
        }
        case 'slice': {
          if (!isArr(node.value)) break;
          for (const idx of sliceIndices(node.value.length, tk.start, tk.end, tk.step)) {
            next.push({ value: node.value[idx], path: node.path + '[' + idx + ']' });
          }
          break;
        }
        case 'recursive': {
          collectRecursive(node.value, node.path, tk.sel, next);
          break;
        }
        default:
          throw new JsonPathError(`内部错误：未知 token 类型 ${tk.type}`);
      }
    }
    cur = next;
  }
  return cur;
}

function getKey(node, key) {
  if (isObj(node)) {
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    if (PSEUDO.has(key)) return pseudoValue(node, key);
    return undefined;
  }
  if (isArr(node)) {
    if (PSEUDO.has(key)) return pseudoValue(node, key);
    // 数组上的数字键
    if (/^\d+$/.test(key)) {
      const idx = parseInt(key, 10);
      return idx < node.length ? node[idx] : undefined;
    }
    return undefined;
  }
  if (typeof node === 'string' && key === 'length') return node.length;
  return undefined;
}

/** 切片索引展开，遵循 Python/JSONPath 的负索引与负步长语义 */
function sliceIndices(len, start, end, step) {
  const out = [];
  if (step > 0) {
    let s = start === null ? 0 : (start < 0 ? Math.max(len + start, 0) : Math.min(start, len));
    let e = end === null ? len : (end < 0 ? Math.max(len + end, 0) : Math.min(end, len));
    for (let i = s; i < e; i += step) out.push(i);
  } else {
    let s = start === null ? len - 1 : (start < 0 ? len + start : Math.min(start, len - 1));
    if (s > len - 1) s = len - 1;
    let e = end === null ? -1 : (end < 0 ? len + end : Math.min(end, len - 1));
    for (let i = s; i > e; i += step) out.push(i);
  }
  return out;
}

/**
 * 递归下降收集。
 * 语义：**先匹配当前节点**，再递归子节点（与主流实现一致）。
 * 匹配时包住整棵子树 —— 否则 `$..` 会退化成无限展开。
 */
function collectRecursive(node, path, sel, out) {
  if (sel.kind === 'key') {
    if (isObj(node) && Object.prototype.hasOwnProperty.call(node, sel.key)) {
      out.push({ value: node[sel.key], path: renderPath(path, sel.key) });
    } else if (isObj(node) && PSEUDO.has(sel.key)) {
      const v = pseudoValue(node, sel.key);
      if (v !== undefined) out.push({ value: v, path: renderPath(path, sel.key) });
    } else if (isArr(node) && PSEUDO.has(sel.key)) {
      const v = pseudoValue(node, sel.key);
      if (v !== undefined) out.push({ value: v, path: path + '.' + sel.key });
    }
  } else {
    // 通配：数组取元素，对象取值
    if (isArr(node)) node.forEach((v, i) => out.push({ value: v, path: path + '[' + i + ']' }));
    else if (isObj(node)) for (const k of Object.keys(node)) out.push({ value: node[k], path: renderPath(path, k) });
  }
  // 继续下钻
  if (isArr(node)) {
    node.forEach((v, i) => { if (v !== null && typeof v === 'object') collectRecursive(v, path + '[' + i + ']', sel, out); });
  } else if (isObj(node)) {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v !== null && typeof v === 'object') collectRecursive(v, renderPath(path, k), sel, out);
    }
  }
}

/**
 * 对外主入口
 * @param {any} value 已解析的数据
 * @param {string} path JSONPath
 * @returns {{ matches: Array<{path, value}>, count, paths }}
 */
function query(value, path) {
  const p = String(path === undefined || path === null ? '$' : path).trim();
  if (p === '$' || p === '') return { matches: [{ path: '$', value }], count: 1, root: true };
  const tokens = tokenize(p);
  const matches = evaluate(value, tokens);
  return {
    matches: matches.map(m => ({ path: m.path, value: m.value })),
    count: matches.length,
    root: false
  };
}

/** 只取匹配到的值（不带路径） */
function queryValues(value, path) {
  return query(value, path).matches.map(m => m.value);
}

/** 校验路径是否合法（不实际求值），返回 null 表示合法 */
function validatePath(path) {
  try { tokenize(path); return null; }
  catch (e) { return e.message; }
}

module.exports = {
  JsonPathError,
  tokenize,
  query,
  queryValues,
  validatePath,
  sliceIndices,
  collectRecursive,
  PSEUDO
};
