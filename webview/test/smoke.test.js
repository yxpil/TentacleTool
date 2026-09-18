/**
 * WebView 冒烟测试 —— 纯逻辑层，不发起任何网络请求
 *
 * 覆盖三块「最值得单测、也最容易回归」的纯函数：
 *   1. HTML 转义实体解码（decodeEntities）
 *   2. HTML 分词器（tokenize）—— 转换器的地基，错一步后面全错
 *   3. HTML → Markdown 转换器（htmlToMarkdown）—— 各元素类型逐个断言
 *   4. page-parser 的元信息 / 链接提取 / URL 解析
 *
 * 运行：node test/smoke.test.js
 */

const path = require('path');

const { htmlToMarkdown, tokenize, decodeEntities, parseAttrs } = require('../src/utils/html-to-md.js');
const { extractPageMeta, extractLinks, resolveUrl } = require('../src/utils/page-parser.js');
const htmlToMdTool = require('../src/tools/html-to-md-tool.js');

/* ------------------------------------------------------------------ *
 * 极简 harness
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function t(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push({ name, actual: a, expected: e });
  }
}

/** 断言 实际值 包含 子串 */
function tHas(name, haystack, needle) {
  const h = String(haystack == null ? '' : haystack);
  if (h.includes(needle)) {
    pass++;
  } else {
    fail++;
    failures.push({ name, actual: JSON.stringify(h.slice(0, 300)), expected: '包含 ' + JSON.stringify(needle) });
  }
}

/** 断言 实际值 不包含 子串 */
function tNot(name, haystack, needle) {
  const h = String(haystack == null ? '' : haystack);
  if (!h.includes(needle)) {
    pass++;
  } else {
    fail++;
    failures.push({ name, actual: JSON.stringify(h.slice(0, 300)), expected: '不包含 ' + JSON.stringify(needle) });
  }
}

function tMatch(name, actual, re) {
  if (re.test(String(actual))) {
    pass++;
  } else {
    fail++;
    failures.push({ name, actual: JSON.stringify(String(actual).slice(0, 300)), expected: '匹配 ' + re.toString() });
  }
}

function tOk(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push({ name, actual: detail || 'false', expected: 'true' });
  }
}

function section(title) {
  console.log('');
  console.log('=== ' + title + ' ===');
}

/* ------------------------------------------------------------------ *
 * 1. decodeEntities
 * ------------------------------------------------------------------ */

section('decodeEntities 实体解码');

t('具名实体', decodeEntities('&lt;div&gt; &amp; &quot;x&quot;'), '<div> & "x"');
// 注意：&nbsp; / &ensp; / &emsp; 有意折叠成普通空格（Markdown 里保留 U+00A0 会破坏排版）
t('空白类实体折叠为普通空格', decodeEntities('a&nbsp;b'), 'a b');
t('连续空白实体折叠', decodeEntities('a&nbsp;&nbsp;b'), 'a  b');
t('十进制数字实体', decodeEntities('&#65;&#66;'), 'AB');
t('十六进制数字实体', decodeEntities('&#x41;&#x42;'), 'AB');
t('大写十六进制 X', decodeEntities('&#X41;'), 'A');
t('无 & 时原样返回（快速路径）', decodeEntities('plain text'), 'plain text');
t('空串', decodeEntities(''), '');
t('null 安全', decodeEntities(null), null);
t('未知实体保留原样', decodeEntities('&zzz;'), '&zzz;');
t('混合文本', decodeEntities('Tom &amp; Jerry&#33;'), 'Tom & Jerry!');
t('中文 + 实体', decodeEntities('价格 &lt;100&gt; 元'), '价格 <100> 元');
t('多个连续实体', decodeEntities('&amp;&amp;&amp;'), '&&&');

/* ------------------------------------------------------------------ *
 * 2. tokenize
 * ------------------------------------------------------------------ */

section('tokenize HTML 分词器');

{
  const tk = tokenize('<p>hello</p>');
  t('start/text/end 三件套', tk.map(x => x.type), ['start', 'text', 'end']);
  t('标签名小写化', tk[0].tag, 'p');
  t('文本内容', tk[1].data, 'hello');
  t('结束标签', tk[2].tag, 'p');
}

