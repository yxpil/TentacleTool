'use strict';
/**
 * stamp_zone —— 时区换算与偏移查询
 *
 * 与 stamp_convert 的分工：
 *   stamp_convert 负责"任意格式 ↔ 任意格式"，zone 只是解释/呈现参数；
 *   stamp_zone 专注"同一时刻在两个时区分别是什么钟面时间"，
 *   并且显式提示夏令时（DST）带来的偏移变化与由此产生的坑。
 *
 * 核心价值在于 DST 提醒：Agent 很容易把"纽约上午 9 点"当成固定偏移 -05:00，
 * 但夏季是 -04:00。这个工具会主动指出这件事。
 */

const T = require('../utils/time');
const fmt = require('./format');

const name = 'stamp_zone';
const title = 'Convert between time zones';
const description =
  '时区换算：把某时刻从一个时区换算到另一个（或一批）时区，给出各自的墙钟时间、UTC 偏移、' +
  '是否处于夏令时。也支持只查某时区在某年的偏移变化（夏令时起止）。' +
  '当心夏令时：同一个时区冬夏偏移不同（如纽约冬 -05:00、夏 -04:00），本工具会明确标出。' +
  '常见时区速查：Asia/Shanghai +08:00（无夏令时）、Asia/Tokyo +09:00、' +
  'Europe/London +00:00/+01:00、America/New_York -05:00/-04:00、America/Los_Angeles -08:00/-07:00、UTC +00:00。';

const inputSchema = {
  type: 'object',
  properties: {
    time: {
      type: ['string', 'number'],
      description:
        '要换算的时刻。时间戳（秒/毫秒自动识别）或日期字符串。' +
        '省略则用"现在"。字符串不带偏移时按 from 时区解释。'
    },
    from: {
      type: 'string',
      description: '源时区（IANA 名）。默认 Asia/Shanghai。省略 time 时代表"现在"所在的参考时区。',
      default: 'Asia/Shanghai'
    },
    to: {
      type: 'string',
      description: '目标时区（单个）。与 toZones 二选一。'
    },
    toZones: {
      type: 'array',
      items: { type: 'string' },
      description: '目标时区列表（批量换算）。不传时默认给一组常用时区。'
    },
    listZones: {
      type: 'boolean',
      description: '是否改为列出当前时刻下的一组常用时区对照表，默认 false',
      default: false
    },
    zoneInfo: {
      type: 'string',
      description:
        '改为查询某个时区的信息：该年标准/夏令偏移、夏令时起止日期、与 UTC 的关系。' +
        '传了它则忽略其它参数。'
    },
    year: {
      type: 'integer',
      description: '配合 zoneInfo 使用，查询哪一年（默认当前年）'
    }
  },
  additionalProperties: false
};

/** 内置常用时区，避免 Agent 去猜名字 */
const COMMON_ZONES = [
  { zone: 'UTC', label: 'UTC 协调世界时' },
  { zone: 'Asia/Shanghai', label: '北京/上海（中国标准时间）' },
  { zone: 'Asia/Hong_Kong', label: '中国香港' },
  { zone: 'Asia/Taipei', label: '中国台湾（台北）' },
  { zone: 'Asia/Tokyo', label: '东京（日本标准时间）' },
  { zone: 'Asia/Seoul', label: '首尔' },
  { zone: 'Asia/Singapore', label: '新加坡' },
  { zone: 'Asia/Kolkata', label: '印度（新德里）' },
  { zone: 'Asia/Dubai', label: '迪拜' },
  { zone: 'Europe/London', label: '伦敦（格林尼治/英国夏令时）' },
  { zone: 'Europe/Paris', label: '巴黎（中欧时间）' },
  { zone: 'Europe/Moscow', label: '莫斯科' },
  { zone: 'America/New_York', label: '纽约（美东时间）' },
  { zone: 'America/Chicago', label: '芝加哥（美中时间）' },
  { zone: 'America/Denver', label: '丹佛（美山区时间）' },
  { zone: 'America/Los_Angeles', label: '洛杉矶（美西时间）' },
  { zone: 'America/Sao_Paulo', label: '圣保罗' },
  { zone: 'Australia/Sydney', label: '悉尼（澳洲东部时间）' },
  { zone: 'Pacific/Auckland', label: '奥克兰' },
  { zone: 'Africa/Cairo', label: '开罗' }
];

