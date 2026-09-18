'use strict';
/**
 * calc_convert：单位换算
 *
 * 设计：每个类别有一个"基准单位"，各单位给出到基准的换算因子（或函数，温度用）。
 * 这样任意两单位之间只需 base = value * fromF；result = base / toF。
 */
const { formatValue } = require('../utils/format');
const { num } = require('../utils/functions');

/* ======================== 单位表 ======================== */

/**
 * 每类：{ base: '基准单位名', units: { 单位: 因子 } }
 * 因子 = 1 个该单位 等于多少个基准单位。
 */
const CATEGORIES = {
  length: {
    base: 'm',
    units: {
      m: 1, meter: 1, meters: 1, metre: 1, metres: 1, 米: 1,
      km: 1000, kilometer: 1000, kilometers: 1000, 千米: 1000, 公里: 1000,
      cm: 0.01, centimeter: 0.01, 厘米: 0.01,
      mm: 0.001, millimeter: 0.001, 毫米: 0.001,
      um: 1e-6, micrometer: 1e-6, 微米: 1e-6,
      nm: 1e-9, nanometer: 1e-9, 纳米: 1e-9,
      dm: 0.1, decimeter: 0.1, 分米: 0.1,
      mi: 1609.344, mile: 1609.344, miles: 1609.344, 英里: 1609.344,
      yd: 0.9144, yard: 0.9144, yards: 0.9144, 码: 0.9144,
      ft: 0.3048, foot: 0.3048, feet: 0.3048, 英尺: 0.3048,
      in: 0.0254, inch: 0.0254, inches: 0.0254, 英寸: 0.0254,
      nmi: 1852, nauticalmile: 1852, 海里: 1852,
      ly: 9.4607304725808e15, lightyear: 9.4607304725808e15, 光年: 9.4607304725808e15,
      au: 1.495978707e11, 天文单位: 1.495978707e11,
      pc: 3.0856775814913673e16, parsec: 3.0856775814913673e16, 秒差距: 3.0856775814913673e16,
      furlong: 201.168, 弗隆: 201.168,
      thou: 0.0000254, mil: 0.0000254
    }
  },
  mass: {
    base: 'kg',
    units: {
      kg: 1, kilogram: 1, kilograms: 1, 千克: 1, 公斤: 1,
      g: 0.001, gram: 0.001, grams: 0.001, 克: 0.001,
      mg: 1e-6, milligram: 1e-6, 毫克: 1e-6,
      ug: 1e-9, microgram: 1e-9, 微克: 1e-9,
      t: 1000, tonne: 1000, ton: 1000, tons: 1000, 吨: 1000,
      lb: 0.45359237, pound: 0.45359237, pounds: 0.45359237, 磅: 0.45359237,
      oz: 0.028349523125, ounce: 0.028349523125, ounces: 0.028349523125, 盎司: 0.028349523125,
      st: 6.35029318, stone: 6.35029318, 英石: 6.35029318,
      jin: 0.5, 斤: 0.5,
      liang: 0.05, 两: 0.05,
      ct: 0.0002, carat: 0.0002, 克拉: 0.0002,
      slug: 14.5939029372
    }
  },
  area: {
    base: 'm2',
    units: {
      m2: 1, '平方米': 1, sqm: 1,
      km2: 1e6, '平方千米': 1e6, sqkm: 1e6,
      cm2: 1e-4, '平方厘米': 1e-4,
      mm2: 1e-6, '平方毫米': 1e-6,
      ha: 10000, hectare: 10000, 公顷: 10000,
      acre: 4046.8564224, acres: 4046.8564224, 英亩: 4046.8564224,
      mu: 666.6666666666666, 亩: 666.6666666666666,
      ft2: 0.09290304, sqft: 0.09290304, '平方英尺': 0.09290304,
      in2: 0.00064516, sqin: 0.00064516, '平方英寸': 0.00064516,
      yd2: 0.83612736, sqyd: 0.83612736,
      mi2: 2589988.110336, sqmi: 2589988.110336,
      are: 100, 公亩: 100
    }
  },
  volume: {
    base: 'l',
    units: {
      l: 1, liter: 1, liters: 1, litre: 1, litres: 1, 升: 1,
      ml: 0.001, milliliter: 0.001, 毫升: 0.001,
      ul: 1e-6, microliter: 1e-6, 微升: 1e-6,
      m3: 1000, '立方米': 1000, cum: 1000,
      cm3: 0.001, '立方厘米': 0.001, cc: 0.001,
      gal: 3.785411784, gallon: 3.785411784, gallons: 3.785411784, 加仑: 3.785411784,
      qt: 0.946352946, quart: 0.946352946, 夸脱: 0.946352946,
      pt: 0.473176473, pint: 0.473176473, 品脱: 0.473176473,
      cup: 0.2365882365, cups: 0.2365882365, 杯: 0.2365882365,
      floz: 0.0295735295625, fluidounce: 0.0295735295625,
      tbsp: 0.01478676478125, 汤匙: 0.01478676478125,
      tsp: 0.00492892159375, 茶匙: 0.00492892159375,
      'ft3': 28.316846592, cubft: 28.316846592,
      'in3': 0.016387064, cubin: 0.016387064,
      bbl: 158.987294928, barrel: 158.987294928, 桶: 158.987294928
    }
  },
  time: {
    base: 's',
    units: {
      s: 1, sec: 1, second: 1, seconds: 1, 秒: 1,
      ns: 1e-9, 纳秒: 1e-9,
      us: 1e-6, 微秒: 1e-6,
      ms: 0.001, 毫秒: 0.001,
      min: 60, minute: 60, minutes: 60, 分: 60, 分钟: 60,
      h: 3600, hr: 3600, hour: 3600, hours: 3600, 小时: 3600,
      d: 86400, day: 86400, days: 86400, 天: 86400, 日: 86400,
      w: 604800, week: 604800, weeks: 604800, 周: 604800, 星期: 604800,
      month: 2629800, months: 2629800, 月: 2629800,
      y: 31557600, year: 31557600, years: 31557600, 年: 31557600,
      decade: 315576000, 十年: 315576000,
      century: 3155760000, 世纪: 3155760000
    }
  },
  speed: {
    base: 'm/s',
    units: {
      'm/s': 1, mps: 1, '米/秒': 1,
      'km/h': 1 / 3.6, kph: 1 / 3.6, kmh: 1 / 3.6, '千米/小时': 1 / 3.6, '公里/小时': 1 / 3.6,
      'mi/h': 0.44704, mph: 0.44704, 英里每小时: 0.44704,
      kn: 0.514444444444, knot: 0.514444444444, knots: 0.514444444444, 节: 0.514444444444,
      'ft/s': 0.3048, fps: 0.3048,
      c: 299792458, 光速: 299792458,
      mach: 340.29, 马赫: 340.29
    }
  },
  data: {
    base: 'B',
    units: {
      b: 0.125, bit: 0.125, bits: 0.125, 位: 0.125,
      B: 1, byte: 1, bytes: 1, 字节: 1,
      KB: 1024, KiB: 1024, kb: 1024, kilobyte: 1024,
      MB: 1048576, MiB: 1048576, mb: 1048576, megabyte: 1048576,
      GB: 1073741824, GiB: 1073741824, gb: 1073741824, gigabyte: 1073741824,
      TB: 1099511627776, TiB: 1099511627776, tb: 1099511627776, terabyte: 1099511627776,
      PB: 1125899906842624, PiB: 1125899906842624, pb: 1125899906842624, petabyte: 1125899906842624
    }
  },
  pressure: {
    base: 'Pa',
    units: {
      Pa: 1, pascal: 1, 帕: 1, 帕斯卡: 1,
      kPa: 1000, 千帕: 1000,
      MPa: 1e6, 兆帕: 1e6,
      bar: 100000, 巴: 100000,
      mbar: 100, 毫巴: 100,
      atm: 101325, 标准大气压: 101325,
      mmHg: 133.322387415, 毫米汞柱: 133.322387415, torr: 133.322368421,
      psi: 6894.757293168, 磅力每平方英寸: 6894.757293168,
      kgfcm2: 98066.5, 'kgf/cm2': 98066.5
    }
  },
  energy: {
    base: 'J',
    units: {
      J: 1, joule: 1, 焦: 1, 焦耳: 1,
      kJ: 1000, 千焦: 1000,
      MJ: 1e6, 兆焦: 1e6,
      cal: 4.184, calorie: 4.184, calories: 4.184, 卡: 4.184, 卡路里: 4.184,
      kcal: 4184, 千卡: 4184, 大卡: 4184,
      Wh: 3600, 瓦时: 3600,
      kWh: 3600000, 千瓦时: 3600000, 度电: 3600000,
      eV: 1.602176634e-19, 电子伏: 1.602176634e-19,
      keV: 1.602176634e-16, MeV: 1.602176634e-13, GeV: 1.602176634e-10,
      BTU: 1055.05585262, btu: 1055.05585262,
      erg: 1e-7, 尔格: 1e-7,
      ftlb: 1.3558179483314004, 'ft·lb': 1.3558179483314004
    }
  },
  power: {
    base: 'W',
    units: {
      W: 1, watt: 1, 瓦: 1, 瓦特: 1,
      kW: 1000, 千瓦: 1000,
      MW: 1e6, 兆瓦: 1e6,
      hp: 745.6998715822702, horsepower: 745.6998715822702, 马力: 745.6998715822702,
      'PS': 735.49875, 公制马力: 735.49875,
      'cal/s': 4.184, 'kcal/h': 1.163
    }
  },
  angle: {
    base: 'rad',
    units: {
      rad: 1, radian: 1, radians: 1, 弧度: 1,
      deg: Math.PI / 180, degree: Math.PI / 180, degrees: Math.PI / 180, 度: Math.PI / 180,
      grad: Math.PI / 200, gradian: Math.PI / 200, 百分度: Math.PI / 200,
      turn: 2 * Math.PI, revolution: 2 * Math.PI, 圈: 2 * Math.PI, 转: 2 * Math.PI,
      arcmin: Math.PI / 10800, 角分: Math.PI / 10800,
      arcsec: Math.PI / 648000, 角秒: Math.PI / 648000
    }
  },
  frequency: {
    base: 'Hz',
    units: {
      Hz: 1, hertz: 1, 赫兹: 1, 赫: 1,
      kHz: 1000, 千赫: 1000,
      MHz: 1e6, 兆赫: 1e6,
      GHz: 1e9, 吉赫: 1e9,
      THz: 1e12, rpm: 1 / 60, 转每分: 1 / 60
    }
  }
};

