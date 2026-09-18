'use strict';
/**
 * 内置函数库（零依赖）
 *
 * 每个函数签名：(...args) => number | {re, im}
 * 复数安全：数值函数统一通过 cx 适配层，自动决定走实数快路径还是复数路径。
 * 角度制：需要角度制时由 evaluator 注入 ctx.angleMode，三角/反三角据此换算。
 *
 * 覆盖范围：
 *   三角 sin cos tan sec csc cot / 反三角 asin acos atan atan2
 *   双曲 sinh cosh tanh / 反双曲 asinh acosh atanh
 *   指数对数 exp ln log log2 log10 /
 *   幂与根 sqrt cbrt root  /  取整 floor ceil round trunc frac sign
 *   组合与数论 fact gamma nCr nPr gcd lcm isprime nextprime mod pow
 *   统计 sum avg mean median mode stdev variance min max count product
 *   其他 abs hypot radians degrees clamp lerp fib
 */
const cx = require('./complex');
const C = cx.C;

/* ======================== 求值上下文的传递 ========================
 * 求值器会在实参末尾追加一个 ctx（提供 angleMode 等），但：
 *   - 定点参数函数（sin/floor/...）用形参接收，多余的 ctx 被忽略，无害
 *   - 不定参函数（sum/avg/...）会把 ctx 误当成一个数据参数
 * 所以给 ctx 打一个标记，不定参函数据此剔除。
 */
const CTX_MARK = '__isCalcCtx';

/** 把求值上下文包成可识别对象 */
function markCtx(ctx) {
  return Object.assign(Object.create(null), { [CTX_MARK]: true, angleMode: ctx.angleMode, precision: ctx.precision });
}

/** 从参数列表里剔除上下文对象 */
function stripCtx(args) {
  return args.filter(a => !(a && a[CTX_MARK]));
}

/* ======================== 角度制适配 ======================== */

const toRad = (x, mode) => (mode === 'deg' ? x * Math.PI / 180 : mode === 'grad' ? x * Math.PI / 200 : x);
const fromRad = (x, mode) => (mode === 'deg' ? x * 180 / Math.PI : mode === 'grad' ? x * 200 / Math.PI : x);

/* ======================== 参数规整（复数感知） ======================== */

/** 把参数转成复数对象 */
const asC = (v) => (typeof v === 'number' ? C(v, 0) : cx.toC(v));
/** 复数结果在虚部为 0 时退化回实数，减少后续运算的对象开销 */
const simp = cx.simp;

/** 复数感知的一元函数包装：实入实出时走原生 Math，保证精度与速度。
 *  若实数结果无定义（NaN，如 ln(-1)、asin(2)），自动升级到复数分支。 */
function realOrComplex(realFn, complexFn) {
  return (v) => {
    if (typeof v === 'number') {
      const r = realFn(v);
      if (!Number.isNaN(r) || Number.isNaN(v)) return cx.clean(r);
      return simp(complexFn(C(v, 0)));     // 实数域无定义 → 复数域求主值
    }
    const z = cx.toC(v);
    if (z.im === 0) {
      const r = realFn(z.re);
      if (!Number.isNaN(r)) return cx.clean(r);
      return simp(complexFn(z));
    }
    return simp(complexFn(z));
  };
}

/* ======================== 三角（角度制感知） ======================== */

function sinFn(v, ctx) {
  const m = ctx.angleMode;
  if (typeof v === 'number') return cx.clean(Math.sin(toRad(v, m)));
  const z = cx.toC(v);
  const r = cx.complexSin(m === 'deg' || m === 'grad' ? C(toRad(z.re, m), toRad(z.im, m)) : z);
  return simp(m === 'deg' || m === 'grad' ? r : r);
}
function cosFn(v, ctx) {
  const m = ctx.angleMode;
  if (typeof v === 'number') return cx.clean(Math.cos(toRad(v, m)));
  const z = cx.toC(v);
  return simp(cx.complexCos(m === 'rad' ? z : C(toRad(z.re, m), toRad(z.im, m))));
}
function tanFn(v, ctx) {
  const m = ctx.angleMode;
  if (typeof v === 'number') return cx.clean(Math.tan(toRad(v, m)));
  const z = cx.toC(v);
  return simp(cx.complexTan(m === 'rad' ? z : C(toRad(z.re, m), toRad(z.im, m))));
}
/** 余切/正割/余割：按倒数实现，并显式检查奇点 */
const cotFn = (v, ctx) => reciprocal(tanFn(v, ctx), 'cot');
const secFn = (v, ctx) => reciprocal(cosFn(v, ctx), 'sec');
const cscFn = (v, ctx) => reciprocal(sinFn(v, ctx), 'csc');

