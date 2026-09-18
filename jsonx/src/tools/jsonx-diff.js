'use strict';
/**
 * jsonx_diff —— 结构化 diff
 *
 * 文本 diff 对 JSON 毫无意义（键顺序、缩进都产生假差异），
 * 本工具递归比较结构，输出 added / removed / changed 三类改动及其路径。
 */

const F = require('./format');

const inputSchema = {
  type: 'object',
  properties: {
    left: { type: 'string', description: '左侧（旧版 / 期望值）文本' },
    right: { type: 'string', description: '右侧（新版 / 实际值）文本' },
    format: { type: 'string', enum: ['auto', 'json', 'yaml', 'csv', 'tsv'], description: '两侧的输入格式，默认 auto（两侧分别自动识别）' },
    leftFormat: { type: 'string', enum: ['auto', 'json', 'yaml', 'csv', 'tsv'], description: '单独指定左侧格式（两侧格式不同时使用）' },
    rightFormat: { type: 'string', enum: ['auto', 'json', 'yaml', 'csv', 'tsv'], description: '单独指定右侧格式' },
    arrayMode: {
      type: 'string',
      enum: ['index', 'byKey', 'ignoreOrder'],
      description:
        '数组比较模式。index（默认）按下标比较；byKey 按元素内某字段匹配（长列表插入元素时不会全盘报差异）；' +
        'ignoreOrder 无视顺序（当数组是集合时用）'
    },
    arrayKey: { type: 'string', description: 'arrayMode=byKey 时用于匹配元素的字段名，默认 id' },
    ignoreOrder: {
      type: 'boolean',
      description: '等价于 arrayMode="ignoreOrder"（数组当集合比较，无视顺序）。两种写法都接受'
    },
    ignoreKeys: {
      type: 'array',
      items: { type: 'string' },
      description:
        '要忽略的路径前缀，如 ["$.updatedAt", "$.meta"]。' +
        '自动兼容两种写法：带 $ 前缀（"$.updatedAt"）与裸键名（"updatedAt"）都识别'
    },
    numericTolerance: { type: 'number', description: '数值容差，默认 0（严格相等）。浮点比较建议设 1e-9' },
    maxChanges: { type: 'integer', description: '最多报告多少条改动，默认 100，最大 1000' },
    limit: { type: 'integer', description: '展示多少条改动，默认 30' }
  },
  required: ['left', 'right']
};

/**
 * 归一化 ignoreKeys。
 *
 * diff() 内部用 `path === k || path.startsWith(k + '.') || path.startsWith(k + '[')` 匹配，
 * 而 path 一定带 `$` 前缀（顶层是 `$`、子键是 `$.updatedAt`）。
 * 于是用户写裸键名 `"updatedAt"` 时 `$.updatedAt`.startsWith('updatedAt.') 为 false，
 * `$.updatedAt` === `updatedAt` 也为 false —— 静默失效，diff 照报噪声。
 *
 * 而这恰恰是最容易踩的写法（matching schema 里那段 `["$.updatedAt", "$.meta"]` 示例
 * 反而没人会照抄）。所以这里统一补上 `$` 前缀，两种写法都吃。
 * 同时顺手拒绝永远匹配不上的输入（空串 / 纯 `$`），避免"传了但没用"的静默失败。
 */
function normalizeIgnoreKeys(input, leftValue, rightValue) {
  if (!Array.isArray(input) || input.length === 0) return [];
  const out = [];
  const unknown = [];
  for (const raw of input) {
    let k = String(raw).trim();
    if (!k) continue;
    if (k === '$') {
      throw new Error('ignoreKeys 不能是 "$"（那会把整棵树都忽略掉）。请给出具体字段，如 "updatedAt" 或 "$.meta"。');
    }
    // 裸键名与点号路径补 `$`；已经是 `$` 开头或 `[` 开头的保持原样
    if (k[0] !== '$' && k[0] !== '[') k = '$.' + k.replace(/^\./, '');
    out.push(k);
    // 顶层键存在性检查：只对 `$.xxx` 形式且两侧都是对象时做，避免误报
    const m = /^\$\.([A-Za-z0-9_$-]+)$/.exec(k);
    if (m && isObjLike(leftValue) && isObjLike(rightValue)) {
      const name = m[1];
      if (!(name in leftValue) && !(name in rightValue)) unknown.push(name);
    }
  }
  if (unknown.length && out.length === unknown.length) {
    throw new Error(
      `ignoreKeys 里的键在两侧数据中都不存在：${unknown.join(', ')}。\n` +
      '请确认字段名（可以用 jsonx_schema 看清有哪些字段）；本参数不会静默忽略不存在的键。'
    );
  }
  return out;
}

