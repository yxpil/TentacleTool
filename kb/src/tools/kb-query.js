'use strict';
/**
 * kb_query —— 执行只读 SQL
 *
 * 这是能力最强也最危险的工具，所以护栏最多：
 *  1. 只读闸门（数据源 readOnly=true 时只允许 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH）
 *  2. 自动补 LIMIT：没有 LIMIT 的 SELECT 会被套上 LIMIT n，避免把全表拉进上下文
 *  3. 行数硬上限（limits.maxRowsHard）
 *  4. 单元格截断 + 总输出预算
 *  5. 危险列打码（配置里的 redact，如 password）
 *  6. 每条查询都记日志（审计）
 */

const rt = require('../kb/runtime');
const fmt = require('./format');
const logger = require('../utils/logger');

const name = 'kb_query';
const title = 'Run read-only SQL';
const description =
  '在一个知识库包含的表上执行只读 SQL 查询（默认数据源为只读模式，写操作会被拒绝）。' +
  '表名请用 `库名`.`表名` 或至少 `表名` 全限定写法。' +
  '没有 LIMIT 的 SELECT 会被自动加上 LIMIT（默认 200，可用 limit 调整，硬上限由配置决定）。' +
  '支持 ? 占位符 + params 数组做参数化查询（强烈建议用于字符串条件，避免拼接错误）。';

const inputSchema = {
  type: 'object',
  properties: {
    sql: {
      type: 'string',
      description: 'SQL 语句。只读模式下仅允许 SELECT / SHOW / DESCRIBE / EXPLAIN / WITH'
    },
    params: {
      type: 'array',
      description: '与 SQL 中 ? 占位符对应的参数数组（会被安全转义）',
      items: {}
    },
    knowledgeBase: {
      type: 'string',
      description: '限定在某个知识库范围内（会检查 SQL 里引用的表是否属于该库，防止查越界）'
    },
    source: {
      type: 'string',
      description: '指定数据源（多数据源时必需）'
    },
    limit: {
      type: 'number',
      description: '返回行数上限，默认 200，受配置的 hard 上限约束'
    },
    cellMax: {
      type: 'number',
      description: '单个单元格最大字符数，默认 500'
    }
  },
  required: ['sql'],
  additionalProperties: false
};

