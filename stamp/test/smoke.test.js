'use strict';
/**
 * Stamp 工具集冒烟测试（零依赖，node test/smoke.test.js）
 *
 * 覆盖范围：
 *   - time.js  ：时区偏移 / 墙钟↔UTC / 解析 / 时长 / 工作日
 *   - cron.js  ：字段解析 / 匹配 / 触发预测（含 DST 与闰年）/ 中文描述
 *   - 六个工具 ：正常路径 + 错误路径 + 边界
 *
 * 断言原则（血泪教训）：**期望值必须来自实测**，不能凭直觉写。
 * 凡是不确定的，先 `node -e "console.log(require('./src/utils/xxx.js').fn(...))"` 打印真实行为。
 */

const assert = require('assert');

const T = require('../src/utils/time');
const C = require('../src/utils/cron');

const now = require('../src/tools/stamp-now');
const convert = require('../src/tools/stamp-convert');
const duration = require('../src/tools/stamp-duration');
const zone = require('../src/tools/stamp-zone');
const workday = require('../src/tools/stamp-workday');
const cron = require('../src/tools/stamp-cron');

/* ============================ 迷你测试框架 ============================ */

let passed = 0;
let failed = 0;
const failures = [];
let currentSection = '(root)';

function section(title) {
  currentSection = title;
  console.log('\n■ ' + title);
}

function t(name, actual, expected) {
  const label = `${currentSection} › ${name}`;
  try {
    assert.deepStrictEqual(actual, expected);
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push({ label, actual, expected, message: e.message });
    console.log('  ✗ ' + name);
    console.log('      期望: ' + JSON.stringify(expected));
    console.log('      实际: ' + JSON.stringify(actual));
  }
}

function tOk(name, cond, hint) {
  const label = `${currentSection} › ${name}`;
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    failures.push({ label, message: hint || '断言为假' });
    console.log('  ✗ ' + name + (hint ? ' — ' + hint : ''));
  }
}

function tThrow(name, fn, msgIncludes) {
  const label = `${currentSection} › ${name}`;
  try {
    fn();
    failed++;
    failures.push({ label, message: '期望抛错但没有抛' });
    console.log('  ✗ ' + name + ' — 期望抛错但没有抛');
  } catch (e) {
    if (msgIncludes && !e.message.includes(msgIncludes)) {
      failed++;
      failures.push({ label, message: `错误信息不含 "${msgIncludes}"，实际: ${e.message}` });
      console.log('  ✗ ' + name + ` — 错误信息不含 "${msgIncludes}"`);
      console.log('      实际: ' + e.message);
    } else {
      passed++;
      console.log('  ✓ ' + name);
    }
  }
}

async function tThrowAsync(name, fn, msgIncludes) {
  const label = `${currentSection} › ${name}`;
  try {
    await fn();
    failed++;
    failures.push({ label, message: '期望抛错但没有抛' });
    console.log('  ✗ ' + name + ' — 期望抛错但没有抛');
  } catch (e) {
    if (msgIncludes && !e.message.includes(msgIncludes)) {
      failed++;
      failures.push({ label, message: `错误信息不含 "${msgIncludes}"，实际: ${e.message}` });
      console.log('  ✗ ' + name + ` — 错误信息不含 "${msgIncludes}"`);
    } else {
      passed++;
      console.log('  ✓ ' + name);
    }
  }
}

/* ============================ 固定基准 ============================ */

const SH = 'Asia/Shanghai';
const NY = 'America/New_York';

/** 2026-09-18 14:30:00 Asia/Shanghai == 2026-09-18T06:30:00Z */
const D1 = Date.UTC(2026, 8, 18, 6, 30, 0);
/** 2026-09-18 10:00:00 Asia/Shanghai（cron 基准） */
const CRON_BASE = Date.UTC(2026, 8, 18, 2, 0, 0);

/* ==================================================================== */
/*                              time.js                                 */
/* ==================================================================== */

section('time.js · 时区偏移');
t('tzOffsetMs 上海', T.tzOffsetMs(D1, SH), 8 * 3600000);
t('tzOffsetMs UTC', T.tzOffsetMs(D1, 'UTC'), 0);
t('tzOffsetMs 东京', T.tzOffsetMs(D1, 'Asia/Tokyo'), 9 * 3600000);
t('tzOffsetMs 纽约（9 月，夏令时）', T.tzOffsetMs(D1, NY), -4 * 3600000);
t('tzOffsetMs 纽约（1 月，标准时）', T.tzOffsetMs(Date.UTC(2026, 0, 15, 12), NY), -5 * 3600000);
t('formatOffset(+28800000)', T.formatOffset(28800000), '+08:00');
t('formatOffset(-18000000)', T.formatOffset(-18000000), '-05:00');
t('formatOffset(0)', T.formatOffset(0), '+00:00');

section('time.js · 时区校验');
tOk('isValidTimeZone 上海为真', T.isValidTimeZone(SH) === true);
tOk('isValidTimeZone UTC 为真', T.isValidTimeZone('UTC') === true);
tOk('isValidTimeZone 乱写为假', T.isValidTimeZone('Not/AZone') === false);
tOk('listTimeZones 返回数组且非空', Array.isArray(T.listTimeZones()) && T.listTimeZones().length > 100);
tOk('listTimeZones 含 Asia/Shanghai', T.listTimeZones().includes('Asia/Shanghai'));

section('time.js · 墙钟读数');
{
  const w = T.wallClockOf(D1, SH);
  t('wallClockOf 上海.year', w.y, 2026);
  t('wallClockOf 上海.month', w.mo, 9);
  t('wallClockOf 上海.day', w.d, 18);
  t('wallClockOf 上海.hour', w.h, 14);
  t('wallClockOf 上海.minute', w.mi, 30);
  t('wallClockOf 上海.weekday（周五）', w.weekday, 5);
  t('wallClockOf 上海.offset', w.offset, '+08:00');
  t('wallClockOf 上海.dst（中国无夏令时）', w.dst, false);
}
{
  const w = T.wallClockOf(D1, NY);
  t('wallClockOf 纽约.hour（夏令时 -4）', w.h, 2);
  t('wallClockOf 纽约.dst', w.dst, true);
  t('wallClockOf 纽约.offset', w.offset, '-04:00');
}

