'use strict';
/**
 * Java / C# 提取器（两者语法高度相似，共用一套逻辑，靠 options 区分）
 * 抓取：package / namespace、import / using、class / interface / enum / struct / record /
 *      trait（Kotlin）、extends / implements、方法（含修饰符与泛型）、字段、构造函数。
 */

const { sanitize, stringAt, splitLines, attachedComment } = require('./clean');

const RESERVED = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'new', 'class', 'interface', 'enum', 'struct', 'record', 'extends',
  'implements', 'package', 'import', 'using', 'namespace', 'public', 'private',
  'protected', 'internal', 'static', 'final', 'sealed', 'abstract', 'virtual', 'override',
  'readonly', 'const', 'var', 'let', 'void', 'int', 'long', 'short', 'byte', 'char',
  'float', 'double', 'boolean', 'bool', 'string', 'String', 'object', 'Object', 'this',
  'super', 'base', 'null', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'throws',
  'synchronized', 'volatile', 'transient', 'native', 'strictfp', 'instanceof', 'typeof',
  'await', 'async', 'yield', 'get', 'set', 'init', 'where', 'out', 'ref', 'in', 'params',
  'delegate', 'event', 'operator', 'explicit', 'implicit', 'checked', 'unchecked',
  'unsafe', 'fixed', 'lock', 'default', 'trait', 'fun', 'val', 'when', 'data', 'suspend'
]);

const GLOBALS = new Set([
  'System', 'Console', 'WriteLine', 'Write', 'ReadLine', 'Math', 'String', 'Integer',
  'Double', 'Float', 'Long', 'Boolean', 'Character', 'Arrays', 'Collections', 'List',
  'Map', 'HashMap', 'Set', 'HashSet', 'ArrayList', 'Optional', 'Stream', 'Objects',
  'println', 'printf', 'format', 'valueOf', 'parseInt', 'parseDouble', 'toString',
  'equals', 'hashCode', 'getClass', 'getName', 'size', 'add', 'remove', 'put', 'get',
  'contains', 'isEmpty', 'length', 'charAt', 'substring', 'indexOf', 'split', 'trim',
  'toUpperCase', 'toLowerCase', 'replace', 'startsWith', 'endsWith', 'append', 'insert',
  'Task', 'Linq', 'Enumerable', 'Convert', 'ToInt32', 'ToString', 'Exception',
  'ArgumentException', 'InvalidOperationException', 'NullReferenceException',
  'TypeError', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException'
]);

