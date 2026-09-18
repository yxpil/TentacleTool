'use strict';
/**
 * jsonx_convert —— 格式互转（JSON / YAML / CSV / TSV / Markdown 表格）
 *
 * 双向：任何输入格式 → 任何输出格式。
 * CSV 只能表达二维表，所以非表格数据（深层嵌套）转 CSV 时会明确拒绝或压平，
 * 而不是悄悄丢数据。
 */

const F = require('./format');

const IN_FORMATS = ['auto', 'json', 'yaml', 'csv', 'tsv'];
const OUT_FORMATS = ['json', 'yaml', 'csv', 'tsv', 'markdown'];

const inputSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '要转换的源文本' },
    from: {
      type: 'string',
      enum: IN_FORMATS,
      description: '源格式。默认 auto 自动识别'
    },
    to: {
      type: 'string',
      enum: OUT_FORMATS,
      description: '目标格式：json / yaml / csv / tsv / markdown（markdown = 表格形式，便于直接给人看）'
    },
    delimiter: { type: 'string', description: 'CSV/TSV 读入时的分隔符（别名 comma/semicolon/tab/pipe 或单字符）' },
    outDelimiter: { type: 'string', description: '输出 CSV 时的分隔符，默认逗号' },
    header: { type: 'boolean', description: 'CSV 读入时是否把首行当表头，默认 true' },
    infer: { type: 'boolean', description: 'CSV 读入时是否做类型推断，默认 true' },
    pretty: { type: 'boolean', description: 'JSON/YAML 输出是否美化缩进，默认 true' },
    indent: { type: 'integer', description: 'JSON 缩进空格数，默认 2' },
    sortKeys: { type: 'boolean', description: 'YAML/JSON 输出时按键名排序，默认 false（保持原序）' },
    flatten: {
      type: 'string',
      enum: ['reject', 'dot', 'json'],
      description: '嵌套对象转 CSV 时的策略：reject（默认，报错并说明）/ dot（把 a.b 变成列名）/ json（把嵌套值序列化成 JSON 字符串）'
    },
    arrayPath: {
      type: 'string',
      description: '当源数据是对象、但内含一个记录数组时，指定该数组的 JSONPath（如 "$.items"）作为表格数据源'
    },
    maxRows: { type: 'integer', description: '最多输出多少行，默认 5000' }
  },
  required: ['text', 'to']
};

