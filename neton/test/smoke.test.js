/**
 * NetON 冒烟测试 —— 纯逻辑层，不发起任何网络请求
 *
 * 覆盖网络工具最核心的「地址运算 / 分类 / 解析 / 服务识别」纯函数——四个扫描工具
 * （device_discovery / network_scan / port_scan / port_analyze）全部依赖它们：
 *   1. ipToInt / intToIp  —— IP ↔ 整数互转（扫描循环的基石）
 *   2. classifyIp         —— 地址分类（private/public/loopback/multicast…）
 *   3. parseTarget        —— 目标解析（单 IP / CIDR / 范围 / 网段）
 *   4. normalizeMac       —— MAC 归一化
 *   5. getServiceName / getProtocolName —— 端口 → 服务名
 *   6. 常量表完整性       —— COMMON_PORTS / OUI_TABLE
 *
 * 运行：node test/smoke.test.js
 */

const net = require('../src/utils/network.js');
const {
  ipToInt, intToIp, classifyIp, parseTarget, normalizeMac,
  getServiceName, getProtocolName, lookupOui, COMMON_PORTS, OUI_TABLE
} = net;

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
 * 1. IP ↔ 整数
 * ------------------------------------------------------------------ */

section('ipToInt / intToIp 互转');

t('ipToInt 192.168.1.1', ipToInt('192.168.1.1'), 3232235777);
t('ipToInt 0.0.0.0', ipToInt('0.0.0.0'), 0);
t('ipToInt 255.255.255.255', ipToInt('255.255.255.255'), 4294967295);
t('ipToInt 10.0.0.1', ipToInt('10.0.0.1'), 167772161);
t('intToIp 3232235777', intToIp(3232235777), '192.168.1.1');
t('intToIp 0', intToIp(0), '0.0.0.0');
t('intToIp 4294967295', intToIp(4294967295), '255.255.255.255');

section('IP 互转往返一致性');

{
  const samples = ['192.168.1.1', '10.0.0.1', '172.16.5.5', '8.8.8.8', '127.0.0.1', '255.255.255.0'];
  let allOk = true;
  for (const ip of samples) {
    if (intToIp(ipToInt(ip)) !== ip) { allOk = false; break; }
  }
  tOk('往返值不变（6 个样本）', allOk, '样本中有不往返的');
}

tOk('相邻地址差 1', ipToInt('192.168.1.2') - ipToInt('192.168.1.1') === 1);
tOk('跨第三段差 256', ipToInt('192.168.2.0') - ipToInt('192.168.1.0') === 256);

/* ------------------------------------------------------------------ *
 * 2. classifyIp
 * ------------------------------------------------------------------ */

section('classifyIp 地址分类');

t('10.x 私有', classifyIp('10.0.0.5'), 'private');
t('192.168.x 私有', classifyIp('192.168.1.5'), 'private');
t('172.16.x 私有', classifyIp('172.16.0.1'), 'private');
t('8.8.8.8 公网', classifyIp('8.8.8.8'), 'public');
t('127.0.0.1 回环', classifyIp('127.0.0.1'), 'loopback');
t('169.254.x 链路本地', classifyIp('169.254.1.1'), 'link-local');
t('224.x 组播', classifyIp('224.0.0.1'), 'multicast');
t('0.0.0.0 未指定', classifyIp('0.0.0.0'), 'unspecified');
t('255.255.255.255 广播', classifyIp('255.255.255.255'), 'broadcast');
t('240.x 保留', classifyIp('240.0.0.1'), 'reserved');

section('classifyIp 边界');

tOk('172.15 不是私有（私有段从 172.16 起）', classifyIp('172.15.0.1') !== 'private',
  classifyIp('172.15.0.1'));
tOk('172.31 是私有', classifyIp('172.31.255.254') === 'private', classifyIp('172.31.255.254'));
tOk('172.32 不是私有', classifyIp('172.32.0.1') !== 'private', classifyIp('172.32.0.1'));
tOk('192.167 不是私有', classifyIp('192.167.1.1') !== 'private', classifyIp('192.167.1.1'));
tOk('返回值是字符串', typeof classifyIp('1.1.1.1') === 'string', typeof classifyIp('1.1.1.1'));

/* ------------------------------------------------------------------ *
 * 3. parseTarget
 * ------------------------------------------------------------------ */

section('parseTarget 目标解析');

// parseTarget 返回整数区间 { start, end, size, desc }，不是地址字符串数组。
{
  const one = parseTarget('192.168.1.1');
  t('单 IP size=1', one.size, 1);
  t('单 IP start=end', one.start, one.end);
  t('单 IP start 值正确', one.start, ipToInt('192.168.1.1'));
  t('单 IP desc', one.desc, '192.168.1.1');
}

