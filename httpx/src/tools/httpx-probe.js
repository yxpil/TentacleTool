'use strict';
/**
 * httpx_probe —— 简易探测
 *
 * 给定 host，分别探测 http / https：状态码、重定向去向、HTTPS 证书有效期
 * （用 tls 模块直接握取对端证书，如实报出自签名/过期/主机名不符等）。
 */
const tls = require('tls');
const { doHttpRequest } = require('../utils/client');
const { errorResult } = require('../utils/out');

const name = 'httpx_probe';
const title = '简易探测';

const description = '给定 host（可带端口，如 "example.com" 或 "example.com:8443"），分别探测 http 与 https：状态码、重定向去向、HTTPS 证书主体/签发者/有效期（用 tls 直接握取对端证书，如实报出自签名/过期/主机名不符，不做全局降级）。需访问内网传 allowPrivate=true。';

const inputSchema = {
  type: 'object',
  properties: {
    host: { type: 'string', description: '目标主机（如 "example.com" 或 "example.com:8443"）' },
    timeout: { type: 'number', description: '超时毫秒（默认 30000）' },
    allowPrivate: { type: 'boolean', description: '允许访问内网/环回地址（默认 false）' }
  },
  required: ['host']
};

function parseHost(host) {
  let s = String(host).trim();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    const h = s.slice(1, end);
    const p = s.slice(end + 1).match(/^:(\d+)$/);
    return { hostname: h, port: p ? parseInt(p[1], 10) : null };
  }
  const idx = s.lastIndexOf(':');
  if (idx > 0) {
    const maybePort = s.slice(idx + 1);
    if (/^\d+$/.test(maybePort)) {
      return { hostname: s.slice(0, idx), port: parseInt(maybePort, 10) };
    }
  }
  return { hostname: s, port: null };
}

function tlsProbe(hostname, port, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const sock = tls.connect(port, hostname, { servername: hostname, rejectUnauthorized: false }, () => {
      const cert = sock.getPeerCertificate(true);
      const hasCert = cert && cert.raw;
      let info = null;
      if (hasCert) {
        info = {
          subject: cert.subject ? cert.subject.CN || cert.subject.O || JSON.stringify(cert.subject) : null,
          issuer: cert.issuer ? cert.issuer.CN || cert.issuer.O || JSON.stringify(cert.issuer) : null,
          validFrom: cert.validFrom || null,
          validTo: cert.validTo || null,
          serial: cert.serialNumber || null,
          fingerprint: cert.fingerprint || null
        };
        const now = Date.now();
        if (cert.validTo && new Date(cert.validTo).getTime() < now) info.expired = true;
        if (cert.validFrom && new Date(cert.validFrom).getTime() > now) info.notYetValid = true;
      }
      finish({
        connected: true,
        authorized: sock.authorized,
        authorizationError: sock.authorizationError || null,
        cert: info
      });
      sock.destroy();
    });
    sock.on('error', (e) => finish({ connected: false, error: e.message }));
    sock.on('timeout', () => { sock.destroy(new Error('TLS 探测超时')); });
    sock.setTimeout(timeout, () => sock.destroy(new Error('TLS 探测超时')));
  });
}

async function httpStatus(scheme, hostname, port, allowPrivate, timeout) {
  const url = `${scheme}://${hostname}:${port}/`;
  try {
    const res = await doHttpRequest({
      method: 'HEAD', url, allowPrivate, timeout,
      maxBodyBytes: 0, followRedirect: true, maxRedirects: 5
    });
    return {
      reachable: true,
      status: res.status,
      statusText: res.statusText,
      redirectTo: res.redirected ? (res.redirectChain[res.redirectChain.length - 1].to || null) : null,
      finalUrl: res.finalUrl
    };
  } catch (e) {
    return { reachable: false, error: e.message, ssrfBlocked: e.code === 'SSRF_BLOCKED' };
  }
}

async function run(args = {}) {
  if (!args.host) return { _text: '用法: httpx_probe(host="example.com")', isError: true, error: '缺少 host', errorCode: null };
  const allowPrivate = !!args.allowPrivate;
  const timeout = args.timeout != null ? args.timeout : 30000;
  const { hostname, port } = parseHost(args.host);

  const httpPort = port || 80;
  const httpsPort = port || 443;

  const lines = [];
  lines.push(`## httpx_probe: ${hostname}${port ? ':' + port : ''}`);
  lines.push('');

  const httpRes = await httpStatus('http', hostname, httpPort, allowPrivate, timeout);
  lines.push('HTTP:');
  if (httpRes.reachable) {
    lines.push(`  状态: ${httpRes.status} ${httpRes.statusText}`);
    if (httpRes.redirectTo) lines.push(`  重定向到: ${httpRes.redirectTo}`);
    else lines.push('  重定向: 无');
  } else {
    lines.push(`  不可达: ${httpRes.error}`);
  }

  const tlsInfo = await tlsProbe(hostname, httpsPort, timeout);
  lines.push('');
  lines.push('HTTPS:');
  if (!tlsInfo.connected) {
    lines.push(`  TLS 不可连: ${tlsInfo.error}`);
  } else {
    if (tlsInfo.cert) {
      const c = tlsInfo.cert;
      lines.push(`  证书主体: ${c.subject || '(无 CN)'}`);
      lines.push(`  签发者: ${c.issuer || '(无)'}`);
      lines.push(`  有效期: ${c.validFrom || '?'} ~ ${c.validTo || '?'}`);
      const flags = [];
      if (c.expired) flags.push('已过期');
      if (c.notYetValid) flags.push('尚未生效');
      if (tlsInfo.authorizationError) flags.push('授权错误: ' + tlsInfo.authorizationError);
      else flags.push('链校验通过');
      lines.push(`  状态: ${flags.join('；')}`);
    } else {
      lines.push('  未提供证书');
    }
    // HTTPS 上的 HTTP 状态
    const httpsRes = await httpStatus('https', hostname, httpsPort, allowPrivate, timeout);
    if (httpsRes.reachable) {
      lines.push(`  状态: ${httpsRes.status} ${httpsRes.statusText}`);
      if (httpsRes.redirectTo) lines.push(`  重定向到: ${httpsRes.redirectTo}`);
    } else {
      lines.push(`  HTTP 状态: 不可达 (${httpsRes.error})`);
    }
  }

  return {
    _text: lines.join('\n'),
    isError: false,
    host: hostname,
    port: port || null,
    http: httpRes,
    https: {
      tlsConnected: tlsInfo.connected,
      authorized: tlsInfo.authorized,
      authorizationError: tlsInfo.authorizationError || null,
      cert: tlsInfo.cert
    }
  };
}

module.exports = { name, title, description, inputSchema, run, parseHost, tlsProbe };
