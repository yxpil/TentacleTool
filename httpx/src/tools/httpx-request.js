'use strict';
/**
 * httpx_request —— 通用 HTTP 请求
 *
 * 参数：method / url / headers / query / body（raw 或 json）/ timeout / maxRedirects /
 *       maxBodyBytes / auth（basic 或 bearer）/ allowPrivate / followRedirect / decompress
 * 返回状态、头、正文（按 content-type 智能截断，二进制只报大小与类型）。
 */
const { doHttpRequest } = require('../utils/client');
const { errorResult } = require('../utils/out');
const { fmtSize, fmtMs, truncateText } = require('../utils/format');

const name = 'httpx_request';
const title = '通用 HTTP 请求';

const description = '发送任意 HTTP 请求并返回状态/响应头/正文。method 默认 GET；query 拼到 URL；body 传对象自动当 JSON（也可传原始字符串）；auth 支持 {type:"basic",username,password} 或 {type:"bearer",token}（认证头绝不进日志）。默认超时 30s、重定向上限 5、响应体上限 2MB（超出截断并提示）。默认拒绝内网/环回地址，需访问内网传 allowPrivate=true。文本正文按 content-type 智能展示，二进制只报类型与大小。';

const inputSchema = {
  type: 'object',
  properties: {
    method: { type: 'string', description: 'HTTP 方法（GET/POST/PUT/DELETE/HEAD/PATCH…，默认 GET）' },
    url: { type: 'string', description: '目标 URL（必须 http/https 绝对地址）' },
    headers: { type: 'object', description: '请求头（键值对；Authorization 由 auth 参数提供，勿手写）' },
    query: { type: 'object', description: '查询参数（拼到 URL 的 ? 之后）' },
    body: { type: 'object', description: '请求体：对象自动 JSON 序列化；字符串原样发送' },
    auth: { type: 'object', description: '认证：{type:"basic",username,password} 或 {type:"bearer",token}' },
    timeout: { type: 'number', description: '超时毫秒（默认 30000）' },
    maxRedirects: { type: 'number', description: '重定向上限（默认 5，0 表示不跟随）' },
    maxBodyBytes: { type: 'number', description: '响应体上限字节（默认 2097152 = 2MB，超出截断）' },
    followRedirect: { type: 'boolean', description: '是否跟随重定向（默认 true）' },
    decompress: { type: 'boolean', description: '是否自动解压 gzip/deflate/br（默认 true）' },
    allowPrivate: { type: 'boolean', description: '允许访问内网/环回地址（默认 false，SSRF 防护）' }
  },
  required: ['url']
};

async function run(args = {}) {
  if (!args.url) {
    return { _text: '用法: httpx_request(url="https://example.com", method="GET", query={...}, body={...})\n返回状态、响应头与正文。', isError: true, error: '缺少 url', errorCode: null };
  }
  let res;
  try {
    res = await doHttpRequest({
      method: args.method || 'GET',
      url: args.url,
      query: args.query,
      headers: args.headers,
      body: args.body,
      auth: args.auth,
      timeout: args.timeout,
      maxRedirects: args.maxRedirects,
      maxBodyBytes: args.maxBodyBytes,
      allowPrivate: args.allowPrivate,
      followRedirect: args.followRedirect,
      decompress: args.decompress
    });
  } catch (e) {
    return errorResult(e);
  }

  return render(res);
}

function render(res) {
  const lines = [];
  lines.push(`## httpx_request: ${res.finalUrl}`);
  lines.push('');
  lines.push(`状态: ${res.status} ${res.statusText}  (耗时 ${fmtMs(res.timings.total)}${res.timings.connect != null ? '，连接 ' + fmtMs(res.timings.connect) : ''}，首字节 ${fmtMs(res.timings.firstByte)})`);
  if (res.redirected) {
    lines.push(`重定向: 经过 ${res.redirectChain.length} 跳`);
  }
  lines.push('');
  lines.push('响应头:');
  for (const [k, v] of Object.entries(res.headers)) {
    lines.push(`  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }

  lines.push('');
  if (res.isText) {
    const note = res.truncated ? `，超出上限已截断（共 ${fmtSize(res.bytes)}）` : '';
    lines.push(`正文 (${res.contentType || 'text'}，${fmtSize(res.bytes)}${note}):`);
    const body = res.bodyText || '';
    lines.push(truncateText(body, 4000, '…(已截断)') || '(空)');
  } else if (res.binary) {
    lines.push(`二进制响应 (${res.binary.type}，${fmtSize(res.binary.size)})，不展示正文。`);
  } else {
    lines.push(`正文: (空)`);
  }

  return {
    _text: lines.join('\n'),
    isError: res.status >= 400,
    ok: res.status < 400,
    status: res.status,
    statusText: res.statusText,
    url: res.finalUrl,
    redirected: res.redirected,
    redirectChain: res.redirectChain,
    headers: res.headers,
    contentType: res.contentType,
    bytes: res.bytes,
    truncated: res.truncated,
    isText: res.isText,
    body: res.isText ? res.bodyText : null,
    binary: res.binary,
    timings: res.timings
  };
}

module.exports = { name, title, description, inputSchema, run, render };
