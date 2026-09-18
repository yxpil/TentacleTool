'use strict';
/**
 * C / C++ 提取器
 * 抓取：#include（系统 <> 与本地 "" 区分）、struct / class / union / enum / typedef /
 *      namespace（C++）、函数定义与原型、宏 #define、全局变量。
 *
 * C 系最大的噪声源是**声明与调用长得像**（`foo(a)` 也可能是宏调用），
 * 这里按"行首是否像类型+名字+("来判定定义，宁可少认也不要错认。
 */

const { sanitize, stringAt, splitLines, attachedComment } = require('./clean');

const RESERVED = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'goto', 'sizeof', 'typeof', 'struct', 'union', 'enum', 'typedef', 'static',
  'extern', 'inline', 'const', 'volatile', 'register', 'auto', 'signed', 'unsigned',
  'void', 'int', 'char', 'short', 'long', 'float', 'double', 'bool', 'class', 'public',
  'private', 'protected', 'virtual', 'override', 'final', 'template', 'typename',
  'namespace', 'using', 'new', 'delete', 'this', 'try', 'catch', 'throw', 'operator',
  'explicit', 'friend', 'mutable', 'constexpr', 'consteval', 'constinit', 'noexcept',
  'nullptr', 'true', 'false', 'NULL', 'defined'
]);

const GLOBALS = new Set([
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf', 'puts', 'putchar',
  'fputs', 'fputc', 'getchar', 'fgets', 'fopen', 'fclose', 'fread', 'fwrite', 'fseek',
  'ftell', 'fflush', 'malloc', 'calloc', 'realloc', 'free', 'memcpy', 'memset', 'memmove',
  'memcmp', 'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp',
  'strstr', 'strchr', 'strrchr', 'strtok', 'atoi', 'atof', 'atol', 'strtol', 'strtod',
  'exit', 'abort', 'assert', 'qsort', 'bsearch', 'time', 'clock', 'rand', 'srand',
  'abs', 'labs', 'fabs', 'sqrt', 'pow', 'exp', 'log', 'log10', 'sin', 'cos', 'tan',
  'ceil', 'floor', 'round', 'fmod', 'isalpha', 'isdigit', 'isspace', 'toupper', 'tolower',
  'std', 'cout', 'cin', 'cerr', 'endl', 'vector', 'string', 'map', 'set', 'pair', 'make_pair',
  'push_back', 'size', 'begin', 'end', 'insert', 'erase', 'find', 'empty', 'clear',
  'resize', 'reserve', 'c_str', 'data', 'length', 'substr', 'compare', 'first', 'second',
  'min', 'max', 'swap', 'move', 'forward', 'static_cast', 'dynamic_cast', 'reinterpret_cast',
  'const_cast', 'make_shared', 'make_unique', 'shared_ptr', 'unique_ptr', 'weak_ptr'
]);

