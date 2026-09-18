'use strict';
/**
 * Python 提取器
 *
 * 抓取：import / from...import、def / async def（含类方法）、class（含基类）、
 *      模块级赋值、类属性、装饰器（记进 doc）、调用点。
 * Python 靠**缩进**定作用域：用行的缩进量判断函数是否属于某个 class。
 */

const { sanitize, stringAt, splitLines, attachedComment } = require('./clean');

const PY_RESERVED = new Set([
  'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'as', 'in',
  'is', 'not', 'and', 'or', 'return', 'yield', 'pass', 'break', 'continue', 'raise',
  'import', 'from', 'def', 'class', 'lambda', 'global', 'nonlocal', 'assert', 'del',
  'True', 'False', 'None', 'print', 'await', 'async', 'match', 'case'
]);

const PY_GLOBALS = new Set([
  'len', 'range', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes',
  'type', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr', 'delattr', 'super',
  'print', 'input', 'open', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed',
  'sum', 'min', 'max', 'abs', 'round', 'any', 'all', 'repr', 'format', 'hash', 'id',
  'iter', 'next', 'vars', 'dir', 'globals', 'locals', 'callable', 'staticmethod',
  'classmethod', 'property', 'object', 'Exception', 'ValueError', 'TypeError',
  'KeyError', 'IndexError', 'RuntimeError', 'StopIteration', 'AttributeError',
  'ImportError', 'OSError', 'IOError', 'ZeroDivisionError', 'NotImplementedError',
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'copy', 'update', 'keys',
  'values', 'items', 'get', 'split', 'join', 'strip', 'lstrip', 'rstrip', 'replace',
  'startswith', 'endswith', 'lower', 'upper', 'title', 'capitalize', 'find', 'index',
  'count', 'sort', 'reverse', 'encode', 'decode', 'read', 'write', 'readlines',
  'writelines', 'close', 'flush', 'seek', 'tell', 'ljust', 'rjust', 'zfill', 'center',
  'partition', 'rpartition', 'rsplit', 'splitlines', 'casefold', 'isalpha', 'isdigit'
]);

function extract(src, ctx) {
  const { clean, commentLines, strings } = sanitize(src, 'python');
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
  const indentOf = (lineNo) => {
    const t = lines[lineNo - 1] || '';
    const m = /^([ \t]*)/.exec(t);
    return m ? m[1].replace(/\t/g, '    ').length : 0;
  };

  // ---------- 1) import ----------
  // import a, b  |  import a as b  |  import a.b.c as d
  const importRe = /^[ \t]*import\s+([^\n#]+)/gm;
  let m;
  while ((m = importRe.exec(clean))) {
    const line = lineNoAt(m.index);
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const asM = /^([\w.]+)\s+as\s+(\w+)$/.exec(t);
      const mod = asM ? asM[1] : t;
      const local = asM ? asM[2] : t.split('.')[0];
      imports.push({ name: mod, from: mod, line, kind: 'import' });
      refs.push({ name: local, line, kind: 'import' });
    }
  }
  // from m import a, b as c  |  from . import x  |  from ..pkg import y
  const fromRe = /^[ \t]*from\s+([\w.\s]+?)\s+import\s+([^\n#]+)/gm;
  while ((m = fromRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const mod = m[1].trim();
    imports.push({ name: mod, from: mod, line, kind: 'from-import' });
    const body = m[2].replace(/[()]/g, '');
    for (const part of body.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const asM = /^(\w+)\s+as\s+(\w+)$/.exec(t);
      const nm = asM ? asM[2] : t;
      if (nm && nm !== '*') refs.push({ name: nm, line, kind: 'import' });
    }
  }

  // ---------- 2) class 与 def ----------
  // 先扫 class，建立 class 区间（靠缩进）
  const classRe = /^([ \t]*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/gm;
  const classBodies = [];
  while ((m = classRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const indent = indentOf(line);
    push({ name: m[2], kind: 'class', line, exported: !m[2].startsWith('_'), doc: doc(line) });
    if (m[3]) {
      for (const base of m[3].split(',')) {
        const b = base.trim().replace(/\[.*$/, '').split('.').pop();
        if (b && b !== 'object') refs.push({ name: b, line, kind: 'extends' });
      }
    }
    // 找该 class 的结束行：第一条缩进 <= indent 的非空非注释行
    let end = lines.length;
    for (let k = line + 1; k <= lines.length; k++) {
      const raw = lines[k - 1];
      const t = raw.trim();
      if (!t) continue;
      const ind = (/^([ \t]*)/.exec(raw)[1] || '').replace(/\t/g, '    ').length;
      if (ind <= indent) { end = k - 1; break; }
    }
    classBodies.push({ name: m[2], startLine: line, endLine: end, indent });
  }

  const defRe = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm;
  while ((m = defRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const indent = indentOf(line);
    const name = m[2];
    const container = classBodies.find(c => line > c.startLine && line <= c.endLine && indent > c.indent);
    push({
      name, kind: container ? 'method' : 'function', line, container: container ? container.name : null,
      exported: indent === 0 && !name.startsWith('_'),
      params: splitParams(m[3]),
      doc: doc(line)
    });
  }

  // ---------- 3) 模块级赋值 与 类属性 ----------
  const assignRe = /^([ \t]*)([A-Za-z_]\w*)\s*(?::\s*([\w\[\].,\s'"]+?))?\s*=\s*(?!=)/gm;
  while ((m = assignRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const indent = indentOf(line);
    const name = m[2];
    if (PY_RESERVED.has(name)) continue;
    const container = classBodies.find(c => line > c.startLine && line <= c.endLine && indent > c.indent);
    if (container) {
      push({ name, kind: 'property', line, container: container.name, doc: doc(line) });
    } else if (indent === 0) {
      // 模块级常量：全大写视为常量
      push({
        name, kind: /^[A-Z][A-Z0-9_]*$/.test(name) ? 'const' : 'variable',
        line, exported: !name.startsWith('_'), doc: doc(line)
      });
    }
  }

  // ---------- 4) 装饰器作为附近符号的补充信息（并入 doc 由 doc() 覆盖，这里仅记名字 refs） ----------
  const decoRe = /^[ \t]*@([\w.]+)/gm;
  while ((m = decoRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const nm = m[1].split('.').pop();
    if (nm && !PY_RESERVED.has(nm)) refs.push({ name: nm, line, kind: 'decorator' });
  }

  // ---------- 5) 调用点 ----------
  const declSpans = new Set(symbols.map(s => s.name + '@' + s.line));
  const callRe = /(^|[^\w$.])([A-Za-z_]\w*)\s*\(/g;
  while ((m = callRe.exec(clean))) {
    const name = m[2];
    if (PY_RESERVED.has(name) || PY_GLOBALS.has(name)) continue;
    const line = lineNoAt(m.index);
    if (declSpans.has(name + '@' + line)) continue;
    calls.push({ name, line });
  }
  const memberRe = /\.([A-Za-z_]\w*)\s*\(/g;
  while ((m = memberRe.exec(clean))) {
    const name = m[1];
    if (PY_RESERVED.has(name) || PY_GLOBALS.has(name)) continue;
    calls.push({ name, line: lineNoAt(m.index), member: true });
  }

  return { symbols, imports, calls, refs };
}

function splitParams(s) {
  if (!s) return [];
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out
    .map(p => p.replace(/^\*+/, '').replace(/[:=].*$/, '').trim())
    .filter(p => p && p !== 'self' && p !== 'cls')
    .slice(0, 12);
}

module.exports = {
  name: 'python',
  extract
};
