'use strict';
/**
 * stamp_duration —— 时长解析与换算
 *
 * 场景：Agent 经常要处理 "2h30m"、"1.5 天"、"90 分钟" 这类东西，
 * 也要把 5400 秒反过来说成人话。这个工具把两个方向都打开，
 * 并且明确区分「时长」与「时刻」——时长是纯量，不随时区/夏令时变化。
 */

const T = require('../utils/time');
const fmt = require('./format');

const name = 'stamp_duration';
const title = 'Parse and convert durations';
const description =
  '解析与换算时长：支持 1h30m、90s、2d、1w2d3h、1.5h、1天2小时、30分钟、1 分 30 秒 等写法，' +
  '一次给出毫秒/秒/分钟/小时/天/周，以及人类可读形式。' +
  '也可以给定两个时间点，算出它们之间的间隔（正向/反向都行）。' +
  '注意：时长是纯量，与时区、夏令时无关。' +
  '常与 stamp_convert 配合：stamp_convert 得到时刻，stamp_duration 得到间隔。';

const inputSchema = {
  type: 'object',
  properties: {
    value: {
      type: ['string', 'number'],
      description:
        '要解析的时长。字符串如 "1h30m" / "90s" / "2d" / "1w2d3h" / "1.5h" / "1天2小时" / "30分钟"；' +
        '纯数字默认按秒解释（可用 defaultUnit 改变）。'
    },
    defaultUnit: {
      type: 'string',
      enum: ['ms', 's', 'm', 'h', 'd', 'w'],
      description: '当 value 是纯数字时的单位，默认 s（秒）',
      default: 's'
    },
    values: {
      type: 'array',
      description: '批量解析多个时长，逐个返回。与 value 二选一。',
      items: { type: ['string', 'number'] }
    },
    from: {
      type: ['string', 'number'],
      description: '间隔计算的起点时刻（时间戳或日期字符串）。与 to 搭配使用。'
    },
    to: {
      type: ['string', 'number'],
      description: '间隔计算的终点时刻（时间戳或日期字符串）。'
    },
    zone: {
      type: 'string',
      description: '解析 from / to 字符串时使用的时区，默认 Asia/Shanghai',
      default: 'Asia/Shanghai'
    },
    unit: {
      type: 'string',
      enum: ['ms', 's', 'm', 'h', 'd', 'w', 'auto', 'all'],
      description:
        '把时长换算成指定单位后返回（便于直接拿去算数）。' +
        'auto（默认）= 自动选最合适的单位；all = 列出全部单位。',
      default: 'auto'
    }
  },
  additionalProperties: false
};

/* ============================ 换算 ============================ */

const UNIT_NAME = {
  ms: '毫秒', s: '秒', m: '分钟', h: '小时', d: '天', w: '周'
};

/** 选择最适合的展示单位（不产生小数优先） */
function pickUnit(ms) {
  const abs = Math.abs(ms);
  const table = [
    ['w', T.MS.w], ['d', T.MS.d], ['h', T.MS.h], ['m', T.MS.m], ['s', T.MS.s], ['ms', 1]
  ];
  for (const [u, factor] of table) {
    if (abs >= factor) return u;
  }
  return 'ms';
}

/** 换算成某单位的数值（保留合理精度） */
function toUnit(ms, unit) {
  const factor = unit === 'ms' ? 1 : T.MS[unit];
  const v = ms / factor;
  // 避免浮点噪声：最多 6 位有效小数，再裁掉尾随 0
  return Number(v.toFixed(6));
}

/** 各单位的完整换算表 */
function allUnits(ms) {
  return [
    ['毫秒', ms, 'ms'],
    ['秒', toUnit(ms, 's'), 's'],
    ['分钟', toUnit(ms, 'm'), 'm'],
    ['小时', toUnit(ms, 'h'), 'h'],
    ['天', toUnit(ms, 'd'), 'd'],
    ['周', toUnit(ms, 'w'), 'w']
  ];
}

/* ============================ 主逻辑 ============================ */

/** 解析 from/to 的一个时间点 */
function parseMoment(v, zone) {
  if (typeof v === 'number') return T.normalizeEpoch(v);
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) {
    const digits = s.replace('-', '').length;
    if (digits !== 8 && digits !== 14) return T.normalizeEpoch(Number(s));
  }
  const p = T.parseDateTime(s, zone);
  return p.utc;
}

