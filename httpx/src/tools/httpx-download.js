'use strict';
/**
 * httpx_download —— 下载到文件
 *
 * 参数：url / path（输出文件）/ maxBytes（大小上限）/ timeout /
 *       resume（断点续传，发 Range）/ auth / allowPrivate
 * 返回文件路径与字节数；支持 206 续传、416 视为已完成。
 */
const fs = require('fs');
const path = require('path');
const { doHttpRequest } = require('../utils/client');
const { errorResult } = require('../utils/out');
const { fmtSize } = require('../utils/format');

const name = 'httpx_download';
const title = '下载到文件';

const description = '把 HTTP 响应体下载到本地文件。path 为输出路径（必填）。maxBytes 设大小上限（默认 50MB，超出截断并提示）；timeout 默认 30s；resume=true 时可断点续传（发 Range，命中 206 追加，416 视为已完成）。需访问内网传 allowPrivate=true。认证用 auth 参数（绝不进日志）。';

const inputSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: '目标 URL（http/https）' },
    path: { type: 'string', description: '本地输出文件路径' },
    maxBytes: { type: 'number', description: '下载大小上限字节（默认 52428800 = 50MB）' },
    timeout: { type: 'number', description: '超时毫秒（默认 30000）' },
    resume: { type: 'boolean', description: '断点续传：已存在文件则发 Range 续传（默认 false）' },
    auth: { type: 'object', description: '认证：{type:"basic",username,password} 或 {type:"bearer",token}' },
    allowPrivate: { type: 'boolean', description: '允许访问内网/环回地址（默认 false）' }
  },
  required: ['url', 'path']
};

async function run(args = {}) {
  if (!args.url) return { _text: '用法: httpx_download(url="https://x/file", path="C:/tmp/f.bin")', isError: true, error: '缺少 url', errorCode: null };
  if (!args.path) return { _text: '用法: httpx_download(url="...", path="本地文件路径")', isError: true, error: '缺少 path', errorCode: null };

  const outPath = path.resolve(args.path);
  const sizeLimit = args.maxBytes != null ? args.maxBytes : 50 * 1024 * 1024;
  const resume = !!args.resume && fs.existsSync(outPath);
  const existing = resume ? fs.statSync(outPath).size : 0;

  const headers = Object.assign({}, args.headers || {});
  if (resume) headers['Range'] = 'bytes=' + existing + '-';

  let res;
  try {
    res = await doHttpRequest({
      method: 'GET',
      url: args.url,
      headers,
      auth: args.auth,
      timeout: args.timeout,
      maxBodyBytes: Math.max(1, sizeLimit - existing),
      allowPrivate: args.allowPrivate,
      returnBuffer: true,
      followRedirect: true
    });
  } catch (e) {
    return errorResult(e);
  }

  const buf = res.buffer || Buffer.alloc(0);
  let wroteBytes;
  let mode;
  if (res.status === 206 && resume) {
    fs.appendFileSync(outPath, buf);
    wroteBytes = existing + buf.length;
    mode = 'append';
  } else if (res.status === 416) {
    // 范围不满足：已是最新
    wroteBytes = existing;
    mode = 'complete';
  } else if (res.status === 200) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    wroteBytes = buf.length;
    mode = resume ? 'overwrite' : 'write';
  } else {
    return {
      _text: `下载失败：服务端返回 ${res.status} ${res.statusText}（未写入文件）。`,
      isError: true,
      status: res.status,
      error: 'HTTP ' + res.status
    };
  }

  const truncated = res.truncated || wroteBytes > sizeLimit;
  const lines = [];
  lines.push(`## httpx_download: ${outPath}`);
  lines.push('');
  lines.push(`结果: ${res.status} ${res.statusText}（${mode === 'append' ? '续传追加' : mode === 'complete' ? '已是最新' : '写入'}）`);
  lines.push(`文件: ${outPath}`);
  lines.push(`字节: ${fmtSize(wroteBytes)} (${wroteBytes})`);
  if (truncated) lines.push(`⚠ 超出大小上限 ${fmtSize(sizeLimit)}，已截断，文件不完整。`);
  lines.push(`耗时: ${res.timings.total}ms`);

  return {
    _text: lines.join('\n'),
    isError: false,
    status: res.status,
    path: outPath,
    bytes: wroteBytes,
    truncated,
    mode,
    contentType: res.contentType
  };
}

module.exports = { name, title, description, inputSchema, run };
