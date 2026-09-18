'use strict';
/**
 * jsonx_aggregate —— 对记录数组做统计
 *
 * 模型经常需要"这一列的平均值/最大值/去重后有几个"。
 * 手算既慢又容易错（尤其是大数组），本工具在本地一次算完只回传结论。
 */

const F = require('./format');

const AGGS = ['count', 'sum', 'avg', 'min', 'max', 'median', 'distinct', 'stddev', 'first', 'last'];

const inputSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '源文本（JSON / YAML / CSV / TSV，自动识别）' },
    path: {
      type: 'string',
      description: '指向要统计的数组的 JSONPath。默认 "$"（顶层数组）；若数据是 {items:[...]} 则写 "$.items"'
    },
    fields: {
      type: 'array',
      items: { type: 'string' },
      description: '要统计哪些字段。不传则统计所有可统计的字段'
    },
    aggs: {
      type: 'array',
      items: { type: 'string', enum: AGGS },
      description: `要计算哪些统计量，默认 ["count","sum","avg","min","max","distinct"]。可选：${AGGS.join(' / ')}`
    },
    groupBy: {
      type: 'string',
      description: '按某字段分组后再统计（如 groupBy="category"），输出每组一行'
    },
    filter: {
      type: 'object',
      description: '等值筛选，只统计满足条件的记录（如 {"status":"active"}，支持多字段 AND）'
    },
    sortBy: { type: 'string', description: '结果按哪个字段排序（分组或字段名）' },
    sortDesc: { type: 'boolean', description: '排序是否降序，默认 false' },
    limit: { type: 'integer', description: '分组结果最多返回多少组，默认 50' },
    format: { type: 'string', enum: ['auto', 'json', 'yaml', 'csv', 'tsv'], description: '源格式，默认 auto' },
    header: { type: 'boolean', description: 'CSV 首行是否表头，默认 true' },
    infer: { type: 'boolean', description: 'CSV 是否类型推断，默认 true' }
  },
  required: ['text']
};

/** 单个字段的统计 */
function statsOf(values, aggs) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
  const out = {};

  for (const a of aggs) {
    switch (a) {
      case 'count': out.count = values.length; break;
      case 'sum': out.sum = nums.length ? nums.reduce((s, x) => s + x, 0) : null; break;
      case 'avg': out.avg = nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null; break;
      case 'min': out.min = nums.length ? Math.min(...nums) : null; break;
      case 'max': out.max = nums.length ? Math.max(...nums) : null; break;
      case 'median': {
        if (!nums.length) { out.median = null; break; }
        const s = [...nums].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        out.median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
        break;
      }
      case 'stddev': {
        if (nums.length < 2) { out.stddev = null; break; }
        const m = nums.reduce((s, x) => s + x, 0) / nums.length;
        // 样本标准差（n-1）：对"观测数据"更合适
        out.stddev = Math.sqrt(nums.reduce((s, x) => s + (x - m) ** 2, 0) / (nums.length - 1));
        break;
      }
      case 'distinct': {
        const set = new Set(nonNull.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)));
        out.distinct = set.size;
        break;
      }
      case 'first': out.first = nonNull.length ? nonNull[0] : null; break;
      case 'last': out.last = nonNull.length ? nonNull[nonNull.length - 1] : null; break;
    }
  }
  out.nonNull = nonNull.length;
  out.nullCount = values.length - nonNull.length;
  out.numeric = nums.length;
  return out;
}

