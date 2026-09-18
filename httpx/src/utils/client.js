'use strict';
/**
 * 零依赖 HTTP 请求引擎（node:http/https/zlib）
 *
 * 能力：
 *  - 自动解压 gzip / deflate / br
 *  - 重定向跟随（上限可配，默认 5；303 转 GET）
 *  - 超时（默认 30s，到点销毁连接）
 *  - 认证：basic / bearer（认证头绝不进入日志，由 server 层脱敏）
 *  - 响应体上限（默认 2MB，超出截断并明确告知）
 *  - 文本/二进制按 content-type 智能处理
 *  - 每跳都过 SSRF 闸门
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { validateUrl, assertSafeHost } = require('./ssrf');

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY = 2 * 1024 * 1024;

function isTextual(ct) {
  if (!ct) return false;
  const t = ct.split(';')[0].trim().toLowerCase();
  return t.startsWith('text/') ||
    /json/.test(t) || /xml/.test(t) || /javascript/.test(t) ||
    /x-www-form-urlencoded/.test(t) || /csv/.test(t) ||
    /yaml/.test(t) || /html/.test(t);
}

function safeDecompress(buf, encoding) {
  const e = String(encoding).toLowerCase();
  try {
    if (e.includes('gzip')) return zlib.gunzipSync(buf);
    if (e.includes('deflate')) {
      try { return zlib.inflateSync(buf); }
      catch (_) { return zlib.ungzipSync(buf); }
    }
    if (e.includes('br')) return zlib.brotliDecompressSync(buf);
  } catch (err) {
    // 解压失败则原样返回（可能是分块/损坏），交由上层按文本处理
    return buf;
  }
  return buf;
}

function buildAuthHeader(auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth.type === 'basic') {
    if (!auth.username && auth.username !== '') return null;
    const tok = Buffer.from(auth.username + ':' + (auth.password || '')).toString('base64');
    return 'Basic ' + tok;
  }
  if (auth.type === 'bearer') {
    if (!auth.token) return null;
    return 'Bearer ' + auth.token;
  }
  return null;
}

/** 单跳请求 */
function requestOnce(target, options) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { return reject(new Error('非法 URL: ' + target)); }
    const lib = u.protocol === 'https:' ? https : http;

    const headers = Object.assign({}, options.headers || {});
    // 认证头（不记录到任何日志）
    const authHeader = buildAuthHeader(options.auth);
    if (authHeader && !Object.keys(headers).some(k => k.toLowerCase() === 'authorization')) {
      headers['Authorization'] = authHeader;
    }

    let body = options.body;
    if (body != null) {
      if (typeof body === 'object' && !Buffer.isBuffer(body)) {
        body = JSON.stringify(body);
        if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json; charset=utf-8';
        }
      }
      if (typeof body === 'string') body = Buffer.from(body, 'utf8');
      if (Buffer.isBuffer(body) && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
        headers['Content-Length'] = String(body.length);
      }
    }

    const reqOpts = {
      method: options.method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + u.search,
      headers,
      // 不动全局 rejectUnauthorized；证书错误如实上报
    };

    const t0 = Date.now();
    let connectMs = null;
    let firstByteMs = null;

    const req = lib.request(reqOpts, (res) => {
      if (firstByteMs === null) firstByteMs = Date.now() - t0;
      const chunks = [];
      let stored = 0;
      let received = 0;
      let truncated = false;
      const maxBody = options.maxBodyBytes != null ? options.maxBodyBytes : DEFAULT_MAX_BODY;

      res.on('data', (c) => {
        received += c.length;
        if (stored < maxBody) {
          const take = Math.min(c.length, maxBody - stored);
          if (take > 0) chunks.push(c.slice(0, take));
          stored += take;
        }
        if (received > maxBody && !truncated) truncated = true;
      });

      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        let buf = raw;
        if (options.decompress !== false && enc) {
          buf = safeDecompress(raw, enc);
        }
        const ct = res.headers['content-type'] || '';
        const textLike = isTextual(ct);
        let bodyText = null;
        let binary = null;
        if (textLike) {
          bodyText = buf.toString('utf8');
        } else if (buf.length) {
          binary = { type: ct || 'application/octet-stream', size: received };
        }
        const out = {
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          finalUrl: target,
          bodyText,
          binary,
          bytes: received,
          storedBytes: stored,
          truncated,
          contentType: ct,
          isText: textLike,
          timings: {
            total: Date.now() - t0,
            connect: connectMs,
            firstByte: firstByteMs
          }
        };
        if (options.returnBuffer) out.buffer = buf;
        resolve(out);
      });

      res.on('error', (e) => reject(e));
    });

    req.on('socket', (s) => {
      s.on('connect', () => { if (connectMs === null) connectMs = Date.now() - t0; });
    });

    const timeout = options.timeout != null ? options.timeout : DEFAULT_TIMEOUT;
    const timer = setTimeout(() => {
      req.destroy(new Error('请求超时（>' + timeout + 'ms）'));
    }, timeout);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });

    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * 完整请求（含重定向跟随）
 * @param {object} opts
 *   method, url, query, headers, body, auth, timeout, maxRedirects,
 *   maxBodyBytes, allowPrivate, followRedirect(默认 true), decompress(默认 true)
 */
async function doHttpRequest(opts) {
  let method = String(opts.method || 'GET').toUpperCase();
  const baseUrl = validateUrl(opts.url);
  const allowPrivate = !!opts.allowPrivate;
  const followRedirect = opts.followRedirect !== false;
  const redirectsLeft0 = opts.maxRedirects != null ? opts.maxRedirects : DEFAULT_MAX_REDIRECTS;

  // 拼 query
  const u = new URL(baseUrl.toString());
  if (opts.query && typeof opts.query === 'object') {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null) u.searchParams.append(k, String(v));
    }
  }
  let target = u.toString();

  const chain = [];
  let redirectsLeft = redirectsLeft0;
  let last;

  while (true) {
    const cur = new URL(target);
    await assertSafeHost(cur.hostname, allowPrivate);
      last = await requestOnce(target, {
      method,
      headers: opts.headers,
      body: opts.body,
      auth: opts.auth,
      timeout: opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT,
      maxBodyBytes: opts.maxBodyBytes != null ? opts.maxBodyBytes : DEFAULT_MAX_BODY,
      decompress: opts.decompress !== false,
      returnBuffer: opts.returnBuffer
    });

    const loc = last.headers.location || last.headers.Location;
    const isRedirect = [301, 302, 303, 307, 308].includes(last.status);
    if (followRedirect && isRedirect && loc && redirectsLeft > 0) {
      const abs = new URL(loc, target).toString();
      chain.push({ from: target, to: abs, status: last.status });
      if (last.status === 303) {
        method = 'GET';
        opts = Object.assign({}, opts, { body: null });
        if (opts.headers) delete opts.headers['content-type'];
      }
      target = abs;
      redirectsLeft--;
      continue;
    }
    break;
  }

  last.redirectChain = chain;
  last.redirected = chain.length > 0;
  return last;
}

module.exports = { doHttpRequest, DEFAULT_TIMEOUT, DEFAULT_MAX_REDIRECTS, DEFAULT_MAX_BODY };