function reciprocal(v, name) {
  const z = asC(v);
  if (z.re === 0 && z.im === 0) throw new Error(name + ' 在 0 处无定义（分母为 0）');
  return simp(cx.div(1, z));
}

/* ======================== 反三角（角度制输出） ======================== */

function asinFn(v, ctx) {
  const m = ctx.angleMode;
  const r = realOrComplex(Math.asin, cx.complexAsin)(v);
  return typeof r === 'number' ? cx.clean(fromRad(r, m)) : r;
}
function acosFn(v, ctx) {
  const m = ctx.angleMode;
  const r = realOrComplex(Math.acos, cx.complexAcos)(v);
  return typeof r === 'number' ? cx.clean(fromRad(r, m)) : r;
}
function atanFn(v, ctx) {
  const m = ctx.angleMode;
  const r = realOrComplex(Math.atan, cx.complexAtan)(v);
  return typeof r === 'number' ? cx.clean(fromRad(r, m)) : r;
}
/** atan2(y, x)：两参数，四象限 */
function atan2Fn(y, x, ctx) {
  const m = ctx.angleMode;
  return cx.clean(fromRad(Math.atan2(num(y, 'atan2'), num(x, 'atan2')), m));
}

/* ======================== 双曲与反双曲 ======================== */

const sinhFn = realOrComplex(Math.sinh, cx.complexSinh);
const coshFn = realOrComplex(Math.cosh, cx.complexCosh);
const tanhFn = realOrComplex(Math.tanh, cx.complexTanh);
const asinhFn = realOrComplex(Math.asinh, (z) => cx.complexLog(cx.add(z, cx.complexSqrt(cx.add(cx.mul(z, z), 1)))));
const acoshFn = realOrComplex(Math.acosh, (z) => cx.complexLog(cx.add(z, cx.complexSqrt(cx.sub(cx.mul(z, z), 1)))));
const atanhFn = realOrComplex(Math.atanh, (z) => cx.mul(0.5, cx.complexLog(cx.div(cx.add(1, z), cx.sub(1, z)))));

/* ======================== 指数与对数 ======================== */

const lnFn = realOrComplex(Math.log, cx.complexLog);
function logFn(a, b, ctx) {
  // 求值器会把 ctx 追加在末尾，因此对"可选参数"必须先剔除 ctx 再判断
  // （否则 log(100) 里的 b 会是 ctx 对象而不是 undefined）
  const extra = stripCtx([b]);
  if (!extra.length) return log10Fn(a);
  return logBase(a, extra[0]);
}
function logBase(a, baseArg) {
  const base = num(baseArg, 'log');
  if (base <= 0 || base === 1) throw new Error('log 的底数必须为正数且不等于 1');
  const lv = lnFn(a);
  if (typeof lv !== 'number') throw new Error('log 的底数形式不支持复数参数');
  return cx.clean(lv / Math.log(base));
}
function log2Fn(v) {
  const r = lnFn(v);
  if (typeof r !== 'number') throw new Error('log2 不支持复数参数');
  return cx.clean(r / Math.LN2);
}
function log10Fn(v) {
  const r = lnFn(v);
  if (typeof r !== 'number') throw new Error('log10 不支持复数参数');
  return cx.clean(r / Math.LN10);
}
const expFn = realOrComplex(Math.exp, cx.complexExp);

/* ======================== 幂与根 ======================== */