/** 温度：非线性，单独处理（全部转到摄氏度再转出） */
const TEMP_UNITS = {
  c: 'c', celsius: 'c', centigrade: 'c', 摄氏度: 'c', '°c': 'c',
  f: 'f', fahrenheit: 'f', 华氏度: 'f', '°f': 'f',
  k: 'k', kelvin: 'k', 开尔文: 'k', 开: 'k',
  r: 'r', rankine: 'r', 兰氏度: 'r'
};

/* ======================== 查找 ======================== */

/** 在指定类别里找单位（大小写敏感优先，再退化到小写匹配） */
function findUnitIn(cat, name) {
  const units = CATEGORIES[cat].units;
  if (Object.prototype.hasOwnProperty.call(units, name)) return { unit: name, factor: units[name] };
  const lower = String(name).toLowerCase();
  for (const k of Object.keys(units)) {
    if (k.toLowerCase() === lower) return { unit: k, factor: units[k] };
  }
  return null;
}

/** 跨全部分类查找某单位属于哪些类别 */
function locateUnit(name) {
  const hits = [];
  for (const cat of Object.keys(CATEGORIES)) {
    const f = findUnitIn(cat, name);
    if (f) hits.push({ category: cat, unit: f.unit });
  }
  if (TEMP_UNITS[String(name).toLowerCase()]) {
    hits.push({ category: 'temperature', unit: String(name).toLowerCase() });
  }
  return hits;
}

