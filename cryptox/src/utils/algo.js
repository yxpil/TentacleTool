'use strict';
/**
 * 哈希算法与编码的归一化（hash / hmac / checksum 三个工具共用）
 *
 * 设计要点：
 *  - 用户写的算法名五花八门（SHA-256 / sha256 / SHA3_256），这里统一归一
 *  - 归一失败时抛出「不支持的算法 + 可用清单」，而不是让 crypto 抛原始异常
 *  - 编码只允许 hex / base64 / base64url —— 其它一律明确报错
 */
const crypto = require('crypto');

const HASH_ALGOS = [
  'md5', 'sha1', 'sha256', 'sha384', 'sha512',
  'sha3-256', 'sha3-512', 'blake2b512', 'blake2s256'
];

const ALIAS = {
  md5: 'md5',
  sha1: 'sha1',
  sha256: 'sha256',
  sha384: 'sha384',
  sha512: 'sha512',
  sha3256: 'sha3-256',
  sha3512: 'sha3-512',
  sha3: 'sha3-256',
  blake2b512: 'blake2b512',
  blake2b: 'blake2b512',
  blake2s256: 'blake2s256',
  blake2s: 'blake2s256'
};

/** 算法名归一；缺省 sha256 */
function normalizeAlgo(a) {
  const raw = (a === undefined || a === null || a === '') ? 'sha256' : String(a);
  const key = raw.toLowerCase().replace(/[\s_-]/g, '');
  const hit = ALIAS[key];
  if (!hit) {
    throw new Error(`不支持的算法 "${raw}"。可用：${HASH_ALGOS.join(', ')}`);
  }
  return hit;
}

/** 输出编码归一；缺省 hex */
function normalizeEncoding(e) {
  const k = String(e === undefined || e === null || e === '' ? 'hex' : e).toLowerCase().replace(/[\s_-]/g, '');
  if (k === 'hex') return 'hex';
  if (k === 'base64') return 'base64';
  if (k === 'base64url') return 'base64url';
  throw new Error(`不支持的输出编码 "${e}"。可用：hex, base64, base64url`);
}

/** 摘要 */
function digest(algo, data, encoding) {
  return crypto.createHash(algo).update(data).digest(encoding);
}

/** HMAC 摘要 */
function hmacDigest(algo, key, data, encoding) {
  return crypto.createHmac(algo, key).update(data).digest(encoding);
}

/** 恒定时间比较两个字符串（长度不同直接 false，不抛异常） */
function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = { HASH_ALGOS, normalizeAlgo, normalizeEncoding, digest, hmacDigest, safeEqual };
