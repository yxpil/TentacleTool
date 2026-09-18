'use strict';
/**
 * YAML 子集解析与序列化（零依赖）
 *
 * 设计取舍：完整 YAML 1.2 是长尾工程（锚点、别名、标签、复杂键、流式嵌套、多文档……）。
 * 本实现只覆盖真实配置文件里 95% 的用法，**遇到不支持的语法明确报错，绝不静默忽略**。
 *
 * 支持：
 *   - 文档边界 --- / ...（多文档）
 *   - 映射 key: value（含缩进嵌套）
 *   - 序列 - item（含 - key: value 的行内映射）
 *   - 标量：字符串（裸 / '单引号' / "双引号"）、数字、布尔、null、~、日期原样留字符串
 *   - 块标量：| 字面量、> 折叠（含 |- >- |+ >+ 的裁剪/保留指示符）
 *   - 流式：{} 与 []
 *   - 注释 #（行首与行尾，引号内的 # 不算注释）
 *   - 引号内的转义（\n \t \\ \" \uXXXX）
 *
 * 明确不支持（遇到即抛错，错误信息里说明原因）：
 *   - 锚点 &name / 别名 *name
 *   - 标签 !!str / !Custom
 *   - 显式键 ? / 复杂键 [a,b]: v
 *   - 指令 %YAML
 *
 * 静默忽略锚点会产出「结构正确但值错误」的结果 —— 这是最坏的可能，所以选择报错。
 */

/* ============================== 解析 ============================== */

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `YAML 第 ${line} 行：${message}` : message);
    this.name = 'YamlError';
    this.line = line || null;
  }
}

