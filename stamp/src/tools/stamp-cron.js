'use strict';
/**
 * stamp_cron —— cron 表达式解析与触发时间预测
 *
 * 为什么值得单独做一个工具：
 *   cron 表达式是"人写、机器跑"的典型歧义重灾区。日字段与周字段同时限定时的
 *   **OR 语义**、`星号斜杠 n` 与 `a-b/n` 的区别、6 段式带秒的方言差异，
 *   这些都容易让 Agent 和人都读错。这个工具把表达式翻译成中文，
 *   并直接给出未来若干次真实触发时刻（含夏令时影响）。
 */

const C = require('../utils/cron');
const T = require('../utils/time');
const fmt = require('./format');

const name = 'stamp_cron';
const title = 'Parse cron and predict next runs';
const description =
  '解析 cron 表达式：翻译成中文描述，并预测未来 N 次触发时刻（按指定时区，含夏令时影响）。' +
  '支持标准 5 段式（分 时 日 月 周）与 6 段式（秒 分 时 日 月 周）。' +
  '会明确指出"日与周同时限定时取 OR（满足其一即触发）"这一经典陷阱。' +
  '不支持 Quartz 扩展符（? L W #）。' +
  '当心：cron 表达式本身不含时区信息，触发时刻取决于运行服务器的时区，务必用 zone 参数说明你假设的时区。';

const inputSchema = {
  type: 'object',
  properties: {
    expression: {
      type: 'string',
      description:
        'cron 表达式。5 段：分 时 日 月 周，如 "0 9 * * 1-5"（工作日 9:00）；' +
        '6 段：秒 分 时 日 月 周，如 "0 0 9 * * 1-5"。' +
        '支持 * / , - 与名称（JAN-DEC、SUN-SAT）。'
    },
    expressions: {
      type: 'array',
      items: { type: 'string' },
      description: '批量解析多个表达式。与 expression 二选一。'
    },
    zone: {
      type: 'string',
      description: '按哪个时区预测触发时刻。默认 Asia/Shanghai。' +
        '注意 cron 表达式本身不带时区，请显式说明你的假设。',
      default: 'Asia/Shanghai'
    },
    from: {
      type: ['string', 'number'],
      description: '从哪个时刻开始预测（默认现在）。时间戳或日期字符串。'
    },
    count: {
      type: 'integer',
      description: '预测多少次触发，默认 5，最多 50。',
      default: 5
    },
    describe: {
      type: 'boolean',
      description: '是否输出中文描述，默认 true',
      default: true
    }
  },
  additionalProperties: false
};

/** 解析起点时刻 */
function resolveFrom(v, zone) {
  if (v === undefined || v === null || v === '') return Date.now();
  if (typeof v === 'number') return T.normalizeEpoch(v);
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) {
    const digits = s.replace('-', '').length;
    if (digits !== 8 && digits !== 14) return T.normalizeEpoch(Number(s));
  }
  return T.parseDateTime(s, zone).utc;
}

/** 渲染单个表达式的分析 */
function renderOne(expr, zone, fromUtc, count, withDescribe) {
  const c = C.parseCron(expr);

  const runs = C.nextRuns(c, fromUtc, count, zone);
  const desc = withDescribe ? C.describeCron(c) : '';

  const rows = runs.map((r, i) => [
    i + 1,
    T.formatInZone(r, zone),
    T.weekdayLabel(T.wallClockOf(r, zone).weekday),
    T.toIsoInZone(r, zone),
    Math.floor(r / 1000)
  ]);

  const w = T.wallClockOf(fromUtc, zone);
  let text = `表达式：\`${expr}\``;
  text += `\n段数：${c.fields} 段（${c.fields === 6 ? '含秒' : '不含秒'}）`;
  if (desc) text += `\n含义：${desc}`;
  text += `\n时区：${zone}（cron 表达式本身不含时区）`;
  text += `\n基准时刻：${T.formatInZone(fromUtc, zone)}（${T.weekdayLabel(w.weekday)}）`;

  if (runs.length === 0) {
    text += `\n\n⚠️ 在合理范围内（约 50 万次迭代）未找到下一次触发时刻。`;
    text += `\n常见原因：日期与星期组合永远无法同时满足（如 "0 0 30 2 *" 2 月 30 日），或月份/日期搭配不当。`;
  } else {
    text += fmt.section(`未来 ${runs.length} 次触发`);
    text += '\n' + fmt.table(['#', '时间', '星期', 'ISO 8601', 'epoch 秒'], rows, { colMax: 32 });

    // 间隔分析：能暴露"看起来是每天其实是每 2 天"这类误读
    if (runs.length >= 2) {
      const gaps = [];
      for (let i = 1; i < runs.length; i++) gaps.push(runs[i] - runs[i - 1]);
      const uniq = [...new Set(gaps)];
      text += fmt.section('触发间隔');
      if (uniq.length === 1) {
        text += `\n固定间隔：${T.humanizeDuration(uniq[0])}`;
      } else {
        text += '\n间隔不等长（这是正常的：如按"每月 1 号"触发，跨月天数不同）：';
        text += '\n  ' + gaps.map(g => T.humanizeDuration(g)).join(' → ');
      }
    }
  }

  // 危险语义提醒
  const traps = [];
  if (c.fields === 6) {
    traps.push('6 段式（秒 分 时 日 月 周）是非标准扩展，部分 cron 实现不认；标准 crontab 只有 5 段。');
  }
  if (!c.domStar && !c.dowStar) {
    traps.push('日字段与周字段**都不是 `*`**：标准 cron 语义是 **OR**（满足其一即触发），不是 AND。' +
      '如果你想要"每月 1 号且是周一"这种 AND 语义，cron 做不到，需要用脚本自行判断。');
  }
  if (!c.domStar && c.dowStar) {
    traps.push('日字段有限定。注意"每月 31 号"在 2/4/6/9/11 月不触发（那些月份没有 31 号）。');
  }
  if (traps.length) {
    text += fmt.section('⚠️ 语义提示');
    text += '\n' + fmt.list(traps);
  }

  return { text, parsed: c, runs, description: desc };
}

