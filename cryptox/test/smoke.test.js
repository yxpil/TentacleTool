'use strict';
/**
 * cryptox 纯逻辑层单测（不联网、不监听端口、不碰用户真实文件）
 *
 * 期望值来源：`.probe.js` 的实测输出 + 公开标准测试向量（RFC/NIST/jwt.io 样例）。
 * 绝不凭印象写期望值 —— 那会让"测试失败"这个信号失去意义。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../src/utils/algo');
const F = require('../src/utils/format');
const hash = require('../src/tools/cryptox-hash');
const hmac = require('../src/tools/cryptox-hmac');
const checksum = require('../src/tools/cryptox-checksum');
const encode = require('../src/tools/cryptox-encode');
const decode = require('../src/tools/cryptox-decode');
const jwtT = require('../src/tools/cryptox-jwt');
const uuidT = require('../src/tools/cryptox-uuid');
const password = require('../src/tools/cryptox-password');
const cipher = require('../src/tools/cryptox-cipher');
const registry = require('../src/tools/registry');

let pass = 0, fail = 0;
const failures = [];
function t(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; failures.push({ name, actual: a, expected: e }); }
}
function tOk(name, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push({ name, actual: 'falsy' + (detail ? ' (' + detail + ')' : ''), expected: 'truthy' }); }
}
function tErr(name, fn, substr) {
  try {
    fn();
    fail++; failures.push({ name, actual: '未抛错', expected: '抛错且信息含「' + substr + '」' });
  } catch (e) {
    const m = String(e.message);
    if (m.includes(substr)) pass++;
    else { fail++; failures.push({ name, actual: m, expected: '含「' + substr + '」' }); }
  }
}
function section(s) { console.log('\n=== ' + s + ' ==='); }

/* ─────────────────── 1. 算法与编码归一 ─────────────────── */
section('算法 / 编码归一');
t('缺省 sha256', A.normalizeAlgo(undefined), 'sha256');
t('SHA-256 → sha256', A.normalizeAlgo('SHA-256'), 'sha256');
t('sha3_512 → sha3-512', A.normalizeAlgo('sha3_512'), 'sha3-512');
t('blake2b → blake2b512', A.normalizeAlgo('blake2b'), 'blake2b512');
t('编码缺省 hex', A.normalizeEncoding(undefined), 'hex');
t('编码 BASE_64URL', A.normalizeEncoding('BASE_64URL'), 'base64url');
tErr('未知算法报错并列出可用项', () => A.normalizeAlgo('sha999'), '不支持的算法');
tErr('未知编码报错', () => A.normalizeEncoding('rot13'), '不支持的输出编码');
tOk('恒定时间比较：等值 true', A.safeEqual('abc', 'abc') === true);
tOk('恒定时间比较：长度不同 false 而非抛错', A.safeEqual('abc', 'abcd') === false);
tOk('恒定时间比较：内容不同 false', A.safeEqual('abc', 'abd') === false);

/* ─────────────────── 2. 哈希（标准向量） ─────────────────── */
section('哈希 · 标准向量');
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MD5_ABC = '900150983cd24fb0d6963f7d28e17f72';
const SHA1_ABC = 'a9993e364706816aba3e25717850c26c9cd0d89d';