/** 从 SQL 里粗略提取被引用的表名（用于越界检查；有误报时会放行而非拒绝） */
function referencedTables(sql) {
  const out = new Set();
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'[^']*'/g, "''")     // 去掉字符串字面量，避免把 'from x' 当表名
    .replace(/"[^"]*"/g, '""');

  const re = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|DESCRIBE|DESC|EXPLAIN)\s+((?:`[^`]+`|\w+)(?:\s*\.\s*(?:`[^`]+`|\w+))?)/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const raw = m[1].replace(/`/g, '').replace(/\s*\.\s*/g, '.');
    if (/^(SELECT|FROM|WHERE|DUAL)$/i.test(raw)) continue;
    out.add(raw);
  }
  return Array.from(out);
}

/** 是否已有 LIMIT（避免重复套一层） */
function hasLimit(sql) {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'[^']*'/g, "''");
  return /\bLIMIT\b/i.test(cleaned);
}

/** 是否值得自动加 LIMIT（只有 SELECT / WITH 需要） */
function shouldAutoLimit(sql) {
  const head = sql.replace(/^\s*\(*\s*/, '').slice(0, 10).toUpperCase();
  return head.startsWith('SELECT') || head.startsWith('WITH');
}

/** 对行里的敏感列打码 */
function redactRow(row, patterns, cellMax) {
  if (!patterns || !patterns.length) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const hit = patterns.some(p => new RegExp(p, 'i').test(k));
    if (hit && v !== null && v !== undefined && v !== '') {
      const s = fmt.cell(v, cellMax);
      out[k] = s.length <= 4 ? '***' : s.slice(0, 2) + '***' + (s.length > 8 ? s.slice(-2) : '');
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function run(args = {}) {
  const s = rt.require();
  const sql = String(args.sql || '').trim();
  if (!sql) {
    return { error: 'empty sql', _text: '请提供 sql 参数。' };
  }

  /* ---------- 决定数据源 ---------- */
  let sourceName = args.source;
  let kb = null;
  if (args.knowledgeBase) {
    kb = s.config.knowledgeBases[args.knowledgeBase];
    if (!kb) {
      return {
        error: 'knowledge base not found',
        _text: `未找到知识库 "${args.knowledgeBase}"。可用的有：\n  ` +
          Object.keys(s.config.knowledgeBases).join('\n  ')
      };
    }
    if (!sourceName) sourceName = kb.source || (kb.tables[0] && kb.tables[0].source);
  }
  if (!sourceName && s.config.sources.default) sourceName = 'default';
  if (!sourceName) {
    const names = Object.keys(s.config.sources);
    if (names.length === 1) sourceName = names[0];
    else {
      return {
        error: 'source not specified',
        _text: `有多个数据源，请用 source 参数指定一个：\n  ${names.join('\n  ')}`
      };
    }
  }
  const src = s.config.sources[sourceName];
  if (!src) {
    return {
      error: 'source not found',
      _text: `未知数据源 "${sourceName}"。可用的有：\n  ${Object.keys(s.config.sources).join('\n  ')}`
    };
  }

  /* ---------- 越界检查：限定知识库时，SQL 不该碰库外的表 ---------- */
  if (kb && kb.tables.length) {
    const allowed = new Set();
    for (const t of kb.tables) {
      const db = t.database || (s.config.sources[t.source] && s.config.sources[t.source].database);
      allowed.add(t.table.toLowerCase());
      if (db) allowed.add((db + '.' + t.table).toLowerCase());
    }
    const refs = referencedTables(sql);
    // 系统库/元数据表视为可读的公共资源（Agent 常用 SHOW / information_schema 探查结构），
    // 其余任何不在白名单里的引用都算越界。
    const isSystemRef = (r) => /^(information_schema|performance_schema|mysql|sys)\b/i.test(r);
    const violations = refs.filter(r => {
      if (isSystemRef(r)) return false;
      return !allowed.has(r.toLowerCase());
    });

    if (violations.length) {
      return {
        error: 'table out of scope',
        _text: `查询引用了知识库「${args.knowledgeBase}」之外的表：${violations.join(', ')}\n\n` +
          `该知识库只包含：\n  ${kb.tables.map(t => (t.database ? t.database + '.' : '') + t.table).join('\n  ')}\n\n` +
          `如确需查询其它表，请去掉 knowledgeBase 参数，或把表加入该知识库配置。`
      };
    }
  }

  /* ---------- 自动补 LIMIT ---------- */
  const limit = Math.min(
    Number(args.limit) || s.config.limits.maxRows || 200,
    s.config.limits.maxRowsHard || 2000
  );
  let finalSql = sql;
  let autoLimited = false;
  if (shouldAutoLimit(sql) && !hasLimit(sql)) {
    finalSql = sql.replace(/;\s*$/, '') + ` LIMIT ${limit}`;
    autoLimited = true;
  }

  /* ---------- 执行 ---------- */
  const start = Date.now();
  let res;
  try {
    res = await s.pools.query(sourceName, finalSql, {
      params: Array.isArray(args.params) ? args.params : undefined,
      maxRows: limit
    });
  } catch (e) {
    // 只读拦截单独给出明确指引
    if (e.code === 'KB_READONLY') {
      return {
        error: 'read only',
        readOnlyViolation: true,
        _text: '🛑 ' + e.message + '\n\n' +
          `当前数据源 "${sourceName}" 是只读模式。只读是默认且推荐的安全设置。\n` +
          '如果你确实需要写操作，请让用户在 kb.config.json 里把该数据源的 ' +
          '"readOnly" 改为 false（不建议，请确认这是有意为之）。'
      };
    }
    const hint = errorHint(e, src);
    return {
      error: e.message,
      errorCode: e.code || null,
      _text: `查询失败：${e.message}\n` + hint
    };
  }
  const took = Date.now() - start;
  logger.log(`[kb_query] source=${sourceName} rows=${res.rows.length} took=${took}ms sql=` +
    finalSql.replace(/\s+/g, ' ').slice(0, 300));

  /* ---------- 渲染 ---------- */
  const cellMax = Number(args.cellMax) || s.config.limits.maxCellChars || 500;
  const colNames = res.columns.map(c => c.name);
  const kbRedact = kb && kb.redact;
  // 表级 redact（知识库里每张表可单独配）
  const tableRedacts = kb ? kb.tables.flatMap(t => t.redact || []) : [];
  const redactPatterns = [].concat(kbRedact || [], tableRedacts);

  const rowsForText = res.rows.map(r => redactRow(r, redactPatterns, cellMax));

  let text = `数据源 ${sourceName}` + (kb ? ` · 知识库「${args.knowledgeBase}」` : '');
  text += ` · 耗时 ${fmt.ms(took)}`;

  if (res.type === 'ok') {
    text += `\n\n语句执行成功（影响 ${res.affectedRows} 行）`;
    return { source: sourceName, affectedRows: res.affectedRows, rows: [], _text: text };
  }

  if (res.rows.length === 0) {
    text += '\n\n查询成功，但结果为空（0 行）。';
    text += '\n提示：检查过滤条件是否过严，或先用不带条件的 LIMIT 查询确认表里有数据。';
    return {
      source: sourceName, columns: colNames, rows: [], rowCount: 0,
      elapsedMs: took, _text: text,
      sql: finalSql
    };
  }

  text += ` · 返回 ${res.rows.length} 行`;
  if (autoLimited) text += `（原始查询无 LIMIT，已自动加 LIMIT ${limit}）`;
  if (redactPatterns.length) text += ` · 已打码列：${redactPatterns.join(', ')}`;
  text += '\n\n';

  text += fmt.table(colNames, rowsForText.map(r => colNames.map(c => r[c] !== undefined ? r[c] : r[c + '_' + colNames.indexOf(c)])), {
    cellMax,
    totalMax: s.config.limits.maxTotalChars || 24000,
    colMax: 48
  });

  if (res.rows.length >= limit) {
    text += `\n\n（已触及行数上限 ${limit}。要更多数据请：① 加 WHERE 收窄条件；` +
      `② 用 COUNT(*) 先看总量；③ 用 kb_stats 了解表规模）`;
  }

  // 提供列清单，便于 Agent 写后续 SQL
  text += `\n\n列：${colNames.join(', ')}`;

  return {
    source: sourceName,
    knowledgeBase: args.knowledgeBase || null,
    columns: colNames,
    rows: res.rows.map(r => redactRow(r, redactPatterns, cellMax)),
    rowCount: res.rows.length,
    limit,
    autoLimited,
    elapsedMs: took,
    sql: finalSql,
    _text: text
  };
}

/** 把常见 MySQL 错误码翻译成可操作的提示 */
function errorHint(e, src) {
  const code = e.code;
  const hints = {
    1045: '账号或密码不正确。检查 kb.config.json 里该数据源的 user / password。',
    1046: `没有选择数据库。请在 SQL 里用 \`库名\`.\`表名\` 全限定写法，` +
      `或在数据源 "${src && src.name}" 配置里补上 database 字段。`,
    1049: '数据库不存在。检查库名拼写，或用 kb_query(sql="SHOW DATABASES") 查看可用库。',
    1054: '列名不存在。用 kb_schema 确认实际列名（注意大小写与别名）。',
    1064: 'SQL 语法错误。检查引号是否配对、关键字拼写；表名/列名建议用反引号包裹。',
    1142: '该账号没有访问这张表的权限。换一个有权限的账号，或让 DBA 授权。',
    1146: '表不存在。用 kb_schema 列出该知识库实际包含的表；注意库名是否正确。',
    2003: '无法连接到 MySQL 服务器。确认服务已启动、host/port 正确、防火墙未拦截。',
    2005: '无法解析主机名。检查 host 配置。'
  };
  const h = hints[code];
  if (h) return '\n💡 ' + h;
  if (e.name === 'MySqlConnectionError') {
    return `\n💡 连接问题：确认 ${src ? src.host + ':' + src.port : 'MySQL 服务'} 可访问，` +
      '账号密码正确，且该账号允许从本机连接（localhost 授权）。';
  }
  return '';
}

module.exports = { name, title, description, inputSchema, run, referencedTables, hasLimit };
