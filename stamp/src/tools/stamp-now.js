'use strict';
/**
 * stamp_now —— 当前时间（一次看多个时区）+ 时间戳全景
 *
 * 为什么需要它：
 *   Agent 的"现在"经常是错的（训练数据里的年份、缓存里的时间、系统时区混淆）。
 *   任何涉及"今天/本周/还剩几天"的任务，第一步都该先问一下真实时间。
 *
 * 一次调用同时给出：
 *   - 各时区的墙钟时间（含星期、UTC 偏移、是否处于夏令时）
 *   - 同一时刻的 epoch（秒/毫秒/微秒/纳秒）与 ISO 8601（含偏移）
 *   - 当天/本周/本月/本年的边界时刻（便于做区间统计）
 */

const T = require('../utils/time');
const logger = require('../utils/logger');
const fmt = require('./format');

const name = 'stamp_now';
const title = 'Current time across time zones';
const description =
  '获取当前真实时间：多个时区的墙钟时间（含星期与 UTC 偏移）、epoch 时间戳（秒/毫秒/微秒/纳秒）、' +
  'ISO 8601 字符串，以及今天/本周/本月/本年的起止时刻。' +
  '凡是涉及「现在」「今天」「本周」「还剩几天」「是否已过期」的任务，先调用它校准时间，' +
  '不要依赖模型自身对当前时间的记忆。' +
  '默认返回 Asia/Shanghai 与 UTC；可用 timeZones 指定任意 IANA 时区列表。';

const inputSchema = {
  type: 'object',
  properties: {
    timeZones: {
      type: 'array',
      items: { type: 'string' },
      description: '要查询的 IANA 时区名列表，如 ["Asia/Shanghai","America/New_York","UTC"]。默认 ["Asia/Shanghai","UTC"]'
    },
    zone: {
      type: 'string',
      description: '单一主时区（等价于把 timeZones 传成 [zone]，且用它计算当天/本周/本月边界）。默认 Asia/Shanghai'
    },
    weekdayStart: {
      type: 'integer',
      enum: [1, 7],
      description: '每周第一天：1=周一（ISO，默认），7=周日',
      default: 1
    },
    includeEpochUnits: {
      type: 'boolean',
      description: '是否给出秒/毫秒/微秒/纳秒四种量级的 epoch，默认 true',
      default: true
    }
  },
  additionalProperties: false
};

/** 把 epoch 毫秒展开成各量级 */
function epochUnits(utcMs) {
  const sec = Math.floor(utcMs / 1000);
  return {
    seconds: sec,
    milliseconds: Math.floor(utcMs),
    microseconds: Math.floor(utcMs) * 1000,
    nanoseconds: Math.floor(utcMs) * 1000000
  };
}

/** 计算某时区下 今天/本周/本月/今年 的墙钟边界，返回 {label: {fromUtc, toUtc, text}} */
function periodBounds(utcMs, timeZone, weekdayStart) {
  const w = T.wallClockOf(utcMs, timeZone);
  const mk = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => {
    const u = T.wallClockToUtc(y, mo, d, h, mi, s, timeZone);
    // DST 空洞时顺延到当天第一个存在的时刻
    if (u !== null) return u + ms;
    for (let hh = h + 1; hh <= 23; hh++) {
      const alt = T.wallClockToUtc(y, mo, d, hh, mi, s, timeZone);
      if (alt !== null) return alt + ms;
    }
    return null;
  };

  const out = {};

  // 今天
  out.today = {
    from: mk(w.y, w.mo, w.d),
    to: mk(w.y, w.mo, w.d, 23, 59, 59, 999)
  };

  // 本周：以 ISO 星期（1=周一..7=周日）为基准回退
  const back = weekdayStart === 7 ? (w.weekday % 7) : (w.weekday - 1);
  const startDate = new Date(Date.UTC(w.y, w.mo - 1, w.d));
  startDate.setUTCDate(startDate.getUTCDate() - back);
  const sy = startDate.getUTCFullYear(), smo = startDate.getUTCMonth() + 1, sd = startDate.getUTCDate();
  const endDate = new Date(Date.UTC(sy, smo - 1, sd));
  endDate.setUTCDate(endDate.getUTCDate() + 6);
  out.week = {
    from: mk(sy, smo, sd),
    to: mk(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate(), 23, 59, 59, 999)
  };

  // 本月
  const dim = T.daysInMonth(w.y, w.mo);
  out.month = {
    from: mk(w.y, w.mo, 1),
    to: mk(w.y, w.mo, dim, 23, 59, 59, 999)
  };

  // 今年
  out.year = {
    from: mk(w.y, 1, 1),
    to: mk(w.y, 12, 31, 23, 59, 59, 999)
  };

  return out;
}

