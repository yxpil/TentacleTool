'use strict';
/**
 * Schema 内省：从 information_schema 读出表/列/注释/主键/外键/索引
 *
 * 为什么必须重视注释：真实业务库（如本机 wkstudy）的表注释和列注释
 * 就是人类写的业务语义（"文章：存储文字系统的核心内容…"）。
 * Agent 靠这些注释才能把"自然语言问题"对到"该查哪张表哪一列"。
 * 没有注释的库只能靠列名猜，效果差很多——所以这也是 kb_schema 的重点输出。
 *
 * 缓存：schema 变化不频繁，默认缓存 5 分钟，可用 refresh 强制刷新。
 */

const { maskSecrets } = require('./config');

const DEFAULT_TTL = 5 * 60 * 1000;

class SchemaCache {
  constructor(poolManager) {
    this.pools = poolManager;
    this.tables = new Map();      // key: source|database|table -> { at, data }
    this.databases = new Map();   // key: source -> { at, data }
  }

  _fresh(entry, ttl) {
    return entry && (Date.now() - entry.at) < ttl;
  }

  clear() { this.tables.clear(); this.databases.clear(); }

  /** 列出某个数据源上的所有库 */
  async listDatabases(sourceName, refresh = false) {
    const key = sourceName;
    if (!refresh && this._fresh(this.databases.get(key), DEFAULT_TTL)) {
      return this.databases.get(key).data;
    }
    const rows = await this.pools.query(sourceName,
      `SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset,
              DEFAULT_COLLATION_NAME AS collation
         FROM information_schema.SCHEMATA
        ORDER BY SCHEMA_NAME`, { maxRows: 500 });
    const data = rows.rows;
    this.databases.set(key, { at: Date.now(), data });
    return data;
  }

  /** 列出某库的表（含注释与行数估计） */
  async listTables(sourceName, database, refresh = false) {
    const key = `${sourceName}|${database}`;
    if (!refresh && this._fresh(this.tables.get(key), DEFAULT_TTL)) {
      return this.tables.get(key).data;
    }
    const rows = await this.pools.query(sourceName,
      `SELECT TABLE_NAME AS name,
              TABLE_TYPE AS type,
              ENGINE AS engine,
              TABLE_ROWS AS rowEstimate,
              TABLE_COMMENT AS comment,
              CREATE_TIME AS createTime,
              UPDATE_TIME AS updateTime,
              TABLE_COLLATION AS collation
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`, { params: [database], maxRows: 5000 });
    const data = rows.rows;
    this.tables.set(key, { at: Date.now(), data });
    return data;
  }