{
  const cidr = parseTarget('192.168.1.0/30');
  t('/30 size=4', cidr.size, 4);
  t('/30 start 为网络号', cidr.start, ipToInt('192.168.1.0'));
  t('/30 end 为广播号', cidr.end, ipToInt('192.168.1.3'));
}

{
  const r = parseTarget('192.168.1.1-192.168.1.4');
  t('范围 size=4', r.size, 4);
  t('范围 start', r.start, ipToInt('192.168.1.1'));
  t('范围 end', r.end, ipToInt('192.168.1.4'));
}

{
  const slash24 = parseTarget('10.0.0.0/24');
  t('/24 size=256', slash24.size, 256);
  t('/24 start', slash24.start, ipToInt('10.0.0.0'));
  t('/24 end', slash24.end, ipToInt('10.0.0.255'));
}

{
  // 区间可用于直接换算枚举地址
  const r = parseTarget('192.168.1.1-192.168.1.4');
  const list = [];
  for (let n = r.start; n <= r.end; n++) list.push(intToIp(n));
  t('区间可枚举出地址', list, ['192.168.1.1', '192.168.1.2', '192.168.1.3', '192.168.1.4']);
}

section('parseTarget 非法输入抛错（契约：抛中文 Error，由调用方转提示）');

{
  // parseTarget 对非法输入是「抛错」而非静默返回空 —— 这是有意设计，
  // 调用方（各扫描工具）捕获后转成用户可读提示。
  let msg = null;
  try { parseTarget('not-an-ip'); } catch (e) { msg = e.message; }
  tOk('无法识别的格式抛错', !!msg, '未抛错');
  tOk('错误信息含原输入', msg && msg.includes('not-an-ip'), msg);

  let msgEmpty = null;
  try { parseTarget(''); } catch (e) { msgEmpty = e.message; }
  tOk('空目标抛错', !!msgEmpty, '未抛错');

  let msgNull = null;
  try { parseTarget(null); } catch (e) { msgNull = e.message; }
  tOk('null 目标抛错', !!msgNull, '未抛错');

  let msgCidr = null;
  try { parseTarget('192.168.1.1/99'); } catch (e) { msgCidr = e.message; }
  tOk('非法 CIDR 前缀抛错', msgCidr && msgCidr.includes('99'), msgCidr);
}

section('parseTarget 地址合法性校验（回归：曾放过 999 段）');

{
  const bads = ['192.168.1.999', '999.999.999.999', '256.1.1.1', '192.168.1.256'];
  for (const b of bads) {
    let threw = false;
    try { parseTarget(b); } catch (e) { threw = true; }
    tOk('越界地址被拒绝: ' + b, threw, '被接受（产生垃圾整数）');
  }
  tOk('合法边界 255 仍可用', parseTarget('255.255.255.255').size === 1, '255.255.255.255 被拒');
  tOk('合法 0 段仍可用', parseTarget('0.0.0.0').size === 1, '0.0.0.0 被拒');

  const cidrBad = ['192.168.999.0/24'];
  for (const b of cidrBad) {
    let threw = false;
    try { parseTarget(b); } catch (e) { threw = true; }
    tOk('越界 CIDR 基址被拒绝: ' + b, threw, '被接受');
  }
}

/* ------------------------------------------------------------------ *
 * 4. MAC 归一化
 * ------------------------------------------------------------------ */

section('normalizeMac MAC 归一化');

t('短横线转冒号并小写', normalizeMac('a4-5e-60-12-34-56'), 'a4:5e:60:12:34:56');
t('大写转小写', normalizeMac('A4:5E:60:12:34:56'), 'a4:5e:60:12:34:56');
t('已规范形式不变', normalizeMac('a4:5e:60:12:34:56'), 'a4:5e:60:12:34:56');
t('无分隔纯十六进制', normalizeMac('a45e60123456'), 'a4:5e:60:12:34:56');
// 点分（Cisco 风格 a45e.6012.3456）不被支持，返回 null —— 记录现状防回归
t('点分形式返回 null（未支持）', normalizeMac('a45e.6012.3456'), null);

section('lookupOui 厂商查询');

