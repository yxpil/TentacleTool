'use strict';
/**
 * 数值格式化（零依赖）
 *
 * 目标：让输出像计算器，而不是像浮点调试日志。
 *   - 消除浮点噪声：sqrt(2)^2 = 2.0000000000000004 → 2
 *   - 整数不显示 .0，也不显示 2.0000000001
 *   - 自动科学计数：很大/很小的数给 1.234e+15，同时给可读写法
 *   - 分数近似：0.3333333333333333 → 1/3（可选，给人类友好提示）
 *   - 复数：3+4i / -2i / 5
 *
 * 关键实现是 snapToRational：先在 1e-12 相对误差内尝试"漂亮的"表示
 * （整数、简单分数、常见无理数平方），命中就用它，否则按精度位数输出。
 */
const cx = require('./complex');

const REL_EPS = 1e-12;

/** 常用无理数的平方/组合，用于把 1.4142135... 识别成 √2 */
const NICE_IRRATIONAL = [
  { value: Math.SQRT2, label: '√2' },
  { value: Math.sqrt(3), label: '√3' },
  { value: Math.sqrt(5), label: '√5' },
  { value: Math.PI, label: 'π' },
  { value: 2 * Math.PI, label: '2π' },
  { value: Math.PI / 2, label: 'π/2' },
  { value: Math.PI / 3, label: 'π/3' },
  { value: Math.PI / 4, label: 'π/4' },
  { value: Math.PI / 6, label: 'π/6' },
  { value: Math.E, label: 'e' },
  { value: (1 + Math.sqrt(5)) / 2, label: 'φ' },
  { value: Math.LN2, label: 'ln2' },
  { value: Math.LN10, label: 'ln10' }
];

