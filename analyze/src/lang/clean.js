'use strict';
/**
 * 源码文本预处理：去注释、去字符串、行号映射
 *
 * 为什么必须做：正则直接在原始文本上跑，注释里的 `function foo()` 和字符串里的
 * `require("./x")` 都会被当成真实代码，产生大量幽灵符号与幽灵依赖。
 * 先把注释/字符串替换成等长空白（**保留换行与列位置**），
 * 后面所有正则都在"净化后文本"上跑，行号就天然对齐原始文件。
 */

const { COMMENT_STYLE, BRACE_LANGS } = require('./tables');

/**
 * 净化源码：注释与字符串**内容**替换为等长占位（长度不变，换行保留）
 *
 * 关键设计：字符串不能整段抹掉。`import x from "./mod"` 里的 "./mod" 是
 * 图谱里最重要的信息之一（依赖边就靠它），抹掉等于自废武功。
 * 所以字符串**引号保留**、**内容换成等长的 `~`**，并把真实值收集进 `strings`，
 * 用位置下标回查。这样：
 *   - 依赖类正则（from/require/#include/use）能照常匹配 "~~~~~~" 这种形状；
 *   - 注释/字符串里伪代码不会被误判成符号；
 *   - 需要真实值时用 stringsAt() 按下标取回。
 *
 * @returns {{ clean: string, commentLines: Set<number>, strings: Array<{start:number,end:number,value:string,quote:string}> }}
 */
function sanitize(src, lang) {
  const style = COMMENT_STYLE[lang] || { line: '//', block: ['/*', '*/'] };
  const braceLang = BRACE_LANGS.has(lang);
  const n = src.length;
  const out = new Array(n);
  const commentLines = new Set();
  const strings = [];        // 字符串字面量：{ start, end, value, quote }
  let curStr = null;         // 当前正在收集的字符串

  // 状态：0=代码 1=行注释 2=块注释 3=双引号串 4=单引号串 5=模板串 6=三引号串
  let st = 0;
  // Ruby 的 =begin/=end 需要整行判断，单独处理
  const rubyBlock = lang === 'ruby' && style.block;
  let lineStart = 0;
  let blockCloser = style.block ? style.block[1] : null;
  let quoteChar = '';
  let tripleQuote = '';
  let lineNo = 1;
  // 逐行收集，便于行级判断
  const startsLine = (i) => i === 0 || src[i - 1] === '\n';
  const restOfLine = (i) => {
    const j = src.indexOf('\n', i);
    return src.slice(i, j < 0 ? n : j);
  };

  for (let i = 0; i < n; i++) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '\n') { lineNo++; lineStart = i + 1; }

    // ---- 状态 1：行注释：吃到行尾 ----
    if (st === 1) {
      if (c === '\n') { st = 0; out[i] = '\n'; }
      else out[i] = ' ';
      continue;
    }

    // ---- 状态 2：块注释：找结束符 ----
    if (st === 2) {
      const closer = rubyBlock && startsLine(i) && restOfLine(i).startsWith('=end') ? '=end' : blockCloser;
      if (closer && src.startsWith(closer, i)) {
        for (let k = 0; k < closer.length; k++) out[i + k] = ' ';
        i += closer.length - 1;
        st = 0;
        continue;
      }
      out[i] = c === '\n' ? '\n' : ' ';
      commentLines.add(lineNo);
      continue;
    }

    // ---- 状态 6：三引号串（Python docstring）：整体吃掉但**不**当注释行 ----
    if (st === 6) {
      if (src.startsWith(tripleQuote, i) && !isEscaped(src, i)) {
        for (let k = 0; k < 3; k++) out[i + k] = ' ';
        i += 2;
        st = 0;
        continue;
      }
      out[i] = c === '\n' ? '\n' : ' ';
      continue;
    }

    // ---- 状态 3/4/5：字符串 ----
    if (st === 3 || st === 4 || st === 5) {
      if (c === '\\') { out[i] = '~'; if (curStr) curStr.value += c; if (i + 1 < n && src[i + 1] !== '\n') { if (curStr) curStr.value += src[i + 1]; out[i + 1] = '~'; i++; } continue; }
      if (c === quoteChar) {
        out[i] = c; st = 0;
        if (curStr) { curStr.end = i + 1; strings.push(curStr); curStr = null; }
        continue;
      }
      // 模板串里的 ${...} 保留为代码（这样 f`${foo()}` 里的 foo() 能被识别）
      if (st === 5 && c === '$' && c2 === '{') {
        // 插值：${ 与 } 覆盖为空白，中间的内容原样保留（是真代码）
        // 注意把 i+1（即 '{' 的位置）交给 findMatchingBrace 作为计数起点，
        // 否则深度从 0 起算、第一个 '}' 就会把它压到 -1，一路吃到文件末尾。
        out[i] = ' '; out[i + 1] = ' ';
        const end = findMatchingBrace(src, i + 1, out);
        i = (end > i + 1) ? end : i + 1;
        continue;
      }
      if (c === '\n') { out[i] = '\n'; if (curStr) curStr.value += '\n'; continue; }
      out[i] = '~';
      if (curStr) curStr.value += c;
      continue;
    }

    // ---- 状态 0：代码 ----

    // Ruby 的 =begin / Python 之外的行首块注释
    if (rubyBlock && startsLine(i) && restOfLine(i).startsWith('=begin')) {
      out[i] = ' '; st = 2; blockCloser = '=end'; continue;
    }

    // 行注释起始
    if (style.line && src.startsWith(style.line, i)) {
      // Python 的 # 只需单个字符；其他语言的 // 要确认不是除号+除号（本工具不深究，// 在 JS 里只可能是注释）
      if (style.line === '#') {
        out[i] = ' '; st = 1; continue;
      }
      // 避免把 `http://` 之类误判——但那是字符串内部，已进不来；这里直接判注释
      out[i] = ' '; out[i + 1] = ' ';
      i += style.line.length - 1;
      st = 1;
      commentLines.add(lineNo);
      continue;
    }

    // 块注释起始
    if (style.block && src.startsWith(style.block[0], i)) {
      const open = style.block[0];
      for (let k = 0; k < open.length; k++) out[i + k] = ' ';
      i += open.length - 1;
      blockCloser = style.block[1];
      st = 2;
      commentLines.add(lineNo);
      continue;
    }

    // 字符串起始
    if (c === '"' ) {
      // Python 三引号
      if ((lang === 'python') && src.startsWith('"""', i)) {
        out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' ';
        i += 2; tripleQuote = '"""'; st = 6; continue;
      }
      out[i] = '"'; quoteChar = '"'; st = 3; curStr = { start: i, end: i, value: '', quote: '"', line: lineNo }; continue;
    }
    if (c === "'") {
      if (lang === 'python' && src.startsWith("'''", i)) {
        out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' ';
        i += 2; tripleQuote = "'''"; st = 6; continue;
      }
      // JS/TS 的单引号就是字符串；C 系的 '\'' 是字符字面量，同样按字符串处理（无害）
      out[i] = "'"; quoteChar = "'"; st = 4; curStr = { start: i, end: i, value: '', quote: "'", line: lineNo }; continue;
    }
    if (c === '`' && (lang === 'javascript' || lang === 'typescript')) {
      out[i] = '`'; quoteChar = '`'; st = 5; curStr = { start: i, end: i, value: '', quote: '`', line: lineNo }; continue;
    }

    // 只填尚未确定的槽位：站在 findMatchingBrace 已经填过的位置上时（模板串插值
    // 返回后的续扫），这里不能覆盖，否则会把插值里的真实代码抹掉。
    if (out[i] === undefined) out[i] = c;
  }
  return { clean: out.join(''), commentLines, strings };
}