/** 把记录数组压平成二维表（含表头） */
function toTable(value, opts) {
  const strategy = opts.flatten || 'reject';
  let rows = value;

  if (rows !== null && typeof rows === 'object' && !Array.isArray(rows)) {
    // 单个对象 → 一行
    rows = [rows];
  }
  if (!Array.isArray(rows)) {
    throw new Error(
      `无法转成表格：顶层是 ${F.typeName(value)}，而 CSV/TSV/Markdown 只能表达"记录列表"。\n` +
      '若数据在某个字段里（如 {items:[...]}），请用 arrayPath 参数指定，例如 arrayPath="$.items"。'
    );
  }
  if (rows.length === 0) return { header: [], rows: [] };

  const nonObj = rows.find(r => r === null || typeof r !== 'object');
  if (nonObj !== undefined) {
    // 标量数组 → 单列表格
    return { header: ['value'], rows: rows.map(r => [r]) };
  }

  // 收集列：并集，保持首次出现顺序
  const cols = [];
  const seen = new Set();
  const nested = new Map();   // 列名 → 该列是否存在嵌套值

  const flatRecords = rows.map(r => {
    if (Array.isArray(r)) return { value: r };
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
      const isNested = v !== null && typeof v === 'object';
      if (isNested) nested.set(k, true);
      out[k] = v;
    }
    return out;
  });

  if (nested.size > 0 && strategy === 'reject') {
    const bad = [...nested.keys()];
    // 若某个嵌套字段是"记录数组"，八成是用户想拿它当表 —— 直接给出可复制的 arrayPath
    const arrayHints = bad.filter(k => Array.isArray(rows[0][k]) && rows.every(r => r && typeof r === 'object'));
    throw new Error(
      `无法直接转成 CSV：以下字段含嵌套对象/数组，而 CSV 是二维表 —— ${bad.join(', ')}。\n` +
      (arrayHints.length
        ? `看起来 "${arrayHints[0]}" 才是你要转的记录列表，试试：arrayPath="$.${arrayHints[0]}"\n`
        : '') +
      '三种处理方式（用 flatten 参数选择）：\n' +
      '  · flatten="json"  把嵌套值序列化成 JSON 字符串放进单元格（保留全部信息，便于往返）\n' +
      '  · flatten="dot"   展开成点号列名（如 user.name），只展开对象不展开数组\n' +
      '  · 先用 jsonx_query 提取出你要的那一层，再转 CSV'
    );
  }

  let finalCols = cols;
  let outRecords = flatRecords;

  if (strategy === 'dot') {
    const expanded = [];
    const dotCols = [];
    const dotSeen = new Set();
    for (const rec of flatRecords) {
      const o = {};
      const visit = (obj, prefix) => {
        for (const [k, v] of Object.entries(obj)) {
          const name = prefix ? prefix + '.' + k : k;
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) visit(v, name);
          else {
            o[name] = Array.isArray(v) ? JSON.stringify(v) : v;
            if (!dotSeen.has(name)) { dotSeen.add(name); dotCols.push(name); }
          }
        }
      };
      visit(rec, '');
      expanded.push(o);
    }
    finalCols = dotCols;
    outRecords = expanded;
  } else if (strategy === 'json') {
    outRecords = flatRecords.map(rec => {
      const o = {};
      for (const [k, v] of Object.entries(rec)) {
        o[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
      }
      return o;
    });
  }

  const body = outRecords.map(rec => finalCols.map(c => {
    const v = rec[c];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }));

  return { header: finalCols, rows: body };
}

/** 渲染 Markdown 表格 */
function renderMarkdown(header, rows) {
  if (!header.length) return '（空表：没有数据行）\n';
  return F.table(header, rows, { colMax: 40, totalMax: 24000 }) + '\n';
}