function nearlyEqual(a, b, relEps = REL_EPS) {
  if (a === b) return true;
  if (!isFinite(a) || !isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff <= relEps * scale;
}

/** 尝试用连分数找出简单有理数近似（分母 ≤ maxDen） */
function toFraction(x, maxDen = 1000000) {
  if (!isFinite(x)) return null;
  const sign = x < 0 ? -1 : 1;
  const v = Math.abs(x);
  let h1 = 1, h0 = 0, k1 = 0, k0 = 1, b = v;
  do {
    const a = Math.floor(b);
    let h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    h0 = h1; h1 = h2;
    k0 = k1; k1 = k2;
    if (Math.abs(b - a) < 1e-15) break;
    b = 1 / (b - a);
  } while (true);
  if (k1 === 0 || k1 === 1) return null;             // 整数不值得写成分数
  if (!nearlyEqual(sign * h1 / k1, x, REL_EPS * 10)) return null;
  if (k1 > maxDen) return null;
  const g = gcd(Math.abs(h1), k1);
  return { num: sign * h1 / g, den: k1 / g };
}

function gcd(a, b) {
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

/**
 * 主格式化：数字 → 字符串
 * opts:
 *   precision  有效数字位数（默认 12，范围 1-17）
 *   fraction   true 时若为简单分数/无理数则给友好写法（默认 true，仅用于附加提示）
 *   showInt    整数是否加千分位（默认 false，避免公式里带逗号）
 * 返回 { text, extra } —— extra 是可选的"另一种写法"提示
 */
function formatNumber(x, opts = {}) {
  const precision = clampInt(opts.precision, 12, 1, 17);
  if (typeof x !== 'number') return { text: String(x), extra: null };

  if (Number.isNaN(x)) return { text: 'NaN（未定义/无解）', extra: null };
  if (x === Infinity) return { text: '∞', extra: null };
  if (x === -Infinity) return { text: '-∞', extra: null };
  if (x === 0) return { text: '0', extra: null };     // 含 -0

  // 1) 整数快路径
  if (Number.isInteger(x) && Math.abs(x) < 1e21) {
    return { text: String(x), extra: null };
  }

  // 2) 消除浮点噪声后看是否是整数
  const rounded = Math.round(x);
  if (nearlyEqual(x, rounded, REL_EPS) && Math.abs(rounded) < 1e15) {
    return { text: String(rounded), extra: null };
  }

  // 3) 非常小/非常大 → 科学计数
  const ax = Math.abs(x);
  if (ax >= 1e15 || ax < 1e-7) {
    return { text: sciNotation(x, precision), extra: null };
  }

  // 4) 常见无理数与简单分数的友好表示（先试，命中就优先展示）
  if (opts.fraction !== false) {
    for (const n of NICE_IRRATIONAL) {
      if (nearlyEqual(x, n.value, 1e-13)) {
        return { text: trimToPrecision(x, precision), extra: n.label };
      }
      if (nearlyEqual(x, -n.value, 1e-13)) {
        return { text: trimToPrecision(x, precision), extra: '-' + n.label };
      }
    }
  }

  // 5) 常规：按有效数字输出，去掉尾随零
  const text = trimToPrecision(x, precision);
  let extra = null;
  if (opts.fraction !== false) {
    const fr = toFraction(x);
    if (fr) extra = `${fr.num}/${fr.den}`;
  }
  return { text, extra };
}

/** 按有效数字裁剪，并去掉浮点噪声尾巴 */
function trimToPrecision(x, precision) {
  let s = x.toPrecision(precision);
  if (s.includes('e')) {
    // toPrecision 可能给出科学计数，转回普通写法（此分支只会出现在极值处）
    const n = Number(s);
    s = Math.abs(n) >= 1e-7 && Math.abs(n) < 1e21 ? plainString(n) : s.replace('e', 'e');
  }
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  // 处理 "1.9999999999999998" 这类接近整数的尾巴
  const num = Number(s);
  if (Number.isFinite(num)) {
    const r = Math.round(num);
    if (r !== 0 && nearlyEqual(num, r, 1e-12) && Math.abs(r) < 1e15) return String(r);
  }
  return s;
}

/** 科学计数法：3 位有效尾数 */
function sciNotation(x, precision) {
  const digits = Math.max(1, Math.min(precision, 15) - 1);
  let s = x.toExponential(digits);
  // 去掉尾数多余的 0：1.5000e+15 → 1.5e+15
  s = s.replace(/\.?0+e/, 'e');
  return s.replace('e+', 'e+').replace('e-', 'e-');
}

function plainString(n) {
  return String(n);
}

function clampInt(v, def, lo, hi) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * 复数格式化：3+4i / -2i / 5
 * 返回 { text, extra }
 */
function formatComplex(z, opts = {}) {
  z = cx.toC(z);
  const re = cx.clean(z.re), im = cx.clean(z.im);
  if (im === 0) return formatNumber(re, opts);

  const imAbs = Math.abs(im);
  // 纯虚数：3i / -2i / i / -i（不写 "0+1i" 这种啰嗦形式）
  if (re === 0) {
    if (imAbs === 1) return { text: im < 0 ? '-i' : 'i', extra: null };
    const imPart = formatNumber(imAbs, opts);
    return { text: imPart.text + 'i', extra: imPart.extra ? imPart.extra + 'i' : null };
  }

  const rePart = formatNumber(re, opts);
  const imPart = formatNumber(imAbs, opts);
  const sign = im < 0 ? '-' : '+';

  let extra = null;
  if (rePart.extra || imPart.extra) {
    const rl = rePart.extra || rePart.text;
    const il = imPart.extra || imPart.text;
    extra = `${rl}${sign}${il}i`;
  }
  // 虚部系数为 1 时省略 "1"：3+i 而非 3+1i
  const imText = imAbs === 1 ? '' : imPart.text;
  const text = `${rePart.text}${sign}${imText}i`;
  return { text, extra };
}

/**
 * 统一入口：数字或复数 → { text, extra }
 * 供 evaluator 与各工具直接调用。
 */
function formatValue(v, opts = {}) {
  if (typeof v === 'number') return formatNumber(v, opts);
  if (v && typeof v === 'object' && 're' in v) return formatComplex(v, opts);
  if (Array.isArray(v)) return { text: '[' + v.map(x => formatValue(x, opts).text).join(', ') + ']', extra: null };
  if (typeof v === 'string') return { text: v, extra: null };
  return { text: String(v), extra: null };
}

/** 只要字符串的便捷封装 */
function fmt(v, opts = {}) {
  const r = formatValue(v, opts);
  return r.extra ? r.text + '  (' + r.extra + ')' : r.text;
}

/** 复数 → 极坐标展示（供 calc_eval 的 polar=true） */
function fmtPolar(z) {
  const p = cx.toPolar(z);
  const r = formatNumber(p.r).text;
  const t = formatNumber(p.theta).text;
  return `r=${r}, θ=${t} rad`;
}

module.exports = {
  formatNumber, formatComplex, formatValue, fmt, fmtPolar,
  trimToPrecision, sciNotation, toFraction, nearlyEqual, REL_EPS
};