async function run(args = {}) {
  const zone = args.zone || 'Asia/Shanghai';
  if (!T.isValidTimeZone(zone)) {
    throw new Error(`无效的时区名 "${zone}"。`);
  }

  /* ---------- 模式 A：区间间隔 ---------- */
  if (args.from !== undefined && args.from !== null &&
      args.to !== undefined && args.to !== null) {
    const a = parseMoment(args.from, zone);
    const b = parseMoment(args.to, zone);
    const diff = b - a;

    const rows = allUnits(diff).map(([label, val]) => [label, val]);

    let text = `从 ${T.formatInZone(a, zone)} 到 ${T.formatInZone(b, zone)}`;
    text += `\n间隔：${T.humanizeDuration(Math.abs(diff))}`;
    text += `\n符号：${diff >= 0 ? '正（to 晚于 from）' : '负（to 早于 from）'}`;
    text += fmt.section('各单位');
    text += '\n' + fmt.table(['单位', '数值'], rows, { colMax: 30 });

    return {
      mode: 'interval',
      from: a,
      to: b,
      fromLocal: T.formatInZone(a, zone),
      toLocal: T.formatInZone(b, zone),
      deltaMs: diff,
      absoluteMs: Math.abs(diff),
      human: T.humanizeDuration(Math.abs(diff)),
      units: Object.fromEntries(allUnits(diff).map(([l, v, k]) => [k, v])),
      _text: text
    };
  }

  /* ---------- 模式 B：时长解析 ---------- */
  let list;
  if (Array.isArray(args.values) && args.values.length) {
    list = args.values;
  } else if (args.value !== undefined && args.value !== null) {
    list = [args.value];
  } else {
    throw new Error(
      '请提供 value（单个时长）或 values（数组），或同时提供 from 与 to 计算间隔。\n' +
      '例：{"value":"1h30m"} / {"values":["90s","2d"]} / {"from":"2026-09-18","to":"2026-09-25"}'
    );
  }

  const defaultUnit = args.defaultUnit || 's';
  if (!T.MS[defaultUnit]) {
    throw new Error(`defaultUnit 只能是 ms/s/m/h/d/w 之一，收到 "${defaultUnit}"。`);
  }

  const rows = [];
  const results = [];

  for (const raw of list) {
    let ms;
    try {
      if (typeof raw === 'number') {
        ms = raw * (T.MS[defaultUnit] || 1000);
      } else {
        const s = String(raw).trim();
        if (/^-?\d+(\.\d+)?$/.test(s)) {
          ms = Number(s) * (T.MS[defaultUnit] || 1000);
        } else {
          ms = T.parseDuration(s, defaultUnit);
        }
      }
    } catch (e) {
      rows.push([String(raw), '❌ ' + e.message, '', '', '']);
      results.push({ input: raw, ok: false, error: e.message });
      continue;
    }

    const human = T.humanizeDuration(ms);
    rows.push([
      String(raw),
      ms,
      toUnit(ms, 's'),
      toUnit(ms, 'm'),
      human
    ]);
    results.push({
      input: raw,
      ok: true,
      ms,
      seconds: toUnit(ms, 's'),
      minutes: toUnit(ms, 'm'),
      hours: toUnit(ms, 'h'),
      days: toUnit(ms, 'd'),
      weeks: toUnit(ms, 'w'),
      human
    });
  }

  const unit = args.unit || 'auto';

  /* ---------- 单值 ---------- */
  if (results.length === 1 && results[0].ok) {
    const r = results[0];
    const chosen = unit === 'auto' ? pickUnit(r.ms) : unit;

    const infoRows = allUnits(r.ms).map(([label, val, key]) => [
      label,
      val,
      key === chosen ? '← 推荐' : ''
    ]);

    let text = `输入：${String(list[0])}`;
    text += `\n时长：${r.human}`;
    text += `\n（纯数字按 ${defaultUnit} 解释）`;
    text += fmt.section('换算');
    text += '\n' + fmt.table(['单位', '数值', '备注'], infoRows, { colMax: 30 });
    if (unit !== 'auto' && unit !== 'all') {
      text += `\n\n换算为单位 ${unit}：**${toUnit(r.ms, unit)} ${unit}**`;
    }
    return {
      ok: true,
      input: list[0],
      ms: r.ms,
      human: r.human,
      unit: unit === 'auto' ? chosen : unit,
      value: unit === 'auto' ? toUnit(r.ms, chosen) : (unit === 'all' ? null : toUnit(r.ms, unit)),
      units: { ms: r.ms, s: r.seconds, m: r.minutes, h: r.hours, d: r.days, w: r.weeks },
      _text: text
    };
  }

  /* ---------- 批量 ---------- */
  let text = `共解析 ${list.length} 个时长`;
  text += fmt.section('解析结果');
  text += '\n' + fmt.table(['输入', '毫秒', '秒', '分钟', '人类可读'], rows, { colMax: 34 });
  const failed = results.filter(r => !r.ok).length;
  if (failed) text += `\n\n⚠️ 其中 ${failed} 个解析失败，见上表 ❌ 行。`;
  return { ok: failed === 0, count: list.length, failed, results, _text: text };
}

module.exports = { name, title, description, inputSchema, run };