function round(n, digits = 6) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  if (Number.isInteger(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function run(args = {}) {
  const text = args.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('请提供 text（源文本）。');
  }

  const parse = require('./jsonx-parse');
  const JP = require('../utils/jsonpath.js');

  const from = args.format || 'auto';
  const detected = from === 'auto' ? parse.detectFormat(text) : { format: from, confidence: 1, reason: '用户指定' };

  let root, warnings = [];
  if (detected.format === 'csv' || detected.format === 'tsv') {
    const r = parse.parseTabular(text, { ...args, format: detected.format });
    root = r.records;
    warnings = r.warnings;
  } else {
    const r = parse.parseJsonish(text, detected.format);
    root = r.value;
    warnings = r.warnings;
  }

  // 定位数组
  const path = args.path || '$';
  const q = JP.query(root, path);
  if (q.count === 0) {
    throw new Error(`path="${path}" 没有匹配到数据。请先用 jsonx_schema 看看结构。`);
  }
  let records = q.matches[0].value;
  if (!Array.isArray(records)) {
    if (records !== null && typeof records === 'object') {
      // 单个对象 → 视为一条记录
      records = [records];
    } else {
      throw new Error(`path="${path}" 指向的是 ${F.typeName(records)}，不是数组。统计需要记录数组。`);
    }
  }
  if (records.length === 0) {
    throw new Error(`path="${path}" 是空数组，没有可统计的数据。`);
  }

  const nonObj = records.find(r => r === null || typeof r !== 'object');
  if (nonObj !== undefined) {
    // 标量数组：直接当单字段统计
    records = records.map(v => ({ value: v }));
  }

  // 筛选
  let filtered = records;
  let filterDesc = '';
  if (args.filter && typeof args.filter === 'object') {
    const conds = Object.entries(args.filter);
    if (!conds.length) throw new Error('filter 不能是空对象。');
    filtered = records.filter(rec => conds.every(([k, v]) => {
      const actual = rec[k];
      if (typeof v === 'number' && typeof actual === 'number') return actual === v;
      return String(actual) === String(v);
    }));
    filterDesc = conds.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' 且 ');
    if (filtered.length === 0) {
      const sampleVals = {};
      for (const [k] of conds) {
        const uniq = [...new Set(records.map(r => r[k]).filter(v => v !== undefined))];
        sampleVals[k] = uniq.slice(0, 8);
      }
      throw new Error(
        `筛选条件 ${filterDesc} 没有匹配到任何记录（共 ${records.length} 条）。\n` +
        `该字段实际出现过的值：${Object.entries(sampleVals).map(([k, v]) => `${k} → ${v.map(x => JSON.stringify(x)).join(', ')}`).join('；')}`
      );
    }
  }

  // 确定字段
  const allFields = [];
  const seen = new Set();
  for (const rec of filtered) for (const k of Object.keys(rec)) if (!seen.has(k)) { seen.add(k); allFields.push(k); }
  if (!allFields.length) throw new Error('记录里没有任何字段可统计。');

  let fields = Array.isArray(args.fields) && args.fields.length ? args.fields.filter(f => typeof f === 'string') : allFields;
  if (!fields.length) throw new Error('fields 不能为空数组。');
  const missing = fields.filter(f => !seen.has(f));
  if (missing.length === fields.length) {
    throw new Error(`fields 里的字段都不存在：${missing.join(', ')}。\n该数据的字段有：${allFields.join(', ')}`);
  }

  const aggs = Array.isArray(args.aggs) && args.aggs.length ? args.aggs : ['count', 'sum', 'avg', 'min', 'max', 'distinct'];
  const badAgg = aggs.filter(a => !AGGS.includes(a));
  if (badAgg.length) {
    throw new Error(`不支持的统计量：${badAgg.join(', ')}。可用：${AGGS.join(' / ')}`);
  }

  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 1000);
  const L = [];
  L.push(`▸ 统计 ${path}${filterDesc ? `（已筛选 ${filterDesc}）` : ''}`);
  L.push('');
  L.push(F.kv([
    ['记录数', filtered.length],
    ...(filtered.length !== records.length ? [['筛选前', records.length]] : []),
    ['字段数', allFields.length]
  ]));
  L.push('');

  let groupResults = null;

  if (args.groupBy) {
    const gk = args.groupBy;
    if (!seen.has(gk)) {
      throw new Error(`groupBy 字段 "${gk}" 不存在。可用字段：${allFields.join(', ')}`);
    }
    const groups = new Map();
    for (const rec of filtered) {
      const key = rec[gk] === null || rec[gk] === undefined ? '(null)' : String(rec[gk]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
    }

    const gFields = (Array.isArray(args.fields) && args.fields.length ? args.fields : allFields).filter(f => f !== gk);
    // 分组表里只展示可比较的核心统计量，避免列爆炸
    const gAggs = aggs.filter(a => ['count', 'sum', 'avg', 'min', 'max', 'distinct'].includes(a));

    let rows = [...groups.entries()].map(([key, recs]) => {
      const row = { [gk]: key, 组内记录数: recs.length };
      for (const f of gFields) {
        const st = statsOf(recs.map(r => r[f]), gAggs);
        for (const a of gAggs) {
          if (st[a] === null || st[a] === undefined) continue;
          if (a === 'count') continue;   // 已由"组内记录数"表达
          // 非数值字段只输出 distinct，避免 sum/avg 无意义
          if (['sum', 'avg', 'min', 'max'].includes(a) && st.numeric === 0) continue;
          row[`${f}.${a}`] = round(st[a]);
        }
        if (gAggs.includes('distinct')) row[`${f}.distinct`] = st.distinct;
      }
      return row;
    });

    if (args.sortBy) {
      const sb = args.sortBy;
      rows.sort((a, b) => {
        const va = a[sb], vb = b[sb];
        if (typeof va === 'number' && typeof vb === 'number') return args.sortDesc ? vb - va : va - vb;
        return args.sortDesc ? String(vb).localeCompare(String(va)) : String(va).localeCompare(String(vb));
      });
    } else {
      rows.sort((a, b) => b.组内记录数 - a.组内记录数);
    }

    const totalGroups = rows.length;
    if (rows.length > limit) rows = rows.slice(0, limit);

    const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
    L.push(`■ 分组统计（按 ${gk}，共 ${totalGroups} 组）`);
    L.push(F.table(cols, rows.map(r => cols.map(c => r[c])), { colMax: 30 }));
    if (totalGroups > limit) L.push(`\n…（另有 ${totalGroups - limit} 组，用 limit 调大或加 filter 收窄）`);

    groupResults = { groupBy: gk, groups: totalGroups, rows };
  } else {
    L.push('■ 字段统计');
    const rows = fields.map(f => {
      const st = statsOf(filtered.map(r => r[f]), aggs);
      const cells = [f];
      for (const a of aggs) {
        // 非数值列不显示 sum/avg 的空值，用 — 表示"不适用"
        if (['sum', 'avg', 'median', 'stddev'].includes(a) && st.numeric === 0) cells.push('—');
        else if (a === 'count') cells.push(st.count);
        else cells.push(st[a] === null || st[a] === undefined ? '—' : round(st[a]));
      }
      return { field: f, cells, stats: st };
    });
    L.push(F.table(['字段', ...aggs.map(a => aggLabel(a))], rows.map(r => r.cells)));
    L.push('');

    const typeNotes = rows.filter(r => r.stats.numeric === 0 && ['sum', 'avg'].some(a => aggs.includes(a)));
    if (typeNotes.length) {
      L.push('■ 备注');
      typeNotes.forEach(r => {
        L.push(`  · ${r.field}：非数值字段（可比较 ${r.stats.nonNull} 个非空值，${r.stats.distinct} 个唯一值），sum/avg 不适用`);
      });
    }
    if (missing.length) L.push(`  · 以下字段不存在已跳过：${missing.join(', ')}`);

    groupResults = { fields: rows.map(r => ({ field: r.field, ...r.stats })) };
  }

  if (warnings.length) {
    L.push('');
    L.push('■ 解析提示');
    warnings.slice(0, 4).forEach(w => L.push('  · ' + w));
  }

  return {
    _text: L.join('\n'),
    format: detected.format,
    path,
    recordCount: filtered.length,
    originalCount: records.length,
    ...(filterDesc ? { filter: filterDesc } : {}),
    ...groupResults,
    warnings
  };
}

function aggLabel(a) {
  return {
    count: '条数', sum: '合计', avg: '平均', min: '最小', max: '最大',
    median: '中位数', distinct: '唯一值', stddev: '标准差', first: '首个', last: '末个'
  }[a] || a;
}

module.exports = {
  name: 'jsonx_aggregate',
  title: '统计聚合（计数/求和/平均/分组）',
  description:
    '对记录数组做统计：计数、求和、平均、最值、中位数、标准差、唯一值数，支持 groupBy 分组、' +
    'filter 等值筛选、sortBy 排序。数值统计在本地一次算完只回传结论，比让模型自己遍历数组更快更准。' +
    '非数值字段会明确标注 sum/avg 不适用，而不是返回 0 误导。',
  inputSchema,
  run,
  statsOf
};
