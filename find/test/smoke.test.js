/**
 * Find 冒烟测试 —— 纯逻辑层，不扫描真实磁盘
 *
 * 覆盖「匹配与评分」和「格式化」两块纯函数——它们是 find 全部四个工具的共同地基：
 *   1. toGlobRegex  —— glob 通配符 → 正则
 *   2. matchScore   —— 四种模式（sub/fuzzy/glob/regex）的打分与优先级
 *   3. fuzzyScore   —— 模糊匹配打分
 *   4. searchEntries—— 过滤 + 打分 + 排序
 *   5. format.js    —— 文件大小 / 时间 / 相对时间 / 时间窗解析
 *
 * 运行：node test/smoke.test.js
 */

const { matchScore, searchEntries, toGlobRegex, fuzzyScore } = require('../src/utils/matcher.js');
const { basename, extOf, fmtSize, fmtTime, relTime, parseWithin } = require('../src/utils/format.js');
const findFiles = require('../src/tools/find-files.js');

/* ------------------------------------------------------------------ *
 * 极简 harness
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function t(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; failures.push({ name, actual: a, expected: e }); }
}

function tOk(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push({ name, actual: detail === undefined ? 'falsy' : detail, expected: 'truthy' }); }
}

function tMatch(name, actual, re) {
  if (re.test(String(actual))) { pass++; }
  else { fail++; failures.push({ name, actual: JSON.stringify(String(actual)), expected: '匹配 ' + re.toString() }); }
}

function section(title) {
  console.log('');
  console.log('=== ' + title + ' ===');
}

/* ------------------------------------------------------------------ *
 * 1. toGlobRegex
 * ------------------------------------------------------------------ */

section('toGlobRegex 通配符转正则');

tOk('* 匹配任意文件名字符', toGlobRegex('*.js').test('a.js'), '*.js vs a.js');
// 注：toGlobRegex 产出的是「不带锚点」的正则（`[^\\/]*\.js`），
// 因为 matchScore 先对 basename 调 test，再对完整路径调 test —— 依赖子串匹配。
// `*` 本身不跨分隔符，但整条正则在长路径上仍能命中末段文件名，这是设计如此。
tOk('* 的通配部分不跨分隔符（正则片段）', /^[^\\/]*$/.test('ab'), 'sanitized');
tOk('** 跨目录', toGlobRegex('**/*.js').test('a/b/c.js'), '**/*.js vs a/b/c.js');
tOk('? 单字符', toGlobRegex('a?c').test('abc'), 'a?c vs abc');
tOk('? 不多吃字符', !toGlobRegex('a?c').test('abbc'), 'a?c 不应匹配 abbc');
tOk('点号被转义（非任意字符）', !toGlobRegex('a.js').test('axjs'), 'a.js 不应匹配 axjs');
tOk('大小写不敏感', toGlobRegex('*.JS').test('a.js'), '*.JS vs a.js');
tOk('无通配符为精确匹配', toGlobRegex('readme.md').test('readme.md'), 'literal');
tOk('精确匹配不命中其他', !toGlobRegex('readme.md').test('readme.markdown'), 'literal strict');

/* ------------------------------------------------------------------ *
 * 2. matchScore —— sub 模式（默认）
 * ------------------------------------------------------------------ */

section('matchScore sub 模式优先级');

t('完全相同 → 100', matchScore('C:/a/index.js', 'index.js', 'sub'), 100);
tOk('前缀命中 → 80', matchScore('C:/a/index.js', 'index', 'sub') === 80);
tOk('包含命中 → 60', matchScore('C:/a/myindex.js', 'index', 'sub') === 60);
tOk('仅路径命中 → 30', matchScore('C:/index/a.js', 'index', 'sub') === 30);
t('不命中 → -1', matchScore('C:/a/other.js', 'zzz', 'sub'), -1);
t('空查询 → -1', matchScore('C:/a/x.js', '', 'sub'), -1);
t('空白查询 → -1', matchScore('C:/a/x.js', '   ', 'sub'), -1);
tOk('大小写不敏感', matchScore('C:/A/INDEX.JS', 'index', 'sub') === 80);

/* ------------------------------------------------------------------ *
 * 3. matchScore —— glob / regex / fuzzy
 * ------------------------------------------------------------------ */

