'use strict';
/**
 * calc_equation：方程与方程组求解
 *
 * 三种输入：
 *   1. equation + variable="x"        —— 单个方程，自动判型（线性/二次/多项式/超越）
 *   2. equations=[..], variables=[..] —— 线性方程组（消元法）
 *   3. coeffs=[a,b,c,...]             —— 直接给多项式系数（从高次到低次）
 *
 * 解析思路：
 *   - 先把方程两边拆成 f(x) = left - right
 *   - 用"符号系数扫描"对多项式求系数：对每个幂次 k，构造 k 阶差商或直接用
 *     采样插值。这里用更稳的做法：对多项式用 n+1 个采样点做牛顿插值/线性解，
 *     对超越方程用数值求根（二分 + 牛顿）。
 */
const { parse } = require('../utils/parser');
const { evaluate, Context, CalcEvalError } = require('../utils/evaluator');
const { formatValue } = require('../utils/format');
const { fmt } = require('../utils/format');

const MAX_ITER = 200;
const TOL = 1e-13;

/* ======================== 求值辅助 ======================== */

/**
 * 构造"以 x 为自由变量"的求值器：返回 f(x) -> number
 * 这里复用了引擎：把变量绑到 scope 里，每次改值再求值。
 */
function makeFunction(node, varName, opts) {
  const ctx = new Context(Object.assign({}, opts, { src: null }));
  return function f(x) {
    ctx.scope.set(varName, x);
    const v = evaluate(node, ctx);
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && 'im' in v) {
      if (Math.abs(v.im) < 1e-14) return v.re;
      throw new Error('方程在该点取到复数值（本工具只求实数解）');
    }
    throw new Error('方程求值结果不是数值: ' + v);
  };
}

/** 把 "lhs = rhs" 或单个表达式解析成 f(x) = lhs - rhs */
function buildResidual(equation, varName, opts) {
  const eq = String(equation);
  const parts = splitEquation(eq);
  const leftNode = parse(parts.left).body[0];
  let node;
  if (parts.right === null) {
    node = leftNode;
  } else {
    const rightNode = parse(parts.right).body[0];
    node = { type: 'binary', op: '-', left: leftNode, right: rightNode };
  }
  return makeFunction(node, varName, opts);
}

/** 在顶层（不在括号内）找到第一个 '='，且排除 == <= >= != */
function splitEquation(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '=' && depth === 0) {
      const prev = s[i - 1], next = s[i + 1];
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
      if (next === '=') continue;
      return { left: s.slice(0, i), right: s.slice(i + 1) };
    }
  }
  return { left: s, right: null };
}

/* ======================== 多项式：采样定次 + 解 ======================== */

/**
 * 推断多项式次数：用差分法。等距采样 f 在 n+1 个点，若 n 阶差分约为 0 则可降次。
 * 返回 { degree, coeffs:[最高次幂项系数 ... 常数项] } 或 null（非多项式）
 */
function fitPolynomial(f, varName) {
  // 从低次往高次试：先用 3 点判 2 次，不行再加点
  for (let deg = 1; deg <= 8; deg++) {
    const n = deg + 1;                       // 需要 n 个点确定 n-1 次多项式？不，deg 次需要 deg+1 点
    const pts = n + 1;                       // 多取一个点验证
    const xs = [];
    for (let i = 0; i < pts; i++) xs.push(i - Math.floor(pts / 2));
    let ys;
    try {
      ys = xs.map(x => f(x));
    } catch (e) { return null; }
    if (ys.some(y => !isFinite(y))) return null;

    const coeffs = solveVandermonde(xs.slice(0, deg + 1), ys.slice(0, deg + 1));
    if (!coeffs) return null;

    // 用剩余点验证（deg+1 之后的点）
    let ok = true;
    for (let i = deg + 1; i < pts; i++) {
      const pred = polyEval(coeffs, xs[i]);
      const scale = Math.max(1, Math.abs(ys[i]));
      if (Math.abs(pred - ys[i]) > 1e-8 * scale) { ok = false; break; }
    }
    if (!ok) continue;

    // 去掉最高次的 0 系数
    let c = coeffs.slice();
    while (c.length > 1 && Math.abs(c[0]) < 1e-12) c.shift();
    // 确认它确实是 deg 次（不是更低次被误判）
    if (c.length !== deg + 1) continue;
    return { degree: c.length - 1, coeffs: c };
  }
  return null;
}

