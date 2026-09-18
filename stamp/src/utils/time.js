'use strict';
/**
 * Stamp 核心时间引擎（零依赖，只用 Node 原生 Date/Intl）
 *
 * 设计原则：
 *  1. **不用 Date 做时区运算**。Date 只有「本地时区」和「UTC」两种视角，
 *     表达不了"东京现在几点"。时区相关运算一律走 Intl.DateTimeFormat 取偏移，
 *     再手工做墙钟↔UTC 换算。
 *  2. **墙钟时间与绝对时刻严格区分**。前者是"2026-03-08 02:30 这个钟面读数"，
 *     后者是"某一瞬间"。DST 跳跃会让两者不是一一对应。
 *  3. **所有解析失败都抛带中文说明的 Error**，由工具层转成可读提示。
 */

/* ============================ 常量 ============================ */

const MS = { ms: 1, s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000, w: 7 * 86400 * 1000 };

/** 星期名 → ISO 序号（1=周一 … 7=周日） */
const WEEKDAY_NAMES = {
  mon: 1, monday: 1, '周一': 1, '星期一': 1,
  tue: 2, tues: 2, tuesday: 2, '周二': 2, '星期二': 2,
  wed: 3, wednesday: 3, '周三': 3, '星期三': 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, '周四': 4, '星期四': 4,
  fri: 5, friday: 5, '周五': 5, '星期五': 5,
  sat: 6, saturday: 6, '周六': 6, '星期六': 6,
  sun: 7, sunday: 7, '周日': 7, '周天': 7, '星期日': 7, '星期天': 7
};

/** JS getUTCDay() → ISO 序号（JS 周日=0，ISO 周日=7） */
function jsDayToIso(d) { return d === 0 ? 7 : d; }

/** ISO 序号 → 中文星期名（1=周一 … 7=周日）。注意这**不是**上面的 WEEKDAY_NAMES 反查表。 */
const WEEKDAY_LABELS = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };

/** ISO 序号 → 中文星期名，越界安全 */
function weekdayLabel(n) { return WEEKDAY_LABELS[n] || '—'; }

/* ============================ 时区 ============================ */

/**
 * 取某时刻在指定时区的 UTC 偏移（毫秒）。
 * 用 Intl 把该时刻"渲染"成目标时区的墙钟读数，再与真实 UTC 时刻相减。
 */
function tzOffsetMs(utcMs, timeZone) {
  if (timeZone === 'UTC' || timeZone === 'Z') return 0;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // en-US + hour12:false 在午夜可能给出 "24"，需要归一
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asIfUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +hour, +parts.minute, +parts.second
  );
  // asIfUtc 与 utcMs 的差 = 该时区相对 UTC 的偏移（已含 DST）
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/** 校验时区名是否被运行环境支持 */
function isValidTimeZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

/** 列出本机 Intl 支持的时区（去重排序） */
function listTimeZones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone');
    }
  } catch (e) { /* 老版本 Node 走下面兜底 */ }
  // 兜底：从几个常见时区派生，同时尽量用 Intl 里能探到的
  const common = [
    'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
    'Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'Europe/Paris',
    'Europe/Moscow', 'America/New_York', 'America/Chicago',
    'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
    'Australia/Sydney', 'Pacific/Auckland'
  ];
  return common.filter(isValidTimeZone);
}

