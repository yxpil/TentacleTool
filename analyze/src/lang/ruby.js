'use strict';
/**
 * Ruby 提取器
 * 抓取：require / require_relative / load、class（含继承 <）、module、
 *      def（含 self. 方法与 ?/!/= 结尾的方法名）、常量、attr_accessor 系列。
 */

const { sanitize, stringAt, splitLines, attachedComment } = require('./clean');

const RB_RESERVED = new Set([
  'if', 'elsif', 'else', 'unless', 'end', 'while', 'until', 'for', 'do', 'begin',
  'rescue', 'ensure', 'retry', 'return', 'yield', 'break', 'next', 'redo', 'case',
  'when', 'then', 'class', 'module', 'def', 'require', 'require_relative', 'load',
  'include', 'extend', 'prepend', 'and', 'or', 'not', 'in', 'nil', 'true', 'false',
  'self', 'super', 'lambda', 'proc', 'block_given?', 'raise', 'puts', 'print', 'p',
  'attr_accessor', 'attr_reader', 'attr_writer', 'private', 'public', 'protected',
  'new', 'freeze', 'dup', 'clone', 'to_s', 'to_i', 'to_f', 'to_a', 'to_h', 'inspect'
]);

function extract(src, ctx) {
  const { clean, commentLines, strings } = sanitize(src, 'ruby');
  const lines = splitLines(src);
  const symbols = [], imports = [], calls = [], refs = [];
  const occ = ctx.occupancy || new Set();
  const push = (s) => {
    if (!s.name) return;
    const key = (s.kind || 'sym') + '|' + s.name + '|' + s.line;
    if (occ.has(key)) return;
    occ.add(key);
    symbols.push(s);
  };
  const doc = (line) => attachedComment(lines, line, commentLines);
  const lineNoAt = (offset) => {
    let n = 1;
    for (let i = 0; i < offset && i < clean.length; i++) if (clean[i] === '\n') n++;
    return n;
  };

  // ---------- require / load ----------
  const reqRe = /^[ \t]*(require|require_relative|load)\s*\(?\s*(['"])(~+)\2/gm;
  let m;
  while ((m = reqRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const quotePos = m.index + m[0].length - m[3].length - 1;
    const lit = stringAt(strings, quotePos);
    if (!lit) continue;
    imports.push({ name: lit.value.split('/').pop(), from: lit.value, line, kind: m[1] });
  }

  // ---------- class / module（用缩进 + end 配对近似） ----------
  const classRe = /^([ \t]*)(class|module)\s+([A-Za-z_][\w:]*)(?:\s*<\s*([A-Za-z_][\w:]*))?/gm;
  const classBodies = [];
  while ((m = classRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const indent = (/^([ \t]*)/.exec(lines[line - 1] || '')[1] || '').length;
    const name = m[3].split('::').pop();
    push({ name, kind: m[2] === 'module' ? 'module' : 'class', line, doc: doc(line) });
    if (m[4]) refs.push({ name: m[4].split('::').pop(), line, kind: 'extends' });
    // 粗略找 end：向后找第一条缩进 <= 当前且以 end 开头的行
    let end = lines.length;
    let depth = 1;
    for (let k = line + 1; k <= lines.length; k++) {
      const t = (lines[k - 1] || '').trim();
      if (/^(class|module|def|if|unless|while|until|for|case|begin|do)\b/.test(t) || /\bdo\s*(\|[^|]*\|)?\s*$/.test(t)) depth++;
      if (/^end\b/.test(t)) { depth--; if (depth <= 0) { end = k; break; } }
    }
    classBodies.push({ name, startLine: line, endLine: end });
  }

  // ---------- def ----------
  const defRe = /^([ \t]*)def\s+(self\.)?([A-Za-z_]\w*[?!=]?)/gm;
  while ((m = defRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const name = m[3];
    const container = classBodies.find(c => line > c.startLine && line <= c.endLine);
    push({
      name,
      kind: container ? 'method' : 'function',
      line,
      container: container ? container.name : null,
      isSelf: !!m[2],
      doc: doc(line)
    });
  }

  // ---------- 常量 / 类属性（大写开头赋值） ----------
  const constRe = /^([ \t]*)([A-Z][A-Z0-9_]*)\s*=/gm;
  while ((m = constRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const container = classBodies.find(c => line > c.startLine && line <= c.endLine);
    push({ name: m[2], kind: 'const', line, container: container ? container.name : null, doc: doc(line) });
  }

  // ---------- attr_accessor 系列 → 属性 ----------
  const attrRe = /^[ \t]*(attr_accessor|attr_reader|attr_writer)\s+(.*)$/gm;
  while ((m = attrRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const container = classBodies.find(c => line > c.startLine && line <= c.endLine);
    const names = m[2].match(/:[A-Za-z_]\w*/g) || [];
    for (const nm of names) {
      push({
        name: nm.slice(1), kind: 'property', line,
        container: container ? container.name : null, doc: doc(line)
      });
    }
  }

  // ---------- include / extend 混入 ----------
  const mixRe = /^[ \t]*(include|extend|prepend)\s+([A-Z]\w*(?:::\w+)?)/gm;
  while ((m = mixRe.exec(clean))) {
    const line = lineNoAt(m.index);
    refs.push({ name: m[2].split('::').pop(), line, kind: m[1] });
  }

  // ---------- 调用点 ----------
  const declSpans = new Set(symbols.map(s => s.name + '@' + s.line));
  const callRe = /(^|[^\w$.:@])([A-Za-z_]\w*[?!]?)\s*\(/g;
  let cm;
  while ((cm = callRe.exec(clean))) {
    const name = cm[2];
    if (RB_RESERVED.has(name)) continue;
    const line = lineNoAt(cm.index);
    if (declSpans.has(name + '@' + line)) continue;
    calls.push({ name, line });
  }
  // 无括号调用（Ruby 常见）：名字后跟参数
  const bareCallRe = /(^|[^\w$.:@])([a-z_]\w*[?!])\s+(?=[A-Za-z_:@"'\[])/gm;
  while ((cm = bareCallRe.exec(clean))) {
    const name = cm[2];
    if (RB_RESERVED.has(name)) continue;
    calls.push({ name, line: lineNoAt(cm.index), noParen: true });
  }
  const memberRe = /\.([a-z_]\w*[?!]?)\s*[(\s]/g;
  while ((cm = memberRe.exec(clean))) {
    const name = cm[1];
    if (RB_RESERVED.has(name)) continue;
    calls.push({ name, line: lineNoAt(cm.index), member: true });
  }

  return { symbols, imports, calls, refs };
}

module.exports = { name: 'ruby', extract };