section('time.js · DST 判定（南北半球）');
t('纽约 7 月为夏令时', T.wallClockOf(Date.UTC(2026, 6, 15, 16), NY).dst, true);
t('纽约 1 月为标准时', T.wallClockOf(Date.UTC(2026, 0, 15, 17), NY).dst, false);
t('悉尼 1 月为夏令时（南半球）', T.wallClockOf(Date.UTC(2026, 0, 15, 1), 'Australia/Sydney').dst, true);
t('悉尼 7 月为标准时（南半球）', T.wallClockOf(Date.UTC(2026, 6, 15, 1), 'Australia/Sydney').dst, false);
t('伦敦 7 月为夏令时', T.wallClockOf(Date.UTC(2026, 6, 15, 12), 'Europe/London').dst, true);
t('上海恒为 false', T.wallClockOf(Date.UTC(2026, 6, 15, 12), SH).dst, false);
t('UTC 恒为 false', T.wallClockOf(Date.UTC(2026, 6, 15, 12), 'UTC').dst, false);

section('time.js · 墙钟 → UTC');
t('wallClockToUtc 上海 14:30', T.wallClockToUtc(2026, 9, 18, 14, 30, 0, SH), D1);
t('wallClockToUtc 纽约 2026-03-08 02:30（夏令时空洞）',
  T.wallClockToUtc(2026, 3, 8, 2, 30, 0, NY), null);
t('wallClockToUtc 纽约 2026-03-08 03:00 存在',
  T.wallClockToUtc(2026, 3, 8, 3, 0, 0, NY) !== null, true);

section('time.js · 格式化');
t('formatInZone 默认 pattern', T.formatInZone(D1, SH), '2026-09-18 14:30:00');
t('formatInZone 自定义 pattern', T.formatInZone(D1, SH, 'YYYY/MM/DD HH:mm'), '2026/09/18 14:30');
t('formatInZone Z 占位符', T.formatInZone(D1, SH, 'Z'), '+08:00');
t('formatInZone ZZ 占位符', T.formatInZone(D1, SH, 'ZZ'), '+0800');
t('formatInZone UTC', T.formatInZone(D1, 'UTC'), '2026-09-18 06:30:00');
t('toIsoInZone 上海', T.toIsoInZone(D1, SH), '2026-09-18T14:30:00+08:00');
t('toIsoInZone UTC', T.toIsoInZone(D1, 'UTC'), '2026-09-18T06:30:00+00:00');

section('time.js · epoch 量级识别');
t('detectEpochUnit 1758180000（10 位）', T.detectEpochUnit(1758180000), 'seconds');
t('detectEpochUnit 1758180000000（13 位）', T.detectEpochUnit(1758180000000), 'milliseconds');
t('detectEpochUnit 1758180000000000（16 位）', T.detectEpochUnit(1758180000000000), 'microseconds');
t('detectEpochUnit 1758180000000000000（19 位）', T.detectEpochUnit(1758180000000000000), 'nanoseconds');
t('normalizeEpoch 秒 → 毫秒', T.normalizeEpoch(1758180000), 1758180000000);
t('normalizeEpoch 毫秒不变', T.normalizeEpoch(1758180000000), 1758180000000);
t('normalizeEpoch 微秒 → 毫秒', T.normalizeEpoch(1758180000000000), 1758180000000);
tThrow('normalizeEpoch NaN 抛错', () => T.normalizeEpoch(NaN), '有效数字');

section('time.js · 日期解析');
t('parseDateTime ISO 带 Z', T.parseDateTime('2026-09-18T14:30:00Z', SH).utc, Date.UTC(2026, 8, 18, 14, 30));
t('parseDateTime ISO 带偏移', T.parseDateTime('2026-09-18T14:30:00+08:00', SH).utc, D1);
t('parseDateTime 纯日期按 zone 解释', T.parseDateTime('2026-09-18', SH).utc, Date.UTC(2026, 8, 17, 16));
t('parseDateTime 紧凑 8 位', T.parseDateTime('20260918', SH).utc, Date.UTC(2026, 8, 17, 16));
t('parseDateTime 紧凑 14 位', T.parseDateTime('20260918143000', SH).utc, D1);
t('parseDateTime 斜杠格式', T.parseDateTime('2026/09/18 14:30', SH).utc, D1);
t('parseDateTime hadOffset（带 Z）', T.parseDateTime('2026-09-18T14:30:00Z', SH).hadOffset, true);
t('parseDateTime hadOffset（纯日期）', T.parseDateTime('2026-09-18', SH).hadOffset, false);
t('parseDateTime hadTime（纯日期）', T.parseDateTime('2026-09-18', SH).hadTime, false);
tThrow('parseDateTime 乱写抛错', () => T.parseDateTime('随便写的', SH), '无法解析');
tThrow('parseDateTime 2 月 30 日抛错', () => T.parseDateTime('2026-02-30', SH), '只有 28 天');

section('time.js · 日历工具');
t('daysInMonth 2026-02', T.daysInMonth(2026, 2), 28);
t('daysInMonth 2028-02（闰年）', T.daysInMonth(2028, 2), 29);
t('daysInMonth 2026-09', T.daysInMonth(2026, 9), 30);
t('isLeapYear 2024', T.isLeapYear(2024), true);
t('isLeapYear 2026', T.isLeapYear(2026), false);
t('isLeapYear 1900（百年不闰）', T.isLeapYear(1900), false);
t('isLeapYear 2000（四百年闰）', T.isLeapYear(2000), true);
t('checkDateParts 2028-02-29 合法', T.checkDateParts(2028, 2, 29), undefined);
tThrow('checkDateParts 13 月抛错', () => T.checkDateParts(2026, 13, 1), '月份');
tThrow('checkDateParts 25 点抛错', () => T.checkDateParts(2026, 1, 1, 25), '小时');
tThrow('checkDateParts 61 分抛错', () => T.checkDateParts(2026, 1, 1, 0, 61), '分钟');

