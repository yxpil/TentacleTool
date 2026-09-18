'use strict';
/** cryptox_jwt —— JWT 解析与（可选）签名验证 */
const crypto = require('crypto');
const F = require('../utils/format');

const HS_ALGOS = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
/** 这些算法是"无签名/不安全"的，遇到要明确警告而不是当作验证通过 */
const UNSAFE_ALGOS = ['none', 'null', ''];

function b64urlDecode(seg) {
  const b = String(seg).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4;
  const padded = pad === 1 ? b : (pad ? b + '='.repeat(4 - pad) : b);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/** 秒级时间戳 → ISO 字符串（超出 Date 表示范围则返回 null） */
function toIso(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const ms = v * 1000;
  if (ms < -8640000000000000 || ms > 8640000000000000) return null;
  return new Date(ms).toISOString();
}

module.exports = {
  name: 'cryptox_jwt',
  title: 'JWT 解析与验证',
  description: '解析 JWT 的 header 与 payload，把 exp / iat / nbf 换算成人类可读时间并标注是否已过期；'
    + '给了 secret 则验证 HS256 / HS384 / HS512 签名（用恒定时间比较）。'
    + '本工具只做解析与验证，不做签名伪造、不做密钥爆破。参数：token（必填）、secret（可选）。',
  inputSchema: {
    type: 'object',
    properties: {
      token: { type: 'string', description: 'JWT 字符串（三段，用 . 分隔）' },
      secret: { type: 'string', description: '可选：HMAC 密钥，提供则验证签名' }
    },
    required: ['token'],
    additionalProperties: false
  },

  run(args = {}) {
    if (typeof args.token !== 'string' || !args.token.trim()) {
      throw new Error('必须提供 token（JWT 字符串）');
    }
    const token = args.token.trim();
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error(`不是合法的 JWT：应有 3 段（header.payload.signature），实际 ${parts.length} 段`);
    }

    let header, payload;
    try {
      header = JSON.parse(b64urlDecode(parts[0]));
    } catch (e) {
      throw new Error('JWT header 解析失败：不是合法的 base64url JSON');
    }
    try {
      payload = JSON.parse(b64urlDecode(parts[1]));
    } catch (e) {
      throw new Error('JWT payload 解析失败：不是合法的 base64url JSON');
    }

    const alg = String(header.alg || '').toUpperCase();
    const now = Math.floor(Date.now() / 1000);

    const times = [];
    for (const [name, key] of [['签发时间 iat', 'iat'], ['生效时间 nbf', 'nbf'], ['过期时间 exp', 'exp']]) {
      const v = payload[key];
      if (v === undefined) continue;
      const iso = toIso(v);
      let state = '—';   // iat 无"状态"语义，按仓库约定用破折号而非空白
      if (key === 'exp') state = v < now ? '已过期' : '未过期';
      if (key === 'nbf') state = v > now ? '尚未生效' : '已生效';
      times.push([name, v, iso || '（超出可表示范围）', state]);
    }

    // 签名验证
    let verify = { attempted: false };
    if (typeof args.secret === 'string' && args.secret.length > 0) {
      verify.attempted = true;
      verify.algorithm = alg || '(缺失)';
      if (UNSAFE_ALGOS.includes(alg.toLowerCase())) {
        verify.supported = false;
        verify.valid = false;
        verify.reason = `header.alg 为 "${header.alg}"（无签名算法），拒绝视为验证通过`;
      } else if (!HS_ALGOS[alg]) {
        verify.supported = false;
        verify.valid = false;
        verify.reason = `暂只支持 HMAC 系列（${Object.keys(HS_ALGOS).join(' / ')}），当前为 ${alg}`;
      } else {
        verify.supported = true;
        const expected = crypto
          .createHmac(HS_ALGOS[alg], args.secret)
          .update(parts[0] + '.' + parts[1])
          .digest('base64url');
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(parts[2], 'utf8');
        verify.valid = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
    }

    const lines = ['JWT 解析', ''];
    lines.push(F.kv([
      ['算法 alg', header.alg],
      ['类型 typ', header.typ],
      ['段数', 3]
    ]));
    lines.push('');
    lines.push('header:');
    lines.push(F.indentBlock(JSON.stringify(header, null, 2)));
    lines.push('');
    lines.push('payload:');
    lines.push(F.indentBlock(JSON.stringify(payload, null, 2)));
    if (times.length) {
      lines.push('');
      lines.push(F.table(['时间字段', '原始值', '可读时间', '状态'], times, { cellMax: 60 }));
    }
    if (verify.attempted) {
      lines.push('');
      lines.push(verify.valid ? '签名验证：✓ 通过' : `签名验证：✗ 未通过${verify.reason ? ' —— ' + verify.reason : ''}`);
    } else {
      lines.push('');
      lines.push('（未提供 secret，跳过了签名验证；注意：只解析 payload 并不能证明 token 可信）');
    }

    return {
      _text: F.clip(lines.join('\n'), 24000, 'payload 过大时可只关注关键字段'),
      header,
      payload,
      algorithm: header.alg || null,
      expired: typeof payload.exp === 'number' ? payload.exp < now : null,
      times,
      verify
    };
  },

  b64urlDecode,
  toIso
};
