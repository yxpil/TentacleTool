'use strict';
/**
 * 表格类型推断：CSV 全文本 → 带类型的记录
 *
 * 设计原则：**保守优先**。误判类型比不推断更糟 ——
 * 一个被误判成数字的身份证号会让下游全部计算错误，而用户很难发现。
 *
 * 只推断：number / boolean / null
 * 默认不推断日期（`2026-09-18` 有歧义，且会破坏下游字符串比较）；
 * 开启 inferDates 后也只补一个 `_raw` 字段保留原始字符串。
 *
 * 大整数（超过 Number.MAX_SAFE_INTEGER）一律留字符串 —— 雪花 ID / 订单号是典型。
 * 前导零（007、0912）一律留字符串 —— 电话号码、编号、邮编。
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** 整数 token：不接受前导零（除单独的 "0"），不接受正号 */
const INT_RE = /^-?(0|[1-9]\d*)$/;
/** 小数：必须有小数点两侧的数字 */
const FLOAT_RE = /^-?(0|[1-9]\d*)\.\d+$/;
/** 科学计数：整数或小数 + eE */
const SCI_RE = /^-?(0|[1-9]\d*)(\.\d+)?[eE][+-]?\d+$/;
/** ISO 日期 / 日期时间 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

const NULL_TOKENS = new Set(['', 'null', 'NULL', 'Null', 'N/A', 'NA', 'n/a', '-']);
const TRUE_TOKENS = new Set(['true', 'TRUE', 'True']);
const FALSE_TOKENS = new Set(['false', 'FALSE', 'False']);

/**
 * 单个单元格 → { value, type }
 * 类型：'null' | 'boolean' | 'number' | 'string' | 'date'
 *
 * 注意 nullTokens 是可配的：CSV 里空字段到底是"缺失"还是"空字符串"，
 * 只有用户知道。默认把纯空字段当 null，但把 '-' / 'N/A' 这类保留为字符串，
 * 因为它们常是有意义的占位符。
 */
function inferCell(raw, opts = {}) {
  const s = raw === undefined || raw === null ? '' : String(raw);
  const trim = opts.trim !== false ? s.trim() : s;
  const nullTokens = opts.nullTokens || new Set(['']);

  if (nullTokens.has(trim)) return { value: null, type: 'null' };

  if (TRUE_TOKENS.has(trim)) return { value: true, type: 'boolean' };
  if (FALSE_TOKENS.has(trim)) return { value: false, type: 'boolean' };

  if (INT_RE.test(trim)) {
    const n = Number(trim);
    // 超过安全整数范围 → 保字符串（雪花 ID / 订单号）
    if (!Number.isSafeInteger(n)) return { value: trim, type: 'string', reason: 'integer-too-large' };
    return { value: n, type: 'number' };
  }
  if (FLOAT_RE.test(trim) || SCI_RE.test(trim)) {
    const n = Number(trim);
    if (!Number.isFinite(n)) return { value: trim, type: 'string', reason: 'not-finite' };
    return { value: n, type: 'number' };
  }

  if (opts.inferDates) {
    if (DATE_RE.test(trim) || DATETIME_RE.test(trim)) {
      return { value: trim, type: 'date', raw: s };
    }
  }

  return { value: s, type: 'string' };
}

/**
 * 根据整列的样本决定该列的统一类型。
 * 只在「整列（非空样本）都一致」时才升级类型，否则退回字符串。
 * 这是"保守优先"的核心：一列里只要有一个非数字，整列就不能当数字。
 */