const sqrtFn = (v) => simp(cx.complexSqrt(v));
/** cbrt：负数给实根（-8 → -2），与 Math.cbrt 一致 */
const cbrtFn = (v) => {
  if (typeof v === 'number') return cx.clean(Math.cbrt(v));
  const z = cx.toC(v);
  if (z.im === 0) return cx.clean(Math.cbrt(z.re));
  return simp(cx.pow(z, C(1 / 3, 0)));
};
/** root(x, n)：n 次根，n 为奇数且 x 为负实数时给实根 */
function rootFn(x, n) {
  const nn = num(n, 'root');
  if (!Number.isInteger(nn) || nn === 0) throw new Error('root 的根指数必须是非零整数');
  const v = asC(x);
  if (v.im === 0 && v.re < 0 && Math.abs(nn) % 2 === 1) {
    const mag = Math.pow(Math.abs(v.re), 1 / nn);
    return cx.clean(nn > 0 ? -mag : -mag);
  }
  return simp(cx.pow(v, C(1 / nn, 0)));
}
function powFn(a, b) { return simp(cx.pow(a, b)); }

/* ======================== 取整与符号 ======================== */

const floorFn = (v, d) => {
  const x = num(v, 'floor');
  const digits = d === undefined ? 0 : num(d, 'floor');
  const f = Math.pow(10, digits);
  return Math.floor(x * f) / f;
};
const ceilFn = (v, d) => {
  const x = num(v, 'ceil');
  const digits = d === undefined ? 0 : num(d, 'ceil');
  const f = Math.pow(10, digits);
  return Math.ceil(x * f) / f;
};
function roundFn(v, d) {
  const x = num(v, 'round');
  const digits = d === undefined ? 0 : num(d, 'round');
  const f = Math.pow(10, digits);
  // 处理 .5 远离零方向取整（计算器惯例），并修正二进制表示误差
  const scaled = x * f;
  const r = Math.sign(scaled) * Math.round(Math.abs(scaled) + (Math.abs(scaled % 1) === 0.5 ? 1e-9 : 0));
  return r / f;
}
const truncFn = (v) => Math.trunc(num(v, 'trunc'));
const fracFn = (v) => {
  const x = num(v, 'frac');
  return x - Math.trunc(x);
};
const signFn = (v) => {
  if (typeof v === 'number') return Math.sign(v);
  const z = cx.toC(v);
  if (z.re === 0 && z.im === 0) return 0;
  return simp(cx.div(z, cx.abs(z)));
};

/* ======================== 组合与数论 ======================== */

/** 阶乘：支持非负整数；非整数用 Gamma 函数插值 */
function factFn(v) {
  const x = num(v, 'fact');
  if (x < 0 && Number.isInteger(x)) throw new Error('负数没有阶乘定义: ' + x);
  if (Number.isInteger(x) && x <= 170) {
    let r = 1;
    for (let i = 2; i <= x; i++) r *= i;
    return r;
  }
  if (x > 170) return Infinity;
  return gammaFn(x + 1);
}

/** Lanczos 近似的 Gamma 函数 */
const G_LN = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7
];
function gammaFn(v) {
  const z = num(v, 'gamma');
  if (Number.isInteger(z) && z > 0) return factFn(z - 1);
  if (z < 0.5) {
    // 反射公式：Γ(z)Γ(1-z) = π / sin(πz)
    return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  }
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < G_LN.length; i++) x += G_LN[i] / (zz + i + 1);
  const t = zz + G_LN.length - 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, zz + 0.5) * Math.exp(-t) * x;
}
function lgammFn(v) { return Math.log(Math.abs(gammaFn(v))); }

