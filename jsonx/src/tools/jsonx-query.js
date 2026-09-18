'use strict';
/**
 * jsonx_query —— JSONPath 取值
 *
 * 支持子集：$ / .key / ['key'] / [n] / [*] / ..key / [start:end:step] / [a,b]
 * 明确不支持过滤器 [?(...)]，会报错并给出替代方案（不静默返回空）。
 */

const F = require('./format');

const inputSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '源文本（JSON / YAML / CSV / TSV，会自动识别）' },
    path: {
      type: 'string',
      description: 'JSONPath 表达式。支持 $ / .key / ["key"] / [n] / [*] / ..key（递归下降）/ [start:end] / [a,b]（多选）。例：$.users[*].name、$..id、$.items[0:3]'
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: '一次查多个路径（与 path 二选一）。批量取值比多次调用省上下文'
    },
    format: { type: 'string', enum: ['auto', 'json', 'yaml', 'csv', 'tsv'], description: '源格式，默认 auto' },
    delimiter: { type: 'string', description: 'CSV 分隔符' },
    header: { type: 'boolean', description: 'CSV 首行是否表头，默认 true' },
    infer: { type: 'boolean', description: 'CSV 是否类型推断，默认 true' },
    limit: { type: 'integer', description: '最多返回多少条匹配，默认 50，最大 1000（防上下文爆炸）' },
    withPath: { type: 'boolean', description: '是否显示每条匹配的路径，默认 true' }
  },
  required: ['text']
};

async function run(args = {}) {
  const text = args.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('请提供 text（源文本）。');
  }
  if (!args.path && !args.paths) {
    throw new Error(
      '请提供 path（单个 JSONPath）或 paths（多个）。\n' +
      '例：{"path":"$.users[*].name"}  或  {"paths":["$.id","$.name"]}'
    );
  }

  const parse = require('./jsonx-parse');
  const JP = require('../utils/jsonpath.js');

  const from = args.format || 'auto';
  const detected = from === 'auto' ? parse.detectFormat(text) : { format: from, confidence: 1, reason: '用户指定' };

  let value;
  let warnings = [];
  if (detected.format === 'csv' || detected.format === 'tsv') {
    const r = parse.parseTabular(text, { ...args, format: detected.format });
    // CSV 解析出来是记录数组，$ 即数组
    value = r.records;
    warnings = r.warnings;
  } else {
    const r = parse.parseJsonish(text, detected.format);
    value = r.value;
    warnings = r.warnings;
  }

  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 1000);
  const withPath = args.withPath !== false;

  const queries = args.paths && Array.isArray(args.paths) && args.paths.length
    ? args.paths.map(p => ({ label: p, path: p }))
    : [{ label: args.path, path: args.path }];

  if (queries.length > 20) {
    throw new Error(`一次最多查询 20 个路径，收到 ${queries.length} 个。`);
  }

  const L = [];
  L.push(`▸ 在 ${detected.format.toUpperCase()} 数据上查询${queries.length > 1 ? ` ${queries.length} 个路径` : ''}`);
  L.push('');

  const results = [];
  for (const q of queries) {
    let qr;
    try {
      qr = JP.query(value, q.path);
    } catch (e) {
      // 单条路径失败不影响其他路径，但错误原文要透出
      results.push({ path: q.path, error: e.message, count: 0, matches: [] });
      L.push(`✗ ${q.path}`);
      L.push(F.indentBlock(e.message, '    '));
      L.push('');
      continue;
    }

    const shown = qr.matches.slice(0, limit);
    const truncated = qr.matches.length - shown.length;

    results.push({
      path: q.path,
      count: qr.matches.length,
      truncated,
      matches: shown.map(m => ({ path: m.path, value: m.value }))
    });

    L.push(`✓ ${q.path}  →  ${qr.count} 条匹配` + (truncated ? `（只显示前 ${limit} 条）` : ''));

    if (qr.count === 0) {
      L.push('    （无匹配）');
      // 给一次"路径是不是写错了"的自检提示
      const hint = suggestFix(value, q.path);
      if (hint) L.push('    提示：' + hint);
      L.push('');
      continue;
    }

    // 输出：短匹配用紧凑列表，复杂匹配用表格或 JSON
    if (shown.every(m => m.value === null || typeof m.value !== 'object')) {
      shown.forEach(m => {
        L.push('    ' + (withPath ? F.cell(m.path, 60) + '  =  ' : '') + F.cell(m.value, 200));
      });
    } else if (shown.every(m => m.value !== null && typeof m.value === 'object' && !Array.isArray(m.value))) {
      // 对象数组（最常见：一条条记录）→ 表格
      const cols = [];
      const seen = new Set();
      for (const m of shown) {
        for (const k of Object.keys(m.value)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
      }
      if (cols.length <= 12) {
        L.push(F.table(
          withPath ? ['路径', ...cols] : cols,
          shown.map(m => (withPath ? [m.path] : []).concat(cols.map(c => {
            const v = m.value[c];
            return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
          })))
        ));
      } else {
        shown.forEach(m => {
          L.push('    ' + (withPath ? F.cell(m.path, 60) + ':' : ''));
          L.push(F.indentBlock(F.safeStringify(m.value, 800), '      '));
        });
      }
    } else {
      shown.forEach(m => {
        if (withPath) L.push('    ' + F.cell(m.path, 60) + ':');
        const body = Array.isArray(m.value)
          ? '[' + m.value.map(x => F.cell(x, 60)).join(', ') + ']' + (m.value.length > 8 ? ` …共 ${m.value.length} 项` : '')
          : F.safeStringify(m.value, 800);
        L.push(F.indentBlock(body, '      '));
      });
    }
    if (truncated) L.push(`    …（另有 ${truncated} 条，用 limit 调大或缩小路径范围）`);
    L.push('');
  }

  // 顶层可用的键提示（帮模型纠正路径）
  const topKeys = topLevelKeys(value);
  if (topKeys.length) {
    L.push('■ 顶层可用的键');
    L.push('  ' + topKeys.slice(0, 30).join(', ') + (topKeys.length > 30 ? ` …共 ${topKeys.length} 个` : ''));
  }

  if (warnings.length) {
    L.push('');
    L.push('■ 源解析提示');
    warnings.slice(0, 5).forEach(w => L.push('  · ' + w));
  }

  return {
    _text: L.join('\n'),
    format: detected.format,
    results,
    topLevelKeys: topKeys,
    warnings
  };
}

