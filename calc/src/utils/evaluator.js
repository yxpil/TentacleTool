'use strict';
/**
 * 求值器（零依赖）
 *
 * 遍历 AST 求值。设计要点：
 *   - 纯实数运算走 Number 快路径（绝大多数算式），出现虚部才升级到复数
 *   - 变量作用域：作用域链（父 → 子），支持多语句里定义/复用变量
 *   - 角度制：三角/反三角按 ctx.angleMode 换算（rad / deg / grad）
 *   - 精度清理：每步运算后把 1e-12 以下的噪声归零，避免误差累积
 *   - 错误信息带上下文：未定义变量会给"你是不是想用 xxx"的提示
 */
const cx = require('./complex');
const { lookupFunction, FUNCTIONS, num, markCtx } = require('./functions');
const { lookupConstant, CONSTANTS } = require('./constants');
const { formatValue } = require('./format');

class CalcEvalError extends Error {
  constructor(message, expr, pos) {
    super(message);
    this.name = 'CalcEvalError';
    this.expr = expr;
    this.pos = pos;
  }
}

/* ======================== 作用域 ======================== */

class Scope {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
  }
  has(name) {
    if (this.vars.has(name)) return true;
    return this.parent ? this.parent.has(name) : false;
  }
  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    return undefined;
  }
  set(name, value) {
    this.vars.set(name, value);
    return value;
  }
  /** 导出为普通对象（给工具输出/调试用） */
  toObject() {
    const base = this.parent ? this.parent.toObject() : {};
    for (const [k, v] of this.vars) base[k] = v;
    return base;
  }
}

/* ======================== 求值上下文 ======================== */

class Context {
  constructor(opts = {}) {
    this.angleMode = normalizeAngleMode(opts.angleMode);
    this.scope = opts.scope || new Scope();
    this.precision = opts.precision || 12;
    // 记录赋值顺序，供输出"变量"清单
    this.assigned = [];
    // 当前正在求值的源码（用于错误定位提示）
    this.src = opts.src || null;
  }
  child() {
    return new Context({
      angleMode: this.angleMode,
      scope: this.scope,
      precision: this.precision,
      src: this.src
    });
  }
}

function normalizeAngleMode(m) {
  if (!m) return 'rad';
  const s = String(m).toLowerCase();
  if (s === 'deg' || s === 'degree' || s === 'degrees' || s === '角度') return 'deg';
  if (s === 'grad' || s === 'gradian' || s === 'gradians') return 'grad';
  return 'rad';
}

/* ======================== 主求值 ======================== */

/**
 * 求值整个程序
 * @returns {Array<{expr, node, value, assign}>} 每条语句的结果
 */
function evaluateProgram(ast, ctx) {
  const c = ctx || new Context({ src: ast && ast.src });
  const results = [];
  for (const node of ast.body) {
    const value = evaluate(node, c);
    results.push({ node, value });
  }
  return results;
}

function evaluate(node, ctx) {
  if (!node) return undefined;
  switch (node.type) {
    case 'program': {
      // 便捷：直接把整个程序交给 evaluate 时返回最后一条语句的值
      const rs = evaluateProgram(node, ctx);
      return rs.length ? rs[rs.length - 1].value : undefined;
    }

    case 'num':
      return node.value;

    case 'group':
      return evaluate(node.expr, ctx);

    case 'array': {
      const items = node.items.map(it => evaluate(it, ctx));
      return items;
    }

    case 'range':
      return evaluateRange(node, ctx);

    case 'var':
      return evaluateVar(node, ctx);

    case 'binary':
      return evaluateBinary(node, ctx);

    case 'unary':
      return evaluateUnary(node, ctx);

    case 'postfix':
      return evaluatePostfix(node, ctx);

    case 'postfixAssign':
      return evaluatePostfixAssign(node, ctx);

    case 'call':
      return evaluateCall(node, ctx);

    case 'assign':
      return evaluateAssign(node, ctx);

    default:
      throw new CalcEvalError('未知的 AST 节点类型: ' + node.type);
  }
}

