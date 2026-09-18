'use strict';
/** cryptox_hmac —— HMAC 签名与校验 */
const fs = require('fs');
const A = require('../utils/algo');
const F = require('../utils/format');

module.exports = {
  name: 'cryptox_hmac',
  title: 'HMAC 签名与校验',
  description: '用密钥对文本或文件计算 HMAC 签名；给了 expected（期望签名）时同时返回校验结果，比较用恒定时间算法，避免时序侧信道。'
    + '参数：key（密钥，必填）、input 或 file 二者之一、algorithm（默认 sha256）、encoding（默认 hex）、expected（可选）。密钥不会出现在任何输出里。',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'HMAC 密钥（必填）' },
      input: { type: 'string', description: '要签名的文本' },
      file: { type: 'string', description: '要签名的文件路径' },
      algorithm: { type: 'string', description: `哈希算法，默认 sha256。可用：${A.HASH_ALGOS.join(', ')}` },
      encoding: { type: 'string', description: '输出编码：hex（默认）/ base64 / base64url' },
      expected: { type: 'string', description: '可选：期望的签名值，提供则返回是否匹配' }
    },
    required: ['key'],
    additionalProperties: false
  },

  run(args = {}) {
    if (typeof args.key !== 'string' || args.key.length === 0) {
      throw new Error('必须提供非空的 key（HMAC 密钥）');
    }
    const algo = A.normalizeAlgo(args.algorithm);
    const enc = A.normalizeEncoding(args.encoding);
    const hasExpected = typeof args.expected === 'string' && args.expected.length > 0;

    const targets = [];
    if (typeof args.input === 'string') {
      targets.push({ label: '(文本输入)', buf: Buffer.from(args.input, 'utf8') });
    }
    if (args.file) {
      let buf;
      try {
        buf = fs.readFileSync(args.file);
      } catch (e) {
        throw new Error(`读不到文件 "${args.file}"：${e.code === 'ENOENT' ? '文件不存在' : e.message}`);
      }
      targets.push({ label: String(args.file), buf });
    }
    if (targets.length === 0) {
      throw new Error('必须提供 input（文本）或 file（文件路径）之一');
    }

    const results = targets.map(t => {
      const signature = A.hmacDigest(algo, args.key, t.buf, enc);
      const row = { source: t.label, bytes: t.buf.length, algorithm: algo, encoding: enc, signature };
      if (hasExpected) row.matches = A.safeEqual(signature, args.expected.trim());
      return row;
    });

    const headers = ['来源', `HMAC-${algo.toUpperCase()}`];
    if (hasExpected) headers.push('校验');
    const rows = results.map(r => {
      const line = [r.source, r.signature];
      if (hasExpected) line.push(r.matches ? '✓ 匹配' : '✗ 不匹配');
      return line;
    });

    const _text = [
      `HMAC · ${algo} · ${enc}${hasExpected ? ' · 含校验' : ''}`,
      '',
      F.table(headers, rows, { cellMax: 200 })
    ].join('\n');

    return { _text, algorithm: algo, encoding: enc, expectedProvided: hasExpected, results };
  }
};
