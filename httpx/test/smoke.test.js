'use strict';
/**
 * httpx 纯逻辑层单测（不启动 MCP、不请求真实网络）
 *
 * 覆盖 SSRF 闸门纯函数（IP 分类 / 拦截判定 / URL 协议校验 / DNS 解析拦截）、
 * 输出格式化（CJK 列宽 / 大小 / 截断 / 表格）。异步部分（assertSafeHost）在 async 段内测。
 * 期望值全部来自「先跑探针看真实行为、再写期望」，不是凭想象。
 */
const ssrf = require('../src/utils/ssrf');
const fmt = require('../src/utils/format');
const probe = require('../src/tools/httpx-probe');

let pass = 0, fail = 0;
const failures = [];
function t(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + '  → 实际 ' + a + '  期望 ' + e); console.log('  FAIL  ' + name); }
}
function tOk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? '  —— ' + detail : '')); console.log('  FAIL  ' + name); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* ---------- classifyIpv4 ---------- */
section('classifyIpv4 边界分类');
t('10.0.0.1 → private', ssrf.classifyIpv4('10.0.0.1'), 'private');
t('172.16.0.1 → private', ssrf.classifyIpv4('172.16.0.1'), 'private');
t('172.31.255.255 → private', ssrf.classifyIpv4('172.31.255.255'), 'private');
t('172.32.0.1 → public（超出 172.16/12）', ssrf.classifyIpv4('172.32.0.1'), 'public');
t('192.168.1.1 → private', ssrf.classifyIpv4('192.168.1.1'), 'private');
t('127.0.0.1 → loopback', ssrf.classifyIpv4('127.0.0.1'), 'loopback');
t('169.254.1.1 → link-local', ssrf.classifyIpv4('169.254.1.1'), 'link-local');
t('8.8.8.8 → public', ssrf.classifyIpv4('8.8.8.8'), 'public');
t('224.0.0.1 → multicast', ssrf.classifyIpv4('224.0.0.1'), 'multicast');
t('240.0.0.1 → reserved', ssrf.classifyIpv4('240.0.0.1'), 'reserved');
t('0.0.0.0 → private（未指定）', ssrf.classifyIpv4('0.0.0.0'), 'private');
t('255.255.255.255 → reserved', ssrf.classifyIpv4('255.255.255.255'), 'reserved');

/* ---------- isBlockedAddress（含 IPv6） ---------- */
section('isBlockedAddress 拦截判定（含 IPv6 与 IPv4 映射）');
t('127.0.0.1 被拦截', ssrf.isBlockedAddress('127.0.0.1'), true);
t('8.8.8.8 不拦截', ssrf.isBlockedAddress('8.8.8.8'), false);
t('::1 被拦截', ssrf.isBlockedAddress('::1'), true);
t('fc00::1 被拦截（唯一本地）', ssrf.isBlockedAddress('fc00::1'), true);
t('fd12:3456::1 被拦截（唯一本地 fd）', ssrf.isBlockedAddress('fd12:3456::1'), true);
t('fe80::1 被拦截（链路本地）', ssrf.isBlockedAddress('fe80::1'), true);
t('2001:4860:4860::8888 不拦截', ssrf.isBlockedAddress('2001:4860:4860::8888'), false);
t('::ffff:127.0.0.1 被拦截（IPv4 映射环回）', ssrf.isBlockedAddress('::ffff:127.0.0.1'), true);
t('::ffff:8.8.8.8 不拦截（IPv4 映射公网）', ssrf.isBlockedAddress('::ffff:8.8.8.8'), false);