/* ======================== 温度换算 ======================== */

function tempToC(v, unit) {
  switch (unit) {
    case 'c': return v;
    case 'f': return (v - 32) * 5 / 9;
    case 'k': return v - 273.15;
    case 'r': return (v - 491.67) * 5 / 9;
    default: throw new Error('未知温度单位: ' + unit);
  }
}

function cToTemp(c, unit) {
  switch (unit) {
    case 'c': return c;
    case 'f': return c * 9 / 5 + 32;
    case 'k': return c + 273.15;
    case 'r': return (c + 273.15) * 9 / 5;
    default: throw new Error('未知温度单位: ' + unit);
  }
}

const TEMP_LABEL = { c: '°C', f: '°F', k: 'K', r: '°R' };

/* ======================== 主逻辑 ======================== */

const CATEGORY_ALIASES = {
  length: ['length', '长度'], mass: ['mass', 'weight', '质量', '重量'],
  area: ['area', '面积'], volume: ['volume', '体积', '容积'],
  time: ['time', '时间'], speed: ['speed', 'velocity', '速度'],
  data: ['data', 'storage', '数据', '存储'],
  pressure: ['pressure', '压强', '压力'], energy: ['energy', '能量', '功'],
  power: ['power', '功率'], angle: ['angle', '角度'],
  frequency: ['frequency', '频率'], temperature: ['temperature', 'temp', '温度']
};

function categoryList() {
  return Object.keys(CATEGORIES).concat(['temperature']);
}

function resolveCategory(name) {
  const s = String(name).toLowerCase();
  for (const cat of Object.keys(CATEGORY_ALIASES)) {
    if (CATEGORY_ALIASES[cat].some(a => String(a).toLowerCase() === s)) return cat;
  }
  return null;
}

