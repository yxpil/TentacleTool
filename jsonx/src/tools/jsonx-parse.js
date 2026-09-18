'use strict';
/**
 * jsonx_parse —— 把任意文本格式解析成数据
 *
 * 这是 jsonx 的"入口工具"：先 parse 拿到数据，再用其他工具查询/转换/比较。
 * 自动识别 JSON / YAML / CSV / TSV，也允许强制指定格式。
 */

const F = require('./format');

const FORMATS = ['auto', 'json', 'yaml', 'csv', 'tsv'];

const inputSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: '要解析的文本内容（JSON / YAML / CSV / TSV）'
    },
    format: {
      type: 'string',
      enum: FORMATS,
      description: '输入格式。默认 auto 自动识别：先试 JSON，再试 YAML，最后按 CSV（含分隔符嗅探）'
    },
    delimiter: {
      type: 'string',
      description: '当 format=csv 时的列分隔符，可用别名 comma / semicolon / tab / pipe，或单个字符。不传则自动嗅探'
    },
    header: {
      type: 'boolean',
      description: 'CSV 是否把首行当表头。默认 true（把首行当列名）；设为 false 则列名生成 col1、col2…'
    },
    infer: {
      type: 'boolean',
      description: 'CSV 是否做类型推断（把 "42" 变数字、空字段变 null）。默认 true。设为 false 则整表都是字符串'
    },
    inferDates: {
      type: 'boolean',
      description: '是否把 2026-09-18 这类日期识别成 date 类型。默认 false（保留字符串，避免下游字符串比较被破坏）'
    },
    maxRows: {
      type: 'integer',
      description: '最多解析多少数据行，超出截断（防上下文爆炸）。默认 1000'
    },
    preview: {
      type: 'integer',
      description: '结果预览展示多少条记录，默认 5，最大 50'
    }
  },
  required: ['text']
};