{
  const tk = tokenize('<DIV CLASS="a">x</DIV>');
  t('大写标签名归一化', tk[0].tag, 'div');
  t('属性解析', tk[0].attrs && tk[0].attrs.class, 'a');
}

{
  const tk = tokenize('<img src="a.png" />');
  t('自闭合标签', tk[0].type, 'start');
  t('自闭合属性', tk[0].attrs.src, 'a.png');
  t('自闭合无独立 end token', tk.length, 1);
}

{
  const tk = tokenize('<!-- 注释 -->');
  t('注释被丢弃', tk.length, 0);
}

{
  const tk = tokenize('<script>var a = "<div>";</script><p>x</p>');
  tOk('script 内内容不被当标签', tk.every(x => x.tag !== 'div'), JSON.stringify(tk.map(x => x.tag)));
  const script = tk.find(x => x.tag === 'script');
  tOk('script 标签本身保留', !!script);
}

{
  const tk = tokenize('<pre>\n  code   here\n</pre>');
  const pre = tk.find(x => x.tag === 'pre');
  tOk('pre 标签被保留', !!pre);
}

{
  const tk = tokenize('<a href="x.html" title="T">link</a>');
  const a = tk[0];
  t('a 的 href', a.attrs.href, 'x.html');
  t('a 的 title', a.attrs.title, 'T');
}

{
  const tk = tokenize('<img src=x.png alt="no close">');
  tOk('无引号属性可解析', !!tk[0].attrs, JSON.stringify(tk[0].attrs));
}

{
  const tk = tokenize('plain text only');
  t('纯文本单 token', tk.length, 1);
  t('纯文本 type', tk[0].type, 'text');
}

{
  const tk = tokenize('x<br>y');
  // br 是「start」型 token（在转换器里变成换行），不是独立类型
  const br = tk.find(x => x.tag === 'br');
  t('br 标签存在', br && br.type, 'start');
  t('br 前后文本完整', tk.filter(x => x.type === 'text').map(x => x.data).join(''), 'xy');
}

/* ------------------------------------------------------------------ *
 * 3. parseAttrs
 * ------------------------------------------------------------------ */

section('parseAttrs 属性解析');

t('双引号', parseAttrs('a="1" b="2"').a, '1');
t('单引号', parseAttrs("a='1'").a, '1');
t('单引号内的双引号', parseAttrs('a=\'he said "hi"\'').a, 'he said "hi"');
t('无值属性', parseAttrs('disabled').disabled, '');
t('空串', parseAttrs(''), {});
t('多余空白', parseAttrs('  a = "1"   b="2"  ').b, '2');

/* ------------------------------------------------------------------ *
 * 4. htmlToMarkdown —— 各元素类型
 * ------------------------------------------------------------------ */

section('htmlToMarkdown 标量与内联元素');

{
  const r = htmlToMarkdown('<p>简单段落</p>', { mode: 'full' });
  t('返回值含 markdown 键', typeof r.markdown, 'string');
  tHas('段落文本', r.markdown, '简单段落');
}

{
  const r = htmlToMarkdown('<p>a</p><p>b</p>', { mode: 'full' });
  tOk('两段落之间有空行', /\ba\b[\s\S]*\n\s*\n[\s\S]*\bb\b/.test(r.markdown), JSON.stringify(r.markdown));
}

{
  const r = htmlToMarkdown('<h2>标题二</h2>', { mode: 'full' });
  tHas('h2 → ##', r.markdown, '## 标题二');
}

{
  const r = htmlToMarkdown('<h1>大标题</h1>', { mode: 'full' });
  tHas('h1 → #', r.markdown, '# 大标题');
}

{
  const r = htmlToMarkdown('<strong>粗</strong> 和 <em>斜</em>', { mode: 'full' });
  tHas('strong → **', r.markdown, '**粗**');
  tHas('em → *', r.markdown, '*斜*');
}

{
  const r = htmlToMarkdown('<code>inline()</code>', { mode: 'full' });
  tHas('行内 code → 反引号', r.markdown, '`inline()`');
}

{
  const r = htmlToMarkdown('<pre><code>line1\nline2</code></pre>', { mode: 'full' });
  tHas('pre 代码块围栏', r.markdown, '```');
  tHas('代码块内容保留', r.markdown, 'line1');
}

