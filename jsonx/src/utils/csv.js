'use strict';
/**
 * CSV / TSV 状态机解析与序列化（RFC 4180 超集）
 *
 * 为什么不用 split(',')：
 *   引号内的分隔符、引号内的换行、转义引号 "" 三种情况 split 全崩，
 *   而这三者在真实导出文件（Excel / 数据库 dump）里极其常见。
 *
 * 支持的约定：
 *   - 可配置分隔符（, ; \t |），**引号内的分隔符不生效**
 *   - 双引号包裹字段，内部 "" 表示一个字面量 "
 *   - 字段内可含换行（CRLF / LF / CR 均保留原样）
 *   - 引号外的行尾：CRLF / LF / CR 都当行尾
 *   - 末尾空字段保留：'a,b,' → ['a','b','']（3 个字段）
 *   - 每行记录源行号，报错可定位到具体单元格
 *
 * 明确不做（已在 README 声明）：
 *   - 不做字段类型推断（那是 infer.js 的职责，与本层解耦）
 *   - 不支持 Excel 的 ="..." 公式包裹形式
 */

const DEFAULT_DELIMITERS = [',', ';', '\t', '|'];

/** 分隔符别名 → 实际字符 */
const DELIMITER_ALIASES = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
  tsv: '\t',
  pipe: '|',
  space: ' ',
  '\\t': '\t'
};

/** 把用户传的分隔符（可能是别名 / 转义写法）归一成单字符 */
function resolveDelimiter(input) {
  if (input === undefined || input === null || input === '') return ',';
  let d = String(input);
  if (Object.prototype.hasOwnProperty.call(DELIMITER_ALIASES, d.toLowerCase())) {
    return DELIMITER_ALIASES[d.toLowerCase()];
  }
  if (d === '\\t') return '\t';
  if (d.length > 1) {
    throw new Error(`分隔符必须是单个字符，收到 "${input}"（可用别名：comma / semicolon / tab / pipe）`);
  }
  return d;
}

/**
 * 嗅探文本最可能的列分隔符。
 * 策略：候选分隔符各自解析前若干行，取「字段数 > 1 且各行字段数最一致」的那个；
 * 一致性优先于字段数，避免把含逗号的长句子误判成 CSV。
 */
function sniffDelimiter(text, opts = {}) {
  const sample = String(text || '').slice(0, opts.sampleChars || 20000);
  const candidates = opts.candidates || DEFAULT_DELIMITERS;
  const lines = sample.split(/\r\n|\n|\r/).filter(l => l.trim() !== '').slice(0, 12);
  if (lines.length === 0) return { delimiter: ',', confidence: 0, reason: '样本为空' };

  let best = null;
  for (const d of candidates) {
    let counts;
    try {
      counts = lines.map(l => {
        const r = parseCsv(l, { delimiter: d });
        return r.rows.length ? r.rows[0].length : 0;
      });
    } catch (e) { continue; }
    const maxCols = Math.max(...counts);
    if (maxCols <= 1) continue;
    const freq = {};
    for (const c of counts) freq[c] = (freq[c] || 0) + 1;
    const consistent = Math.max(...Object.values(freq));
    const ratio = consistent / counts.length;
    // 得分：一致行占比为主，列数为辅（防止单列文件胜出）
    const score = ratio * 100 + Math.min(maxCols, 20);
    if (!best || score > best.score) {
      best = { delimiter: d, score, cols: maxCols, ratio, consistent, total: counts.length };
    }
  }
  if (!best) return { delimiter: ',', confidence: 0, reason: '所有候选分隔符都解析出单列' };
  return {
    delimiter: best.delimiter,
    confidence: Number(best.ratio.toFixed(2)),
    detectedColumns: best.cols,
    consistentRows: best.consistent,
    totalRows: best.total,
    reason: `候选分隔符中 ${JSON.stringify(best.delimiter)} 的列数一致性最高（${best.consistent}/${best.total} 行）`
  };
}

