'use strict';
/** cryptox_uuid —— 生成 UUID / 短 ID，或校验已有 UUID */
const crypto = require('crypto');
const F = require('../utils/format');

const MAX_COUNT = 100;

/** 同毫秒内的单调计数器状态（RFC 9562 的 Monotonic Random 思路） */
let v7LastMs = -1;
let v7Counter = 0;

/**
 * UUID v7（RFC 9562）：48 位毫秒时间戳 + 12 位计数器 + 62 位随机
 *
 * 为什么需要计数器：如果 rand_a 也填纯随机，**同一毫秒内生成的多个 v7 无法保证字典序**
 * （实测三个连续 v7 排序为 …7dde / …7f30 / …7a59 是乱的）。那 v7 相对 v4 的意义
 * —— 可当排序键、索引局部性好 —— 就丢了一半。
 *
 * 策略：rand_a（12 位）作同毫秒计数器；新毫秒从随机值起步（避免 ID 可预测）；
 * 同毫秒内递增；计数器溢出则借用下一个毫秒；时钟回拨时沿用上一个时间戳，绝不倒退。
 */
function uuidv7() {
  let ms = Date.now();
  if (ms <= v7LastMs) {
    ms = v7LastMs;                                  // 同毫秒或时钟回拨：不倒退
    v7Counter = (v7Counter + 1) & 0x0fff;
    if (v7Counter === 0) ms = v7LastMs + 1;         // 12 位溢出：借用下一毫秒
  } else {
    v7Counter = crypto.randomInt(0, 0x1000);        // 新毫秒：随机起点
  }
  v7LastMs = ms;

  const buf = Buffer.alloc(16);
  buf[0] = Math.floor(ms / 2 ** 40) & 0xff;
  buf[1] = Math.floor(ms / 2 ** 32) & 0xff;
  buf[2] = Math.floor(ms / 2 ** 24) & 0xff;
  buf[3] = Math.floor(ms / 2 ** 16) & 0xff;
  buf[4] = Math.floor(ms / 2 ** 8) & 0xff;
  buf[5] = ms & 0xff;
  crypto.randomBytes(8).copy(buf, 8);               // rand_b
  buf[6] = (v7Counter >> 8) & 0x0f;                 // rand_a 高 4 位 = 计数器高位
  buf[7] = v7Counter & 0xff;                        // rand_a 低 8 位 = 计数器低位
  buf[6] = (buf[6] & 0x0f) | 0x70;                  // version = 7
  buf[8] = (buf[8] & 0x3f) | 0x80;                  // variant = RFC 4122/9562
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 短 ID：URL 安全、无填充的 base64 随机串 */
function shortId(len = 16) {
  const n = Math.max(6, Math.min(64, Math.floor(len)));
  const bytes = Math.ceil(n * 3 / 4);
  return crypto.randomBytes(bytes).toString('base64url').slice(0, n);
}

const UUID_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

/** 校验并解析一个 UUID 字符串 */
function inspect(value) {
  const s = String(value).trim();
  const m = UUID_RE.exec(s);
  if (!m) return { value: s, valid: false, reason: '不符合 8-4-4-4-12 的十六进制格式' };
  const version = parseInt(m[3][0], 16);
  const variantNibble = parseInt(m[4][0], 16);
  const variantOk = (variantNibble & 0x8) === 0x8;   // RFC 4122 / 9562 变体
  return {
    value: s.toLowerCase(),
    valid: true,
    version,
    variant: variantOk ? 'RFC 4122/9562' : `非标准（首 nibble=${m[4][0]}）`,
    variantOk
  };
}

module.exports = {
  name: 'cryptox_uuid',
  title: 'UUID 与短 ID 生成',
  description: '生成 UUID 或短 ID，也可以校验已有 UUID 的版本与合法性。'
    + '参数：version（v4 随机 / v7 时间有序，默认 v4；或 short 生成短 ID）、count（生成个数，默认 1，上限 100）、length（仅 short 用，默认 16，范围 6-64）、validate（给一个字符串则改为校验模式，忽略生成参数）。'
    + 'v7 按 RFC 9562 实现：48 位毫秒时间戳 + 12 位同毫秒计数器，批量生成的 ID 严格递增，可直接当排序键。',
  inputSchema: {
    type: 'object',
    properties: {
      version: { type: 'string', description: 'v4（默认，随机）/ v7（时间有序）/ short（短 ID）' },
      count: { type: 'number', description: `生成个数，默认 1，上限 ${MAX_COUNT}` },
      length: { type: 'number', description: 'short 模式下的长度，默认 16（范围 6-64）' },
      validate: { type: 'string', description: '可选：给出一个 UUID 字符串则进入校验模式' }
    },
    additionalProperties: false
  },

  run(args = {}) {
    // 校验模式
    if (typeof args.validate === 'string' && args.validate.trim()) {
      const r = inspect(args.validate);
      const _text = [
        'UUID 校验',
        '',
        F.kv([
          ['输入', r.value],
          ['合法', r.valid ? '是' : '否'],
          ['版本', r.valid ? 'v' + r.version : '—'],
          ['变体', r.valid ? r.variant : '—'],
          ['说明', r.valid ? (r.variantOk ? '结构正确' : '结构可解析但变体位不符合 RFC') : r.reason]
        ])
      ].join('\n');
      return { _text, mode: 'validate', result: r };
    }

    const raw = String(args.version === undefined || args.version === null ? 'v4' : args.version).trim().toLowerCase().replace(/[\s_-]/g, '');
    const version = { v4: 'v4', uuid4: 'v4', random: 'v4', v7: 'v7', uuid7: 'v7', short: 'short', shortid: 'short', nano: 'short' }[raw];
    if (!version) {
      throw new Error(`不支持的 version "${args.version}"。可用：v4, v7, short`);
    }

    const count = Number.isFinite(args.count) && args.count > 0 ? Math.min(Math.floor(args.count), MAX_COUNT) : 1;
    const len = Number.isFinite(args.length) ? Math.floor(args.length) : 16;

    const ids = [];
    for (let i = 0; i < count; i++) {
      if (version === 'v4') ids.push(crypto.randomUUID());
      else if (version === 'v7') ids.push(uuidv7());
      else ids.push(shortId(len));
    }

    const _text = [
      `生成 · ${version} · ${count} 个`,
      '',
      F.list(ids)
    ].join('\n');

    return { _text, mode: 'generate', version, count, ids };
  },

  uuidv7,
  shortId,
  inspect
};