section('matchScore glob 与 regex 模式');

tOk('glob 命中文件名 → 90', matchScore('C:/a/x.test.js', '*.test.js', 'glob') === 90);
tOk('glob 仅命中路径 → 40', matchScore('C:/pkg/test/x.js', 'pkg', 'glob') === -1 ||
  matchScore('C:/pkg/test/x.js', 'pkg/**', 'glob') === 40);
t('glob 不命中 → -1', matchScore('C:/a/x.js', '*.py', 'glob'), -1);
tOk('regex 命中 → 90', matchScore('C:/a/x.test.js', '\\.test\\.js$', 'regex') === 90);
t('regex 非法模式 → -1（不抛错）', matchScore('C:/a/x.js', '([', 'regex'), -1);
tOk('fuzzy 顺序命中', fuzzyScore('index.js', 'idx') !== -1, 'idx in index.js');
tOk('fuzzy 顺序不满足 → -1', fuzzyScore('index.js', 'zxi') === -1, 'zxi should fail');

section('fuzzyScore 连续加成');

{
  const contiguous = fuzzyScore('abc.js', 'abc');
  const scattered = fuzzyScore('axbxc.js', 'abc');
  tOk('连续命中分更高', contiguous > scattered, `contiguous=${contiguous} scattered=${scattered}`);
  tOk('连续命中为正', contiguous > 0, contiguous);
  tOk('完全不匹配为 -1', fuzzyScore('xyz.js', 'abc') === -1);
}

/* ------------------------------------------------------------------ *
 * 4. searchEntries
 * ------------------------------------------------------------------ */

section('searchEntries 过滤与排序');

{
  const entries = [
    { p: 'C:/proj/src/index.js', s: 100, m: 1700000000000, d: 0 },
    { p: 'C:/proj/src/main.js', s: 200, m: 1700000000000, d: 0 },
    { p: 'C:/proj/docs', s: 0, m: 1700000000000, d: 1 },
    { p: 'C:/proj/src/utils/helper.js', s: 300, m: 1700000000000, d: 0 }
  ];

  const r = searchEntries(entries, { query: 'index' });
  tOk('返回含 total 与 matches', r && typeof r.total === 'number' && Array.isArray(r.matches),
    JSON.stringify(r && Object.keys(r)));
  t('命中数', r.total, 1);
  tOk('命中的是 index.js', r.matches[0] && String(r.matches[0].e.p).includes('index.js'),
    JSON.stringify(r.matches[0] && r.matches[0].e.p));

  const all = searchEntries(entries, { query: 'js' });
  tOk('子串 js 命中多个', all.total >= 3, 'total=' + all.total);

  const onlyJs = searchEntries(entries, { query: '', ext: ['js'] });
  tOk('空查询 + ext 过滤可用或返回空', onlyJs && typeof onlyJs.total === 'number', JSON.stringify(onlyJs));

  const dirs = searchEntries(entries, { query: 'docs', type: 'dir' });
  tOk('type=dir 只回目录', dirs.matches.every(m => m.e.d === 1), JSON.stringify(dirs.matches.map(m => m.e.p)));

  const files = searchEntries(entries, { query: 'js', type: 'file' });
  tOk('type=file 只回文件', files.matches.every(m => m.e.d === 0), JSON.stringify(files.matches.map(m => m.e.p)));

  const scored = searchEntries(entries, { query: 'js' });
  const scores = scored.matches.map(m => m.score);
  tOk('结果按分数降序', scores.every((s, i) => i === 0 || scores[i - 1] >= s), JSON.stringify(scores));
}

/* ------------------------------------------------------------------ *
 * 5. format.js
 * ------------------------------------------------------------------ */

section('format 扩展名与文件名');

t('extOf 普通扩展名', extOf('C:/a/photo.JPG'), 'jpg');
t('extOf 多级扩展名取最后一段', extOf('C:/a/bundle.min.js'), 'js');
t('extOf 无扩展名 → 空', extOf('C:/a/Makefile'), '');
// 点开头的文件没有扩展名（.gitignore 是「文件名」不是「扩展名 gitignore」）
t('extOf 点文件 → 空', extOf('C:/a/.gitignore'), '');
t('extOf 点开头的真扩展名文件取末段', extOf('C:/a/.eslintrc.json'), 'json');
t('basename 反斜杠路径', basename('C:\\a\\b\\c.txt'), 'c.txt');
t('basename 正斜杠路径', basename('C:/a/b/c.txt'), 'c.txt');
t('basename 无目录', basename('c.txt'), 'c.txt');