/** 组合数 nCr：大数用乘法累乘避免阶乘溢出 */
function ncrFn(n, r) {
  const N = num(n, 'nCr'), R = num(r, 'nCr');
  if (!Number.isInteger(N) || !Number.isInteger(R)) throw new Error('nCr 的两个参数都必须是整数');
  if (R < 0 || N < 0) throw new Error('nCr 的参数不能为负');
  if (R > N) return 0;
  const k = Math.min(R, N - R);
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = result * (N - k + i) / i;
  }
  return Math.round(result);
}
function nprFn(n, r) {
  const N = num(n, 'nPr'), R = num(r, 'nPr');
  if (!Number.isInteger(N) || !Number.isInteger(R)) throw new Error('nPr 的两个参数都必须是整数');
  if (R < 0 || N < 0) throw new Error('nPr 的参数不能为负');
  if (R > N) return 0;
  let result = 1;
  for (let i = 0; i < R; i++) result *= (N - i);
  return Math.round(result);
}
function gcdFn(a, b) {
  let x = Math.abs(Math.round(num(a, 'gcd'))), y = Math.abs(Math.round(num(b, 'gcd')));
  while (y) { const t = x % y; x = y; y = t; }
  return x;
}
function lcmFn(a, b) {
  const x = Math.abs(Math.round(num(a, 'lcm'))), y = Math.abs(Math.round(num(b, 'lcm')));
  if (x === 0 || y === 0) return 0;
  return Math.abs(x / gcdFn(x, y) * y);
}
/** Miller-Rabin 确定性实现（< 2^64 用固定基） */
function isPrimeFn(v) {
  const n = Math.round(num(v, 'isprime'));
  if (n < 2) return 0;
  if (n < 4) return 1;
  if (n % 2 === 0) return 0;
  for (const p of [3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]) {
    if (n === p) return 1;
    if (n % p === 0) return 0;
  }
  // 确定性基组（对 n < 3.3e24 有效）
  let d = n - 1, s = 0;
  while (d % 2 === 0) { d /= 2; s++; }
  const bases = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];
  for (const a of bases) {
    if (a >= n) continue;
    let x = modpow(a, d, n);
    if (x === 1 || x === n - 1) continue;
    let ok = false;
    for (let i = 0; i < s - 1; i++) {
      x = (x * x) % n;
      if (x === n - 1) { ok = true; break; }
    }
    if (!ok) return 0;
  }
  return 1;
}
function nextPrimeFn(v) {
  let n = Math.round(num(v, 'nextprime'));
  if (n < 2) return 2;
  n = n % 2 === 0 ? n + 1 : n + 2;
  while (!isPrimeFn(n)) n += 2;
  return n;
}
/** 模幂：底数、指数、模 */
function modpow(base, exp, mod) {
  let result = 1n;
  let b = BigInt(base) % BigInt(mod);
  let e = BigInt(exp);
  const m = BigInt(mod);
  if (m === 0n) throw new Error('mod 不能为 0');
  if (b < 0n) b = (b % m + m) % m;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return Number(result);
}
function modFn(a, b) {
  const x = num(a, 'mod'), y = num(b, 'mod');
  if (y === 0) throw new Error('取模的除数不能为 0');
  return ((x % y) + y) % y;   // 结果始终非负（数学惯例）
}

/* ======================== 统计聚合（接受数组或多个参数） ======================== */

/** 把参数规整成数字数组：接受 sum(1,2,3) 或 sum([1,2,3]) */
function flatten(args) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    out.push(v);
  };
  args.forEach(walk);
  return out;
}
/** 数字数组；ctx 是求值器追加的上下文，必须剔除，否则会被当成数据 */
const nums = (args, name) => {
  const data = stripCtx(args);
  return flatten(data).map((v, i) => num(v, name + ' 的第 ' + (i + 1) + ' 个参数'));
};

function sumFn(...args) { return nums(args, 'sum').reduce((a, b) => a + b, 0); }
function productFn(...args) { return nums(args, 'product').reduce((a, b) => a * b, 1); }
function avgFn(...args) {
  const a = nums(args, 'avg');
  if (!a.length) throw new Error('avg 至少需要一个参数');
  return a.reduce((x, y) => x + y, 0) / a.length;
}
function minFn(...args) {
  const a = nums(args, 'min');
  if (!a.length) throw new Error('min 至少需要一个参数');
  return Math.min(...a);
}
function maxFn(...args) {
  const a = nums(args, 'max');
  if (!a.length) throw new Error('max 至少需要一个参数');
  return Math.max(...a);
}
function medianFn(...args) {
  const a = nums(args, 'median').slice().sort((x, y) => x - y);
  if (!a.length) throw new Error('median 至少需要一个参数');
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function modeFn(...args) {
  const a = nums(args, 'mode');
  if (!a.length) throw new Error('mode 至少需要一个参数');
  const freq = new Map();
  a.forEach(v => freq.set(v, (freq.get(v) || 0) + 1));
  let best = a[0], bestN = 0;
  for (const [v, n] of freq) if (n > bestN) { bestN = n; best = v; }
  return best;
}
function varianceFn(...args) {
  const a = nums(args, 'variance');
  if (a.length < 2) throw new Error('variance 至少需要两个参数');
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1);
}
const stdevFn = (...args) => Math.sqrt(varianceFn(...args));
/** 总体标准差（除以 n） */
function pstdevFn(...args) {
  const a = nums(args, 'pstdev');
  if (!a.length) throw new Error('pstdev 至少需要一个参数');
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
}
function countFn(...args) { return flatten(stripCtx(args)).length; }

