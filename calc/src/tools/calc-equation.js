'use strict';
/**
 * calc_equation：方程与方程组求解
 *
 * 四种输入：
 *   1. equation + variable="x"        —— 单个方程，自动判型（线性/二次/多项式/超越）
 *   2. equations=[..], variables=[..] —— 联立方程组，自动分派：
 *        · 恰好线性方阵 → 直接高斯消元（精确，不迭代）
 *        · 其余（非线性 / 非方阵）→ 阻尼最小二乘（Levenberg-Marquardt）+ 多起点
 *          求解，并枚举给定搜索框内的多个解
 *   3. coeffs=[a,b,c,...]             —— 直接给多项式系数（从高次到低次）
 *   4. equations（1 条）+ variables（多）→ 自动当"欠定参数解"给出，多余变量作自由参数
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

/* ======================== 线性方程组（精确，不作迭代） ======================== */

/**
 * 把每条方程线性化成一行 A·x = b。
 * 原理：f(x_vec) 对每个变量若是线性的，则 f(e_i) - f(0) 就是第 i 个系数。
 * 返回 { A, b } 或 { error }
 */
function linearize(eqs, vars) {
  const n = vars.length;
  const A = [], b = [];
  for (const eqStr of eqs) {
    const { node } = buildResidualNode(eqStr);
    const ctx = new Context({ src: null });
    const evalAt = (vec) => {
      vars.forEach((v, i) => ctx.scope.set(v, vec[i]));
      const val = evaluate(node, ctx);
      if (typeof val !== 'number') {
        if (val && 'im' in val && Math.abs(val.im) < 1e-14) return val.re;
        throw new Error('算式中出现复数或非数值');
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
  return { A, b };
}

/** 验证线性假设：f(u+v) 是否等于 f(u)+f(v)-f(0)（线性性），在若干随机点上抽查 */
function verifyLinear(A, b, fns) {
  for (let trial = 0; trial < 4; trial++) {
    const u = [], v = [];
    for (let i = 0; i < fns.length; i++) {
      u.push((Math.sin(trial * 7 + i * 3.1) + 0.3) * 1.7);
      v.push((Math.cos(trial * 5 + i * 2.3) - 0.2) * 2.3);
    }
    for (let r = 0; r < fns.length; r++) {
      const fu = safeVec(fns[r], u), fv = safeVec(fns[r], v);
      const s = new Array(fns.length).fill(0);
      for (let i = 0; i < fns.length; i++) s[i] = u[i] + v[i];
      const fs = safeVec(fns[r], s);
      if (fu == null || fv == null || fs == null) return false;
      // 线性要求 f(u+v) - f(u) - f(v) + f(0) ≈ 0，f(0) = -b[r]
      const lhs = fs - fu - fv + (-b[r]);
      const scale = Math.max(1, Math.abs(fs), Math.abs(fu), Math.abs(fv));
      if (Math.abs(lhs) > 1e-7 * scale) return false;
    }
  }
  return true;
}

function safeVec(f, vec) {
  try {
    const v = f(vec);
    return isFinite(v) ? v : null;
  } catch (e) { return null; }
}

/** 用 A·x = b 反推 x 代入 f 校验残差（线性情形下应恒为 0） */
function residualsAt(fns, vec) {
  const out = [];
  for (const f of fns) {
    const v = safeVec(f, vec);
    out.push(v == null ? Infinity : v);
  }
  return out;
}

/* ======================== 非线性方程组：阻尼最小二乘 ======================== */

/**
 * 高斯-牛顿 / Levenberg-Marquardt：最小化 F(x) = ‖f(x)‖₂
 * 支持 m ≠ n（超定：最小二乘解；欠定：加阻尼后给最小范数解）。
 *
 * 收敛判据：
 *   - cost ≤ tol                      → ok，精确解
 *   - 步长 / 增益相对饱和             → 局部极小（ok 由 softTol 决定）
 *   - 残差函数在邻域内不可求值（NaN） → 该起点不可用
 *
 * @returns {null | {x, cost, ok, iterations, method, stalls}}
 */
function levenbergMarquardt(fns, x0, opts = {}) {
  const m = fns.length;
  const n = x0.length;
  const maxIter = opts.maxIter || 300;
  const tol = opts.tol != null ? opts.tol : 1e-14;
  const softTol = opts.softTol != null ? opts.softTol : 1e-8;

  let x = x0.slice();
  let F = costAt(fns, x);
  if (F == null) return null;                       // 起点就求不了值
  let bestX = x.slice(), bestF = F;

  if (F < tol) return { x, cost: F, ok: true, iterations: 0, method: 'LM(阻尼最小二乘)', stalls: 0 };

  let lam = 1e-3;
  let stalls = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    // ---- 1) 残差 + 数值雅可比 J (m×n) ----
    const r = new Array(m);
    for (let i = 0; i < m; i++) r[i] = safeVec(fns[i], x) ?? NaN;
    if (r.some(v => !isFinite(v))) break;           // 当前位置不可求值 → 放弃

    const J = [];
    let degenerate = 0;                             // 雅可比整行为 0 的方程个数
    for (let i = 0; i < m; i++) {
      const row = [];
      for (let j = 0; j < n; j++) {
        const h = Math.max(1e-8, Math.abs(x[j]) * 1e-8);
        const xp = x.slice(); xp[j] += h;
        const xm = x.slice(); xm[j] -= h;
        const fp = safeVec(fns[i], xp);
        const fm = safeVec(fns[i], xm);
        row.push((fp == null || fm == null) ? 0 : (fp - fm) / (2 * h));
      }
      if (row.every(v => Math.abs(v) < 1e-14)) degenerate++;
      J.push(row);
    }

    // ---- 2) 正规方程 (JᵀJ + λ·diag) d = -Jᵀr ----
    const JtJ = zeros(n, n), Jtr = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      for (let a = 0; a < n; a++) {
        Jtr[a] -= J[i][a] * r[i];
        for (let b = 0; b < n; b++) JtJ[a][b] += J[i][a] * J[i][b];
      }
    }

    // ---- 3) 试不同 λ ----
    let accepted = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const diagScale = Math.max(1e-12, Math.abs(JtJ[0][0]));
      const M = JtJ.map((row, a) => row.map((v, b) => (a === b ? v + lam * Math.max(diagScale, Math.abs(JtJ[a][a]) || diagScale) : v)));
      const d = solveSymmetric(M, Jtr.slice());
      if (!d) { lam = Math.min(lam * 10, 1e14); continue; }
      if (d.every(v => Math.abs(v) < 1e-300)) { lam = Math.min(lam * 10, 1e14); continue; }

      const xNew = x.map((v, i) => v + d[i]);
      if (xNew.some(v => !isFinite(v) || Math.abs(v) > 1e12)) { lam = Math.min(lam * 10, 1e14); continue; }
      const FNew = costAt(fns, xNew);
      if (FNew != null && FNew < F) {
        const relGain = (F - FNew) / Math.max(F, 1e-300);
        x = xNew; F = FNew;
        if (F < bestF) { bestF = F; bestX = x.slice(); }
        lam = Math.max(lam * 0.25, 1e-15);
        accepted = true;
        if (F < tol) return { x, cost: F, ok: true, iterations: iter + 1, method: 'LM(阻尼最小二乘)', stalls: 0 };
        // 步长与相对增益都饱和 → 局部极小
        const stepNorm = Math.max(...d.map(Math.abs));
        const xScale = Math.max(1, ...x.map(Math.abs));
        if (relGain < 1e-14 && stepNorm < 1e-11 * xScale) stalls++;
        else stalls = 0;
        break;
      }
      lam = Math.min(lam * 10, 1e14);
    }

    if (!accepted) {
      // λ 顶到上限仍无下降 → 局部极小
      return finish(bestX, bestF, iter + 1, softTol, degenerate === m);
    }
    if (stalls >= 3) {
      return finish(x, F, iter + 1, softTol, degenerate === m);
    }
  }
  return finish(bestX, bestF, maxIter, softTol, false);
}

