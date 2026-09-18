'use strict';
/**
 * stamp_convert —— 时间戳 ↔ 日期字符串 任意互转
 *
 * 这是最常用的时间工具。核心难点是"输入到底是什么"：
 *   - 是 epoch 数字？量级是多少（秒/毫秒/微秒/纳秒）？
 *   - 是日期字符串？带时区偏移吗？还是本地墙钟？
 *   - 是"now" / "today" / "yesterday" 这类相对词吗？
 * 全部由 detectEpochUnit / parseDateTime 处理，工具层只负责编排与呈现。
 */

const T = require('../utils/time');
const fmt = require('./format');

const name = 'stamp_convert';
const title = 'Convert timestamps and dates';
const description =
  '时间格式万能转换：epoch 时间戳（自动识别秒/毫秒/微秒/纳秒）与日期字符串互转，支持多时区、' +
  '多种输出格式（ISO 8601 / 自定义 pattern / 各量级 epoch / HTTP 日期 / 相对时间），' +
  '以及 now、today、yesterday、tomorrow、+3d、-2h 这类相对表达。' +
  '不知道输入该填哪里时，直接把值丢给 value 即可，工具会自动判断类型。' +
  '需批量转换时把多个值放进 values 数组，一次返回多行。';

const inputSchema = {
  type: 'object',
  properties: {
    value: {
      type: ['string', 'number'],
      description:
        '要转换的值。可以是 epoch 数字（秒/毫秒/微秒/纳秒自动识别）、' +
        '日期字符串（2026-09-18、2026-09-18T14:30:00Z、2026/09/18 14:30、20260918、20260918143000、' +
        '2026-09-18T14:30:00+08:00），或相对表达（now / today / yesterday / tomorrow / +3d / -2h）。'
    },
    values: {
      type: 'array',
      description: '批量转换：一次传入多个值，逐个返回结果。与 value 二选一。',
      items: { type: ['string', 'number'] }
    },
    zone: {
      type: 'string',
      description: '解释与输出所用的 IANA 时区。默认 Asia/Shanghai。' +
        '注意：若输入字符串自带偏移（如 +08:00 或 Z），则偏移优先，zone 仅决定输出呈现。',
      default: 'Asia/Shanghai'
    },
    to: {
      type: 'string',
      description:
        '期望输出格式。默认 "iso"。可选：' +
        'iso（2026-09-18T14:30:00+08:00）、' +
        'local（2026-09-18 14:30:00）、' +
        'date（2026-09-18）、' +
        'epoch-s / epoch-ms / epoch-us / epoch-ns（数字时间戳）、' +
        'rfc（RFC 2822，HTTP/SMTP 用）、' +
        'utc（UTC 下的 ISO）、' +
        'relative（如「3 天前」）、' +
        '或任意自定义 pattern（YYYY MM DD HH mm ss SSS Z ZZ）。',
      default: 'iso'
    },
    outZone: {
      type: 'string',
      description: '仅输出用的时区（与解释输入的 zone 分开）。省略时同 zone。'
    },
    all: {
      type: 'boolean',
      description: '是否一次性列出所有常用格式（覆盖 to），默认 false',
      default: false
    }
  },
  additionalProperties: false
};

/* ============================ 解析输入 ============================ */

const RELATIVE_RE = /^(now|today|yesterday|tomorrow|now[+-].*|today[+-].*)$/i;

/**
 * 解析一个值 → { utc, kind, detail }
 * kind: 'epoch' | 'relative' | 'datetime'
 */
