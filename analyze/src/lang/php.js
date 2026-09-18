'use strict';
/**
 * PHP 提取器
 * 抓取：namespace、use、require/include（含 _once）、class / interface / trait /
 *      enum（含 extends / implements）、function（含方法、修饰符）、属性、const、define。
 */

const { sanitize, stringAt, splitLines, attachedComment } = require('./clean');

const PHP_RESERVED = new Set([
  'if', 'else', 'elseif', 'endif', 'for', 'foreach', 'while', 'endwhile', 'do', 'switch',
  'case', 'default', 'break', 'continue', 'return', 'function', 'fn', 'class', 'interface',
  'trait', 'enum', 'extends', 'implements', 'namespace', 'use', 'as', 'new', 'clone',
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'readonly', 'const',
  'var', 'global', 'echo', 'print', 'die', 'exit', 'isset', 'unset', 'empty', 'list',
  'array', 'callable', 'iterable', 'match', 'try', 'catch', 'finally', 'throw', 'yield',
  'require', 'require_once', 'include', 'include_once', 'this', 'self', 'parent',
  'true', 'false', 'null', 'and', 'or', 'xor', 'instanceof', 'insteadof', 'declare'
]);

const PHP_GLOBALS = new Set([
  'count', 'strlen', 'strpos', 'str_replace', 'strtolower', 'strtoupper', 'substr',
  'trim', 'ltrim', 'rtrim', 'explode', 'implode', 'array_map', 'array_filter',
  'array_merge', 'array_keys', 'array_values', 'array_push', 'array_pop', 'array_shift',
  'in_array', 'array_key_exists', 'is_array', 'is_string', 'is_null', 'is_int',
  'sprintf', 'printf', 'print_r', 'var_dump', 'json_encode', 'json_decode', 'file_get_contents',
  'file_put_contents', 'fopen', 'fclose', 'fwrite', 'preg_match', 'preg_replace',
  'spl_autoload_register', 'class_exists', 'function_exists', 'method_exists', 'define',
  'defined', 'constant', 'get_class', 'gettype', 'settype', 'intval', 'floatval',
  'strval', 'boolval', 'date', 'time', 'microtime', 'sort', 'usort', 'ksort'
]);