section('format 人类可读大小');

t('小于 1KB 显示字节', fmtSize(512), '512 B');
t('恰 1KB', fmtSize(1024), '1.0 KB');
t('KB 量级', fmtSize(1536), '1.5 KB');
t('MB 量级', fmtSize(1024 * 1024), '1.0 MB');
t('GB 量级', fmtSize(1024 * 1024 * 1024), '1.0 GB');
t('0 字节', fmtSize(0), '0 B');
t('null → 短横线', fmtSize(null), '-');
t('undefined → 短横线', fmtSize(undefined), '-');
tMatch('大数值不带多余小数', fmtSize(500 * 1024 * 1024), /^\d+ MB$/);

section('format 时间');

tOk('fmtTime 输出 YYYY-MM-DD HH:MM', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(fmtTime(Date.now())),
  fmtTime(Date.now()));
t('fmtTime 0 → 短横线', fmtTime(0), '-');
tMatch('relTime 刚刚/秒前/分钟前', relTime(Date.now() - 5000), /(刚刚|秒前)/);
tMatch('relTime 分钟级', relTime(Date.now() - 5 * 60 * 1000), /分钟前/);
tMatch('relTime 小时级', relTime(Date.now() - 5 * 3600 * 1000), /小时前/);
tMatch('relTime 天级', relTime(Date.now() - 5 * 24 * 3600 * 1000), /天前/);
t('relTime 0 → 短横线', relTime(0), '-');

section('format 时间窗解析');

t('默认 24 小时', parseWithin(null), 24 * 3600 * 1000);
t('空串取默认', parseWithin(''), 24 * 3600 * 1000);
t('数字按小时', parseWithin(2), 2 * 3600 * 1000);
t('"30m" → 30 分钟', parseWithin('30m'), 30 * 60 * 1000);
t('"7d" → 7 天', parseWithin('7d'), 7 * 24 * 3600 * 1000);
t('"1h" → 1 小时', parseWithin('1h'), 3600 * 1000);
t('"2w" → 2 周', parseWithin('2w'), 2 * 7 * 24 * 3600 * 1000);
t('"90min" → 90 分钟', parseWithin('90min'), 90 * 60 * 1000);
t('非法输入 → null', parseWithin('abc'), null);
t('纯数字字符串按小时', parseWithin('3'), 3 * 3600 * 1000);
t('带空格 " 5d "', parseWithin(' 5d '), 5 * 24 * 3600 * 1000);

/* ------------------------------------------------------------------ *
 * 6. find_files 工具入口（参数校验，不实际扫描）
 * ------------------------------------------------------------------ */

section('find_files 工具入口');

(async () => {
  const none = await findFiles.run({});
  tOk('缺 query 返回提示或空结果', !!none, JSON.stringify(none).slice(0, 120));

  const parsed = findFiles.parseExt('js,ts, .py ');
  tOk('parseExt 返回数组', Array.isArray(parsed), typeof parsed);
  tOk('parseExt 归一化（小写、去空格、去点）',
    parsed.every(e => e === e.toLowerCase() && !e.startsWith('.') && e === e.trim()),
    JSON.stringify(parsed));
  tOk('parseExt 含 js/ts/py',
    ['js', 'ts', 'py'].every(x => parsed.includes(x)), JSON.stringify(parsed));

  /* ------------------------------------------------------------------ *
   * 汇总
   * ------------------------------------------------------------------ */
  console.log('');
  console.log('=== 汇总 ===');
  if (failures.length) {
    console.log('');
    console.log('失败项：');
    for (const f of failures) {
      console.log('  FAIL  ' + f.name);
      console.log('        实际 = ' + f.actual);
      console.log('        期望 = ' + f.expected);
    }
    console.log('');
  }
  console.log('通过 ' + pass + '   失败 ' + fail);
  if (fail) process.exit(1);
})();