/** 顶层键列表（数组则给元素结构） */
function topLevelKeys(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value);
  if (Array.isArray(value)) {
    const first = value.find(x => x !== null && typeof x === 'object' && !Array.isArray(x));
    if (first) return ['[数组] 每个元素的字段: ' + Object.keys(first).join(', ')];
  }
  return [];
}

/** 路径无匹配时，尝试猜一个相近的正确路径 */
function suggestFix(value, path) {
  const JP = require('../utils/jsonpath.js');
  const m = /\.([A-Za-z_$][A-Za-z0-9_$-]*)$/.exec(path);
  if (!m) {
    if (/\[\?\(/.test(path)) return '本实现不支持过滤器 [?(...)]，请先用 jsonx_query 取出整个数组，或用 jsonx_convert 转成 CSV 后自己筛选。';
    return null;
  }
  const wanted = m[1];

  // 收集全文档出现过的所有键名，找相近的
  const allKeys = new Set();
  const collect = (v, depth) => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(x => collect(x, depth + 1)); return; }
    for (const k of Object.keys(v)) { allKeys.add(k); collect(v[k], depth + 1); }
  };
  collect(value, 0);

  const lower = wanted.toLowerCase();
  const near = [...allKeys].filter(k => {
    const kl = k.toLowerCase();
    return kl !== lower && (kl.includes(lower) || lower.includes(kl));
  });
  if (near.length) return `没有 "${wanted}" 这个键。相近的有：${near.slice(0, 6).join(', ')}`;
  if (allKeys.size === 0) return '数据里没有任何对象键，确认一下路径层级。';
  return `没有 "${wanted}" 这个键。文档中出现过的键有：${[...allKeys].slice(0, 15).join(', ')}` +
    (allKeys.size > 15 ? ` …共 ${allKeys.size} 个` : '');
}

module.exports = {
  name: 'jsonx_query',
  title: 'JSONPath 取值',
  description:
    '用 JSONPath 从 JSON/YAML/CSV 数据里取值。支持 $ / .key / ["key"] / [n] / [*] / ..key（递归下降）/ ' +
    '[start:end] 切片 / [a,b] 多选 / .length。不支持过滤器 [?(...)]（会明确报错并给替代方案）。' +
    '支持一次传多个 path，批量取值比多次调用省上下文。',
  inputSchema,
  run,
  topLevelKeys,
  suggestFix
};
