'use strict';
/** cryptox_cipher —— AES-256-GCM 加解密（口令派生密钥，密文为自描述封套） */
const crypto = require('crypto');
const F = require('../utils/format');

const PREFIX = 'CRYPTOX1:';
const DEFAULT_ITER = 100000;
const SCRYPT_N = 16384;

function normalizeKdf(k) {
  const s = String(k === undefined || k === null || k === '' ? 'pbkdf2' : k).toLowerCase().replace(/\s/g, '');
  if (s === 'pbkdf2' || s === 'pbkdf2sha256' || s === 'pbkdf2-sha256') return 'pbkdf2';
  if (s === 'scrypt') return 'scrypt';
  throw new Error(`不支持的密钥派生算法 "${k}"。可用：pbkdf2, scrypt`);
}

function iterOf(v) {
  return Number.isFinite(v) && v >= 1000 ? Math.floor(v) : DEFAULT_ITER;
}

function deriveKey(password, salt, kdf, iterations, keylen = 32) {
  const pw = Buffer.from(String(password), 'utf8');
  if (kdf === 'scrypt') {
    return crypto.scryptSync(pw, salt, keylen, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  }
  return crypto.pbkdf2Sync(pw, salt, iterOf(iterations), keylen, 'sha256');
}

/** 加密：每次都用新的 salt 与 iv，参数随封套一起保存，解密方无需额外配置 */
function encrypt(text, password, kdf, iterations) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt, kdf, iterations);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]);
  const env = {
    v: 1,
    alg: 'aes-256-gcm',
    kdf,
    iter: kdf === 'pbkdf2' ? iterOf(iterations) : SCRYPT_N,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  };
  return { envelope: PREFIX + Buffer.from(JSON.stringify(env), 'utf8').toString('base64'), meta: { ...env, salt: env.salt, iv: env.iv, tag: env.tag, ct: undefined } };
}

function decrypt(envelope, password) {
  const s = String(envelope).trim();
  if (!s.startsWith(PREFIX)) {
    throw new Error(`密文格式不对：应以 ${PREFIX} 开头（请使用本工具生成的封套）`);
  }
  let env;
  try {
    env = JSON.parse(Buffer.from(s.slice(PREFIX.length), 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('密文封套解析失败：内容被截断，或不是本工具生成的格式');
  }
  if (env.alg !== 'aes-256-gcm') throw new Error(`不支持的加密算法 "${env.alg}"`);
  if (!env.salt || !env.iv || !env.tag || env.ct === undefined) {
    throw new Error('密文封套缺少必需字段（salt / iv / tag / ct）');
  }
  const kdf = normalizeKdf(env.kdf);
  const key = deriveKey(password, Buffer.from(env.salt, 'base64'), kdf, env.iter);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    throw new Error('解密失败：口令不正确，或数据已被篡改（GCM 认证标签校验未通过）');
  }
}

module.exports = {
  name: 'cryptox_cipher',
  title: 'AES-256-GCM 加解密',
  description: '用口令或密钥对文本做 AES-256-GCM 认证加密 / 解密。'
    + '参数：mode（encrypt 默认 / decrypt）、input（明文或密文，必填）、password（口令，必填）、kdf（pbkdf2 默认 / scrypt）、iterations（PBKDF2 迭代次数，默认 100000）。'
    + '密文是自描述的 base64 封套（含算法、KDF、salt、iv、GCM tag），以 CRYPTOX1: 开头，解密方无需额外参数。'
    + '口令不会出现在任何输出或日志里。注意：这是计算工具，不是密码管理器。',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', description: 'encrypt（默认）或 decrypt' },
      input: { type: 'string', description: '要加密的明文，或要解密的封套字符串' },
      password: { type: 'string', description: '加密/解密口令（必填）' },
      kdf: { type: 'string', description: '密钥派生算法：pbkdf2（默认，SHA-256）/ scrypt' },
      iterations: { type: 'number', description: 'PBKDF2 迭代次数，默认 100000（低于 1000 会被忽略）' }
    },
    required: ['input', 'password'],
    additionalProperties: false
  },

  run(args = {}) {
    if (typeof args.input !== 'string' || args.input.length === 0) {
      throw new Error('必须提供 input（明文或密文封套）');
    }
    if (typeof args.password !== 'string' || args.password.length === 0) {
      throw new Error('必须提供 password（加密/解密口令）');
    }
    const mode = String(args.mode === undefined || args.mode === null || args.mode === '' ? 'encrypt' : args.mode).toLowerCase().trim();
    const kdf = normalizeKdf(args.kdf);

    if (mode === 'decrypt') {
      const plain = decrypt(args.input, args.password);
      const _text = [
        `解密 · aes-256-gcm · kdf=${kdf}`,
        '',
        F.kv([
          ['明文长度', plain.length + ' 字符'],
          ['明文', plain]
        ])
      ].join('\n');
      return { _text: F.clip(_text, 24000, '明文过长，可只取前若干字符'), mode: 'decrypt', kdf, plaintext: plain };
    }

    if (mode !== 'encrypt') {
      throw new Error(`不支持的 mode "${args.mode}"。可用：encrypt, decrypt`);
    }

    const { envelope, meta } = encrypt(args.input, args.password, kdf, args.iterations);
    const _text = [
      `加密 · aes-256-gcm · kdf=${kdf} · iterations=${meta.iter}`,
      '',
      F.kv([
        ['明文长度', args.input.length + ' 字符'],
        ['封套长度', envelope.length + ' 字符']
      ]),
      '',
      '密文封套（可直接喂给 mode=decrypt）：',
      envelope
    ].join('\n');

    return {
      _text,
      mode: 'encrypt',
      kdf,
      iterations: meta.iter,
      envelope,
      meta: { v: meta.v, alg: meta.alg, kdf: meta.kdf, iter: meta.iter }
    };
  },

  encrypt,
  decrypt,
  PREFIX
};