async function run(args = {}) {
  const primaryZone = args.zone || 'Asia/Shanghai';
  let zones = Array.isArray(args.timeZones) && args.timeZones.length
    ? args.timeZones.slice()
    : [primaryZone, 'UTC'];

  // 去重但保序
  zones = zones.filter((z, i) => zones.indexOf(z) === i);

  for (const z of zones) {
    if (!T.isValidTimeZone(z)) {
      throw new Error(
        `无效的时区名 "${z}"。请使用 IANA 时区名，如 Asia/Shanghai / America/New_York / Europe/London / UTC。`
      );
    }
  }
  if (!T.isValidTimeZone(primaryZone)) {
    throw new Error(`无效的主时区名 "${primaryZone}"。`);
  }

  const now = Date.now();
  const weekdayStart = args.weekdayStart === 7 ? 7 : 1;
  const withUnits = args.includeEpochUnits !== false;

  /* ---------- 各时区墙钟 ---------- */
  const rows = [];
  const zoneDetails = [];
  for (const z of zones) {
    const w = T.wallClockOf(now, z);
    rows.push([
      z,
      T.formatInZone(now, z),
      T.weekdayLabel(w.weekday),
      T.formatOffset(w.offsetMs),
      w.dst ? '是（DST）' : '否'
    ]);
    zoneDetails.push({
      timeZone: z,
      localTime: T.formatInZone(now, z),
      iso: T.toIsoInZone(now, z),
      weekday: w.weekday,
      weekdayName: T.weekdayLabel(w.weekday),
      utcOffset: T.formatOffset(w.offsetMs),
      utcOffsetMinutes: Math.round(w.offsetMs / 60000),
      wallClock: { year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s }
    });
  }

  /* ---------- 主时区的当天/本周/本月/今年 ---------- */
  const bounds = periodBounds(now, primaryZone, weekdayStart);
  const boundRows = [];
  const boundsStructured = {};
  for (const [k, label] of [['today', '今天'], ['week', '本周'], ['month', '本月'], ['year', '今年']]) {
    const b = bounds[k];
    if (!b || b.from === null) continue;
    const leftMs = b.to - now;
    const elapsed = now - b.from;
    const spanMs = b.to - b.from + 1;
    boundRows.push([
      label,
      T.formatInZone(b.from, primaryZone),
      T.formatInZone(b.to, primaryZone),
      Math.round(elapsed / 1000) + 's',
      Math.round(leftMs / 1000) + 's',
      (elapsed / spanMs * 100).toFixed(1) + '%'
    ]);
    boundsStructured[k] = {
      from: b.from,
      to: b.to,
      fromIso: T.toIsoInZone(b.from, primaryZone),
      toIso: T.toIsoInZone(b.to, primaryZone),
      fromLocal: T.formatInZone(b.from, primaryZone),
      toLocal: T.formatInZone(b.to, primaryZone)
    };
  }

  const units = epochUnits(now);
  const wPrimary = T.wallClockOf(now, primaryZone);

  /* ---------- 组装文本 ---------- */
  let text = '';
  text += `现在（${primaryZone}）：${T.formatInZone(now, primaryZone)} ${T.weekdayLabel(wPrimary.weekday)}`;
  text += `\nUTC 基准：${new Date(now).toISOString()}`;
  text += `\nepoch：${units.seconds} 秒 / ${units.milliseconds} 毫秒`;

  text += fmt.section('各时区');
  text += '\n' + fmt.table(['时区', '墙钟时间', '星期', 'UTC 偏移', '夏令时'], rows, { colMax: 34 });

  text += fmt.section(`区间边界（${primaryZone}）`);
  text += '\n' + fmt.table(
    ['区间', '开始', '结束', '已过', '剩余', '进度'],
    boundRows, { colMax: 30 }
  );

  if (withUnits) {
    text += fmt.section('时间戳换算');
    text += '\n' + fmt.table(
      ['量级', '数值', '说明'],
      [
        ['秒', units.seconds, '10 位，Unix 标准（most APIs）'],
        ['毫秒', units.milliseconds, '13 位，JavaScript / Java'],
        ['微秒', units.microseconds, '16 位，Python / PostgreSQL'],
        ['纳秒', units.nanoseconds, '19 位，Go / 高精度计时']
      ],
      { colMax: 40 }
    );
  }

  text += `\n\n下一步：stamp_convert( 传入时间戳或日期字符串 ) 做任意格式互转；`;
  text += `stamp_zone( from=?, to=? ) 做时区换算；`;
  text += `stamp_workday( ) 算工作日。`;

  return {
    now,
    timeZone: primaryZone,
    iso: T.toIsoInZone(now, primaryZone),
    isoUtc: new Date(now).toISOString(),
    weekday: wPrimary.weekday,
    weekdayName: T.weekdayLabel(wPrimary.weekday),
    localTime: T.formatInZone(now, primaryZone),
    epoch: withUnits ? units : { seconds: units.seconds, milliseconds: units.milliseconds },
    timeZones: zoneDetails,
    bounds: boundsStructured,
    _text: text
  };
}

module.exports = { name, title, description, inputSchema, run };