/** 用最少的工作判断这段文本像什么 */
function detectFormat(text, opts = {}) {
  const t = String(text).trim();
  if (t === '') throw new Error('输入文本为空，无法解析。请提供 JSON / YAML / CSV / TSV 内容。');

  // CSV 的分隔符嗅探结果很可靠，优先用它的置信度判断
  const CSV = require('../utils/csv');
  const sniff = CSV.sniffDelimiter(t);

  // JSON：以 { [ " 开头，或整体是合法标量
  if (/^[{[]/.test(t)) {
    try { JSON.parse(t); return { format: 'json', confidence: 1, reason: '以 { 或 [ 开头且 JSON.parse 成功' }; }
    catch (e) { /* 落到下面继续试 */ }
  }

  // YAML 优先于 CSV：YAML 的 `key: value` 不会被误判成 CSV（冒号不是默认分隔符），
  // 但含冒号的 YAML 若先按 CSV 解析会产生一堆单列行，所以顺序很重要。
  //
  // ★ 关键约束：只让 YAML **集合**（映射/序列）取得优先权。
  // 踩过的坑：`a\n1\n2`（无冒号无横杠的多行文本）是合法的 YAML **标量**文档，
  // YAML 会只取第一行、静默丢掉其余行 —— 而这恰恰是最常见的单列 CSV 形状。
  // 因此标量 YAML 不参与"优先于 CSV"的竞争，交给后面按行/分隔符判。
  let yamlCollection = null;
  try {
    const Y = require('../utils/yaml');
    const { documents } = Y.parseYaml(t);
    const v = documents[0];
    if (documents.length >= 1 && v !== null && typeof v === 'object') {
      yamlCollection = v;
    }
  } catch (e) { /* 不是 YAML */ }

  if (yamlCollection !== null) {
    return { format: 'yaml', confidence: 0.9, reason: 'YAML 解析成功且顶层是集合' };
  }

  if (sniff.delimiter && sniff.confidence >= 0.6 && sniff.detectedColumns > 1) {
    const isTab = sniff.delimiter === '\t';
    return {
      format: isTab ? 'tsv' : 'csv',
      confidence: sniff.confidence,
      reason: sniff.reason
    };
  }

  // 多行纯文本：优先当 CSV（哪怕只有一列）。单行才算 YAML 标量。
  const nonEmptyLines = t.split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
  if (nonEmptyLines.length > 1) {
    const isTab = (sniff.delimiter === '\t');
    return {
      format: isTab ? 'tsv' : 'csv',
      confidence: Math.max(sniff.confidence || 0, 0.5),
      reason: nonEmptyLines.length > 1 && (!sniff.detectedColumns || sniff.detectedColumns <= 1)
        ? `多行文本且无 YAML 集合特征，按单列 CSV 处理（${nonEmptyLines.length} 行）`
        : sniff.reason
    };
  }

  // 退回 JSON 标量
  try { JSON.parse(t); return { format: 'json', confidence: 0.8, reason: 'JSON 标量' }; } catch (e) { /* ignore */ }

  // 单行标量：YAML 什么都接受，所以这里只作为"最后兜底"，
  // 并且**明确告知这是一段纯文本标量**，避免用户以为解析出了一个结构。
  try {
    const Y = require('../utils/yaml');
    Y.parseYaml(t);
    return {
      format: 'yaml',
      confidence: 0.3,
      scalar: true,
      reason: '仅是一段纯文本标量（无结构特征）；若本意是表格请用 format="csv"'
    };
  } catch (e) { /* ignore */ }

  if (sniff.detectedColumns > 1) {
    return { format: 'csv', confidence: sniff.confidence || 0.4, reason: sniff.reason };
  }

  throw new Error(
    '无法识别输入格式。已尝试 JSON / YAML / CSV / TSV 均失败。\n' +
    '请用 format 参数显式指定格式，例如 format="csv" 并配合 delimiter。'
  );
}

/** 解析 CSV/TSV → { records, schema, columns, columnNames } */
function parseTabular(text, opts) {
  const CSV = require('../utils/csv');
  const INF = require('../utils/infer');
  const delimiter = opts.delimiter || (opts.format === 'tsv' ? '\t' : undefined);

  const useHeader = opts.header !== false;
  const parsed = CSV.parseCsv(text, {
    delimiter,
    header: useHeader,
    maxRows: opts.maxRows || 1000
  });

  const headerNames = useHeader
    ? parsed.header
    : Array.from({ length: parsed.meta.columns }, (_, i) => `col${i + 1}`);

  const inferred = INF.inferTable(parsed.rows, {
    header: headerNames,
    infer: opts.infer !== false,
    inferDates: !!opts.inferDates
  });

  // ★ 结构化结果里同时存在 `columns` 与 `schema.columns` 是设计陷阱：
  // 同名不同形（一个是字符串数组、一个是对象数组），调用方先看到哪个就按哪个写，
  // 拿到字符串数组的一方去取 c.type 会得到 undefined 而不是报错 —— 又是一次静默失败。
  // 所以统一成一种形状：columns 就是对象数组（与 schema.columns 完全一致），
  // 只要名字的场景交给单列的 columnNames。
  return {
    records: inferred.records,
    schema: inferred.schema,
    columns: inferred.schema.columns,
    columnNames: inferred.columns,
    meta: parsed.meta,
    warnings: parsed.warnings,
    lineNumbers: parsed.lineNumbers
  };
}
/** 解析 JSON → 保持原样 */
function parseJsonish(text, format) {
  if (format === 'json') {
    try { return { value: JSON.parse(text), warnings: [] }; }
    catch (e) {
      throw new Error(`JSON 解析失败：${e.message}\n（常见原因：尾随逗号、单引号、注释 —— JSON 都不允许。若是这类文本请改用 format="yaml"）`);
    }
  }
  const Y = require('../utils/yaml');
  const { documents, warnings } = Y.parseYaml(text);
  if (documents.length > 1) {
    return { value: documents, warnings: warnings.concat([`该 YAML 含 ${documents.length} 个文档，已作为数组返回`]), multiDoc: true };
  }
  return { value: documents[0], warnings };
}

async function run(args = {}) {
  const text = args.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('请提供 text（要解析的文本内容）。\n例：{"text":"a,b\\n1,2","format":"csv","header":false}');
  }

  const requested = args.format || 'auto';
  if (!FORMATS.includes(requested)) {
    throw new Error(`format 只能是 ${FORMATS.join(' / ')}，收到 ${JSON.stringify(args.format)}`);
  }

  const detected = requested === 'auto' ? detectFormat(text) : { format: requested, confidence: 1, reason: '用户指定' };
  const format = detected.format;

  const previewLimit = Math.min(Math.max(parseInt(args.preview, 10) || 5, 1), 50);

  let value, records = null, schema = null, columns = null, columnNames = null, warnings = [], extraMeta = {};

  if (format === 'csv' || format === 'tsv') {
    const r = parseTabular(text, { ...args, format });
    records = r.records;
    schema = r.schema;
    columns = r.columns;          // 对象数组，与 schema.columns 同形
    columnNames = r.columnNames;  // 纯名字数组（列名场景专用）
    warnings = r.warnings;
    extraMeta = r.meta;
    value = records;
  } else {
    const r = parseJsonish(text, format);
    value = r.value;
    warnings = r.warnings;
    if (r.multiDoc) extraMeta.multiDoc = true;
  }

  // ---- 组装文本输出 ----
  const L = [];
  L.push(`▸ 已解析为 ${format.toUpperCase()}${requested === 'auto' ? `（自动识别：${detected.reason}）` : '（用户指定）'}`);
  L.push('');
  L.push(`■ 总体`);
  L.push(F.kv([
    ['顶层类型', F.typeName(value)],
    ...(format === 'csv' || format === 'tsv' ? [
      ['形状', F.describeTabular(extraMeta)],
      ['分隔符', extraMeta.delimiterLabel],
      ['列名', (columnNames || []).join(', ')]
    ] : [
      ['规模', F.describeSize(value)]
    ])
  ]));

  if (schema && schema.columns && schema.columns.length) {
    L.push('');
    L.push('■ 列类型');
    L.push(F.table(
      ['列', '类型', '可空', '空值数', '样例'],
      schema.columns.map(c => [c.name, c.type, c.nullable ? '是' : '否', c.nullCount, (c.sample || []).join(', ')])
    ));
  } else if (format === 'json' || format === 'yaml') {
    const INF = require('../utils/infer');
    if (value !== null && typeof value === 'object') {
      const js = INF.inferJsonSchema(value);
      L.push('');
      L.push('■ 结构概览');
      if (js.records) {
        L.push(`  记录集：${js.records.rowCount} 条，${js.records.totalFields} 个字段` +
          (js.records.optionalFields.length ? `，可选字段：${js.records.optionalFields.join(', ')}` : ''));
        L.push(F.table(
          ['字段', '类型'],
          Object.entries(js.records.fields).map(([k, v]) => [k, INF.shortType(v)])
        ));
      } else if (Array.isArray(value)) {
        L.push(`  数组：${value.length} 个元素，元素类型 ${INF.shortType(js.schema.items || { type: '?' })}`);
      } else {
        L.push(F.table(
          ['字段', '类型'],
          Object.entries(js.schema.properties || {}).map(([k, v]) => [k, INF.shortType(v)])
        ));
      }
    }
  }

  // ---- 预览 ----
  L.push('');
  L.push(`■ 预览（前 ${previewLimit} 条）`);
  if (Array.isArray(value) && value.length) {
    L.push(F.previewRows(value, previewLimit));
  } else if (Array.isArray(value) && value.length === 0) {
    L.push('  （空数组）');
  } else {
    L.push(F.indentBlock(F.safeStringify(value, 2000), '  '));
  }

  if (warnings.length) {
    L.push('');
    L.push('■ 提示');
    warnings.slice(0, 8).forEach(w => L.push('  · ' + w));
    if (warnings.length > 8) L.push(`  · …另有 ${warnings.length - 8} 条`);
  }

  L.push('');
  L.push('■ 下一步');
  L.push('  · 取值/筛选：jsonx_query(path="$.a.b")');
  L.push('  · 转换格式：jsonx_convert(to="yaml")');
  L.push('  · 看结构：jsonx_schema()');

  return {
    _text: L.join('\n'),
    format,
    detected: requested === 'auto' ? detected : null,
    rowCount: Array.isArray(value) ? value.length : null,
    schema,
    warnings,
    ...(records ? { records } : {}),
    ...(format === 'csv' || format === 'tsv' ? { columns, columnNames, meta: extraMeta } : { value })
  };
}

module.exports = {
  name: 'jsonx_parse',
  title: '解析文本为数据（JSON/YAML/CSV/TSV）',
  description:
    '把 JSON / YAML / CSV / TSV 文本解析成结构化数据，并给出形状、列类型与预览。' +
    'CSV 走完整状态机（正确处理引号内逗号、字段内换行、转义引号 ""），并做保守的类型推断' +
    '（前导零、超长整数一律留字符串）。返回结构化数据供后续工具使用。',
  inputSchema,
  run,
  detectFormat,
  parseTabular,
  parseJsonish
};