/**
 * 核心：把 CSV 文本解析成二维数组
 *
 * @param {string} text
 * @param {object} opts
 *   delimiter  分隔符（默认 ','）
 *   quote      引号字符（默认 '"'）
 *   header     是否把首行当表头（默认 false，调用方决定）
 *   skipEmpty  跳过完全空白的行（默认 true）
 *   comment    行首注释符（如 '#'），处于行首时整行忽略
 * @returns {{ rows: string[][], header: string[]|null, lineNumbers: number[], warnings: string[], meta: object }}
 */
function parseCsv(text, opts = {}) {
  const src = String(text === undefined || text === null ? '' : text);
  const delimiter = resolveDelimiter(opts.delimiter);
  const quote = opts.quote || '"';
  const skipEmpty = opts.skipEmpty !== false;
  const comment = opts.comment || null;
  const maxRows = opts.maxRows || 0;

  const rows = [];
  const lineNumbers = [];
  const warnings = [];

  let field = '';
  let row = [];
  let inQuotes = false;
  let line = 1;
  let fieldStartLine = 1;
  let atLineStart = true;
  let rowHasContent = false;
  let pendingComment = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };

  const pushRow = () => {
    pushField();
    const isEmpty = row.every(c => c === '');
    // 表头行豁免 skipEmpty —— 否则全空表头会静默把数据顶到第一行
    if (!(skipEmpty && isEmpty)) {
      rows.push(row);
      lineNumbers.push(fieldStartLine);
    }
    row = [];
    rowHasContent = false;
    fieldStartLine = line;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === quote) {
        if (src[i + 1] === quote) { field += quote; i++; }
        else { inQuotes = false; }
      } else {
        if (ch === '\n') line++;
        field += ch;   // 引号内换行原样保留
      }
      continue;
    }

    // 行首注释：仅在字段完全未开始时生效
    if (comment && atLineStart && field === '' && row.length === 0 && ch === comment) {
      pendingComment = true;
      atLineStart = false;
      continue;
    }
    if (pendingComment) {
      if (ch === '\n' || ch === '\r') {
        pendingComment = false;
        if (ch === '\r' && src[i + 1] === '\n') i++;
        line++;
        atLineStart = true;
        fieldStartLine = line;
      }
      continue;
    }

    if (ch === quote && field === '') {
      inQuotes = true;
      atLineStart = false;
      rowHasContent = true;
      continue;
    }

    if (ch === quote) {
      // 字段中间出现裸引号：宽容处理并告警，不中断整个解析
      warnings.push(`第 ${line} 行：未加引号的字段中间出现 ${JSON.stringify(quote)}，已按字面量处理`);
      field += quote;
      continue;
    }

    if (ch === delimiter) {
      pushField();
      atLineStart = false;
      rowHasContent = true;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      pushRow();
      line++;
      atLineStart = true;
      fieldStartLine = line;
      continue;
    }

    field += ch;
    atLineStart = false;
    rowHasContent = true;
  }

  // 收尾：文件末尾没有换行时仍有最后一行
  if (inQuotes) {
    // 引号未闭合：把已读内容落盘并明确告警，而不是静默丢弃整行
    warnings.push(`第 ${fieldStartLine} 行起：引号未闭合，已按文件末尾截断处理`);
    pushRow();
  } else if (field !== '' || row.length > 0 || rowHasContent) {
    pushRow();
  }

  let header = null;
  if (opts.header && rows.length > 0) {
    header = rows.shift();
    lineNumbers.shift();
  }

  // ★ 必须在 slice 之前记录真实总数。
  // 踩过的坑：原写法在 return 里算 `rows.length + truncated`，但 rows 此时
  // 已被 slice 成截断后的数组，导致 totalDataRows 把被丢掉的行数重复计一遍
  // （4 行截成 2 行会报 total=6）。
  const totalDataRows = rows.length;

  let outRows = rows;
  let outLineNumbers = lineNumbers;
  let truncated = 0;
  if (maxRows > 0 && rows.length > maxRows) {
    truncated = rows.length - maxRows;
    outRows = rows.slice(0, maxRows);
    outLineNumbers = lineNumbers.slice(0, maxRows);
    warnings.push(`数据行超过 maxRows=${maxRows}，已截断 ${truncated} 行`);
  }

  const colCount = Math.max(0, ...outRows.map(r => r.length), header ? header.length : 0);
  const ragged = outRows.filter(r => r.length !== colCount).length;

  return {
    rows: outRows,
    header,
    lineNumbers: outLineNumbers,
    warnings,
    meta: {
      delimiter,
      delimiterLabel: labelDelimiter(delimiter),
      columns: colCount,
      rowCount: outRows.length,
      totalDataRows,
      truncated,
      raggedRows: ragged,
      quotedFields: countQuoted(src, delimiter, quote)
    }
  };
}