/** 解析时刻输入 */
function resolveTime(input, fromZone) {
  if (input === undefined || input === null || input === '') return Date.now();
  if (typeof input === 'number') return T.normalizeEpoch(input);
  const s = String(input).trim();
  if (/^-?\d+$/.test(s)) {
    const digits = s.replace('-', '').length;
    if (digits !== 8 && digits !== 14) return T.normalizeEpoch(Number(s));
  }
  return T.parseDateTime(s, fromZone).utc;
}

/** 查某时区某年的 DST 规则 */
function zoneReport(zone, year) {
  if (!T.isValidTimeZone(zone)) {
    throw new Error(`无效的时区名 "${zone}"。`);
  }
  if (zone === 'UTC' || zone === 'Z') {
    return {
      timeZone: 'UTC',
      year,
      standardOffset: '+00:00',
      standardOffsetMinutes: 0,
      dstOffset: null,
      dstOffsetMinutes: null,
      usesDst: false,
      dstShiftMinutes: 0,
      dstStart: null,
      dstEnd: null,
      monthsInDst: [],
      /** 逐月偏移也补上，保证渲染层可以无差别使用（曾经因为这里漏字段而崩过） */
      monthlyOffsets: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, offset: '+00:00' })),
      note: 'UTC 本身不带偏移，也不使用夏令时。'
    };
  }

  // 逐月采样，找出该年出现过哪些偏移（最多两种：标准 / 夏令）
  const samples = [];
  for (let mo = 0; mo < 12; mo++) {
    const probe = Date.UTC(year, mo, 15, 12, 0, 0);
    const off = T.tzOffsetMs(probe, zone);
    samples.push({ month: mo + 1, offsetMs: off, offset: T.formatOffset(off) });
  }
  const unique = [...new Set(samples.map(s => s.offsetMs))].sort((a, b) => a - b);
  const standard = unique[0];
  const dst = unique.length > 1 ? unique[unique.length - 1] : null;

  // 找到 DST 起止：日粒度扫描偏移变化点
  let dstStart = null, dstEnd = null;
  if (dst !== null) {
    /* 关键：不要用"偏移变大=进入夏令时"来判断——那只对北半球成立。
       悉尼等南半球时区 4 月偏移变小（退出 DST）、10 月变大（进入 DST）。
       正确做法是按目标偏移判定：
         变化后 == dst 偏移 → 进入夏令时
         变化后 == standard 偏移 → 退出夏令时
       若该年发生了两次同类变化（跨年段），取该年中最早/最晚的那次。 */
    const transitions = [];
    const cursor = new Date(Date.UTC(year, 0, 1));
    let prev = T.tzOffsetMs(cursor.getTime(), zone);
    while (cursor.getUTCFullYear() === year) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (cursor.getUTCFullYear() !== year) break;
      const cur = T.tzOffsetMs(cursor.getTime(), zone);
      if (cur !== prev) {
        transitions.push({
          date: cursor.toISOString().slice(0, 10),
          from: T.formatOffset(prev),
          to: T.formatOffset(cur),
          enteredDst: cur === dst
        });
        prev = cur;
      }
    }
    const enters = transitions.filter(t => t.enteredDst);
    const exits = transitions.filter(t => !t.enteredDst);
    if (enters.length) dstStart = enters[0];
    if (exits.length) dstEnd = exits[0];
  }

  const monthsInDst = unique.length > 1
    ? samples.filter(s => s.offsetMs === dst).map(s => s.month)
    : [];

  return {
    timeZone: zone,
    year,
    standardOffset: T.formatOffset(standard),
    standardOffsetMinutes: standard / 60000,
    dstOffset: dst === null ? null : T.formatOffset(dst),
    dstOffsetMinutes: dst === null ? null : dst / 60000,
    usesDst: dst !== null,
    dstShiftMinutes: dst === null ? 0 : (dst - standard) / 60000,
    dstStart: dstStart,
    dstEnd: dstEnd,
    monthsInDst,
    monthlyOffsets: samples.map(s => ({ month: s.month, offset: s.offset }))
  };
}