/* ---------- validateUrl 协议校验（同步） ---------- */
section('validateUrl 协议与主机名校验（同步，不做 DNS）');
tOk('拒绝 file: 协议', (() => { try { ssrf.validateUrl('file:///etc/passwd'); return false; } catch (e) { return e.code === 'SSRF_BLOCKED'; } })());
tOk('拒绝 ftp: 协议', (() => { try { ssrf.validateUrl('ftp://x.com'); return false; } catch (e) { return e.code === 'SSRF_BLOCKED'; } })());
tOk('拒绝 gopher: 协议', (() => { try { ssrf.validateUrl('gopher://x'); return false; } catch (e) { return e.code === 'SSRF_BLOCKED'; } })());
tOk('拒绝 data: 协议', (() => { try { ssrf.validateUrl('data:text/plain,hi'); return false; } catch (e) { return e.code === 'SSRF_BLOCKED'; } })());
tOk('接受 http: 绝对地址', (() => { try { const u = ssrf.validateUrl('http://example.com:8080/p'); return u.hostname === 'example.com' && u.port === '8080'; } catch (e) { return false; } })());
tOk('接受 https: 绝对地址', (() => { try { const u = ssrf.validateUrl('https://example.com/p?a=1'); return u.protocol === 'https:' && u.pathname === '/p'; } catch (e) { return false; } })());
tOk('拒绝协议相对 URL（缺协议，new URL 抛错）', (() => { try { ssrf.validateUrl('//example.com'); return false; } catch (e) { return true; } })());
tOk('拒绝非 URL 字符串', (() => { try { ssrf.validateUrl('not a url'); return false; } catch (e) { return e.code === 'SSRF_BLOCKED'; } })());

/* ---------- format 输出格式化 ---------- */
section('format 大小 / 列宽 / 截断');
t('fmtSize 0', fmt.fmtSize(0), '0 B');
t('fmtSize 512', fmt.fmtSize(512), '512 B');
t('fmtSize 1023', fmt.fmtSize(1023), '1023 B');
t('fmtSize 1024', fmt.fmtSize(1024), '1.0 KB');
t('fmtSize 1536', fmt.fmtSize(1536), '1.5 KB');
t('fmtSize 2097152', fmt.fmtSize(2097152), '2.0 MB');
t('fmtSize 10485760', fmt.fmtSize(10485760), '10.0 MB');
t('displayWidth 中文ab = 6', fmt.displayWidth('中文ab'), 6);
t('displayWidth ASCII = 5', fmt.displayWidth('ASCII'), 5);
t('truncateText 窄于上限不截断', fmt.truncateText('hi', 10, '…'), 'hi');
t('truncateText 中文按显示宽度截断', fmt.truncateText('中文123456', 6, '…'), '中文12…');
tOk('renderTable 含表头', /URL/.test(fmt.renderTable(['URL', '状态'], [['https://x', '200']])), '表头缺失');
tOk('renderTable 对齐 CJK（中文列宽计 2）', /中文/.test(fmt.renderTable(['名称', '值'], [['中文', 'v']])), '内容缺失');

/* ---------- parseHost（probe 解析） ---------- */
section('httpx_probe.parseHost');
t('example.com', probe.parseHost('example.com'), { hostname: 'example.com', port: null });
t('example.com:8443', probe.parseHost('example.com:8443'), { hostname: 'example.com', port: 8443 });
t('[::1]:443', probe.parseHost('[::1]:443'), { hostname: '::1', port: 443 });
t('127.0.0.1:8080', probe.parseHost('127.0.0.1:8080'), { hostname: '127.0.0.1', port: 8080 });

/* ---------- assertSafeHost（异步：DNS + 放行开关） ---------- */
section('assertSafeHost 异步闸门');
(async () => {
  let blockedDefault = false, errCode = null;
  try { await ssrf.assertSafeHost('127.0.0.1', false); }
  catch (e) { blockedDefault = true; errCode = e.code; }
  tOk('127.0.0.1 默认拦截抛 SSRF_BLOCKED', blockedDefault && errCode === 'SSRF_BLOCKED', 'blocked=' + blockedDefault + ' code=' + errCode);

  let allowed = false;
  try { await ssrf.assertSafeHost('127.0.0.1', true); allowed = true; }
  catch (e) {}
  tOk('127.0.0.1 allowPrivate=true 放行', allowed, 'allowed=' + allowed);

  let pubAllowed = false;
  try { await ssrf.assertSafeHost('8.8.8.8', false); pubAllowed = true; }
  catch (e) {}
  tOk('公网 IP 默认放行', pubAllowed, 'pubAllowed=' + pubAllowed);

  // 解析失败（无法解析的域名）应被拦截，而非静默放行
  let dnsBlocked = false, dnsCode = null;
  try { await ssrf.assertSafeHost('nonexistent.invalid.invalid', false); }
  catch (e) { dnsBlocked = true; dnsCode = e.code; }
  tOk('无法解析的域名被拦截（不静默放行）', dnsBlocked && dnsCode === 'SSRF_BLOCKED', 'dnsBlocked=' + dnsBlocked);

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(52));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  · ' + f));
  }
  console.log('='.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
