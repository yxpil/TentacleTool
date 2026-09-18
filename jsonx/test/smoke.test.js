'use strict';
/**
 * Jsonx 工具集冒烟测试（零依赖，node test/smoke.test.js）
 *
 * 覆盖范围：
 *   - csv.js      ：状态机解析（引号内分隔符/换行、转义引号、CRLF、不规则行列）
 *   - yaml.js     ：子集解析与序列化、往返一致性、不支持语法必须报错
 *   - jsonpath.js ：全部支持的语法 + 不支持语法必须报错
 *   - infer.js    ：保守类型推断（前导零、大整数、混合列）
 *   - diff.js     ：三种数组模式、ignoreKeys、容差
 *   - 六个工具    ：正常路径 + 错误路径 + 边界
 *
 * 断言原则（血泪教训）：**期望值必须来自实测**，不能凭直觉写。
 * 凡是不确定的，先 `node -e "console.log(JSON.stringify(require('./src/utils/xxx.js').fn(...)))"` 打印真实行为。
 */

const assert = require('assert');

const CV = require('../src/utils/csv');
const Y = require('../src/utils/yaml');
const JP = require('../src/utils/jsonpath');
const INF = require('../src/utils/infer');
const DIFF = require('../src/utils/diff');

const parseTool = require('../src/tools/jsonx-parse');
const convertTool = require('../src/tools/jsonx-convert');
const queryTool = require('../src/tools/jsonx-query');
const schemaTool = require('../src/tools/jsonx-schema');
const diffTool = require('../src/tools/jsonx-diff');
const aggTool = require('../src/tools/jsonx-aggregate');

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
      console.log('      实际: ' + e.message);
    } else {
      passed++;
      console.log('  ✓ ' + name);
    }
  }
}

