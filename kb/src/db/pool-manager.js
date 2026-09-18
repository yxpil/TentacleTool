'use strict';
/**
 * 数据源池管理器：按 source 名字分发查询，惰性建池
 *
 * 另外承担一个安全职责：**只读闸门**。
 * 配置里 source 默认 readOnly=true，此时任何非 SELECT/SHOW/DESCRIBE/EXPLAIN 的语句
 * 都在这里被拦下，而不是靠上层自觉。这是防止 Agent "手滑写库"的最后一道闸。
 */

const { Pool } = require('./pool');

/** 只读模式下允许的语句开头（宽松匹配，但拒绝明显写操作） */
const READONLY_ALLOW = /^\s*(\(*\s*)?(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH|USE|SET\s+NAMES|SET\s+@)\b/i;

/** 明显是写操作的关键词（出现在语句开头或紧跟分号后） */
const WRITE_PATTERN = /(^|;)\s*(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|DROP|ALTER|CREATE|RENAME|GRANT|REVOKE|LOAD\s+DATA|LOCK|UNLOCK|CALL|HANDLER|IMPORT)\b/i;

/**
 * 检查一条 SQL 是否可以在只读模式下执行
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkReadOnly(sql) {
  if (!sql || !sql.trim()) return { ok: false, reason: 'SQL 为空' };

  // 去掉注释再判断，避免 /* */ INSERT 这种绕过
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .trim();

  if (WRITE_PATTERN.test(cleaned)) {
    const m = WRITE_PATTERN.exec(cleaned);
    return {
      ok: false,
      reason: `只读模式拒绝执行 ${(m[2] || '').toUpperCase()} 语句。` +
        `如需写入，请在配置里把该数据源的 readOnly 设为 false（不建议）。`
    };
  }
  // 多语句一律拒绝（防止 SELECT 1; DROP TABLE x）
  const noTrail = cleaned.replace(/;\s*$/, '');
  if (noTrail.includes(';')) {
    return { ok: false, reason: '只读模式拒绝多语句（检测到分号）。一次只执行一条查询。' };
  }
  if (!READONLY_ALLOW.test(cleaned)) {
    const head = cleaned.slice(0, 40).replace(/\s+/g, ' ');
    return {
      ok: false,
      reason: `只读模式只允许 SELECT / SHOW / DESCRIBE / EXPLAIN / WITH 开头的查询，收到："${head}…"`
    };
  }
  return { ok: true };
}

class PoolManager {
  constructor(config) {
    this.config = config;
    this.pools = new Map();     // sourceName -> Pool
  }

  get sourceNames() { return Object.keys(this.config.sources); }

  /** 取（必要时创建）某个数据源的连接池 */
  poolFor(sourceName) {
    const src = this.config.sources[sourceName];
    if (!src) {
      const avail = this.sourceNames.join(', ') || '(无)';
      throw new Error(`未知数据源 "${sourceName}"。可用：${avail}`);
    }
    if (!this.pools.has(sourceName)) {
      this.pools.set(sourceName, new Pool(src, src.pool || {}));
    }
    return this.pools.get(sourceName);
  }

  /**
   * 执行查询（自动路由到对应数据源 + 只读检查）
   * @param {string} sourceName
   * @param {string} sql
   * @param {object} opts { params, maxRows, bypassReadOnly }
   */
  async query(sourceName, sql, opts = {}) {
    const src = this.config.sources[sourceName];
    if (!src) {
      const avail = this.sourceNames.join(', ') || '(无)';
      throw new Error(`未知数据源 "${sourceName}"。可用：${avail}`);
    }
    if (src.readOnly && !opts.bypassReadOnly) {
      const chk = checkReadOnly(sql);
      if (!chk.ok) {
        const e = new Error(chk.reason);
        e.name = 'ReadOnlyViolation';
        e.code = 'KB_READONLY';
        throw e;
      }
    }
    const pool = this.poolFor(sourceName);
    const maxRows = Math.min(
      opts.maxRows || src.maxRows || this.config.limits.maxRows,
      this.config.limits.maxRowsHard
    );
    return pool.query(sql, Object.assign({}, opts, { maxRows }));
  }

  /** 在指定库里执行（自动补 USE 语义：用限定名而不是真的切库，避免池内连接状态串味） */
  async queryIn(sourceName, database, sql, opts = {}) {
    if (database) {
      // 不执行 USE，改为把当前库显式写进查询上下文：
      // 通过 SELECT ... FROM `db`.`table` 由调用方保证，这里只做默认库兜底。
      const src = this.config.sources[sourceName];
      if (!src.database) {
        // 连接上没有默认库，且查询可能用到未限定表名 → 用 USE 会污染池，
        // 所以这里明确要求调用方使用限定表名；仅在必要时补一次 USE。
        const pool = this.poolFor(sourceName);
        await pool.query('USE `' + database.replace(/`/g, '') + '`');
      }
    }
    return this.query(sourceName, sql, opts);
  }

  /** 探活所有数据源，返回每个源的连通性（供 kb_sources 显示） */
  async probe(sourceName) {
    const start = Date.now();
    try {
      const pool = this.poolFor(sourceName);
      const r = await pool.query('SELECT VERSION() AS version, DATABASE() AS currentDb');
      return {
        ok: true,
        ms: Date.now() - start,
        version: r.rows[0] ? r.rows[0].version : null,
        currentDatabase: r.rows[0] ? r.rows[0].currentDb : null,
        pool: { size: pool.size, idle: pool.idleCount }
      };
    } catch (e) {
      return {
        ok: false,
        ms: Date.now() - start,
        error: e.message,
        code: e.code || null
      };
    }
  }

  async shutdown() {
    const pools = Array.from(this.pools.values());
    this.pools.clear();
    await Promise.all(pools.map(p => p.shutdown().catch(() => { })));
  }
}

module.exports = { PoolManager, checkReadOnly, READONLY_ALLOW, WRITE_PATTERN };