  /** 取一张表的完整结构：列定义 + 主键 + 外键 + 索引 */
  async describeTable(sourceName, database, table, refresh = false) {
    const key = `${sourceName}|${database}|${table}`;
    if (!refresh && this._fresh(this.tables.get(key), DEFAULT_TTL)) {
      return this.tables.get(key).data;
    }

    const [cols, keys, fks, idx, tblMeta] = await Promise.all([
      this.pools.query(sourceName,
        `SELECT COLUMN_NAME AS name,
                ORDINAL_POSITION AS position,
                COLUMN_DEFAULT AS defaultValue,
                IS_NULLABLE AS nullable,
                DATA_TYPE AS dataType,
                COLUMN_TYPE AS columnType,
                CHARACTER_MAXIMUM_LENGTH AS maxLength,
                NUMERIC_PRECISION AS numericPrecision,
                NUMERIC_SCALE AS numericScale,
                COLUMN_KEY AS columnKey,
                EXTRA AS extra,
                COLUMN_COMMENT AS comment,
                CHARACTER_SET_NAME AS charset
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`, { params: [database, table], maxRows: 2000 }),

      this.pools.query(sourceName,
        `SELECT k.COLUMN_NAME AS columnName, k.ORDINAL_POSITION AS position, k.CONSTRAINT_NAME AS name
           FROM information_schema.KEY_COLUMN_USAGE k
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
            AND k.CONSTRAINT_NAME = 'PRIMARY'
          ORDER BY k.ORDINAL_POSITION`, { params: [database, table], maxRows: 200 }),

      this.pools.query(sourceName,
        `SELECT k.CONSTRAINT_NAME AS name,
                k.COLUMN_NAME AS columnName,
                k.REFERENCED_TABLE_SCHEMA AS refDatabase,
                k.REFERENCED_TABLE_NAME AS refTable,
                k.REFERENCED_COLUMN_NAME AS refColumn
           FROM information_schema.KEY_COLUMN_USAGE k
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
            AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, { params: [database, table], maxRows: 500 }),

      this.pools.query(sourceName,
        `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique,
                SEQ_IN_INDEX AS seq, COLUMN_NAME AS columnName, INDEX_TYPE AS type
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY INDEX_NAME, SEQ_IN_INDEX`, { params: [database, table], maxRows: 500 }),

      this.pools.query(sourceName,
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine,
                TABLE_ROWS AS rowEstimate, TABLE_COMMENT AS comment,
                TABLE_COLLATION AS collation, CREATE_TIME AS createTime, UPDATE_TIME AS updateTime
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, { params: [database, table], maxRows: 1 })
    ]);

    const columns = cols.rows.map(c => ({
      name: c.name,
      position: c.position,
      type: c.dataType,
      fullType: c.columnType,
      length: c.maxLength,
      precision: c.numericPrecision,
      scale: c.numericScale,
      nullable: c.nullable === 'YES',
      default: c.defaultValue,
      key: c.columnKey || null,          // PRI / UNI / MUL
      extra: c.extra || '',
      comment: c.comment || '',
      charset: c.charset || null
    }));

    // 外键按约束名聚合
    const fkMap = new Map();
    for (const f of fks.rows) {
      if (!fkMap.has(f.name)) {
        fkMap.set(f.name, { name: f.name, columns: [], refDatabase: f.refDatabase, refTable: f.refTable, refColumns: [] });
      }
      const e = fkMap.get(f.name);
      e.columns.push(f.columnName);
      e.refColumns.push(f.refColumn);
    }

    // 索引聚合（主键单列在 keys 里，索引里也会出现，做标注区分）
    const idxMap = new Map();
    for (const i of idx.rows) {
      if (!idxMap.has(i.name)) {
        idxMap.set(i.name, { name: i.name, unique: !Number(i.nonUnique), type: i.type, columns: [] });
      }
      idxMap.get(i.name).columns.push(i.columnName);
    }

    const data = {
      source: sourceName,
      database,
      table,
      meta: tblMeta.rows[0] || null,
      primaryKey: keys.rows.map(k => k.columnName),
      columns,
      foreignKeys: Array.from(fkMap.values()),
      indexes: Array.from(idxMap.values()),
      columnCount: columns.length
    };

    this.tables.set(key, { at: Date.now(), data });
    return data;
  }

  /**
   * 取一批表里所有可搜索的文本列（用于 kb_search 的全文/模糊搜索）
   * 只挑字符型列（char/varchar/text 系）与 JSON，数字/二进制列不参与文本搜索
   */
  static textColumnsOf(desc) {
    const TEXTY = /^(char|varchar|tinytext|text|mediumtext|longtext|enum|set|json|tinyblob|blob|mediumblob|longblob)$/i;
    return desc.columns.filter(c => {
      if (!TEXTY.test(c.type)) return false;
      // 明确排除二进制
      if (/blob|binary/i.test(c.fullType) && !/text/i.test(c.type)) return false;
      return true;
    });
  }

  /** 取一张表里最适合作为"标题/摘要"展示的列 */
  static displayColumnsOf(desc, limit = 3) {
    const texty = SchemaCache.textColumnsOf(desc);
    // 优先名字像标题/名称/描述的列
    const scored = texty.map((c) => {
      let score = 0;
      if (/title|name|subject|label|heading/i.test(c.name)) score += 10;
      if (/title|名称|标题|主题/i.test(c.comment)) score += 12;
      if (/desc|summary|abstract|content|body|remark|note/i.test(c.name)) score += 5;
      if (/描述|摘要|内容|备注|说明/i.test(c.comment)) score += 6;
      if (/text$/i.test(c.type)) score -= 1;      // 大文本列放后面，避免输出爆炸
      if (c.length && c.length > 2000) score -= 3;
      return { col: c, score };
    }).sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.col);
  }
}

module.exports = { SchemaCache, DEFAULT_TTL };