function finish(x, cost, iterations, softTol, allDegenerate) {
  return {
    x,
    cost,
    ok: cost < softTol,
    iterations,
    method: 'LM(阻尼最小二乘)',
    stalled: true,
    allDegenerate: !!allDegenerate
  };
}

function costAt(fns, x) {
  let s = 0;
  for (const f of fns) {
    const v = safeVec(f, x);
    if (v == null) return null;
    s += v * v;
  }
  return Math.sqrt(s);
}

function zeros(r, c) {
  const out = [];
  for (let i = 0; i < r; i++) out.push(new Array(c).fill(0));
  return out;
}

/** 解对称正定线性方程组（带主元的高斯消元，失败返回 null） */
function solveSymmetric(M, rhs) {
  const n = M.length;
  const A = M.map((row, i) => row.concat([rhs[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-300) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = A[i][n];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x.every(isFinite) ? x : null;
}

/**
 * 多起点求解：在搜索框内撒点，从每个起点做 LM，再对解去重。
 * @param fns  残差函数数组（每个接受向量返回数值）
 * @param box  每个变量的 [lo, hi]（形如 [[-10,10],[-10,10]]）
 * @param opts { guesses, maxSolutions, softTol, tol, allowApprox }
 * @returns {{ solutions, all, best, bestCost, count, approxFallback }}
 */
function solveNonlinearSystem(fns, box, opts = {}) {
  const n = box.length;
  const maxStart = opts.maxStart || 2400;

  // ---- 起点集合：用户 guesses + 网格 + 中心/原点 ----
  const starts = [];
  for (const g of (opts.guesses || [])) {
    if (Array.isArray(g) && g.length === n) starts.push(g.slice());
  }

  const perAxis = Math.max(3, Math.min(11, Math.round(Math.pow(maxStart, 1 / Math.max(1, n)))));
  const axis = [];
  for (let i = 0; i < n; i++) {
    const [lo, hi] = box[i];
    const arr = [];
    for (let k = 0; k < perAxis; k++) arr.push(lo + (hi - lo) * (k / (perAxis - 1)));
    axis.push(arr);
  }
  const total = Math.pow(perAxis, n);
  if (total <= maxStart) {
    const rec = (idx, acc) => {
      if (idx === n) { starts.push(acc.slice()); return; }
      for (const v of axis[idx]) { acc.push(v); rec(idx + 1, acc); acc.pop(); }
    };
    rec(0, []);
  } else {
    for (let i = 0; i < maxStart; i++) {
      const p = [];
      for (let j = 0; j < n; j++) {
        const [lo, hi] = box[j];
        p.push(lo + (hi - lo) * pseudoRandom(i * n + j + 1));
      }
      starts.push(p);
    }
  }

  const softTol = opts.softTol != null ? opts.softTol : 1e-8;
  const tol = opts.tol != null ? opts.tol : 1e-14;
  // 去重阈值：LM 通常能收敛到 ~1e-12，用 1e-5 合并"数值上其实是同一个点"的解，
  // 避免圆/双曲线这类系统在切线附近被拆成一批近似重复的解。
  const dedupeTol = opts.dedupeTol || 1e-5;
  const maxSolutions = opts.maxSolutions || 50;

  const found = [];
  const approxPool = [];   // 未达 softTol 的局部极小（用于超定最小二乘回报）
  let allDegenerate = true;
  let bestAny = null;

  for (const s of starts) {
    if (found.length >= maxSolutions) break;
    const r = levenbergMarquardt(fns, s, { tol, softTol });
    if (!r) continue;
    if (r.allDegenerate === false) allDegenerate = false;
    if (bestAny == null || r.cost < bestAny.cost) bestAny = r;

    // 必须落在用户给的搜索框内 —— 否则 [−2,2] 这种窄框会被框外的解"穿透"
    if (!withinBox(r.x, box)) continue;

    if (!r.ok) {
      if (approxPool.length < 400) approxPool.push({ x: r.x, cost: r.cost });
      continue;
    }

    // 去重 + 累计"命中次数"（越稳固的解被越多起点收敛到）
    let dup = false;
    for (const f of found) {
      let close = true;
      for (let i = 0; i < n; i++) {
        if (Math.abs(f.x[i] - r.x[i]) > dedupeTol * Math.max(1, Math.abs(f.x[i]), Math.abs(r.x[i]))) { close = false; break; }
      }
      if (close) {
        if (r.cost < f.cost) { f.x = r.x; f.cost = r.cost; }
        f.hits++;
        dup = true;
        break;
      }
    }
    if (!dup) found.push({ x: r.x, cost: r.cost, hits: 1, method: r.method });
  }

  found.sort((a, b) => (a.cost - b.cost) || (b.hits - a.hits));

  // ---- 兜底：网格颗粒度不够时按轴扫描找残差低谷再精化 ----
  const needFallback = !found.length;
  if (needFallback && !allDegenerate) {
    const center = box.map(([lo, hi]) => (lo + hi) / 2);
    for (let i = 0; i < n; i++) {
      const [lo, hi] = box[i];
      const steps = Math.min(8000, Math.max(200, Math.round(8000 / n)));
      const step = (hi - lo) / steps;
      let bx = null, bv = Infinity;
      for (let k = 0; k <= steps; k++) {
        const p = center.slice();
        p[i] = lo + k * step;
        const v = costAt(fns, p);
        if (v != null && v < bv) { bv = v; bx = p; }
      }
      if (bx) {
        const r = levenbergMarquardt(fns, bx, { tol, softTol });
        if (r && r.ok && withinBox(r.x, box)) {
          let dup = false;
          for (const f of found) {
            let close = true;
            for (let j = 0; j < n; j++) {
              if (Math.abs(f.x[j] - r.x[j]) > dedupeTol * Math.max(1, Math.abs(f.x[j]), Math.abs(r.x[j]))) { close = false; break; }
            }
            if (close) { dup = true; break; }
          }
          if (!dup) found.push({ x: r.x, cost: r.cost, hits: 1, method: r.method });
        }
      }
    }
    found.sort((a, b) => (a.cost - b.cost) || (b.hits - a.hits));
  }

  let best = found.length ? found[0] : bestAny;
  const bestCost = best ? best.cost : Infinity;

  // 保留 cost 足够小、或与最优解同量级的解
  const keep = found.filter(f => f.cost <= softTol || f.cost <= bestCost * 1e-6 + 1e-15);

  // ---- 无精确解但允许近似（超定最小二乘）时，回报最优局部极小 ----
  let approxFallback = null;
  if (!keep.length) {
    const pool = approxPool.concat(bestAny && !approxPool.some(p => p === bestAny) && bestAny.ok === false ? [bestAny] : []);
    if (!pool.length && bestAny) pool.push({ x: bestAny.x, cost: bestAny.cost });
    pool.sort((a, b) => a.cost - b.cost);
    if (bestAny && bestAny.x) {
      approxFallback = { x: bestAny.x, cost: bestAny.cost };
    }
  }

  return {
    solutions: keep.map(k => k.x),
    all: keep,
    best: best ? best.x : null,
    bestCost,
    count: keep.length,
    approxFallback,
    allDegenerate
  };
}

/** 向量是否落在搜索框内（容差仅吸收浮点噪声，不做放宽） */
function withinBox(x, box) {
  for (let i = 0; i < box.length; i++) {
    const [lo, hi] = box[i];
    const pad = 1e-6 * Math.max(1, Math.abs(lo), Math.abs(hi), hi - lo);
    if (!(x[i] >= lo - pad && x[i] <= hi + pad)) return false;
  }
  return true;
}

/** 确定性伪随机（同一输入永远同一结果，避免答案抖动） */
function pseudoRandom(i) {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/* ======================== 方程组求值的公共部分 ======================== */

/** 把 "lhs = rhs" 解析成残差 AST 节点 */
function buildResidualNode(equation) {
  const parts = splitEquation(String(equation));
  const left = parse(parts.left).body[0];
  if (parts.right === null) return { node: left };
  const right = parse(parts.right).body[0];
  return { node: { type: 'binary', op: '-', left, right } };
}

/** 为一组方程 + 变量名建立数值残差函数数组（向量入参 → 数值） */
function makeSystemFunctions(eqs, vars) {
  const nodes = eqs.map(eqStr => buildResidualNode(eqStr).node);
  const ctx = new Context({ src: null });
  const fns = nodes.map(node => function f(vec) {
    vars.forEach((v, i) => ctx.scope.set(v, vec[i]));
    const val = evaluate(node, ctx);
    if (typeof val === 'number') return val;
    if (val && 'im' in val) {
      if (Math.abs(val.im) < 1e-14) return val.re;
      return NaN;
    }
    return NaN;
  });
  return fns;
}

/** 单个方程：给多变量时，其余变量当自由参数。返回求解结果 */
function solveSingleEquationMultiVar(equation, vars, args) {
  // 默认把所有自由变量取 0；同时给出一份"以某变量为自变量"的表达式形态
  const fns = makeSystemFunctions([equation], vars);
  const zero = new Array(vars.length).fill(0);
  const points = [];
  const probes = [-3, -1, -0.5, 0, 0.5, 1, 3];
  for (const p of probes) {
    const x0 = zero.slice(); x0[0] = p;
    const r = levenbergMarquardt(fns, x0, { tol: 1e-14 });
    if (r && r.ok) points.push(r.x);
  }
  return { fns, points };
}

/* ======================== 主逻辑 ======================== */

function run(args = {}) {
  const out = [];
  out.push('## calc_equation');
  out.push('');

  const opts = { angleMode: args.angleMode || 'rad', precision: args.precision || 12 };

  /* --- 模式 2：方程组（自动分派：线性 / 非线性 / 非方阵） --- */
  if (Array.isArray(args.equations)) {
    const eqs = args.equations.map(String);
    const vars = Array.isArray(args.variables) ? args.variables.map(String) : [];
    if (!vars.length) {
      return '求解方程组时必须提供 variables（未知数名列表），例如\n'
        + '  calc_equation(equations=["2x+3y=8", "x-y=-1"], variables=["x","y"])\n'
        + '  calc_equation(equations=["x^2+y^2=25", "x-y=1"], variables=["x","y"])';
    }
    if (!eqs.length) return 'equations 不能为空';
    return renderSystem(out, eqs, vars, args, opts);
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
      + '  calc_equation(equations=["2x+3y=8","x-y=-1"], variables=["x","y"])          线性方程组\n'
      + '  calc_equation(equations=["x^2+y^2=25","x-y=1"], variables=["x","y"])        非线性方程组（多解）\n'
      + '  calc_equation(equations=["x+y+z=6","x-y=0"], variables=["x","y","z"])       非方阵（最小二乘）\n'
      + '  calc_equation(coeffs=[1,-5,6])                          直接给系数\n'
      + '\n'
      + '方程组可选参数:\n'
      + '  searchRange=[lo,hi]  多解搜索范围（默认 [-10,10]），非线性方程组枚举解时用\n'
      + '  guesses=[[1,1],[2,-2]]  自定义初值，用于找特定分支的解\n'
      + '  maxSolutions=n       最多返回多少个解（默认 50）\n';
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

/* ======================== 方程组渲染 ======================== */

/**
 * 方程组主渲染：先判线性方阵（精确消元），否则走非线性多解求解。
 */
function renderSystem(out, eqs, vars, args, opts) {
  const m = eqs.length, n = vars.length;

  out.push('**方程组:**');
  eqs.forEach(e => out.push('- ' + e));
  out.push(`**未知数:** ${vars.join(', ')}  （${m} 个方程 / ${n} 个未知数）`);
  out.push('');

  let fns;
  try {
    fns = makeSystemFunctions(eqs, vars);
  } catch (e) {
    out.push('**解析失败**: ' + (e.message || e));
    return out.join('\n');
  }

  // ---------- 1) 先试"线性 + 方阵"：精确、无迭代 ----------
  if (m === n) {
    let lin = null;
    try {
      lin = linearize(eqs, vars);
    } catch (e) {
      out.push('> 线性化试探失败（' + (e.message || e) + '），改用数值法。');
      out.push('');
    }
    if (lin && verifyLinear(lin.A, lin.b, fns)) {
      const rank = matrixRank(lin.A);
      if (rank === n) {
        const sol = gaussSolve(lin.A, lin.b);
        if (sol) {
          out.push('**类型:** 线性方程组（高斯消元，精确解）');
          out.push('');
          out.push('**解（唯一）:**');
          vars.forEach((v, i) => {
            const fv = formatValue(clean(sol[i]), opts);
            out.push(`- ${v} = **${fv.text}**${fv.extra ? `  _(${fv.extra})_` : ''}`);
          });
          appendVerification(out, fns, vars, [sol], opts);
          return out.join('\n');
        }
      } else if (rank === matrixRank(lin.A.map((row, i) => row.concat([lin.b[i]])))) {
        out.push('**类型:** 线性方程组（**欠定**：方程线性相关，有无穷多解）');
        out.push('');
        out.push(`秩 = ${rank} < ${n}，只给出一个特解（自由变量取 0）：`);
        const sol = gaussSolveLeast(lin.A, lin.b);
        if (sol) {
          vars.forEach((v, i) => {
            const fv = formatValue(clean(sol[i]), opts);
            out.push(`- ${v} = **${fv.text}**${fv.extra ? `  _(${fv.extra})_` : ''}`);
          });
          appendVerification(out, fns, vars, [sol], opts);
        }
        out.push('');
        out.push(`> 完整解集是 ${n - rank} 维的：把 ${n - rank} 个变量当自由参数 t₁…，用参数式表达。`);
        return out.join('\n');
      } else {
        out.push('**类型:** 线性方程组（**矛盾**：无解）');
        out.push('');
        out.push('系数矩阵的秩 < 增广矩阵的秩，方程互相冲突。');
        out.push('下面给出**最小二乘近似解**（使 ‖Ax-b‖ 最小）：');
        out.push('');
      }
    }
  }

  // ---------- 2) 非线性 / 非方阵：多起点最小二乘 ----------
  let boxInfo;
  try {
    boxInfo = normalizeSystemBox(args, n);
  } catch (e) {
    out.push('**参数错误**: ' + (e.message || e));
    return out.join('\n');
  }
  const box = boxInfo.box;
  const guesses = normalizeGuesses(args.guesses, n);
  const maxSolutions = Number.isFinite(Number(args.maxSolutions)) && Number(args.maxSolutions) > 0
    ? Math.min(200, Math.floor(Number(args.maxSolutions))) : 50;

  const sol = solveNonlinearSystem(fns, box, {
    maxSolutions,
    guesses,
    softTol: 1e-8,
    tol: 1e-14
  });

  const kind = m === n ? '非线性方程组' : (m > n ? '超定方程组' : '欠定方程组');
  const rangeText = box.every(b => b[0] === box[0][0] && b[1] === box[0][1])
    ? `[${box[0][0]}, ${box[0][1]}]ᵏ`
    : box.map(b => `[${b[0]},${b[1]}]`).join('×');
  out.push(`**类型:** ${kind}（阻尼最小二乘 + 多起点，搜索范围 ${rangeText}）`);
  out.push('');

  // 所有方程的雅可比都为零 → 方程里没有未知数（纯常量断言）
  if (sol.allDegenerate && !sol.count) {
    out.push('**无法求解**: 方程里似乎没有出现任何未知数（或它们全部被消掉了）。');
    out.push('请检查 variables 是否写错 —— 变量名必须和方程里出现的名字完全一致。');
    return out.join('\n');
  }

  if (!sol.count) {
    // 超定 → 报最小二乘解；亦覆盖"残差停在某个极小值"的一般情形
    if (sol.approxFallback && isFinite(sol.approxFallback.cost)) {
      const x = sol.approxFallback.x;
      const cost = sol.approxFallback.cost;
      const isLS = m !== n;
      out.push(`**无精确解**，给出**${isLS ? '最小二乘' : '残差最小'}近似解**（最大残差 ${fmtResidual(cost)}）：`);
      out.push('');
      out.push('- ' + vars.map((v, i) => `${v} ≈ **${formatValue(clean(x[i]), opts).text}**`).join('，'));
      out.push('');
      out.push('| ' + vars.join(' | ') + ' | 各方程残差 |');
      out.push('|' + '---|'.repeat(n + 1));
      out.push('| ' + x.map(v => formatValue(clean(v), opts).text).join(' | ')
        + ' | ' + residualsAt(fns, x).map(r => fmtResidual(r)).join(', ') + ' |');
      out.push('');
      if (isLS) {
        out.push(`> 方程数 (${m}) ≠ 未知数 (${n})，一般无法让所有方程同时为 0；上解使残差平方和最小。`);
      } else {
        out.push('> 迭代停在残差的最小值处（可能无实解、也可能是数值解在搜索范围内没被找到）。');
        out.push('> 可尝试扩大 `searchRange` 或用 `guesses` 指定更接近解的初值。');
      }
      return out.join('\n');
    }
    out.push(`**未找到解**（在 ${rangeText} 范围内）。`);
    out.push('');
    out.push('可以尝试：');
    out.push('- 扩大搜索范围：`searchRange=[-50,50]`');
    out.push('- 给出初值提示：`guesses=[[1,1],[3,-2]]`');
    if (m < n) out.push('- 方程数少于未知数数，解集是连续的一整片（欠定），请补充方程');
    out.push('- 确认方程确实有实解（如 `x^2+y^2=-1` 无实解）');
    return out.join('\n');
  }

  const exact = sol.all.filter(s => s.cost <= 1e-8);
  const approx = sol.all.filter(s => s.cost > 1e-8);

  if (exact.length) {
    out.push(`**解（${exact.length} 组${exact.length > 1 ? '，多解已枚举' : ''}）:**`);
    out.push('');
    exact.forEach((s, i) => {
      out.push(`**解 ${i + 1}**  ` + vars.map((v, k) => `${v} = **${formatValue(clean(s.x[k]), opts).text}**`).join('，'));
    });
    out.push('');
    out.push('| # | ' + vars.join(' | ') + ' | 最大残差 |');
    out.push('|' + '---|'.repeat(n + 2));
    exact.forEach((s, i) => {
      const rs = residualsAt(fns, s.x);
      out.push(`| ${i + 1} | ` + s.x.map(x => formatValue(clean(x), opts).text).join(' | ')
        + ` | ${fmtResidual(Math.max(...rs.map(Math.abs)))} |`);
    });
  }

  if (approx.length) {
    out.push('');
    out.push(`**近似解（残差未达 1e-8，共 ${approx.length} 组，仅供参考）:**`);
    approx.forEach((s, i) => {
      const rs = residualsAt(fns, s.x);
      out.push(`- ` + vars.map((v, k) => `${v} ≈ ${formatValue(clean(s.x[k]), opts).text}`).join('，')
        + `  （最大残差 ${fmtResidual(Math.max(...rs.map(Math.abs)))})`);
    });
  }

  if (m > n) {
    out.push('');
    out.push(`> 方程数 (${m}) > 未知数 (${n})：这是**最小二乘解**，一般无法让所有方程同时成立。`);
  } else if (m < n) {
    out.push('');
    out.push(`> 方程数 (${m}) < 未知数 (${n})：解集是 ${n - m} 维的，上面只是最小范数解；`
      + `把某些变量当自由参数可写成参数式。`);
  }

  out.push('');
  out.push('> 数值解由多起点迭代得到：可能有遗漏的解（尤其重根 / 切点），'
    + '也可能因起点密度不够而漏掉孤立解；放大 `searchRange` 或用 `guesses` 指定初值可改善。');

  return out.join('\n');
}

/**
 * 单方程 + 多变量：把其余变量当自由参数给出参数解。
 */
function renderSingleMultiVar(out, equation, vars, args, opts) {
  out.push(`**方程:** ${equation}`);
  out.push(`**变量:** ${vars.join(', ')}  （1 个方程 / ${vars.length} 个未知数 —— 欠定）`);
  out.push('');

  // 找出哪些变量是"活跃"的（真正出现在方程里的）
  const active = vars.filter(v => {
    const re = new RegExp('(?<![A-Za-z0-9_])' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])');
    return re.test(equation);
  });
  if (!active.length) {
    out.push('⚠ 方程里没有出现任何给定变量，请检查变量名。');
    return out.join('\n');
  }

  // 对每个活跃变量，把其他活跃变量固定为 0，解出"该变量关于其余变量的表达式"
  // 这里用数值法采样给出若干满足方程的点，并提示参数化写法
  const fns = makeSystemFunctions([equation], vars);
  const free = vars.filter(v => !active.includes(v) || active.indexOf(v) > 0);

  out.push(`**分析:** 该方程含 ${active.length} 个变量（${active.join(', ')}），`
    + `是欠定的 —— 有无限多组解。`);
  out.push('');
  out.push('**通解形式:** 任选 ' + (active.length - 1) + ' 个变量作自由参数，'
    + `剩下的 \`${active[0]}\` 由方程唯一确定（或反过来）。`);
  out.push('');
  out.push('**示例解（自由参数取 0）:**');
  const sols = [];
  for (const probe of [0, 1, -1, 2]) {
    const x0 = new Array(vars.length).fill(0);
    const idx = vars.indexOf(active[0]);
    x0[idx] = probe;
    const r = levenbergMarquardt(fns, x0, { tol: 1e-14, softTol: 1e-8 });
    if (r && r.ok) sols.push(r.x);
  }
  const seen = [];
  for (const s of sols) {
    if (seen.some(t => t.every((v, i) => Math.abs(v - s[i]) < 1e-8))) continue;
    seen.push(s);
  }
  if (seen.length) {
    seen.forEach(s => {
      out.push('- ' + vars.map((v, i) => `${v} = ${formatValue(clean(s[i]), opts).text}`).join('，'));
    });
  } else {
    out.push('（未找到满足方程的数值点，请检查方程是否有实解）');
  }
  out.push('');
  out.push('> 想要**参数式**通解，请把该方程喂给一个符号计算工具；'
    + '本工具给的是数值解。若只想解某个变量，用 `equation=... , variable="x"` 的单方程模式。');
  return out.join('\n');
}

/** 把求解结果代回原方程，给出残差验证表（建立信任） */
function appendVerification(out, fns, vars, sols, opts) {
  out.push('');
  out.push('**代回验证:**');
  out.push('| ' + vars.join(' | ') + ' | 各方程残差 |');
  out.push('|' + '---|'.repeat(vars.length) + '---|');
  for (const s of sols) {
    const rs = residualsAt(fns, s);
    out.push('| ' + s.map(x => formatValue(clean(x), opts).text).join(' | ')
      + ' | ' + rs.map(r => fmtResidual(r)).join(', ') + ' |');
  }
}

function fmtResidual(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v === 0) return '0';
  if (Math.abs(v) < 1e-6) return v.toExponential(2);
  return Number(v.toPrecision(6)).toString();
}

/**
 * 归一化 searchRange，返回每个变量各自的 [lo, hi] 数组。
 * 支持：
 *   [lo, hi]                        所有变量同一区间
 *   [[lo1,hi1],[lo2,hi2],...]       每变量不同区间（长度须 = 变量数）
 */
function normalizeSystemBox(args, n) {
  const r = args.searchRange != null ? args.searchRange : args.range;
  if (!Array.isArray(r) || !r.length) {
    return { box: Array.from({ length: n }, () => [-10, 10]), flat: [-10, 10] };
  }
  // 每变量不同
  if (Array.isArray(r[0])) {
    if (r.length !== n) {
      throw new Error(`searchRange 给了 ${r.length} 组区间，但未知数有 ${n} 个，数量必须一致`);
    }
    const box = r.map((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`searchRange[${i}] 不是 [lo, hi]`);
      const lo = Number(pair[0]), hi = Number(pair[1]);
      if (!isFinite(lo) || !isFinite(hi) || lo >= hi) {
        throw new Error(`searchRange[${i}] = [${pair[0]}, ${pair[1]}] 不合法（要求 lo < hi）`);
      }
      return [lo, hi];
    });
    return { box, flat: [Math.min(...box.map(b => b[0])), Math.max(...box.map(b => b[1]))] };
  }
  // 统一区间
  const lo = Number(r[0]), hi = Number(r[1]);
  if (!isFinite(lo) || !isFinite(hi) || lo >= hi) {
    throw new Error(`searchRange = [${r[0]}, ${r[1]}] 不合法（要求 lo < hi）`);
  }
  return { box: Array.from({ length: n }, () => [lo, hi]), flat: [lo, hi] };
}

/** 归一化 guesses：[[...], [...]] → 起点数组 */
function normalizeGuesses(g, n) {
  if (!Array.isArray(g)) return [];
  const out = [];
  for (const item of g) {
    if (Array.isArray(item) && item.length === n && item.every(v => isFinite(Number(v)))) {
      out.push(item.map(Number));
    } else if (typeof item === 'number') {
      out.push(new Array(n).fill(Number(item)));
    }
  }
  return out;
}

/** 矩阵秩（行阶梯化，列主元） */
function matrixRank(A) {
  if (!A.length) return 0;
  const M = A.map(r => r.slice());
  const rows = M.length, cols = M[0].length;
  let rank = 0;
  for (let col = 0; col < cols && rank < rows; col++) {
    let piv = -1, best = 1e-12;
    for (let r = rank; r < rows; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (piv < 0) continue;
    [M[rank], M[piv]] = [M[piv], M[rank]];
    for (let r = 0; r < rows; r++) {
      if (r === rank) continue;
      const f = M[r][col] / M[rank][col];
      if (f === 0) continue;
      for (let c = col; c < cols; c++) M[r][c] -= f * M[rank][c];
    }
    rank++;
  }
  return rank;
}

/** 高斯消元（带部分主元）；方程数 = 未知数数时用，返回解或 null */
function gaussSolve(A, b) {
  const n = A.length;
  if (!n || A[0].length !== n) return null;
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
  const x = M.map((row, i) => row[n] / row[i]);
  return x.every(isFinite) ? x : null;
}

/**
 * 欠定 / 超定线性系统的最小范数最小二乘解：
 * 用正规方程 (AᵀA + εI) x = Aᵀb（Tikhonov 正则，ε 取小值保证可解）。
 */
function gaussSolveLeast(A, b) {
  const m = A.length, n = A[0].length;
  const eps = 1e-12;
  const M = zeros(n, n), rhs = new Array(n).fill(0);
  for (let i = 0; i < m; i++) {
    for (let a = 0; a < n; a++) {
      rhs[a] += A[i][a] * b[i];
      for (let c = 0; c < n; c++) M[a][c] += A[i][a] * A[i][c];
    }
  }
  for (let a = 0; a < n; a++) M[a][a] += eps;
  return solveSymmetric(M, rhs);
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

module.exports = {
  run,
  polyRoots,
  numericRoots,
  splitEquation,
  solveNonlinearSystem,
  levenbergMarquardt,
  linearize,
  verifyLinear
};