section('time.js · 星期');
t('weekdayLabel(1)', T.weekdayLabel(1), '周一');
t('weekdayLabel(5)', T.weekdayLabel(5), '周五');
t('weekdayLabel(7)', T.weekdayLabel(7), '周日');
t('weekdayLabel(0) 越界安全', T.weekdayLabel(0), '—');
t('jsDayToIso(0) → 7', T.jsDayToIso(0), 7);
t('jsDayToIso(1) → 1', T.jsDayToIso(1), 1);
tOk('WEEKDAY_NAMES 是名称→序号映射', T.WEEKDAY_NAMES['周五'] === 5 && T.WEEKDAY_NAMES.monday === 1);

section('time.js · 时长解析');
t('parseDuration 1h30m', T.parseDuration('1h30m'), 5400000);
t('parseDuration 90s', T.parseDuration('90s'), 90000);
t('parseDuration 2d', T.parseDuration('2d'), 172800000);
t('parseDuration 1w2d3h', T.parseDuration('1w2d3h'), 788400000);
t('parseDuration 1.5h', T.parseDuration('1.5h'), 5400000);
t('parseDuration 1天2小时', T.parseDuration('1天2小时'), 93600000);
t('parseDuration 30分钟', T.parseDuration('30分钟'), 1800000);
t('parseDuration 纯数字默认秒', T.parseDuration('90'), 90000);
t('parseDuration 纯数字指定单位', T.parseDuration('2', 'h'), 7200000);
t('parseDuration 1 分 30 秒', T.parseDuration('1分30秒'), 90000);
tThrow('parseDuration 乱写抛错', () => T.parseDuration('bogus'), '无法解析');

section('time.js · 时长人类可读');
t('humanizeDuration 3725000', T.humanizeDuration(3725000), '1h 2m 5s');
t('humanizeDuration 90000', T.humanizeDuration(90000), '1m 30s');
t('humanizeDuration 2000', T.humanizeDuration(2000), '2s');
t('humanizeDuration 0', T.humanizeDuration(0), '0s');
t('humanizeDuration 负数', T.humanizeDuration(-90000), '-1m 30s');

section('time.js · 工作日');
{
  // 2026-09-18 是周五
  const fri = Date.UTC(2026, 8, 17, 16); // 上海 2026-09-18 00:00
  const H = new Set();
  t('addWorkdays 周五 +1 → 周一', T.addWorkdays(fri, 1, SH, H), Date.UTC(2026, 8, 20, 16));
  t('addWorkdays 周五 +5 → 下周五', T.addWorkdays(fri, 5, SH, H), Date.UTC(2026, 8, 24, 16));
  t('addWorkdays 周五 -1 → 周四', T.addWorkdays(fri, -1, SH, H), Date.UTC(2026, 8, 16, 16));
  t('addWorkdays 跳过指定节假日', T.addWorkdays(fri, 1, SH, new Set(['2026-09-21'])), Date.UTC(2026, 8, 21, 16));
  t('countWorkdays 09-18 → 09-25', T.countWorkdays(fri, Date.UTC(2026, 8, 24, 16), SH, H), 5);
  t('isWorkday 周六为假', T.isWorkday({ y: 2026, mo: 9, d: 19, weekday: 6 }, H), false);
  t('isWorkday 周一为真', T.isWorkday({ y: 2026, mo: 9, d: 21, weekday: 1 }, H), true);
  t('isWorkday 节假日为假', T.isWorkday({ y: 2026, mo: 10, d: 1, weekday: 4 }, new Set(['2026-10-01'])), false);
}
t('dateKey 补零', T.dateKey({ y: 2026, mo: 9, d: 8 }), '2026-09-08');

/* ==================================================================== */
/*                              cron.js                                 */
/* ==================================================================== */

