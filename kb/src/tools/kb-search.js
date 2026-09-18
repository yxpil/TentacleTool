'use strict';
/**
 * kb_search —— 跨多张表的内容搜索（知识库的核心用法）
 *
 * 这是"把多张表当作一个知识库"最直接的体现：
 * 用户问一句关键词，工具在所有已配置的表的所有文本列上并行搜索，
 * 把命中片段汇总成一份统一的、带出处的结果列表。
 *
 * 对齐策略：Agent 不知道关键词具体在哪张表哪一列，所以这里做全列扫描；
 * 但每张表用 UNION ALL 合成一条 SQL 而不是逐列发 N 条查询，
 * 既省往返也便于统一排序与限流。
 */

const rt = require('../kb/runtime');
const { SchemaCache } = require('../kb/schema');
const fmt = require('./format');
const logger = require('../utils/logger');

const name = 'kb_search';
const title = 'Search across tables';
const description =
  '在知识库包含的多张表中跨表搜索关键词（对所有文本列做 LIKE 匹配），返回命中片段与出处（库.表.列）。' +
  '适合"这个库里哪里有提到 XXX"这类问题。支持多个关键词（默认 AND/OR 可切换）、' +
  '按知识库或指定表限定范围、分页。命中结果是原文片段，不是全文，请用 kb_query 深挖。';

const inputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '搜索关键词。多个词用空格分隔，默认全部命中才返回（AND）'
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: '多个关键词（数组形式，等价于 query 用空格分隔）'
    },
    mode: {
      type: 'string',
      enum: ['and', 'or'],
      description: '多关键词的匹配方式：and（都要命中，默认）或 or（任一命中）',
      default: 'and'
    },
    knowledgeBase: {
      type: 'string',
      description: '限定知识库。不传则搜索所有知识库'
    },
    tables: {
      type: 'array',
      items: { type: 'string' },
      description: '只搜指定表（"表名" 或 "库.表名"）。与 knowledgeBase 可叠加'
    },
    tablesLimit: {
      type: 'number',
      description: '最多扫描多少张表，默认 20（防止配置了上百张表时过慢）',
      default: 20
    },
    limit: {
      type: 'number',
      description: '返回命中条数上限，默认 30',
      default: 30
    },
    offset: {
      type: 'number',
      description: '翻页偏移，默认 0',
      default: 0
    },
    snippetLen: {
      type: 'number',
      description: '每条命中片段的最大字符数，默认 200。设 0 返回整列值',
      default: 200
    },
    caseSensitive: {
      type: 'boolean',
      description: '是否区分大小写，默认 false',
      default: false
    },
    perTable: {
      type: 'number',
      description: '每张表最多贡献多少条命中，默认 10（避免一张大表占满结果）',
      default: 10
    }
  },
  required: [],
  additionalProperties: false
};

/** LIKE 模式串转义（% _ \ 都要转义） */
function likeEscape(s) {
  return String(s).replace(/([\\%_])/g, '\\$1');
}

/** 给定值和关键词，计算片段（命中词附近上下文） */
function makeSnippet(value, keywords, snippetLen, caseSensitive) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = s.replace(/\r\n/g, '\n').replace(/\n/g, '␤').replace(/\t/g, ' ');
  if (!snippetLen || snippetLen <= 0) return s;
  if (s.length <= snippetLen) return s;

  const hay = caseSensitive ? s : s.toLowerCase();
  let idx = -1;
  for (const kw of keywords) {
    const needle = caseSensitive ? kw : kw.toLowerCase();
    const at = hay.indexOf(needle);
    if (at >= 0 && (idx < 0 || at < idx)) idx = at;
  }
  if (idx < 0) {
    // 没找到（可能是 LIKE 在服务端匹配但这里大小写/编码差异）→ 取开头
    return s.slice(0, snippetLen) + '…';
  }
  // 让命中词大致居中
  const lead = Math.max(0, idx - Math.floor(snippetLen / 3));
  let out = s.slice(lead, lead + snippetLen);
  if (lead > 0) out = '…' + out;
  if (lead + snippetLen < s.length) out = out + '…';
  return out;
}

