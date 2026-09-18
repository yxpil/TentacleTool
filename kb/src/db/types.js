'use strict';
/**
 * MySQL 列类型定义与文本协议结果集解码
 *
 * 文本协议（COM_QUERY）下所有值都以"长度编码字符串"到达，
 * 需要按列类型把字符串还原成 JS 的 number / bigint / boolean / Date / string / null。
 */

/* ======================== 列类型常量 ======================== */

const FIELD_TYPE = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  NULL: 0x06,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  INT24: 0x09,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  YEAR: 0x0d,
  NEWDATE: 0x0e,
  VARCHAR: 0x0f,
  BIT: 0x10,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  ENUM: 0xf7,
  SET: 0xf8,
  TINY_BLOB: 0xf9,
  MEDIUM_BLOB: 0xfa,
  LONG_BLOB: 0xfb,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe,
  GEOMETRY: 0xff
};

/** 类型码 → 人类可读名（供 kb_schema 输出） */
const TYPE_NAME = {
  0x00: 'DECIMAL', 0x01: 'TINYINT', 0x02: 'SMALLINT', 0x03: 'INT', 0x04: 'FLOAT',
  0x05: 'DOUBLE', 0x06: 'NULL', 0x07: 'TIMESTAMP', 0x08: 'BIGINT', 0x09: 'MEDIUMINT',
  0x0a: 'DATE', 0x0b: 'TIME', 0x0c: 'DATETIME', 0x0d: 'YEAR', 0x0e: 'NEWDATE',
  0x0f: 'VARCHAR', 0x10: 'BIT', 0xf5: 'JSON', 0xf6: 'DECIMAL', 0xf7: 'ENUM', 0xf8: 'SET',
  0xf9: 'TINYBLOB', 0xfa: 'MEDIUMBLOB', 0xfb: 'LONGBLOB', 0xfc: 'BLOB',
  0xfd: 'VAR_STRING', 0xfe: 'STRING', 0xff: 'GEOMETRY'
};

/* 列定义标志位（只保留我们关心的几个） */
const FLAG = {
  NOT_NULL: 0x0001,
  PRI_KEY: 0x0002,
  UNIQUE_KEY: 0x0004,
  MULTIPLE_KEY: 0x0008,
  BLOB: 0x0010,
  UNSIGNED: 0x0020,
  ZEROFILL: 0x0040,
  BINARY: 0x0080,
  ENUM: 0x0100,
  AUTO_INCREMENT: 0x0200,
  TIMESTAMP: 0x0400,
  SET: 0x0800,
  NUM: 0x8000
};

/* ======================== 字符集 ======================== */

/**
 * 只处理实际会用到的字符集。MySQL 的 charset id 有几百个，
 * 全部映射没有意义；未识别的按 utf8 处理并标记 uncertain。
 */
const CHARSET = {
  1: 'latin1', 8: 'latin1', 9: 'latin1',
  28: 'gbk', 24: 'gbk', 87: 'gbk',
  33: 'utf8', 83: 'utf8',
  45: 'utf8mb4', 46: 'utf8mb4', 224: 'utf8mb4', 255: 'utf8mb4',
  63: 'binary', 65: 'binary'
};

function charsetName(id) {
  if (id === 224 || id === 45 || id === 46 || id === 255) return 'utf8mb4';
  return CHARSET[id] || 'utf8';
}

/**
 * MySQL 字符集名 → Node Buffer 支持的编码名
 *
 * Node 不认识 'utf8mb4' / 'utf8mb3'（会直接抛 Unknown encoding），
 * 它们都是 utf8 的超集/别名，统一映射到 'utf8'。
 * 不支持的（gbk/latin1 之外的）一律退回 utf8 并标记 uncertain，
 * 让上层能在输出里提示"该列编码未被精确处理"。
 */
function toNodeEncoding(charset) {
  if (!charset) return 'utf8';
  const c = String(charset).toLowerCase();
  if (c === 'utf8mb4' || c === 'utf8mb3' || c === 'utf8' || c === 'utf-8') return 'utf8';
  if (c === 'binary') return 'binary';
  if (c === 'latin1' || c === 'ascii' || c === 'ucs2' || c === 'utf16le') return c;
  if (c === 'gbk' || c === 'gb2312' || c === 'gb18030' || c === 'big5') {
    // Node 内置不支持 GBK 系；标注出来，按 utf8 尽力解码
    return 'utf8';
  }
  return 'utf8';
}

/** 该字符集是否能被 Node 精确解码 */
function isCharsetSupported(charset) {
  const c = String(charset || '').toLowerCase();
  return ['utf8mb4', 'utf8mb3', 'utf8', 'utf-8', 'binary', 'latin1', 'ascii', 'ucs2', 'utf16le'].includes(c);
}

/* ======================== 值解码 ======================== */

const TEXTY = new Set([
  FIELD_TYPE.VARCHAR, FIELD_TYPE.VAR_STRING, FIELD_TYPE.STRING,
  FIELD_TYPE.TINY_BLOB, FIELD_TYPE.MEDIUM_BLOB, FIELD_TYPE.LONG_BLOB, FIELD_TYPE.BLOB,
  FIELD_TYPE.ENUM, FIELD_TYPE.SET, FIELD_TYPE.BIT, FIELD_TYPE.GEOMETRY
]);

