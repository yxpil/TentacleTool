'use strict';
/** cryptox_decode —— 文本解码（base64 / hex / url / HTML 实体 / Unicode 转义 等） */
const F = require('../utils/format');
const { normalizeFormat, FORMATS } = require('./cryptox-encode');

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', laquo: '\u00ab', raquo: '\u00bb',
  times: '\u00d7', divide: '\u00f7', deg: '\u00b0', plusmn: '\u00b1',
  '1/2': '\u00bd', micro: '\u00b5', middot: '\u00b7', bull: '\u2022'
};

/** base64 解码：容忍空白、缺省补齐；非法字符或坏长度要明确报错而不是吐乱码 */
function decodeBase64(input) {
  const cleaned = String(input).replace(/\s+/g, '');
  if (!cleaned) throw new Error('输入为空，无法解码 base64');
  const b = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b)) {
    throw new Error('不是合法的 base64 字符串（含非 base64 字符）');
  }
  const pad = b.length % 4;
  if (pad === 1) throw new Error('base64 长度非法（length % 4 === 1）');
  const padded = pad ? b + '='.repeat(4 - pad) : b;
  return Buffer.from(padded, 'base64').toString('utf8');
}

/** hex 解码 */
function decodeHex(input) {
  const c = String(input).replace(/\s+/g, '').replace(/^0x/i, '');
  if (!c) throw new Error('输入为空，无法解码 hex');
  if (!/^[0-9a-fA-F]+$/.test(c)) throw new Error('不是合法的十六进制字符串');
  if (c.length % 2 !== 0) throw new Error('十六进制长度必须为偶数（每字节两位）');
  return Buffer.from(c, 'hex').toString('utf8');
}

/** HTML 实体解码：数字实体走码点，命名实体查表，未知实体原样保留 */
function decodeHtml(input) {
  return String(input)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      const cp = parseInt(h, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const cp = parseInt(d, 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) => {
      const hit = NAMED_ENTITIES[n] !== undefined ? NAMED_ENTITIES[n] : NAMED_ENTITIES[n.toLowerCase()];
      return hit !== undefined ? hit : m;
    });
}

/** Unicode 转义解码：支持 \uXXXX 与 \u{XXXXX}，代理对按 UTF-16 自然拼合 */
function decodeUnicode(input) {
  return String(input)
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (m, h) => {
      const cp = parseInt(h, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeOne(text, format) {
  switch (format) {
    case 'base64':
    case 'base64url':
      return decodeBase64(text);
    case 'hex':
      return decodeHex(text);
    case 'url':
      try {
        return decodeURIComponent(text);
      } catch (e) {
        throw new Error('URL 解码失败：包含非法的百分号转义（如单独的 % 或 %ZZ）');
      }
    case 'uri':
      try {
        return decodeURI(text);
      } catch (e) {
        throw new Error('URI 解码失败：包含非法的百分号转义');
      }
    case 'querystring': {
      const plus = String(text).replace(/\+/g, ' ');
      try {
        return decodeURIComponent(plus);
      } catch (e) {
        throw new Error('querystring 解码失败：包含非法的百分号转义');
      }
    }
    case 'html':
      return decodeHtml(text);
    case 'unicode':
      return decodeUnicode(text);
    default:
      throw new Error('内部错误：未处理的格式 ' + format);
  }
}

module.exports = {
  name: 'cryptox_decode',
  title: '文本解码',
  description: '解码各种编码形式的文本：base64 / base64url / hex / url / uri / querystring / html（HTML 实体）/ unicode（\\uXXXX 转义）。'
    + '容错策略明确：base64 容忍空白与缺省 padding，hex 要求偶数长度，URL 系转义非法时给出明确错误而不是静默返回原文。'
    + '参数：input（必填，要解码的文本）、format（默认 base64）。',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: '要解码的文本（必填）' },
      format: { type: 'string', description: `编码格式，默认 base64。可用：${FORMATS.join(', ')}` }
    },
    required: ['input'],
    additionalProperties: false
  },

  run(args = {}) {
    if (typeof args.input !== 'string') {
      throw new Error('必须提供 input（要解码的文本）');
    }
    const format = normalizeFormat(args.format);
    const output = decodeOne(args.input, format);
    const _text = [
      `解码 · ${format}`,
      '',
      F.kv([
        ['输入长度', args.input.length + ' 字符'],
        ['输出长度', output.length + ' 字符'],
        ['结果', output]
      ])
    ].join('\n');

    return { _text, format, inputLength: args.input.length, output };
  },

  normalizeFormat,
  decodeOne
};
