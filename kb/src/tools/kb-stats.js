'use strict';
/**
 * kb_stats —— 知识库概览
 *
 * 回答"这个知识库有多大、有哪些表、哪些表是空的、哪些列全是 NULL"，
 * 让 Agent 在写查询前对数据体量有预期，避免把空表当有数据。
 */

const rt = require('../kb/runtime');
const { SchemaCache } = require('../kb/schema');
const fmt = require('./format');

const name = 'kb_stats';
const title = 'Knowledge base overview';
const description =
  '给出知识库的整体概览：每张表的行数、列数、主键、是否有注释、文本列数量（决定能否被 kb_search 搜到）。' +
  '还可用 countRows=true 实际 COUNT 精确行数（比 information_schema 的估计值准，但会扫表，表大时较慢）。' +
  '适合在写查询前快速了解数据规模与结构完整度。';

const inputSchema = {
  type: 'object',
  properties: {
    knowledgeBase: {
      type: 'string',
      description: '只看某个知识库，默认全部'
    },
    countRows: {
      type: 'boolean',
      description: '实际执行 COUNT(*) 获取精确行数（默认 false，用 information_schema 的估计值）',
      default: false
    },
    refresh: {
      type: 'boolean',
      description: '跳过 schema 缓存，默认 false',
      default: false
    }
  },
  additionalProperties: false
};

async function run(args = {}) {
  const s = rt.require();
  const refresh = !!args.refresh;

  const kbNames = args.knowledgeBase
    ? Object.keys(s.config.knowledgeBases).filter(k => k === args.knowledgeBase)
    : Object.keys(s.config.knowledgeBases);

  if (kbNames.length === 0) {
    return {
      error: 'knowledge base not found',
      _text: `未找到知识库 "${args.knowledgeBase}"。可用的有：\n  ` +
        Object.keys(s.config.knowledgeBases).join('\n  ')
    };
  }

  const rows = [];
  const problems = [];
  let totalTables = 0, totalColumns = 0, searchableTables = 0;
  let uncommentedTables = 0, emptyTables = 0;

  for (const k of kbNames) {
    const kb = s.config.knowledgeBases[k];
    for (const t of kb.tables) {
      const database = t.database || (s.config.sources[t.source] && s.config.sources[t.source].database);
      if (!database) {
        problems.push(`${k}/${t.table}: 未指定 database`);
        continue;
      }
      let desc;
      try {
        desc = await s.schema.describeTable(t.source, database, t.table, refresh);
      } catch (e) {
        problems.push(`${database}.${t.table}: ${e.message}`);
        continue;
      }

      totalTables++;
      totalColumns += desc.columnCount;
      const textCols = SchemaCache.textColumnsOf(desc);
      const searchable = textCols.length > 0 && (!t.columns || t.columns.length > 0);
      if (searchable) searchableTables++;
      const comment = (desc.meta && desc.meta.comment) || t.description || '';
      if (!comment) uncommentedTables++;

      let rowCount = desc.meta ? desc.meta.rowEstimate : null;
      let exact = false;
      if (args.countRows) {
        try {
          const r = await s.pools.query(t.source,
            `SELECT COUNT(*) AS c FROM \`${database}\`.\`${t.table}\`` + (t.where ? ` WHERE ${t.where}` : ''),
            { maxRows: 1 });
          rowCount = r.rows[0] ? Number(r.rows[0].c) : null;
          exact = true;
        } catch (e) {
          problems.push(`${database}.${t.table} COUNT 失败: ${e.message}`);
        }
      }
      if (rowCount === 0) emptyTables++;

      rows.push([
        k,
        `${database}.${t.table}`,
        rowCount === null ? '?' : rowCount + (exact ? '' : '~'),
        desc.columnCount,
        textCols.length,
        desc.primaryKey.join(',') || '(无)',
        comment || '⚠️ 无注释',
        desc.foreignKeys.length || '',
        t.where ? '有' : ''
      ]);
    }
  }

  /* ---------- 渲染 ---------- */
  let text = `知识库概览`;
  if (args.countRows) text += `（精确 COUNT）`;
  text += `\n\n■ 汇总`;
  text += '\n' + fmt.kv([
    ['知识库数', kbNames.length],
    ['表白数', totalTables],
    ['列总数', totalColumns],
    ['可搜索的表（有文本列）', `${searchableTables}/${totalTables}`],
    ['无注释的表', uncommentedTables],
    ['行数为 0 的表', emptyTables]
  ]);

  text += `\n\n■ 明细`;
  text += '\n' + fmt.table(
    ['知识库', '表', '行数', '列数', '文本列', '主键', '表注释', '外键', '过滤'],
    rows,
    { colMax: 40, totalMax: s.config.limits.maxTotalChars || 24000 }
  );

  text += `\n\n注：行数是 ${args.countRows ? '精确值' : 'INFORMATION_SCHEMA 的估计值（带 ~，大表可能偏差较大，可用 countRows=true 取精确值）'}`;

  if (uncommentedTables > 0) {
    text += `\n⚠️ 有 ${uncommentedTables} 张表没有注释，Agent 难以判断其业务含义。` +
      `建议在数据库里用 ALTER TABLE ... COMMENT '说明' 补上，或在知识库配置里给表加 description。`;
  }
  if (emptyTables > 0) {
    text += `\n⚠️ 有 ${emptyTables} 张表当前行数为 0，查询它们会返回空结果，注意区分"没有数据"与"查错了"。`;
  }
  if (problems.length) {
    text += `\n\n■ 问题\n  ` + problems.join('\n  ');
  }

  text += '\n\n下一步：kb_schema(knowledgeBase="...") 看结构；kb_search(query="...") 搜内容。';

  return {
    knowledgeBases: kbNames,
    tableCount: totalTables,
    columnCount: totalColumns,
    searchableTables,
    uncommentedTables,
    emptyTables,
    exactRowCounts: !!args.countRows,
    tables: rows.map(r => ({
      knowledgeBase: r[0], table: r[1], rows: r[2], columns: r[3],
      textColumns: r[4], primaryKey: r[5], comment: r[6]
    })),
    problems: problems.length ? problems : undefined,
    _text: fmt.clip(text, s.config.limits.maxTotalChars || 24000)
  };
}

module.exports = { name, title, description, inputSchema, run };
