'use strict';
/**
 * 知识库配置
 *
 * 核心概念区分（这是本工具集的设计关键）：
 *
 *   source（数据源）  = 一个 MySQL 连接目标：host + port + user + password
 *   database（库）    = MySQL 里的 schema（database）
 *   table（表）       = 具体一张表
 *   knowledge base（知识库）= **有名字的一批表的集合**，表可以来自不同 source / database
 *
 * 用户要的"允许指定多个 MySQL 表格作为知识库"落在最后这一层：
 * 一个知识库 = [{ source, database, table }, ...]，
 * 这样 Agent 可以对着"客服知识库"这种业务概念提问，而不是记一堆库名表名。
 *
 * 配置文件查找顺序（先找到先用）：
 *   1. 环境变量 KB_CONFIG 指向的文件
 *   2. <toolset>/kb.config.json
 *   3. <toolset>/kb.config.local.json   （本地私有，已在 .gitignore 里）
 *   4. 用户主目录 ~/.kb.config.json
 *
 * 也支持用环境变量 KB_MYSQL_URL 直接给单个数据源（快速试用的最短路径）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TOOLSET_DIR = path.join(__dirname, '..', '..');

/* ======================== 默认值 ======================== */

const DEFAULT_SOURCE = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  charset: 'utf8mb4',
  connectTimeout: 10000,
  queryTimeout: 30000,
  ssl: false,
  dateStrings: true
};

const DEFAULT_LIMITS = {
  maxRows: 200,             // 单次查询默认返回行数（Agent 上下文经济）
  maxRowsHard: 2000,        // 硬上限，超过直接拒绝
  maxCellChars: 500,        // 单元格字符数上限，超出截断
  maxTotalChars: 24000,     // 单次工具输出总字符预算
  timeoutMs: 30000
};

/* ======================== URL 解析 ======================== */

/**
 * 解析 mysql://user:pass@host:port/database
 * 兼容 mysql:// 与 mariadb://
 */
function parseUrl(url) {
  if (!url) return null;
  const m = /^(mysql|mariadb):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?]+)(?::(\d+))?(?:\/([^?]*))?/.exec(url.trim());
  if (!m) throw new Error('无法解析数据库 URL（期望 mysql://user:pass@host:port/db）：' + url);
  return {
    host: m[4],
    port: m[5] ? Number(m[5]) : 3306,
    user: m[2] !== undefined ? decodeURIComponent(m[2]) : 'root',
    password: m[3] !== undefined ? decodeURIComponent(m[3]) : '',
    database: m[6] ? decodeURIComponent(m[6]) : undefined
  };
}

/* ======================== 规范化 ======================== */

/** 把一个 table 条目规范成统一结构 */
function normTableEntry(t, defaultSourceName) {
  if (typeof t === 'string') {
    // 支持 "db.table" 写法
    const dot = t.indexOf('.');
    if (dot > 0) {
      return { source: defaultSourceName, database: t.slice(0, dot), table: t.slice(dot + 1) };
    }
    return { source: defaultSourceName, database: undefined, table: t };
  }
  if (t && typeof t === 'object') {
    // 支持 { database, table } / { db, name } / { schema, table }
    const database = t.database || t.db || t.schema;
    const table = t.table || t.name || t.tableName;
    if (!table) throw new Error('表条目缺少表名：' + JSON.stringify(t));
    return {
      source: t.source || defaultSourceName,
      database,
      table,
      label: t.label || t.alias,
      description: t.description || t.comment,
      // 只暴露部分列（把宽表的敏感/无关列挡在外面）
      columns: Array.isArray(t.columns) ? t.columns : undefined,
      // 只暴露部分行（固化过滤条件，例如只给"已发布"数据）
      where: t.where || t.filter,
      // 敏感列名（输出时打码）
      redact: Array.isArray(t.redact) ? t.redact : undefined
    };
  }
  throw new Error('非法的表条目：' + JSON.stringify(t));
}

/**
 * 规范化整份配置，并做基本校验
 * @returns {{ sources, knowledgeBases, limits, warnings }}
 */