/* ======================== 杂项 ======================== */

const absFn = (v) => cx.abs(v);
const hypotFn = (...args) => Math.hypot(...nums(args, 'hypot'));

/* 复数分量与极坐标 */
const conjFn = (v) => cx.simp(cx.conj(v));
const argFn = (v) => cx.arg(v);
const reFn = (v) => cx.toC(v).re;
const imFn = (v) => cx.toC(v).im;
function polarFn(v, ctx) {
  const p = cx.toPolar(v);
  // 返回数组 [模, 辐角]，辐角按当前角度制换算
  return [cx.clean(p.r), cx.clean(fromRad(p.theta, ctx.angleMode))];
}

/**
 * 角度 ↔ 弧度换算。
 * `deg(90)` 的语义是"这个 90 是角度" —— 因此它把参数换算成三角函数期望的弧度值。
 * 在 rad 模式下需要 deg→rad；在 deg 模式下三角函数本身就吃角度，故原样返回。
 * 这样 sin(deg(90))=1 在任何模式下都成立。
 */
function radiansFn(v, ctx) {
  const n = num(v, 'radians');
  return cx.clean(ctx.angleMode === 'rad' ? toRad(n, 'deg') : n);
}
function degreesFn(v, ctx) {
  const n = num(v, 'degrees');
  return cx.clean(ctx.angleMode === 'rad' ? fromRad(n, 'deg') : fromRad(toRad(n, 'deg'), 'deg'));
}
function clampFn(v, lo, hi) {
  return Math.min(Math.max(num(v, 'clamp'), num(lo, 'clamp')), num(hi, 'clamp'));
}
function lerpFn(a, b, t) {
  const A = num(a, 'lerp'), B = num(b, 'lerp'), T = num(t, 'lerp');
  return A + (B - A) * T;
}
function fibFn(v) {
  const n = Math.round(num(v, 'fib'));
  if (n < 0) throw new Error('fib 的参数不能为负');
  let a = 0, b = 1;
  for (let i = 0; i < n; i++) { const t = a + b; a = b; b = t; }
  return a;
}
/** 整数除法与取余 */
function idivFn(a, b) {
  const x = num(a, 'idiv'), y = num(b, 'idiv');
  if (y === 0) throw new Error('除数为 0');
  return Math.trunc(x / y);
}

/** 参数必须是实数（复数会给出清晰报错，而不是静默 NaN） */
function num(v, name) {
  if (typeof v === 'number') return v;
  const z = cx.toC(v);
  if (z.im === 0) return z.re;
  throw new Error((name || '该函数') + ' 只接受实数参数，收到复数 ' + fmtC(z));
}
function fmtC(z) {
  const r = cx.clean(z.re), i = cx.clean(z.im);
  return `${r}${i >= 0 ? '+' : '-'}${Math.abs(i)}i`;
}

/* ======================== 注册表 ======================== */

/**
 * 函数表：name → { fn, min, max, help, aliases }
 * min/max 为参数个数约束（max = Infinity 表示不定参）
 */