function labelDelimiter(d) {
  if (d === '\t') return 'tab';
  if (d === ',') return 'comma';
  if (d === ';') return 'semicolon';
  if (d === '|') return 'pipe';
  if (d === ' ') return 'space';
  return d;
}

/**
 * 统计被引号包裹的字段数（用于报告"这份 CSV 用了多少引号"）。
 * 注意：必须在字段起点遇到引号才计一次（与 parseCsv 的 `ch === quote && field === ''` 判定一致），
 * 否则字段中间的裸引号会被重复计数。
 */
function countQuoted(src, delimiter, quote) {
  let n = 0, field = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === quote) {
        if (src[i + 1] === quote) { i++; continue; }   // 转义引号，仍在本字段内
        inQ = false;
      }
      continue;
    }
    if (ch === quote && field === '') { inQ = true; n++; continue; }
    if (ch === delimiter || ch === '\n' || ch === '\r') { field = ''; continue; }
    field += ch;   // 不忽略空白，否则 " a" 与 "a" 的判定会不一致
  }
  return n;
}

/**
 * 一个字段需不需要引号包裹（RFC 4180 的 MINIMAL 策略）
 * 含分隔符 / 引号 / 换行 / 首尾空白时必须包裹 —— 首尾空白不包裹会在往返时丢失。
 */
function needsQuote(s, delimiter) {
  if (s === '') return false;
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) return true;
  if (/^[\s]|[\s]$/.test(s)) return true;
  return false;
}

function escapeField(s, delimiter) {
  const str = s === undefined || s === null ? '' : String(s);
  if (!needsQuote(str, delimiter)) return str;
  return '"' + str.replace(/"/g, '""') + '"';
}

/**
 * 二维数组 → CSV 文本
 * @param {Array<Array<any>>} rows
 * @param {object} opts  delimiter / header / eol / trailingNewline
 */
function stringifyCsv(rows, opts = {}) {
  const delimiter = resolveDelimiter(opts.delimiter);
  const eol = opts.eol || '\r\n';
  const out = [];
  if (opts.header && Array.isArray(opts.header)) {
    out.push(opts.header.map(h => escapeField(h, delimiter)).join(delimiter));
  }
  for (const r of rows) {
    if (r === null || r === undefined) { out.push(''); continue; }
    if (!Array.isArray(r)) {
      throw new Error(`stringifyCsv 需要二维数组，收到 ${typeof r}（值: ${JSON.stringify(r)}）`);
    }
    out.push(r.map(c => escapeField(c, delimiter)).join(delimiter));
  }
  const text = out.join(eol);
  return opts.trailingNewline === false ? text : text + eol;
}

/** 按分隔符猜测文件的"表格形状"描述，给 Agent 一眼看懂 */
function describeShape(meta) {
  const parts = [`${meta.rowCount} 行 × ${meta.columns} 列`];
  if (meta.header) parts.push('含表头');
  if (meta.raggedRows > 0) parts.push(`${meta.raggedRows} 行列数不齐`);
  return parts.join('，');
}

module.exports = {
  DEFAULT_DELIMITERS,
  DELIMITER_ALIASES,
  resolveDelimiter,
  labelDelimiter,
  sniffDelimiter,
  parseCsv,
  stringifyCsv,
  escapeField,
  needsQuote,
  describeShape
};