function parseOne(raw, zone) {
  if (typeof raw === 'number') {
    const unit = T.detectEpochUnit(raw);
    return { utc: T.normalizeEpoch(raw), kind: 'epoch', detail: unit };
  }

  const s = String(raw).trim();
  if (!s) throw new Error('空值无法转换');

  /* 纯数字字符串的歧义：既可能是 epoch，也可能是紧凑日期。
     用位数消歧（约定俗成的量级）：
       8 位  → YYYYMMDD       （20260918），按紧凑日期
       14 位 → YYYYMMDDHHmmss （20260918143000），按紧凑日期
       10 位 → epoch 秒；13 位 → epoch 毫秒；16 位 → 微秒；19 位 → 纳秒
     其余位数仍按 epoch 量级自动判断。 */
  if (/^-?\d+$/.test(s)) {
    const digitCount = s.replace('-', '').length;
    const isCompactDate = !s.startsWith('-') && (digitCount === 8 || digitCount === 14);
    if (!isCompactDate) {
      const n = Number(s);
      const unit = T.detectEpochUnit(n);
      return { utc: T.normalizeEpoch(n), kind: 'epoch', detail: unit };
    }
    const parsed = T.parseDateTime(s, zone);
    return {
      utc: parsed.utc,
      kind: 'datetime',
      detail: digitCount === 8 ? `紧凑日期 YYYYMMDD（按 ${zone} 解释）` : `紧凑日期 YYYYMMDDHHmmss（按 ${zone} 解释）`,
      hadTime: parsed.hadTime
    };
  }

  // 带小数点的纯数字仍是 epoch
  if (/^-?\d+\.\d+$/.test(s)) {
    const n = Number(s);
    const unit = T.detectEpochUnit(n);
    return { utc: T.normalizeEpoch(n), kind: 'epoch', detail: unit };
  }

  // 相对表达
  const lower = s.toLowerCase();
  if (lower === 'now' || lower === 'today' || lower === 'yesterday' || lower === 'tomorrow') {
    const now = Date.now();
    if (lower === 'now') return { utc: now, kind: 'relative', detail: 'now' };
    const w = T.wallClockOf(now, zone);
    const delta = lower === 'today' ? 0 : (lower === 'yesterday' ? -1 : 1);
    const base = new Date(Date.UTC(w.y, w.mo - 1, w.d));
    base.setUTCDate(base.getUTCDate() + delta);
    const utc = T.wallClockToUtc(
      base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 0, 0, 0, zone
    );
    return { utc, kind: 'relative', detail: lower };
  }

  // now+3d / today-2h 之类
  const relMatch = s.match(/^(now|today|yesterday|tomorrow)\s*([+-])\s*(.+)$/i);
  if (relMatch) {
    const base = parseOne(relMatch[1], zone);
    const sign = relMatch[2] === '-' ? -1 : 1;
    const durMs = T.parseDuration(relMatch[3]);
    return {
      utc: base.utc + sign * durMs,
      kind: 'relative',
      detail: `${relMatch[1]}${relMatch[2]}${relMatch[3]}`
    };
  }

  const parsed = T.parseDateTime(s, zone);
  if (parsed.utc === null || !isFinite(parsed.utc)) {
    throw new Error(`无法解析的时间: "${s}"`);
  }
  return {
    utc: parsed.utc,
    kind: 'datetime',
    detail: parsed.hadOffset ? '自带时区偏移' : `按 ${zone} 解释`,
    hadTime: parsed.hadTime
  };
}

/* ============================ 输出格式化 ============================ */

function formatOutput(utc, to, zone) {
  switch (to) {
    case 'iso': return T.toIsoInZone(utc, zone);
    case 'utc': return new Date(utc).toISOString();
    case 'local': return T.formatInZone(utc, zone, 'YYYY-MM-DD HH:mm:ss');
    case 'date': return T.formatInZone(utc, zone, 'YYYY-MM-DD');
    case 'time': return T.formatInZone(utc, zone, 'HH:mm:ss');
    case 'epoch-s': return String(Math.floor(utc / 1000));
    case 'epoch-ms': return String(Math.floor(utc));
    case 'epoch-us': return String(Math.floor(utc) * 1000);
    case 'epoch-ns': return String(Math.floor(utc) * 1000000);
    case 'rfc': return toRfc2822(utc, zone);
    case 'relative': return humanizeRelative(utc);
    default:
      // 当作自定义 pattern
      return T.formatInZone(utc, zone, to);
  }
}

/** RFC 2822（"Fri, 18 Sep 2026 14:30:00 +0800"） */
const RFC_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function toRfc2822(utc, zone) {
  const w = T.wallClockOf(utc, zone);
  const dow = RFC_DOW[w.weekday % 7];
  return `${dow}, ${T.pad(w.d)} ${RFC_MON[w.mo - 1]} ${w.y} ` +
    `${T.pad(w.h)}:${T.pad(w.mi)}:${T.pad(w.s)} ${w.offset.replace(':', '')}`;
}

/** 相对当前时间的中文描述 */
function humanizeRelative(utc) {
  const diff = utc - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  const human = T.humanizeDuration(abs, { maxUnits: 2 });
  if (abs < 2000) return '就在刚才';
  return past ? human + '前' : human + '后';
}

/* ============================ 主逻辑 ============================ */