section('htmlToMarkdown 列表');

{
  const r = htmlToMarkdown('<ul><li>甲</li><li>乙</li></ul>', { mode: 'full' });
  tMatch('无序列表标记', r.markdown, /[-*]\s+甲/);
  tMatch('第二项', r.markdown, /[-*]\s+乙/);
}

{
  const r = htmlToMarkdown('<ol><li>第一</li><li>第二</li></ol>', { mode: 'full' });
  tMatch('有序列表编号', r.markdown, /1\.\s+第一/);
  tMatch('有序列表第二项', r.markdown, /2\.\s+第二/);
}

{
  const r = htmlToMarkdown('<ul><li>外<ul><li>内</li></ul></li></ul>', { mode: 'full' });
  tHas('外层项', r.markdown, '外');
  tHas('嵌套内层项', r.markdown, '内');
  tMatch('嵌套有缩进', r.markdown, /\n\s+[-*]\s+内/);
}

section('htmlToMarkdown 链接与图片');

{
  const r = htmlToMarkdown('<a href="https://example.com">例子</a>', { mode: 'full', baseUrl: 'https://host.test/' });
  tHas('链接语法', r.markdown, '[例子](https://example.com)');
}

{
  const r = htmlToMarkdown('<a href="/rel">相对</a>', { mode: 'full', baseUrl: 'https://host.test/dir/page.html' });
  tHas('相对链接被解析为绝对', r.markdown, 'https://host.test/rel');
}

{
  const r = htmlToMarkdown('<a href="https://example.com">例子</a>', { mode: 'full', includeLinks: false });
  tNot('includeLinks=false 时无链接语法', r.markdown, '](https://example.com)');
  tHas('但文本仍在', r.markdown, '例子');
}

{
  const r = htmlToMarkdown('<img src="a.png" alt="替代文字">', { mode: 'full', baseUrl: 'https://host.test/dir/' });
  tHas('图片语法', r.markdown, '![替代文字]');
  tHas('图片地址被绝对化', r.markdown, 'https://host.test/dir/a.png');
}

{
  const r = htmlToMarkdown('<img src="a.png" alt="x">', { mode: 'full', includeImages: false });
  tNot('includeImages=false 时无图片语法', r.markdown, '![');
}

section('htmlToMarkdown 表格与引用');

{
  const r = htmlToMarkdown('<blockquote>引用内容</blockquote>', { mode: 'full' });
  tMatch('引用 → >', r.markdown, /^>\s+引用内容/m);
}

{
  const html = '<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>';
  const r = htmlToMarkdown(html, { mode: 'full' });
  tHas('表头单元格', r.markdown, '列A');
  tHas('数据单元格', r.markdown, '1');
  tMatch('Markdown 表格分隔行', r.markdown, /\|\s*-{2,}/);
}

section('htmlToMarkdown 标题与元信息');

{
  const r = htmlToMarkdown('<html><head><title>页面标题</title></head><body><p>正文</p></body></html>', { mode: 'full' });
  t('提取 title', r.title, '页面标题');
  tHas('title 作为一级标题前置', r.markdown, '# 页面标题');
}

{
  const r = htmlToMarkdown('<html><head><title>T</title></head><body><p>正文</p></body></html>', { mode: 'full', includeTitle: false });
  tNot('includeTitle=false 时无前置标题', r.markdown, '# T');
}

section('htmlToMarkdown 边界与容错');

{
  const r = htmlToMarkdown('', { mode: 'full' });
  t('空输入不抛错', typeof r.markdown, 'string');
}

{
  const r = htmlToMarkdown(null, { mode: 'full' });
  t('null 输入不抛错', typeof r.markdown, 'string');
}

{
  const r = htmlToMarkdown('<p>未闭合段落', { mode: 'full' });
  tHas('未闭合标签容错', r.markdown, '未闭合段落');
}

{
  const r = htmlToMarkdown('<div><span>x</span></div>', { mode: 'full' });
  tHas('纯容器标签不产生噪声', r.markdown, 'x');
}

{
  const r = htmlToMarkdown('<p>a</p>', { mode: 'full' });
  tNot('无多余连续空行（3+ 被压缩）', r.markdown, '\n\n\n');
}

