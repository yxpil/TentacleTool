/**
 * Search 冒烟测试 —— 纯逻辑层，不发起任何网络请求
 *
 * 覆盖「引擎解析底座」——三个引擎适配器（bing/baidu/duckduckgo）共用的纯函数，
 * 以及 token 流上的区间/文本提取原语：
 *   1. collapse / clampInt / classList —— 基础工具
 *   2. decodeBingUrl / decodeDdgUrl / resolveBaiduLink —— 跳转链接还原
 *   3. findRanges / textInRange / findStart / anchorText —— token 区间原语
 *   4. html-to-md 的 decodeEntities / tokenize —— 结果页转 Markdown 的地基
 *
 * 有意不测的：真实的搜索引擎请求（依赖外网、结果不稳定，不适合当回归门槛）。
 *
 * 运行：node test/smoke.test.js
 */

const c = require('../src/utils/engines/common.js');
const {
  collapse, clampInt, classList, findRanges, textInRange, findStart, anchorText,
  decodeBingUrl, decodeDdgUrl, resolveBaiduLink
} = c;
const { tokenize, decodeEntities } = require('../src/utils/html-to-md.js');

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

function section(title) {
  console.log('');
  console.log('=== ' + title + ' ===');
}

/* ------------------------------------------------------------------ *
 * 1. 基础工具
 * ------------------------------------------------------------------ */

section('collapse 空白折叠');

t('多空格折叠', collapse('a   b'), 'a b');
t('换行制表折叠为空格', collapse('a\n\t b'), 'a b');
t('首尾去空白', collapse('  a  '), 'a');
t('空串', collapse(''), '');
// 注：collapse 用 String(s)，所以 null/undefined 会字面变成 "null"/"undefined"。
// 调用方（引擎解析器）传的都是字符串 token，实践上不会命中该分支。
t('null 变字面量（String() 语义，记录现状）', collapse(null), 'null');
t('中文保留', collapse('标题  内容'), '标题 内容');

section('clampInt 整数裁剪');

t('上界裁剪', clampInt(999, 1, 10), 10);
t('下界裁剪', clampInt(0, 1, 10), 1);
t('区间内原样', clampInt(5, 1, 10), 5);
t('非数字回退到 min', clampInt('x', 1, 10), 1);
t('null 回退到 min', clampInt(null, 3, 10), 3);
t('数字字符串被解析', clampInt('7', 1, 10), 7);
t('浮点被取整', clampInt(7.9, 1, 10), 7);
t('边界值 min', clampInt(1, 1, 10), 1);
t('边界值 max', clampInt(10, 1, 10), 10);
t('Infinity 回退到 min', clampInt(Infinity, 1, 10), 1);

section('classList 类名解析');

t('多个类名', classList({ class: 'a b c' }), ['a', 'b', 'c']);
t('多余空白', classList({ class: '  a   b  ' }), ['a', 'b']);
t('转小写', classList({ class: 'A B' }), ['a', 'b']);
t('无 class', classList({}), []);
t('null attrs', classList(null), []);
t('空 class', classList({ class: '' }), []);

/* ------------------------------------------------------------------ *
 * 2. 跳转链接还原
 * ------------------------------------------------------------------ */

section('decodeBingUrl 必应跳转还原');