async function run(args = {}) {
  const zone = args.zone || 'Asia/Shanghai';
  if (!T.isValidTimeZone(zone)) {
    throw new Error(`无效的时区名 "${zone}"。`);
  }
  const count = Math.max(1, Math.min(50, args.count || 5));
  const fromUtc = resolveFrom(args.from, zone);
  const withDescribe = args.describe !== false;

  let list;
  if (Array.isArray(args.expressions) && args.expressions.length) {
    list = args.expressions;
  } else if (typeof args.expression === 'string' && args.expression.trim()) {
    list = [args.expression];
  } else if (args.expression !== undefined && args.expression !== null) {
    // 传了 expression 但为空串 / 纯空白：给出更贴切的错误，而不是笼统的"请提供"
    throw new Error('expression 不能为空字符串。请传入一个 cron 表达式，如 "0 9 * * 1-5"。');
  } else {
    throw new Error(
      '请提供 expression（单个表达式）或 expressions（数组）。\n' +
      '例：{"expression":"0 9 * * 1-5","zone":"Asia/Shanghai"}'
    );
  }

  if (list.length > 20) {
    throw new Error(`一次最多解析 20 个表达式，收到 ${list.length} 个。`);
  }

  /* ---------- 批量：紧凑表格 ---------- */
  if (list.length > 1) {
    const rows = [];
    const results = [];
    for (const expr of list) {
      try {
        const c = C.parseCron(expr);
        const runs = C.nextRuns(c, fromUtc, 1, zone);
        const desc = withDescribe ? C.describeCron(c) : '';
        rows.push([
          expr,
          c.fields + ' 段',
          desc || '—',
          runs.length ? T.formatInZone(runs[0], zone) : '⚠️ 永不触发',
          runs.length ? T.weekdayLabel(T.wallClockOf(runs[0], zone).weekday) : '—'
        ]);
        results.push({
          expression: expr,
          ok: true,
          fields: c.fields,
          description: desc,
          parsed: c,
          nextRun: runs.length ? runs[0] : null,
          nextRunLocal: runs.length ? T.formatInZone(runs[0], zone) : null
        });
      } catch (e) {
        rows.push([expr, '—', '❌ ' + e.message, '', '']);
        results.push({ expression: expr, ok: false, error: e.message });
      }
    }

    const w = T.wallClockOf(fromUtc, zone);
    let text = `共解析 ${list.length} 个表达式`;
    text += `\n时区：${zone}｜基准时刻：${T.formatInZone(fromUtc, zone)}（${T.weekdayLabel(w.weekday)}）`;
    text += fmt.section('解析结果');
    text += '\n' + fmt.table(['表达式', '段数', '含义', '下一次触发', '星期'], rows, { colMax: 46 });
    const failed = results.filter(r => !r.ok).length;
    if (failed) text += `\n\n⚠️ 其中 ${failed} 个解析失败，见上表 ❌ 行。`;
    text += `\n\n需要看未来多次触发与语义陷阱，请单独传 expression。`;

    return { ok: failed === 0, zone, count: list.length, failed, results, _text: text };
  }

  /* ---------- 单表达式 ---------- */
  const expr = list[0];

  let rendered;
  try {
    rendered = renderOne(expr, zone, fromUtc, count, withDescribe);
  } catch (e) {
    // 解析失败时给出友好提示而非堆栈
    throw new Error(
      `${e.message}\n\n` +
      '表达式格式：5 段 = 分 时 日 月 周；6 段 = 秒 分 时 日 月 周。\n' +
      '每段支持：* 任意 / a,b,c 枚举 / a-b 区间 / */n 步长 / a-b/n 区间步长。\n' +
      '月份与星期也接受名称：JAN-DEC、SUN-SAT（3 字母，不区分大小写）。\n' +
      '例："*/15 * * * *"（每 15 分钟）、"0 9 * * 1-5"（工作日 9:00）、"0 0 1 * *"（每月 1 号 0:00）。'
    );
  }

  return {
    ok: true,
    zone,
    expression: expr,
    fields: rendered.parsed.fields,
    description: rendered.description,
    parsed: rendered.parsed,
    nextRuns: rendered.runs,
    nextRunLocals: rendered.runs.map(r => T.formatInZone(r, zone)),
    nextRunIso: rendered.runs.map(r => T.toIsoInZone(r, zone)),
    _text: rendered.text
  };
}

module.exports = { name, title, description, inputSchema, run };