async function run(args = {}) {
  /* ---------- 模式 C：时区信息查询 ---------- */
  if (args.zoneInfo) {
    const zone = args.zoneInfo;
    const year = args.year || T.wallClockOf(Date.now(), T.isValidTimeZone(zone) ? zone : 'UTC').y;
    const r = zoneReport(zone, year);

    let text = `${zone}（${year} 年）`;
    text += fmt.section('偏移');
    text += '\n' + fmt.kv([
      ['标准时偏移', r.standardOffset],
      ['夏令时偏移', r.usesDst ? r.dstOffset : '不使用夏令时'],
      ['夏令时调整量', r.usesDst ? r.dstShiftMinutes + ' 分钟' : '—']
    ]);

    if (r.usesDst) {
      text += fmt.section('夏令时区间');
      const rows = [];
      if (r.dstStart) rows.push(['进入夏令时', r.dstStart.date, r.dstStart.from + ' → ' + r.dstStart.to]);
      if (r.dstEnd) rows.push(['退出夏令时', r.dstEnd.date, r.dstEnd.from + ' → ' + r.dstEnd.to]);
      text += '\n' + fmt.table(['事件', '日期', '偏移变化'], rows, { colMax: 30 });
      text += `\n处于夏令时的月份：${r.monthsInDst.join('、')} 月`;
      text += `\n\n⚠️ 该时区全年偏移不固定：${r.standardOffset} ↔ ${r.dstOffset}。`;
      text += `\n换算跨夏令时的时刻时，请以本工具算出的结果为准，不要用固定偏移心算。`;
    } else {
      text += `\n\n该时区全年固定偏移 ${r.standardOffset}，不使用夏令时。`;
    }

    text += fmt.section('逐月偏移');
    text += '\n' + fmt.table(
      ['月份', '偏移'],
      r.monthlyOffsets.map(m => [m.month + ' 月', m.offset]),
      { colMax: 12 }
    );

    return { mode: 'zoneInfo', ...r, _text: text };
  }

  /* ---------- 解析时刻 ---------- */
  const fromZone = args.from || 'Asia/Shanghai';
  if (!T.isValidTimeZone(fromZone)) {
    throw new Error(`无效的源时区名 "${fromZone}"。请用 IANA 名，如 Asia/Shanghai。`);
  }
  const utc = resolveTime(args.time, fromZone);

  /* ---------- 目标时区列表 ---------- */
  let targets;
  if (Array.isArray(args.toZones) && args.toZones.length) {
    targets = args.toZones.slice();
  } else if (args.to) {
    targets = [args.to];
  } else if (args.listZones) {
    targets = COMMON_ZONES.map(z => z.zone);
  } else {
    // 没指定目标时，默认给一组常用时区（含源时区在最前）
    targets = [fromZone, 'UTC', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
    targets = targets.filter((z, i) => targets.indexOf(z) === i);
  }

  for (const z of targets) {
    if (!T.isValidTimeZone(z)) {
      throw new Error(
        `无效的目标时区名 "${z}"。请用 IANA 时区名，如 Asia/Shanghai / America/New_York / UTC。`
      );
    }
  }

  const labelOf = (z) => {
    const hit = COMMON_ZONES.find(c => c.zone === z);
    return hit ? hit.label : '';
  };

  /* ---------- 渲染 ---------- */
  const rows = [];
  const zones = [];
  let hasDst = false;

  for (const z of targets) {
    const w = T.wallClockOf(utc, z);
    if (w.dst) hasDst = true;
    rows.push([
      z,
      T.formatInZone(utc, z),
      T.weekdayLabel(w.weekday),
      w.offset,
      w.dst ? '夏令时' : '标准时'
    ]);
    zones.push({
      timeZone: z,
      label: labelOf(z),
      local: T.formatInZone(utc, z),
      iso: T.toIsoInZone(utc, z),
      weekday: w.weekday,
      weekdayName: T.weekdayLabel(w.weekday),
      utcOffset: w.offset,
      utcOffsetMinutes: Math.round(w.offsetMs / 60000),
      isDst: !!w.dst,
      wallClock: {
        year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s
      }
    });
  }

  const wFrom = T.wallClockOf(utc, fromZone);
  const dayShift = (() => {
    // 与源时区的日期差（跨日提醒）
    const a = T.dateKey(wFrom);
    return targets.map(z => {
      const w = T.wallClockOf(utc, z);
      const b = T.dateKey(w);
      if (b === a) return null;
      const da = Date.UTC(wFrom.y, wFrom.mo - 1, wFrom.d);
      const db = Date.UTC(w.y, w.mo - 1, w.d);
      const days = Math.round((db - da) / 86400000);
      return { zone: z, days };
    }).filter(Boolean);
  })();

  let text = `时刻：${T.formatInZone(utc, fromZone)}（${fromZone}，${T.weekdayLabel(wFrom.weekday)}）`;
  text += `\nUTC：${new Date(utc).toISOString()}`;
  text += `\nepoch：${Math.floor(utc / 1000)} 秒`;

  text += fmt.section('各时区对照');
  text += '\n' + fmt.table(['时区', '当地时间', '星期', 'UTC 偏移', '状态'], rows, { colMax: 40 });

  if (dayShift.length) {
    text += fmt.section('跨日提醒');
    text += '\n' + fmt.list(dayShift.map(d =>
      `${d.zone} 比 ${fromZone} 的日期${d.days > 0 ? '晚' : '早'} ${Math.abs(d.days)} 天`
    ));
  }

  if (hasDst) {
    text += fmt.section('夏令时提示');
    const dstZones = zones.filter(z => z.isDst).map(z => z.timeZone);
    text += `\n以下时区当前处于夏令时：${dstZones.join('、')}`;
    text += `\n它们的偏移在冬夏之间会变化，换算其它日期的时刻时不要沿用当前偏移。`;
    text += `\n可用 stamp_zone(zoneInfo="<时区>") 查看该时区全年的偏移变化。`;
  }

  /* ---------- 单目标时额外给出"反推"信息 ---------- */
  if (targets.length === 1) {
    const z = targets[0];
    const w = T.wallClockOf(utc, z);
    const rep = zoneReport(z, w.y);
    text += fmt.section(`「${z}」时区概览`);
    text += '\n' + fmt.kv([
      ['标准时', rep.standardOffset],
      ['夏令时', rep.usesDst ? rep.dstOffset + `（调整 ${rep.dstShiftMinutes} 分钟）` : '不使用'],
      ['当前状态', w.dst ? '夏令时' : '标准时'],
      ['与 UTC 关系', 'UTC' + (w.offsetMs >= 0 ? '+' : '-') + Math.abs(w.offsetMs / 3600000) + ' 小时']
    ]);
  }

  return {
    mode: 'convert',
    from: fromZone,
    fromLocal: T.formatInZone(utc, fromZone),
    utc,
    isoUtc: new Date(utc).toISOString(),
    epoch: Math.floor(utc / 1000),
    timeZones: zones,
    dayShift,
    hasDst,
    _text: text
  };
}

module.exports = { name, title, description, inputSchema, run, COMMON_ZONES };