/** 单位换算核心：返回数值 */
function convertUnit(value, from, to, category) {
  const f = String(from).trim();
  const t = String(to).trim();

  // 温度优先判定（c/f/k 等短名会与其它类别冲突，但温度只有 4 个单位，且常成对出现）
  const fT = TEMP_UNITS[f.toLowerCase()];
  const tT = TEMP_UNITS[t.toLowerCase()];
  const wantTemp = category === 'temperature' || (!category && fT && tT);

  if (wantTemp) {
    if (!fT) throw new Error(`温度类里没有单位 "${f}"（可用: c, f, k, r）`);
    if (!tT) throw new Error(`温度类里没有单位 "${t}"（可用: c, f, k, r）`);
    return cToTemp(tempToC(value, fT), tT);
  }

  const cats = category ? [category] : categoryList().filter(c => c !== 'temperature');

  // 双方在同一类别里出现 → 该类别就是答案
  let chosen = null;
  for (const cat of cats) {
    if (!CATEGORIES[cat]) continue;
    const a = findUnitIn(cat, f);
    const b = findUnitIn(cat, t);
    if (a && b) { chosen = { cat, a, b }; break; }
  }
  // 只有一方命中 → 另一方的分类可以确定
  if (!chosen) {
    for (const cat of cats) {
      if (!CATEGORIES[cat]) continue;
      const a = findUnitIn(cat, f);
      const b = findUnitIn(cat, t);
      if (a || b) { chosen = { cat, a, b }; break; }
    }
  }
  if (!chosen) {
    const where = category ? `类别 "${category}" 中` : '已知单位表里';
    throw new Error(`无法识别单位对 "${f}" → "${t}"（${where}找不到）。用 calc_convert(list=true) 查看可用单位。`);
  }
  const { cat, a, b } = chosen;
  if (!a) throw new Error(`"${f}" 不在 ${cat} 类别中。该类别可用: ${Object.keys(CATEGORIES[cat].units).slice(0, 40).join(', ')}...`);
  if (!b) throw new Error(`"${t}" 不在 ${cat} 类别中。该类别可用: ${Object.keys(CATEGORIES[cat].units).slice(0, 40).join(', ')}...`);

  return value * a.factor / b.factor;
}

function run(args = {}) {
  // 列单位
  if (args.list) {
    const cat = args.category ? resolveCategory(args.category) : null;
    const out = ['## 可用单位', ''];
    const cats = cat ? [cat] : categoryList();
    for (const c of cats) {
      if (c === 'temperature') {
        out.push(`### temperature 温度`);
        out.push('c(°C), f(°F), k(K), r(°R)');
        out.push('');
        continue;
      }
      const u = CATEGORIES[c];
      out.push(`### ${c} ${categoryLabel(c)}（基准: ${u.base}）`);
      out.push(Object.keys(u.units).join(', '));
      out.push('');
    }
    out.push('> 用法: calc_convert(value=1, from="km", to="mi")');
    return out.join('\n');
  }

  const value = args.value != null ? num(args.value, 'value') : null;
  const from = args.from != null ? String(args.from) : null;
  const to = args.to != null ? String(args.to) : null;

  if (value == null || !from || !to) {
    return '用法: calc_convert(value=100, from="km/h", to="m/s")\n\n'
      + '更多：\n'
      + '  calc_convert(value=1, from="GB", to="MB")\n'
      + '  calc_convert(value=37, from="c", to="f")     温度用 c/f/k/r\n'
      + '  calc_convert(list=true)                        列出全部单位\n'
      + '  calc_convert(list=true, category="length")     只看某一类\n';
  }

  const category = args.category ? resolveCategory(args.category) : null;
  if (args.category && !category) {
    return `未知类别 "${args.category}"。可用: ${categoryList().join(', ')}`;
  }

  const out = [];
  out.push('## calc_convert');
  out.push('');

  let result;
  try {
    result = convertUnit(value, from, to, category);
  } catch (e) {
    out.push('**错误**: ' + e.message);
    return out.join('\n');
  }

  const { text, extra } = formatValue(result, { precision: args.precision || 12 });
  // 温度的显示带单位符号
  const isTemp = category === 'temperature' || (TEMP_UNITS[from.toLowerCase()] && TEMP_UNITS[to.toLowerCase()]);
  const fromLabel = isTemp ? (TEMP_LABEL[TEMP_UNITS[from.toLowerCase()]] || from) : from;
  const toLabel = isTemp ? (TEMP_LABEL[TEMP_UNITS[to.toLowerCase()]] || to) : to;

  out.push(`${formatValue(value, { precision: 12 }).text} ${fromLabel}  =  **${text}** ${toLabel}${extra ? `  _(${extra})_` : ''}`);
  out.push('');
  out.push(`> ${value} ${from} → ${text} ${to}`);
  return out.join('\n');
}

function categoryLabel(c) {
  const map = {
    length: '长度', mass: '质量', area: '面积', volume: '体积', time: '时间',
    speed: '速度', data: '数据', pressure: '压强', energy: '能量', power: '功率',
    angle: '角度', frequency: '频率', temperature: '温度'
  };
  return map[c] ? '（' + map[c] + '）' : '';
}

module.exports = { run, CATEGORIES, TEMP_UNITS, convertUnit, categoryList, resolveCategory };