/** 解范德蒙德方程组（高斯消元），xs 是节点，ys 是对应值，返回按降幂排列的系数 */
function solveVandermonde(xs, ys) {
  const n = xs.length;
  // 增广矩阵：每行 [x^n ... x^1 x^0 | y]
  const M = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let k = n - 1; k >= 0; k--) row.push(Math.pow(xs[i], k));
    row.push(ys[i]);
    M.push(row);
  }
  for (let col = 0; col < n; col++) {
    // 选主元
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
    // 消元
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push(M[i][n] / M[i][i]);
  return out;
}

function polyEval(coeffs, x) {
  let v = 0;
  for (const c of coeffs) v = v * x + c;
  return v;
}

/** 用伴随矩阵 / Durand-Kerner 求多项式全部复根，再筛实数根 */
function polyRoots(coeffs) {
  let c = coeffs.slice();
  while (c.length > 1 && Math.abs(c[0]) < 1e-14) c.shift();
  const n = c.length - 1;
  if (n <= 0) return [];
  // 归一化（首项为 1）
  const a = c.map(v => v / c[0]);

  if (n === 1) return [{ re: -a[1], im: 0 }];
  if (n === 2) {
    const [_, b, cc] = a;
    const disc = b * b - 4 * cc;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      return [{ re: (-b + s) / 2, im: 0 }, { re: (-b - s) / 2, im: 0 }];
    }
    const s = Math.sqrt(-disc);
    return [{ re: -b / 2, im: s / 2 }, { re: -b / 2, im: -s / 2 }];
  }

  // Durand-Kerner：n 个复根同时迭代
  const roots = [];
  for (let i = 0; i < n; i++) {
    const ang = 2 * Math.PI * i / n + 0.4;
    const r = 0.4 + Math.pow(1.5, i % 5);
    roots.push({ re: r * Math.cos(ang), im: r * Math.sin(ang) });
  }
  for (let iter = 0; iter < 2000; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      // p(zi) / prod_{j!=i}(zi - zj)
      const pv = polyEvalC(a, roots[i]);
      let denom = { re: 1, im: 0 };
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const d = { re: roots[i].re - roots[j].re, im: roots[i].im - roots[j].im };
        denom = cmul(denom, d);
      }
      if (Math.abs(denom.re) < 1e-300 && Math.abs(denom.im) < 1e-300) continue;
      const q = cdiv(pv, denom);
      roots[i] = { re: roots[i].re - q.re, im: roots[i].im - q.im };
      maxDelta = Math.max(maxDelta, Math.abs(q.re), Math.abs(q.im));
    }
    if (maxDelta < 1e-16) break;
  }
  return roots;
}

function polyEvalC(a, z) {
  let re = 0, im = 0;
  for (const c of a) {
    const nr = re * z.re - im * z.im + c;
    const ni = re * z.im + im * z.re;
    re = nr; im = ni;
  }
  return { re, im };
}
function cmul(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }
function cdiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

/* ======================== 数值求根（超越方程） ======================== */

/**
 * 先扫描区间找符号变化，再二分 + 牛顿精化。
 * 返回去重后的实数根数组。
 */