/* ==================================================================== */
(async () => {

  /* ========================= csv.js · 基础 ========================= */
  section('csv.js · 基础解析');

  t('简单两行', CV.parseCsv('a,b\n1,2').rows, [['a', 'b'], ['1', '2']]);
  t('分隔符 sniff（逗号）', CV.sniffDelimiter('a,b,c\n1,2,3').delimiter, ',');
  t('分隔符 sniff（tab）', CV.sniffDelimiter('a\tb\tc\n1\t2\t3').delimiter, '\t');
  t('分隔符 sniff（分号）', CV.sniffDelimiter('a;b;c\n1;2;3').delimiter, ';');
  t('分隔符别名 comma → ,', CV.resolveDelimiter('comma'), ',');
  t('分隔符别名 tab → \\t', CV.resolveDelimiter('tab'), '\t');
  t('分隔符别名 pipe → |', CV.resolveDelimiter('pipe'), '|');
  t('分隔符 \\t 转义写法', CV.resolveDelimiter('\\t'), '\t');
  tThrow('多字符分隔符报错', () => CV.resolveDelimiter('ab'), '必须是单个字符');

  section('csv.js · 引号处理');

  t('引号内逗号是一个字段', CV.parseCsv('a,"x,y",b').rows[0], ['a', 'x,y', 'b']);
  t('引号内换行是一个字段', CV.parseCsv('a,"line1\nline2",b').rows[0], ['a', 'line1\nline2', 'b']);
  t('转义引号 "" → 单个 "', CV.parseCsv('a,"he said ""hi""",b').rows[0], ['a', 'he said "hi"', 'b']);
  t('引号内的 \r\n 原样保留', CV.parseCsv('a,"x\r\ny",b').rows[0], ['a', 'x\r\ny', 'b']);
  t('字段内换行不增加行数', CV.parseCsv('a,"l1\nl2",b\nc,d,e').rows.length, 2);
  t('字段内换行后的行号正确', CV.parseCsv('a,"l1\nl2",b\nc,d,e').lineNumbers, [1, 3]);

  section('csv.js · 空字段与不规则');

  t('末尾空字段保留', CV.parseCsv('a,b,').rows[0], ['a', 'b', '']);
  t('开头空字段保留', CV.parseCsv(',a,b').rows[0], ['', 'a', 'b']);
  t('空字段在中间保留', CV.parseCsv('a,,b').rows[0], ['a', '', 'b']);
  t('不同列数 → rows 原样保留', CV.parseCsv('a,b\n1,2,3').rows[1].length, 3);
  t('raggedRows 计数', CV.parseCsv('a,b\n1,2,3').meta.raggedRows, 1);
  t('列数取最大值', CV.parseCsv('a,b\n1,2,3').meta.columns, 3);

  section('csv.js · CRLF 与注释');

  t('CRLF 行尾', CV.parseCsv('a,b\r\n1,2').rows, [['a', 'b'], ['1', '2']]);
  t('CR 行尾', CV.parseCsv('a,b\r1,2').rows, [['a', 'b'], ['1', '2']]);
  t('注释行被忽略', CV.parseCsv('# note\na,b\n1,2', { comment: '#' }).rows, [['a', 'b'], ['1', '2']]);
  t('注释后行号仍准确', CV.parseCsv('# note\na,b', { comment: '#' }).lineNumbers, [2]);

  section('csv.js · 表头与截断');

  t('header 抽出首行', CV.parseCsv('a,b\n1,2', { header: true }).header, ['a', 'b']);
  t('header 抽出后 rows 只剩数据', CV.parseCsv('a,b\n1,2', { header: true }).rows, [['1', '2']]);
  t('maxRows 截断', CV.parseCsv('a\n1\n2\n3', { maxRows: 2 }).rows.length, 2);
  t('maxRows 截断报告丢掉的行数', CV.parseCsv('a\n1\n2\n3', { maxRows: 2 }).meta.truncated, 2);
  t('totalDataRows 是截断前的真实总数', CV.parseCsv('a\n1\n2\n3', { maxRows: 2 }).meta.totalDataRows, 4);
  t('带 header 时 totalDataRows 不含表头',
    CV.parseCsv('a\n1\n2\n3', { header: true, maxRows: 2 }).meta.totalDataRows, 3);

  section('csv.js · 未闭合引号（宽容 + 告警）');

  const unclosed = CV.parseCsv('a,"unterminated\nb,c');
  tOk('未闭合引号产生告警', unclosed.warnings.some(w => w.includes('引号未闭合')));
  tOk('未闭合引号仍产出内容不崩', unclosed.rows.length >= 1);

  section('csv.js · 序列化');

  t('含逗号需引号', CV.escapeField('a,b', ','), '"a,b"');
  t('含引号需转义', CV.escapeField('a"b', ','), '"a""b"');
  t('含换行需引号', CV.escapeField('a\nb', ','), '"a\nb"');
  t('首尾空白需引号', CV.escapeField(' a', ','), '" a"');
  t('普通值不加引号', CV.escapeField('abc', ','), 'abc');
  t('空串不加引号', CV.escapeField('', ','), '');
  t('needsQuote 含分隔符', CV.needsQuote('a,b', ','), true);
  t('needsQuote 普通值', CV.needsQuote('ab', ','), false);

  section('csv.js · 往返');

  // 注意：**不要用"全空字段的行"做往返用例** —— parseCsv 默认 skipEmpty=true 会
  // 把整行空白的行丢掉（这是有意设计，避免 CSV 里的空行污染记录）。这是实现契约，不是 bug。
  const csvRoundTripCases = [
    [['a', 'b'], ['1', '2']],
    [['a,b', 'c"d'], ['x\ny', '  pad  ']],
    [['中文', 'emoji🎉'], ['tab\there', 'nl\nhere']],
    [['a', ''], ['', 'b']],
    [['x'], ['y']]
  ];
  for (let i = 0; i < csvRoundTripCases.length; i++) {
    const rows = csvRoundTripCases[i];
    const text = CV.stringifyCsv(rows, { eol: '\n' });
    t(`往返 ${i + 1}`, CV.parseCsv(text).rows, rows);
  }
  t('全空行默认被丢弃（skipEmpty）', CV.parseCsv('\n\n').rows, []);
  t('skipEmpty:false 保留全空行', CV.parseCsv('\n\n', { skipEmpty: false }).rows, [[''], ['']]);

  /* ========================= yaml.js ========================= */
  section('yaml.js · 标量');

  t('整数', Y.parseYamlSingle('a: 42').value, { a: 42 });
  t('负数', Y.parseYamlSingle('a: -7').value, { a: -7 });
  t('小数', Y.parseYamlSingle('a: 3.14').value, { a: 3.14 });
  t('科学计数', Y.parseYamlSingle('a: 1e5').value, { a: 100000 });
  t('true', Y.parseYamlSingle('a: true').value, { a: true });
  t('True', Y.parseYamlSingle('a: True').value, { a: true });
  t('false', Y.parseYamlSingle('a: false').value, { a: false });
  t('null', Y.parseYamlSingle('a: null').value, { a: null });
  t('波浪号 ~ = null', Y.parseYamlSingle('a: ~').value, { a: null });
  t('空值 = null', Y.parseYamlSingle('a:').value, { a: null });
  t('前导零不当数字', Y.parseYamlSingle('a: 007').value, { a: '007' });
  t('裸字符串', Y.parseYamlSingle('a: hello').value, { a: 'hello' });
  t('yes 按字符串（YAML 1.2 语义）', Y.parseYamlSingle('a: yes').value, { a: 'yes' });
  t('no 按字符串', Y.parseYamlSingle('a: no').value, { a: 'no' });
  t('on 按字符串', Y.parseYamlSingle('a: on').value, { a: 'on' });
  t('yes 序列化时仍加引号（兼容 YAML 1.1 解析器）', Y.stringifyYaml({ a: 'yes' }), "a: 'yes'\n");
  t('引号串保留冒号', Y.parseYamlSingle('a: "x: y"').value, { a: 'x: y' });
  t('单引号串', Y.parseYamlSingle("a: 'it''s'").value, { a: "it's" });
  t('双引号转义 \\n', Y.parseYamlSingle('a: "x\\ny"').value, { a: 'x\ny' });
  t('双引号 \\u 转义', Y.parseYamlSingle('a: "\\u4e2d"').value, { a: '中' });

  section('yaml.js · 结构与嵌套');

  t('嵌套映射', Y.parseYamlSingle('a:\n  b: 1').value, { a: { b: 1 } });
  t('三层嵌套', Y.parseYamlSingle('a:\n  b:\n    c: 1').value, { a: { b: { c: 1 } } });
  t('同级键闭合', Y.parseYamlSingle('a:\n  b: 1\nc: 2').value, { a: { b: 1 }, c: 2 });
  t('序列', Y.parseYamlSingle('l:\n  - x\n  - y').value, { l: ['x', 'y'] });
  t('对象数组', Y.parseYamlSingle('u:\n  - n: a\n    v: 1\n  - n: b\n    v: 2').value,
    { u: [{ n: 'a', v: 1 }, { n: 'b', v: 2 }] });
  t('序列中嵌套映射', Y.parseYamlSingle('l:\n  - n: x\n    m:\n      k: v\n    t: z').value,
    { l: [{ n: 'x', m: { k: 'v' }, t: 'z' }] });
  t('序列的序列', Y.parseYamlSingle('m:\n  - - 1\n    - 2\n  - - 3').value, { m: [[1, 2], [3]] });
  t('矩阵', Y.parseYamlSingle('m:\n  - - 1\n    - 2\n  - - 3\n    - 4').value, { m: [[1, 2], [3, 4]] });
  t('流式映射', Y.parseYamlSingle('a: {x: 1, y: 2}').value, { a: { x: 1, y: 2 } });
  t('流式序列', Y.parseYamlSingle('a: [1, 2, 3]').value, { a: [1, 2, 3] });
  t('流式嵌套', Y.parseYamlSingle('a: {b: [1, 2]}').value, { a: { b: [1, 2] } });
  t('行内对象数组', Y.parseYamlSingle('- a: 1\n  b: 2').value, [{ a: 1, b: 2 }]);

  section('yaml.js · 块标量与注释');

  t('字面量块 |', Y.parseYamlSingle('a: |\n  l1\n  l2').value, { a: 'l1\nl2\n' });
  t('字面量块 |- 去尾换行', Y.parseYamlSingle('a: |-\n  l1\n  l2').value, { a: 'l1\nl2' });
  t('折叠块 >', Y.parseYamlSingle('a: >\n  l1\n  l2').value, { a: 'l1 l2\n' });
  t('折叠块 >- 去尾换行', Y.parseYamlSingle('a: >-\n  l1\n  l2').value, { a: 'l1 l2' });
  t('行尾注释被剥离', Y.parseYamlSingle('a: 1  # note').value, { a: 1 });
  t('整行注释被忽略', Y.parseYamlSingle('# note\na: 1').value, { a: 1 });
  t('引号内的 # 不是注释', Y.parseYamlSingle('a: "x # y"').value, { a: 'x # y' });
  t('a#b 不是注释（# 前无空白）', Y.parseYamlSingle('a: x#y').value, { a: 'x#y' });
  t('文档边界 ---', Y.parseYaml('---\na: 1\n---\nb: 2').documents, [{ a: 1 }, { b: 2 }]);
  t('单文档返回长度 1', Y.parseYaml('a: 1').documents.length, 1);

  section('yaml.js · 不支持语法必须报错（静默忽略会产生错误的值）');

  tThrow('锚点 & 报错', () => Y.parseYaml('a: &x 1'), '不支持 锚点');
  tThrow('别名 * 报错', () => Y.parseYaml('a: *x'), '不支持 别名');
  tThrow('标签 !! 报错', () => Y.parseYaml('a: !!str 1'), '不支持 标签');
  tThrow('YAML 指令报错', () => Y.parseYaml('%YAML 1.2\n---\na: 1'), '不支持 YAML 指令');
  tThrow('复杂键报错', () => Y.parseYaml('[a,b]: 1'), '不支持复杂键');
  tThrow('多文档用 Single 报错', () => Y.parseYamlSingle('---\na: 1\n---\nb: 2'), '含 2 个文档');
  tThrow('缩进不一致报错', () => Y.parseYaml('a: 1\n    b: 2'), '缩进不一致');

  section('yaml.js · 序列化的往返一致性（最关键的性质）');

  const yamlSamples = {
    '标量集合': { a: 1, b: 'x', c: true, d: null, e: 1.5, f: -3 },
    '歧义字符串必须加引号': { s1: '123', s2: 'true', s3: 'null', s4: 'yes', s5: '~', s6: '' },
    '特殊字符': { a: 'has: colon', b: 'has # hash', c: '- dash', d: 'a\nb', e: "quo'te", f: 'dq"uote' },
    '嵌套': { s: { h: 'h', p: 1 }, l: [1, 2, 3], m: [{ x: 1 }, { y: [2, 3] }] },
    '空容器': { o: {}, a: [], n: null },
    'Unicode': { cn: '中文值', emoji: '🎉', mix: 'a中文b' },
    '首尾空白': { a: ' pad ', b: '\ttab' },
    '数字形态字符串': { a: '0.5', b: '-1', c: '1e3' }
  };
  for (const [name, v] of Object.entries(yamlSamples)) {
    const text = Y.stringifyYaml(v);
    let back;
    try { back = Y.parseYamlSingle(text).value; }
    catch (e) { back = 'ERROR: ' + e.message; }
    t(`往返：${name}`, back, v);
  }

  section('yaml.js · 序列化细节');

  tOk('歧义字符串 "123" 被加引号', Y.stringifyYaml({ a: '123' }).includes("'123'"));
  tOk('歧义字符串 "true" 被加引号', Y.stringifyYaml({ a: 'true' }).includes("'true'"));
  tOk('真布尔不加引号', Y.stringifyYaml({ a: true }).includes('a: true'));
  tOk('空字符串被加引号', Y.stringifyYaml({ a: '' }).includes("''"));
  t('YAML 输出以换行结尾', Y.stringifyYaml({ a: 1 }).endsWith('\n'), true);

  /* ========================= jsonpath.js ========================= */
  section('jsonpath.js · 支持的全部语法');

  const doc = {
    store: {
      name: 'Shop',
      items: [
        { id: 1, name: 'Apple', price: 3.5, tags: ['fruit', 'red'] },
        { id: 2, name: 'Bread', price: 2.0, tags: ['bakery'] },
        { id: 3, name: 'Cheese', price: 8.0, tags: ['dairy', 'yellow'] }
      ],
      meta: { open: true, nested: { id: 99 } }
    },
    ids: [10, 20, 30, 40, 50]
  };
  const q = p => JP.query(doc, p).matches.map(m => m.value);
  const qp = p => JP.query(doc, p).matches.map(m => m.path);

  t('$ 返回全文档', q('$').length, 1);
  t('$.store.name', q('$.store.name'), ['Shop']);
  t('$.store.items[0].name', q('$.store.items[0].name'), ['Apple']);
  t('负下标 [-1]', q('$.store.items[-1].name'), ['Cheese']);
  t('负下标 [-2]', q('$.store.items[-2].name'), ['Bread']);
  t('通配 [*]', q('$.store.items[*].name'), ['Apple', 'Bread', 'Cheese']);
  t('点号通配 .*', q('$.store.items.*.name'), ['Apple', 'Bread', 'Cheese']);
  t('括号键访问', q("$.store.items[0]['name']"), ['Apple']);
  t('双引号括号键', q('$.store.items[0]["name"]'), ['Apple']);
  t('递归下降 $.store..id', q('$.store..id'), [1, 2, 3, 99]);
  t('递归下降 $..id', q('$..id'), [1, 2, 3, 99]);
  t('切片 [1:4]', q('$.ids[1:4]'), [20, 30, 40]);
  t('切片 [:2]', q('$.ids[:2]'), [10, 20]);
  t('切片 [3:]', q('$.ids[3:]'), [40, 50]);
  t('切片负起点 [-2:]', q('$.ids[-2:]'), [40, 50]);
  t('切片步长 [::2]', q('$.ids[::2]'), [10, 30, 50]);
  t('切片负步长 [::-1]', q('$.ids[::-1]'), [50, 40, 30, 20, 10]);
  t('切片负步长区间 [3:0:-1]', q('$.ids[3:0:-1]'), [40, 30, 20]);
  t('多选下标 [0,2,4]', q('$.ids[0,2,4]'), [10, 30, 50]);
  t('多选键', q("$.store.items[0]['name','price']"), ['Apple', 3.5]);
  t('两级通配', q('$.store.items[*].tags[*]'), ['fruit', 'red', 'bakery', 'dairy', 'yellow']);
  t('递归+通配 $..tags[*]', q('$..tags[*]'), ['fruit', 'red', 'bakery', 'dairy', 'yellow']);
  t('.length 数组', q('$.ids.length'), [5]);
  t('.length 上层数组', q('$.store.items.length'), [3]);
  t('.keys 对象键', q('$.store.keys'), [['name', 'items', 'meta']]);
  t('裸键开头（无 $）', q('store.name'), ['Shop']);
  t('路径记录正确', qp('$.store.items[1].name'), ['$.store.items[1].name']);

  section('jsonpath.js · 不支持语法必须报错（不能静默返回空）');

  tThrow('过滤器 [?(...)] 报错', () => JP.query(doc, '$.store.items[?(@.price>3)]'), '不支持过滤器');
  tThrow('脚本表达式报错', () => JP.query(doc, '$.store.items[(1+2)]'), '不支持脚本');
  tThrow('递归多选报错', () => JP.query(doc, '$..[0,1]'), '只支持单个键或通配');
  tThrow('括号不配对报错', () => JP.query(doc, '$.store.items['), '没有配对');
  tThrow('空路径片段报错', () => JP.query(doc, '$.store..'), '缺少键名');
  tThrow('@ 开头报错', () => JP.query(doc, '@.foo'), '不支持以 @ 开头');
  tThrow('step=0 报错', () => JP.query(doc, '$.ids[::0]'), 'step 不能为 0');
  tThrow('空下标报错', () => JP.query(doc, '$.ids[]'), '空的下标');
  tThrow('切片四段报错', () => JP.query(doc, '$.ids[1:2:3:4]'), '最多三段');

  section('jsonpath.js · 边界');

  t('不存在的键返回空', q('$.nope'), []);
  t('标量上取键返回空', q('$.store.name.x'), []);
  t('数组超界返回空', q('$.ids[99]'), []);
  t('负超界返回空', q('$.ids[-99]'), []);
  t('空数组通配返回空', JP.query({ a: [] }, '$.a[*]').count, 0);
  t('切片空结果', q('$.ids[10:20]'), []);
  t('validatePath 合法返回 null', JP.validatePath('$.a.b[0]'), null);
  tOk('validatePath 非法返回消息', typeof JP.validatePath('$.a[?(@)]') === 'string');

  section('jsonpath.js · sliceIndices 语义（对齐 Python/JSONPath）');

  t('sliceIndices(5,1,4,1)', JP.sliceIndices(5, 1, 4, 1), [1, 2, 3]);
  t('sliceIndices(5,null,null,-1)', JP.sliceIndices(5, null, null, -1), [4, 3, 2, 1, 0]);
  t('sliceIndices(5,-2,null,1)', JP.sliceIndices(5, -2, null, 1), [3, 4]);
  t('sliceIndices(5,0,10,1) 上限夹取', JP.sliceIndices(5, 0, 10, 1), [0, 1, 2, 3, 4]);

  /* ========================= infer.js ========================= */
  section('infer.js · 单值推断（保守优先）');

  t('整数', INF.inferCell('42'), { value: 42, type: 'number' });
  t('负数', INF.inferCell('-7'), { value: -7, type: 'number' });
  t('小数', INF.inferCell('3.14'), { value: 3.14, type: 'number' });
  t('零', INF.inferCell('0'), { value: 0, type: 'number' });
  t('科学计数', INF.inferCell('1e5'), { value: 100000, type: 'number' });
  t('前导零 → 字符串（电话/编号）', INF.inferCell('0912').type, 'string');
  t('前导零 007 → 字符串', INF.inferCell('007'), { value: '007', type: 'string' });
  t('超级大整数 → 字符串（雪花 ID）', INF.inferCell('9007199254740993').type, 'string');
  tOk('大整数给出原因', INF.inferCell('9007199254740993').reason === 'integer-too-large');
  t('空串 → null', INF.inferCell(''), { value: null, type: 'null' });
  t('空白 → null', INF.inferCell('   '), { value: null, type: 'null' });
  t('true', INF.inferCell('true'), { value: true, type: 'boolean' });
  t('False', INF.inferCell('False'), { value: false, type: 'boolean' });
  t('N/A 保留字符串', INF.inferCell('N/A'), { value: 'N/A', type: 'string' });
  t('横杠保留字符串', INF.inferCell('-'), { value: '-', type: 'string' });
  t('日期默认留字符串', INF.inferCell('2026-09-18').type, 'string');
  t('开启 inferDates 后识别为 date', INF.inferCell('2026-09-18', { inferDates: true }).type, 'date');
  t('半成品数字 .5 留字符串', INF.inferCell('.5').type, 'string');
  t('5. 留字符串', INF.inferCell('5.').type, 'string');
  t('null 字面量（非空字段）留字符串', INF.inferCell('null').type, 'string');

  section('infer.js · 整列推断（一列有杂值就整列退回字符串）');

  t('全整数列', INF.inferColumn(['1', '2', '3']).type, 'number');
  t('全整数列的值', INF.inferColumn(['1', '2', '3']).values, [1, 2, 3]);
  t('含文本 → 整列字符串', INF.inferColumn(['1', 'x', '3']).type, 'string');
  t('含文本时数字也退回字符串', INF.inferColumn(['1', 'x', '3']).values, ['1', 'x', '3']);
  tOk('混合列标注原因', INF.inferColumn(['1', 'x', '3']).reason === 'mixed-types');
  t('空值不影响数字类型', INF.inferColumn(['1', '', '3']).type, 'number');
  t('空值变 null', INF.inferColumn(['1', '', '3']).values, [1, null, 3]);
  t('空值计数', INF.inferColumn(['1', '', '3']).nullCount, 1);
  t('全空列类型 null', INF.inferColumn(['', '', '']).type, 'null');
  t('前导零整列字符串', INF.inferColumn(['007', '0912']).type, 'string');
  t('大整数整列字符串', INF.inferColumn(['9007199254740993', '9007199254740994']).type, 'string');
  t('整数小数混列 → number', INF.inferColumn(['1.5', '2', '3.25']).type, 'number');
  t('布尔整列', INF.inferColumn(['true', 'false']).type, 'boolean');
  t('整数与布尔混列 → 字符串', INF.inferColumn(['1', 'true']).type, 'string');

  section('infer.js · 表格推断');

  const tbl = INF.inferTable(
    [['alice', '30', 'true', ''], ['bob', '25', 'false', 'x']],
    { header: ['name', 'age', 'active', 'note'] });
  t('列名', tbl.columns, ['name', 'age', 'active', 'note']);
  t('记录 1', tbl.records[0], { name: 'alice', age: 30, active: true, note: null });
  t('age 推断为 number', tbl.schema.columns[1].type, 'number');
  t('note 可空', tbl.schema.columns[3].nullable, true);
  t('重名列去重', INF.inferTable([['1', '2']], { header: ['a', 'a'] }).columns, ['a', 'a_2']);
  t('空表头生成 col 名', INF.inferTable([['1', '2']], { header: ['', ''] }).columns, ['col1', 'col2']);
  t('infer:false 全字符串', INF.inferTable([['1']], { header: ['a'], infer: false }).records[0].a, '1');

  section('infer.js · JSON schema 推断');

  const schemaData = [
    { id: 1, name: 'a', tags: ['x'], meta: { ok: true } },
    { id: 2, name: 'b', tags: [], meta: { ok: false, extra: 1 } },
    { id: 3, name: 'c', tags: ['y', 'z'], other: 5 }
  ];
  const js = INF.inferJsonSchema(schemaData, { enumMaxCardinality: 5 });
  t('记录数', js.records.rowCount, 3);
  t('字段总数', js.records.totalFields, 5);
  t('可选字段', js.records.optionalFields.sort(), ['meta', 'other']);
  t('id 推断为 integer', js.records.fields.id.type, 'integer');
  t('name 枚举并集（不是只有第一份）', js.records.fields.name.enum, ['a', 'b', 'c']);
  t('空数组不污染元素类型', js.records.fields.tags.items.type, 'string');
  t('空数组元素的枚举并集', js.records.fields.tags.items.enum, ['x', 'y', 'z']);
  t('嵌套对象可选键', js.records.fields.meta.optionalKeys, ['extra']);
  t('混合类型数组', INF.inferJsonSchema({ a: [1, 'x', true] }).schema.properties.a.items.type,
    ['integer', 'string', 'boolean']);
  t('全 null 数组', INF.inferJsonSchema({ a: [null, null] }).schema.properties.a.items.type, 'null');
  t('空数组标记 empty', INF.inferJsonSchema({ a: [] }).schema.properties.a.empty, true);
  t('shortType 数组', INF.shortType({ type: 'array', items: { type: 'string' } }), 'array<string>');
  t('shortType 对象计数', INF.shortType({ type: 'object', properties: { a: {}, b: {} } }), 'object{2}');

  /* ========================= diff.js ========================= */
  section('diff.js · 对象比较');

  t('键顺序不同视为相等', DIFF.diff({ a: 1, b: 2 }, { b: 2, a: 1 }).equal, true);
  t('标量改动', DIFF.diff({ a: 1 }, { a: 2 }).changes[0].kind, 'changed');
  t('改动路径', DIFF.diff({ a: 1 }, { a: 2 }).changes[0].path, '$.a');
  t('新增键', DIFF.diff({ a: 1 }, { a: 1, b: 2 }).changes[0].kind, 'added');
  t('删除键', DIFF.diff({ a: 1, b: 2 }, { a: 1 }).changes[0].kind, 'removed');
  t('嵌套路径', DIFF.diff({ u: { n: 'a' } }, { u: { n: 'b' } }).changes[0].path, '$.u.n');
  t('类型变化计数', DIFF.diff({ a: '1' }, { a: 1 }).stats.typeChanges, 1);
  tOk('类型变化带原因', /类型变化/.test(DIFF.diff({ a: '1' }, { a: 1 }).changes[0].reason));
  t('1 与 1.0 相等', DIFF.diff({ a: 1 }, { a: 1.0 }).equal, true);
  t('null vs 0 不等', DIFF.diff({ a: null }, { a: 0 }).equal, false);
  t('含横杠的键走括号路径（避免歧义）', DIFF.diff({ 'a-b': 1 }, { 'a-b': 2 }).changes[0].path, '$["a-b"]');
  t('含点的键走括号路径', DIFF.diff({ 'a.b': 1 }, { 'a.b': 2 }).changes[0].path, '$["a.b"]');
  t('含空格的键走括号路径', DIFF.diff({ 'a b': 1 }, { 'a b': 2 }).changes[0].path, '$["a b"]');
  t('含引号的键转义正确', DIFF.diff({ 'a"b': 1 }, { 'a"b': 2 }).changes[0].path, '$["a\\"b"]');
  t('普通标识符走点号', DIFF.diff({ ok_key: 1 }, { ok_key: 2 }).changes[0].path, '$.ok_key');

  section('diff.js · 数组三种模式');

  t('index 模式按下标', DIFF.diff([1, 2, 3], [1, 9, 3]).changes[0].path, '$[1]');
  t('index 模式长度变化报 length', DIFF.diff([1, 2], [1, 2, 3]).changes.some(c => c.path === '$.length'), true);
  t('忽略顺序（真相同）', DIFF.diff([1, 2, 3], [3, 1, 2], { ignoreOrder: true }).equal, true);
  t('忽略顺序（有差异）', DIFF.diff([1, 2, 3], [3, 1, 9], { ignoreOrder: true }).equal, false);
  t('ignoreArrayOrder 是别名', DIFF.diff([1, 2], [2, 1], { ignoreArrayOrder: true }).equal, true);
  t('ignoreOrder 长度不同', DIFF.diff([1, 2], [2, 1, 5], { ignoreOrder: true }).equal, false);
  t('对象数组忽略顺序', DIFF.diff([{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 1 }], { ignoreOrder: true }).equal, true);
  t('byKey 匹配元素', DIFF.diff(
    [{ id: 1, n: 'a' }, { id: 2, n: 'b' }],
    [{ id: 2, n: 'B' }],
    { arrayMode: 'byKey', arrayKey: 'id' }).changes.map(c => c.kind), ['removed', 'changed']);
  t('byKey 路径带键', DIFF.diff(
    [{ id: 7, n: 'a' }], [{ id: 7, n: 'b' }],
    { arrayMode: 'byKey', arrayKey: 'id' }).changes[0].path, '$[id=7].n');
  tThrow('非法 arrayMode 报错', () => DIFF.diff(1, 2, { arrayMode: 'bogus' }), 'arrayMode 只能是');

  section('diff.js · 过滤与容差');

  t('ignoreKeys 跳过', DIFF.diff({ a: 1, t: 1 }, { a: 2, t: 9 }, { ignoreKeys: ['$.t'] }).changes.length, 1);
  t('ignoreKeys 跳过后仍报 a', DIFF.diff({ a: 1, t: 1 }, { a: 2, t: 9 }, { ignoreKeys: ['$.t'] }).changes[0].path, '$.a');
  t('数值容差内视为相等', DIFF.diff({ a: 1.0 }, { a: 1.05 }, { numericTolerance: 0.1 }).equal, true);
  t('数值容差外不等', DIFF.diff({ a: 1.0 }, { a: 1.5 }, { numericTolerance: 0.1 }).equal, false);
  t('maxChanges 截断', DIFF.diff(
    Array.from({ length: 20 }, (_, i) => i),
    Array.from({ length: 20 }, (_, i) => i + 100),
    { maxChanges: 5 }).changes.length, 5);
  t('maxChanges 标记 truncated', DIFF.diff(
    Array.from({ length: 20 }, (_, i) => i),
    Array.from({ length: 20 }, (_, i) => i + 100),
    { maxChanges: 5 }).truncated, true);
  t('相等时 changes 为空', DIFF.diff({ a: 1 }, { a: 1 }).changes, []);

  /* ========================= 工具层 ========================= */

  section('jsonx_parse · 自动识别');

  t('识别 JSON 对象', (await parseTool.run({ text: '{"a":1}' })).format, 'json');
  t('识别 JSON 数组', (await parseTool.run({ text: '[1,2]' })).format, 'json');
  t('识别 YAML', (await parseTool.run({ text: 'a: 1\nb: 2' })).format, 'yaml');
  t('识别 CSV', (await parseTool.run({ text: 'a,b\n1,2' })).format, 'csv');
  t('识别 TSV', (await parseTool.run({ text: 'a\tb\n1\t2' })).format, 'tsv');
  t('YAML 嵌套不被误判为 CSV', (await parseTool.run({ text: 'srv:\n  host: h\n  port: 1' })).format, 'yaml');

  section('jsonx_parse · 输出与边界');

  const pr = await parseTool.run({ text: 'id,phone\n1,0912\n2,0077' });
  tOk('parse 输出含列类型表', pr._text.includes('列类型'));
  tOk('parse 输出含预览', pr._text.includes('预览'));
  tOk('parse 保留前导零', pr._text.includes('0912'));
  t('parse 结构化返回 rowCount', pr.rowCount, 2);
  t('parse 自动识别信息存在', pr.detected !== null, true);
  t('指定 format 时 detected 为 null', (await parseTool.run({ text: 'a: 1', format: 'yaml' })).detected, null);
  tThrowAsync('空文本报错', () => parseTool.run({ text: '' }), '请提供 text');
  tThrowAsync('非法 format 报错', () => parseTool.run({ text: 'a: 1', format: 'xml' }), 'format 只能是');

  t('CSV header=false 生成列名', (await parseTool.run({ text: '1,2', header: false })).columnNames, ['col1', 'col2']);
  t('infer=false 全字符串', (await parseTool.run({ text: 'a\n1', infer: false })).records[0].a, '1');
  t('单列 CSV 不被误判为 YAML', (await parseTool.run({ text: 'name\nalice\nbob' })).format, 'csv');
  t('单列 CSV 行数正确', (await parseTool.run({ text: 'name\nalice\nbob' })).rowCount, 2);
  t('单列 CSV 列名正确', (await parseTool.run({ text: 'name\nalice\nbob' })).columnNames, ['name']);
  // ★ columns 必须是对象数组（与 schema.columns 同形）。
  // 踩过的坑：原来这里 columns 是字符串数组、schema.columns 是对象数组，
  // 同名不同形 —— 调用方拿 columns 去取 c.type 会得到 undefined 而不报错。
  const colR = await parseTool.run({ text: 'id,name\n1,a\n2,b' });
  t('columns 是对象数组', colR.columns.map(c => c.name), ['id', 'name']);
  t('columns[0].type 可用', colR.columns[0].type, 'number');
  t('columns 与 schema.columns 同形', JSON.stringify(colR.columns), JSON.stringify(colR.schema.columns));
  t('maxRows 生效', (await parseTool.run({ text: 'a\n1\n2\n3', maxRows: 2 })).rowCount, 2);
  // 单行纯文本是合法的 YAML 标量，因此不会"无法识别"，而是以低置信度标注为标量
  const scalarR = await parseTool.run({ text: '!!!@@@###' });
  t('无结构单行文本按标量处理', scalarR.format, 'yaml');
  tOk('标量识别给出 scalar 标记', scalarR.detected && scalarR.detected.scalar === true);

  section('jsonx_convert · 各方向');

  const c1 = await convertTool.run({ text: '{"a":1,"b":"x"}', to: 'yaml' });
  tOk('JSON→YAML 输出', c1.output.includes('a: 1'));
  tOk('JSON→YAML 往返校验通过', c1.roundTrip.ok === true);

  const c2 = await convertTool.run({ text: 'a: 1\nb: x', to: 'json' });
  tOk('YAML→JSON 输出可解析', (() => { try { JSON.parse(c2.output); return true; } catch (e) { return false; } })());

  const c3 = await convertTool.run({ text: 'users:\n  - id: 1\n    n: a', to: 'csv', arrayPath: '$.users' });
  tOk('YAML→CSV 含表头', c3.output.includes('id,n'));
  tOk('YAML→CSV 含数据', c3.output.includes('1,a'));

  const c4 = await convertTool.run({ text: 'a,b\n1,2', to: 'json' });
  t('CSV→JSON 类型推断', JSON.parse(c4.output)[0].a, 1);
  tOk('CSV→JSON 往返校验通过', c4.roundTrip.ok === true);

  const c5 = await convertTool.run({ text: '[{id:1},{id:2}]', to: 'markdown' });
  tOk('JSON→Markdown 表格', c5.output.includes('| id |'));

  const c6 = await convertTool.run({ text: 'a,b\n1,2', to: 'tsv' });
  tOk('TSV 输出用制表符', c6.output.includes('\t'));

  section('jsonx_convert · 嵌套与错误路径');

  tThrowAsync('嵌套转 CSV 默认报错',
    () => convertTool.run({ text: '[{a:{b:1}}]', to: 'csv' }), '无法直接转成 CSV');
  tOk('报错里给出 arrayPath 建议',
    (await convertTool.run({ text: '{"items":[{"a":1}]}', to: 'csv' }).then(() => '', e => e.message)).includes('arrayPath'));

  const c7 = await convertTool.run({ text: '[{"id":1, "u":{"n":"a"}}]', to: 'csv', flatten: 'dot' });
  tOk('flatten=dot 展开点号列名', c7.output.includes('u.n'));

  const c8 = await convertTool.run({ text: '[{"id":1, "u":{"n":"a"}}]', to: 'csv', flatten: 'json' });
  tOk('flatten=json 序列化嵌套值', c8.output.includes('""n""'));

  tThrowAsync('缺 to 报错', () => convertTool.run({ text: 'a: 1' }), '请提供 to');
  tThrowAsync('非法 to 报错', () => convertTool.run({ text: 'a: 1', to: 'xml' }), 'to 只能是');
  tThrowAsync('arrayPath 无匹配报错',
    () => convertTool.run({ text: '{"a":1}', to: 'csv', arrayPath: '$.nope' }), '没有匹配到任何数据');
  tThrowAsync('标量转 CSV 报错',
    () => convertTool.run({ text: '"hello"', to: 'csv' }), '');

  const cq = await convertTool.run({ text: 'a,b\n1,"x,y"', to: 'json' });
  tOk('CSV 引号内逗号往返保留', cq.output.includes('x,y'));
  t('CSV 引号内逗号解析为一个字段', JSON.parse(cq.output)[0].b, 'x,y');
  t('sortKeys 排序输出', (await convertTool.run({ text: '{"b":1,"a":2}', to: 'json', sortKeys: true })).output.indexOf('"a"') <
    (await convertTool.run({ text: '{"b":1,"a":2}', to: 'json', sortKeys: true })).output.indexOf('"b"'), true);

  section('jsonx_query · 取值');

  const qd = '{"store":{"items":[{"id":1,"n":"A"},{"id":2,"n":"B"}],"meta":{"open":true}},"ver":"1.0"}';
  t('单路径取值', (await queryTool.run({ text: qd, path: '$.ver' })).results[0].matches[0].value, '1.0');
  t('通配取值', (await queryTool.run({ text: qd, path: '$.store.items[*].n' })).results[0].count, 2);
  t('多路径查询', (await queryTool.run({ text: qd, paths: ['$.ver', '$..id'] })).results.length, 2);
  tOk('输出含顶层键提示', (await queryTool.run({ text: qd, path: '$.ver' }))._text.includes('顶层可用的键'));
  tOk('路径不存在时给出相近提示',
    (await queryTool.run({ text: qd, path: '$.store.itemz' }))._text.includes('没有 "itemz" 这个键'));

  const qf = await queryTool.run({ text: qd, path: '$.store.items[?(@.id>1)]' });
  t('不支持过滤器时该条 error 有值', typeof qf.results[0].error === 'string', true);
  tOk('不支持过滤器时输出标注 ✗', qf._text.includes('✗'));
  tOk('过滤器错误给替代方案', qf.results[0].error.includes('不支持过滤器'));

  tThrowAsync('缺 path 报错', () => queryTool.run({ text: qd }), '请提供 path');
  t('limit 生效', (await queryTool.run({ text: qd, path: '$.store.items[*]', limit: 1 })).results[0].matches.length, 1);
  tOk('limit 截断有标记', /只显示前 1 条/.test((await queryTool.run({ text: qd, path: '$.store.items[*]', limit: 1 }))._text));
  t('CSV 上查询', (await queryTool.run({ text: 'id,n\n1,a\n2,b', path: '$[*].n' })).results[0].count, 2);

  section('jsonx_schema · 结构');

  const sr = await schemaTool.run({ text: 'id,name\n1,a\n2,b' });
  tOk('CSV schema 输出列定义', sr._text.includes('列定义'));
  // schema 的 columns 保持"纯名字数组"（这是 schema 自己的对外契约，与 columnNames 同义）
  t('CSV schema 返回 columns（名字数组）', sr.columns, ['id', 'name']);
  t('CSV schema 同时给出结构化列定义', sr.columnSchema.columns.map(c => c.type), ['number', 'string']);
  tOk('CSV schema 文本里不出现 [object Object]', !/\[object Object\]/.test(sr._text));
  const sj = await schemaTool.run({ text: '[{"a":1},{"a":2,"b":3}]' });
  tOk('JSON schema 识别记录集', sj._text.includes('这是一个记录集'));
  t('JSON schema 可选字段', sj.records.optionalFields, ['b']);
  tThrowAsync('schema 空文本报错', () => schemaTool.run({ text: '  ' }), '请提供 text');

  section('jsonx_diff · 工具层');

  const d1 = await diffTool.run({ left: '{"a":1}', right: '{"a":2}' });
  t('工具层 diff 不等', d1.equal, false);
  t('工具层 diff 改动数', d1.changes.length, 1);
  tOk('工具层 diff 输出表格', d1._text.includes('改动明细'));
  const d2 = await diffTool.run({ left: '{"b":1,"a":2}', right: '{"a":2,"b":1}' });
  t('工具层键顺序相等', d2.equal, true);
  tOk('相等时输出确认语', d2._text.includes('完全相等'));
  const d3 = await diffTool.run({ left: '[{id:1},{id:2}]', right: '[{id:2},{id:3}]', arrayMode: 'byKey' });
  tOk('byKey 路径含 id=', JSON.stringify(d3.changes).includes('id='));
  const d4 = await diffTool.run({ left: '{"a":1,"t":1}', right: '{"a":1,"t":9}', ignoreKeys: ['$.t'] });
  t('ignoreKeys 后相等', d4.equal, true);
  tThrowAsync('缺 left/right 报错', () => diffTool.run({ left: '{}' }), '请提供 left 与 right');
  tThrowAsync('非法 arrayMode 报错', () => diffTool.run({ left: '{}', right: '{}', arrayMode: 'x' }), 'arrayMode 只能是');

  section('jsonx_aggregate · 统计');

  const csvAgg = 'name,dept,salary\nAlice,Eng,120\nBob,Eng,100\nCarol,Sales,90\nDave,Sales,95';
  const a1 = await aggTool.run({ text: csvAgg });
  t('记录数', a1.recordCount, 4);
  tOk('输出含字段统计', a1._text.includes('字段统计'));
  tOk('salary 合计正确（120+100+90+95=405）', a1._text.includes('405'));
  tOk('非数值字段标注不适用', a1._text.includes('非数值字段'));
  const a2 = await aggTool.run({ text: csvAgg, groupBy: 'dept', fields: ['salary'] });
  tOk('分组统计输出', a2._text.includes('分组统计'));
  tOk('Eng 组求和 220', a2._text.includes('220'));
  tOk('Sales 组求和 185', a2._text.includes('185'));
  const a3 = await aggTool.run({ text: csvAgg, filter: { dept: 'Eng' } });
  t('筛选后记录数', a3.recordCount, 2);
  tThrowAsync('筛选无匹配报错',
    () => aggTool.run({ text: csvAgg, filter: { dept: 'Nope' } }), '没有匹配到任何记录');
  tThrowAsync('groupBy 字段不存在报错',
    () => aggTool.run({ text: csvAgg, groupBy: 'nope' }), '不存在');
  tThrowAsync('非法聚合函数报错',
    () => aggTool.run({ text: csvAgg, aggs: ['bogus'] }), '不支持的统计量');
  tThrowAsync('path 指向非数组报错',
    () => aggTool.run({ text: '{"a":1}', path: '$.a' }), '不是数组');
  tThrowAsync('空数组报错', () => aggTool.run({ text: '[]' }), '空数组');
  const a4 = await aggTool.run({ text: '[1,2,3,4]', aggs: ['count', 'sum', 'avg', 'median', 'stddev'] });
  t('标量数组求和', a4._text.includes('10'), true);
  const a5 = await aggTool.run({ text: 'v\n1\n2\n3\n4\n5', aggs: ['median'] });
  tOk('中位数 3', /\|\s*3\s*\|/.test(a5._text));
  const a6 = await aggTool.run({ text: 'v\n1\n2\n3\n4\n5', aggs: ['distinct'] });
  tOk('唯一值 5', a6._text.includes('5'));

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