/**
 * 按净化文本里的位置取回字符串真实值。
 * 提取器在 clean 上匹配到 `from "~~~~~~"` 后，用引号所在下标回查真实模块名。
 * @param {Array} strings sanitize() 产出的字符串表（已按 start 升序）
 * @param {number} pos clean 文本中的下标（指向引号或串内任意位置）
 */
function stringAt(strings, pos) {
  for (const s of strings) {
    if (pos >= s.start && pos < s.end) return s;
  }
  return null;
}

/**
 * 找到与 i 处 '{' 配对的 '}'，返回其下标。
 *
 * 这是模板串插值 `${ ... }` 的专用处理器：插值里的内容是**真代码**，
 * 要原样保留在净化文本里（这样 `${foo()}` 里的 foo 才能被识别）。
 *
 * 两个必须遵守的约束：
 *   1) 只写 `out[i] === undefined` 的位置——绝不复写已经确定的字符，
 *      否则会把后面的真实代码（比如函数收尾的 `}`）抹成空白，
 *      导致括号失衡、整个文件的函数体区间全部算错。
 *   2) 跨行时只补换行符，不改动已有内容。
 */
function findMatchingBrace(src, i, out) {
  let depth = 0;
  const n = src.length;
  for (; i < n; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        // 收尾的 '}' 属于插值语法本身，不属于被保留的代码，抹成空白
        out[i] = ' ';
        return i;
      }
    }
    // 只为"尚未确定"的位置填空，绝不覆盖
    if (out[i] === undefined) out[i] = (c === '\n') ? '\n' : c;
  }
  return n - 1;
}

function isEscaped(src, i) {
  let k = i - 1, cnt = 0;
  while (k >= 0 && src[k] === '\\') { cnt++; k--; }
  return cnt % 2 === 1;
}

/** 把文本按行切开，带原始行号（1-based） */
function splitLines(src) {
  return src.split(/\r\n|\r|\n/);
}

/** 计算偏移 → 行号 的快速查询器 */
function makeLineLookup(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return function lineAt(offset) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** 取某行的文本（1-based），超界返回空串 */
function lineText(lines, lineNo) {
  return (lineNo >= 1 && lineNo <= lines.length) ? lines[lineNo - 1] : '';
}

/** 从定义位置出发，向上收集紧邻的注释行作为 doc（最多 n 行） */
function attachedComment(lines, lineNo, commentLines, max = 6) {
  const out = [];
  for (let k = lineNo - 1; k >= 1 && out.length < max; k--) {
    if (!commentLines.has(k)) break;
    const t = lines[k - 1].trim().replace(/^(\/\/+|#+|\*+|\/\*+)\s?/, '').replace(/\*\/\s*$/, '').trim();
    if (t) out.unshift(t);
  }
  // JSDoc 的 @param/@returns 拼在一起会糊成一团，读起来费劲。
  // 这里做两点收敛：只保留首句概述 + 去掉重复的标签堆叠。
  const joined = out.join(' ');
  const firstSentence = joined.split(/(?<=[。．.!?！？])\s*/)[0] || joined;
  const hasTags = /@param|@returns|@returns|@throws|@example/.test(joined);
  const text = hasTags ? firstSentence : joined;
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

module.exports = { sanitize, stringAt, splitLines, makeLineLookup, lineText, attachedComment, findMatchingBrace };