function normalizeConfig(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    throw new Error('配置为空或格式不对（应为 JSON 对象）');
  }

  /* ---- sources ---- */
  const sources = {};
  const rawSources = raw.sources || {};

  // 允许 sources 直接写成 URL 字符串
  for (const [name, val] of Object.entries(rawSources)) {
    if (typeof val === 'string') {
      sources[name] = Object.assign({}, DEFAULT_SOURCE, parseUrl(val), { name });
    } else {
      const merged = Object.assign({}, DEFAULT_SOURCE, val);
      if (val && val.url) Object.assign(merged, parseUrl(val.url));
      merged.name = name;
      // 只保留 Connection 认识的字段，避免把 label 之类传下去
      sources[name] = {
        name,
        label: merged.label,
        host: merged.host,
        port: Number(merged.port) || 3306,
        user: merged.user,
        password: merged.password !== undefined ? String(merged.password) : '',
        database: merged.database,
        charset: merged.charset || 'utf8mb4',
        connectTimeout: Number(merged.connectTimeout) || DEFAULT_SOURCE.connectTimeout,
        queryTimeout: Number(merged.queryTimeout) || DEFAULT_SOURCE.queryTimeout,
        ssl: merged.ssl || false,
        dateStrings: merged.dateStrings !== false,
        bigIntAsString: merged.bigIntAsString !== false,
        allowCleartextPassword: !!merged.allowCleartextPassword,
        maxRows: Number(merged.maxRows) || DEFAULT_LIMITS.maxRows,
        readOnly: merged.readOnly !== false,   // 默认只读
        pool: merged.pool || { max: 4, idleTimeout: 60000 }
      };
    }
  }

  // 也支持顶层单个数据源写法（只有 host/user/... 没有 sources 时）
  if (Object.keys(sources).length === 0 && (raw.host || raw.url)) {
    const base = raw.url ? parseUrl(raw.url) : {};
    sources.default = Object.assign({}, DEFAULT_SOURCE, base, {
      name: 'default',
      host: raw.host || base.host || DEFAULT_SOURCE.host,
      port: Number(raw.port || base.port || 3306),
      user: raw.user || base.user || DEFAULT_SOURCE.user,
      password: raw.password !== undefined ? String(raw.password) : (base.password || ''),
      database: raw.database || base.database,
      ssl: raw.ssl || false,
      readOnly: raw.readOnly !== false
    });
    warnings.push('配置里没有 sources，已把顶层连接参数当作名为 "default" 的数据源。');
  }

  if (Object.keys(sources).length === 0) {
    throw new Error('配置里没有任何数据源（sources）。至少需要一个 MySQL 连接目标。');
  }

  /* ---- knowledge bases ---- */
  const knowledgeBases = {};
  const rawKbs = raw.knowledgeBases || raw.knowledge_bases || raw.kbs || {};

  for (const [name, kbRaw] of Object.entries(rawKbs)) {
    const def = (typeof kbRaw === 'object' && !Array.isArray(kbRaw)) ? kbRaw : { tables: kbRaw };
    const tablesRaw = def.tables || [];
    if (!Array.isArray(tablesRaw)) throw new Error(`知识库 "${name}" 的 tables 必须是数组`);
    if (tablesRaw.length === 0) {
      warnings.push(`知识库 "${name}" 没有任何表，将被跳过。`);
      continue;
    }
    const defaultSourceName = def.source || Object.keys(sources)[0];
    if (def.source && !sources[def.source]) {
      throw new Error(`知识库 "${name}" 引用了不存在的数据源 "${def.source}"`);
    }
    const tables = tablesRaw.map(t => normTableEntry(t, defaultSourceName));
    // 校验每张表引用的 source 存在
    for (const t of tables) {
      if (!sources[t.source]) {
        throw new Error(`知识库 "${name}" 的表 ${t.database || ''}.${t.table} 引用了不存在的数据源 "${t.source}"`);
      }
      if (!t.database && !sources[t.source].database) {
        warnings.push(`知识库 "${name}" 的表 "${t.table}" 未指定 database，` +
          `且数据源 "${t.source}" 也没有默认库；查询时若报 "No database selected"，请补上 database 字段。`);
      }
    }
    knowledgeBases[name] = {
      name,
      label: def.label || def.description || name,
      description: def.description || '',
      tables,
      redact: Array.isArray(def.redact) ? def.redact : undefined
    };
  }

  /* ---- 便捷写法：只有 sources、没有 knowledgeBases 时，为每个源的默认库建一个同名知识库 ---- */
  if (Object.keys(knowledgeBases).length === 0) {
    for (const [sname, s] of Object.entries(sources)) {
      if (!s.database) continue;
      knowledgeBases[sname] = {
        name: sname,
        label: s.label || `${sname}（${s.database}）`,
        description: `数据源 ${sname} 的整个 ${s.database} 库`,
        // 空 tables 表示"整库"，由 schema 层展开
        tables: [],
        autoWholeDatabase: true,
        source: sname,
        database: s.database
      };
    }
    if (Object.keys(knowledgeBases).length) {
      warnings.push('配置里没有 knowledgeBases，已为每个数据源的默认库自动创建一个同名知识库（整库）。');
    }
  }

  if (Object.keys(knowledgeBases).length === 0) {
    throw new Error('配置里没有任何可用的知识库（knowledgeBases），也没有带默认库的数据源。');
  }

  /* ---- limits ---- */
  const limits = Object.assign({}, DEFAULT_LIMITS, raw.limits || {});

  return { sources, knowledgeBases, limits, warnings };
}

/* ======================== 加载 ======================== */

