'use strict';
/**
 * httpx_batch —— 并发批量请求
 *
 * 给定 URL 列表，按并发数上限同时发请求，单条超时独立，失败项自动重试 1 次。
 * 输出汇总表（状态/耗时/大小）与失败明细。
 */
const { doHttpRequest } = require('../utils/client');
const { errorResult } = require('../utils/out');
const { fmtSize, fmtMs, renderTable, truncateText } = require('../utils/format');

const name = 'httpx_batch';
const title = '并发批量请求';

const description = '对一组 URL 并发发送相同方法的请求。concurrency 控制并发数（默认 4，上限 16）；timeout 为单条超时（默认 30s）；失败项自动重试 1 次。输出汇总表（序号/URL/状态/耗时/大小/重试）与失败明细。需访问内网传 allowPrivate=true。每条响应体只取前 64KB 用于判状态码与大小，不返回正文。';

const inputSchema = {
  type: 'object',
  properties: {
    urls: { type: 'array', description: 'URL 数组（必填）' },
    method: { type: 'string', description: 'HTTP 方法（默认 GET）' },
    headers: { type: 'object', description: '公共请求头' },
    body: { type: 'object', description: '公共请求体（对象自动 JSON）' },
    auth: { type: 'object', description: '认证：{type:"basic",username,password} 或 {type:"bearer",token}' },
    concurrency: { type: 'number', description: '并发数上限（默认 4，上限 16）' },
    timeout: { type: 'number', description: '单条超时毫秒（默认 30000）' },
    allowPrivate: { type: 'boolean', description: '允许访问内网/环回地址（默认 false）' }
  },
  required: ['urls']
};

function clamp(n, lo, hi) {
  n = Number(n);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

async function runOne(url, args, timeout) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await doHttpRequest({
        method: args.method || 'GET',
        url,
        headers: args.headers,
        body: args.body,
        auth: args.auth,
        timeout,
        allowPrivate: args.allowPrivate,
        maxBodyBytes: 64 * 1024,
        followRedirect: true
      });
      return {
        url,
        ok: res.status < 400,
        status: res.status,
        ms: res.timings.total,
        bytes: res.bytes,
        error: null,
        attempts: attempt + 1,
        redirected: res.redirected,
        ssrfBlocked: false
      };
    } catch (e) {
      lastErr = e;
    }
  }
  return {
    url,
    ok: false,
    status: null,
    ms: null,
    bytes: 0,
    error: lastErr ? lastErr.message : '未知错误',
    attempts: 2,
    redirected: false,
    ssrfBlocked: lastErr && lastErr.code === 'SSRF_BLOCKED'
  };
}

async function run(args = {}) {
  const urls = args.urls;
  if (!Array.isArray(urls) || !urls.length) {
    return { _text: '用法: httpx_batch(urls=["https://a","https://b"], concurrency=4)', isError: true, error: '缺少 urls 数组', errorCode: null };
  }
  const concurrency = clamp(args.concurrency, 1, 16);
  const timeout = args.timeout != null ? args.timeout : 30000;

  const results = new Array(urls.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= urls.length) break;
      results[i] = await runOne(urls[i], args, timeout);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));

  const okCount = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;
  const totalMs = results.reduce((s, r) => s + (r.ms || 0), 0);

  const lines = [];
  lines.push(`## httpx_batch: ${results.length} 个请求，并发 ${concurrency}`);
  lines.push('');
  const rows = results.map((r, i) => [
    String(i + 1),
    truncateText(r.url, 48, '…'),
    r.status != null ? String(r.status) : 'ERR',
    r.ms != null ? fmtMs(r.ms) : '—',
    fmtSize(r.bytes),
    r.attempts > 1 ? (r.ok ? '重试成功' : '重试失败') : '—'
  ]);
  lines.push(renderTable(['#', 'URL', '状态', '耗时', '大小', '重试'], rows, { align: ['r', 'l', 'r', 'r', 'r', 'l'] }));

  lines.push('');
  lines.push(`汇总: 成功 ${okCount} / 失败 ${failCount}；总耗时 ${fmtMs(totalMs)}；平均 ${fmtMs(Math.round(totalMs / results.length))}`);

  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    lines.push('');
    lines.push('失败明细:');
    failed.forEach((r, i) => {
      lines.push(`  ${results.indexOf(r) + 1}. ${truncateText(r.url, 60, '…')} → ${r.ssrfBlocked ? 'SSRF 拦截' : r.error}`);
    });
  }

  return {
    _text: lines.join('\n'),
    isError: failCount > 0,
    total: results.length,
    ok: okCount,
    failed: failCount,
    totalMs,
    results
  };
}

module.exports = { name, title, description, inputSchema, run };