function inferColumn(values, opts = {}) {
  const nonNull = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  const totalNonNull = nonNull.length;
  if (totalNonNull === 0) return { type: 'null', values: values.map(() => null), nullCount: values.length };

  const stats = { number: 0, boolean: 0, string: 0, date: 0, null: 0, forcedString: 0 };
  const converted = [];
  const nullTokens = opts.nullTokens || new Set(['']);
  const inferDates = !!opts.inferDates;
  const inferNumbers = opts.inferNumbers !== false;
  const inferBooleans = opts.inferBooleans !== false;

  for (const raw of values) {
    const r = inferCell(raw, { nullTokens, inferDates, trim: opts.trim });
    if (r.type === 'number' && !inferNumbers) converted.push({ value: String(raw), type: 'string' });
    else if (r.type === 'boolean' && !inferBooleans) converted.push({ value: String(raw), type: 'string' });
    else converted.push(r);
    if (r.reason) stats.forcedString++;
  }

  for (const c of converted) stats[c.type] = (stats[c.type] || 0) + 1;

  const candidates = ['number', 'boolean', 'date'];
  let chosen = 'string';
  for (const t of candidates) {
    if (stats[t] === totalNonNull) { chosen = t; break; }
  }
  // 全 null 列
  if (stats.null === values.length) return { type: 'null', values: values.map(() => null), nullCount: values.length };

  // 类型不统一时把已转换的值退回原始字符串（保持整列一致）
  if (chosen === 'string' && (stats.number > 0 || stats.boolean > 0)) {
    return {
      type: 'string',
      values: values.map(v => (v === null || v === undefined) ? null : String(v)),
      nullCount: stats.null,
      reason: 'mixed-types'
    };
  }

  return {
    type: chosen,
    values: converted.map(c => c.value),
    nullCount: stats.null,
    forcedString: stats.forcedString
  };
}

/**
 * 二维表（含可选表头）→ 记录数组 + 推断出的 schema
 * @param {string[][]} rows
 * @param {object} opts  header(string[]) / infer / inferDates / nullTokens / trim
 * @returns {{ records: object[], schema: object, columns: string[] }}
 */
function inferTable(rows, opts = {}) {
  const header = opts.header;
  const colCount = header ? header.length : Math.max(1, ...rows.map(r => r.length));
  const columns = header
    ? header.map((h, i) => String(h === undefined || h === null || String(h).trim() === '' ? `col${i + 1}` : h))
    : Array.from({ length: colCount }, (_, i) => `col${i + 1}`);

  // 列去重：重名加 _2 _3 后缀（否则转 JSON 时后者覆盖前者）
  const seen = new Map();
  const uniqueCols = columns.map(c => {
    const n = (seen.get(c) || 0) + 1;
    seen.set(c, n);
    return n === 1 ? c : `${c}_${n}`;
  });

  const infer = opts.infer !== false;
  const colValues = [];
  for (let c = 0; c < colCount; c++) {
    colValues.push(rows.map(r => (c < r.length ? r[c] : null)));
  }

  if (!infer) {
    return {
      columns: uniqueCols,
      records: rows.map(r => {
        const o = {};
        uniqueCols.forEach((name, i) => { o[name] = i < r.length ? r[i] : null; });
        return o;
      }),
      schema: { infer: false, columns: uniqueCols.map(n => ({ name: n, type: 'string' })) }
    };
  }

  const inferred = colValues.map(vals => inferColumn(vals, opts));

  const records = rows.map((r, ri) => {
    const o = {};
    uniqueCols.forEach((name, ci) => { o[name] = inferred[ci].values[ri]; });
    return o;
  });

  const schema = {
    infer: true,
    rowCount: rows.length,
    columnCount: colCount,
    columns: uniqueCols.map((name, i) => {
      const inf = inferred[i];
      const sample = inf.values.filter(v => v !== null).slice(0, 3);
      return {
        name,
        type: inf.type,
        nullable: inf.nullCount > 0,
        nullCount: inf.nullCount,
        sample,
        ...(inf.reason ? { note: inf.reason } : {}),
        ...(inf.forcedString ? { forcedString: inf.forcedString } : {})
      };
    })
  };

  return { columns: uniqueCols, records, schema };
}

/**
 * 从 JSON 记录数组反向推断 schema（用于 jsonx_schema 工具）
 * 比表格版更丰富：能表达嵌套结构与数组元素类型。
 */