/** 展开区间：`1:5` → [1,2,3,4,5]，`1:2:9` → [1,3,5,7,9] */
function evaluateRange(node, ctx) {
  const a = num(evaluate(node.start, ctx), '区间');
  const b = num(evaluate(node.end, ctx), '区间');
  const step = node.step ? num(evaluate(node.step, ctx), '区间步长') : (b >= a ? 1 : -1);
  if (step === 0) throw new CalcEvalError('区间步长不能为 0', ctx.src, node.pos);
  const out = [];
  const MAX = 100000;
  if (step > 0) {
    for (let v = a; v <= b + 1e-12; v += step) {
      if (out.length >= MAX) throw new CalcEvalError('区间元素超过 100000 个，请缩小范围', ctx.src, node.pos);
      out.push(clean0(v));
    }
  } else {
    for (let v = a; v >= b - 1e-12; v += step) {
      if (out.length >= MAX) throw new CalcEvalError('区间元素超过 100000 个，请缩小范围', ctx.src, node.pos);
      out.push(clean0(v));
    }
  }
  return out;
}

const clean0 = (v) => (Math.abs(v) < 1e-12 ? 0 : v);

function evaluateVar(node, ctx) {
  const name = node.name;
  // 1) 用户变量优先（允许覆盖常量，例如 x=1 之后 x）
  if (ctx.scope.has(name)) return ctx.scope.get(name);
  // 2) 常量
  const c = lookupConstant(name);
  if (c) return c.value;
  // 3) 提示：是不是把函数当变量用了
  const fn = lookupFunction(name);
  if (fn) {
    throw new CalcEvalError(
      `"${name}" 是函数，需要参数，例如 ${name}(x)；若想作为变量请先赋值 ${name}=...`,
      ctx.src, node.pos
    );
  }
  const hint = suggestName(name, ctx);
  throw new CalcEvalError(`未定义的变量 "${name}"${hint}`, ctx.src, node.pos);
}

/** 用编辑距离给拼错的变量名提示 */
function suggestName(name, ctx) {
  const candidates = [];
  for (const k of ctx.scope.toObject ? Object.keys(ctx.scope.toObject()) : []) candidates.push(k);
  for (const k of Object.keys(CONSTANTS)) candidates.push(k);
  for (const k of Object.keys(FUNCTIONS)) candidates.push(k);
  const lower = name.toLowerCase();
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(lower, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best && bestD <= Math.max(1, Math.floor(name.length / 3))) {
    return `（是不是想用 "${best}"?）`;
  }
  return '';
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* ======================== 二元运算 ======================== */

function evaluateBinary(node, ctx) {
  const op = node.op;

  // 逻辑短路：&& || 不预先求值右操作数
  if (op === '&&' || op === '||') {
    const l = truthy(evaluate(node.left, ctx));
    if (op === '&&') return l ? (truthy(evaluate(node.right, ctx)) ? 1 : 0) : 0;
    return l ? 1 : (truthy(evaluate(node.right, ctx)) ? 1 : 0);
  }

  const left = evaluate(node.left, ctx);
  const right = evaluate(node.right, ctx);

  switch (op) {
    case '+': return cx.simp(cx.add(left, right));
    case '-': return cx.simp(cx.sub(left, right));
    case '*': return cx.simp(cx.mul(left, right));
    case '/': {
      const d = cx.toC(right);
      if (d.re === 0 && d.im === 0) {
        throw new CalcEvalError('除以 0', ctx.src, node.pos);
      }
      return cx.simp(cx.div(left, right));
    }
    case '//': {
      const a = num(left, '整除'), b = num(right, '整除');
      if (b === 0) throw new CalcEvalError('整除的除数为 0', ctx.src, node.pos);
      return Math.floor(a / b);
    }
    case '%': {
      const a = num(left, '取模'), b = num(right, '取模');
      if (b === 0) throw new CalcEvalError('取模的除数为 0', ctx.src, node.pos);
      return ((a % b) + b) % b;
    }
    case '^': return cx.simp(cx.pow(left, right));
    case '<': return num(left, '比较') < num(right, '比较') ? 1 : 0;
    case '>': return num(left, '比较') > num(right, '比较') ? 1 : 0;
    case '<=': return num(left, '比较') <= num(right, '比较') ? 1 : 0;
    case '>=': return num(left, '比较') >= num(right, '比较') ? 1 : 0;
    case '==': return equalsLoose(left, right) ? 1 : 0;
    case '!=': return equalsLoose(left, right) ? 0 : 1;
    default:
      throw new CalcEvalError('未知运算符: ' + op, ctx.src, node.pos);
  }
}

function equalsLoose(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b), 1);
  }
  const A = cx.toC(a), B = cx.toC(b);
  return Math.abs(A.re - B.re) <= 1e-12 && Math.abs(A.im - B.im) <= 1e-12;
}