function numericRoots(f, lo, hi, steps = 2000) {
  const xs = [];
  const step = (hi - lo) / steps;
  let prevX = lo, prevY;
  try { prevY = f(lo); } catch (e) { prevY = NaN; }

  for (let i = 1; i <= steps; i++) {
    const x = lo + i * step;
    let y;
    try { y = f(x); } catch (e) { prevX = x; prevY = NaN; continue; }
    if (isFinite(prevY) && isFinite(y)) {
      if (y === 0) { xs.push(x); }
      else if (prevY === 0) { xs.push(prevX); }
      else if (prevY * y < 0) {
        const r = refine(f, prevX, x);
        if (r != null) xs.push(r);
      }
    }
    prevX = x; prevY = y;
  }

  // 去重（合并相邻近根）
  xs.sort((a, b) => a - b);
  const out = [];
  for (const r of xs) {
    if (!out.length || Math.abs(r - out[out.length - 1]) > 1e-7 * Math.max(1, Math.abs(r))) out.push(r);
  }
  return out;
}

/** 二分 + 牛顿混合精化 */
function refine(f, a, b) {
  let fa = safeF(f, a), fb = safeF(f, b);
  if (fa == null || fb == null) return null;
  let lo = a, hi = b;
  for (let i = 0; i < MAX_ITER; i++) {
    const mid = (lo + hi) / 2;
    const fm = safeF(f, mid);
    if (fm == null) break;
    if (fm === 0 || (hi - lo) / 2 < TOL) {
      // 牛顿再打一枪
      const nr = newton(f, mid);
      return clean(nr != null ? nr : mid);
    }
    if (fa * fm < 0) { hi = mid; fb = fm; }
    else { lo = mid; fa = fm; }
  }
  return clean((lo + hi) / 2);
}

function safeF(f, x) {
  try {
    const v = f(x);
    return isFinite(v) ? v : null;
  } catch (e) { return null; }
}

function newton(f, x0) {
  let x = x0;
  for (let i = 0; i < 60; i++) {
    const fx = safeF(f, x);
    if (fx == null) return null;
    if (Math.abs(fx) < 1e-15) return x;
    const h = Math.max(1e-8, Math.abs(x) * 1e-8);
    const f1 = safeF(f, x + h), f2 = safeF(f, x - h);
    if (f1 == null || f2 == null) return null;
    const d = (f1 - f2) / (2 * h);
    if (!isFinite(d) || Math.abs(d) < 1e-300) return null;
    const step = fx / d;
    const nx = x - step;
    if (!isFinite(nx)) return null;
    if (Math.abs(nx - x) < 1e-15) return nx;
    x = nx;
  }
  return x;
}

/** 把接近整数的浮点噪声清掉 */
function clean(v) {
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-10 * Math.max(1, Math.abs(v))) return r;
  return v;
}

/* ======================== 线性方程组 ======================== */

function solveLinearSystem(eqs, vars) {
  const n = vars.length;
  if (eqs.length !== n) {
    return { error: `方程个数 (${eqs.length}) 与未知数个数 (${vars.length}) 必须相同（当前只支持方阵）` };
  }
  // 每条方程线性化：f(x_vec) 对每个变量是线性的 → 采样求系数
  const A = [], b = [];
  for (const eqStr of eqs) {
    const { left, right } = splitEquation(String(eqStr));
    const ln = parse(left).body[0];
    const rn = right === null ? { type: 'num', value: 0 } : parse(right).body[0];
    const node = { type: 'binary', op: '-', left: ln, right: rn };

    const ctx = new Context({ src: null });
    const evalAt = (vec) => {
      vars.forEach((v, i) => ctx.scope.set(v, vec[i]));
      const val = evaluate(node, ctx);
      if (typeof val !== 'number') {
        if (val && 'im' in val && Math.abs(val.im) < 1e-14) return val.re;
        throw new Error('线性方程组里出现了复数或非数值');
      }
      return val;
    };

    const zero = new Array(n).fill(0);
    const b0 = evalAt(zero);
    const row = [];
    for (let i = 0; i < n; i++) {
      const e = new Array(n).fill(0);
      e[i] = 1;
      row.push(evalAt(e) - b0);
    }
    A.push(row);
    b.push(-b0);
  }
  const sol = gaussSolve(A, b);
  if (!sol) return { error: '方程组无唯一解（系数矩阵奇异：可能无解或有无穷多解）' };
  return { solution: sol.map(clean) };
}

