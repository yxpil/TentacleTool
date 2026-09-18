'use strict';
/**
 * httpx_json —— JSON API 便捷调用
 *
 * GET/POST JSON：自动设置与解析 Content-Type，把非 2xx 的响应体也返回（便于看错误详情）。
 */
const { doHttpRequest } = require('../utils/client');
const { errorResult } = require('../utils/out');
const { fmtMs, truncateText } = require('../utils/format');

const name = 'httpx_json';
const title = 'JSON API 便捷调用';

const description = '面向 JSON API 的便捷封装：自动加 Accept: application/json；POST 时把 data 对象序列化为 JSON 并设 Content-Type: application/json。响应按 content-type 自动 JSON 解析，非 2xx 的响应体也会原样返回（errorBody）便于排查。需访问内网传 allowPrivate=true。';

const inputSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: '目标 URL（http/https）' },
    method: { type: 'string', description: 'HTTP 方法（默认 GET；POST 时配合 data）' },
    data: { type: 'object', description: 'POST 的请求体对象（自动 JSON 序列化）' },
    query: { type: 'object', description: '查询参数' },
    headers: { type: 'object', description: '额外请求头（不要手设 Content-Type/Accept）' },
    auth: { type: 'object', description: '认证：{type:"basic",username,password} 或 {type:"bearer",token}' },
    timeout: { type: 'number', description: '超时毫秒（默认 30000）' },
    maxRedirects: { type: 'number', description: '重定向上限（默认 5）' },
    allowPrivate: { type: 'boolean', description: '允许访问内网/环回地址（默认 false）' }
  },
  required: ['url']
};

function tryParseJson(text) {
  if (text == null) return { value: null, ok: false };
  try { return { value: JSON.parse(text), ok: true }; }
  catch (e) { return { value: null, ok: false, error: e.message }; }
}

async function run(args = {}) {
  if (!args.url) {
    return { _text: '用法: httpx_json(url="https://api.x/u", method="POST", data={...})', isError: true, error: '缺少 url', errorCode: null };
  }
  const method = String(args.method || 'GET').toUpperCase();
  const headers = Object.assign({ 'Accept': 'application/json' }, args.headers || {});

  let res;
  try {
    res = await doHttpRequest({
      method,
      url: args.url,
      query: args.query,
      headers,
      body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? args.data : undefined,
      auth: args.auth,
      timeout: args.timeout,
      maxRedirects: args.maxRedirects,
      allowPrivate: args.allowPrivate,
      decompress: true
    });
  } catch (e) {
    return errorResult(e);
  }

  const parsed = tryParseJson(res.bodyText);
  const isErr = res.status >= 400;

  const lines = [];
  lines.push(`## httpx_json: ${method} ${res.finalUrl}`);
  lines.push('');
  lines.push(`状态: ${res.status} ${res.statusText}${isErr ? '  (非 2xx，响应体仍已返回)' : ''}`);
  lines.push(`Content-Type: ${res.contentType || '(无)'}`);
  lines.push('');
  if (parsed.ok) {
    const pretty = JSON.stringify(parsed.value, null, 2);
    lines.push('JSON:');
    lines.push(truncateText(pretty, 4000, '…(已截断)'));
  } else if (res.bodyText) {
    lines.push('正文（非 JSON）:');
    lines.push(truncateText(res.bodyText, 2000, '…(已截断)'));
  } else {
    lines.push('（无响应体）');
  }

  return {
    _text: lines.join('\n'),
    isError: isErr,
    ok: !isErr,
    status: res.status,
    statusText: res.statusText,
    url: res.finalUrl,
    contentType: res.contentType,
    json: parsed.ok ? parsed.value : null,
    raw: res.bodyText,
    parseError: parsed.ok ? null : (res.bodyText ? parsed.error : null),
    headers: res.headers,
    timings: res.timings
  };
}

module.exports = { name, title, description, inputSchema, run };
