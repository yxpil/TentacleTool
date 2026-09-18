'use strict';
/**
 * 复数运算（零依赖）
 *
 * 内部统一用 {re, im} 表示；实数就是 im === 0。
 * 求值层对"纯实数运算"快路径直接用 Number 算，只有出现虚部才走这里，
 * 这样常见算式没有对象分配开销，精度也更好。
 *
 * 精度处理：三角函数/开方等在实轴上的结果会做噪声清理（见 clean），
 * 让 sin(pi) 得到 0 而不是 1.22e-16。
 */

const EPS = 1e-12;

/** 把 |x| 小于阈值的分量归零，消除浮点噪声 */
function clean(x) {
  if (!isFinite(x)) return x;
  return Math.abs(x) < EPS ? 0 : x;
}

const C = (re, im) => ({ re: re || 0, im: im || 0 });

const isReal = (z) => typeof z === 'number' || (z && !z.im);

/** 复数结果在虚部为 0 时退化回实数，减少后续运算的对象开销 */
function simp(z) {
  if (typeof z === 'number') return z;
  if (!z) return z;
  return z.im === 0 ? z.re : z;
}

/** 复数加法 */
function add(a, b) {
  const A = toC(a), B = toC(b);
  if (A.im === 0 && B.im === 0) return clean(A.re + B.re);
  return C(clean(A.re + B.re), clean(A.im + B.im));
}
function sub(a, b) {
  const A = toC(a), B = toC(b);
  if (A.im === 0 && B.im === 0) return clean(A.re - B.re);
  return C(clean(A.re - B.re), clean(A.im - B.im));
}
function mul(a, b) {
  const A = toC(a), B = toC(b);
  if (A.im === 0 && B.im === 0) return clean(A.re * B.re);          // 纯实数快路径
  return C(clean(A.re * B.re - A.im * B.im), clean(A.re * B.im + A.im * B.re));
}
function div(a, b) {
  const A = toC(a), B = toC(b);
  if (B.im === 0) {
    if (B.re === 0) return C(A.re === 0 ? NaN : A.re / 0, A.im === 0 ? NaN : A.im / 0);
    if (A.im === 0) return clean(A.re / B.re);
    return C(clean(A.re / B.re), clean(A.im / B.re));
  }
  const d = B.re * B.re + B.im * B.im;
  if (d === 0) return C(NaN, NaN);
  return C(clean((A.re * B.re + A.im * B.im) / d), clean((A.im * B.re - A.re * B.im) / d));
}

function abs(z) {
  const A = toC(z);
  if (A.im === 0) return Math.abs(A.re);
  return Math.hypot(A.re, A.im);
}
function arg(z) {
  const A = toC(z);
  return Math.atan2(A.im, A.re);
}
function conj(z) {
  const A = toC(z);
  return A.im === 0 ? A.re : C(A.re, -A.im);
}
function neg(z) {
  const A = toC(z);
  return A.im === 0 ? -A.re : C(-A.re, -A.im);
}

/** 幂运算：整数指数用重复平方（实数→实数，精度好）；其余走极坐标 */
function pow(a, b) {
  const A = toC(a), B = toC(b);
  // 实数底 + 实数指数 → 实数快路径（含负数非整数指数落到复数域）
  if (A.im === 0 && B.im === 0) {
    const base = A.re, exp = B.re;
    if (base >= 0 || Number.isInteger(exp)) {
      const r = Math.pow(base, exp);
      if (!Number.isNaN(r) || base !== 0) return clean(r);
    }
    // 负底非整数指数：(-8)^(1/3) → 主值 1+1.732i（复数域）
  }
  if (A.re === 0 && A.im === 0) {
    if (B.re === 0 && B.im === 0) return 1;
    return B.re > 0 ? 0 : C(Infinity, 0);
  }
  // 整数实指数：重复平方，避免极坐标精度损失
  if (B.im === 0 && Number.isInteger(B.re) && Math.abs(B.re) <= 1000) {
    let n = B.re, result = C(1, 0), baseC = A;
    if (n < 0) { baseC = div(1, baseC); n = -n; }
    while (n > 0) {
      if (n & 1) result = mul(result, baseC);
      baseC = mul(baseC, baseC);
      n = Math.floor(n / 2);
    }
    return result;
  }
  // 一般情形：z^w = e^(w·ln z)
  const lnz = complexLog(A);
  return complexExp(mul(B, lnz));
}