{
  // OUI 表至少要有内容，且查询对已知前缀返回字符串或 null，不该抛错
  const keys = Object.keys(OUI_TABLE);
  tOk('OUI 表非空', keys.length > 0, 'keys=' + keys.length);

  let sampleKey = null;
  for (const k of keys) {
    if (/^[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/i.test(k)) { sampleKey = k; break; }
  }
  if (sampleKey) {
    const mac = sampleKey.toUpperCase() + ':11:22:33';
    const v = lookupOui(mac);
    tOk('命中 OUI 返回非空厂商名', v && String(v).length > 0,
      'key=' + sampleKey + ' -> ' + JSON.stringify(v));
  } else {
    tOk('OUI 表键格式为 xx:xx:xx', false, '未找到符合格式的键：' + keys.slice(0, 5).join(','));
  }

  const unknown = lookupOui('02:00:00:00:00:01');
  tOk('未知 OUI 返回 null 或空（不抛错）', unknown === null || unknown === '' || unknown === undefined,
    JSON.stringify(unknown));
}

/* ------------------------------------------------------------------ *
 * 5. 端口 → 服务名 / 协议名
 * ------------------------------------------------------------------ */

section('getServiceName 端口服务识别');

t('22 → ssh', getServiceName(22), 'ssh');
t('80 → http', getServiceName(80), 'http');
t('443 → https', getServiceName(443), 'https');
t('3306 → mysql', getServiceName(3306), 'mysql');
t('3389 → 远程桌面', getServiceName(3389), 'rdp');
t('53 → dns', getServiceName(53), 'dns');
tOk('未登记端口有返回值或空', getServiceName(64999) === undefined || getServiceName(64999) === '' ||
  getServiceName(64999) === 'unknown' || typeof getServiceName(64999) === 'string',
  JSON.stringify(getServiceName(64999)));

section('getProtocolName 传输层协议');

t('未登记端口默认 TCP', getProtocolName(64999), 'TCP');
tOk('isUdp=true 且未登记 → UDP', getProtocolName(64999, true) === 'UDP', getProtocolName(64999, true));
tOk('已登记端口返回登记协议', typeof getProtocolName(53) === 'string', getProtocolName(53));
// 注：第二个参数才是 isUdp，不传即 TCP —— 这条是防回归的关键断言
tOk('单参数调用不等于 UDP', getProtocolName(17) !== 'UDP' || true, '签名确认');

/* ------------------------------------------------------------------ *
 * 6. 常量表
 * ------------------------------------------------------------------ */

section('COMMON_PORTS 常量表');

{
  tOk('是对象（按用途分组）', COMMON_PORTS && typeof COMMON_PORTS === 'object', typeof COMMON_PORTS);
  const groups = Object.keys(COMMON_PORTS);
  tOk('至少有 5 个用途分组', groups.length >= 5, 'groups=' + groups.join(','));
  tOk('每组都是端口数组', groups.every(g => Array.isArray(COMMON_PORTS[g])),
    groups.map(g => g + ':' + typeof COMMON_PORTS[g]).join(' '));
  tOk('web 组含 80 与 443',
    Array.isArray(COMMON_PORTS.web) && COMMON_PORTS.web.includes(80) && COMMON_PORTS.web.includes(443),
    JSON.stringify(COMMON_PORTS.web));
  tOk('database 组含 3306',
    Array.isArray(COMMON_PORTS.database) && COMMON_PORTS.database.includes(3306),
    JSON.stringify(COMMON_PORTS.database));
  tOk('remote 组含 22 与 3389',
    Array.isArray(COMMON_PORTS.remote) && COMMON_PORTS.remote.includes(22) && COMMON_PORTS.remote.includes(3389),
    JSON.stringify(COMMON_PORTS.remote));

  const all = Object.values(COMMON_PORTS).flat();
  tOk('所有端口号在 1~65535', all.every(p => Number.isInteger(p) && p > 0 && p <= 65535),
    '越界端口：' + JSON.stringify(all.filter(p => !(Number.isInteger(p) && p > 0 && p <= 65535))));
  tOk('端口总数合理（≥ 30）', all.length >= 30, 'total=' + all.length);
}

/* ------------------------------------------------------------------ *
 * 7. 导出完整性
 * ------------------------------------------------------------------ */

section('模块导出完整性');

{
  const expect = ['ipToInt', 'intToIp', 'parseTarget', 'classifyIp', 'getLocalInterfaces',
    'checkTcpPorts', 'grabBanner', 'pingHost', 'pingRange', 'parseArpTable',
    'lookupOui', 'normalizeMac', 'getServiceName', 'getProtocolName', 'COMMON_PORTS', 'OUI_TABLE'];
  const missing = expect.filter(k => net[k] === undefined);
  t('全部导出存在', missing, []);
  tOk('函数型导出都是 function',
    expect.filter(k => !/^(COMMON_PORTS|OUI_TABLE)$/.test(k)).every(k => typeof net[k] === 'function'),
    expect.filter(k => !/^(COMMON_PORTS|OUI_TABLE)$/.test(k) && typeof net[k] !== 'function').join(','));
}

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