function inferJsonSchema(value, opts = {}) {
  const maxDepth = opts.maxDepth || 6;
  const sampleLimit = opts.sampleLimit || 200;

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'object') return 'object';
    if (typeof v === 'string') return 'string';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'bigint') return 'integer';
    return typeof v;
  }

  /** 合并一组类型描述（用于数组元素） */
  function unify(descs) {
    // 空数组贡献的 `unknown` 不是真实类型，必须剔除，
    // 否则 `[{tags:['x']}, {tags:[]}]` 会得到 array<string | unknown> —— 一个假类型。
    const meaningful = descs.filter(d => d && !(d.type === 'unknown' && d.empty));
    const pool0 = meaningful.length ? meaningful : descs;
    const nonNull = pool0.filter(d => d.type !== 'null');
    const pool = nonNull.length ? nonNull : pool0;
    const types = [...new Set(pool.map(d => d.type))];
    if (types.length === 1) {
      const merged = { type: types[0] };
      const objs = pool.filter(d => d.type === 'object');
      if (objs.length) {
        merged.properties = mergeProperties(objs);
        merged.optionalKeys = optionalKeysOf(objs);
      }
      if (types[0] === 'array') {
        merged.items = unify(pool.map(d => d.items).filter(Boolean));
      }
      const anys = pool.filter(d => d.enum);
      if (anys.length === pool.length) {
        // 枚举取并集，而不是拿第一份 —— 否则只会看到 'a' 而漏掉 'b'、'c'
        merged.enum = [...new Set(pool.flatMap(d => d.enum))].sort();
      }
      return merged;
    }
    // 混合类型
    const objs = pool.filter(d => d.type === 'object');
    if (objs.length === pool.length) {
      return { type: 'object', properties: mergeProperties(objs), optionalKeys: optionalKeysOf(objs) };
    }
    if (pool.every(d => d.type === 'integer' || d.type === 'number')) return { type: 'number' };
    return { type: types };
  }

  function mergeProperties(objs) {
    const keys = [...new Set(objs.flatMap(o => Object.keys(o.properties || {})))];
    const out = {};
    for (const k of keys) {
      out[k] = unify(objs.map(o => o.properties[k]).filter(Boolean));
    }
    return out;
  }

  function optionalKeysOf(objs) {
    const keys = [...new Set(objs.flatMap(o => Object.keys(o.properties || {})))];
    return keys.filter(k => objs.some(o => !o.properties || !(k in o.properties)));
  }

  function walk(v, depth) {
    if (depth > maxDepth) return { type: typeOf(v), note: 'max-depth-reached' };
    const t = typeOf(v);
    if (t === 'array') {
      // 空数组没有任何元素可供推断。这里**不造 `unknown` 类型**，只标记 empty，
      // 由 unify 忽略其贡献 —— 否则 `[{tags:['x']}, {tags:[]}]` 会得到
      // array<string | unknown> 这个并不存在的假类型。
      if (v.length === 0) return { type: 'array', empty: true, length: 0 };
      const sampled = v.slice(0, sampleLimit);
      const itemDescs = sampled.map(x => walk(x, depth + 1));
      const u = unify(itemDescs);
      // 全字符串且基数小 → 给枚举候选
      if (u.type === 'string' && opts.enumMaxCardinality) {
        const uniq = [...new Set(sampled)];
        if (uniq.length <= opts.enumMaxCardinality) u.enum = uniq.sort();
      }
      return { type: 'array', length: v.length, items: u, ...(v.length > sampleLimit ? { sampledItems: sampleLimit } : {}) };
    }
    if (t === 'object') {
      const props = {};
      const keys = Object.keys(v);
      for (const k of keys) props[k] = walk(v[k], depth + 1);
      return { type: 'object', properties: props, propertyCount: keys.length };
    }
    const d = { type: t };
    if (t === 'string' && opts.enumMaxCardinality !== undefined) {
      d.enum = [v];
    }
    return d;
  }

  const desc = walk(value, 0);

  // 顶层若是对象数组，额外给出"记录集"视角，这是最常见的用途
  let records = null;
  if (Array.isArray(value) && value.length && value.every(x => x !== null && typeof x === 'object' && !Array.isArray(x))) {
    records = {
      rowCount: value.length,
      fields: mergeProperties(value.slice(0, sampleLimit).map(x => walk(x, 0))),
    };
    const keys = [...new Set(value.flatMap(x => Object.keys(x)))];
    records.optionalFields = keys.filter(k => value.some(x => !(k in x)));
    records.totalFields = keys.length;
  }

  return { schema: desc, records };
}

/** 根据样本推断一个值的"紧凑类型标签"（给表格展示用） */
function shortType(desc) {
  if (!desc) return '?';
  if (Array.isArray(desc.type)) return desc.type.join(' | ');
  if (desc.type === 'array') return 'array<' + shortType(desc.items) + '>';
  if (desc.type === 'object') {
    if (desc.properties) return 'object{' + Object.keys(desc.properties).length + '}';
    return 'object';
  }
  return desc.type;
}

module.exports = {
  MAX_SAFE,
  INT_RE,
  FLOAT_RE,
  SCI_RE,
  DATE_RE,
  DATETIME_RE,
  NULL_TOKENS,
  inferCell,
  inferColumn,
  inferTable,
  inferJsonSchema,
  shortType
};