function isObjLike(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseSide(text, fmt, args, label) {
  const parse = require('./jsonx-parse');
  const from = fmt || args.format || 'auto';
  const detected = from === 'auto'
    ? parse.detectFormat(text)
    : { format: from, confidence: 1, reason: '用户指定' };
  if (detected.format === 'csv' || detected.format === 'tsv') {
    const r = parse.parseTabular(text, { ...args, format: detected.format });
    return { value: r.records, format: detected.format, warnings: r.warnings };
  }
  const r = parse.parseJsonish(text, detected.format);
  return { value: r.value, format: detected.format, warnings: r.warnings };
}

async function run(args = {}) {
  if (typeof args.left !== 'string' || typeof args.right !== 'string') {
    throw new Error('请提供 left 与 right（两侧要比较的文本）。\n例：{"left":"{\\"a\\":1}","right":"{\\"a\\":2}"}');
  }

  const D = require('../utils/diff.js');
  const L = parseSide(args.left, args.leftFormat, args, 'left');
  const R = parseSide(args.right, args.rightFormat, args, 'right');

  const maxChanges = Math.min(Math.max(parseInt(args.maxChanges, 10) || 100, 1), 1000);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 200);

  if (args.arrayMode && !['index', 'byKey', 'ignoreOrder'].includes(args.arrayMode)) {
    throw new Error(`arrayMode 只能是 index / byKey / ignoreOrder，收到 ${JSON.stringify(args.arrayMode)}`);
  }
  if (Array.isArray(args.ignoreKeys) && args.ignoreKeys.some(k => typeof k !== 'string')) {
    throw new Error('ignoreKeys 必须是字符串数组，如 ["$.updatedAt"]。');
  }

  const result = D.diff(L.value, R.value, {
    arrayMode: args.arrayMode,
    arrayKey: args.arrayKey,
    // ★ 必须把便捷开关透传下去。踩过的坑：工具层只透传了 arrayMode，
    // 而 diff() 里读的 opts.ignoreArrayOrder / opts.ignoreOrder 在这一层就丢了，
    // 于是「按文档写 ignoreOrder:true」静默无效、仍按下标比较。
    // 这类「选项被中间层吃掉」的 bug 单元测试测不出（引擎层是对的），
    // 只有端到端按文档调用才暴露 —— 所以 e2e 必须按文档写法调用。
    ignoreOrder: args.ignoreOrder,
    ignoreArrayOrder: args.ignoreArrayOrder,
    ignoreKeys: normalizeIgnoreKeys(args.ignoreKeys, L.value, R.value),
    numericTolerance: typeof args.numericTolerance === 'number' ? args.numericTolerance : 0,
    maxChanges
  });

  const L_ = [];
  L_.push(`▸ 结构化比较：${L.format.toUpperCase()} vs ${R.format.toUpperCase()}（数组模式 ${result.options.arrayMode}）`);
  L_.push('');

  // 把生效的比较选项显式回显：diff 的"静默无效"是最危险的失败模式
  // （选项没生效时不报错、只多出几条假差异，用户会当成真实改动）。
  const effective = [];
  if (result.options.arrayMode !== 'index') effective.push(`数组模式=${result.options.arrayMode}`);
  if (result.options.arrayMode === 'byKey') effective.push(`匹配键=${result.options.arrayKey}`);
  if (result.options.ignoreKeys.length) effective.push(`忽略=${result.options.ignoreKeys.join(',')}`);
  if (result.options.numericTolerance > 0) effective.push(`数值容差=${result.options.numericTolerance}`);
  if (effective.length) L_.push('  生效选项：' + effective.join('  ·  '));

  if (result.equal) {
    L_.push('✓ 两侧结构完全相等（键顺序与缩进差异不计）');
  } else {
    const s = result.stats;
    L_.push(`✗ 发现 ${result.changes.length} 处改动` + (result.truncated ? '（已达上限，未穷尽）' : ''));
    L_.push(F.kv([
      ['新增', s.added],
      ['删除', s.removed],
      ['修改', s.changed],
      ['其中类型变化', s.typeChanges],
      ['未变', s.unchanged]
    ]));
    L_.push('');
    L_.push(`■ 改动明细（显示前 ${Math.min(limit, result.changes.length)} 条）`);
    L_.push(F.table(
      ['类型', '路径', '左', '右', '说明'],
      result.changes.slice(0, limit).map(c => [
        c.kind === 'added' ? '新增' : c.kind === 'removed' ? '删除' : '修改',
        c.path,
        c.left !== undefined ? c.left : '',
        c.right !== undefined ? c.right : '',
        c.reason || ''
      ]),
      { colMax: 48 }
    ));
    if (result.changes.length > limit) {
      L_.push(`\n…（另有 ${result.changes.length - limit} 条，用 limit 调大）`);
    }
    if (result.truncated) {
      L_.push('\n⚠ 已达 maxChanges 上限，改动列表不完整。调大 maxChanges 可看全。');
    }
  }

  const warnings = [...L.warnings, ...R.warnings];
  if (warnings.length) {
    L_.push('');
    L_.push('■ 解析提示');
    warnings.slice(0, 5).forEach(w => L_.push('  · ' + w));
  }

  return {
    _text: L_.join('\n'),
    equal: result.equal,
    changes: result.changes,
    stats: result.stats,
    truncated: result.truncated,
    options: result.options,
    warnings
  };
}

module.exports = {
  name: 'jsonx_diff',
  title: '结构化 diff（比文本 diff 准确）',
  description:
    '递归比较两段 JSON/YAML/CSV 数据的结构，输出带路径的 added/removed/changed 改动列表。' +
    '键顺序与缩进差异不计（这是文本 diff 会误报的）。数组支持三种比较模式：index（按下标）、' +
    'byKey（按元素内 id 等字段匹配，适合长列表增删）、ignoreOrder（无视顺序）。' +
    '支持 ignoreKeys 排除时间戳等噪声字段、numericTolerance 做浮点容差。',
  inputSchema,
  run
};