const FUNCTIONS = {
  /* 三角 */
  sin: { fn: sinFn, min: 1, max: 1, help: '正弦' },
  cos: { fn: cosFn, min: 1, max: 1, help: '余弦' },
  tan: { fn: tanFn, min: 1, max: 1, help: '正切' },
  cot: { fn: cotFn, min: 1, max: 1, help: '余切 = 1/tan' },
  sec: { fn: secFn, min: 1, max: 1, help: '正割 = 1/cos' },
  csc: { fn: cscFn, min: 1, max: 1, help: '余割 = 1/sin' },
  /* 反三角 */
  asin: { fn: asinFn, min: 1, max: 1, help: '反正弦（支持 |x|>1 → 复数）' },
  acos: { fn: acosFn, min: 1, max: 1, help: '反余弦（支持 |x|>1 → 复数）' },
  atan: { fn: atanFn, min: 1, max: 1, help: '反正切' },
  atan2: { fn: atan2Fn, min: 2, max: 2, help: 'atan2(y, x)：四象限反正切' },
  arcsin: { fn: asinFn, min: 1, max: 1, help: '反正弦（asin 的别名）' },
  arccos: { fn: acosFn, min: 1, max: 1, help: '反余弦（acos 的别名）' },
  arctan: { fn: atanFn, min: 1, max: 1, help: '反正切（atan 的别名）' },
  /* 双曲 */
  sinh: { fn: sinhFn, min: 1, max: 1, help: '双曲正弦' },
  cosh: { fn: coshFn, min: 1, max: 1, help: '双曲余弦' },
  tanh: { fn: tanhFn, min: 1, max: 1, help: '双曲正切' },
  asinh: { fn: asinhFn, min: 1, max: 1, help: '反双曲正弦' },
  acosh: { fn: acoshFn, min: 1, max: 1, help: '反双曲余弦' },
  atanh: { fn: atanhFn, min: 1, max: 1, help: '反双曲正切' },
  /* 指数对数 */
  exp: { fn: expFn, min: 1, max: 1, help: 'e 的幂' },
  ln: { fn: lnFn, min: 1, max: 1, help: '自然对数（负数 → 复数）' },
  log: { fn: logFn, min: 1, max: 2, help: 'log(x) 以 10 为底；log(x, base) 指定底' },
  log2: { fn: log2Fn, min: 1, max: 1, help: '以 2 为底的对数' },
  log10: { fn: log10Fn, min: 1, max: 1, help: '以 10 为底的对数' },
  /* 幂与根 */
  sqrt: { fn: sqrtFn, min: 1, max: 1, help: '平方根（负数 → 复数）' },
  cbrt: { fn: cbrtFn, min: 1, max: 1, help: '立方根（负数给实根）' },
  root: { fn: rootFn, min: 2, max: 2, help: 'root(x, n)：x 的 n 次根' },
  pow: { fn: powFn, min: 2, max: 2, help: 'pow(a, b) = a^b' },
  /* 取整 */
  floor: { fn: floorFn, min: 1, max: 2, help: 'floor(x[, 小数位]) 向下取整' },
  ceil: { fn: ceilFn, min: 1, max: 2, help: 'ceil(x[, 小数位]) 向上取整' },
  round: { fn: roundFn, min: 1, max: 2, help: 'round(x[, 小数位]) 四舍五入' },
  trunc: { fn: truncFn, min: 1, max: 1, help: '截断小数部分' },
  frac: { fn: fracFn, min: 1, max: 1, help: '小数部分' },
  sign: { fn: signFn, min: 1, max: 1, help: '符号（-1/0/1；复数返回单位向量）' },
  /* 组合与数论 */
  fact: { fn: factFn, min: 1, max: 1, help: '阶乘（非整数用 Gamma 插值）' },
  gamma: { fn: gammaFn, min: 1, max: 1, help: 'Gamma 函数' },
  lgamma: { fn: lgammFn, min: 1, max: 1, help: 'ln|Γ(x)|' },
  nCr: { fn: ncrFn, min: 2, max: 2, help: '组合数 C(n, r)' },
  nPr: { fn: nprFn, min: 2, max: 2, help: '排列数 P(n, r)' },
  gcd: { fn: gcdFn, min: 2, max: 2, help: '最大公约数' },
  lcm: { fn: lcmFn, min: 2, max: 2, help: '最小公倍数' },
  isprime: { fn: isPrimeFn, min: 1, max: 1, help: '是否质数（1/0）' },
  nextprime: { fn: nextPrimeFn, min: 1, max: 1, help: '大于等于 x 的下一个质数' },
  mod: { fn: modFn, min: 2, max: 2, help: '取模（结果非负）' },
  idiv: { fn: idivFn, min: 2, max: 2, help: '整数除法（截断）' },
  /* 统计 */
  sum: { fn: sumFn, min: 1, max: Infinity, help: '求和：sum(1,2,3) 或 sum([1,2,3])' },
  product: { fn: productFn, min: 1, max: Infinity, help: '连乘' },
  avg: { fn: avgFn, min: 1, max: Infinity, help: '算术平均' },
  mean: { fn: avgFn, min: 1, max: Infinity, help: '算术平均（avg 别名）' },
  min: { fn: minFn, min: 1, max: Infinity, help: '最小值' },
  max: { fn: maxFn, min: 1, max: Infinity, help: '最大值' },
  median: { fn: medianFn, min: 1, max: Infinity, help: '中位数' },
  mode: { fn: modeFn, min: 1, max: Infinity, help: '众数' },
  variance: { fn: varianceFn, min: 2, max: Infinity, help: '样本方差（除以 n-1）' },
  stdev: { fn: stdevFn, min: 2, max: Infinity, help: '样本标准差' },
  pstdev: { fn: pstdevFn, min: 1, max: Infinity, help: '总体标准差（除以 n）' },
  count: { fn: countFn, min: 1, max: Infinity, help: '参数个数' },
  /* 杂项 */
  abs: { fn: absFn, min: 1, max: 1, help: '绝对值/模' },
  hypot: { fn: hypotFn, min: 1, max: Infinity, help: '欧几里得范数' },
  /* 复数分量与极坐标 */
  conj: { fn: conjFn, min: 1, max: 1, help: '共轭复数' },
  conjugate: { fn: conjFn, min: 1, max: 1, help: '共轭复数（别名）' },
  arg: { fn: argFn, min: 1, max: 1, help: '辐角（按当前角度制）' },
  re: { fn: reFn, min: 1, max: 1, help: '实部' },
  real: { fn: reFn, min: 1, max: 1, help: '实部（别名）' },
  im: { fn: imFn, min: 1, max: 1, help: '虚部系数' },
  imag: { fn: imFn, min: 1, max: 1, help: '虚部系数（别名）' },
  polar: { fn: polarFn, min: 1, max: 1, help: '极坐标 [模, 辐角]' },
  radians: { fn: radiansFn, min: 1, max: 1, help: '角度 → 弧度（与 angleMode 无关）' },
  degrees: { fn: degreesFn, min: 1, max: 1, help: '弧度 → 角度（与 angleMode 无关）' },
  deg: { fn: radiansFn, min: 1, max: 1, help: '把角度当弧度用：sin(deg(90))=1，不受 angleMode 影响' },
  todeg: { fn: radiansFn, min: 1, max: 1, help: 'deg 的别名（角度 → 弧度）' },
  clamp: { fn: clampFn, min: 3, max: 3, help: 'clamp(x, lo, hi) 限制在区间内' },
  lerp: { fn: lerpFn, min: 3, max: 3, help: 'lerp(a, b, t) 线性插值' },
  fib: { fn: fibFn, min: 1, max: 1, help: '斐波那契第 n 项' }
};