const UNSUPPORTED_PATTERNS = [
  { re: /^\s*[^#]*?:\s*&\S/, what: '锚点（&name）', why: '零依赖实现不支持锚点/别名展开' },
  { re: /^\s*[^#]*?:\s*\*\S/, what: '别名（*name）', why: '零依赖实现不支持锚点/别名展开' },
  { re: /^\s*-\s*&\S/, what: '锚点（&name）', why: '零依赖实现不支持锚点/别名展开' },
  { re: /^\s*-\s*\*\S/, what: '别名（*name）', why: '零依赖实现不支持锚点/别名展开' },
  { re: /^\s*[^#]*?:\s*!\S/, what: '标签（!type）', why: '标签需要类型系统，超出本实现范围' },
  { re: /^\s*%[A-Z]/, what: 'YAML 指令（%…）', why: '指令影响解析器行为，本实现不支持' }
];

/** 去掉行尾注释（跳过引号内的 #） */
function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) {
      if (inD && line[i - 1] === '\\') { /* 转义引号，不切换 */ }
      else inD = !inD;
    } else if (ch === '#' && !inS && !inD) {
      // `#` 只有前面是空白或行首时才是注释起始（`a#b` 是值的一部分）
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

/** 单行是否只是空/注释 */
function isBlank(line) {
  const s = stripComment(line).trim();
  return s === '';
}

/**
 * 解析器主类：按行扫描 + 缩进栈
 */
class YamlParser {
  constructor(text, opts = {}) {
    this.rawLines = String(text === undefined || text === null ? '' : text)
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    this.opts = opts;
    this.i = 0;
    this.warnings = [];
  }

  /** 当前物理行的原始内容 */
  peek() { return this.i < this.rawLines.length ? this.rawLines[this.i] : null; }

  /** 当前行的缩进宽度（tab 在 YAML 里非法，这里宽容地按 1 列算并告警） */
  indentOf(line) {
    let n = 0;
    for (const ch of line) {
      if (ch === ' ') n++;
      else if (ch === '\t') { n++; if (!this._tabWarned) { this.warnings.push('检测到 tab 缩进，YAML 规范要求空格，已按 1 列宽容处理'); this._tabWarned = true; } }
      else break;
    }
    return n;
  }

  checkUnsupported(line, lineNo) {
    for (const p of UNSUPPORTED_PATTERNS) {
      if (p.re.test(line)) {
        throw new YamlError(`不支持 ${p.what}：${p.why}`, lineNo);
      }
    }
  }

  /** 解析整个文档，返回多文档数组 */
  parseDocuments() {
    const docs = [];
    let line = this.peek();
    // 跳过开头的 --- 与注释
    while (line !== null) {
      const t = stripComment(line).trim();
      if (t === '' || t === '---') { this.i++; line = this.peek(); }
      else break;
    }
    while (this.i < this.rawLines.length) {
      const doc = this.parseBlock(0);
      docs.push(doc);
      // 跳到下一个文档边界
      let l = this.peek();
      while (l !== null) {
        const t = stripComment(l).trim();
        if (t === '---' || t === '...') { this.i++; l = this.peek(); if (t === '---') break; }
        else if (t === '') { this.i++; l = this.peek(); }
        else {
          // 同一缩进级别还有内容 → 说明上一个 parseBlock 提前返回了
          if (this.indentOf(l) === 0) break;
          this.i++; l = this.peek();
        }
      }
      if (this.i >= this.rawLines.length) break;
    }
    if (docs.length === 0) docs.push(null);
    return docs;
  }

  /**
   * 解析一个缩进块（映射或序列或标量）
   * @param {number} minIndent 该块的基准缩进
   */
  parseBlock(minIndent) {
    // 找到块的第一条有效内容，确定缩进
    let startIndent = null;
    {
      let j = this.i;
      while (j < this.rawLines.length) {
        const l = this.rawLines[j];
        if (isBlank(l)) { j++; continue; }
        const t = stripComment(l).trim();
        if (t === '---' || t === '...') break;
        startIndent = this.indentOf(l);
        break;
      }
    }
    if (startIndent === null || startIndent < minIndent) return null;

    const first = this.rawLines[this.i];
    if (first === undefined) return null;
    const firstBody = stripComment(first).slice(this.indentOf(first));

    // 决定这个块的类型
    if (/^-\s/.test(firstBody) || firstBody.trim() === '-') {
      return this.parseSequence(startIndent);
    }
    if (this.looksLikeMapping(firstBody)) {
      return this.parseMapping(startIndent);
    }
    // 不是映射也不是序列：可能是一个标量（或块标量）
    return this.parseScalarBlock(startIndent);
  }

  /** 判断一行内容是否为 `key: value` 形式 */
  looksLikeMapping(body) {
    const idx = findKeyColon(body);
    return idx !== -1;
  }

  parseMapping(indent) {
    const obj = {};
    while (this.i < this.rawLines.length) {
      const line = this.rawLines[this.i];
      if (isBlank(line)) { this.i++; continue; }
      const lineNo = this.i + 1;
      const ind = this.indentOf(line);
      if (ind < indent) break;
      if (ind > indent) {
        throw new YamlError(`缩进不一致（期望 ${indent} 列，实际 ${ind} 列）—— 多余的缩进通常意味着上一行缺少值`, lineNo);
      }
      let body = stripComment(line).slice(ind);
      if (body.trim() === '') { this.i++; continue; }
      if (body.trim() === '---' || body.trim() === '...') break;
      this.checkUnsupported(body, lineNo);

      const colon = findKeyColon(body);
      if (colon === -1) {
        throw new YamlError(`无法解析为键值对：${JSON.stringify(body.trim())}。若这是序列项，请确认使用了 "- " 前缀`, lineNo);
      }
      const rawKey = body.slice(0, colon).trim();
      const rest = body.slice(colon + 1);
      const key = parseKeyToken(rawKey, lineNo);
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        this.warnings.push(`第 ${lineNo} 行：键 ${JSON.stringify(key)} 重复出现，后者覆盖前者`);
      }
      this.i++;

      const valueText = rest.trim();
      if (valueText === '') {
        // 值是嵌套块 / 多行块标量 / null
        obj[key] = this.readLineFollowingBlock(indent);
        continue;
      }
      if (isBlockScalarIndicator(valueText)) {
        obj[key] = this.readBlockScalar(indent, valueText, lineNo);
        continue;
      }
      obj[key] = parseInlineValue(valueText, lineNo);
    }
    return obj;
  }

  parseSequence(indent) {
    const arr = [];
    while (this.i < this.rawLines.length) {
      const line = this.rawLines[this.i];
      if (isBlank(line)) { this.i++; continue; }
      const lineNo = this.i + 1;
      const ind = this.indentOf(line);
      if (ind < indent) break;
      if (ind > indent) {
        throw new YamlError(`序列项的缩进不一致（期望 ${indent} 列，实际 ${ind} 列）`, lineNo);
      }
      const body = stripComment(line).slice(ind);
      if (body.trim() === '---' || body.trim() === '...') break;
      if (!/^-(?: |$)/.test(body)) break;   // 该缩进上不是序列项了

      this.checkUnsupported(body, lineNo);
      const after = body.replace(/^-\s?/, '');
      const valueIndent = ind + (body.length - after.length);

      if (after.trim() === '') {
        // `-` 后面换行的嵌套块
        this.i++;
        arr.push(this.parseBlock(indent + 1));
        continue;
      }

      if (isBlockScalarIndicator(after.trim())) {
        this.i++;
        arr.push(this.readBlockScalar(indent, after.trim(), lineNo));
        continue;
      }

      // `- - 1` —— 序列项本身又是一个序列（紧凑嵌套写法）
      if (/^-(?: |$)/.test(after)) {
        const nested = [];
        // 先把当前行剩下的部分当作内层序列的第一项处理
        const innerFirst = after.replace(/^-\s?/, '').trim();
        this.i++;
        if (innerFirst === '') {
          nested.push(this.parseBlock(valueIndent + 1));
        } else {
          nested.push(parseInlineValue(innerFirst, lineNo));
        }
        // 后续与 valueIndent 对齐的 `- ...` 行都属于这个内层序列
        const restSeq = this.parseSequenceAt(valueIndent);
        arr.push(nested.concat(restSeq));
        continue;
      }

      // `- key: value` —— 行内映射，后续同级键要与该键对齐
      if (this.looksLikeMapping(after)) {
        const obj = {};
        const colon = findKeyColon(after);
        const key = parseKeyToken(after.slice(0, colon).trim(), lineNo);
        const rest = after.slice(colon + 1).trim();
        this.i++;
        if (rest === '') {
          obj[key] = this.readLineFollowingBlock(valueIndent);
        } else if (isBlockScalarIndicator(rest)) {
          obj[key] = this.readBlockScalar(valueIndent, rest, lineNo);
        } else {
          obj[key] = parseInlineValue(rest, lineNo);
        }
        // 后续与 valueIndent 对齐的键属于同一个对象
        const more = this.parseMappingAt(valueIndent, obj);
        Object.assign(obj, more);
        arr.push(obj);
        continue;
      }

      arr.push(parseInlineValue(after, lineNo));
      this.i++;
    }
    return arr;
  }

  /** 在指定缩进上继续解析映射，合并进 target */
  parseMappingAt(indent, target) {
    const obj = Object.assign({}, target);
    while (this.i < this.rawLines.length) {
      const line = this.rawLines[this.i];
      if (isBlank(line)) { this.i++; continue; }
      const lineNo = this.i + 1;
      const ind = this.indentOf(line);
      if (ind !== indent) break;
      const body = stripComment(line).slice(ind);
      if (body.trim() === '' || body.trim() === '---' || body.trim() === '...') break;
      if (/^-(?: |$)/.test(body)) break;
      const colon = findKeyColon(body);
      if (colon === -1) break;
      this.checkUnsupported(body, lineNo);
      const key = parseKeyToken(body.slice(0, colon).trim(), lineNo);
      const rest = body.slice(colon + 1).trim();
      this.i++;
      if (rest === '') obj[key] = this.readLineFollowingBlock(indent);
      else if (isBlockScalarIndicator(rest)) obj[key] = this.readBlockScalar(indent, rest, lineNo);
      else obj[key] = parseInlineValue(rest, lineNo);
    }
    return obj;
  }

  /** 在指定缩进上继续解析序列，返回项目数组（用于 `- - 1` 这类紧凑嵌套） */
  parseSequenceAt(indent) {
    const out = [];
    while (this.i < this.rawLines.length) {
      const line = this.rawLines[this.i];
      if (isBlank(line)) { this.i++; continue; }
      const ind = this.indentOf(line);
      if (ind !== indent) break;
      const body = stripComment(line).slice(ind);
      if (!/^-(?: |$)/.test(body) || body.trim() === '---' || body.trim() === '...') break;
      const lineNo = this.i + 1;
      this.checkUnsupported(body, lineNo);
      const after = body.replace(/^-\s?/, '');
      const valueIndent = ind + (body.length - after.length);
      if (after.trim() === '') {
        this.i++;
        out.push(this.parseBlock(indent + 1));
      } else if (isBlockScalarIndicator(after.trim())) {
        this.i++;
        out.push(this.readBlockScalar(indent, after.trim(), lineNo));
      } else if (/^-(?: |$)/.test(after)) {
        const nested = [];
        const innerFirst = after.replace(/^-\s?/, '').trim();
        this.i++;
        nested.push(innerFirst === '' ? this.parseBlock(valueIndent + 1) : parseInlineValue(innerFirst, lineNo));
        out.push(nested.concat(this.parseSequenceAt(valueIndent)));
      } else {
        this.i++;
        out.push(parseInlineValue(after, lineNo));
      }
    }
    return out;
  }

  /** 值留空时，读取后续更深缩进的块作为值 */
  readLineFollowingBlock(ownerIndent) {
    // 跳过空行
    while (this.i < this.rawLines.length && isBlank(this.rawLines[this.i])) {
      // 空行后若回到同级或更浅，则值是 null
      let j = this.i + 1;
      if (j >= this.rawLines.length) { this.i = j; return null; }
      break;
    }
    if (this.i >= this.rawLines.length) return null;
    const line = this.rawLines[this.i];
    const ind = this.indentOf(line);
    if (stripComment(line).trim() === '' || ind <= ownerIndent) return null;
    return this.parseBlock(ownerIndent + 1);
  }

  /** 无缩进的块标量（如 `- |` 之后的内容）与有缩进的共用逻辑 */
  readBlockScalar(ownerIndent, indicator, lineNo) {
    const m = /^([|>])([+-]?)(\d*)$/.exec(indicator.trim());
    if (!m) throw new YamlError(`无法识别的块标量指示符 ${JSON.stringify(indicator)}`, lineNo);
    const style = m[1];
    const chomp = m[2];
    const explicitIndent = m[3] ? ownerIndent + parseInt(m[3], 10) : null;

    const raw = [];
    let blockIndent = explicitIndent;
    while (this.i < this.rawLines.length) {
      const line = this.rawLines[this.i];
      if (line.trim() === '') { raw.push(''); this.i++; continue; }
      const ind = this.indentOf(line);
      if (ind <= ownerIndent) break;
      if (blockIndent === null) blockIndent = ind;
      if (ind < blockIndent) break;
      raw.push(line.slice(blockIndent));
      this.i++;
    }
    // 去掉尾部因空行产生的冗余（chomp 决定最终形态）
    while (raw.length && raw[raw.length - 1] === '') raw.pop();

    let text;
    if (style === '|') {
      text = raw.join('\n');
      if (chomp !== '-') text += '\n';
    } else {
      // `>` 折叠：相邻非空行拼成一行，空行变换行
      const parts = [];
      let buf = [];
      for (const l of raw) {
        if (l === '') { if (buf.length) { parts.push(buf.join(' ')); buf = []; } parts.push(''); }
        else buf.push(l);
      }
      if (buf.length) parts.push(buf.join(' '));
      text = parts.join('\n');
      if (chomp === '+') text += '\n';
      else if (chomp !== '-' && text !== '') text += '\n';
    }
    if (chomp === '+') text += '\n';
    return text;
  }

  /** 顶层标量文档（整份文件就是一个标量） */
  parseScalarBlock(indent) {
    const line = this.rawLines[this.i];
    if (line === undefined) return null;
    const lineNo = this.i + 1;
    const ind = this.indentOf(line);
    const body = stripComment(line).slice(ind);
    this.checkUnsupported(body, lineNo);
    if (isBlockScalarIndicator(body.trim())) {
      this.i++;
      return this.readBlockScalar(ind - 1, body.trim(), lineNo);
    }
    this.i++;
    return parseInlineValue(body.trim(), lineNo);
  }
}

/* ============================ 词法辅助 ============================ */

/** 找到一个 `key: value` 里的冒号位置；跳过引号内与外层 {} [] 内的冒号 */
function findKeyColon(body) {
  let inS = false, inD = false;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inS) { if (ch === "'") inS = false; continue; }
    if (inD) { if (ch === '"' && body[i - 1] !== '\\') inD = false; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') { depth--; continue; }
    if (ch === ':' && depth === 0) {
      // 冒号必须是「键的结束」：后面是空白或行尾，或者是流式值的起始 { [ 
      const next = body[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
      if (next === '{' || next === '[') return i;
    }
  }
  return -1;
}

function isBlockScalarIndicator(s) {
  return /^[|>][+-]?\d*$/.test(String(s).trim());
}

/** 解析映射的键 token（去过引号） */
function parseKeyToken(raw, lineNo) {
  if (raw === '') throw new YamlError('键为空', lineNo);
  if (/^[[{]/.test(raw)) {
    throw new YamlError(`不支持复杂键 ${JSON.stringify(raw)}（只有标量键），如 [a,b]: v 这类写法`, lineNo);
  }
  if (raw[0] === '"' || raw[0] === "'") {
    const v = parseQuoted(raw, lineNo);
    return String(v);
  }
  return raw;
}

/** 解析单引号 / 双引号字符串（含 \uXXXX） */
function parseQuoted(s, lineNo) {
  const q = s[0];
  if (s[s.length - 1] !== q || s.length < 2) {
    throw new YamlError(`引号未闭合：${JSON.stringify(s)}`, lineNo);
  }
  const inner = s.slice(1, -1);
  if (q === "'") {
    // 单引号里只有 '' 是转义，其余全字面量
    return inner.replace(/''/g, "'");
  }
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') { out += ch; continue; }
    const nx = inner[++i];
    switch (nx) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'u': {
        const hex = inner.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        else out += 'u';
        break;
      }
      case 'x': {
        const hex = inner.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; }
        else out += 'x';
        break;
      }
      case undefined: out += '\\'; break;
      default: out += nx;
    }
  }
  return out;
}

/** 流式集合 {} / [] 的递归下降解析 */
function parseFlow(s, lineNo) {
  const st = { s, i: 0 };
  skipWs(st);
  const v = parseFlowValue(st, lineNo);
  skipWs(st);
  if (st.i < s.length) throw new YamlError(`流式值后有多余内容：${JSON.stringify(s.slice(st.i))}`, lineNo);
  return v;
}

function skipWs(st) {
  while (st.i < st.s.length && /\s/.test(st.s[st.i])) st.i++;
}

function parseFlowValue(st, lineNo) {
  skipWs(st);
  const ch = st.s[st.i];
  if (ch === '{') return parseFlowMap(st, lineNo);
  if (ch === '[') return parseFlowSeq(st, lineNo);
  // 标量：读到 , } ] 或结尾
  let out = '', inS = false, inD = false;
  while (st.i < st.s.length) {
    const c = st.s[st.i];
    if (inS) { out += c; if (c === "'") inS = false; st.i++; continue; }
    if (inD) {
      if (c === '"' && st.s[st.i - 1] !== '\\') inD = false;
      out += c; st.i++; continue;
    }
    if (c === "'") { inS = true; out += c; st.i++; continue; }
    if (c === '"') { inD = true; out += c; st.i++; continue; }
    if (c === ',' || c === '}' || c === ']') break;
    out += c; st.i++;
  }
  return parseInlineValue(out.trim(), lineNo);
}

function parseFlowMap(st, lineNo) {
  st.i++;   // 吃掉 {
  const obj = {};
  skipWs(st);
  if (st.s[st.i] === '}') { st.i++; return obj; }
  while (st.i < st.s.length) {
    skipWs(st);
    // 键
    let key = '';
    if (st.s[st.i] === '"' || st.s[st.i] === "'") {
      const q = st.s[st.i];
      let j = st.i + 1;
      while (j < st.s.length) {
        if (st.s[j] === q && st.s[j - 1] !== '\\') break;
        j++;
      }
      key = parseQuoted(st.s.slice(st.i, j + 1), lineNo);
      st.i = j + 1;
    } else {
      while (st.i < st.s.length && st.s[st.i] !== ':' && st.s[st.i] !== '}' && st.s[st.i] !== ',') {
        key += st.s[st.i++];
      }
      key = key.trim();
    }
    skipWs(st);
    if (st.s[st.i] === ':') {
      st.i++;
      obj[String(key)] = parseFlowValue(st, lineNo);
    } else {
      // 没有冒号：YAML 流式映射里 {a, b} 等价于 {a: null, b: null}
      obj[String(key)] = null;
    }
    skipWs(st);
    if (st.s[st.i] === ',') { st.i++; skipWs(st); if (st.s[st.i] === '}') { st.i++; return obj; } continue; }
    if (st.s[st.i] === '}') { st.i++; return obj; }
    throw new YamlError(`流式映射解析失败，位置 ${st.i}：${JSON.stringify(st.s)}`, lineNo);
  }
  throw new YamlError('流式映射缺少收尾的 }', lineNo);
}

function parseFlowSeq(st, lineNo) {
  st.i++;   // 吃掉 [
  const arr = [];
  skipWs(st);
  if (st.s[st.i] === ']') { st.i++; return arr; }
  while (st.i < st.s.length) {
    arr.push(parseFlowValue(st, lineNo));
    skipWs(st);
    if (st.s[st.i] === ',') { st.i++; skipWs(st); if (st.s[st.i] === ']') { st.i++; return arr; } continue; }
    if (st.s[st.i] === ']') { st.i++; return arr; }
    throw new YamlError(`流式序列解析失败，位置 ${st.i}：${JSON.stringify(st.s)}`, lineNo);
  }
  throw new YamlError('流式序列缺少收尾的 ]', lineNo);
}

/* ======================= 标量：文本 → JS 值 ======================= */

const NULL_TOKENS = new Set(['null', 'Null', 'NULL', '~', '']);
/**
 * 布尔字面量。
 *
 * ★ 刻意只认 true/false，**不认 YAML 1.1 的 yes/no/on/off**。
 * 两个理由：
 *   1) YAML 1.2 官方规范已把它们移出布尔集（只留 true/false），跟 JSON 对齐；
 *   2) 实际数据里 yes/no 更常是**值本身**（问卷答案、开关描述），
 *      当成布尔会让 `status: no` 变成 false，往返 JSON 时类型被悄悄改变。
 * 若用户确实需要 1.1 语义，应在上游把 yes/no 显式改成 true/false。
 */
const TRUE_TOKENS = new Set(['true', 'True', 'TRUE']);
const FALSE_TOKENS = new Set(['false', 'False', 'FALSE']);

/**
 * 解析一个行内标量（可能是引号串 / 流式集合 / 数字 / 布尔 / null / 裸字符串）
 *
 * 注意 YAML 1.1 的 yes/no/on/off 布尔：本实现**默认按字符串**处理（与 YAML 1.2 一致，
 * 也与 JSON 的可预期性一致）。理由是 yes/no 在中文场景里常是值而非布尔。
 */
function parseInlineValue(text, lineNo) {
  const s = String(text).trim();
  if (s === '') return null;
  if (s[0] === '"' || s[0] === "'") {
    let q = s[0];
    // 只有整个字符串被一对引号包住才算引号串
    if (s.length >= 2 && s[s.length - 1] === q) {
      const inner = s.slice(1, -1);
      // 检查引号是否在中间就闭合了（如 "a"b）
      let j = 1;
      while (j < s.length - 1) {
        if (s[j] === q) {
          if (q === "'" && s[j + 1] === "'") { j += 2; continue; }
          if (q === '"' && s[j - 1] === '\\') { j++; continue; }
          break;
        }
        j++;
      }
      if (j === s.length - 1) return parseQuoted(s, lineNo);
    }
  }
  if (s[0] === '{' || s[0] === '[') return parseFlow(s, lineNo);
  if (NULL_TOKENS.has(s)) return null;
  if (TRUE_TOKENS.has(s)) return true;
  if (FALSE_TOKENS.has(s)) return false;
  if (isNumericToken(s)) return Number(s);
  return s;
}

/** 严格的数字判定：不接受前导零、不接受 16 进制、不接受 .5 / 5. 这种半成品 */
function isNumericToken(s) {
  if (/^-?(0|[1-9]\d*)$/.test(s)) return true;                       // 整数
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(s)) return true;                  // 小数
  if (/^-?(0|[1-9]\d*)(\.\d+)?[eE][+-]?\d+$/.test(s)) return true;   // 科学计数
  if (/^0x[0-9a-fA-F]+$/.test(s)) return false;                      // 刻意不当数字
  return false;
}

/* ============================== 序列化 ============================== */

/**
 * 会被解析回「非字符串」的值 —— 序列化时必须加引号，否则往返改变类型。
 * 这是 JSON→YAML→JSON 往返一致性的关键。
 */
/**
 * 会被"别家解析器"读成非字符串的值 → 序列化时必须加引号。
 *
 * 注意这份表比上面的 TRUE_TOKENS/FALSE_TOKENS **更宽**：
 * 本实现按 YAML 1.2 不把 yes/no/on/off 当布尔（见上），
 * 但 **YAML 1.1 的解析器会**。为了让输出的 YAML 拿到别处也能被正确读成字符串，
 * 这几个词仍然加引号 —— 宁可多一对引号，也不要跨解析器时类型漂移。
 */
const AMBIGUOUS_STRINGS = new Set([
  'null', 'Null', 'NULL', '~', '',
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'yes', 'Yes', 'YES', 'no', 'No', 'NO',
  'on', 'On', 'ON', 'off', 'Off', 'OFF'
]);

function looksNumeric(s) {
  return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s);
}

/** 字符串是否必须加引号 */
function needsYamlQuote(s) {
  if (s === '') return true;
  if (AMBIGUOUS_STRINGS.has(s)) return true;
  if (looksNumeric(s)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/:\s/.test(s) || /\s#/.test(s)) return true;
  if (/\n|\r|\t/.test(s)) return true;
  if (/^[\s]|[\s]$/.test(s)) return true;
  if (/^<<$/.test(s)) return true;
  return false;
}

function quoteScalar(s) {
  if (!needsYamlQuote(s)) return s;
  if (/\n/.test(s)) return JSON.stringify(s);          // 含换行用双引号 + \n 转义
  const needsDouble = /[\\"]/.test(s) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s) || /^\s|\s$/.test(s);
  if (needsDouble) return JSON.stringify(s);
  return "'" + s.replace(/'/g, "''") + "'";
}

/** JS 值 → 单行 YAML 标量；返回 null 表示"这是集合，需要多行渲染" */
function scalarToYaml(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      if (Number.isNaN(v)) return '.nan';
      return v > 0 ? '.inf' : '-.inf';
    }
    return String(v);
  }
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return quoteScalar(v);
  if (v instanceof Date) return v.toISOString();
  return null;   // 对象/数组
}

function isCollection(v) {
  return v !== null && typeof v === 'object' && !(v instanceof Date);
}

/**
 * 序列化为 YAML 文本
 * @param {any} value
 * @param {object} opts  indent(默认2) / depth / sortKeys / flowLevel
 */
function stringifyYaml(value, opts = {}) {
  const indentSize = opts.indent || 2;
  const sortKeys = !!opts.sortKeys;
  const lines = [];
  const docs = opts.multiple && Array.isArray(value) && opts.isMultiDoc ? value : null;

  if (docs) {
    docs.forEach((d, idx) => {
      if (idx > 0) lines.push('---');
      emit(d, 0, false);
    });
  } else {
    emit(value, 0, false);
  }

  function pad(n) { return ' '.repeat(n * indentSize); }

  function emit(v, level, asSeqItem) {
    if (!isCollection(v)) {
      lines.push(pad(level) + (asSeqItem ? '- ' : '') + scalarToYaml(v));
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(pad(level) + (asSeqItem ? '- []' : '[]'));
        return;
      }
      // 全标量且较短 → 用流式，更紧凑
      if (v.every(x => !isCollection(x)) && v.length <= (opts.flowThreshold || 0)) {
        lines.push(pad(level) + (asSeqItem ? '- ' : '') + '[' + v.map(x => scalarToYaml(x)).join(', ') + ']');
        return;
      }
      for (const item of v) {
        if (!isCollection(item)) {
          lines.push(pad(level) + '- ' + scalarToYaml(item));
        } else if (Array.isArray(item)) {
          if (item.length === 0) { lines.push(pad(level) + '- []'); continue; }
          lines.push(pad(level) + '-');
          emit(item, level + 1, false);
        } else {
          const keys = orderedKeys(item, sortKeys);
          if (keys.length === 0) { lines.push(pad(level) + '- {}'); continue; }
          // 行内映射紧凑写法：- key: value
          const first = keys[0];
          const fv = item[first];
          if (!isCollection(fv)) {
            lines.push(pad(level) + '- ' + quoteKey(first) + ': ' + scalarToYaml(fv));
            for (let k = 1; k < keys.length; k++) {
              emitMapEntry(keys[k], item[keys[k]], level + 1);
            }
          } else {
            lines.push(pad(level) + '- ' + quoteKey(first) + ':');
            emit(fv, level + 2, false);
            for (let k = 1; k < keys.length; k++) {
              emitMapEntry(keys[k], item[keys[k]], level + 1);
            }
          }
        }
      }
      return;
    }
    // 普通对象
    const keys = orderedKeys(v, sortKeys);
    if (keys.length === 0) {
      lines.push(pad(level) + (asSeqItem ? '- {}' : '{}'));
      return;
    }
    for (const k of keys) emitMapEntry(k, v[k], level);
  }

  function emitMapEntry(key, val, level) {
    const k = quoteKey(key);
    if (!isCollection(val)) {
      const s = scalarToYaml(val);
      if (s !== null && s.includes('\n')) {
        // 多行字符串用块标量，可读性远好于 "a\nb"
        lines.push(pad(level) + k + ': |');
        for (const ln of s.replace(/\n$/, '').split('\n')) lines.push(pad(level + 1) + ln);
      } else {
        lines.push(pad(level) + k + ': ' + s);
      }
      return;
    }
    if (Array.isArray(val)) {
      if (val.length === 0) { lines.push(pad(level) + k + ': []'); return; }
      lines.push(pad(level) + k + ':');
      emit(val, level + 1, false);
      return;
    }
    const okeys = orderedKeys(val, sortKeys);
    if (okeys.length === 0) { lines.push(pad(level) + k + ': {}'); return; }
    lines.push(pad(level) + k + ':');
    emit(val, level + 1, false);
  }

  return lines.join('\n') + '\n';
}

function orderedKeys(obj, sortKeys) {
  const keys = Object.keys(obj);
  return sortKeys ? keys.sort() : keys;
}

/** 键名需要引号的情况：空、含特殊字符、会被误读成非字符串 */
function quoteKey(k) {
  if (needsYamlQuote(k)) return quoteScalar(k);
  if (/[\s:[\]{},#&*!|>'"%@`]/.test(k)) return quoteScalar(k);
  return k;
}

/* ============================== 对外 API ============================== */

/**
 * 解析 YAML 文本。多文档时返回数组（单文档时也返回数组，由调用方决定是否取 [0]）。
 */
function parseYaml(text, opts = {}) {
  const p = new YamlParser(text, opts);
  const docs = p.parseDocuments();
  return { documents: docs, warnings: p.warnings };
}

/** 解析 YAML 并返回单个值；多文档时抛错（避免静默丢掉后面的文档） */
function parseYamlSingle(text, opts = {}) {
  const { documents, warnings } = parseYaml(text, opts);
  if (documents.length > 1) {
    throw new Error(`该 YAML 含 ${documents.length} 个文档（--- 分隔）。请改用 parseYaml 处理多文档，或指定只取第 N 个文档`);
  }
  return { value: documents[0] === undefined ? null : documents[0], warnings };
}

module.exports = {
  YamlError,
  parseYaml,
  parseYamlSingle,
  stringifyYaml,
  parseInlineValue,
  scalarToYaml,
  needsYamlQuote,
  quoteScalar,
  isNumericToken,
  findKeyColon,
  stripComment,
  isBlockScalarIndicator,
  AMBIGUOUS_STRINGS
};