function truthy(v) {
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  const z = cx.toC(v);
  return z.re !== 0 || z.im !== 0;
}

function evaluateUnary(node, ctx) {
  const v = evaluate(node.arg, ctx);
  if (node.op === '-') return cx.simp(cx.neg(v));
  if (node.op === 'not') return truthy(v) ? 0 : 1;
  throw new CalcEvalError('未知一元运算符: ' + node.op, ctx.src, node.pos);
}

function evaluatePostfix(node, ctx) {
  const v = evaluate(node.arg, ctx);
  if (node.op === '!') {
    const fact = FUNCTIONS.fact;
    try {
      return fact.fn(num(v, '阶乘'), ctx);
    } catch (e) {
      throw wrapEvalError(e, '阶乘', ctx, node);
    }
  }
  if (node.op === 'percent') {
    // 百分号：除以 100
    return cx.simp(cx.div(v, 100));
  }
  throw new CalcEvalError('未知后缀运算符: ' + node.op, ctx.src, node.pos);
}

/** 后缀自增自减：`x++` 返回旧值并把变量 ±1 */
function evaluatePostfixAssign(node, ctx) {
  const name = node.name;
  if (!ctx.scope.has(name)) {
    throw new CalcEvalError(`"${name}" 尚未赋值，无法自增自减`, ctx.src, node.pos);
  }
  const old = num(ctx.scope.get(name), `${node.op} 的目标`);
  ctx.scope.set(name, clean0(old + (node.op === '++' ? 1 : -1)));
  return old;
}

/* ======================== 函数调用 ======================== */

function evaluateCall(node, ctx) {
  const found = lookupFunction(node.name);
  if (!found) {
    const hint = suggestName(node.name, ctx);
    throw new CalcEvalError(`未知函数 "${node.name}"${hint}（用 calc_help 查看全部函数）`, ctx.src, node.pos);
  }
  const { name, def } = found;
  const argc = node.args.length;
  if (argc < def.min || argc > def.max) {
    const expect = def.max === Infinity
      ? `至少 ${def.min} 个`
      : def.min === def.max ? `${def.min} 个` : `${def.min}-${def.max} 个`;
    throw new CalcEvalError(
      `${name} 需要 ${expect}参数，实际给了 ${argc} 个（${def.help}）`,
      ctx.src, node.pos
    );
  }

  const args = node.args.map(a => evaluate(a, ctx));

  // 传入求值上下文（角度制/精度）。定点参数函数用形参接收、忽略多余实参；
  // 不定参函数据 stripCtx 剔除，避免被当成数据。
  const callCtx = markCtx(ctx);
  try {
    return def.fn(...args, callCtx);
  } catch (e) {
    throw wrapEvalError(e, name, ctx, node);
  }
}

function wrapEvalError(e, fnName, ctx, node) {
  if (e instanceof CalcEvalError) return e;
  return new CalcEvalError(`${fnName}: ${e.message}`, ctx.src, node.pos);
}

/* ======================== 赋值 ======================== */

function evaluateAssign(node, ctx) {
  const value = evaluate(node.value, ctx);
  ctx.scope.set(node.name, value);
  if (!ctx.assigned.includes(node.name)) ctx.assigned.push(node.name);
  return value;
}

module.exports = {
  evaluate, evaluateProgram, Context, Scope, CalcEvalError,
  normalizeAngleMode, truthy, clean0
};