const NUMERIC = new Set([
  FIELD_TYPE.TINY, FIELD_TYPE.SHORT, FIELD_TYPE.LONG, FIELD_TYPE.INT24,
  FIELD_TYPE.LONGLONG, FIELD_TYPE.FLOAT, FIELD_TYPE.DOUBLE, FIELD_TYPE.YEAR
]);

const DATETIMEY = new Set([
  FIELD_TYPE.DATE, FIELD_TYPE.TIME, FIELD_TYPE.DATETIME,
  FIELD_TYPE.TIMESTAMP, FIELD_TYPE.NEWDATE
]);

/**
 * 把文本协议拿到的字符串按列类型转成 JS 值
 * @param {Buffer|null} raw  原始字节（null 表示 SQL NULL）
 * @param {number} type      field type
 * @param {number} flags     列标志位
 * @param {string} charset   字符集名
 * @param {object} opts      { dateStrings: boolean, bigIntAsString: boolean }
 */
function decodeValue(raw, type, flags, charset, opts = {}) {
  if (raw === null) return null;

  const unsigned = !!(flags & FLAG.UNSIGNED);
  const enc = toNodeEncoding(charset);

  /* 二进制/blob：不强转字符串，交给调用方决定（避免把图片塞进 JSON） */
  if (type === FIELD_TYPE.BLOB || type === FIELD_TYPE.LONG_BLOB ||
      type === FIELD_TYPE.MEDIUM_BLOB || type === FIELD_TYPE.TINY_BLOB ||
      type === FIELD_TYPE.GEOMETRY) {
    if (flags & FLAG.BINARY) return { $binary: true, bytes: raw.length };
    return raw.toString(enc);
  }

  if (TEXTY.has(type)) {
    const s = raw.toString(enc);
    if (type === FIELD_TYPE.BIT) {
      // BIT(n) 在文本协议下会以原始字节返回，转成整数更实用
      let v = 0n;
      for (const b of raw) v = (v << 8n) | BigInt(b);
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    }
    return s;
  }

  // 文本协议下数值/日期都是字符串形式
  const str = raw.toString('ascii');

  if (NUMERIC.has(type)) {
    if (type === FIELD_TYPE.FLOAT || type === FIELD_TYPE.DOUBLE) {
      const n = parseFloat(str);
      return Number.isNaN(n) ? str : n;
    }
    if (type === FIELD_TYPE.LONGLONG) {
      // 大整数：超出安全范围就保留字符串，避免精度悄悄丢失
      const n = Number(str);
      if (Number.isSafeInteger(n)) return n;
      return opts.bigIntAsString === false ? n : str;
    }
    const n = Number(str);
    return Number.isNaN(n) ? str : n;
  }

  if (type === FIELD_TYPE.DECIMAL || type === FIELD_TYPE.NEWDECIMAL) {
    // DECIMAL 必须避免二进制浮点误差：保留原始字符串最忠实
    return str;
  }

  if (type === FIELD_TYPE.JSON) {
    const s = raw.toString(enc);
    try { return JSON.parse(s); } catch (e) { return s; }
  }

  if (DATETIMEY.has(type)) {
    if (opts.dateStrings) return str;
    // 零值日期（'0000-00-00 00:00:00'）在 JS 里是 Invalid Date，保留字符串
    if (/^0{4}-0{2}-0{2}/.test(str)) return str;
    if (type === FIELD_TYPE.TIME) return str;      // TIME 可超 24h，交给调用方
    const iso = str.replace(' ', 'T');
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? str : d;
  }

  // 未知类型：优先当数字，否则当字符串
  const n = Number(str);
  return Number.isNaN(n) ? str : n;
}

/**
 * 解析结果集列定义包（COM_QUERY 响应里的 column definition 41）
 */
function parseColumnDefinition(reader) {
  reader.lenencStr();               // catalog（总是 "def"）
  const schema = reader.lenencStr(); // 库名
  const table = reader.lenencStr(); // 表别名
  const orgTable = reader.lenencStr(); // 原表名
  const name = reader.lenencStr();  // 列别名
  const orgName = reader.lenencStr(); // 原列名
  reader.lenencInt();               // 固定长度字段（0x0c）
  const charsetId = reader.u16();
  const columnLength = reader.u32();
  const type = reader.u8();
  const flags = reader.u16();
  const decimals = reader.u8();
  reader.skip(2);                   // filler

  return {
    schema, table, orgTable, name, orgName,
    charsetId, charset: charsetName(charsetId),
    columnLength, type, typeName: TYPE_NAME[type] || ('0x' + type.toString(16)),
    flags, decimals,
    unsigned: !!(flags & FLAG.UNSIGNED),
    notNull: !!(flags & FLAG.NOT_NULL),
    primaryKey: !!(flags & FLAG.PRI_KEY),
    autoIncrement: !!(flags & FLAG.AUTO_INCREMENT)
  };
}

module.exports = {
  FIELD_TYPE, TYPE_NAME, FLAG, CHARSET,
  charsetName, toNodeEncoding, isCharsetSupported,
  decodeValue, parseColumnDefinition,
  TEXTY, NUMERIC, DATETIMEY
};
