'use strict';
/**
 * stamp_workday —— 工作日推算
 *
 * 场景：
 *   "这个需求 5 个工作日后交付"（加 N 工作日）
 *   "合同 2026-10-01 生效，30 个工作日后的到期日"（加 N 工作日 + 节假日）
 *   "这两个日期之间有几个工作日"（统计）
 *   "2026-10-08 是工作日吗"（判定）
 *
 * 关键设计：
 *   - 默认只排除周末，节假日必须显式传入（构建时无法内置一份永远不会过期的节假日表，
 *     内置反而会制造"看起来对其实过期"的静默错误）。
 *   - 支持调休（把某个周末设为上班日），这是中国日历的刚需。
 *   - 推算保持"墙钟时刻"不变：加了 5 个工作日之后，时间点还是下午 3 点，
 *     而不是简单加 5*86400 秒。
 */

const T = require('../utils/time');
const fmt = require('./format');

const name = 'stamp_workday';
const title = 'Workday calculations';
const description =
  '工作日推算：给出日期加/减 N 个工作日后的日期、统计两个日期之间的工作日数、判断某天是否工作日。' +
  '默认只排除周六周日；中国法定节假日与调休请通过 holidays（放假日期）与 workdays（调休上班日）显式传入，' +
  '例如 holidays=["2026-10-01","2026-10-02"]、workdays=["2026-10-10"]。' +
  '结果保持墙钟时刻不变（下午 3 点加 5 个工作日仍是下午 3 点）。';

const inputSchema = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['add', 'count', 'check'],
      description:
        'add=加/减 N 个工作日（需 days）；count=统计区间工作日数（需 from+to）；check=判断某天是否工作日（需 date）。' +
        '不填时会根据提供的参数自动推断。',
      default: 'add'
    },
    date: {
      type: ['string', 'number'],
      description: '基准日期（add / check 模式用）。时间戳或日期字符串，如 "2026-09-18"。默认现在。'
    },
    days: {
      type: 'integer',
      description: '要加（正数）或减（负数）的工作日数。add 模式必填。'
    },
    from: {
      type: ['string', 'number'],
      description: '起止区间起点（count 模式必需）。'
    },
    to: {
      type: ['string', 'number'],
      description: '起止区间终点（count 模式必需）。'
    },
    zone: {
      type: 'string',
      description: '解释与呈现日期所用的时区，默认 Asia/Shanghai',
      default: 'Asia/Shanghai'
    },
    holidays: {
      type: 'array',
      items: { type: 'string' },
      description: '放假的日期列表（YYYY-MM-DD），这些天不算工作日。例如 ["2026-10-01","2026-10-02"]'
    },
    workdays: {
      type: 'array',
      items: { type: 'string' },
      description: '调休上班日列表（YYYY-MM-DD），即使落在周末也算工作日。例如 ["2026-10-10"]'
    },
    includeBoundary: {
      type: 'boolean',
      description: 'count 模式下是否把终点当天计入，默认 false（不含起点、含终点）',
      default: false
    }
  },
  additionalProperties: false
};

/** 解析日期输入为 UTC 毫秒（保留其墙钟） */
function resolveMoment(v, zone) {
  if (v === undefined || v === null || v === '') return Date.now();
  if (typeof v === 'number') return T.normalizeEpoch(v);
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) {
    const digits = s.replace('-', '').length;
    if (digits !== 8 && digits !== 14) return T.normalizeEpoch(Number(s));
  }
  return T.parseDateTime(s, zone).utc;
}

/** 校验并标准化日期列表 */
function normalizeDateList(arr, fieldName) {
  const out = new Set();
  if (!Array.isArray(arr)) return out;
  for (const raw of arr) {
    const s = String(raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      throw new Error(`${fieldName} 里的 "${s}" 格式不对，应为 YYYY-MM-DD。`);
    }
    const [y, mo, d] = s.split('-').map(Number);
    T.checkDateParts(y, mo, d);
    out.add(s);
  }
  return out;
}

