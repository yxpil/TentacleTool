'use strict';
/**
 * jsonx_schema —— 结构推断
 *
 * 给一份数据，回答"它长什么样"：字段名、类型、可空性、枚举候选、嵌套结构。
 * 这是模型在拿到陌生数据时最该先调用的工具。
 */

const F = require('./format');

const inputSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '源文本（JSON / YAML / CSV / TSV，自动识别）' },
    format: { type: 'string', enum: ['auto', 'json', 'yaml', 'csv', 'tsv'], description: '源格式，默认 auto' },
    delimiter: { type: 'string', description: 'CSV 分隔符' },
    header: { type: 'boolean', description: 'CSV 首行是否表头，默认 true' },
    infer: { type: 'boolean', description: 'CSV 是否类型推断，默认 true' },
    inferDates: { type: 'boolean', description: '是否把日期识别为 date 类型，默认 false' },
    enumMaxCardinality: {
      type: 'integer',
      description: '字符串列的枚举候选上限：基数不超过该值时才给 enum 列表（默认 10，设 0 关闭）'
    },
    maxDepth: { type: 'integer', description: '递归推断的最大深度，默认 6' },
    sampleLimit: { type: 'integer', description: '数组采样元素数，默认 200' }
  },
  required: ['text']
};

async function run(args = {}) {
  const text = args.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('请提供 text（源文本）。');
  }

  const parse = require('./jsonx-parse');
  const INF = require('../utils/infer.js');

  const from = args.format || 'auto';
  const detected = from === 'auto' ? parse.detectFormat(text) : { format: from, confidence: 1, reason: '用户指定' };

  const enumMax = args.enumMaxCardinality === undefined ? 10 : Math.max(0, parseInt(args.enumMaxCardinality, 10) || 0);
  const schemaOpts = {
    maxDepth: Math.min(Math.max(parseInt(args.maxDepth, 10) || 6, 1), 20),
    sampleLimit: Math.min(Math.max(parseInt(args.sampleLimit, 10) || 200, 1), 5000),
    ...(enumMax > 0 ? { enumMaxCardinality: enumMax } : {})
  };

  let value, csvInfo = null, warnings = [];

  if (detected.format === 'csv' || detected.format === 'tsv') {
    const r = parse.parseTabular(text, { ...args, format: detected.format });
    value = r.records;
    csvInfo = { meta: r.meta, columns: r.columnNames, schema: r.schema };
    warnings = r.warnings;
  } else {
    const r = parse.parseJsonish(text, detected.format);
    value = r.value;
    warnings = r.warnings;
  }

  const result = INF.inferJsonSchema(value, schemaOpts);

  const L = [];
  L.push(`▸ ${detected.format.toUpperCase()} 结构推断${from === 'auto' ? `（自动识别：${detected.reason}）` : ''}`);
  L.push('');

  // ---- 表格数据：走列视角 ----
  if (csvInfo) {
    L.push('■ 总体');
    L.push(F.kv([
      ['形状', F.describeTabular(csvInfo.meta)],
      ['列', csvInfo.columns.join(', ')],
      ['分隔符', csvInfo.meta.delimiterLabel]
    ]));
    L.push('');
    L.push('■ 列定义');
    L.push(F.table(
      ['列', '类型', '可空', '空值', '样例'],
      csvInfo.schema.columns.map(c => [
        c.name, c.type, c.nullable ? '是' : '否', c.nullCount, (c.sample || []).join(', ')
      ])
    ));
    const notes = csvInfo.schema.columns.filter(c => c.note || c.forcedString);
    if (notes.length) {
      L.push('');
      L.push('■ 推断备注');
      notes.forEach(c => {
        if (c.note === 'mixed-types') L.push(`  · ${c.name}：列内类型不一致，已整体退回字符串（避免部分行变数字导致下游出错）`);
        if (c.forcedString) L.push(`  · ${c.name}：有 ${c.forcedString} 个值超出安全整数范围或无法转换，已保留字符串`);
      });
    }
  } else {
    // ---- JSON/YAML：走嵌套结构 ----
    L.push('■ 总体');
    L.push(F.kv([
      ['顶层类型', F.typeName(value)],
      ['规模', F.describeSize(value)]
    ]));
    L.push('');

    if (result.records) {
      L.push('■ 这是一个记录集');
      L.push(F.kv([
        ['记录数', result.records.rowCount],
        ['字段数', result.records.totalFields],
        ...(result.records.optionalFields.length ? [['可选字段（部分记录缺失）', result.records.optionalFields.join(', ')]] : [])
      ]));
      L.push('');
      L.push('■ 字段定义');
      L.push(F.table(
        ['字段', '类型', '可选', '枚举候选'],
        Object.entries(result.records.fields).map(([k, v]) => [
          k,
          INF.shortType(v),
          result.records.optionalFields.includes(k) ? '是' : '否',
          v.enum ? v.enum.slice(0, 6).join(' / ') + (v.enum.length > 6 ? ' …' : '') : ''
        ])
      ));
    } else if (Array.isArray(value)) {
      L.push(`■ 这是一个数组：${value.length} 个元素`);
      L.push(F.kv([
        ['元素类型', INF.shortType(result.schema.items || {})],
        ...(result.schema.items && result.schema.items.enum ? [['枚举候选', result.schema.items.enum.slice(0, 10).join(' / ')]] : [])
      ]));
    } else if (value !== null && typeof value === 'object') {
      L.push('■ 顶级字段');
      L.push(F.table(
        ['字段', '类型'],
        Object.entries(result.schema.properties || {}).map(([k, v]) => [k, INF.shortType(v)])
      ));
      // 展开一层看嵌套
      const nested = Object.entries(result.schema.properties || {}).filter(([, v]) => v.type === 'object' && v.properties);
      if (nested.length) {
        L.push('');
        L.push('■ 嵌套对象');
        for (const [k, v] of nested.slice(0, 5)) {
          L.push(`  ${k}:`);
          L.push(F.table(
            ['  · 字段', '类型'],
            Object.entries(v.properties).map(([k2, v2]) => ['  · ' + k2, INF.shortType(v2)])
          ));
        }
        if (nested.length > 5) L.push(`  …另有 ${nested.length - 5} 个嵌套对象`);
      }
    } else {
      L.push(`■ 标量值：${F.cell(value, 200)}`);
    }
  }

  if (warnings.length) {
    L.push('');
    L.push('■ 提示');
    warnings.slice(0, 6).forEach(w => L.push('  · ' + w));
  }

  L.push('');
  L.push('■ 下一步');
  L.push('  · 取值：jsonx_query(path="$.字段名")');
  L.push('  · 转格式：jsonx_convert(to="csv")');
  L.push('  · 统计：jsonx_aggregate()');

  return {
    _text: L.join('\n'),
    format: detected.format,
    schema: result.schema,
    records: result.records,
    ...(csvInfo ? { columns: csvInfo.columns, columnSchema: csvInfo.schema, meta: csvInfo.meta } : {}),
    warnings
  };
}

module.exports = {
  name: 'jsonx_schema',
  title: '结构推断（字段/类型/可空性/枚举）',
  description:
    '推断 JSON/YAML/CSV 数据的结构：字段名、类型、是否可空、枚举候选值、嵌套层级。' +
    '拿到陌生数据时先调这个，能避免盲猜字段名。对 CSV 会给出每列的推断类型，' +
    '并明确标注"列内类型不一致已退回字符串"这类保守处理。',
  inputSchema,
  run
};
