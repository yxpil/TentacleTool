'use strict';
/**
 * kb_schema —— 查看表结构（列、类型、注释、主键、外键、索引）
 *
 * 这是让 Agent"读懂业务语义"的关键工具：
 * 真实库里的表注释/列注释就是人写的业务说明，
 * 有了这些，Agent 才能把"用户手机号"映射到 sys_user.phone。
 */

const rt = require('../kb/runtime');
const fmt = require('./format');

const name = 'kb_schema';
const title = 'Describe table schema';
const description =
  '查看知识库中表的结构：列名、类型、是否可空、默认值、注释、主键、外键、索引。' +
  '注释（comment）尤其重要——它通常写着业务含义，用来把自然语言问题对应到具体列。' +
  '不传 table 时列出该知识库所有表的概览；传 table 给单表详情；' +
  '也支持不传 knowledgeBase 直接按 database+table 查任意表。';

const inputSchema = {
  type: 'object',
  properties: {
    knowledgeBase: {
      type: 'string',
      description: '知识库名。与 table 组合使用；不传 table 时列出该库全部表'
    },
    table: {
      type: 'string',
      description: '表名，支持 "表名" 或 "库名.表名"'
    },
    database: {
      type: 'string',
      description: '库名（当 table 里没带库名时使用）'
    },
    source: {
      type: 'string',
      description: '数据源名（默认取知识库指定的源，或第一个源）'
    },
    filter: {
      type: 'string',
      description: '只显示名称/注释匹配该关键词的表或列（大小写不敏感）'
    },
    refresh: {
      type: 'boolean',
      description: '跳过 schema 缓存强制重新读取，默认 false',
      default: false
    },
    showIndexes: {
      type: 'boolean',
      description: '单表详情里是否显示索引列表，默认 true',
      default: true
    }
  },
  additionalProperties: false
};