/* 别名（大小写不敏感查找） */
const ALIASES = {
  asin: 'asin', arcsin: 'asin',
  acos: 'acos', arccos: 'acos',
  atan: 'atan', arctan: 'atan',
  lg: 'log10', log10: 'log10',
  ln: 'ln',
  sqr: 'sqrt', sgn: 'sign',
  ncr: 'nCr', npr: 'nPr', c: 'nCr', p: 'nPr',
  average: 'avg', std: 'stdev', stddev: 'stdev'
};

/** 大小写不敏感的函数查找 */
function lookupFunction(name) {
  if (FUNCTIONS[name]) return { name, def: FUNCTIONS[name] };
  const lower = name.toLowerCase();
  if (ALIASES[lower] && FUNCTIONS[ALIASES[lower]]) {
    return { name: ALIASES[lower], def: FUNCTIONS[ALIASES[lower]] };
  }
  // 逐个做大小写不敏感匹配（处理 nCr / nCr 这类驼峰名）
  for (const key of Object.keys(FUNCTIONS)) {
    if (key.toLowerCase() === lower) return { name: key, def: FUNCTIONS[key] };
  }
  return null;
}

module.exports = { FUNCTIONS, lookupFunction, toRad, fromRad, num, flatten, markCtx, stripCtx };
