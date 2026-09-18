'use strict';
/**
 * httpx_head —— 头信息探测
 *
 * 发送 HEAD（必要时可改 GET），返回状态、全部响应头、重定向链、各阶段耗时
 * （连接 / 首字节 / 总耗时）。
 */
const { doHttpRequest } = require('../utils/client');
const { errorResult } = require('../utils/out');
const { fmtMs, renderTable } = require('../utils/format');

const name = 'httpx_head';
const title = '头信息探测';

const description = '探测目标响应头：发送 HEAD 请求，返回状态码、全部响应头、重定向链（from→to→status）与各阶段耗时（TCP 连接 / 首字节 / 总耗时）。默认跟随重定向上限 5、超时 30s。需访问内网传 allowPrivate=true。';

const inputSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: '目标 URL（http/https）' },
    timeout: { type: 'number', description: '超时毫秒（默认 30000）' },
    maxRedirects: { type: 'number', description: '重定向上限（默认 5，0 表示不跟随）' },
    allowPrivate: { type: 'boolean', description: '允许访问内网/环回地址（默认 false）' }
  },
  required: ['url']
};

async function run(args = {}) {
  if (!args.url) return { _text: '用法: httpx_head(url="https://example.com")', isError: true, error: '缺少 url', errorCode: null };
  let res;
  try {
    res = await doHttpRequest({
      method: 'HEAD',
      url: args.url,
      timeout: args.timeout,
      maxRedirects: args.maxRedirects,
      allowPrivate: args.allowPrivate,
      maxBodyBytes: 0,
      followRedirect: true
    });
  } catch (e) {
    return errorResult(e);
  }

  const lines = [];
  lines.push(`## httpx_head: ${res.finalUrl}`);
  lines.push('');
  lines.push(`状态: ${res.status} ${res.statusText}`);
  if (res.redirected) {
    lines.push(`重定向: 经过 ${res.redirectChain.length} 跳`);
  }
  lines.push('');
  const rows = Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]);
  lines.push(renderTable(['响应头', '值'], rows));

  lines.push('');
  const t = res.timings;
  lines.push('耗时:');
  lines.push(`  连接   : ${t.connect != null ? fmtMs(t.connect) : '—'}`);
  lines.push(`  首字节 : ${fmtMs(t.firstByte)}`);
  lines.push(`  总耗时 : ${fmtMs(t.total)}`);

  if (res.redirected) {
    lines.push('');
    lines.push('重定向链:');
    res.redirectChain.forEach((h, i) => {
      lines.push(`  ${i + 1}. ${h.from} → ${h.to}  (${h.status})`);
    });
  }

  return {
    _text: lines.join('\n'),
    isError: res.status >= 400,
    status: res.status,
    statusText: res.statusText,
    url: res.finalUrl,
    redirected: res.redirected,
    redirectChain: res.redirectChain,
    headers: res.headers,
    timings: res.timings
  };
}

module.exports = { name, title, description, inputSchema, run };