/** 自然对数（主值分支，arg ∈ (-π, π]） */
function complexLog(z) {
  const A = toC(z);
  if (A.re === 0 && A.im === 0) return C(-Infinity, 0);
  return C(clean(Math.log(Math.hypot(A.re, A.im))), Math.atan2(A.im, A.re));
}
function complexExp(z) {
  const A = toC(z);
  if (A.im === 0) return clean(Math.exp(A.re));
  const r = Math.exp(A.re);
  return C(clean(r * Math.cos(A.im)), clean(r * Math.sin(A.im)));
}
function complexSqrt(z) {
  const A = toC(z);
  if (A.im === 0 && A.re >= 0) return Math.sqrt(A.re);
  const m = Math.hypot(A.re, A.im);
  const re = Math.sqrt((m + A.re) / 2);
  let im = Math.sqrt((m - A.re) / 2);
  if (A.im < 0) im = -im;
  return C(clean(re), clean(im));
}

/* ---- 三角/双曲（复数公式）---- */
function complexSin(z) {
  const A = toC(z);
  if (A.im === 0) return clean(Math.sin(A.re));
  return C(clean(Math.sin(A.re) * Math.cosh(A.im)), clean(Math.cos(A.re) * Math.sinh(A.im)));
}
function complexCos(z) {
  const A = toC(z);
  if (A.im === 0) return clean(Math.cos(A.re));
  return C(clean(Math.cos(A.re) * Math.cosh(A.im)), clean(-Math.sin(A.re) * Math.sinh(A.im)));
}
function complexTan(z) {
  const A = toC(z);
  if (A.im === 0) return clean(Math.tan(A.re));
  return div(complexSin(A), complexCos(A));
}
function complexSinh(z) {
  const A = toC(z);
  if (A.im === 0) return clean(Math.sinh(A.re));
  return C(clean(Math.sinh(A.re) * Math.cos(A.im)), clean(Math.cosh(A.re) * Math.sin(A.im)));
}
function complexCosh(z) {
  const A = toC(z);
  if (A.im === 0) return clean(Math.cosh(A.re));
  return C(clean(Math.cosh(A.re) * Math.cos(A.im)), clean(Math.sinh(A.re) * Math.sin(A.im)));
}
function complexTanh(z) {
  const A = toC(z);
  if (A.im === 0) return clean(Math.tanh(A.re));
  return div(complexSinh(A), complexCosh(A));
}

/* ---- 反三角/反双曲（对数形式，支持复数分支）---- */
function complexAsin(z) {
  const A = toC(z);
  if (A.im === 0 && A.re >= -1 && A.re <= 1) return Math.asin(A.re);
  // asin z = -i·ln(iz + sqrt(1-z²))
  const iz = C(-A.im, A.re);
  const s = complexSqrt(sub(1, mul(A, A)));
  const l = complexLog(add(iz, s));
  return C(clean(l.im), clean(-l.re));
}
function complexAcos(z) {
  const A = toC(z);
  if (A.im === 0 && A.re >= -1 && A.re <= 1) return Math.acos(A.re);
  // acos z = π/2 - asin z
  return sub(Math.PI / 2, complexAsin(A));
}
function complexAtan(z) {
  const A = toC(z);
  if (A.im === 0) return clean(Math.atan(A.re));
  // atan z = (i/2)·ln((i+z)/(i-z))
  const q = div(add(C(0, 1), A), sub(C(0, 1), A));
  const l = complexLog(q);
  return C(clean(-l.im / 2), clean(l.re / 2));
}

/* ---- 工具 ---- */
function toC(z) {
  if (typeof z === 'number') return C(z, 0);
  if (!z) return C(0, 0);
  return { re: z.re || 0, im: z.im || 0 };
}
/** 复数 → 极坐标 {r, theta} */
function toPolar(z) {
  const A = toC(z);
  return { r: Math.hypot(A.re, A.im), theta: Math.atan2(A.im, A.re) };
}

module.exports = {
  C, toC, isReal, clean, simp, EPS,
  add, sub, mul, div, pow, neg, conj, abs, arg,
  complexLog, complexExp, complexSqrt,
  complexSin, complexCos, complexTan,
  complexSinh, complexCosh, complexTanh,
  complexAsin, complexAcos, complexAtan,
  toPolar
};