{
  const r = htmlToMarkdown('<p>x</p>', { mode: 'full' });
  t('首尾无空行', r.markdown, r.markdown.trim());
}

{
  const r = htmlToMarkdown('<script>var x=1;</script><p>正文</p>', { mode: 'full' });
  tNot('脚本内容不进正文', r.markdown, 'var x=1');
}

{
  const r = htmlToMarkdown('<style>.a{color:red}</style><p>正文</p>', { mode: 'full' });
  tNot('样式内容不进正文', r.markdown, 'color:red');
}

/* ------------------------------------------------------------------ *
 * 5. page-parser
 * ------------------------------------------------------------------ */

section('page-parser 元信息提取');

{
  const html = `<html><head>
    <title>我的页面</title>
    <meta name="description" content="页面描述">
    <meta name="keywords" content="a,b,c">
    <meta property="og:title" content="OG标题">
    <meta property="og:image" content="https://host.test/og.png">
    <meta name="twitter:card" content="summary">
    <link rel="icon" href="/favicon.ico">
  </head><body><p>${'字'.repeat(400)}</p></body></html>`;
  const meta = extractPageMeta(html, 'https://host.test/page');
  t('title', meta.title, '我的页面');
  // description 嵌在 meta 子对象下
  t('description', meta.meta && meta.meta.description, '页面描述');
  tHas('keywords 保留', JSON.stringify(meta), 'a,b,c');
  tHas('OG 字段', JSON.stringify(meta), 'OG标题');
}

{
  const meta = extractPageMeta('<html><body><p>x</p></body></html>', 'https://host.test/');
  t('无 title 时为安全值', typeof meta.title, 'string');
}

section('page-parser 链接提取');

{
  const html = '<a href="/a">A</a><a href="/b">B</a><a href="/a">A重复</a>';
  const r = extractLinks(html, 'https://host.test/base/');
  t('返回含 total/links/domains', Object.keys(r).sort(), ['domains', 'links', 'total']);
  const links = r.links;
  // 元素是对象：{ text, href, domain, type }
  tOk('元素是含 href 的对象', links.every(l => l && typeof l === 'object' && 'href' in l),
    JSON.stringify(links[0]));
  tOk('相对链接被绝对化', links.every(l => String(l.href).startsWith('http')),
    JSON.stringify(links.map(l => l.href)));
  t('重复链接被去重（3 个 a 标签 → 2 条）', r.total, 2);
  t('links 长度与 total 一致', links.length, 2);
  t('首个链接文本正确', links[0] && links[0].text, 'A');
  t('域名统计', r.domains.length, 1);
  t('域名计数', r.domains[0] && r.domains[0].count, 2);
}

section('page-parser resolveUrl');

t('相对路径', resolveUrl('/x', 'https://host.test/a/b'), 'https://host.test/x');
t('同级相对路径', resolveUrl('c.html', 'https://host.test/a/b.html'), 'https://host.test/a/c.html');
t('绝对 URL 原样', resolveUrl('https://other.test/z', 'https://host.test/'), 'https://other.test/z');
t('协议相对', resolveUrl('//cdn.test/x.js', 'https://host.test/'), 'https://cdn.test/x.js');
// 空 href 会落回 baseUrl（不是空串）
t('空 href 落回 base', resolveUrl('', 'https://host.test/'), 'https://host.test/');
t('锚点保留在 base 上', resolveUrl('#sec', 'https://host.test/p'), 'https://host.test/p#sec');

/* ------------------------------------------------------------------ *
 * 6. html_to_md 工具入口（含参数校验，不联网）
 * ------------------------------------------------------------------ */

section('html_to_md 工具入口');

(async () => {
  const bad = await htmlToMdTool.run({});
  tOk('缺 html 参数返回 error', !!(bad && bad.error), JSON.stringify(bad));

  const empty = await htmlToMdTool.run({ html: '   ' });
  tOk('空白 html 返回 error', !!(empty && empty.error), JSON.stringify(empty));

  const ok = await htmlToMdTool.run({ html: '<p>来自工具</p>' });
  tOk('正常调用不返回 error', !(ok && ok.error), JSON.stringify(ok && ok.error));

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
