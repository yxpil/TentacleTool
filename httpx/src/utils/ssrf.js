'use strict';
/**
 * SSRF 防护 + URL 校验（零依赖，纯函数为主）
 *
 * 设计原则：
 *  - 只允许 http:/https: 协议，拒绝 file:/ftp:/gopher:/data: 等
 *  - 默认拒绝内网/环回/链路本地/保留地址；需访问时显式传 allowPrivate=true
 *  - 域名类主机做 DNS 解析，逐个地址判定（防 DNS 重绑定到内网）
 *  - 重定向目标同样重新校验
 */
const dns = require('dns');
const net = require('net');

/** 被拦截时抛出的错误，带 code 便于调用方区分 */
class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
    this.code = 'SSRF_BLOCKED';
  }
}

/** 分类 IPv4 地址（返回 'public' / 'private' / 'loopback' / 'link-local' / 'multicast' / 'reserved' / 'invalid'） */
function classifyIpv4(ip) {
  const parts = String(ip).split('.').map(s => parseInt(s, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return 'invalid';
  const [a, b] = parts;
  if (a === 0) return 'private';                 // 0.0.0.0/8 未指定
  if (a === 10) return 'private';                // 10/8
  if (a === 127) return 'loopback';              // 127/8
  if (a === 169 && b === 254) return 'link-local'; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16/12
  if (a === 192 && b === 168) return 'private';  // 192.168/16
  if (a >= 224 && a <= 239) return 'multicast';  // 224/4
  if (a >= 240) return 'reserved';               // 240/4
  return 'public';
}

/** 分类 IPv6 地址（已处理 IPv4 映射/兼容形式） */
function classifyIpv6(ip) {
  let s = String(ip);
  const z = s.indexOf('%');
  if (z >= 0) s = s.slice(0, z); // 去掉区域标识 %eth0
  // 内嵌 IPv4（::ffff:127.0.0.1 等）
  if (s.indexOf('.') >= 0) {
    const v4 = s.split(':').pop();
    if (net.isIP(v4) === 4) return classifyIpv4(v4);
  }
  if (s === '::' || s === '::0' || s === '0:0:0:0:0:0:0:0') return 'private'; // 未指定
  if (s === '::1') return 'loopback';
  const head = s.split(':')[0];
  const first = parseInt(head, 16);
  if (!Number.isNaN(first)) {
    if ((first & 0xfe00) === 0xfc00) return 'private';   // fc00::/7 唯一本地
    if ((first & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
    if ((first & 0xff00) === 0xff00) return 'multicast';  // ff00::/8
  }
  return 'public';
}

/** 判定一个 IP 字面量是否被 SSRF 闸门拦截（非 public 即拦截） */
function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return classifyIpv4(ip) !== 'public';
  if (v === 6) return classifyIpv6(ip) !== 'public';
  return false; // 不是 IP 字面量（域名）由 assertSafeHost 解析后再判
}

/** 同步校验协议与主机名存在性，返回 URL 对象。拒绝非 http(s) 与缺主机名。 */
function validateUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    throw new SsrfError('不是合法的 URL：' + rawUrl);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError('只允许 http/https 协议，已拒绝 ' + u.protocol + '（来自 ' + rawUrl + '）');
  }
  if (!u.hostname) {
    throw new SsrfError('URL 缺少主机名：' + rawUrl);
  }
  return u;
}

function resolveAddresses(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return reject(err);
      resolve((addresses || []).map(a => a.address));
    });
  });
}

/**
 * 异步校验主机是否安全（含 DNS 解析 + 逐地址判定）。
 * @param {string} hostname
 * @param {boolean} allowPrivate 显式放开内网
 */
async function assertSafeHost(hostname, allowPrivate) {
  const v = net.isIP(hostname);
  if (v) {
    if (!allowPrivate && isBlockedAddress(hostname)) {
      throw new SsrfError(hostname + ' 属于环回/内网/链路本地/保留地址，已按 SSRF 策略拦截（需访问内网请传 allowPrivate=true）');
    }
    return;
  }
  if (allowPrivate) return;
  let addrs;
  try {
    addrs = await resolveAddresses(hostname);
  } catch (e) {
    throw new SsrfError('无法解析主机 ' + hostname + '：' + e.message);
  }
  if (!addrs.length) {
    throw new SsrfError('主机 ' + hostname + ' 解析为空，已拦截');
  }
  for (const a of addrs) {
    if (isBlockedAddress(a)) {
      throw new SsrfError('主机 ' + hostname + ' 解析到内网地址 ' + a + '，已按 SSRF 策略拦截（需访问内网请传 allowPrivate=true）');
    }
  }
}

/** 同步快判：IP 字面量是否会被拦（供测试与纯逻辑使用，不做 DNS） */
function isPrivateLiteral(hostname) {
  return net.isIP(hostname) ? isBlockedAddress(hostname) : false;
}

module.exports = {
  SsrfError,
  classifyIpv4,
  classifyIpv6,
  isBlockedAddress,
  validateUrl,
  assertSafeHost,
  isPrivateLiteral
};
