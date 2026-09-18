'use strict';
/**
 * Rust 提取器
 * 抓取：use（含 use a::{b, c}）、fn（含 pub / async / 泛型）、impl 块内方法、
 *      struct / enum / trait / type / const / static / mod、宏调用（记录名字）。
 */

const { sanitize, stringAt, splitLines, attachedComment } = require('./clean');

const RS_RESERVED = new Set([
  'if', 'else', 'for', 'while', 'loop', 'match', 'return', 'fn', 'let', 'mut', 'const',
  'static', 'struct', 'enum', 'trait', 'impl', 'type', 'mod', 'use', 'pub', 'crate',
  'super', 'self', 'Self', 'where', 'as', 'in', 'ref', 'move', 'async', 'await', 'dyn',
  'unsafe', 'extern', 'break', 'continue', 'true', 'false', 'box', 'yield'
]);

const RS_GLOBALS = new Set([
  'println', 'print', 'eprintln', 'eprint', 'format', 'vec', 'assert', 'assert_eq',
  'assert_ne', 'debug_assert', 'debug_assert_eq', 'panic', 'unreachable', 'unimplemented',
  'todo', 'write', 'writeln', 'read_to_string', 'to_string', 'to_owned', 'clone',
  'unwrap', 'expect', 'ok', 'err', 'some', 'none', 'into', 'from', 'iter', 'collect',
  'map', 'filter', 'fold', 'for_each', 'len', 'is_empty', 'push', 'pop', 'insert',
  'remove', 'get', 'get_mut', 'contains', 'contains_key', 'iter_mut', 'entry', 'or_insert',
  'new', 'default', 'parse', 'trim', 'split', 'join', 'replace', 'starts_with', 'ends_with',
  'spawn', 'join', 'lock', 'read', 'write_all', 'flush', 'open', 'create', 'args',
  'env', 'vars', 'exit', 'drop', 'mem', 'ptr', 'cmp', 'ops', 'fmt', 'io', 'fs', 'path'
]);

function extract(src, ctx) {
  const { clean, commentLines, strings } = sanitize(src, 'rust');
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

  // ---------- use ----------
  // use a::b::c;  |  use a::{b, c};  |  use a::b as d;  |  pub use ...
  const useRe = /^[ \t]*(?:pub\s+)?use\s+([^;]+);/gm;
  let m;
  while ((m = useRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const spec = m[1].trim();
    const path = spec.replace(/\{[\s\S]*\}?/, '').replace(/::\s*$/, '').replace(/::$/, '');
    if (path) imports.push({ name: path.split('::').pop() || path, from: path, line, kind: 'use' });
    // 花括号内的名字
    const braceM = /\{([\s\S]*?)\}/.exec(spec);
    if (braceM) {
      for (const part of braceM[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const asM = /^(\S+)\s+as\s+(\S+)$/.exec(t);
        const nm = asM ? asM[2] : t.replace(/^self$/, path.split('::').pop() || '');
        if (nm && nm !== 'self') refs.push({ name: nm, line, kind: 'import' });
      }
    } else {
      const asM = /(\S+)\s+as\s+(\S+)/.exec(spec);
      const nm = asM ? asM[2] : spec.split('::').pop();
      if (nm && nm !== '*' && nm !== 'self') refs.push({ name: nm, line, kind: 'import' });
    }
  }

  // ---------- impl 块（为方法提供 container） ----------
  const implRe = /^[ \t]*impl(?:\s*<[^>]*>)?\s+(?:([A-Za-z_][\w:]*(?:<[^>]*>)?)\s+for\s+)?([A-Za-z_][\w:]*(?:<[^>]*>)?)/gm;
  const implBodies = [];
  while ((m = implRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const target = (m[2] || '').replace(/<.*$/, '').split('::').pop();
    const trait = m[1] ? m[1].replace(/<.*$/, '').split('::').pop() : null;
    if (trait) refs.push({ name: trait, line, kind: 'implements' });
    const open = clean.indexOf('{', implRe.lastIndex);
    const end = open >= 0 ? matchBrace(clean, open) : -1;
    implBodies.push({ target, trait, start: open, end: end > 0 ? end : clean.length });
  }

  // ---------- fn ----------
  const fnRe = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/gm;
  while ((m = fnRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const name = m[1];
    const impl = implBodies.find(b => m.index > b.start && m.index < b.end);
    push({
      name,
      kind: impl ? 'method' : 'function',
      line,
      container: impl ? impl.target : null,
      exported: /^[ \t]*pub/.test(lines[line - 1] || ''),
      doc: doc(line)
    });
  }

  // ---------- struct / enum / trait / union / type / mod ----------
  const typeRe = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union|type)\s+([A-Za-z_]\w*)/gm;
  while ((m = typeRe.exec(clean))) {
    const line = lineNoAt(m.index);
    push({
      name: m[2], kind: m[1], line,
      exported: /^[ \t]*pub/.test(lines[line - 1] || ''),
      doc: doc(line)
    });
  }
  const modRe = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/gm;
  while ((m = modRe.exec(clean))) {
    const line = lineNoAt(m.index);
    push({ name: m[1], kind: 'mod', line, doc: doc(line) });
  }

  // ---------- const / static ----------
  const constRe = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/gm;
  while ((m = constRe.exec(clean))) {
    const line = lineNoAt(m.index);
    push({
      name: m[2], kind: m[1] === 'const' ? 'const' : 'variable', line,
      exported: /^[ \t]*pub/.test(lines[line - 1] || ''), doc: doc(line)
    });
  }

  // ---------- trait 实现目标（impl Trait for Type）已在上文 refs ----------

  // ---------- 调用点 ----------
  const declSpans = new Set(symbols.map(s => s.name + '@' + s.line));
  const callRe = /(^|[^\w$:.])([A-Za-z_]\w*)\s*(?:::<[^>]*>)?\s*\(/g;
  while ((m = callRe.exec(clean))) {
    const name = m[2];
    if (RS_RESERVED.has(name) || RS_GLOBALS.has(name)) continue;
    const line = lineNoAt(m.index);
    if (declSpans.has(name + '@' + line)) continue;
    calls.push({ name, line });
  }
  const memberRe = /\.([A-Za-z_]\w*)\s*\(/g;
  while ((m = memberRe.exec(clean))) {
    const name = m[1];
    if (RS_RESERVED.has(name) || RS_GLOBALS.has(name)) continue;
    calls.push({ name, line: lineNoAt(m.index), member: true });
  }
  // 路径调用 Module::func(
  const pathCallRe = /(?:^|[^\w$])([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(/g;
  while ((m = pathCallRe.exec(clean))) {
    const name = m[2];
    if (RS_RESERVED.has(name) || RS_GLOBALS.has(name)) continue;
    calls.push({ name, line: lineNoAt(m.index), via: m[1] });
  }

  return { symbols, imports, calls, refs };
}

function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

module.exports = { name: 'rust', extract };