function extract(src, ctx) {
  const { clean, commentLines, strings } = sanitize(src, 'php');
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

  // ---------- namespace ----------
  const nsRe = /^[ \t]*namespace\s+([\w\\]+)\s*[;{]/gm;
  let m;
  while ((m = nsRe.exec(clean))) {
    const line = lineNoAt(m.index);
    push({ name: m[1].replace(/\\/g, '/'), kind: 'namespace', line, doc: doc(line) });
    const braceIdx = clean.indexOf('{', m.index);
    if (braceIdx >= 0 && braceIdx < m.index + m[0].length + 2 && /{/.test(m[0])) {
      // 带花括号的 namespace
    }
  }

  // ---------- use 导入 ----------
  const useRe = /^[ \t]*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm;
  while ((m = useRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const full = m[1];
    const local = m[2] || full.split('\\').pop();
    imports.push({ name: local, from: full.replace(/\\/g, '/'), line, kind: 'use' });
    refs.push({ name: local, line, kind: 'import' });
  }
  // 组导入 use A\{B, C};
  const groupUseRe = /^[ \t]*use\s+([\w\\]+)\\\{([^}]+)\}\s*;/gm;
  while ((m = groupUseRe.exec(clean))) {
    const line = lineNoAt(m.index);
    for (const part of m[2].split(',')) {
      const t = part.trim();
      const asM = /^([\w\\]+)\s+as\s+(\w+)$/.exec(t);
      const nm = asM ? asM[2] : t.split('\\').pop();
      if (nm) refs.push({ name: nm, line, kind: 'import' });
    }
  }

  // ---------- require / include ----------
  const reqRe = /^[ \t]*(require|require_once|include|include_once)\s*[\s(]*(['"])(~+)\2/gm;
  while ((m = reqRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const quotePos = m.index + m[0].length - m[3].length - 1;
    const lit = stringAt(strings, quotePos);
    if (!lit) continue;
    imports.push({ name: lit.value.split('/').pop(), from: lit.value, line, kind: m[1] });
  }

  // ---------- class / interface / trait / enum ----------
  const classRe = /^([ \t]*)(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm;
  const classBodies = [];
  while ((m = classRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const name = m[3];
    push({ name, kind: m[2], line, doc: doc(line) });
    const open = clean.indexOf('{', classRe.lastIndex);
    const end = open >= 0 ? matchBrace(clean, open) : -1;
    classBodies.push({ name, start: open, end: end > 0 ? end : clean.length });
    // extends / implements
    const head = clean.slice(classRe.lastIndex, open >= 0 ? open : classRe.lastIndex + 300);
    const extendM = /\bextends\s+([\w\\]+)/.exec(head);
    if (extendM) refs.push({ name: extendM[1].split('\\').pop(), line, kind: 'extends' });
    const implM = /\bimplements\s+([\w\\,\s]+)/.exec(head);
    if (implM) {
      for (const part of implM[1].split(',')) {
        const t = part.trim().split('\\').pop();
        if (t) refs.push({ name: t, line, kind: 'implements' });
      }
    }
  }

  // ---------- function（含方法） ----------
  const funcRe = /^([ \t]*)(?:(public|private|protected|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(([^)]*)\)/gm;
  while ((m = funcRe.exec(clean))) {
    const idx = m.index + m[1].length;
    const line = lineNoAt(idx);
    const name = m[3];
    if (PHP_RESERVED.has(name)) continue;
    const container = classBodies.find(c => idx > c.start && idx < c.end);
    push({
      name,
      kind: container ? 'method' : 'function',
      line,
      container: container ? container.name : null,
      exported: !container || /\bpublic\b/.test(m[2] || '') || !/\b(private|protected)\b/.test(m[2] || ''),
      params: splitParams(m[4]),
      doc: doc(line)
    });
  }

  // ---------- 属性 ----------
  const propRe = /^([ \t]*)(?:(public|private|protected|static|readonly|var)\s+)+(?:\??[A-Za-z_]\w*\s+)?\$([A-Za-z_]\w*)/gm;
  while ((m = propRe.exec(clean))) {
    const idx = m.index + m[1].length;
    const line = lineNoAt(idx);
    const container = classBodies.find(c => idx > c.start && idx < c.end);
    if (!container) continue;
    push({ name: m[3], kind: 'property', line, container: container.name, doc: doc(line) });
  }

  // ---------- const / define ----------
  const constRe = /^([ \t]*)(?:(public|private|protected|final)\s+)?const\s+([A-Za-z_]\w*)/gm;
  while ((m = constRe.exec(clean))) {
    const idx = m.index + m[1].length;
    const line = lineNoAt(idx);
    const container = classBodies.find(c => idx > c.start && idx < c.end);
    push({ name: m[3], kind: 'const', line, container: container ? container.name : null, doc: doc(line) });
  }
  const defineRe = /\bdefine\s*\(\s*['"]([A-Za-z_]\w*)['"]/g;
  while ((m = defineRe.exec(clean))) {
    const line = lineNoAt(m.index);
    push({ name: m[1], kind: 'const', line, doc: doc(line) });
  }

  // ---------- 调用点 ----------
  const declSpans = new Set(symbols.map(s => s.name + '@' + s.line));
  const callRe = /(^|[^\w$>:\\])([A-Za-z_]\w*)\s*\(/g;
  let cm;
  while ((cm = callRe.exec(clean))) {
    const name = cm[2];
    if (PHP_RESERVED.has(name) || PHP_GLOBALS.has(name)) continue;
    const line = lineNoAt(cm.index);
    if (declSpans.has(name + '@' + line)) continue;
    calls.push({ name, line });
  }
  const memberRe = /(?:->|::)\s*([A-Za-z_]\w*)\s*\(/g;
  while ((cm = memberRe.exec(clean))) {
    const name = cm[1];
    if (PHP_RESERVED.has(name) || PHP_GLOBALS.has(name)) continue;
    calls.push({ name, line: lineNoAt(cm.index), member: true });
  }

  return { symbols, imports, calls, refs };
}

function matchBrace(text, openIdx) {
  if (openIdx < 0) return -1;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
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
  return out.map(p => p.replace(/\$/, '').replace(/=.*$/, '').trim()).filter(Boolean).slice(0, 12);
}

module.exports = { name: 'php', extract };
