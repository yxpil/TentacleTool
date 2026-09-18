'use strict';
/**
 * 内置常量
 * 复数常量用 {re, im} 表示，求值层会按需退化。
 */
const PI = Math.PI;
const E = Math.E;

const CONSTANTS = {
  pi: PI,
  'π': PI,
  tau: 2 * Math.PI,
  'τ': 2 * Math.PI,
  e: E,
  i: { re: 0, im: 1 },
  j: { re: 0, im: 1 },
  inf: Infinity,
  infinity: Infinity,
  '∞': Infinity,
  nan: NaN,
  phi: (1 + Math.sqrt(5)) / 2,          // 黄金比例
  'φ': (1 + Math.sqrt(5)) / 2,
  golden: (1 + Math.sqrt(5)) / 2,
  sqrt2: Math.SQRT2,
  sqrt3: Math.sqrt(3),
  sqrt5: Math.sqrt(5),
  ln2: Math.LN2,
  ln10: Math.LN10,
  log2e: Math.LOG2E,
  log10e: Math.LOG10E,
  c: 299792458,                          // 光速 m/s
  g: 9.80665,                            // 标准重力加速度 m/s²
  G: 6.67430e-11,                        // 引力常数
  h: 6.62607015e-34,                     // 普朗克常数
  hbar: 1.054571817e-34,                 // 约化普朗克常数
  k: 1.380649e-23,                       // 玻尔兹曼常数
  Na: 6.02214076e23,                     // 阿伏伽德罗常数
  R: 8.314462618,                        // 气体常数
  qe: 1.602176634e-19,                   // 元电荷
  me: 9.1093837015e-31,                  // 电子质量
  mp: 1.67262192369e-27,                 // 质子质量
  atm: 101325,                           // 标准大气压 Pa
  au: 1.495978707e11,                    // 天文单位 m
  ly: 9.4607304725808e15                 // 光年 m
};

/** 常量名集合（用于改进错误提示：把拼错的函数名/变量名提示出来） */
const CONSTANT_NAMES = new Set(Object.keys(CONSTANTS));

/** 大小写不敏感查找常量（PI / Pi / pi 都能命中） */
function lookupConstant(name) {
  if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) {
    return { name, value: CONSTANTS[name] };
  }
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CONSTANTS, lower)) {
    return { name: lower, value: CONSTANTS[lower] };
  }
  return null;
}

module.exports = { CONSTANTS, CONSTANT_NAMES, lookupConstant };
