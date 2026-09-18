'use strict';
/** cryptox_password —— 密码生成与强度评估 */
const crypto = require('crypto');
const F = require('../utils/format');

const CHARSETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/'
};
/** 容易看错的字符（0/O、1/l/I、|）—— excludeAmbiguous 时剔除 */
const AMBIGUOUS = new Set('0Oo1lI|`\'"');

/** 常见弱口令（只放最有代表性的一小撮，用于模式提醒，不做字典攻击） */
const COMMON = [
  'password', 'passwd', '123456', '12345678', '123456789', 'qwerty', 'abc123', 'letmein',
  'admin', 'root', 'welcome', 'monkey', 'dragon', 'iloveyou', 'sunshine', 'princess',
  'football', 'baseball', 'master', 'shadow', 'superman', 'trustno1', 'qwerty123', '1q2w3e4r'
];

function charsetOf(pw) {
  let n = 0;
  const kinds = [];
  if (/[a-z]/.test(pw)) { n += 26; kinds.push('小写'); }
  if (/[A-Z]/.test(pw)) { n += 26; kinds.push('大写'); }
  if (/[0-9]/.test(pw)) { n += 10; kinds.push('数字'); }
  if (/[^a-zA-Z0-9]/.test(pw)) { n += 33; kinds.push('符号'); }
  return { n, kinds };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pick(str) {
  return str[crypto.randomInt(0, str.length)];
}

function filterAmbiguous(str, exclude) {
  if (!exclude) return str;
  const out = [...str].filter(ch => !AMBIGUOUS.has(ch)).join('');
  return out.length > 0 ? out : str;
}

function generate(opts) {
  const exclude = opts.excludeAmbiguous !== false;
  const use = {
    lower: opts.lower !== false,
    upper: opts.upper !== false,
    digits: opts.digits !== false,
    symbols: opts.symbols === true     // 符号默认关闭：很多系统不接受
  };
  const pools = [];
  for (const k of Object.keys(use)) {
    if (use[k]) pools.push({ key: k, chars: filterAmbiguous(CHARSETS[k], exclude) });
  }
  if (pools.length === 0) {
    throw new Error('至少要启用一类字符（lower / upper / digits / symbols）');
  }
  const all = pools.map(p => p.chars).join('');
  const length = opts.length;
  if (length < pools.length) {
    throw new Error(`长度 ${length} 太短：需要至少 ${pools.length} 位才能覆盖所选 ${pools.length} 类字符`);
  }

  // 先给每类各放一个，保证类别齐全，再补足长度，最后打乱
  const chars = pools.map(p => pick(p.chars));
  while (chars.length < length) chars.push(pick(all));
  return shuffle(chars).join('');
}

function evaluate(pw) {
  const { n, kinds } = charsetOf(pw);
  const entropy = pw.length > 0 && n > 0 ? pw.length * Math.log2(n) : 0;
  const issues = [];

  if (pw.length < 8) issues.push('长度不足 8 位');
  if (n <= 10) issues.push('字符种类过少（只有一类）');
  if (/(.)\1{2,}/.test(pw)) issues.push('存在连续 3 个以上重复字符');
  if (/^[0-9]+$/.test(pw)) issues.push('纯数字');
  if (/^[a-zA-Z]+$/.test(pw)) issues.push('纯字母');
  if (/(0123|1234|2345|3456|4567|5678|6789|0987|9876|abcd|bcde|cdef|qwer|wert|erty|asdf|sdfg|zxcv)/i.test(pw)) {
    issues.push('包含键盘/字母表顺序片段');
  }
  if (COMMON.includes(pw.toLowerCase())) issues.push('属于常见弱口令');

  let level, advice;
  if (entropy < 28) { level = '极弱'; advice = '几乎可被瞬间猜出，请更换'; }
  else if (entropy < 36) { level = '很弱'; advice = '容易被离线爆破，建议加长'; }
  else if (entropy < 60) { level = '一般'; advice = '日常够用，重要账号建议再长一些'; }
  else if (entropy < 80) { level = '强'; advice = '强度良好'; }
  else { level = '很强'; advice = '强度很好'; }
  if (issues.length > 0 && entropy < 60) advice += '；注意上面列出的模式问题';

  return {
    length: pw.length,
    charsetSize: n,
    kinds,
    entropyBits: Math.round(entropy * 10) / 10,
    level,
    advice,
    issues
  };
}

module.exports = {
  name: 'cryptox_password',
  title: '密码生成与强度评估',
  description: '两种模式：① 生成 —— 默认模式，按 length（默认 16）与字符集开关（lower / upper / digits 默认开，symbols 默认关）生成，'
    + 'excludeAmbiguous 默认剔除容易看错的字符（0O1lI|）；② 评估 —— 给 password 时评估强度：字符集规模、熵（bits）、等级与弱模式问题（纯数字、键盘序列、重复、常见弱口令）。'
    + '用密码学安全随机源（crypto.randomInt）。',
  inputSchema: {
    type: 'object',
    properties: {
      password: { type: 'string', description: '可选：给出待评估的密码则进入评估模式' },
      length: { type: 'number', description: '生成密码的长度，默认 16' },
      count: { type: 'number', description: '生成个数，默认 1，上限 50' },
      lower: { type: 'boolean', description: '是否含小写字母，默认 true' },
      upper: { type: 'boolean', description: '是否含大写字母，默认 true' },
      digits: { type: 'boolean', description: '是否含数字，默认 true' },
      symbols: { type: 'boolean', description: '是否含符号，默认 false' },
      excludeAmbiguous: { type: 'boolean', description: '是否剔除易混字符 0Oo1lI| 等，默认 true' }
    },
    additionalProperties: false
  },

  run(args = {}) {
    // 评估模式
    if (typeof args.password === 'string' && args.password.length > 0) {
      const r = evaluate(args.password);
      const _text = [
        '密码强度评估',
        '',
        F.kv([
          ['长度', r.length + ' 字符'],
          ['字符集规模', r.charsetSize + ' 种（' + r.kinds.join('+') + '）'],
          ['熵', r.entropyBits + ' bits'],
          ['等级', r.level],
          ['建议', r.advice]
        ]),
        r.issues.length ? '\n检测到的弱模式：\n' + F.list(r.issues) : '\n未检测到常见弱模式。'
      ].join('\n');
      return { _text, mode: 'evaluate', result: r };
    }

    // 生成模式
    const length = Number.isFinite(args.length) ? Math.floor(args.length) : 16;
    if (length < 4 || length > 128) {
      throw new Error(`长度需在 4-128 之间，当前 ${length}`);
    }
    const count = Number.isFinite(args.count) && args.count > 0 ? Math.min(Math.floor(args.count), 50) : 1;

    const opts = {
      length,
      lower: args.lower,
      upper: args.upper,
      digits: args.digits,
      symbols: args.symbols,
      excludeAmbiguous: args.excludeAmbiguous
    };
    const passwords = [];
    for (let i = 0; i < count; i++) passwords.push(generate(opts));

    const sample = evaluate(passwords[0]);
    const _text = [
      `密码生成 · ${count} 个 · 长度 ${length} · 熵约 ${sample.entropyBits} bits（${sample.level}）`,
      '',
      F.list(passwords),
      '',
      '（请立即存入密码管理器；本工具不保存、不记录任何生成的密码）'
    ].join('\n');

    return { _text, mode: 'generate', count, length, passwords, entropyBits: sample.entropyBits, level: sample.level };
  },

  generate,
  evaluate
};