section('cron.js · 字段解析');
{
  const c5 = C.parseCron('0 9 * * 1-5');
  t('5 段式 fields', c5.fields, 5);
  t('5 段式 秒固定 {0}', [...c5.seconds], [0]);
  t('5 段式 分 {0}', [...c5.minutes], [0]);
  t('5 段式 时 {9}', [...c5.hours], [9]);
  t('5 段式 日 star', c5.domStar, true);
  t('5 段式 周 star', c5.dowStar, false);
  t('5 段式 周 1-5 展开', [...c5.dow].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  t('5 段式 月全量', c5.months.size, 12);

  const c6 = C.parseCron('30 0 9 * * 1-5');
  t('6 段式 fields', c6.fields, 6);
  t('6 段式 秒 {30}', [...c6.seconds], [30]);
  t('6 段式 分 {0}', [...c6.minutes], [0]);
  t('6 段式 时 {9}', [...c6.hours], [9]);

  const step = C.parseCron('*/15 * * * *');
  t('步长 */15', [...step.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  const range = C.parseCron('0 0-5/2 * * *');
  t('区间步长 0-5/2', [...range.hours].sort((a, b) => a - b), [0, 2, 4]);
  const list = C.parseCron('0 1,5,9 * * *');
  t('枚举 1,5,9', [...list.hours].sort((a, b) => a - b), [1, 5, 9]);
  const named = C.parseCron('0 9 * JAN-MAR MON');
  t('月份名称 JAN-MAR', [...named.months].sort((a, b) => a - b), [1, 2, 3]);
  t('星期名称 MON', [...named.dow], [1]);
  const domZero = C.parseCron('0 0 * * 0');
  t('周字段 0 视为周日 7', [...domZero.dow], [7]);

  tThrow('段数不对抛错', () => C.parseCron('0 9 * *'), '段');
  tThrow('非法字符抛错', () => C.parseCron('0 9 * * xyz'), '');
  tThrow('小时超界抛错', () => C.parseCron('0 25 * * *'), '');
  tThrow('Quartz 扩展 ? 被拒', () => C.parseCron('0 0 12 ? * *'), '');
  tThrow('Quartz 扩展 L 被拒', () => C.parseCron('0 0 12 * * L'), '');
}

section('cron.js · 静态可行性检查');
tThrow('2 月 30 日 → 永不触发', () => C.parseCron('0 0 30 2 *'), '永远不会触发');
tThrow('4 月 31 日 → 永不触发', () => C.parseCron('0 0 31 4 *'), '永远不会触发');
t('2 月 29 日合法', !!C.parseCron('0 0 29 2 *'), true);
t('1 月 31 日合法', !!C.parseCron('0 0 31 1 *'), true);
t('2 月 30 日 + 周字段（OR 语义）不判死', !!C.parseCron('0 0 30 2 1'), true);

section('cron.js · 触发预测（上海基准 2026-09-18 10:00 周五）');
{
  const f = CRON_BASE;
  const fmt1 = (r) => T.formatInZone(r, SH);

  const daily = C.nextRuns(C.parseCron('0 9 * * *'), f, 3, SH);
  t('每天 9:00 第一次是 09-19（跳过当天 10:00 之后）', fmt1(daily[0]), '2026-09-19 09:00:00');
  t('每天 9:00 第二次', fmt1(daily[1]), '2026-09-20 09:00:00');
  t('每天 9:00 第三次', fmt1(daily[2]), '2026-09-21 09:00:00');

  const q = C.nextRuns(C.parseCron('*/15 * * * *'), f, 3, SH);
  t('每 15 分第一次', fmt1(q[0]), '2026-09-18 10:15:00');
  t('每 15 分第二次', fmt1(q[1]), '2026-09-18 10:30:00');
  t('每 15 分第三次', fmt1(q[2]), '2026-09-18 10:45:00');

  const wd = C.nextRuns(C.parseCron('0 9 * * 1-5'), f, 3, SH);
  t('工作日 9:00 跳过周末（第一次周一）', fmt1(wd[0]), '2026-09-21 09:00:00');
  t('工作日 9:00 第二次', fmt1(wd[1]), '2026-09-22 09:00:00');
  t('工作日 9:00 第三次', fmt1(wd[2]), '2026-09-23 09:00:00');

  const monthly = C.nextRuns(C.parseCron('0 0 1 * *'), f, 3, SH);
  t('每月 1 号第一次', fmt1(monthly[0]), '2026-10-01 00:00:00');
  t('每月 1 号第二次', fmt1(monthly[1]), '2026-11-01 00:00:00');
  t('每月 1 号第三次', fmt1(monthly[2]), '2026-12-01 00:00:00');

  const sunday = C.nextRuns(C.parseCron('30 2 * * 0'), f, 3, SH);
  t('每周日 02:30 第一次', fmt1(sunday[0]), '2026-09-20 02:30:00');
  t('每周日 02:30 第二次', fmt1(sunday[1]), '2026-09-27 02:30:00');

  const leap = C.nextRuns(C.parseCron('0 0 29 2 *'), f, 3, SH);
  t('2 月 29 日第一次（2028 闰年）', fmt1(leap[0]), '2028-02-29 00:00:00');
  t('2 月 29 日第二次（2032）', fmt1(leap[1]), '2032-02-29 00:00:00');
  t('2 月 29 日第三次（2036）', fmt1(leap[2]), '2036-02-29 00:00:00');

  const or = C.nextRuns(C.parseCron('0 0 1 * 1'), f, 3, SH);
  t('日/周 OR 语义：09-21 周一', fmt1(or[0]), '2026-09-21 00:00:00');
  t('日/周 OR 语义：09-28 周一', fmt1(or[1]), '2026-09-28 00:00:00');
  t('日/周 OR 语义：10-01（月度触发点）', fmt1(or[2]), '2026-10-01 00:00:00');

  t('count=0 返回空数组', C.nextRuns(C.parseCron('0 9 * * *'), f, 0, SH), []);
}

section('cron.js · DST 边界（这是最难的场景）');
{
  // 纽约 2026-03-08 02:00→03:00 跳表：当天的 02:xx 不存在
  const beforeSpring = T.parseDateTime('2026-03-07T00:00:00', NY).utc;
  const r1 = C.nextRuns(C.parseCron('30 2 * * *'), beforeSpring, 4, NY);
  const fmtNY = (x) => T.formatInZone(x, NY);
  t('春季跳表：03-07 正常', fmtNY(r1[0]), '2026-03-07 02:30:00');
  t('春季跳表：03-08 被正确跳过', fmtNY(r1[1]), '2026-03-09 02:30:00');
  t('春季跳表：03-09 正常', fmtNY(r1[2]), '2026-03-10 02:30:00');

  const r2 = C.nextRuns(C.parseCron('0 2 * * *'), beforeSpring, 3, NY);
  t('春季跳表（02:00）：03-08 被跳过', fmtNY(r2[1]), '2026-03-09 02:00:00');

  // 纽约 2026-11-01 01:00 回拨：01:xx 出现两次，取更早一次
  const beforeFall = T.parseDateTime('2026-10-31T00:00:00', NY).utc;
  const r3 = C.nextRuns(C.parseCron('30 1 * * *'), beforeFall, 3, NY);
  t('秋季回拨：10-31 正常', fmtNY(r3[0]), '2026-10-31 01:30:00');
  t('秋季回拨：11-01 取更早一次', fmtNY(r3[1]), '2026-11-01 01:30:00');
  t('秋季回拨：11-02 恢复', fmtNY(r3[2]), '2026-11-02 01:30:00');

  // 上海无夏令时，全年偏移一致
  const shAll = C.nextRuns(C.parseCron('0 0 * * *'), CRON_BASE, 5, SH);
  const shOffsets = shAll.map(x => T.wallClockOf(x, SH).offset);
  tOk('上海连续 5 天偏移全是 +08:00', shOffsets.every(o => o === '+08:00'));
}

section('cron.js · 中文描述');
t('0 9 * * 1-5 描述', C.describeCron(C.parseCron('0 9 * * 1-5')), '第 0 分 · 9 点 · 每周一、二、三、四、五');
t('*/15 描述', C.describeCron(C.parseCron('*/15 * * * *')), '第 0,15,30,45 分 · 每小时 · 每天');
t('0 0 1 * * 描述', C.describeCron(C.parseCron('0 0 1 * *')), '第 0 分 · 0 点 · 每月 1 号');
t('0 0 29 2 * 描述（月+日合并）', C.describeCron(C.parseCron('0 0 29 2 *')), '第 0 分 · 0 点 · 2 月的 29 号');
t('0 0 1 * 1 描述（OR 语义）',
  C.describeCron(C.parseCron('0 0 1 * 1')),
  '第 0 分 · 0 点 · 每月 1 号**或**每周一（两者满足其一）');

section('cron.js · matchesCron');
{
  const c = C.parseCron('30 14 * * *');
  const hit = T.wallClockOf(D1, SH); // 2026-09-18 14:30
  t('命中 14:30', C.matchesCron(c, hit), true);
  const miss = T.wallClockOf(Date.UTC(2026, 8, 18, 6, 31), SH);
  t('不命中 14:31', C.matchesCron(c, miss), false);
}

/* ==================================================================== */
/*                          工具：stamp_now                              */
/* ==================================================================== */

section('stamp_now · 正常路径');
(async () => {
  const r = await now.run({});
  tOk('返回 now 时间戳', typeof r.now === 'number' && r.now > 0);
  t('默认主时区', r.timeZone, SH);
  tOk('epoch.seconds 是 10 位', String(r.epoch.seconds).length === 10);
  tOk('epoch.milliseconds 是 13 位', String(r.epoch.milliseconds).length === 13);
  tOk('timeZones 含上海与 UTC', r.timeZones.length === 2 &&
    r.timeZones[0].timeZone === SH && r.timeZones[1].timeZone === 'UTC');
  tOk('bounds 含 today/week/month/year',
    !!(r.bounds.today && r.bounds.week && r.bounds.month && r.bounds.year));
  tOk('weekdayName 是中文星期', /^周[一二三四五六日]$/.test(r.weekdayName));
  tOk('_text 含"现在"', r._text.includes('现在'));
  tOk('epoch 秒与毫秒自洽', r.epoch.milliseconds === r.epoch.seconds * 1000 + (r.now % 1000));

  const r2 = await now.run({ timeZones: ['Asia/Tokyo', 'Europe/London', 'UTC'], zone: 'Asia/Tokyo' });
  t('自定义时区列表长度', r2.timeZones.length, 3);
  t('主时区生效', r2.timeZone, 'Asia/Tokyo');
  tOk('东京偏移 +09:00', r2.timeZones[0].utcOffset === '+09:00');

  const r3 = await now.run({ zone: SH, weekdayStart: 7 });
  tOk('weekdayStart=7 时本周从周日开始',
    T.wallClockOf(r3.bounds.week.from, SH).weekday === 7);

  await tThrowAsync('无效时区抛错', () => now.run({ zone: 'Bad/Zone' }), '无效的时区名');
  await tThrowAsync('无效 timeZones 元素抛错', () => now.run({ timeZones: ['Bad/Zone'] }), '无效的时区名');

  /* ================================================================ */
  /*                      工具：stamp_convert                          */
  /* ================================================================ */

  section('stamp_convert · epoch 输入');
  {
    const r = await convert.run({ value: 1758180000, zone: SH });
    t('秒级时间戳识别', r.kind, 'epoch');
    t('秒级时间戳单位', r.detail, 'seconds');
    t('秒级时间戳结果 UTC', r.isoUtc, '2025-09-18T07:20:00.000Z');
    t('秒级时间戳本地', r.local, '2025-09-18 15:20:00');

    const rm = await convert.run({ value: 1758180000000, zone: SH, to: 'epoch-s' });
    t('毫秒级识别', rm.detail, 'milliseconds');
    t('毫秒转秒输出', rm.output, '1758180000');

    const ru = await convert.run({ value: 1758180000000000, zone: SH });
    t('微秒级识别', ru.detail, 'microseconds');
  }

  section('stamp_convert · 日期字符串输入');
  {
    const rz = await convert.run({ value: '2026-09-18T14:30:00Z', zone: SH });
    t('带 Z 的 ISO 识别', rz.kind, 'datetime');
    t('带 Z 的 ISO 说明', rz.detail, '自带时区偏移');
    t('带 Z 的 ISO 转为上海时间', rz.local, '2026-09-18 22:30:00');
    t('带 Z 的 ISO UTC 不变', rz.isoUtc, '2026-09-18T14:30:00.000Z');

    const ro = await convert.run({ value: '2026-09-18T14:30:00+08:00', zone: SH });
    t('带 +08:00 偏移', ro.isoUtc, '2026-09-18T06:30:00.000Z');

    const rd = await convert.run({ value: '2026-09-18', zone: SH });
    t('纯日期按 zone 解释', rd.isoUtc, '2026-09-17T16:00:00.000Z');
    t('纯日期说明含时区', rd.detail.includes(SH), true);

    const rc = await convert.run({ value: '20260918', zone: SH });
    t('紧凑 8 位识别为 datetime 而非 epoch', rc.kind, 'datetime');
    t('紧凑 8 位结果', rc.isoUtc, '2026-09-17T16:00:00.000Z');

    const rc14 = await convert.run({ value: '20260918143000', zone: SH });
    t('紧凑 14 位识别', rc14.kind, 'datetime');
    t('紧凑 14 位结果', rc14.isoUtc, '2026-09-18T06:30:00.000Z');
  }

  section('stamp_convert · 输出格式');
  {
    const base = { value: '2026-09-18T14:30:00Z', zone: SH };
    t('to=local', (await convert.run({ ...base, to: 'local' })).output, '2026-09-18 22:30:00');
    t('to=date', (await convert.run({ ...base, to: 'date' })).output, '2026-09-18');
    t('to=time', (await convert.run({ ...base, to: 'time' })).output, '22:30:00');
    t('to=utc', (await convert.run({ ...base, to: 'utc' })).output, '2026-09-18T14:30:00.000Z');
    t('to=epoch-ms', (await convert.run({ ...base, to: 'epoch-ms' })).output, '1789741800000');
    t('to=rfc（UTC）', (await convert.run({ value: '2026-09-18T14:30:00Z', zone: 'UTC', to: 'rfc' })).output,
      'Fri, 18 Sep 2026 14:30:00 +0000');
    t('to=自定义 pattern', (await convert.run({ ...base, to: 'YYYY/MM/DD' })).output, '2026/09/18');

    const all = await convert.run({ ...base, all: true });
    tOk('all=true 返回 formats 列表', Array.isArray(all.formats) && all.formats.length >= 12);
    tOk('all=true 含 RFC 2822 行', all.formats.some(f => f.name.includes('RFC')));
    tOk('all=true 含纳秒', all.formats.some(f => f.name.includes('纳秒')));
  }

  section('stamp_convert · 相对表达与批量');
  {
    const rn = await convert.run({ value: 'now', zone: SH });
    t('now 识别', rn.kind, 'relative');
    tOk('now 与当前时间接近', Math.abs(rn.utc - Date.now()) < 5000);

    const rt = await convert.run({ value: 'today', zone: SH });
    t('today 是当天 00:00', rt.local.slice(-8), '00:00:00');

    const ry = await convert.run({ value: 'yesterday', zone: SH });
    tOk('yesterday 比 today 早一天', (await convert.run({ value: 'today', zone: SH })).utc - ry.utc === 86400000);

    const rb = await convert.run({ values: ['now', 1758180000, '20260918', 'nonsense'], zone: SH });
    t('批量计数', rb.count, 4);
    t('批量失败计数', rb.failed, 1);
    t('批量结果条数', rb.results.length, 4);
    t('批量第 1 条 ok', rb.results[0].ok, true);
    t('批量第 4 条 not ok', rb.results[3].ok, false);
    tOk('批量表格含失败标记', rb._text.includes('❌'));
  }

  section('stamp_convert · 错误路径');
  await tThrowAsync('无 value 也无 values 抛错', () => convert.run({}), '请提供 value');
  await tThrowAsync('无效 zone 抛错', () => convert.run({ value: 'now', zone: 'Bad/Zone' }), '无效的时区名');
  await tThrowAsync('无效 outZone 抛错',
    () => convert.run({ value: 'now', zone: SH, outZone: 'Bad/Zone' }), '无效的输出时区名');
  await tThrowAsync('超过 200 个值抛错',
    () => convert.run({ values: Array.from({ length: 201 }, () => 'now'), zone: SH }), '最多转换 200 个值');

  /* ================================================================ */
  /*                     工具：stamp_duration                          */
  /* ================================================================ */

  section('stamp_duration · 单值解析');
  {
    const r = await duration.run({ value: '1h30m' });
    t('1h30m → 毫秒', r.ms, 5400000);
    t('1h30m → 秒', r.units.s, 5400);
    t('1h30m → 分钟', r.units.m, 90);
    t('1h30m → 小时', r.units.h, 1.5);
    t('1h30m 人类可读', r.human, '1h 30m');
    t('auto 推荐单位为小时', r.unit, 'h');

    const r2 = await duration.run({ value: 90 });
    t('纯数字默认按秒', r2.ms, 90000);
    t('90s 人类可读', r2.human, '1m 30s');

    const r3 = await duration.run({ value: '2d', unit: 'h' });
    t('unit 指定换算', r3.value, 48);
    t('unit 字段回显', r3.unit, 'h');

    const r4 = await duration.run({ value: '1天2小时' });
    t('中文时长 1天2小时 → 小时', r4.units.h, 26);
  }

  section('stamp_duration · 间隔模式');
  {
    const r = await duration.run({ from: '2026-09-18', to: '2026-09-25' });
    t('模式为 interval', r.mode, 'interval');
    t('间隔毫秒', r.deltaMs, 604800000);
    t('间隔天数', r.units.d, 7);
    t('间隔人类可读', r.human, '1w');
    tOk('_text 含"间隔"', r._text.includes('间隔'));

    const rev = await duration.run({ from: '2026-09-25', to: '2026-09-18' });
    t('反向间隔为负', rev.deltaMs, -604800000);
    t('反向绝对值正确', rev.absoluteMs, 604800000);

    const tzr = await duration.run({ from: '2026-09-18T14:30:00Z', to: '2026-09-18T16:00:00Z' });
    t('跨时区解析仍按绝对时刻', tzr.deltaMs, 5400000);
  }

  section('stamp_duration · 批量与错误');
  {
    const r = await duration.run({ values: ['90s', '2d', '1w2d3h', '30分钟', 'bogus'] });
    t('批量计数', r.count, 5);
    t('批量失败计数', r.failed, 1);
    t('批量 2d 秒数', r.results[1].seconds, 172800);
    t('批量 1w2d3h 小时', r.results[2].hours, 219);
  }
  await tThrowAsync('无参抛错', () => duration.run({}), '请提供 value');
  await tThrowAsync('无效 defaultUnit 抛错',
    () => duration.run({ value: '1h', defaultUnit: 'x' }), 'defaultUnit');
  await tThrowAsync('无效 zone 抛错', () => duration.run({ value: '1h', zone: 'Bad/Zone' }), '无效的时区名');

  /* ================================================================ */
  /*                       工具：stamp_zone                            */
  /* ================================================================ */

  section('stamp_zone · 换算');
  {
    const r = await zone.run({
      time: '2026-09-18T14:30:00', from: SH,
      toZones: [SH, 'Asia/Tokyo', 'Europe/London', NY, 'UTC']
    });
    t('模式为 convert', r.mode, 'convert');
    t('返回 5 个时区', r.timeZones.length, 5);
    t('上海本地时间', r.timeZones[0].local, '2026-09-18 14:30:00');
    t('东京本地时间', r.timeZones[1].local, '2026-09-18 15:30:00');
    t('伦敦偏移（夏令时）', r.timeZones[2].utcOffset, '+01:00');
    t('纽约偏移（夏令时）', r.timeZones[3].utcOffset, '-04:00');
    t('hasDst 为真', r.hasDst, true);
    tOk('_text 提示夏令时', r._text.includes('夏令时'));

    const winter = await zone.run({
      time: '2026-01-15T14:30:00', from: SH, toZones: [NY]
    });
    t('冬季纽约偏移 -05:00', winter.timeZones[0].utcOffset, '-05:00');
    t('冬季不处于夏令时', winter.timeZones[0].isDst, false);
    t('冬季无 DST 提示段落', winter._text.includes('夏令时提示'), false);
  }

  section('stamp_zone · 跨日提醒');
  {
    const r = await zone.run({
      time: '2026-09-18T14:30:00', from: SH, toZones: [SH, NY, 'America/Los_Angeles']
    });
    tOk('检测到跨日', r.dayShift.length >= 1);
    const la = r.dayShift.find(d => d.zone === 'America/Los_Angeles');
    tOk('洛杉矶日期早 1 天', la && la.days === -1);
    tOk('_text 含跨日提醒', r._text.includes('跨日提醒'));
  }

  section('stamp_zone · 时区信息查询');
  {
    const ny = await zone.run({ zoneInfo: NY, year: 2026 });
    t('纽约标准时', ny.standardOffset, '-05:00');
    t('纽约夏令时', ny.dstOffset, '-04:00');
    t('纽约使用 DST', ny.usesDst, true);
    t('纽约调整 60 分钟', ny.dstShiftMinutes, 60);
    t('纽约进入夏令时日期', ny.dstStart.date, '2026-03-09');
    t('纽约退出夏令时日期', ny.dstEnd.date, '2026-11-02');
    t('纽约进入时偏移变化', ny.dstStart.to, '-04:00');

    const sh = await zone.run({ zoneInfo: SH, year: 2026 });
    t('上海标准时', sh.standardOffset, '+08:00');
    t('上海不使用 DST', sh.usesDst, false);
    t('上海 dstOffset 为 null', sh.dstOffset, null);

    // 南半球：进入夏令时应在春季（10 月），退出在秋季（4 月）
    const syd = await zone.run({ zoneInfo: 'Australia/Sydney', year: 2026 });
    t('悉尼标准时 +10:00', syd.standardOffset, '+10:00');
    t('悉尼夏令时 +11:00', syd.dstOffset, '+11:00');
    t('悉尼进入夏令时在 10 月（南半球）', syd.dstStart.date, '2026-10-04');
    t('悉尼退出夏令时在 4 月（南半球）', syd.dstEnd.date, '2026-04-05');

    const akl = await zone.run({ zoneInfo: 'Pacific/Auckland', year: 2026 });
    t('奥克兰进入夏令时在 9 月（南半球）', akl.dstStart.date, '2026-09-27');
    t('奥克兰退出夏令时在 4 月（南半球）', akl.dstEnd.date, '2026-04-05');

    const utc = await zone.run({ zoneInfo: 'UTC', year: 2026 });
    t('UTC 不使用 DST', utc.usesDst, false);
  }

  section('stamp_zone · 默认与错误');
  {
    const r = await zone.run({ time: '2026-09-18T14:30:00' });
    tOk('默认目标含上海与 UTC',
      r.timeZones.some(z => z.timeZone === SH) && r.timeZones.some(z => z.timeZone === 'UTC'));

    const nowRun = await zone.run({});
    tOk('省略 time 用现在', Math.abs(nowRun.utc - Date.now()) < 5000);

    const single = await zone.run({ time: '2026-09-18T14:30:00', from: SH, to: NY });
    tOk('单目标时附时区概览', single._text.includes('时区概览'));
  }

  await tThrowAsync('无效 from 抛错', () => zone.run({ from: 'Bad/Zone' }), '无效的源时区名');
  await tThrowAsync('无效 to 抛错', () => zone.run({ to: 'Bad/Zone' }), '无效的目标时区名');
  await tThrowAsync('无效 zoneInfo 抛错', () => zone.run({ zoneInfo: 'Bad/Zone' }), '无效的时区名');

  /* ================================================================ */
  /*                     工具：stamp_workday                           */
  /* ================================================================ */

  section('stamp_workday · add 模式');
  {
    const r = await workday.run({ date: '2026-09-18', days: 5 });
    t('模式为 add', r.mode, 'add');
    t('5 工作日后', r.resultLocal, '2026-09-25 00:00:00');
    t('结果星期为周五', r.resultWeekday, '周五');
    t('跨越日历天 7 天', r.calendarDays, 7);
    t('基准是工作日', r.baseIsWorkday, true);

    const r2 = await workday.run({ date: '2026-09-18', days: -3 });
    t('3 工作日前', r2.resultLocal, '2026-09-15 00:00:00');
    t('往前方向结果为周二', r2.resultWeekday, '周二');

    const r3 = await workday.run({ date: '2026-09-18', days: 1 });
    t('周五 +1 工作日跳过周末到周一', r3.resultLocal, '2026-09-21 00:00:00');

    // 国庆长假：09-30 +5 工作日应跨过 10-01..10-07 与周末，落在 10-13
    const r4 = await workday.run({
      date: '2026-09-30', days: 5,
      holidays: ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'],
      workdays: ['2026-10-10']
    });
    t('含节假日与调休的推算', r4.resultLocal, '2026-10-13 00:00:00');
    t('holidays 被记录', r4.holidays.length, 5);
    t('workdays 被记录', r4.makeupWorkdays.length, 1);
  }

  section('stamp_workday · count 模式');
  {
    const r = await workday.run({ from: '2026-09-01', to: '2026-09-30' });
    t('模式为 count', r.mode, 'count');
    t('9 月 1→30 日历天数（不含起点含终点）', r.totalDays, 29);
    t('9 月 1→30 工作日数', r.workdays, 21);
    t('9 月 1→30 周末数', r.weekends, 8);

    const r2 = await workday.run({
      from: '2026-09-28', to: '2026-10-11',
      holidays: ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'],
      workdays: ['2026-10-10']
    });
    t('国庆区间工作日数', r2.workdays, 5);
    t('国庆区间法定假期数', r2.holidaysHit, 5);
    t('国庆区间调休数', r2.makeupHit, 1);
    t('国庆区间周末数', r2.weekends, 4);

    const inc = await workday.run({ from: '2026-09-01', to: '2026-09-30', includeBoundary: true });
    t('含起点后日历天数 +1', inc.totalDays, 30);
  }

  section('stamp_workday · check 模式');
  {
    const fri = await workday.run({ date: '2026-09-18' });
    t('模式为 check', fri.mode, 'check');
    t('周五是工作日', fri.isWorkday, true);
    t('周五原因', fri.reason, '正常工作日');

    const sat = await workday.run({ date: '2026-09-19' });
    t('周六不是工作日', sat.isWorkday, false);
    t('周六原因', sat.reason, '周末');
    t('周六 isWeekend', sat.isWeekend, true);

    const hol = await workday.run({ date: '2026-10-01', holidays: ['2026-10-01'] });
    t('法定假期不是工作日', hol.isWorkday, false);
    t('法定假期原因', hol.reason, '法定假期');
    t('法定假期 isHoliday', hol.isHoliday, true);

    const mk = await workday.run({ date: '2026-10-10', workdays: ['2026-10-10'] });
    t('调休的周六是工作日', mk.isWorkday, true);
    t('调休原因', mk.reason, '调休上班日（虽是周末但算工作日）');
    t('调休 isMakeupWorkday', mk.isMakeupWorkday, true);
  }

  section('stamp_workday · 错误路径');
  await tThrowAsync('add 缺 days 抛错', () => workday.run({ mode: 'add', date: '2026-09-18' }), '需要提供 days');
  await tThrowAsync('days=0 抛错', () => workday.run({ date: '2026-09-18', days: 0 }), '非零整数');
  await tThrowAsync('count 缺 to 抛错', () => workday.run({ mode: 'count', from: '2026-09-01' }), '同时提供 from 与 to');
  await tThrowAsync('count 反向抛错',
    () => workday.run({ from: '2026-09-30', to: '2026-09-01' }), 'to 不能早于 from');
  await tThrowAsync('holidays 格式错抛错',
    () => workday.run({ date: '2026-09-18', holidays: ['2026/10/01'] }), '格式不对');
  await tThrowAsync('holidays 非法日期抛错',
    () => workday.run({ date: '2026-09-18', holidays: ['2026-02-30'] }), '只有 28 天');
  await tThrowAsync('holidays 与 workdays 冲突抛错',
    () => workday.run({ date: '2026-09-18', holidays: ['2026-10-01'], workdays: ['2026-10-01'] }),
    '同时出现在');
  await tThrowAsync('未知 mode 抛错',
    () => workday.run({ mode: 'nope', date: '2026-09-18' }), '未知的 mode');
  await tThrowAsync('无效 zone 抛错',
    () => workday.run({ date: '2026-09-18', zone: 'Bad/Zone' }), '无效的时区名');

  /* ================================================================ */
  /*                       工具：stamp_cron                            */
  /* ================================================================ */

  section('stamp_cron · 单表达式');
  {
    const r = await cron.run({ expression: '0 9 * * 1-5', zone: SH, from: CRON_BASE, count: 3 });
    t('ok 为真', r.ok, true);
    t('段数为 5', r.fields, 5);
    t('描述正确', r.description, '第 0 分 · 9 点 · 每周一、二、三、四、五');
    t('返回 3 次触发', r.nextRuns.length, 3);
    t('第一次触发本地时间', r.nextRunLocals[0], '2026-09-21 09:00:00');
    t('第二次触发本地时间', r.nextRunLocals[1], '2026-09-22 09:00:00');
    tOk('_text 含时区说明', r._text.includes('cron 表达式本身不含时区'));
    tOk('_text 含触发间隔', r._text.includes('触发间隔'));
  }

  section('stamp_cron · 语义陷阱提示');
  {
    const r = await cron.run({ expression: '0 0 1 * 1', zone: SH, from: CRON_BASE, count: 2 });
    tOk('日/周同时限定时提示 OR 语义', r._text.includes('OR'));

    const r2 = await cron.run({ expression: '0 0 29 2 *', zone: SH, from: CRON_BASE, count: 1 });
    tOk('日字段限定时提示月份天数陷阱', r2._text.includes('31 号'));

    const r3 = await cron.run({ expression: '0 0 9 * * 1-5', zone: SH, from: CRON_BASE, count: 1 });
    t('6 段式段数', r3.fields, 6);
    tOk('6 段式提示非标准扩展', r3._text.includes('非标准扩展'));
  }

  section('stamp_cron · 批量');
  {
    const r = await cron.run({ expressions: ['0 9 * * 1-5', '*/15 * * * *', 'bogus expr', '0 0 30 2 *'] });
    t('批量计数', r.count, 4);
    t('批量失败计数（bogus + 2月30日）', r.failed, 2);
    t('批量第一条 ok', r.results[0].ok, true);
    t('批量第一条下一次触发', r.results[0].nextRunLocal, '2026-09-21 09:00:00');
    t('批量第三条 not ok', r.results[2].ok, false);
    tOk('批量表格含失败标记', r._text.includes('❌'));
  }

  section('stamp_cron · 错误路径');
  await tThrowAsync('无表达式抛错', () => cron.run({}), '请提供 expression');
  await tThrowAsync('无效 zone 抛错', () => cron.run({ expression: '0 9 * * *', zone: 'Bad/Zone' }), '无效的时区名');
  await tThrowAsync('非法表达式给出格式指引',
    () => cron.run({ expression: 'bogus', zone: SH }), '表达式格式');
  await tThrowAsync('超过 20 个表达式抛错',
    () => cron.run({ expressions: Array.from({ length: 21 }, () => '* * * * *') }), '最多解析 20 个');
  await tThrowAsync('空字符串抛错', () => cron.run({ expression: '', zone: SH }), '不能为空');

  /* ==================================================================== */
  /*                                 汇总                                 */
  /* ==================================================================== */

  console.log('\n' + '='.repeat(60));
  console.log(`通过 ${passed} 项，失败 ${failed} 项，共 ${passed + failed} 项`);
  if (failed > 0) {
    console.log('\n失败明细：');
    for (const f of failures) {
      console.log('  ✗ ' + f.label);
      console.log('    ' + f.message);
      if (f.actual !== undefined) {
        console.log('    期望: ' + JSON.stringify(f.expected));
        console.log('    实际: ' + JSON.stringify(f.actual));
      }
    }
    process.exit(1);
  }
  console.log('全部通过 ✓');
})();