async function run(args = {}) {
  const zone = args.zone || 'Asia/Shanghai';
  if (!T.isValidTimeZone(zone)) {
    throw new Error(`无效的时区名 "${zone}"。请用 IANA 时区名，如 Asia/Shanghai / UTC。`);
  }
  const outZone = args.outZone || zone;
  if (!T.isValidTimeZone(outZone)) {
    throw new Error(`无效的输出时区名 "${outZone}"。`);
  }

  let list;
  if (Array.isArray(args.values) && args.values.length) {
    list = args.values;
  } else if (args.value !== undefined && args.value !== null) {
    list = [args.value];
  } else {
    throw new Error('请提供 value（单个值）或 values（数组）之一。');
  }

  if (list.length > 200) {
    throw new Error(`一次最多转换 200 个值，收到 ${list.length} 个。请分批调用。`);
  }

  const rows = [];
  const results = [];
  for (const raw of list) {
    let info;
    try {
      info = parseOne(raw, zone);
    } catch (e) {
      rows.push([String(raw), '❌ ' + e.message, '', '', '']);
      results.push({ input: raw, ok: false, error: e.message });
      continue;
    }
    const w = T.wallClockOf(info.utc, outZone);
    rows.push([
      String(raw).slice(0, 40),
      T.formatInZone(info.utc, outZone),
      T.weekdayLabel(w.weekday),
      info.kind + (info.detail ? '（' + info.detail + '）' : ''),
      new Date(info.utc).toISOString()
    ]);
    results.push({
      input: typeof raw === 'string' ? raw : raw,
      ok: true,
      kind: info.kind,
      detail: info.detail,
      utc: info.utc,
      iso: T.toIsoInZone(info.utc, outZone),
      isoUtc: new Date(info.utc).toISOString(),
      local: T.formatInZone(info.utc, outZone),
      zone: outZone,
      weekday: w.weekday,
      weekdayName: T.weekdayLabel(w.weekday),
      epoch: {
        seconds: Math.floor(info.utc / 1000),
        milliseconds: Math.floor(info.utc),
        microseconds: Math.floor(info.utc) * 1000,
        nanoseconds: Math.floor(info.utc) * 1000000
      }
    });
  }

  const single = results.length === 1 && results[0].ok;
  const to = args.all ? 'all' : (args.to || 'iso');

  /* ---------- 单值 + all：把所有格式列出来 ---------- */
  if (single && args.all) {
    const utc = results[0].utc;
    const w = T.wallClockOf(utc, outZone);
    const allRows = [
      ['ISO 8601（带偏移）', formatOutput(utc, 'iso', outZone)],
      ['ISO 8601（UTC / Z）', formatOutput(utc, 'utc', outZone)],
      ['本地日期时间', formatOutput(utc, 'local', outZone)],
      ['仅日期', formatOutput(utc, 'date', outZone)],
      ['仅时间', formatOutput(utc, 'time', outZone)],
      ['RFC 2822（HTTP/SMTP）', formatOutput(utc, 'rfc', outZone)],
      ['epoch 秒', formatOutput(utc, 'epoch-s', outZone)],
      ['epoch 毫秒', formatOutput(utc, 'epoch-ms', outZone)],
      ['epoch 微秒', formatOutput(utc, 'epoch-us', outZone)],
      ['epoch 纳秒', formatOutput(utc, 'epoch-ns', outZone)],
      ['相对现在', formatOutput(utc, 'relative', outZone)],
      ['星期', T.weekdayLabel(w.weekday)],
      ['UTC 偏移', w.offset + (w.dst ? '（夏令时）' : '')]
    ];
    let text = `输入：${String(list[0])}`;
    text += `\n识别为：${results[0].kind}${results[0].detail ? '（' + results[0].detail + '）' : ''}`;
    text += `\n输出时区：${outZone}`;
    text += fmt.section('全部格式');
    text += '\n' + fmt.table(['格式', '值'], allRows, { colMax: 52 });
    return { ok: true, input: list[0], ...results[0], formats: allRows.map(r => ({ name: r[0], value: r[1] })), _text: text };
  }

  /* ---------- 单值 ---------- */
  if (single) {
    const r = results[0];
    const out = formatOutput(r.utc, to, outZone);
    const w = T.wallClockOf(r.utc, outZone);
    const pairs = [
      ['输入', String(list[0])],
      ['识别为', r.kind + (r.detail ? '（' + r.detail + '）' : '')],
      ['结果（' + to + '）', out],
      ['本地时间', r.local],
      ['星期', r.weekdayName],
      ['UTC 偏移', w.offset + (w.dst ? '（夏令时）' : '')],
      ['ISO 8601', r.iso],
      ['UTC', r.isoUtc],
      ['epoch 秒', String(r.epoch.seconds)],
      ['epoch 毫秒', String(r.epoch.milliseconds)]
    ];
    let text = `输入：${String(list[0])}`;
    text += `\n识别为：${r.kind}${r.detail ? '（' + r.detail + '）' : ''}`;
    text += `\n输出时区：${outZone}`;
    text += fmt.section('转换结果');
    text += '\n' + fmt.kv(pairs);
    return { ok: true, input: list[0], ...r, output: out, _text: text };
  }

  /* ---------- 批量 ---------- */
  let text = `共 ${list.length} 个值，输出时区 ${outZone}，目标格式 ${to}`;
  text += fmt.section('转换结果');
  text += '\n' + fmt.table(
    ['输入', '本地时间', '星期', '识别', 'UTC ISO'],
    rows, { colMax: 40 }
  );
  const failed = results.filter(r => !r.ok).length;
  if (failed) text += `\n\n⚠️ 其中 ${failed} 个值解析失败，见上表 ❌ 行。`;
  return { ok: failed === 0, count: list.length, failed, results, _text: text };
}

module.exports = { name, title, description, inputSchema, run };