async function run(args = {}) {
  const text = args.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('请提供 text（要转换的源文本）。');
  }
  const to = args.to;
  if (!to) throw new Error(`请提供 to（目标格式）。可选：${OUT_FORMATS.join(' / ')}`);
  if (!OUT_FORMATS.includes(to)) {
    throw new Error(`to 只能是 ${OUT_FORMATS.join(' / ')}，收到 ${JSON.stringify(to)}`);
  }

  const parse = require('./jsonx-parse');
  const from = args.from || 'auto';
  if (!IN_FORMATS.includes(from)) {
    throw new Error(`from 只能是 ${IN_FORMATS.join(' / ')}，收到 ${JSON.stringify(args.from)}`);
  }

  // ---- 读入 ----
  const detected = from === 'auto' ? parse.detectFormat(text) : { format: from, confidence: 1, reason: '用户指定' };
  let inFormat = detected.format;

  let value;
  let inWarnings = [];
  let inColumns = null;

  if (inFormat === 'csv' || inFormat === 'tsv') {
    const r = parse.parseTabular(text, { ...args, format: inFormat });
    value = r.records;
    inWarnings = r.warnings;
    inColumns = r.columnNames;   // 这里只要列名，用 columnNames（columns 是对象数组）
  } else {
    const r = parse.parseJsonish(text, inFormat);
    value = r.value;
    inWarnings = r.warnings;
  }

  // arrayPath：从对象里挑出记录数组
  if (args.arrayPath) {
    const JP = require('../utils/jsonpath.js');
    const q = JP.query(value, args.arrayPath);
    if (q.count === 0) {
      throw new Error(`arrayPath="${args.arrayPath}" 没有匹配到任何数据。请先用 jsonx_query 确认路径。`);
    }
    value = q.matches[0].value;
  }

  // ---- 输出 ----
  let out, outMeta = {};
  const maxRows = args.maxRows || 5000;

  if (to === 'json') {
    const indent = args.indent === undefined ? (args.pretty === false ? 0 : 2) : args.indent;
    let v = value;
    if (args.sortKeys) v = sortDeep(v);
    out = JSON.stringify(v, jsonReplacer, indent || undefined);
    if (indent === 0) out = JSON.stringify(v, jsonReplacer);
  } else if (to === 'yaml') {
    const Y = require('../utils/yaml.js');
    out = Y.stringifyYaml(value, { indent: args.indent || 2, sortKeys: !!args.sortKeys });
  } else if (to === 'csv' || to === 'tsv') {
    const CV = require('../utils/csv.js');
    const tbl = toTable(value, args);
    if (tbl.rows.length > maxRows) {
      outMeta.truncated = tbl.rows.length - maxRows;
      tbl.rows = tbl.rows.slice(0, maxRows);
    }
    const delim = args.outDelimiter || (to === 'tsv' ? '\t' : ',');
    out = CV.stringifyCsv(tbl.rows, { delimiter: delim, header: tbl.header, eol: args.eol || '\n' });
  } else {
    const tbl = toTable(value, args);
    if (tbl.rows.length > maxRows) { outMeta.truncated = tbl.rows.length - maxRows; tbl.rows = tbl.rows.slice(0, maxRows); }
    out = renderMarkdown(tbl.header, tbl.rows);
  }

  // 往返校验：结构转换最容易在这里悄悄丢数据，所以转完立刻验一次
  let roundTrip = null;
  if (to === 'yaml' || to === 'json') {
    try {
      const Y = require('../utils/yaml.js');
      const reprocessed = to === 'yaml' ? Y.parseYamlSingle(out).value : JSON.parse(out);
      const D = require('../utils/diff.js');
      // 只比结构，不比 undefined 与函数（JSON 表达不了它们）
      const norm = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
      const d = D.diff(norm(value), norm(reprocessed), { maxChanges: 3 });
      roundTrip = { ok: d.equal, sampleChanges: d.changes };
    } catch (e) {
      roundTrip = { ok: false, error: e.message };
    }
  }

  const L = [];
  L.push(`▸ ${inFormat.toUpperCase()} → ${to.toUpperCase()}` +
    (from === 'auto' ? `（源格式自动识别：${detected.reason}）` : ''));
  if (inColumns) L.push(`  源列：${inColumns.join(', ')}`);
  if (outMeta.truncated) L.push(`  ⚠ 已截断 ${outMeta.truncated} 行（maxRows=${maxRows}）`);
  if (roundTrip) {
    L.push(roundTrip.ok
      ? '  ✓ 往返校验通过（转换无信息丢失）'
      : `  ⚠ 往返校验有差异${roundTrip.error ? '：' + roundTrip.error : '（见结构化结果）'}`);
  }
  L.push('');
  L.push('```' + (to === 'markdown' ? '' : to));
  L.push(F.clip(out, 20000, `输出超过 20000 字符已截断；完整内容见结构化结果，或缩小范围后重试`));
  L.push('```');
  if (inWarnings.length) {
    L.push('');
    L.push('■ 源解析提示');
    inWarnings.slice(0, 5).forEach(w => L.push('  · ' + w));
  }

  return {
    _text: L.join('\n'),
    from: inFormat,
    to,
    output: out,
    outputLength: out.length,
    truncated: outMeta.truncated || 0,
    roundTrip,
    warnings: inWarnings
  };
}

/** JSON.stringify 的 replacer：BigInt 与 undefined 都能安全输出 */
function jsonReplacer(key, val) {
  if (typeof val === 'bigint') return String(val);
  return val;
}

/** 递归按键排序（不改变原值） */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

module.exports = {
  name: 'jsonx_convert',
  title: '格式互转（JSON / YAML / CSV / TSV / Markdown）',
  description:
    '在 JSON / YAML / CSV / TSV / Markdown 表格之间双向转换，转换后自动做往返校验并报告是否丢失信息。' +
    '嵌套对象转 CSV 时会明确报错并给出三种压平策略（flatten=json/dot），不会静默丢数据。',
  inputSchema,
  run,
  toTable,
  sortDeep
};