/** 时区偏移转 "+08:00" 形式 */
function formatOffset(ms) {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  return sign + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/* ============================ 墙钟 ↔ UTC ============================ */

/**
 * 把"某时区的墙钟读数"换算成绝对时刻（UTC 毫秒）。
 *
 * DST 的两种坏情况：
 *  - **不存在的时刻**（春季跳表，如 02:30 被跳过）→ 返回 null，调用方决定怎么办
 *  - **重复的时刻**（秋季回拨，如 01:30 出现两次）→ 取更早的一次（标准做法）
 *
 * 做法：先按"当作 UTC"猜一个时刻，用它的偏移校正，再迭代一次收敛
 * （单次校正已足够，因为偏移只取决于时刻所在的 DST 区间，迭代一次即稳定）。
 */
function wallClockToUtc(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (timeZone === 'UTC' || timeZone === 'Z') return guess;

  let off = tzOffsetMs(guess, timeZone);
  let utc = guess - off;
  // 用校正后的时刻再取一次偏移，处理跨 DST 边界的情况
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off) {
    utc = guess - off2;
    off = off2;
  }
  // 校验：该时刻渲染回墙钟，是否真的等于输入（不等说明落在 DST 空洞里）
  const back = wallClockOf(utc, timeZone);
  if (back.y !== y || back.mo !== mo || back.d !== d ||
      back.h !== h || back.mi !== mi || back.s !== s) {
    return null; // 不存在的墙钟时刻
  }
  return utc;
}

/**
 * 某绝对时刻在指定时区的墙钟读数。
 *
 * dst 的判定：取该年 1 月与 7 月两个"基准时刻"的偏移，较小者视为标准时偏移；
 * 当前偏移大于标准时偏移即为夏令时。这样对南北半球都成立，
 * 对不使用 DST 的时区两个基准相同、恒为 false。
 */
function wallClockOf(utcMs, timeZone) {
  const off = tzOffsetMs(utcMs, timeZone);
  const shifted = new Date(utcMs + off);
  const y = shifted.getUTCFullYear();
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
    s: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
    weekday: jsDayToIso(shifted.getUTCDay()),
    offsetMs: off,
    offset: formatOffset(off),
    dst: isDstAt(utcMs, timeZone, y, off)
  };
}

/** 该时刻是否处于夏令时（相对于该年 1 月 / 7 月偏移中较小者） */
function isDstAt(utcMs, timeZone, year, currentOffset) {
  if (timeZone === 'UTC' || timeZone === 'Z') return false;
  let standard = null;
  for (const month of [0, 6]) {
    const probe = Date.UTC(year, month, 15, 12, 0, 0);
    const o = tzOffsetMs(probe, timeZone);
    if (standard === null || o < standard) standard = o;
  }
  if (standard === null) return false;
  return currentOffset > standard;
}

/* ============================ 格式化 ============================ */

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/**
 * 格式化为指定时区的字符串。
 * 支持的占位符：YYYY YY MM M DD D HH H mm m ss s SSS Z ZZ
 */
function formatInZone(utcMs, timeZone, pattern = 'YYYY-MM-DD HH:mm:ss') {
  const w = wallClockOf(utcMs, timeZone);
  return pattern.replace(/YYYY|YY|MM|DD|HH|mm|ss|SSS|ZZ|M|D|H|m|s|Z/g, (tok) => {
    switch (tok) {
      case 'YYYY': return String(w.y);
      case 'YY': return String(w.y).slice(-2);
      case 'MM': return pad(w.mo);
      case 'M': return String(w.mo);
      case 'DD': return pad(w.d);
      case 'D': return String(w.d);
      case 'HH': return pad(w.h);
      case 'H': return String(w.h);
      case 'mm': return pad(w.mi);
      case 'm': return String(w.mi);
      case 'ss': return pad(w.s);
      case 's': return String(w.s);
      case 'SSS': return pad(w.ms, 3);
      case 'ZZ': return w.offset.replace(':', '');
      case 'Z': return w.offset;
      default: return tok;
    }
  });
}