{
  // 构造一个真实的 base64url 载荷
  const real = 'https://example.com/page';
  const b64 = Buffer.from(real, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jump = 'https://www.bing.com/ck/a?!&&u=a1' + b64 + '&ntb=1';
  t('从跳转链接还原真实地址', decodeBingUrl(jump), real);
}

t('非必应链接原样返回', decodeBingUrl('https://example.com/x'), 'https://example.com/x');
t('空串安全', decodeBingUrl(''), '');
t('null 安全', decodeBingUrl(null), '');
tOk('无法解码时保留跳转链接（仍可访问）',
  String(decodeBingUrl('https://www.bing.com/ck/a?u=bad!!')).includes('bing.com'),
  decodeBingUrl('https://www.bing.com/ck/a?u=bad!!'));

section('decodeDdgUrl DuckDuckGo 跳转还原');

t('从 uddg 参数还原',
  decodeDdgUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp%3Fa%3D1'),
  'https://example.com/p?a=1');
t('非 DDG 链接原样', decodeDdgUrl('https://example.com/'), 'https://example.com/');
t('空串安全', decodeDdgUrl(''), '');
tOk('uddg 非法时保留原链接',
  String(decodeDdgUrl('https://duckduckgo.com/l/?uddg=%%%')).includes('duckduckgo.com'),
  decodeDdgUrl('https://duckduckgo.com/l/?uddg=%%%'));

section('resolveBaiduLink 百度跳转（异步）');

/* ------------------------------------------------------------------ *
 * 3. token 区间原语
 * ------------------------------------------------------------------ */

section('token 区间原语');

{
  const tokens = tokenize('<div class="wrap"><p>第一段</p><p>第二段</p></div>');

  // findRanges：找出所有 <p>
  const ps = findRanges(tokens, (tag) => tag === 'p');
  t('findRanges 找到 2 个 p', ps.length, 2);
  tOk('区间含 start/end/attrs', ps[0] && typeof ps[0].start === 'number' &&
    typeof ps[0].end === 'number' && !!ps[0].attrs, JSON.stringify(ps[0]));
  tOk('区间不重叠且递增', ps[0].end <= ps[1].start, JSON.stringify([ps[0], ps[1]]));

  // textInRange：取第一段文本（含标签本身无关，只累加 text token）
  const seg = textInRange(tokens, ps[0].start, ps[0].end);
  t('textInRange 取到文本', seg, '第一段');

  // findStart：找带 class 的 div
  const wrap = findStart(tokens, 0, tokens.length, (tag, attrs) => tag === 'div' && attrs.class === 'wrap');
  tOk('findStart 找到 wrap 容器', !!wrap, JSON.stringify(wrap));
  t('findStart 返回的 attrs', wrap && wrap.attrs.class, 'wrap');

  // findStart 未命中
  const none = findStart(tokens, 0, tokens.length, (tag) => tag === 'table');
  t('findStart 未命中返回 null', none, null);
}

{
  // 嵌套命中应只保留最外层（去重逻辑）
  const tokens = tokenize('<div class="a"><div class="a"><span>x</span></div></div>');
  const hits = findRanges(tokens, (tag, attrs) => tag === 'div' && attrs.class === 'a');
  t('嵌套同类命中被去重为 1 个', hits.length, 1);
}

{
  // anchorText：提取 <a> 文本，含嵌套标签文本
  const tokens = tokenize('<a href="u">链接<b>加粗</b>文字</a>');
  const start = tokens.findIndex(x => x.type === 'start' && x.tag === 'a');
  tOk('anchorText 取到链接文本', anchorText(tokens, start).includes('链接'), anchorText(tokens, start));
  tOk('anchorText 含嵌套标签文本', anchorText(tokens, start).includes('加粗'), anchorText(tokens, start));
}

{
  const tokens = tokenize('<a href="u">A</a>');
  const start = tokens.findIndex(x => x.type === 'start' && x.tag === 'a');
  t('anchorText 解码实体', anchorText(tokenize('<a href="u">Tom &amp; Jerry</a>'), start), 'Tom & Jerry');
}

/* ------------------------------------------------------------------ *
 * 4. html-to-md 底座（search 也内嵌了一份转换器）
 * ------------------------------------------------------------------ */

section('search 侧 html-to-md 底座');

t('实体解码', decodeEntities('&lt;p&gt;'), '<p>');
t('nbsp 折叠为空格', decodeEntities('a&nbsp;b'), 'a b');

{
  const tk = tokenize('<h3 class="t">结果标题</h3>');
  t('tokenize 三件套', tk.map(x => x.type), ['start', 'text', 'end']);
  t('属性解析', tk[0].attrs.class, 't');
  t('文本内容', tk[1].data, '结果标题');
}

{
  // tokenize 会为 raw-text 元素（script/style）产出 text token —— 这是分词层的原样行为；
  // 过滤发生在转换器层（htmlToMarkdown 的 SKIP_TAGS）。两条断言分别锁住这两层契约。
  const html = '<script>var a=1;</script><style>.x{color:red}</style><p>x</p>';
  const tk = tokenize(html);
  tOk('分词层：script 是 RAW_TEXT 元素并产出文本 token',
    tk.some(x => x.type === 'text' && String(x.data).includes('var a=1')),
    JSON.stringify(tk.map(x => x.type + ':' + (x.tag || x.data))));

  const { htmlToMarkdown } = require('../src/utils/html-to-md.js');
  const r = htmlToMarkdown(html, { mode: 'full' });
  t('转换层：脚本内容被剔除', r.markdown.includes('var a=1'), false);
  t('转换层：样式内容被剔除', r.markdown.includes('color:red'), false);
  t('转换层：正文保留', r.markdown.trim(), 'x');
}

/* ------------------------------------------------------------------ *
 * 5. 引擎适配器模块形状（不实际联网）
 * ------------------------------------------------------------------ */

section('引擎适配器模块形状');

(async () => {
  const engines = [
    ['bing', require('../src/utils/engines/bing.js')],
    ['baidu', require('../src/utils/engines/baidu.js')],
    ['duckduckgo', require('../src/utils/engines/duckduckgo.js')]
  ];
  for (const [name, mod] of engines) {
    tOk(name + ' 导出 search 函数', typeof mod.search === 'function', typeof mod.search);
    tOk(name + ' search 是 async（返回 Promise）',
      (() => { try { const r = mod.search('测试', {}); const isP = r && typeof r.then === 'function'; if (isP) r.catch(() => {}); return isP; } catch (e) { return false; } })(),
      '非 Promise');
  }

  // resolveBaiduLink 是异步的，返回 { url, resolved }
  tOk('resolveBaiduLink 返回 Promise',
    (() => { const r = resolveBaiduLink('https://www.baidu.com/link?url=abc'); const isP = r && typeof r.then === 'function'; if (isP) r.then(() => {}).catch(() => {}); return isP; })(),
    '非 Promise');

  const nonBaidu = await resolveBaiduLink('https://example.com/x');
  tOk('非百度链接返回 { url, resolved } 结构',
    nonBaidu && typeof nonBaidu === 'object' && 'url' in nonBaidu, JSON.stringify(nonBaidu));
  t('非百度链接 url 原样返回', nonBaidu.url, 'https://example.com/x');
  t('非百度链接 resolved=true', nonBaidu.resolved, true);

  const emptyBaidu = await resolveBaiduLink('');
  tOk('空链接也返回对象（不抛错）', emptyBaidu && typeof emptyBaidu === 'object',
    JSON.stringify(emptyBaidu));

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