function makeExtractor(opts) {
  const { lang, importKeyword } = opts;

  function extract(src, ctx) {
    const { clean, commentLines, strings } = sanitize(src, lang);
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
    // 修饰符里能否看到 public（决定 exported）
    const modifiersAt = (line) => lines[line - 1] || '';

    // ---------- import / using ----------
    if (importKeyword === 'import') {
      const re = /^[ \t]*import\s+(?:static\s+)?([\w.*]+)\s*;/gm;
      let m;
      while ((m = re.exec(clean))) {
        const line = lineNoAt(m.index);
        imports.push({ name: m[1].split('.').pop(), from: m[1], line, kind: 'import' });
      }
    } else {
      // C#: using X.Y.Z;  |  using Alias = X.Y.Z;
      const re = /^[ \t]*using\s+(?:(?:static\s+)?([\w.]+)\s*=\s*)?([\w.]+)\s*;/gm;
      let m;
      while ((m = re.exec(clean))) {
        const line = lineNoAt(m.index);
        const target = m[2];
        imports.push({ name: m[1] || target.split('.').pop(), from: target, line, kind: 'using' });
        if (m[1]) refs.push({ name: m[1], line, kind: 'import' });
      }
    }

    // ---------- package / namespace ----------
    const pkgRe = /^[ \t]*(package|namespace)\s+([\w.]+)/gm;
    let m;
    while ((m = pkgRe.exec(clean))) {
      const line = lineNoAt(m.index);
      push({ name: m[2], kind: 'package', line, doc: doc(line) });
    }

    // ---------- 类型声明（含嵌套） ----------
    const classRe = /^([ \t]*)(?:\[[^\]]*\]\s*)*(?:@\w+(?:\([^)]*\))?\s*)*(?:(public|private|protected|internal|static|final|sealed|abstract|partial|open|data|value)\s+)*\b(class|interface|enum|struct|record|trait|object)\s+([A-Za-z_]\w*)/gm;
    const classBodies = [];
    while ((m = classRe.exec(clean))) {
      const line = lineNoAt(m.index);
      const name = m[4];
      const kind = m[3] === 'object' ? 'class' : m[3];
      const mod = modifiersAt(line);
      push({ name, kind, line, exported: /\b(public|internal)\b/.test(mod) || !/\b(private|protected)\b/.test(mod), doc: doc(line) });
      // 泛型参数当作 refs 忽略
      const open = clean.indexOf('{', classRe.lastIndex);
      const end = open >= 0 ? matchBrace(clean, open) : -1;
      classBodies.push({ name, start: open, end: end > 0 ? end : clean.length, kind });
    }

    // ---------- extends / implements / : 基类（C# 的 class X : Base） ----------
    // 分成两趟各管一件事，避免多个可选组互相抢占导致漏抓：
    //   1) Java/Kotlin 风格：class A extends B implements C, D
    //   2) C# 风格：class A : Base, IScan
    const inheritRe = /\b(class|interface|struct|record|trait|object)\s+([A-Za-z_]\w*(?:<[^>]*>)?)((?:\s*(?:extends|implements)\s+[\w.<>,\s]+?)+)?\s*(?::\s*([\w.<>,\s]+?))?\s*\{/g;
    while ((m = inheritRe.exec(clean))) {
      const line = lineNoAt(m.index);
      const grab = (str, kind) => {
        if (!str) return;
        for (const part of str.split(',')) {
          const t = part.trim().replace(/<.*$/, '').split('.').pop();
          if (t && /^[A-Za-z_]/.test(t)) refs.push({ name: t, line, kind });
        }
      };
      // 1) extends ... / implements ...（可重复出现）
      if (m[3]) {
        const clauses = m[3].matchAll(/(extends|implements)\s+([\w.<>,\s]+?)(?=\s*(?:extends|implements)\s|$)/g);
        for (const c of clauses) grab(c[2], c[1] === 'extends' ? 'extends' : 'implements');
      }
      // 2) C# 的冒号基类列表
      if (lang === 'csharp') grab(m[4], 'extends');
    }

    // ---------- 方法 / 构造函数 / 字段 ----------
    // 方法：修饰符... 返回类型 名字(参数) {  （名字后紧跟 ( 且前面有类型词）
    const methodRe = /^([ \t]*)((?:public|private|protected|internal|static|final|sealed|abstract|virtual|override|synchronized|native|async|extern|unsafe|readonly|partial|open|suspend)\s+)*(?:<[^>]*>\s*)?([A-Za-z_][\w.<>\[\],\s?]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?[{;]/gm;
    while ((m = methodRe.exec(clean))) {
      const idx = m.index + m[1].length;
      const line = lineNoAt(idx);
      const retType = (m[3] || '').trim();
      const name = m[4];
      if (RESERVED.has(name)) continue;
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'case'].includes(retType)) continue;
      const container = classBodies.find(c => idx > c.start && idx < c.end);
      // 构造函数：名字等于所在类名 或 没有返回类型
      const isCtor = (container && name === container.name) || !retType || retType === '';
      push({
        name,
        kind: isCtor ? 'method' : 'method',
        line,
        container: container ? container.name : null,
        exported: /\b(public|internal)\b/.test(modifiersAt(line)),
        params: splitParams(m[5]),
        ctor: !!isCtor,
        doc: doc(line)
      });
      // 返回类型当 refs（首字母大写）
      const rt = retType.replace(/<.*$/, '').split('.').pop();
      if (rt && /^[A-Z]/.test(rt) && !GLOBALS.has(rt)) refs.push({ name: rt, line, kind: 'type-ref' });
    }

    // C# 属性：public int Foo { get; set; }
    if (lang === 'csharp') {
      const propRe = /^([ \t]*)((?:public|private|protected|internal|static|readonly|virtual|override|abstract|sealed|required)\s+)*([A-Za-z_][\w.<>\[\],\s?]*?)\s+([A-Za-z_]\w*)\s*(?:\{[^}]*\b(get|set|init)\b)/gm;
      while ((m = propRe.exec(clean))) {
        const idx = m.index + m[1].length;
        const line = lineNoAt(idx);
        const name = m[4];
        if (RESERVED.has(name)) continue;
        const container = classBodies.find(c => idx > c.start && idx < c.end);
        if (!container) continue;
        push({ name, kind: 'property', line, container: container.name, doc: doc(line) });
      }
    }

    // 字段： 修饰符... 类型 名字 = 或 ;   （类体内）
    const fieldRe = /^([ \t]+)((?:public|private|protected|internal|static|final|readonly|const|volatile|transient)\s+)+([A-Za-z_][\w.<>\[\],\s?]*?)\s+([A-Za-z_]\w*)\s*[;=]/gm;
    while ((m = fieldRe.exec(clean))) {
      const idx = m.index + m[1].length;
      const line = lineNoAt(idx);
      const name = m[4];
      if (RESERVED.has(name)) continue;
      const container = classBodies.find(c => idx > c.start && idx < c.end);
      if (!container) continue;
      push({
        name, kind: 'field', line, container: container.name,
        typeName: (m[3] || '').trim(), doc: doc(line)
      });
    }

    // ---------- 调用点 ----------
    const declSpans = new Set(symbols.map(s => s.name + '@' + s.line));
    const callRe = /(^|[^\w$.])([A-Za-z_]\w*)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(clean))) {
      const name = cm[2];
      if (RESERVED.has(name) || GLOBALS.has(name)) continue;
      const line = lineNoAt(cm.index);
      if (declSpans.has(name + '@' + line)) continue;
      calls.push({ name, line });
    }
    const memberRe = /\.([A-Za-z_]\w*)\s*\(/g;
    while ((cm = memberRe.exec(clean))) {
      const name = cm[1];
      if (RESERVED.has(name) || GLOBALS.has(name)) continue;
      calls.push({ name, line: lineNoAt(cm.index), member: true });
    }

    return { symbols, imports, calls, refs };
  }

  return extract;
}

function matchBrace(text, openIdx) {
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
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(p => p.replace(/@\w+/g, '').trim()).filter(Boolean).slice(0, 12);
}

module.exports = {
  java: { name: 'java', extract: makeExtractor({ lang: 'java', importKeyword: 'import' }) },
  csharp: { name: 'csharp', extract: makeExtractor({ lang: 'csharp', importKeyword: 'using' }) }
};