/** 构造最终的 isWorkday 判定函数：周末 + 节假日 - 调休 */
function makeJudge(holidaySet, makeupSet) {
  return (w) => {
    const key = T.dateKey(w);
    if (makeupSet.has(key)) return true;        // 调休：周末也上班
    if (holidaySet.has(key)) return false;      // 法定假期
    return w.weekday !== 6 && w.weekday !== 7;  // 默认排除周六周日
  };
}

async function run(args = {}) {
  const zone = args.zone || 'Asia/Shanghai';
  if (!T.isValidTimeZone(zone)) {
    throw new Error(`无效的时区名 "${zone}"。`);
  }

  const holidaySet = normalizeDateList(args.holidays, 'holidays');
  const makeupSet = normalizeDateList(args.workdays, 'workdays');

  if (holidaySet.size && makeupSet.size) {
    for (const k of holidaySet) {
      if (makeupSet.has(k)) {
        throw new Error(`日期 ${k} 同时出现在 holidays 与 workdays 里，请去掉其中一个。`);
      }
    }
  }

  // 自动推断模式
  let mode = args.mode;
  if (!mode) {
    if (args.from !== undefined && args.to !== undefined) mode = 'count';
    else if (args.days !== undefined) mode = 'add';
    else if (args.date !== undefined) mode = 'check';
    else mode = 'add';
  }

  /* ===================== add ===================== */
  if (mode === 'add') {
    if (args.days === undefined || args.days === null) {
      throw new Error('add 模式需要提供 days（要加/减的工作日数）。');
    }
    if (!Number.isInteger(args.days) || args.days === 0) {
      throw new Error(`days 必须是非零整数，收到 "${args.days}"。`);
    }

    const baseUtc = resolveMoment(args.date, zone);
    const baseW = T.wallClockOf(baseUtc, zone);
    const baseIsWorkday = makeJudge(holidaySet, makeupSet)(baseW);

    // 用带调休的判定重算 addWorkdays
    const targetUtc = addWorkdaysWith(baseUtc, args.days, zone, holidaySet, makeupSet);
    const targetW = T.wallClockOf(targetUtc, zone);

    const dir = args.days > 0 ? '后' : '前';
    let text = `基准：${T.formatInZone(baseUtc, zone)}（${T.weekdayLabel(baseW.weekday)}）`;
    text += `\n${baseIsWorkday ? '是' : '不是'}工作日`;
    text += `\n\n**${Math.abs(args.days)} 个工作日${dir}：${T.formatInZone(targetUtc, zone)}（${T.weekdayLabel(targetW.weekday)}）**`;

    // 途经的日历天跨度
    const calendarDays = Math.round(
      (Date.UTC(targetW.y, targetW.mo - 1, targetW.d) - Date.UTC(baseW.y, baseW.mo - 1, baseW.d)) / 86400000
    );
    text += `\n跨越日历天：${Math.abs(calendarDays)} 天（含 ${Math.abs(args.days)} 个工作日 + ${Math.abs(calendarDays) - Math.abs(args.days)} 个非工作日）`;

    text += fmt.section('明细');
    text += '\n' + fmt.kv([
      ['基准日期', T.formatInZone(baseUtc, zone) + '（' + T.weekdayLabel(baseW.weekday) + '）'],
      ['方向', args.days > 0 ? '往后' : '往前'],
      ['工作日数', Math.abs(args.days)],
      ['结果日期', T.formatInZone(targetUtc, zone) + '（' + T.weekdayLabel(targetW.weekday) + '）'],
      ['结果 epoch 秒', String(Math.floor(targetUtc / 1000))],
      ['结果 ISO', T.toIsoInZone(targetUtc, zone)],
      ['排除的节假日', holidaySet.size ? [...holidaySet].join(', ') : '（未提供）'],
      ['调休上班日', makeupSet.size ? [...makeupSet].join(', ') : '（未提供）']
    ]);

    return {
      mode: 'add',
      zone,
      base: baseUtc,
      baseLocal: T.formatInZone(baseUtc, zone),
      baseWeekday: T.weekdayLabel(baseW.weekday),
      baseIsWorkday,
      days: args.days,
      result: targetUtc,
      resultLocal: T.formatInZone(targetUtc, zone),
      resultWeekday: T.weekdayLabel(targetW.weekday),
      resultIso: T.toIsoInZone(targetUtc, zone),
      calendarDays: Math.abs(calendarDays),
      holidays: [...holidaySet],
      makeupWorkdays: [...makeupSet],
      _text: text
    };
  }

  /* ===================== count ===================== */
  if (mode === 'count') {
    if (args.from === undefined || args.to === undefined) {
      throw new Error('count 模式需要同时提供 from 与 to。');
    }
    const fromUtc = resolveMoment(args.from, zone);
    const toUtc = resolveMoment(args.to, zone);
    if (toUtc < fromUtc) {
      throw new Error('count 模式下 to 不能早于 from。请交换两者，或改用 stamp_duration 求带符号间隔。');
    }

    const judge = makeJudge(holidaySet, makeupSet);
    const wFrom = T.wallClockOf(fromUtc, zone);
    const wTo = T.wallClockOf(toUtc, zone);

    // 逐日遍历（按墙钟日期），统计
    let workdays = 0, weekends = 0, holidaysHit = 0, makeupHit = 0, total = 0;
    const details = [];
    const cursor = new Date(Date.UTC(wFrom.y, wFrom.mo - 1, wFrom.d));
    const endKey = T.dateKey(wTo);
    const startKey = T.dateKey(wFrom);

    let guard = 0;
    while (true) {
      if (++guard > 20000) throw new Error('区间过大（超过 20000 天），请缩小范围。');
      const y = cursor.getUTCFullYear();
      const mo = cursor.getUTCMonth() + 1;
      const d = cursor.getUTCDate();
      const key = `${y}-${T.pad(mo)}-${T.pad(d)}`;
      const weekday = T.jsDayToIso(cursor.getUTCDay());
      const isWeekend = weekday === 6 || weekday === 7;

      // 是否在统计区间内（不含起点，含终点 = includeBoundary 控制）
      const inRange = args.includeBoundary
        ? (key >= startKey && key <= endKey)
        : (key > startKey && key <= endKey);

      if (inRange) {
        total++;
        const isHoliday = holidaySet.has(key);
        const isMakeup = makeupSet.has(key);
        const isWork = judge({ y, mo, d, weekday });
        if (isWork) workdays++;
        if (isWeekend) weekends++;
        if (isHoliday) holidaysHit++;
        if (isMakeup) makeupHit++;
        if (details.length < 60) {
          details.push([
            key, T.weekdayLabel(weekday),
            isWork ? '是' : '否',
            isHoliday ? '法定假期' : (isMakeup ? '调休上班' : (isWeekend ? '周末' : ''))
          ]);
        }
      }

      if (key >= endKey) break;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    let text = `区间：${T.formatInZone(fromUtc, zone)}（${T.weekdayLabel(wFrom.weekday)}）`;
    text += ` → ${T.formatInZone(toUtc, zone)}（${T.weekdayLabel(wTo.weekday)}）`;
    text += `\n统计口径：${args.includeBoundary ? '含起止两端' : '含终点、不含起点'}`;
    text += `\n\n**工作日 ${workdays} 天 / 共 ${total} 天**`;

    text += fmt.section('汇总');
    text += '\n' + fmt.kv([
      ['日历天数', total + ' 天'],
      ['工作日', workdays + ' 天'],
      ['其中周末', weekends + ' 天'],
      ['其中法定假期', holidaysHit + ' 天'],
      ['其中调休上班', makeupHit + ' 天'],
      ['非工作日合计', (total - workdays) + ' 天']
    ]);

    if (details.length) {
      text += fmt.section('逐日明细');
      text += '\n' + fmt.table(['日期', '星期', '工作日', '备注'], details, { colMax: 22 });
      if (total > details.length) {
        text += `\n（仅显示前 ${details.length} 天，共 ${total} 天）`;
      }
    }

    return {
      mode: 'count',
      zone,
      from: fromUtc,
      to: toUtc,
      totalDays: total,
      workdays,
      weekends,
      holidaysHit,
      makeupHit,
      nonWorkdays: total - workdays,
      holidays: [...holidaySet],
      makeupWorkdays: [...makeupSet],
      _text: text
    };
  }

  /* ===================== check ===================== */
  if (mode === 'check') {
    const utc = resolveMoment(args.date, zone);
    const w = T.wallClockOf(utc, zone);
    const key = T.dateKey(w);
    const isWeekend = w.weekday === 6 || w.weekday === 7;
    const isHoliday = holidaySet.has(key);
    const isMakeup = makeupSet.has(key);
    const isWork = makeJudge(holidaySet, makeupSet)(w);

    let reason;
    if (isMakeup) reason = '调休上班日（虽是周末但算工作日）';
    else if (isHoliday) reason = '法定假期';
    else if (isWeekend) reason = '周末';
    else reason = '正常工作日';

    let text = `日期：${T.formatInZone(utc, zone)}（${T.weekdayLabel(w.weekday)}）`;
    text += `\n\n**${isWork ? '是' : '不是'}工作日** —— ${reason}`;

    if (isWork) {
      const prev = addWorkdaysWith(utc, -1, zone, holidaySet, makeupSet);
      const next = addWorkdaysWith(utc, 1, zone, holidaySet, makeupSet);
      text += fmt.section('相邻工作日');
      text += '\n' + fmt.kv([
        ['上一个工作日', T.formatInZone(prev, zone)],
        ['下一个工作日', T.formatInZone(next, zone)]
      ]);
    } else {
      const next = nextWorkdayFrom(utc, zone, holidaySet, makeupSet);
      text += `\n下一个工作日：${T.formatInZone(next, zone)}（${T.weekdayLabel(T.wallClockOf(next, zone).weekday)}）`;
    }

    return {
      mode: 'check',
      zone,
      date: utc,
      dateLocal: T.formatInZone(utc, zone),
      dateKey: key,
      weekday: w.weekday,
      weekdayName: T.weekdayLabel(w.weekday),
      isWorkday: isWork,
      isWeekend,
      isHoliday,
      isMakeupWorkday: isMakeup,
      reason,
      _text: text
    };
  }

  throw new Error(`未知的 mode "${mode}"，只支持 add / count / check。`);
}

/* ============================ 带调休的工作日算术 ============================ */

/** 加/减 N 个工作日（支持调休上班日），保持墙钟时刻不变 */
function addWorkdaysWith(utcMs, days, timeZone, holidaySet, makeupSet) {
  const judge = makeJudge(holidaySet, makeupSet);
  const start = T.wallClockOf(utcMs, timeZone);
  let { y, mo, d } = start;
  const { h, mi, s } = start;
  const step = days >= 0 ? 1 : -1;
  let remaining = Math.abs(days);
  let guard = 0;

  while (remaining > 0) {
    if (++guard > 10000) throw new Error('工作日推算超出最大迭代次数（节假日配置过多？）');
    const cursor = new Date(Date.UTC(y, mo - 1, d));
    cursor.setUTCDate(cursor.getUTCDate() + step);
    y = cursor.getUTCFullYear();
    mo = cursor.getUTCMonth() + 1;
    d = cursor.getUTCDate();
    const w = { y, mo, d, weekday: T.jsDayToIso(cursor.getUTCDay()) };
    if (judge(w)) remaining--;
  }

  const utc = T.wallClockToUtc(y, mo, d, h, mi, s, timeZone);
  if (utc === null) {
    for (let hh = h + 1; hh <= 23; hh++) {
      const alt = T.wallClockToUtc(y, mo, d, hh, mi, s, timeZone);
      if (alt !== null) return alt;
    }
    throw new Error('推算结果落在夏令时空洞内且无法顺延。');
  }
  return utc;
}

/** 从某时刻往后找最近的工作日（不含当天） */
function nextWorkdayFrom(utcMs, timeZone, holidaySet, makeupSet) {
  return addWorkdaysWith(utcMs, 1, timeZone, holidaySet, makeupSet);
}

module.exports = { name, title, description, inputSchema, run };
