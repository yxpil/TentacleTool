'use strict';
/** cryptox_encode —— 文本编码（base64 / hex / url / HTML 实体 / Unicode 转义 等） */
const F = require('../utils/format');

const FORMATS = ['base64', 'base64url', 'hex', 'url', 'uri', 'querystring', 'html', 'unicode'];

const HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function normalizeFormat(f) {
  const k = String(f === undefined || f === null || f === '' ? 'base64' : f).toLowerCase().replace(/[\s_-]/g, '');
  const map = {
    base64: 'base64', b64: 'base64',
    base64url: 'base64url', b64url: 'base64url',
    hex: 'hex', hexadecimal: 'hex',
    url: 'url', urlcomponent: 'url', component: 'url', uricomponent: 'url',
    uri: 'uri',
    querystring: 'querystring', qs: 'querystring', urlsearchparams: 'querystring',
    html: 'html', htmlentity: 'html', entity: 'html',
    unicode: 'unicode', unicodeescape: 'unicode', uescape: 'unicode'
  };
  const hit = map[k];
  if (!hit) throw new Error(`不支持的编码格式 "${f}"。可用：${FORMATS.join(', ')}`);
  return hit;
}

function encodeOne(text, format) {
  switch (format) {
    case 'base64':
      return Buffer.from(text, 'utf8').toString('base64');
    case 'base64url':
      return Buffer.from(text, 'utf8').toString('base64url');
    case 'hex':
      return Buffer.from(text, 'utf8').toString('hex');
    case 'url':
      return encodeURIComponent(text);
    case 'uri':
      return encodeURI(text);
    case 'querystring':
      // querystring 语义：空格编成 +，其余走 encodeURIComponent
      return encodeURIComponent(text).replace(/%20/g, '+');
    case 'html':
      return text.replace(/[&<>"']/g, ch => HTML_MAP[ch]);
    case 'unicode':
      return [...text].map(ch => {
        const cp = ch.codePointAt(0);
        if (cp < 128) return ch;
        if (cp > 0xffff) {
          const h = cp - 0x10000;
          const hi = 0xd800 + (h >> 10), lo = 0xdc00 + (h & 0x3ff);
          return '\\u' + hi.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0');
        }
        return '\\u' + cp.toString(16).padStart(4, '0');
      }).join('');
    default:
      throw new Error('内部错误：未处理的格式 ' + format);
  }
}

module.exports = {
  name: 'cryptox_encode',
  title: '文本编码',
  description: '把文本编码成各种表示形式：base64（默认）/ base64url / hex / url（encodeURIComponent）/ '
    + 'uri（encodeURI）/ querystring（URLSearchParams）/ html（HTML 实体转义）/ unicode（\\uXXXX 转义，代理对正确处理）。'
    + '参数：input（必填，要编码的文本）、format（默认 base64）。',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: '要编码的文本（必填）' },
      format: { type: 'string', description: `编码格式，默认 base64。可用：${FORMATS.join(', ')}` }
    },
    required: ['input'],
    additionalProperties: false
  },

  run(args = {}) {
    if (typeof args.input !== 'string') {
      throw new Error('必须提供 input（要编码的文本）');
    }
    const format = normalizeFormat(args.format);
    const output = encodeOne(args.input, format);
    const _text = [
      `编码 · ${format}`,
      '',
      F.kv([
        ['输入长度', args.input.length + ' 字符'],
        ['输出长度', output.length + ' 字符'],
        ['结果', output]
      ])
    ].join('\n');

    return { _text, format, inputLength: args.input.length, output };
  },

  // 供 cryptox_decode 复用（toMcpTools 只映射 name/title/description/inputSchema，不会外泄）
  normalizeFormat,
  FORMATS,
  encodeOne
};