t('sha256("abc")', hash.run({ input: 'abc' }).results[0].hash, SHA256_ABC);
t('sha256("") 空串', hash.run({ input: '' }).results[0].hash, SHA256_EMPTY);
t('md5("abc")', hash.run({ input: 'abc', algorithm: 'md5' }).results[0].hash, MD5_ABC);
t('sha1("abc")', hash.run({ input: 'abc', algorithm: 'sha1' }).results[0].hash, SHA1_ABC);
t('sha256 base64 输出', hash.run({ input: 'abc', encoding: 'base64' }).results[0].hash, 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
t('字节数按 UTF-8 计', hash.run({ input: '你好' }).results[0].bytes, 6);
t('algorithm 回显', hash.run({ input: 'abc', algorithm: 'SHA-256' }).algorithm, 'sha256');
tOk('摘要长度 sha256=64 hex', hash.run({ input: 'x' }).results[0].hash.length === 64);
tOk('摘要长度 md5=32 hex', hash.run({ input: 'x', algorithm: 'md5' }).results[0].hash.length === 32);
tErr('既无 input 也无 file 报错', () => hash.run({}), '必须提供 input');
tErr('文件不存在报错', () => hash.run({ file: path.join(os.tmpdir(), '__cryptox_missing__.txt') }), '读不到文件');
tErr('未支持算法报错', () => hash.run({ input: 'a', algorithm: 'sha0' }), '不支持的算法');

// 文本与文件同一内容应同摘要
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryptox-test-'));
const fileA = path.join(tmpDir, 'a.txt');
fs.writeFileSync(fileA, 'abc');
t('文件哈希 === 文本哈希', hash.run({ file: fileA }).results[0].hash, SHA256_ABC);

/* ─────────────────── 3. HMAC ─────────────────── */
section('HMAC');
const HMAC_FOX = 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8';
const fox = { key: 'key', input: 'The quick brown fox jumps over the lazy dog' };
t('RFC 标准向量', hmac.run(fox).results[0].signature, HMAC_FOX);
t('校验命中', hmac.run({ ...fox, expected: HMAC_FOX }).results[0].matches, true);
t('校验未命中', hmac.run({ ...fox, expected: 'deadbeef' }).results[0].matches, false);
t('大小写不同的期望值不匹配', hmac.run({ ...fox, expected: HMAC_FOX.toUpperCase() }).results[0].matches, false);
t('未给 expected 时不出现 matches 字段', hmac.run(fox).results[0].matches, undefined);
t('expectedProvided 回显', hmac.run({ ...fox, expected: HMAC_FOX }).expectedProvided, true);
tOk('输出里不含密钥明文', !JSON.stringify(hmac.run(fox)).includes('"key"') || !hmac.run(fox)._text.includes('key'));
tErr('缺 key 报错', () => hmac.run({ input: 'a' }), '必须提供非空的 key');
tErr('空 key 报错', () => hmac.run({ key: '', input: 'a' }), '必须提供非空的 key');
tErr('无输入报错', () => hmac.run({ key: 'k' }), '必须提供 input');

/* ─────────────────── 4. 编码 / 解码 ─────────────────── */
section('编码 / 解码 · 往返与边界');
const ROUND = 'a b&<>"你';
t('base64 编码', encode.run({ input: ROUND, format: 'base64' }).output, 'YSBiJjw+IuS9oA==');
t('base64url 无 padding', encode.run({ input: ROUND, format: 'base64url' }).output, 'YSBiJjw-IuS9oA');
t('hex 编码（UTF-8）', encode.run({ input: ROUND, format: 'hex' }).output, '612062263c3e22e4bda0');
t('url 编码', encode.run({ input: ROUND, format: 'url' }).output, 'a%20b%26%3C%3E%22%E4%BD%A0');
t('uri 编码保留 &', encode.run({ input: ROUND, format: 'uri' }).output, 'a%20b&%3C%3E%22%E4%BD%A0');
t('querystring 空格→+', encode.run({ input: 'a b', format: 'querystring' }).output, 'a+b');
t('html 实体', encode.run({ input: ROUND, format: 'html' }).output, 'a b&amp;&lt;&gt;&quot;你');
t('unicode 转义', encode.run({ input: '你', format: 'unicode' }).output, '\\u4f60');
for (const f of ['base64', 'base64url', 'hex', 'url', 'querystring', 'html', 'unicode']) {
  const enc = encode.run({ input: ROUND, format: f }).output;
  const back = decode.run({ input: enc, format: f === 'querystring' ? 'querystring' : f }).output;
  t('往返 ' + f, back, ROUND);
}
t('emoji 代理对往返', decode.run({ input: encode.run({ input: '🔐 测试', format: 'unicode' }).output, format: 'unicode' }).output, '🔐 测试');
t('base64 容忍缺 padding', decode.run({ input: 'YWJjZA' }).output, 'abcd');
t('base64 容忍空白', decode.run({ input: 'YWJj\nZA=='.replace('==', '') }).output, 'abcd');
t('hex 解码', decode.run({ input: '616263', format: 'hex' }).output, 'abc');
t('hex 容忍 0x 前缀', decode.run({ input: '0x616263', format: 'hex' }).output, 'abc');
t('html 命名+数字+十六进制实体', decode.run({ input: '&lt;a&gt; &#65; &#x4f60;', format: 'html' }).output, '<a> A 你');
t('html 未知实体原样保留', decode.run({ input: '&nope;', format: 'html' }).output, '&nope;');
t('unicode 解码', decode.run({ input: '\\u4f60\\u597d', format: 'unicode' }).output, '你好');
t('url 解码', decode.run({ input: 'a%20b%26c', format: 'url' }).output, 'a b&c');
t('querystring 解码 + → 空格', decode.run({ input: 'a+b%26c', format: 'querystring' }).output, 'a b&c');
tErr('base64 非法字符报错', () => decode.run({ input: '!!!!' }), '不是合法的 base64');
tErr('base64 长度 %4==1 报错', () => decode.run({ input: 'YWJjZ' }), '长度非法');
tErr('hex 奇数长度报错', () => decode.run({ input: 'abc', format: 'hex' }), '必须为偶数');
tErr('hex 非法字符报错', () => decode.run({ input: 'zz', format: 'hex' }), '不是合法的十六进制');
tErr('url 非法转义报错（不静默返回原文）', () => decode.run({ input: '%ZZ', format: 'url' }), 'URL 解码失败');
tErr('编码缺 input 报错', () => encode.run({}), '必须提供 input');
tErr('未知格式报错', () => encode.run({ input: 'a', format: 'rot13' }), '不支持的编码格式');

/* ─────────────────── 5. JWT ─────────────────── */
section('JWT');
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const rj = jwtT.run({ token: TOKEN, secret: 'your-256-bit-secret' });
t('header 解析', rj.header, { alg: 'HS256', typ: 'JWT' });
t('payload 解析', rj.payload, { sub: '1234567890', name: 'John Doe', iat: 1516239022 });
t('HMAC-SHA256 签名验证通过（jwt.io 标准样例）', rj.verify.valid, true);
t('无 exp 时 expired 为 null', rj.expired, null);
t('不给 secret 时跳过验证', jwtT.run({ token: TOKEN }).verify, { attempted: false });
const expTok = jwtT.run({ token: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE1MTYyMzkwMjJ9.x' });
t('过期 token expired=true', expTok.expired, true);
t('时间字段可读', expTok.times[0][2], '2018-01-18T01:30:22.000Z');
t('时间字段标注已过期', expTok.times[0][3], '已过期');
const noneV = jwtT.run({ token: 'eyJhbGciOiJub25lIn0.eyJhIjoxfQ.', secret: 'k' }).verify;
t('alg=none 拒绝视为通过', noneV.valid, false);
t('alg=none 给出原因', noneV.supported, false);
tErr('两段 token 报错', () => jwtT.run({ token: 'abc.def' }), '应有 3 段');
tErr('缺 token 报错', () => jwtT.run({}), '必须提供 token');
tOk('失败签名时 verify.valid=false', jwtT.run({ token: TOKEN, secret: '错的密钥' }).verify.valid === false);

/* ─────────────────── 6. UUID ─────────────────── */
section('UUID');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const v4 = uuidT.run({ version: 'v4' }).ids[0];
tOk('v4 格式正确', UUID_RE.test(v4), v4);
t('v4 版本位是 4', v4[14], '4');
tOk('v4 变体位合法', /[89ab]/.test(v4[19]), v4[19]);
const v7s = uuidT.run({ version: 'v7', count: 3 }).ids;
t('v7 批量数量', v7s.length, 3);
tOk('v7 格式正确', v7s.every(x => UUID_RE.test(x)));
t('v7 版本位是 7', v7s[0][14], '7');
tOk('v7 批量严格递增（同毫秒由 12 位计数器保证）', v7s[0] < v7s[1] && v7s[1] < v7s[2], v7s.join(' < '));
t('v7 批量 20 个仍严格递增', (() => {
  const many = uuidT.run({ version: 'v7', count: 20 }).ids;
  return many.every((x, i) => i === 0 || many[i - 1] < x);
})(), true);
t('count 上限截断到 100', uuidT.run({ version: 'v4', count: 999 }).ids.length, 100);
t('short 默认长度 16', uuidT.run({ version: 'short' }).ids[0].length, 16);
t('short 指定长度 24', uuidT.run({ version: 'short', length: 24 }).ids[0].length, 24);
tOk('short 是 URL 安全字符', /^[A-Za-z0-9_-]+$/.test(uuidT.run({ version: 'short' }).ids[0]));
t('校验 v7 合法', uuidT.run({ validate: '01a0b4f4-0060-7bdf-b9a5-bdeb22e2f06a' }).result.version, 7);
t('校验非法格式', uuidT.run({ validate: 'not-a-uuid' }).result.valid, false);
t('校验模式回显 state', uuidT.run({ validate: v4 }).mode, 'validate');
t('生成模式回显 state', uuidT.run({}).mode, 'generate');
tErr('未知版本报错', () => uuidT.run({ version: 'v9' }), '不支持的 version');

/* ─────────────────── 7. 密码 ─────────────────── */
section('密码');
const weak = password.evaluate('123456');
t('弱口令熵（6 位纯数字 19.9 bits）', weak.entropyBits, 19.9);
t('弱口令等级', weak.level, '极弱');
t('弱口令字符集规模', weak.charsetSize, 10);
tOk('检出"纯数字"', weak.issues.includes('纯数字'));
tOk('检出"常见弱口令"', weak.issues.includes('属于常见弱口令'));
tOk('检出键盘序列', weak.issues.includes('包含键盘/字母表顺序片段'));
const strong = password.evaluate('Tr0ub4dor&3xKcd!!');
t('强口令等级', strong.level, '很强');
t('强口令无弱模式', strong.issues.length, 0);
t('17 位混合字符集熵', strong.entropyBits, 111.7);
t('评估模式回显', password.run({ password: 'abc' }).mode, 'evaluate');
const gen = password.run({ length: 20, symbols: true });
t('生成长度', gen.passwords[0].length, 20);
t('生成模式回显', gen.mode, 'generate');
tOk('四类字符齐全', [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].every(re => re.test(gen.passwords[0])), gen.passwords[0]);
tOk('默认剔除易混字符 0Oo1lI|', ![...gen.passwords[0]].some(ch => '0Oo1lI|'.includes(ch)), gen.passwords[0]);
tOk('批量生成互不相同', new Set(password.run({ length: 16, count: 5 }).passwords).size === 5);
tOk('默认不含符号', !/[^a-zA-Z0-9]/.test(password.run({ length: 32 }).passwords[0]));
tErr('长度越界报错', () => password.run({ length: 200 }), '长度需在 4-128 之间');
t('最小长度 4 且四类齐全时可用', password.run({ length: 4, symbols: true }).passwords[0].length, 4);
tOk('最小长度下四类字符都在', [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].every(re => re.test(password.run({ length: 4, symbols: true }).passwords[0])));
tErr('全部类别关闭报错', () => password.run({ lower: false, upper: false, digits: false }), '至少要启用一类字符');

/* ─────────────────── 8. 加解密 ─────────────────── */
section('AES-256-GCM');
const enc1 = cipher.run({ input: '机密文本 🔐', password: 'pw-123' });
t('封套前缀', enc1.envelope.slice(0, 9), 'CRYPTOX1:');
t('往返一致（含 emoji）', cipher.run({ mode: 'decrypt', input: enc1.envelope, password: 'pw-123' }).plaintext, '机密文本 🔐');
tOk('默认 PBKDF2 100000 次', enc1.iterations === 100000 && enc1.kdf === 'pbkdf2');
tOk('每次加密 salt 不同（密文不同）', cipher.run({ input: '同文', password: 'p' }).envelope !== cipher.run({ input: '同文', password: 'p' }).envelope);
tOk('scrypt 可解密自身产物', (() => {
  const e = cipher.run({ input: 'x', password: 'p', kdf: 'scrypt' });
  return cipher.run({ mode: 'decrypt', input: e.envelope, password: 'p' }).plaintext === 'x';
})());
tErr('错误口令报错', () => cipher.run({ mode: 'decrypt', input: enc1.envelope, password: '错的' }), '解密失败');
tErr('非本工具封套报错', () => cipher.run({ mode: 'decrypt', input: 'plain-text', password: 'p' }), '密文格式不对');
tErr('未知 mode 报错', () => cipher.run({ mode: 'sign', input: 'a', password: 'b' }), '不支持的 mode');
tErr('缺口令报错', () => cipher.run({ input: 'a' }), '必须提供 password');
tOk('输出里不含口令明文', !JSON.stringify(enc1).includes('pw-123'));

// 真篡改：改掉 ct 里的一个字符（保持封套结构合法），应被 GCM 认证标签拦下
const envObj = JSON.parse(Buffer.from(enc1.envelope.slice(9), 'base64').toString('utf8'));
envObj.ct = Buffer.from(envObj.ct, 'base64');
envObj.ct[0] = envObj.ct[0] ^ 0xff;
envObj.ct = envObj.ct.toString('base64');
const tampered = 'CRYPTOX1:' + Buffer.from(JSON.stringify(envObj), 'utf8').toString('base64');
tErr('篡改密文被 GCM 拦下', () => cipher.run({ mode: 'decrypt', input: tampered, password: 'pw-123' }), '解密失败');

/* ─────────────────── 9. 校验和 ─────────────────── */
section('文件校验和');
fs.writeFileSync(path.join(tmpDir, 'b.md'), '# hi');
fs.writeFileSync(path.join(tmpDir, 'c.bin'), Buffer.from([0, 1, 2, 255]));
const sum = checksum.run({ path: tmpDir });
t('目录递归文件数', sum.count, 3);
t('算法回显', sum.algorithm, 'sha256');
t('单文件内容哈希正确', checksum.run({ path: fileA }).results[0].hash, SHA256_ABC);
t('ext 过滤只留 .md', checksum.run({ path: tmpDir, ext: '.md' }).count, 1);
t('ext 不带点也能用', checksum.run({ path: tmpDir, ext: 'txt' }).count, 1);
t('expected 匹配', checksum.run({ path: fileA, expected: SHA256_ABC }).expectedMatched, true);
t('expected 不匹配', checksum.run({ path: fileA, expected: 'deadbeef' }).expectedMatched, false);
t('expected 大小写不敏感', checksum.run({ path: fileA, expected: SHA256_ABC.toUpperCase() }).expectedMatched, true);
t('多文件时不做 expected 比对', checksum.run({ path: tmpDir, expected: SHA256_ABC }).expectedMatched, null);
t('非递归只取一层', checksum.run({ path: tmpDir, recursive: false }).count, 3);
tErr('路径不存在报错', () => checksum.run({ path: path.join(tmpDir, '__nope__') }), '不可访问');
tErr('缺 path 报错', () => checksum.run({}), '必须提供 path');

/* ─────────────────── 10. 输出约定 ─────────────────── */
section('输出约定（表格 / 截断 / 契约）');
const blob = F.cell({ a: 1 });
t('对象单元格被 JSON 化而不是 [object Object]', blob, '{"a":1}');
t('null 显示为破折号', F.cell(null), '—');
t('换行在单元格内替换为 ␤', F.cell('a\nb'), 'a␤b');
t('CJK 显示宽度按 2 计', F.displayWidth('中文ab'), 6);
t('字节格式化', F.size(1536), '1.5 KB');
tOk('长文本被截断并给出续读提示', F.clip('x'.repeat(30000), 100, '缩小范围').includes('输出已截断'));
tOk('表格超上限时明确告知省略行数', F.table(['a'], Array.from({ length: 400 }, (_, i) => ['x'.repeat(40)]), { totalMax: 2000 }).includes('表格已截断'));

(async () => {
  section('registry 契约');
  t('工具数量', registry.TOOLS.length, 9);
  t('工具名清单', registry.TOOLS.map(x => x.name), [
    'cryptox_hash', 'cryptox_hmac', 'cryptox_checksum', 'cryptox_encode', 'cryptox_decode',
    'cryptox_jwt', 'cryptox_uuid', 'cryptox_password', 'cryptox_cipher'
  ]);
  const listed = registry.toMcpTools();
  tOk('toMcpTools 只暴露契约字段', listed.every(x => Object.keys(x).sort().join(',') === 'description,inputSchema,name,title'));
  tOk('每个工具有非空 description', registry.TOOLS.every(x => typeof x.description === 'string' && x.description.length > 20));
  tOk('每个工具有 inputSchema.type=object', registry.TOOLS.every(x => x.inputSchema && x.inputSchema.type === 'object'));
  tOk('encode 模块的内部函数未泄露到工具契约', listed.every(x => !('encodeOne' in x) && !('normalizeFormat' in x)));

  const out = await registry.executeTool('cryptox_hash', { input: 'abc' });
  tOk('executeTool 返回 { text, structured }', typeof out.text === 'string' && typeof out.structured === 'object');
  tOk('structured 里不含 _text', !('_text' in out.structured));
  tOk('text 是纯文本（不以 { 开头）', !out.text.trimStart().startsWith('{'));
  tOk('text 里不含 [object Object]', !/\[object Object\]/.test(out.text));
  tOk('structured 带 algorithm', out.structured.algorithm === 'sha256');

  const encOut = await registry.executeTool('cryptox_encode', { input: '你好' });
  tOk('编码结果同时出现在文本与结构化里', encOut.text.includes('5L2g5aW9') && encOut.structured.output === '5L2g5aW9');

  try {
    await registry.executeTool('cryptox_nope', {});
    fail++; failures.push({ name: '未知工具抛错', actual: '未抛错', expected: '抛错' });
  } catch (e) {
    if (String(e.message).includes('未知工具') && String(e.message).includes('cryptox_hash')) pass++;
    else { fail++; failures.push({ name: '未知工具抛错', actual: e.message, expected: '含「未知工具」与可用清单' }); }
  }

  // 清理临时目录
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n' + '='.repeat(52));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  console.log('='.repeat(52));
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  ✗ ${f.name}\n      实际: ${f.actual}\n      期望: ${f.expected}`);
  }
  process.exit(fail ? 1 : 0);
})();