/** ISO 8601（含偏移） */
function toIsoInZone(utcMs, timeZone) {
  const w = wallClockOf(utcMs, timeZone);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${w.offset}`;
}

/* ============================ 解析 ============================ */

/**
 * 解析日期时间字符串 → 绝对时刻（UTC 毫秒）。
 *
 * 支持：
 *  - ISO 8601：2026-09-18 / 2026-09-18 14:30 / 2026-09-18T14:30:00Z /
 *    2026-09-18T14:30:00+08:00 / 2026-09-18T14:30:00.123
 *  - 紧凑：20260918 / 20260918143000
 *  - 斜杠：2026/9/18 14:30
 *  - 只有日期时按该时区的当天 00:00:00 解释
 *  - 带明确偏移（Z / ±HH:MM）时忽略 timeZone 参数，以偏移为准
 *
 * @returns {{utc:number, hadOffset:boolean, hadTime:boolean}}
 */
function parseDateTime(input, timeZone = 'UTC') {
  if (input instanceof Date) {
    return { utc: input.getTime(), hadOffset: true, hadTime: true };
  }
  if (typeof input === 'number') {
    return { utc: normalizeEpoch(input), hadOffset: true, hadTime: true };
  }
  const s = String(input == null ? '' : input).trim();
  if (!s) throw new Error('时间字符串为空');

  // 纯数字：先按紧凑日期时间尝试，否则交给 epoch
  if (/^\d+$/.test(s)) {
    if (s.length === 8) {
      const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
      const utc = wallClockToUtc(y, mo, d, 0, 0, 0, timeZone);
      if (utc === null) throw new Error(`日期不存在（可能是夏令时空洞）: ${s}`);
      return { utc, hadOffset: false, hadTime: false };
    }
    if (s.length === 14) {
      const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
      const h = +s.slice(8, 10), mi = +s.slice(10, 12), sec = +s.slice(12, 14);
      const utc = wallClockToUtc(y, mo, d, h, mi, sec, timeZone);
      if (utc === null) throw new Error(`时刻不存在（可能是夏令时空洞）: ${s}`);
      return { utc, hadOffset: false, hadTime: true };
    }
    return { utc: normalizeEpoch(+s), hadOffset: true, hadTime: true };
  }

  // 通用：拆出日期、时间、偏移
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    const hasTime = m[4] !== undefined;
    const h = hasTime ? +m[4] : 0;
    const mi = m[5] !== undefined ? +m[5] : 0;
    const sec = m[6] !== undefined ? +m[6] : 0;
    const msPart = m[7] !== undefined ? +(m[7] + '00').slice(0, 3) : 0;
    const offTok = m[8];

    checkDateParts(y, mo, d, h, mi, sec);

    if (offTok) {
      // 带明确偏移：直接算出 UTC，忽略 timeZone
      const offMs = (offTok.toUpperCase() === 'Z')
        ? 0
        : (() => {
          const sign = offTok[0] === '-' ? -1 : 1;
          const body = offTok.slice(1).replace(':', '');
          return sign * ((+body.slice(0, 2)) * 3600000 + (+body.slice(2, 4)) * 60000);
        })();
      return {
        utc: Date.UTC(y, mo - 1, d, h, mi, sec, msPart) - offMs,
        hadOffset: true,
        hadTime: hasTime
      };
    }

    const utc = wallClockToUtc(y, mo, d, h, mi, sec, timeZone);
    if (utc === null) {
      throw new Error(`该时刻在时区 ${timeZone} 不存在（夏令时跳表），请改时间或换时区`);
    }
    return { utc: utc + msPart, hadOffset: false, hadTime: hasTime };
  }

  // 最后兜底：交给 Date 原生解析（能处理 RFC 2822 等），但结果依赖本地时区，慎用
  const fallback = new Date(s);
  if (!isNaN(fallback.getTime())) {
    return { utc: fallback.getTime(), hadOffset: true, hadTime: true };
  }
  throw new Error(`无法解析的时间格式: ${s}`);
}

function checkDateParts(y, mo, d, h, mi, sec) {
  if (mo < 1 || mo > 12) throw new Error(`月份超出范围: ${mo}`);
  if (d < 1 || d > 31) throw new Error(`日期超出范围: ${d}`);
  if (h > 23) throw new Error(`小时超出范围: ${h}`);
  if (mi > 59) throw new Error(`分钟超出范围: ${mi}`);
  if (sec > 59) throw new Error(`秒超出范围: ${sec}`);
  // 校验真实天数（含闰年）
  const dim = daysInMonth(y, mo);
  if (d > dim) throw new Error(`${y} 年 ${mo} 月只有 ${dim} 天，不存在 ${d} 日`);
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * 归一化 epoch 输入：自动判断秒 / 毫秒 / 微秒。
 * 依据是量级——秒级时间戳在 2001~2286 年之间是 1e9~1e10。
 */
function normalizeEpoch(n) {
  if (!isFinite(n)) throw new Error('时间戳不是有效数字: ' + n);
  const neg = n < 0;
  const abs = Math.abs(n);
  let ms;
  if (abs < 1e11) ms = n * 1000;          // 秒（含 10 位）
  else if (abs < 1e14) ms = n;             // 毫秒（13 位）
  else if (abs < 1e17) ms = n / 1000;      // 微秒（16 位）
  else ms = n / 1e6;                       // 纳秒
  if (neg) ms = -Math.abs(ms);
  return Math.round(ms);
}

/** 探测输入时间戳的原始单位（用于回显，帮用户确认没搞错量级） */
function detectEpochUnit(n) {
  const abs = Math.abs(n);
  if (abs < 1e11) return 'seconds';
  if (abs < 1e14) return 'milliseconds';
  if (abs < 1e17) return 'microseconds';
  return 'nanoseconds';
}

/* ============================ 时长解析 ============================ */

/**
 * 解析人类可读时长为毫秒。
 * 支持：90 / 90s / 1h30m / 2d / 1w2d3h / "1天2小时" / 1.5h
 * 纯数字（无单位）默认按秒，与 Unix 习惯一致。
 *
 * @param {string|number} input
 * @param {string} defaultUnit - 裸数字的默认单位（'s'|'m'|'h'|'d'|'w'）
 */
function parseDuration(input, defaultUnit = 's') {
  if (typeof input === 'number') {
    if (!isFinite(input)) throw new Error('时长不是有效数字: ' + input);
    return input * (MS[defaultUnit] || MS.s);
  }
  const s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) throw new Error('时长字符串为空');

  // 纯数字
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return parseFloat(s) * (MS[defaultUnit] || MS.s);
  }

  const UNITS = [
    [/(\d+(?:\.\d+)?)\s*(?:weeks?|w|周|星期)/g, MS.w],
    [/(\d+(?:\.\d+)?)\s*(?:days?|d|天|日)/g, MS.d],
    [/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|小时|时)/g, MS.h],
    [/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m|分钟|分)/g, MS.m],
    [/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s|秒)/g, MS.s],
    [/(\d+(?:\.\d+)?)\s*(?:milliseconds?|ms|毫秒)/g, MS.ms]
  ];

  let total = 0;
  let consumed = 0;
  const sign = /^\s*-/.test(s) ? -1 : 1;
  for (const [re, unitMs] of UNITS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      total += parseFloat(m[1]) * unitMs;
      consumed += m[0].length;
    }
  }
  if (total === 0 && consumed === 0) {
    throw new Error(`无法解析的时长: ${input}（可用 90s / 1h30m / 2d / 1w2d / "1天2小时"）`);
  }
  return sign * total;
}

/** 毫秒 → 人类可读（1d 2h 3m 4s；自动省略为 0 的高位单位） */
function humanizeDuration(ms, opts = {}) {
  const maxUnits = opts.maxUnits || 4;
  const neg = ms < 0;
  let rest = Math.abs(Math.round(ms));
  const parts = [];
  const units = [
    ['w', MS.w], ['d', MS.d], ['h', MS.h], ['m', MS.m], ['s', MS.s], ['ms', MS.ms]
  ];
  for (const [label, unitMs] of units) {
    if (rest >= unitMs) {
      const v = Math.floor(rest / unitMs);
      rest -= v * unitMs;
      parts.push(v + label);
      if (parts.length >= maxUnits) break;
    }
  }
  if (parts.length === 0) parts.push('0s');
  const out = parts.join(' ');
  return neg ? '-' + out : out;
}

/* ============================ 工作日 ============================ */

/**
 * 判断某墙钟日期是否为工作日（不含节假日，节假日由 holidays 显式传入）。
 * @param {Set<string>} holidays - 'YYYY-MM-DD' 集合
 */
function isWorkday(w, holidays) {
  if (w.weekday === 6 || w.weekday === 7) return false;
  if (holidays && holidays.has(dateKey(w))) return false;
  return true;
}

function dateKey(w) {
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

/**
 * 从某时刻起推算 N 个工作日后（或前）的时刻，保持墙钟时刻不变。
 * 用 wallClockToUtc 重算，因此跨 DST 时"钟面时间"不变而绝对时长会变（符合直觉）。
 */
function addWorkdays(utcMs, days, timeZone, holidays) {
  const start = wallClockOf(utcMs, timeZone);
  let { y, mo, d } = start;
  const { h, mi, s } = start;
  const step = days >= 0 ? 1 : -1;
  let remaining = Math.abs(days);
  let guard = 0;
  while (remaining > 0) {
    if (++guard > 10000) throw new Error('工作日推算超出最大迭代次数（节假日配置过多？）');
    // 前进一天（用 UTC 日期算术避免本地时区干扰）
    const cursor = new Date(Date.UTC(y, mo - 1, d));
    cursor.setUTCDate(cursor.getUTCDate() + step);
    y = cursor.getUTCFullYear();
    mo = cursor.getUTCMonth() + 1;
    d = cursor.getUTCDate();
    const w = { y, mo, d, weekday: jsDayToIso(cursor.getUTCDay()) };
    if (isWorkday(w, holidays)) remaining--;
  }
  const utc = wallClockToUtc(y, mo, d, h, mi, s, timeZone);
  if (utc === null) {
    // 落进 DST 空洞：往后顺延到该日第一个存在的时刻
    for (let hh = h + 1; hh <= 23; hh++) {
      const alt = wallClockToUtc(y, mo, d, hh, mi, s, timeZone);
      if (alt !== null) return alt;
    }
    throw new Error('推算结果落在夏令时空洞内且无法顺延');
  }
  return utc;
}

/** 统计两个时刻之间的工作日数（不含起点，含终点） */
function countWorkdays(fromUtc, toUtc, timeZone, holidays) {
  if (toUtc <= fromUtc) return 0;
  let count = 0;
  let cursor = wallClockOf(fromUtc, timeZone);
  const endKey = dateKey(wallClockOf(toUtc, timeZone));
  let guard = 0;
  while (true) {
    if (++guard > 100000) throw new Error('工作日统计超出最大迭代次数');
    const c = new Date(Date.UTC(cursor.y, cursor.mo - 1, cursor.d));
    c.setUTCDate(c.getUTCDate() + 1);
    const w = { y: c.getUTCFullYear(), mo: c.getUTCMonth() + 1, d: c.getUTCDate(), weekday: jsDayToIso(c.getUTCDay()) };
    const key = dateKey(w);
    if (toUtc <= wallClockToUtc(w.y, w.mo, w.d, 0, 0, 0, timeZone)) {
      // 已越过终点所在的日期起点
    }
    if (key > endKey) break;
    if (isWorkday(w, holidays)) count++;
    cursor = w;
    if (key === endKey) break;
  }
  return count;
}

module.exports = {
  MS, WEEKDAY_NAMES, WEEKDAY_LABELS, weekdayLabel, jsDayToIso,
  tzOffsetMs, isValidTimeZone, listTimeZones, formatOffset,
  wallClockToUtc, wallClockOf, isDstAt,
  formatInZone, toIsoInZone, pad,
  parseDateTime, normalizeEpoch, detectEpochUnit, checkDateParts,
  daysInMonth, isLeapYear,
  parseDuration, humanizeDuration,
  isWorkday, dateKey, addWorkdays, countWorkdays
};