async function run(args = {}) {
  const s = rt.require();

  /* ---------- 关键词 ---------- */
  let keywords = [];
  if (Array.isArray(args.keywords) && args.keywords.length) {
    keywords = args.keywords.map(k => String(k).trim()).filter(Boolean);
  } else if (args.query) {
    // 支持用引号包住的短语："hello world" foo
    const raw = String(args.query).trim();
    const phraseRe = /"([^"]+)"|'([^']+)'|(\S+)/g;
    let m;
    while ((m = phraseRe.exec(raw)) !== null) {
      const w = m[1] || m[2] || m[3];
      if (w) keywords.push(w);
    }
  }
  if (!keywords.length) {
    return {
      error: 'no keywords',
      _text: '请提供 query 或 keywords 参数。例如 kb_search(query="登录 失败")。'
    };
  }

  const mode = (args.mode === 'or') ? 'or' : 'and';
  const caseSensitive = !!args.caseSensitive;
  const limit = Math.max(1, Number(args.limit) || 30);
  const offset = Math.max(0, Number(args.offset) || 0);
  const snippetLen = args.snippetLen === 0 ? 0 : (Number(args.snippetLen) || 200);
  const perTable = Math.max(1, Number(args.perTable) || 10);
  const tablesLimit = Math.max(1, Number(args.tablesLimit) || 20);

  /* ---------- 收集候选表 ---------- */
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

  // 用户显式指定表 → 解析成 (source, database, table)
  let explicit = null;
  if (Array.isArray(args.tables) && args.tables.length) {
    explicit = args.tables.map(t => {
      const str = String(t).replace(/`/g, '').trim();
      const dot = str.indexOf('.');
      return dot > 0
        ? { database: str.slice(0, dot), table: str.slice(dot + 1) }
        : { database: null, table: str };
    });
  }

  const candidates = [];
  const skipped = [];

  for (const k of kbNames) {
    const kb = s.config.knowledgeBases[k];
    for (const t of kb.tables) {
      const database = t.database || (s.config.sources[t.source] && s.config.sources[t.source].database);
      if (explicit) {
        const match = explicit.some(e =>
          e.table === t.table && (!e.database || e.database === database));
        if (!match) continue;
      }
      if (!database) {
        skipped.push(`跳过 ${t.table}：未指定 database`);
        continue;
      }
      candidates.push({
        knowledgeBase: k, source: t.source, database, table: t.table,
        where: t.where, columns: t.columns, redact: t.redact || kb.redact
      });
    }
  }

  if (candidates.length === 0) {
    return {
      error: 'no tables to search',
      _text: '没有可搜索的表。' +
        (args.tables ? `指定的表 ${args.tables.join(', ')} 不在知识库里；` : '') +
        '用 kb_sources(verbose=true) 查看配置了哪些表。' +
        (skipped.length ? '\n' + skipped.join('\n') : '')
    };
  }

  let toScan = candidates;
  let truncatedTables = 0;
  if (candidates.length > tablesLimit) {
    truncatedTables = candidates.length - tablesLimit;
    toScan = candidates.slice(0, tablesLimit);
  }

  /* ---------- 逐表构造并执行查询 ---------- */
  const hits = [];
  const errors = [];
  let scanned = 0;

  for (const t of toScan) {
    let desc;
    try {
      desc = await s.schema.describeTable(t.source, t.database, t.table, false);
    } catch (e) {
      errors.push(`${t.database}.${t.table}: ${e.message}`);
      continue;
    }

    let textCols = SchemaCache.textColumnsOf(desc);
    // 配置里指定了只暴露部分列 → 搜索也只看这些列
    if (t.columns && t.columns.length) {
      const allow = new Set(t.columns.map(c => c.toLowerCase()));
      textCols = textCols.filter(c => allow.has(c.name.toLowerCase()));
    }
    if (textCols.length === 0) {
      skipped.push(`跳过 ${t.database}.${t.table}：没有可搜索的文本列`);
      continue;
    }

    scanned++;
    const pk = desc.primaryKey.length ? desc.primaryKey : (desc.columns[0] ? [desc.columns[0].name] : []);

    // 构造：对每个文本列做 LIKE，用 UNION ALL 把 (col, val) 拍平
    // 这样一次往返就能拿到一张表所有列的命中
    const branches = textCols.map(c => {
      const conds = keywords.map(kw => {
        const pat = `'%${likeEscape(kw)}%'`;
        return caseSensitive
          ? `\`${c.name}\` LIKE BINARY ${pat}`
          : `\`${c.name}\` LIKE ${pat}`;
      });
      const whereCond = mode === 'or' ? conds.join(' OR ') : conds.join(' AND ');
      // 只取非空值，避免 NULL 匹配噪声
      const notNull = `\`${c.name}\` IS NOT NULL`;
      const extra = t.where ? ` AND (${t.where})` : '';
      const pkCols = pk.map(p => `\`${p}\` AS \`__pk_${p}\``).join(', ');
      const pkPart = pkCols ? pkCols + ', ' : '';
      return `SELECT '${c.name.replace(/'/g, "''")}' AS \`__col\`, ` +
        `CAST(\`${c.name}\` AS CHAR) AS \`__val\`, ${pkPart}` +
        // 加 uid 便于后续按主键回查
        `1 AS \`__ord\` FROM \`${t.database}\`.\`${t.table}\` ` +
        `WHERE ${notNull} AND (${whereCond})${extra}`;
    });

    const sql = branches.join('\nUNION ALL\n') + `\nLIMIT ${perTable * textCols.length}`;

    try {
      const res = await s.pools.query(t.source, sql, { maxRows: Math.min(perTable * textCols.length, 1000) });
      // 每张表最多贡献 perTable 条（跨列合并后截断）
      let taken = 0;
      for (const row of res.rows) {
        if (taken >= perTable) break;
        const col = row.__col;
        const val = row.__val;
        // 主键字段
        const idParts = [];
        for (const [k, v] of Object.entries(row)) {
          if (k.startsWith('__pk_') && v !== null && v !== undefined) {
            idParts.push(k.slice(5) + '=' + fmt.cell(v, 40));
          }
        }
        // 打码列在搜索里同样处理：命中片段本身就含敏感内容，直接跳过打码列更安全
        if (t.redact && t.redact.some(p => new RegExp(p, 'i').test(col))) {
          hits.push({
            knowledgeBase: t.knowledgeBase, database: t.database, table: t.table,
            column: col, id: idParts.join(', '), snippet: '(该列在配置中标记为敏感，内容已隐藏)',
            redacted: true
          });
          taken++;
          continue;
        }
        hits.push({
          knowledgeBase: t.knowledgeBase, database: t.database, table: t.table,
          column: col, id: idParts.join(', '),
          snippet: makeSnippet(val, keywords, snippetLen, caseSensitive)
        });
        taken++;
      }
    } catch (e) {
      errors.push(`${t.database}.${t.table}: ${e.message}`);
    }
  }

  /* ---------- 排序 + 分页 ---------- */
  // 排序策略：命中关键词更多的排前面（更相关），同分按表名稳定排序
  const scored = hits.map((h) => {
    const hay = caseSensitive ? h.snippet : h.snippet.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const needle = caseSensitive ? kw : kw.toLowerCase();
      let at = hay.indexOf(needle);
      while (at >= 0) { score++; at = hay.indexOf(needle, at + needle.length); }
    }
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score ||
    a.h.database.localeCompare(b.h.database) ||
    a.h.table.localeCompare(b.h.table) ||
    a.h.column.localeCompare(b.h.column));

  const ordered = scored.map(x => x.h);
  const page = ordered.slice(offset, offset + limit);

  /* ---------- 渲染 ---------- */
  let text = `搜索「${keywords.join(mode === 'or' ? ' 或 ' : ' 且 ')}」`;
  text += ` · 知识库 ${kbNames.join('/')}`;
  text += ` · 扫描 ${scanned} 张表`;
  text += ` · 命中 ${ordered.length} 条`;
  if (caseSensitive) text += ' · 区分大小写';

  if (page.length === 0) {
    text += '\n\n没有找到匹配内容。';
    text += '\n建议：';
    text += '\n  · 换更短/更常见的关键词（如「登录」而不是「登录失败三次锁定」）';
    text += '\n  · 用 mode="or" 放宽匹配（要求任一关键词命中）';
    text += '\n  · 确认表范围：kb_sources(verbose=true) 看配置了哪些表';
    text += '\n  · 有些库的字符串列可能是 GBK 编码，非 ASCII 关键词可能匹配不到';
  } else {
    text += offset > 0 ? `（第 ${offset + 1}~${offset + page.length} 条）` : '';
    text += '\n';
    text += '\n' + page.map((h, i) => {
      const loc = `${h.database}.${h.table}.${h.column}`;
      const id = h.id ? `  [${h.id}]` : '';
      return `${offset + i + 1}. **${loc}**${id}\n   ${h.snippet}`;
    }).join('\n');
  }

  if (offset + page.length < ordered.length) {
    text += `\n\n翻页：kb_search(query="${keywords.join(' ')}"` +
      (args.knowledgeBase ? `, knowledgeBase="${args.knowledgeBase}"` : '') +
      `, offset=${offset + limit})`;
  }
  if (truncatedTables > 0) {
    text += `\n（还有 ${truncatedTables} 张表未扫描，可用 tablesLimit 提高上限或指定 tables 精确搜索）`;
  }
  if (skipped.length) {
    text += `\n（跳过 ${skipped.length} 项：${skipped.slice(0, 3).join('；')}${skipped.length > 3 ? ' …' : ''}）`;
  }
  if (errors.length) {
    text += `\n⚠️ ${errors.length} 张表查询出错：${errors.slice(0, 3).join('；')}`;
  }

  logger.log(`[kb_search] kw=${keywords.join('|')} scanned=${scanned} hits=${ordered.length} ` +
    `errors=${errors.length}`);

  return {
    query: keywords.join(' '),
    keywords,
    mode,
    scannedTables: scanned,
    totalHits: ordered.length,
    offset,
    limit,
    results: page,
    errors: errors.length ? errors : undefined,
    skipped: skipped.length ? skipped : undefined,
    _text: fmt.clip(text, s.config.limits.maxTotalChars || 24000, '请减小 limit 或加长关键词')
  };
}

module.exports = { name, title, description, inputSchema, run, likeEscape, makeSnippet };