function findConfigFile(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.KB_CONFIG) candidates.push(process.env.KB_CONFIG);
  candidates.push(path.join(TOOLSET_DIR, 'kb.config.json'));
  candidates.push(path.join(TOOLSET_DIR, 'kb.config.local.json'));
  candidates.push(path.join(os.homedir(), '.kb.config.json'));
  for (const c of candidates) {
    try {
      if (c && fs.statSync(c).isFile()) return c;
    } catch (e) { /* 不存在，继续 */ }
  }
  return null;
}

/**
 * 加载配置
 * @param {string} [explicitPath]
 * @returns {{ config, path, warnings, fromEnv }}
 */
function loadConfig(explicitPath) {
  // 1. 环境变量直给 URL 的最短路径（优先级最高，方便临时试用）
  if (process.env.KB_MYSQL_URL) {
    const url = parseUrl(process.env.KB_MYSQL_URL);
    const db = process.env.KB_MYSQL_DATABASE || url.database;
    const raw = {
      sources: { default: Object.assign({}, url, { label: url.host }) },
      knowledgeBases: db ? {
        default: {
          label: `${url.host} / ${db}`,
          description: '来自 KB_MYSQL_URL 环境变量',
          tables: []
        }
      } : {},
      limits: {}
    };
    if (db) {
      raw.knowledgeBases.default.autoWholeDatabase = true;
      raw.knowledgeBases.default.source = 'default';
      raw.knowledgeBases.default.database = db;
    }
    const config = normalizeConfig(raw);
    return { config, path: '(KB_MYSQL_URL 环境变量)', warnings: config.warnings, fromEnv: true };
  }

  // 2. 配置文件
  const file = findConfigFile(explicitPath);
  if (!file) {
    throw new Error(
      '找不到知识库配置。请任选一种方式：\n' +
      '  a) 在 kb/ 下创建 kb.config.json（可复制 kb.config.example.json 改）\n' +
      '  b) 设置环境变量 KB_CONFIG=<配置文件绝对路径>\n' +
      '  c) 设置环境变量 KB_MYSQL_URL=mysql://user:pass@host:3306/dbname 快速试用\n' +
      '  d) 在用户主目录创建 ~/.kb.config.json'
    );
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error('读取配置文件失败：' + file + ' —— ' + e.message);
  }

  // 去掉 // 行注释与块注释（JSON 本身不支持，但配置文件里注释很有用）
  const stripped = stripJsonComments(text);

  let raw;
  try {
    raw = JSON.parse(stripped);
  } catch (e) {
    throw new Error('配置文件不是合法 JSON：' + file + '\n' + e.message +
      '\n（提示：字符串里的反斜杠要写成 \\\\，Windows 路径建议用正斜杠 /）');
  }

  const config = normalizeConfig(raw);
  return { config, path: file, warnings: config.warnings, fromEnv: false };
}

/** 去掉 JSON 里的注释（谨慎处理：只在字符串外生效） */
function stripJsonComments(text) {
  let out = '';
  let inStr = false, inLine = false, inBlock = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

/** 脱敏：把配置里出现过的密码都换成 ***（用于任何可能外泄的输出） */
function maskSecrets(obj) {
  const secrets = new Set();
  const collect = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (/pass/i.test(k) && typeof val === 'string' && val) secrets.add(val);
      else if (typeof val === 'object') collect(val);
    }
  };
  collect(obj);
  // 凭据字段一律替换成固定占位（空串也不原样输出），
  // 同时保留"是否已设置"这一信息，便于诊断认证问题。
  const json = JSON.stringify(obj, (k, v) => {
    if (/password|passwd|pwd|secret|token|credential/i.test(k)) {
      return (v === undefined || v === null || v === '') ? '(未设置)' : '***';
    }
    return v;
  });
  let out = json;
  // 兜底：万一同一个密码字符串出现在别的字段里（例如写进了 URL），也一并抹掉
  for (const s of secrets) {
    if (s.length >= 3) out = out.split(s).join('***');
  }
  return JSON.parse(out);
}

/**
 * 只保留"可以安全外传"的数据源字段。
 * 比 maskSecrets 更彻底：源对象里根本不含凭据，杜绝任何形式的泄漏。
 */
function safeSourceView(src) {
  return {
    name: src.name,
    label: src.label,
    host: src.host,
    port: src.port,
    user: src.user,
    database: src.database || null,
    charset: src.charset,
    ssl: !!src.ssl,
    readOnly: src.readOnly !== false,
    maxRows: src.maxRows,
    passwordSet: src.password !== undefined && src.password !== null && src.password !== ''
  };
}

module.exports = {
  loadConfig, normalizeConfig, parseUrl, stripJsonComments, maskSecrets,
  safeSourceView, findConfigFile, DEFAULT_SOURCE, DEFAULT_LIMITS, TOOLSET_DIR
};
