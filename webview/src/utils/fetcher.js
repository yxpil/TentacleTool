'use strict';
/**
 * 零依赖网页抓取器（Node 原生 http/https/zlib）
 * - 自动跟随重定向（最多 5 跳）
 * - 自动解压 gzip / deflate / br
 * - 自动字符集识别（HTTP 头 -> meta charset -> UTF-8 兜底，支持中文 GBK/GB18030）
 * - 大小上限 + 超时保护
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 WebViewMCP/1.0';

/**
 * 抓取网页
 * @param {string} url 目标地址（http/https）
 * @param {object} opts - { timeout: 毫秒(默认20000), maxBytes: 字节(默认8MB), headers: 附加请求头 }
 * @returns {Promise<{finalUrl, status, contentType, charset, body, sizeBytes, elapsedMs, redirects}>}
 */
function fetchPage(url, opts = {}) {
  const timeout = clampInt(opts.timeout || 20000, 2000, 120000);
  const maxBytes = opts.maxBytes || 8 * 1024 * 1024;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let redirects = 0;
    let currentUrl = url;

    const attempt = (target) => {
      let u;
      try { u = new URL(target); } catch (e) { return reject(new Error('无效 URL: ' + target)); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return reject(new Error('仅支持 http/https 协议: ' + u.protocol));
      }
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: Object.assign({
          'User-Agent': DEFAULT_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br'
        }, opts.headers || {})
      }, (res) => {
        // 重定向
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (++redirects > 5) return reject(new Error('重定向次数过多（>5）'));
          const next = new URL(res.headers.location, u).toString();
          currentUrl = next;
          return attempt(next);
        }

        const chunks = [];
        let size = 0;
        res.on('data', c => {
          size += c.length;
          if (size > maxBytes) { req.destroy(); reject(new Error('响应体过大（>' + Math.round(maxBytes / 1024 / 1024) + 'MB）')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            let buf = Buffer.concat(chunks);
            const contentEncoding = (res.headers['content-encoding'] || '').toLowerCase().trim();
            buf = decompress(buf, contentEncoding);
            const contentType = res.headers['content-type'] || '';
            const headerCharset = (contentType.match(/charset=([\w-]+)/i) || [])[1] || '';
            const decoded = decodeText(buf, headerCharset);
            resolve({
              finalUrl: currentUrl,
              status: res.statusCode,
              contentType,
              charset: decoded.charset,
              body: decoded.text,
              sizeBytes: buf.length,
              elapsedMs: Date.now() - start,
              redirects
            });
          } catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeout, () => req.destroy(new Error('请求超时（' + timeout + 'ms）')));
      req.end();
    };

    attempt(currentUrl);
  });
}

/** 按 content-encoding 解压 */
function decompress(buf, encoding) {
  if (!encoding || encoding === 'identity' || buf.length === 0) return buf;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate' || encoding === 'x-deflate') {
      // zlib 头嗅探：0x78 = zlib 流，否则按原始 deflate
      if (buf.length > 1 && buf[0] === 0x78) return zlib.inflateSync(buf);
      return zlib.inflateRawSync(buf);
    }
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch (e) {
    // 解压失败则按未压缩处理
  }
  return buf;
}

/**
 * 按字符集解码为字符串
 * 优先级：显式 charset 参数 -> HTTP 头 charset -> HTML meta charset -> UTF-8
 */
function decodeText(buf, headerCharset) {
  let charset = (headerCharset || '').toLowerCase();
  if (!charset) {
    // 嗅探 HTML 头部的 meta charset（只看前 2KB）
    const head = buf.slice(0, 2048).toString('latin1');
    const m = head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || head.match(/charset=["']?([\w-]+)/i);
    if (m) charset = m[1].toLowerCase();
  }
  const normalize = (c) => {
    if (!c) return 'utf-8';
    const s = c.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (s === 'gbk' || s === 'gb2312' || s === 'gb18030' || s === 'gb') return 'gb18030';
    if (s === 'big5' || s === 'big5hkscs') return 'big5';
    if (s === 'shift_jis' || s === 'shift-jis' || s === 'sjis' || s === 'cp932') return 'shift_jis';
    if (s === 'eucjp' || s === 'euc-jp') return 'eucjp';
    if (s === 'latin1' || s === 'iso88591' || s === 'cp1252' || s === 'windows1252') return 'latin1';
    if (s === 'utf8' || s === 'utf-8') return 'utf-8';
    return s;
  };
  charset = normalize(charset);
  const decoders = charset === 'utf-8' ? ['utf-8'] : [charset, 'utf-8'];
  for (const label of decoders) {
    try {
      const td = new TextDecoder(label, { fatal: false });
      return { text: td.decode(buf), charset: label };
    } catch (e) { /* 该编码不可用，尝试下一个 */ }
  }
  return { text: buf.toString('utf8'), charset: 'utf-8' };
}

function clampInt(v, min, max) {
  v = parseInt(v, 10);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

module.exports = { fetchPage, decodeText };