/** 把 "db.table" 拆开 */
function splitQualified(tableArg, databaseArg) {
  if (!tableArg) return { database: databaseArg, table: null };
  const t = String(tableArg).trim();
  // 用反引号或点分隔都支持
  const cleaned = t.replace(/`/g, '');
  const dot = cleaned.indexOf('.');
  if (dot > 0) return { database: cleaned.slice(0, dot), table: cleaned.slice(dot + 1) };
  return { database: databaseArg, table: cleaned };
}

async function listTablesOfKb(s, kb, filter, refresh) {
  const sections = [];
  const out = [];

  for (const t of kb.tables) {
    const database = t.database || s.config.sources[t.source].database;
    if (!database) {
      sections.push(`⚠️ 表 ${t.table} 未指定 database，跳过（请在配置里补 database）`);
      continue;
    }
    let desc;
    try {
      desc = await s.schema.describeTable(t.source, database, t.table, refresh);
    } catch (e) {
      sections.push(`❌ ${database}.${t.table} 读取失败：${e.message}`);
      continue;
    }
    const kw = filter ? String(filter).toLowerCase() : null;
    if (kw) {
      const hit = t.table.toLowerCase().includes(kw) ||
        String(desc.meta && desc.meta.comment || '').toLowerCase().includes(kw) ||
        desc.columns.some(c => c.name.toLowerCase().includes(kw) || String(c.comment).toLowerCase().includes(kw));
      if (!hit) continue;
    }

    out.push({
      database, table: t.table,
      comment: (desc.meta && desc.meta.comment) || t.description || '',
      rows: desc.meta ? desc.meta.rowEstimate : null,
      columns: desc.columnCount,
      primaryKey: desc.primaryKey
    });
  }

  return { out, sections };
}

async function run(args = {}) {
  const s = rt.require();
  const refresh = !!args.refresh;

  /* ---------- 单表详情 ---------- */
  if (args.table) {
    const { database, table } = splitQualified(args.table, args.database);

    // 决定用哪个 source：显式指定 > 知识库里该表所属的源 > 第一个源
    let sourceName = args.source;
    let resolvedDb = database || null;
    if (!sourceName && args.knowledgeBase) {
      const kb = s.config.knowledgeBases[args.knowledgeBase];
      if (!kb) {
        return { error: 'knowledge base not found', _text: `未找到知识库 "${args.knowledgeBase}"。` };
      }
      const entry = kb.tables.find(t => t.table === table && (!database || !t.database || t.database === database));
      if (entry) {
        sourceName = entry.source;
        resolvedDb = resolvedDb || entry.database || s.config.sources[entry.source].database;
      } else {
        // 知识库里没配这张表：如果源上有默认库，仍然允许直接查（更宽容）
        sourceName = kb.source || kb.tables[0] && kb.tables[0].source;
      }
    }
    if (!sourceName) sourceName = Object.keys(s.config.sources)[0];
    if (!resolvedDb) resolvedDb = s.config.sources[sourceName] && s.config.sources[sourceName].database;

    if (!resolvedDb) {
      return {
        error: 'database not specified',
        _text: `无法确定表 "${table}" 属于哪个库。请用 "库名.表名" 的写法，或传 database 参数。`
      };
    }

    let desc;
    try {
      desc = await s.schema.describeTable(sourceName, resolvedDb, table, refresh);
    } catch (e) {
      if (e.code === 1146 || /doesn't exist|not exist/i.test(e.message)) {
        return {
          error: 'table not found',
          _text: `表 "${resolvedDb}.${table}" 不存在（数据源 ${sourceName}）。\n` +
            `用 kb_schema(knowledgeBase="...") 列出可用表，或 kb_query 执行 SHOW TABLES FROM \`${resolvedDb}\`。`
        };
      }
      throw e;
    }

    const full = `${resolvedDb}.${table}`;
    let text = `表 ${full}  [数据源 ${sourceName}]`;

    if (desc.meta) {
      text += '\n' + fmt.kv([
        ['说明', desc.meta.comment || '(无表注释)'],
        ['引擎', desc.meta.engine],
        ['行数估计', desc.meta.rowEstimate],
        ['排序规则', desc.meta.collation],
        ['更新时间', desc.meta.updateTime]
      ]);
    }

    text += fmt.section(`列（${desc.columnCount}）`);
    const rows = desc.columns.map(c => [
      c.name,
      c.fullType,
      c.nullable ? 'YES' : 'NO',
      c.default === null || c.default === undefined ? '' : String(c.default),
      (c.key || '') + (/auto_increment/i.test(c.extra) ? ' AUTO' : ''),
      c.comment || ''
    ]);
    text += '\n' + fmt.table(['列', '类型', '可空', '默认', '键', '注释'], rows, { colMax: 34 });

    if (desc.primaryKey.length) {
      text += fmt.section('主键') + '\n  ' + desc.primaryKey.join(', ');
    }

    if (desc.foreignKeys.length) {
      text += fmt.section('外键');
      text += '\n' + fmt.list(desc.foreignKeys.map(f =>
        `${f.columns.join(', ')} → ${f.refDatabase}.${f.refTable}(${f.refColumns.join(', ')})  [${f.name}]`
      ));
    }

    if (args.showIndexes !== false && desc.indexes.length) {
      text += fmt.section('索引');
      text += '\n' + fmt.list(desc.indexes.map(i =>
        `${i.name}(${i.columns.join(', ')})${i.unique ? ' UNIQUE' : ''}${/PRIMARY/i.test(i.name) ? ' [主键]' : ''}`
      ));
    }

    // 把每个列的注释也放进结构化输出，方便 Agent 程序化使用
    text += `\n\n下一步：kb_query(sql="SELECT * FROM \`${resolvedDb}\`.\`${table}\` LIMIT 5") 看样本数据；` +
      `kb_search(query="关键词", knowledgeBase="...") 搜内容。`;

    return {
      source: sourceName,
      database: resolvedDb,
      table,
      comment: (desc.meta && desc.meta.comment) || '',
      rowEstimate: desc.meta ? desc.meta.rowEstimate : null,
      primaryKey: desc.primaryKey,
      columns: desc.columns.map(c => ({
        name: c.name, type: c.fullType, nullable: c.nullable,
        default: c.default, key: c.key, comment: c.comment
      })),
      foreignKeys: desc.foreignKeys,
      indexes: desc.indexes,
      _text: text
    };
  }

  /* ---------- 多表概览 ---------- */
  const kbName = args.knowledgeBase;
  const kbs = kbName
    ? Object.keys(s.config.knowledgeBases).filter(k => k === kbName)
    : Object.keys(s.config.knowledgeBases);

  if (kbs.length === 0) {
    return {
      error: 'knowledge base not found',
      _text: `未找到知识库 "${kbName}"。可用的有：\n  ` +
        Object.keys(s.config.knowledgeBases).join('\n  ')
    };
  }

  let text = '';
  const allTables = [];
  const problems = [];

  for (const k of kbs) {
    const kb = s.config.knowledgeBases[k];
    text += fmt.section(`知识库「${k}」` + (kb.description ? ` — ${kb.description}` : ''));

    if (!kb.tables.length) {
      text += '\n（该知识库为整库模式，请在配置里显式列出表，或直接用 kb_query 查询）';
      continue;
    }

    const { out, sections } = await listTablesOfKb(s, kb, args.filter, refresh);
    problems.push(...sections);

    if (out.length === 0) {
      text += '\n（没有匹配的表' + (args.filter ? `（filter="${args.filter}"）` : '') + '）';
      continue;
    }

    text += '\n' + fmt.table(
      ['表', '说明', '列数', '行数估计', '主键'],
      out.map(o => [
        (o.database ? o.database + '.' : '') + o.table,
        o.comment || '',
        o.columns,
        o.rows === null ? '' : o.rows,
        o.primaryKey.join(',') || '(无)'
      ]),
      { colMax: 40 }
    );

    allTables.push(...out.map(o => ({
      knowledgeBase: k, database: o.database, table: o.table,
      comment: o.comment, columns: o.columns,
      rowEstimate: o.rows, primaryKey: o.primaryKey
    })));
  }

  if (problems.length) {
    text += fmt.section('问题');
    text += '\n' + problems.join('\n');
  }

  text += `\n\n共 ${allTables.length} 张表。下一步：` +
    'kb_schema(table="表名") 看单表结构；kb_search(query="关键词") 搜内容；kb_query 跑 SQL。';

  return { knowledgeBases: kbs, tables: allTables, tableCount: allTables.length, _text: text };
}

module.exports = { name, title, description, inputSchema, run };