function makeExtractor(lang) {
  const isCpp = lang === 'cpp';
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

    // ---------- #include ----------
    // <system.h> 保留原样；"local.h" 的引号保留、内容变 ~~~，需回查真实路径
    const incRe = /^[ \t]*#\s*include\s*(?:<([^>\n]+)>|(['"])(~+)\2)/gm;
    let m;
    while ((m = incRe.exec(clean))) {
      const line = lineNoAt(m.index);
      if (m[1]) {
        imports.push({
          name: m[1].split('/').pop(),
          from: m[1],
          line,
          kind: 'include-system'
        });
      } else {
        const quotePos = m.index + m[0].length - m[3].length - 1;
        const lit = stringAt(strings, quotePos);
        if (!lit) continue;
        imports.push({
          name: lit.value.split('/').pop(),
          from: lit.value,
          line,
          kind: 'include-local'
        });
      }
    }

    // ---------- #define 宏 ----------
    const defRe = /^[ \t]*#\s*define\s+([A-Za-z_]\w*)/gm;
    while ((m = defRe.exec(clean))) {
      const line = lineNoAt(m.index);
      push({ name: m[1], kind: 'macro', line, exported: /^[A-Z_]/.test(m[1]), doc: doc(line) });
    }

    // ---------- namespace（C++） ----------
    const nsBodies = [];
    if (isCpp) {
      const nsRe = /^[ \t]*namespace\s+([A-Za-z_]\w*)\s*\{/gm;
      while ((m = nsRe.exec(clean))) {
        const line = lineNoAt(m.index);
        push({ name: m[1], kind: 'namespace', line, doc: doc(line) });
        const open = clean.indexOf('{', nsRe.lastIndex - 1);
        const end = open >= 0 ? matchBrace(clean, open) : -1;
        nsBodies.push({ name: m[1], start: open, end: end > 0 ? end : clean.length });
      }
    }

    // ---------- struct / class / union / enum ----------
    const tagRe = /^([ \t]*)(typedef\s+)?(struct|class|union|enum)\s+(?:([A-Za-z_]\w*)\s*)?(?::\s*([^{;]+))?\s*\{/gm;
    const tagBodies = [];
    while ((m = tagRe.exec(clean))) {
      const line = lineNoAt(m.index);
      const kind = m[3];
      let name = m[4];
      const open = clean.lastIndexOf('{', tagRe.lastIndex);
      const end = matchBrace(clean, open);
      // typedef struct { ... } Name;  → 名字在尾部
      if (!name && m[2]) {
        const tail = clean.slice(end + 1, end + 120);
        const tm = /^\s*([A-Za-z_]\w*)\s*;/.exec(tail);
        if (tm) name = tm[1];
      }
      if (name) {
        push({ name, kind: kind === 'class' ? 'class' : kind, line, doc: doc(line) });
      }
      if (m[5]) {
        // 继承（C++ : public Base）
        for (const part of m[5].split(',')) {
          const b = part.trim().replace(/^(public|private|protected|virtual)\s+/, '').split('<')[0].trim();
          if (b && /^[A-Za-z_]/.test(b)) refs.push({ name: b, line, kind: 'extends' });
        }
      }
      if (name) tagBodies.push({ name, start: open, end: end > 0 ? end : clean.length, kind });
    }

    // ---------- typedef 别名 ----------
    const typedefRe = /^[ \t]*typedef\s+(?!struct|union|enum)[\w\s*]*?\b([A-Za-z_]\w*)\s*;/gm;
    while ((m = typedefRe.exec(clean))) {
      const line = lineNoAt(m.index);
      push({ name: m[1], kind: 'typedef', line, doc: doc(line) });
    }
    // C++ using 别名
    if (isCpp) {
      const usingRe = /^[ \t]*using\s+([A-Za-z_]\w*)\s*=/gm;
      while ((m = usingRe.exec(clean))) {
        const line = lineNoAt(m.index);
        push({ name: m[1], kind: 'typedef', line, doc: doc(line) });
      }
    }

    // ---------- 函数定义 / 原型 ----------
    // 形如：[修饰符/返回类型...] name(args) {  或  name(args);
    // 策略：整行匹配（不吃 return 之类的词），先排除控制语句开头的行，
    // 再用"类型 名字("的结构确认这是声明而不是调用。
    const funcRe = /^([ \t]*)(?:template\s*<[^;\n]*>\s*)?((?:(?:static|inline|extern|virtual|constexpr|explicit|friend|__declspec\s*\([^)]*\))\s+)*)([A-Za-z_]\w*(?:\s*[*&]+)?(?:\s+[A-Za-z_]\w*(?:::\w+)*(?:\s*<[^;{}()]*>)?)*)\s+([A-Za-z_]\w*(?:::\w+)*)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?::\s*[^{;\n]+)?(\{|;)[ \t]*(?:\/\/.*)?$/gm;
    while ((m = funcRe.exec(clean))) {
      const line = lineNoAt(m.index + m[1].length);
      const raw = m[4];
      const name = raw.split('::').pop();
      if (RESERVED.has(name)) continue;
      // 行首是控制语句 → 不是函数定义
      if (/^[ \t]*(if|for|while|switch|return|catch|do|else)\b/.test(m[0])) continue;
      const container = tagBodies.find(b => m.index > b.start && m.index < b.end);
      const qualifier = raw.includes('::') ? raw.split('::').slice(0, -1).join('::') : null;
      push({
        name,
        kind: container ? 'method' : 'function',
        line,
        pos: m.index,
        container: container ? container.name : (qualifier || null),
        params: splitParams(m[5]),
        prototypeOnly: m[6] === ';',
        doc: doc(line)
      });
    }

    // ---------- 全局变量（顶层，带类型） ----------
    const globalVarRe = /^([A-Za-z_]\w*(?:\s*[*&])?(?:\s+[A-Za-z_]\w*)*)\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;/gm;
    while ((m = globalVarRe.exec(clean))) {
      const line = lineNoAt(m.index);
      const typeWord = m[1].trim().split(/\s+/)[0].replace(/[*&]/g, '');
      if (!RESERVED.has(typeWord) && !/^(struct|union|enum|class)$/.test(typeWord)) continue;
      if (RESERVED.has(m[2])) continue;
      push({ name: m[2], kind: 'variable', line, doc: doc(line) });
    }

    // ---------- 调用点 ----------
    const declSpans = new Set(symbols.map(s => s.name + '@' + s.line));
    const callRe = /(^|[^\w$.>:])([A-Za-z_]\w*)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(clean))) {
      const name = cm[2];
      if (RESERVED.has(name) || GLOBALS.has(name)) continue;
      const line = lineNoAt(cm.index);
      if (declSpans.has(name + '@' + line)) continue;
      calls.push({ name, line });
    }
    if (isCpp) {
      const memberRe = /[.>-]+([A-Za-z_]\w*)\s*\(/g;
      while ((cm = memberRe.exec(clean))) {
        const name = cm[1];
        if (RESERVED.has(name) || GLOBALS.has(name)) continue;
        calls.push({ name, line: lineNoAt(cm.index), member: true });
      }
      const nsCallRe = /(?:^|[^\w$])([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(/g;
      while ((cm = nsCallRe.exec(clean))) {
        const name = cm[2];
        if (RESERVED.has(name) || GLOBALS.has(name)) continue;
        calls.push({ name, line: lineNoAt(cm.index), via: cm[1] });
      }
    }

    return { symbols, imports, calls, refs };
  }
  return extract;
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
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(p => p.replace(/[*&]/g, ' ').trim()).filter(Boolean).slice(0, 12);
}

module.exports = {
  c: { name: 'c', extract: makeExtractor('c') },
  cpp: { name: 'cpp', extract: makeExtractor('cpp') }
};