/** 高斯消元（带部分主元），返回解数组或 null */
function gaussSolve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/* ======================== 主逻辑 ======================== */

function run(args = {}) {
  const out = [];
  out.push('## calc_equation');
  out.push('');

  const opts = { angleMode: args.angleMode || 'rad', precision: args.precision || 12 };

  /* --- 模式 2：线性方程组 --- */
  if (Array.isArray(args.equations)) {
    const eqs = args.equations.map(String);
    const vars = Array.isArray(args.variables) ? args.variables.map(String) : [];
    if (!vars.length) {
      return '求解方程组时必须提供 variables（未知数名列表），例如\n'
        + '  calc_equation(equations=["2x+3y=8", "x-y=-1"], variables=["x","y"])';
    }
    out.push('**方程组:**');
    eqs.forEach(e => out.push('- ' + e));
    out.push('');
    const r = solveLinearSystem(eqs, vars);
    if (r.error) { out.push('**无法求解**: ' + r.error); return out.join('\n'); }
    out.push('**解:**');
    r.solution.forEach((v, i) => {
      out.push(`- ${vars[i]} = **${formatValue(v, opts).text}**`);
    });
    return out.join('\n');
  }

  /* --- 模式 3：直接给多项式系数 --- */
  if (Array.isArray(args.coeffs)) {
    const coeffs = args.coeffs.map(Number);
    if (coeffs.some(v => !isFinite(v))) return 'coeffs 必须全是数字';
    if (coeffs.length < 2) return 'coeffs 至少需要两项（次数 ≥ 1）';
    out.push(`**多项式系数（降幂）:** [${coeffs.join(', ')}]`);
    out.push('');
    return renderPolynomialRoots(out, coeffs, opts, args.variable || 'x');
  }

  /* --- 模式 1：单方程 --- */
  const equation = args.equation != null ? String(args.equation)
    : (args.eqs != null ? String(args.eqs) : null);
  if (!equation) {
    return '用法:\n'
      + '  calc_equation(equation="2x+3=7")                        单方程（自动判型）\n'
      + '  calc_equation(equation="x^2-5x+6=0")                    二次/高次\n'
      + '  calc_equation(equation="cos(x)=0.5", range=[-10,10])    超越方程（数值求根）\n'
      + '  calc_equation(equations=["2x+3y=8","x-y=-1"], variables=["x","y"])  方程组\n'
      + '  calc_equation(coeffs=[1,-5,6])                          直接给系数\n';
  }

  const varName = String(args.variable || detectVariable(equation) || 'x');
  out.push(`**方程:** ${equation}`);
  out.push(`**未知数:** ${varName}`);
  out.push('');

  let f;
  try {
    f = buildResidual(equation, varName, opts);
  } catch (e) {
    out.push('**解析/求值失败**: ' + (e.message || e));
    return out.join('\n');
  }

  // 先当多项式试
  const poly = fitPolynomial(f, varName);
  if (poly && poly.degree >= 1) {
    out.push(`**类型:** ${poly.degree} 次多项式（系数降幂: [${poly.coeffs.map(v => round12(v)).join(', ')}]）`);
    out.push('');
    const real = realRoots(poly.coeffs);
    if (!real.length) {
      out.push('**实数解: 无**');
    } else {
      out.push(`**实数解（${real.length} 个）:**`);
      real.forEach((r, i) => out.push(`${i + 1}. ${varName} = **${formatValue(r, opts).text}**${formatValue(r, opts).extra ? `  _(${formatValue(r, opts).extra})_` : ''}`));
    }
    // 复根也给出（若有）
    const all = polyRoots(poly.coeffs).filter(z => Math.abs(z.im) > 1e-9);
    if (all.length) {
      out.push('');
      out.push('**复数解:**');
      all.forEach((z, i) => {
        const zz = { re: round12(z.re), im: round12(z.im) };
        out.push(`${i + 1}. ${varName} = **${formatValue(zz, opts).text}**`);
      });
    }
    return out.join('\n');
  }

  // 数值求根
  const range = Array.isArray(args.range) && args.range.length === 2
    ? [Number(args.range[0]), Number(args.range[1])]
    : [-50, 50];
  out.push(`**类型:** 非线性方程（数值求根，区间 [${range[0]}, ${range[1]}]）`);
  out.push('');

  const roots = numericRoots(f, range[0], range[1]);
  if (!roots.length) {
    out.push('**区间内未找到实数解。**');
    out.push('');
    out.push('可以尝试：');
    out.push('- 扩大搜索范围：`range=[-1000,1000]`');
    out.push('- 确认方程有实根（如 `x^2+1=0` 只有复根）');
  } else {
    out.push(`**找到 ${roots.length} 个实数解:**`);
    roots.forEach((r, i) => {
      const rv = formatValue(clean(r), opts);
      out.push(`${i + 1}. ${varName} ≈ **${rv.text}**${rv.extra ? `  _(${rv.extra})_` : ''}`);
    });
    out.push('');
    out.push('> 数值解可能因区间而漏根；如需完整复根请提供 coeffs。');
  }
  return out.join('\n');
}

