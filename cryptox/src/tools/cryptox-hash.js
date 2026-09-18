'use strict';
/** cryptox_hash —— 文本 / 文件的哈希摘要 */
const fs = require('fs');
const A = require('../utils/algo');
const F = require('../utils/format');

module.exports = {
  name: 'cryptox_hash',
  title: '哈希摘要',
  description: '计算文本或文件的哈希摘要。算法支持 md5 / sha1 / sha256 / sha384 / sha512 / sha3-256 / sha3-512 / blake2b512 / blake2s256，默认 sha256。'
    + '输入用 input（直接给文本）或 file（文件路径）二者之一，同时给出则分别计算两行结果。输出编码默认 hex，可选 base64 / base64url。',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: '要计算哈希的文本内容' },
      file: { type: 'string', description: '要计算哈希的文件路径' },
      algorithm: { type: 'string', description: `哈希算法，默认 sha256。可用：${A.HASH_ALGOS.join(', ')}` },
      encoding: { type: 'string', description: '输出编码：hex（默认）/ base64 / base64url' }
    },
    additionalProperties: false
  },

  run(args = {}) {
    const algo = A.normalizeAlgo(args.algorithm);
    const enc = A.normalizeEncoding(args.encoding);

    const targets = [];
    if (typeof args.input === 'string') {
      const buf = Buffer.from(args.input, 'utf8');
      targets.push({ label: '(文本输入)', bytes: buf.length, buf });
    }
    if (args.file) {
      let buf;
      try {
        buf = fs.readFileSync(args.file);
      } catch (e) {
        throw new Error(`读不到文件 "${args.file}"：${e.code === 'ENOENT' ? '文件不存在' : e.message}`);
      }
      targets.push({ label: String(args.file), bytes: buf.length, buf });
    }
    if (targets.length === 0) {
      throw new Error('必须提供 input（文本）或 file（文件路径）之一');
    }

    const results = targets.map(t => ({
      source: t.label,
      bytes: t.bytes,
      algorithm: algo,
      encoding: enc,
      hash: A.digest(algo, t.buf, enc)
    }));

    const _text = [
      `哈希 · ${algo} · ${enc}`,
      '',
      F.table(
        ['来源', '字节', '摘要'],
        results.map(r => [r.source, r.bytes, r.hash]),
        { cellMax: 200 }
      )
    ].join('\n');

    return { _text, algorithm: algo, encoding: enc, results };
  }
};
