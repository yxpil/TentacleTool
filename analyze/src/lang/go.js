'use strict';
/**
 * Go 提取器
 * 抓取：package、import（单行与块）、func / 带接收者的方法、type struct/interface、
 *       const / var、调用点（含 pkg.Func() 形态）。
 */

const { sanitize, stringAt, splitLines, attachedComment } = require('./clean');

const GO_RESERVED = new Set([
  'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'func', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer',
  'select', 'package', 'import', 'const', 'var', 'goto', 'fallthrough',
  'true', 'false', 'nil', 'iota', 'make', 'new', 'len', 'cap', 'append', 'copy',
  'delete', 'panic', 'recover', 'print', 'println', 'close', 'complex', 'real', 'imag'
]);

const GO_GLOBALS = new Set([
  'Errorf', 'Sprintf', 'Printf', 'Println', 'Print', 'Sprint', 'Sprintln', 'Fprintf',
  'New', 'Error', 'Fatal', 'Fatalf', 'Log', 'Logf', 'String', 'Int', 'Bool', 'Uint',
  'Int64', 'Uint64', 'Float64', 'Bytes', 'Rune', 'TrimSpace', 'Split', 'Join', 'Contains',
  'HasPrefix', 'HasSuffix', 'Replace', 'ToLower', 'ToUpper', 'ReadFile', 'WriteFile',
  'MkdirAll', 'Stat', 'Open', 'Create', 'Getenv', 'Setenv', 'LookupEnv', 'ListenAndServe',
  'HandleFunc', 'Handle', 'Marshal', 'Unmarshal', 'Map', 'Slice', 'Fields', 'Equal'
]);

function extract(src, ctx) {
  const { clean, commentLines, strings } = sanitize(src, 'go');
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

  // ---------- package ----------
  const pkgM = /^[ \t]*package\s+([A-Za-z_]\w*)/m.exec(clean);
  const pkgName = pkgM ? pkgM[1] : null;
  if (pkgName) {
    const line = lineNoAt(pkgM.index);
    push({ name: pkgName, kind: 'package', line, doc: doc(line) });
  }

  // ---------- import（单行 + 块） ----------
  // 净化后模块名是 "~~~"，靠 stringAt 按引号位置取回真实路径
  const blockRe = /^[ \t]*import\s*\(([\s\S]*?)\)/gm;
  let m;
  while ((m = blockRe.exec(clean))) {
    const baseLine = lineNoAt(m.index);
    const inner = m[1];
    const innerBase = m.index + m[0].indexOf(inner);
    const re = /(?:(\w+|\.|_)\s+)?(['"])(~+)\2/g;
    let im;
    while ((im = re.exec(inner))) {
      const quotePos = innerBase + im.index + im[0].length - im[3].length - 1;
      const lit = stringAt(strings, quotePos);
      if (!lit) continue;
      const offsetInBlock = im.index;
      const line = baseLine + (inner.slice(0, offsetInBlock).match(/\n/g) || []).length;
      const mod = lit.value;
      imports.push({ name: mod.split('/').pop(), from: mod, line, kind: 'import', alias: im[1] || null });
      if (im[1] && im[1] !== '_' && im[1] !== '.') refs.push({ name: im[1], line, kind: 'import', module: mod });
    }
  }
  const singleRe = /^[ \t]*import\s+(?:(\w+|\.|_)\s+)?(['"])(~+)\2/gm;
  while ((m = singleRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const quotePos = m.index + m[0].length - m[3].length - 1;
    const lit = stringAt(strings, quotePos);
    if (!lit) continue;
    const mod = lit.value;
    imports.push({ name: mod.split('/').pop(), from: mod, line, kind: 'import', alias: m[1] || null });
  }

  // ---------- func / 方法（带接收者） ----------
  const funcRe = /^[ \t]*func\s*(?:\(\s*(\w+)\s+\*?([\w.\[\]]+)\s*\)\s*)?([A-Za-z_]\w*)\s*\(/gm;
  while ((m = funcRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const recvType = m[2] ? m[2].replace(/^\[\]/, '').split('.').pop() : null;
    const name = m[3];
    push({
      name,
      kind: recvType ? 'method' : 'function',
      line,
      container: recvType,
      exported: /^[A-Z]/.test(name),
      doc: doc(line)
    });
  }

  // ---------- type 声明 ----------
  const typeRe = /^[ \t]*type\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?(struct|interface|=|\w+)/gm;
  while ((m = typeRe.exec(clean))) {
    const line = lineNoAt(m.index);
    const kw = m[2];
    const kind = kw === 'struct' ? 'struct' : kw === 'interface' ? 'interface' : 'type';
    push({ name: m[1], kind, line, exported: /^[A-Z]/.test(m[1]), doc: doc(line) });
    if (kw === 'interface') {
      // 接口内嵌（另一个接口名）
      const open = clean.indexOf('{', typeRe.lastIndex);
      const end = open >= 0 ? matchBrace(clean, open) : -1;
      if (end > 0) {
        const body = clean.slice(open + 1, end);
        const embRe = /^[ \t]*([A-Z]\w*(?:\.\w+)?)\s*$/gm;
        let em;
        while ((em = embRe.exec(body))) {
          refs.push({ name: em[1].split('.').pop(), line, kind: 'embeds' });
        }
      }
    }
  }

  // ---------- const / var（含块） ----------
  const declRe = /^[ \t]*(const|var)\s+(?:\(([\s\S]*?)^[ \t]*\)|([A-Za-z_]\w*)(?:\s+[\w.*\[\]]+)?\s*=?)/gm;
  while ((m = declRe.exec(clean))) {
    const kw = m[1];
    const baseLine = lineNoAt(m.index);
    if (m[2] != null) {
      const inner = m[2];
      const re = /^[ \t]*([A-Za-z_]\w*)\s*(?:[\w.*\[\]]+)?\s*=/gm;
      let im;
      while ((im = re.exec(inner))) {
        const line = baseLine + (inner.slice(0, im.index).match(/\n/g) || []).length;
        push({
          name: im[1], kind: kw === 'const' ? 'const' : 'variable', line,
          exported: /^[A-Z]/.test(im[1]), doc: doc(line)
        });
      }
    } else if (m[3]) {
      push({
        name: m[3], kind: kw === 'const' ? 'const' : 'variable', line: baseLine,
        exported: /^[A-Z]/.test(m[3]), doc: doc(baseLine)
      });
    }
  }

  // ---------- 调用点 ----------
  const declSpans = new Set(symbols.map(s => s.name + '@' + s.line));
  const callRe = /(^|[^\w$.])([A-Za-z_]\w*)\s*\(/g;
  while ((m = callRe.exec(clean))) {
    const name = m[2];
    if (GO_RESERVED.has(name) || GO_GLOBALS.has(name)) continue;
    const line = lineNoAt(m.index);
    if (declSpans.has(name + '@' + line)) continue;
    calls.push({ name, line });
  }
  const memberRe = /\.([A-Za-z_]\w*)\s*\(/g;
  while ((m = memberRe.exec(clean))) {
    const name = m[1];
    if (GO_RESERVED.has(name) || GO_GLOBALS.has(name)) continue;
    calls.push({ name, line: lineNoAt(m.index), member: true });
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

module.exports = { name: 'go', extract };