function renderPolynomialRoots(out, coeffs, opts, varName) {
  const all = polyRoots(coeffs);
  const real = all.filter(z => Math.abs(z.im) < 1e-9).map(z => clean(z.re)).sort((a, b) => a - b);
  const complex = all.filter(z => Math.abs(z.im) >= 1e-9);
  if (!real.length && !complex.length) {
    out.push('该多项式没有根（常数非零）');
    return out.join('\n');
  }
  if (real.length) {
    out.push(`**实数解（${real.length} 个）:**`);
    real.forEach((r, i) => {
      const rv = formatValue(r, opts);
      out.push(`${i + 1}. ${varName} = **${rv.text}**${rv.extra ? `  _(${rv.extra})_` : ''}`);
    });
  } else {
    out.push('**实数解: 无**');
  }
  if (complex.length) {
    out.push('');
    out.push(`**复数解（${complex.length} 个）:**`);
    complex.forEach((z, i) => {
      const zz = { re: round12(z.re), im: round12(z.im) };
      out.push(`${i + 1}. ${varName} = **${formatValue(zz, opts).text}**`);
    });
  }
  return out.join('\n');
}

function realRoots(coeffs) {
  return polyRoots(coeffs)
    .filter(z => Math.abs(z.im) < 1e-8)
    .map(z => clean(z.re))
    .sort((a, b) => a - b)
    .filter((v, i, arr) => !i || Math.abs(v - arr[i - 1]) > 1e-9 * Math.max(1, Math.abs(v)));
}

function round12(v) {
  if (!isFinite(v)) return v;
  const r = Number(v.toPrecision(12));
  return r === 0 ? 0 : r;
}

/** 从方程里猜未知数：出现过且不是函数名/常量的单字母标识符 */
function detectVariable(equation) {
  const { FUNCTIONS } = require('../utils/functions');
  const { CONSTANTS } = require('../utils/constants');
  const names = String(equation).match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  const seen = new Set();
  for (const n of names) {
    const lower = n.toLowerCase();
    if (FUNCTIONS[lower] || Object.prototype.hasOwnProperty.call(FUNCTIONS, n)) continue;
    if (Object.keys(CONSTANTS).some(k => k.toLowerCase() === lower)) continue;
    // 跳过紧跟 '(' 的函数调用名
    const idx = equation.indexOf(n);
    if (idx >= 0 && equation[idx + n.length] === '(') continue;
    seen.add(n);
  }
  const arr = [...seen];
  if (arr.includes('x')) return 'x';
  if (arr.length === 1) return arr[0];
  return arr.length ? arr[0] : null;
}

module.exports = { run, polyRoots, numericRoots, splitEquation };
