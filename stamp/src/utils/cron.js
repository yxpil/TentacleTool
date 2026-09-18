'use strict';
/**
 * Cron 表达式解析与下一次触发时间预测（零依赖）
 *
 * 支持标准 5 段（分 时 日 月 周）与 6 段（多一个秒，Quartz 风格）。
 * 字段语法：*  ,  -  /  以及数字与月份/星期名（jan/1、mon/1）
 * 不支持：? L W #（这些是 Quartz 扩展，遇到时给出明确报错而不是静默忽略）
 *
 * 关于「日 与 周」的语义（这是 cron 最容易踩的坑）：
 *   当 日 字段和 周 字段**都不是** * 时，标准 cron 的语义是 **OR**（满足其一即触发），
 *   而不是 AND。本实现遵循标准行为，并在描述里说明，避免用户误判。
 */

const { wallClockToUtc, wallClockOf, formatInZone, pad } = require('./time');

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
const WEEKDAY_NAMES = {
  sun: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

/**
 * 解析单个 cron 字段为「取值集合」。
 * @param {string} field
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @param {object} names 名称映射（如 jan→1）；周字段会把 0/7 都当周日（规范化为 7）
 * @returns {Set<number>}
 */
function parseField(field, min, max, names, isWeekday) {
  const out = new Set();
  if (field == null || field === '' || field === '*') {
    for (let i = min; i <= max; i++) out.add(i);
    return out;
  }

  // 明确拒绝 Quartz 扩展，避免"看起来支持但其实没实现"
  if (/[?LW#]/i.test(field)) {
    throw new Error(`不支持 cron 扩展符号（? L W #）："${field}"。本实现只支持标准 5/6 段语法。`);
  }

  for (const part of String(field).split(',')) {
    const seg = part.trim();
    if (!seg) throw new Error(`cron 字段有空的项："${field}"`);

    // 拆出步长
    const [rangePart, stepPart] = seg.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      step = parseInt(stepPart, 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`步长必须是正整数："${seg}"`);
      }
      if (stepPart !== String(step)) {
        throw new Error(`步长不是合法整数："${seg}"`);
      }
    }

    let lo, hi;
    if (rangePart === '*' || rangePart === '') {
      lo = min; hi = max;
    } else if (rangePart.includes('-')) {
      const bits = rangePart.split('-');
      if (bits.length !== 2) throw new Error(`范围格式错误："${seg}"`);
      lo = resolveName(bits[0], names, min, max, isWeekday);
      hi = resolveName(bits[1], names, min, max, isWeekday);
      if (lo > hi) throw new Error(`范围起止颠倒："${seg}"（${lo} > ${hi}）`);
    } else {
      lo = resolveName(rangePart, names, min, max, isWeekday);
      // 无步长时是单值；有步长（如 5/10）表示"从 5 开始到底，每 10"
      hi = stepPart !== undefined ? max : lo;
    }

    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  if (out.size === 0) throw new Error(`cron 字段解析结果为空："${field}"`);
  return out;
}

function resolveName(tok, names, min, max, isWeekday) {
  const t = String(tok).trim().toLowerCase();
  if (t === '') throw new Error('cron 字段有空值');
  let v = null;
  if (/^\d+$/.test(t)) {
    v = parseInt(t, 10);
  } else if (names && names[t] !== undefined) {
    v = names[t];
  } else {
    throw new Error(`无法识别的取值："${tok}"（可用数字${names ? '或名称如 ' + Object.keys(names).slice(0, 3).join('/') : ''}）`);
  }
  // 周字段：0 与 7 都表示周日，统一成 7
  if (isWeekday && v === 0) v = 7;
  if (v < min || v > max) {
    throw new Error(`取值 ${v} 超出范围 ${min}~${max}`);
  }
  return v;
}

/**
 * 解析完整 cron 表达式。
 * @returns {{seconds:Set,minutes:Set,hours:Set,dom:Set,months:Set,dow:Set,domStar:boolean,dowStar:boolean,fields:number,source:string}}
 */
function parseCron(expr) {
  const src = String(expr == null ? '' : expr).trim();
  if (!src) throw new Error('cron 表达式为空');

  const parts = src.split(/\s+/);
  let secField, minField, hourField, domField, monField, dowField;

  if (parts.length === 5) {
    [minField, hourField, domField, monField, dowField] = parts;
    secField = '0';
  } else if (parts.length === 6) {
    [secField, minField, hourField, domField, monField, dowField] = parts;
  } else {
    throw new Error(
      `cron 表达式应为 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周），` +
      `当前有 ${parts.length} 段："${src}"`
    );
  }

  const months = parseField(monField, 1, 12, MONTH_NAMES);
  const dom = parseField(domField, 1, 31);
  const domStar = domField === '*' || domField === '*/1' || domField === '?';
  const dowStar = dowField === '*' || dowField === '*/1' || dowField === '?';

  /* 静态可行性检查：月份与日期的组合是否可能存在。
     若不检查，"0 0 30 2 *"（2 月 30 日）要等 nextRuns 扫完整个视野才知道永不触发，
     耗时数秒。这里在解析阶段直接算出来，让调用方立刻拿到清晰错误。
     注意：只有 周 字段为 * 时才适用——若周字段也有限定，日/周是 OR 语义，
     即使"2 月 30 日"不可能，仍可能按星期触发，不能判死。 */
  if (!domStar && dowStar) {
    const MAX_DOM = { 1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31 };
    const feasible = [];
    for (const mo of months) {
      for (const d of dom) {
        if (d <= MAX_DOM[mo]) feasible.push({ mo, d });
      }
    }
    if (feasible.length === 0) {
      const monthsDesc = [...months].sort((a, b) => a - b)
        .map(m => `${m} 月最多 ${MAX_DOM[m]} 天`).join('，');
      const domDesc = [...dom].sort((a, b) => a - b).join('/');
      throw new Error(
        `该表达式永远不会触发：日字段为 ${domDesc}，但所限定的月份都不可能有这些日期（${monthsDesc}）。` +
        '请检查日期与月份的组合。'
      );
    }
  }

  return {
    seconds: parseField(secField, 0, 59),
    minutes: parseField(minField, 0, 59),
    hours: parseField(hourField, 0, 23),
    dom,
    months,
    dow: parseField(dowField, 1, 7, WEEKDAY_NAMES, true),
    domStar,
    dowStar,
    fields: parts.length,
    source: src
  };
}

/** 某墙钟时刻是否命中该 cron（日与周按标准 OR 语义） */
function matchesCron(c, w) {
  if (!c.seconds.has(w.s)) return false;
  if (!c.minutes.has(w.mi)) return false;
  if (!c.hours.has(w.h)) return false;
  if (!c.months.has(w.mo)) return false;

  const domHit = c.dom.has(w.d);
  const dowHit = c.dow.has(w.weekday);

  // 标准 cron：两者都被限定时取 OR；否则只取被限定的那个
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowHit;
  if (c.dowStar) return domHit;
  return domHit || dowHit;
}

/**
 * 从 fromMs 之后开始找接下来的 N 次触发时刻。
 *
 * 实现方式：逐秒推进太慢（跨月会扫几百万次）。
 * 正确做法是「按字段逐级跳跃」——从当前时刻起，把秒/分/时/日/月/周依次对齐到
 * 下一个允许值。这里采用更简单可靠的策略：以「分钟」为步长粗筛，
 * 命中后再在该分钟内按秒集合枚举。对标准 5 段表达式（秒固定为 0）效率最好。
 *
 * @param {object} c parseCron 结果
 * @param {number} fromMs 起始绝对时刻（不含）
 * @param {number} count 需要几次
 * @param {string} timeZone 判定所用时区
 * @param {number} maxIterations 迭代上限，防止"永不触发"的表达式卡死
 */
/**
 * 预测未来若干次触发时刻。
 *
 * 性能策略：不做逐秒扫描（跨月会跑几百万次），而是按字段逐级跳跃：
 *   月份/日期/星期不匹配 → 跳到次日 00:00
 *   小时不匹配           → 跳到下一个整点
 *   分钟不匹配           → 跳到下一分钟
 *   全部匹配             → 只在该分钟内的秒集合里找一次
 *
 * 终止条件用**日历视野**而不是迭代次数：
 *   一台机器上 wallClockOf 约 0.2ms，如果只限迭代次数，像 "0 0 30 2 *"（2 月 30 日，
 *   永不触发）这种表达式会把 50 万次迭代跑满 —— 用户要等好几分钟才被告知"找不到"。
 *   改用"最多往后找 N 年"作为边界，既能覆盖所有现实用例（含 2 月 29 日这种
 *   最多隔 8 年的表达式），又能在毫秒级给出"永不触发"的结论。
 *
 * 夏令时陷阱（这里踩过一次真实的死循环，值得记下来）：
 *   "春季跳表"会让某些墙钟时刻根本不存在（纽约 2026-03-08 的 02:00–02:59）。
 *   此时 wallClockToUtc 对这些墙钟返回 null。
 *   如果表达式恰好指向 02:30，那么"跳到下一个整点"这类**按墙钟反推**的跳法
 *   会因为目标墙钟不存在而失败，退化成一次毫无进展的步进 —— 死循环。
 *
 *   因此本实现坚持两条硬约束：
 *   1. **每一轮迭代 cursor 必须严格增大**（有真实时间上的进展），否则强制 +1 分钟；
 *   2. 墙钟优化跳转只是"加速"，一旦落空立刻回退到保守步进。
 *   这样即使时区规则再怪，也只会慢，不会卡死。
 *
 * @param {number} horizonYears 最多往后搜索多少年（默认 20 年）。
 *   为什么是 20：闰年规则下 2 月 29 日最长可能间隔 8 年（如 2096→2104，因为 2100 不是闰年），
 *   要凑够 count 次结果就得把视野放得比 8 年宽裕得多。20 年足以容纳
 *   "2 月 29 日 × count=5" 这种极端组合，代价只是 20 年 × 365 次左右的迭代（约 2 秒）。
 */
function nextRuns(c, fromMs, count, timeZone = 'UTC', horizonYears = 20) {
  const results = [];
  if (count <= 0) return results;

  // 从下一分钟的第一秒开始（避免重复返回 fromMs 本身所在的那次）
  let cursor = Math.floor(fromMs / 60000) * 60000 + 60000;

  const horizonMs = cursor + Math.round(horizonYears * 365.25 * 86400000);

  /** 跳转到某墙钟时刻；不存在或没有实质前进则返回 null（由调用方回退） */
  const jumpToWall = (y, mo, d, h, mi, s) => {
    const t = wallClockToUtc(y, mo, d, h, mi, s, timeZone);
    return (t !== null && t > cursor) ? t : null;
  };

  while (results.length < count) {
    if (cursor > horizonMs) {
      throw new Error(
        `在 ${horizonYears} 年的搜索范围内找不到足够的下一次触发时间。` +
        '该表达式可能永远不会触发（例如"0 0 30 2 *"指 2 月 30 日，2 月从没有 30 号），' +
        '请检查月份与日期的组合是否可能是有效日期。'
      );
    }

    const prevCursor = cursor;
    const w = wallClockOf(cursor, timeZone);

    const monthOk = c.months.has(w.mo);
    const domHit = c.dom.has(w.d);
    const dowHit = c.dow.has(w.weekday);
    let dayOk;
    if (c.domStar && c.dowStar) dayOk = true;
    else if (c.domStar) dayOk = dowHit;
    else if (c.dowStar) dayOk = domHit;
    else dayOk = domHit || dowHit;

    if (!monthOk || !dayOk) {
      /* 跳到次日的 00:00:00。若次日 00:00 不存在（某些时区会在午夜跳表），
         就退而求其次跳到次日白天某个存在的墙钟。 */
      const nextDay = new Date(Date.UTC(w.y, w.mo - 1, w.d));
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const ny = nextDay.getUTCFullYear();
      const nmo = nextDay.getUTCMonth() + 1;
      const nd = nextDay.getUTCDate();
      let jumped = null;
      for (const hh of [0, 1, 2, 3, 4, 12]) {
        jumped = jumpToWall(ny, nmo, nd, hh, 0, 0);
        if (jumped !== null) break;
      }
      cursor = jumped !== null ? jumped : cursor + 86400000;
    } else if (!c.hours.has(w.h)) {
      /* 跳到下一个整点。优先按墙钟 +1 小时；失败（DST 空洞）则退化为真实时间 +1 小时。 */
      let jumped = null;
      for (let step = 1; step <= 4 && jumped === null; step++) {
        let hh = w.h + step;
        let dy = w.y, dmo = w.mo, dd = w.d;
        if (hh > 23) {
          const nd = new Date(Date.UTC(w.y, w.mo - 1, w.d));
          nd.setUTCDate(nd.getUTCDate() + 1);
          dy = nd.getUTCFullYear(); dmo = nd.getUTCMonth() + 1; dd = nd.getUTCDate();
          hh -= 24;
        }
        jumped = jumpToWall(dy, dmo, dd, hh, 0, 0);
      }
      cursor = jumped !== null ? jumped
        : (Math.floor(cursor / 3600000) + 1) * 3600000;
    } else if (!c.minutes.has(w.mi)) {
      /* 跳到下一个整分钟。按墙钟 +1 分钟；失败则真实时间 +1 分钟。 */
      let nmi = w.mi + 1, ny = w.y, nmo = w.mo, nd = w.d, nh = w.h;
      if (nmi > 59) {
        nmi = 0; nh++;
        if (nh > 23) {
          nh = 0;
          const ndd = new Date(Date.UTC(w.y, w.mo - 1, w.d));
          ndd.setUTCDate(ndd.getUTCDate() + 1);
          ny = ndd.getUTCFullYear(); nmo = ndd.getUTCMonth() + 1; nd = ndd.getUTCDate();
        }
      }
      const jumped = jumpToWall(ny, nmo, nd, nh, nmi, 0);
      cursor = jumped !== null ? jumped
        : (Math.floor(cursor / 60000) + 1) * 60000;
    } else {
      // 时/分/日/月/周 全匹配：在本分钟内的秒集合里找第一个尚未过的秒
      const minuteStart = cursor - (cursor % 60000);
      const secondsSorted = Array.from(c.seconds).sort((a, b) => a - b);
      const curSec = Math.floor((cursor - minuteStart) / 1000);
      const hit = secondsSorted.find(s => s > curSec || (s === curSec && cursor === minuteStart));

      if (hit !== undefined) {
        const candidate = minuteStart + hit * 1000;
        if (candidate > fromMs) {
          // DST 校验：候选时刻必须真实存在于该时区（跳表时段不存在）
          const cw = wallClockOf(candidate, timeZone);
          const roundTrip = wallClockToUtc(cw.y, cw.mo, cw.d, cw.h, cw.mi, cw.s, timeZone);
          if (roundTrip !== null && roundTrip === candidate) {
            results.push(candidate);
            cursor = candidate + 1000;
            continue;
          }
        }
      }
      // 本分钟没有可用秒（或全被 DST 否掉）：前进到下一分钟
      cursor = minuteStart + 60000;
    }

    /* 硬约束：每轮必须严格前进，否则保守 +1 分钟，杜绝任何形式的死循环 */
    if (cursor <= prevCursor) cursor = prevCursor + 60000;
  }

  return results;
}

/* ============================ 描述 ============================ */

function describeSet(set, min, max, unitLabel, names) {
  if (set.size === max - min + 1) return '每' + unitLabel;
  const vals = Array.from(set).sort((a, b) => a - b);
  if (vals.length === 1) return `${vals[0]}${unitLabel === '分钟' ? '分' : ''}`;
  return vals.join(',');
}

/** 生成中文描述（让用户确认表达式是否符合预期） */
function describeCron(c) {
  const bits = [];
  const secAll = c.seconds.size === 60;
  const minAll = c.minutes.size === 60;
  const hourAll = c.hours.size === 24;

  if (secAll) bits.push('每秒');
  else if (c.seconds.size === 1 && c.seconds.has(0)) {
    /* 标准 5 段，秒固定 0，不单独描述 */
  } else {
    bits.push(`第 ${Array.from(c.seconds).sort((a, b) => a - b).join(',')} 秒`);
  }

  if (minAll) bits.push('每分钟');
  else if (c.minutes.size === 1) bits.push(`第 ${Array.from(c.minutes)[0]} 分`);
  else bits.push(`第 ${Array.from(c.minutes).sort((a, b) => a - b).join(',')} 分`);

  if (hourAll) bits.push('每小时');
  else if (c.hours.size === 1) bits.push(`${Array.from(c.hours)[0]} 点`);
  else bits.push(`${Array.from(c.hours).sort((a, b) => a - b).join(',')} 点`);

  const monAll = c.months.size === 12;
  const monthsDesc = monAll ? ''
    : Array.from(c.months).sort((a, b) => a - b).join(',') + ' 月';

  const domAll = c.domStar;
  const dowAll = c.dowStar;
  const DOW = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };
  const dowDesc = Array.from(c.dow).sort((a, b) => a - b).map(d => DOW[d]).join('、');
  const domDesc = Array.from(c.dom).sort((a, b) => a - b).join(',');

  /* 月份与日期的措辞：把"2 月"与"29 号"合成"2 月的 29 号"更好读，
     但日期是多值时（如 1,15 号）就退化成"1,15 号 · 2 月"避免句子绕。 */
  let datePart;
  if (!domAll && !dowAll) {
    datePart = `每月 ${domDesc} 号**或**每周${dowDesc}（两者满足其一）`;
  } else if (!domAll) {
    datePart = c.dom.size === 1 && monthsDesc && c.months.size === 1
      ? `${monthsDesc}的 ${domDesc} 号`
      : `每月 ${domDesc} 号`;
  } else if (!dowAll) {
    datePart = `每周${dowDesc}`;
  } else {
    datePart = '每天';
  }

  // 月份在日期已被吸收进 datePart 时不再重复输出
  const monthAbsorbed = !domAll && c.dom.size === 1 && c.months.size === 1;
  if (monthsDesc && !monthAbsorbed) bits.push(monthsDesc);
  bits.push(datePart);

  return bits.join(' · ');
}

module.exports = {
  parseCron, parseField, matchesCron, nextRuns, describeCron,
  MONTH_NAMES, WEEKDAY_NAMES
};
