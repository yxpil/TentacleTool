'use strict';
/**
 * JavaScript / TypeScript 提取器
 *
 * 抓取：
 *   - 函数声明        function foo() {}  /  async function foo()
 *   - 变量函数        const foo = () => {} / const foo = function(){} / const foo = async () => {}
 *   - 类              class Foo extends Bar {}
 *   - 类方法          foo() {} / async foo() {} / get foo() {} / static foo() {} / #priv() {}
 *   - 类属性函数      foo = () => {}
 *   - 顶层/导出变量   const foo = ... / let / var  （非函数也记，供 refs 使用）
 *   - 接口/类型别名   interface Foo / type Foo =   （TS）
 *   - 枚举            enum Foo                    （TS）
 *   - import / require / export ... from
 *   - 调用            标识符后跟 ( 的位置
 */

const { sanitize, stringAt, splitLines, attachedComment } = require('./clean');

/** 关键字/内置名，做调用统计时排除，避免把 if/for/return 当函数 */
const JS_RESERVED = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
  'function', 'class', 'extends', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of',
  'try', 'catch', 'finally', 'throw', 'await', 'yield', 'void', 'this', 'super',
  'const', 'let', 'var', 'import', 'export', 'default', 'from', 'as', 'async',
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity'
]);

/** 常见的内置/宿主方法名，调用统计里剔除（否则 console/JSON/Array 会霸榜） */
const JS_GLOBALS = new Set([
  'console', 'log', 'warn', 'error', 'info', 'debug', 'JSON', 'parse', 'stringify',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date', 'RegExp', 'Error',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'require', 'module', 'exports', 'process', 'global', 'window', 'document', 'Buffer',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'split',
  'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every', 'includes',
  'indexOf', 'lastIndexOf', 'sort', 'reverse', 'fill', 'flat', 'flatMap', 'keys', 'values',
  'entries', 'has', 'get', 'set', 'add', 'delete', 'clear', 'size', 'length', 'toString',
  'valueOf', 'hasOwnProperty', 'isArray', 'from', 'assign', 'keys', 'freeze', 'defineProperty',
  'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race', 'allSettled', 'any',
  'apply', 'call', 'bind', 'test', 'exec', 'match', 'matchAll', 'replace', 'replaceAll',
  'search', 'trim', 'trimStart', 'trimEnd', 'padStart', 'padEnd', 'toUpperCase',
  'toLowerCase', 'charAt', 'charCodeAt', 'codePointAt', 'repeat', 'startsWith', 'endsWith',
  'abs', 'floor', 'ceil', 'round', 'max', 'min', 'pow', 'sqrt', 'random', 'sign', 'trunc',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'write', 'read', 'end', 'on', 'once', 'emit', 'off', 'removeListener', 'next', 'done',
  'querySelector', 'querySelectorAll', 'addEventListener', 'removeEventListener',
  'createElement', 'appendChild', 'setAttribute', 'getAttribute'
]);

function extract(src, ctx) {
  const { clean, commentLines, strings } = sanitize(src, ctx.lang);
  const lines = splitLines(src);
  const symbols = [];
  const imports = [];
  const calls = [];
  const refs = [];
  const importedNames = new Map();   // 本地名 → 来源模块，用于把跨文件调用接到正确文件
  const occ = ctx.occupancy || new Set();   // 可选的去重集合，避免同一位置重复登记

  const push = (s) => {
    if (!s.name) return;
    const key = (s.kind || 'sym') + '|' + s.name + '|' + s.line;
    if (occ.has(key)) return;
    occ.add(key);
    symbols.push(s);
  };
  const doc = (line) => attachedComment(lines, line, commentLines);

  // ---------- 1) 顶层 import / export ... from ----------
  // import x from 'm' | import { a, b as c } from 'm' | import * as ns from 'm'
  // 注意：净化后模块名是 '~~~~~~'，必须用 stringAt 按引号位置取回真实值
  const importRe = /(^|[\s;{}()])(?:import|export)\s+([\s\S]*?)\s*from\s*(['"])(~+)\3/g;
  let m;
  while ((m = importRe.exec(clean))) {
    const line = lineNoAt(clean, m.index);
    const clause = m[2];
    const quotePos = m.index + m[0].length - m[4].length - 1;
    const lit = stringAt(strings, quotePos);
    const mod = lit ? lit.value : '';
    if (mod) imports.push({ name: mod, from: mod, line, kind: 'import' });
    // 记录导入的本地名（外部来源符号，供 refs 用）
    const names = [];
    const braceM = /\{([\s\S]*?)\}/.exec(clause);
    if (braceM) {
      for (const part of braceM[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const asM = /^(\S+)\s+as\s+(\S+)$/.exec(t);
        names.push(asM ? asM[2] : t);
      }
    }
    const starM = /\*\s+as\s+(\S+)/.exec(clause);
    if (starM) names.push(starM[1]);
    if (!braceM && !starM) {
      const def = clause.split(',')[0].trim();
      if (def && /^[A-Za-z_$][\w$]*$/.test(def)) names.push(def);
    }
    for (const nm of names) {
      importedNames.set(nm, mod);
      refs.push({ name: nm, line, kind: 'import', module: mod });
    }
  }

  // 裸 import 'm'（副作用导入）：引号紧跟在 import 之后，没有 from 子句
  const bareImportRe = /(^|[\s;}])(?:import)\s*(['"])(~+)\2/g;
  while ((m = bareImportRe.exec(clean))) {
    const line = lineNoAt(clean, m.index);
    // 引号一定在本次匹配跨度内：从匹配末尾往前找（长度 = 内容长 + 2 引号）
    const quotePos = m.index + m[0].length - m[3].length - 1;
    const lit = stringAt(strings, quotePos);
    if (lit) imports.push({ name: lit.value, from: lit.value, line, kind: 'import' });
  }

  // ---------- 2) require(...) ----------
  const requireRe = /\brequire\s*\(\s*(['"])(~+)\1\s*\)/g;
  while ((m = requireRe.exec(clean))) {
    const line = lineNoAt(clean, m.index);
    const lit = stringAt(strings, m.index + m[0].indexOf(m[1]));
    if (lit) imports.push({ name: lit.value, from: lit.value, line, kind: 'require' });
  }
  // 动态 import(...)
  const dynImportRe = /\bimport\s*\(\s*(['"])(~+)\1\s*\)/g;
  while ((m = dynImportRe.exec(clean))) {
    const line = lineNoAt(clean, m.index);
    const lit = stringAt(strings, m.index + m[0].indexOf(m[1]));
    if (lit) imports.push({ name: lit.value, from: lit.value, line, kind: 'dynamic-import' });
  }

  // ---------- 3) 类与继承 ----------
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*))?/g;
  const classBodies = [];   // { name, start, end }
  while ((m = classRe.exec(clean))) {
    const line = lineNoAt(clean, m.index);
    push({ name: m[1], kind: 'class', line, pos: m.index, exported: isExported(clean, m.index, m[0]), doc: doc(line) });
    if (m[2]) {
      refs.push({ name: m[2].split('.').pop(), line, kind: 'extends' });
    }
    const open = clean.indexOf('{', classRe.lastIndex);
    const end = open >= 0 ? matchBrace(clean, open) : -1;
    classBodies.push({ name: m[1], start: open, end: end > 0 ? end : clean.length });
  }

  // ---------- 4) 函数声明 ----------
  const funcRe = /(^|[\s;{}(){},:])(?:export\s+)?(?:default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  while ((m = funcRe.exec(clean))) {
    const line = lineNoAt(clean, m.index);
    const name = m[3];
    push({ name, kind: 'function', line, pos: m.index, exported: isExported(clean, m.index, m[0]), params: splitParams(m[4]), doc: doc(line) });
    // 类型注解参数 refs
    collectTypeRefs(m[4], line, refs);
  }

  // ---------- 5) 变量赋值 / 箭头函数 / 类方法 / 属性函数 ----------
  // 5a) const|let|var name = (async)? (args) =>   |  function
  const varFuncRe = /(^|[\s;{}])(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s+)?(?:function\s*\*?\s*[A-Za-z_$]*\s*\(([^)]*)\)|(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>)/g;
  while ((m = varFuncRe.exec(clean))) {
    const line = lineNoAt(clean, m.index);
    const name = m[2];
    const params = m[4] || m[5] || m[6] || '';
    push({
      name, kind: 'function', line, pos: m.index, arrow: !m[4],
      exported: isExported(clean, m.index, m[0]),
      params: splitParams(params), doc: doc(line)
    });
    collectTypeRefs(params, line, refs);
  }

  // 5b) 普通变量声明（跳过 5a 已登记的函数型：同一 name+line 只留函数那条）
  const varRe = /(^|[\s;{}])(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$<>,\[\]|&\s.]*?))?\s*=/g;
  const seenDecl = new Set(symbols.map(s => s.name + '|' + s.line));
  while ((m = varRe.exec(clean))) {
    const line = lineNoAt(clean, m.index);
    const name = m[2];
    if (seenDecl.has(name + '|' + line)) continue;
    seenDecl.add(name + '|' + line);
    push({ name, kind: 'variable', line, pos: m.index, exported: isExported(clean, m.index, m[0]), typeName: (m[3] || '').trim(), doc: doc(line) });
    if (m[3]) collectTypeRefs(m[3], line, refs);
  }

  // 5c) 类体内的成员方法：缩进 + name(args) {   （含 async/get/set/static/#private/*generator）
  const methodRe = /(^|\n)([ \t]+)(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\*\s*)?(#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::[^{;]+)?\{/g;
  while ((m = methodRe.exec(clean))) {
    const idx = m.index + m[1].length;
    const line = lineNoAt(clean, idx);
    const name = m[4];
    if (JS_RESERVED.has(name)) continue;
    const container = findContainer(classBodies, idx);
    if (!container) continue;    // 不是类成员，可能是块里的立即调用等，跳过
    push({
      name, kind: 'method', line, pos: idx, container,
      params: splitParams(m[5]), doc: doc(line)
    });
    collectTypeRefs(m[5], line, refs);
  }

  // 5d) 类体属性箭头函数：name = () => {} / name = async () => {}
  const propFuncRe = /(^|\n)([ \t]+)(?:static\s+)?(?:readonly\s+)?(#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*=\s*(async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/g;
  while ((m = propFuncRe.exec(clean))) {
    const idx = m.index + m[1].length;
    const line = lineNoAt(clean, idx);
    const container = findContainer(classBodies, idx);
    if (!container) continue;
    push({
      name: m[3], kind: 'method', line, container,
      params: splitParams(m[5] || m[6] || ''), doc: doc(line)
    });
  }

  // 5e) 类属性（非函数）
  const propRe = /(^|\n)([ \t]+)(?:static\s+)?(?:readonly\s+)?(#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$<>,\[\]|&\s.]*?))?\s*[;=]/g;
  while ((m = propRe.exec(clean))) {
    const idx = m.index + m[1].length;
    const line = lineNoAt(clean, idx);
    const name = m[3];
    if (JS_RESERVED.has(name)) continue;
    const container = findContainer(classBodies, idx);
    if (!container) continue;
    push({ name, kind: 'property', line, pos: idx, container, typeName: (m[4] || '').trim(), doc: doc(line) });
  }

  // ---------- 6) TypeScript：interface / type / enum / namespace ----------
  if (ctx.lang === 'typescript') {
    const ifaceRe = /\b(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([^{]+))?/g;
    while ((m = ifaceRe.exec(clean))) {
      const line = lineNoAt(clean, m.index);
      push({ name: m[1], kind: 'interface', line, pos: m.index, exported: isExported(clean, m.index, m[0]), doc: doc(line) });
      if (m[2]) for (const base of m[2].split(',')) {
        const b = base.trim().split(/[<(\s]/)[0];
        if (b) refs.push({ name: b, line, kind: 'extends' });
      }
    }
    const typeRe = /\b(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = typeRe.exec(clean))) {
      const line = lineNoAt(clean, m.index);
      push({ name: m[1], kind: 'type', line, pos: m.index, exported: isExported(clean, m.index, m[0]), doc: doc(line) });
    }
    const enumRe = /\b(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g;
    while ((m = enumRe.exec(clean))) {
      const line = lineNoAt(clean, m.index);
      push({ name: m[1], kind: 'enum', line, pos: m.index, exported: isExported(clean, m.index, m[0]), doc: doc(line) });
    }
    // TS 的 implements 子句（class A implements B, C）
    const implRe = /\bclass\s+[A-Za-z_$][\w$]*(?:\s+extends\s+[A-Za-z_$][\w$.<>,\s]*?)?\s+implements\s+([A-Za-z_$][\w$.,<>\s]*?)\s*\{/g;
    while ((m = implRe.exec(clean))) {
      const line = lineNoAt(clean, m.index);
      for (const part of m[1].split(',')) {
        const t = part.trim().replace(/<.*$/, '').split('.').pop();
        if (t) refs.push({ name: t, line, kind: 'implements' });
      }
    }
    // TS 的 interface extends 已在上面处理；class extends 已在 3) 处理
  }

  // ---------- 7) 调用点 ----------
  const inTx = ctx.transaction || null;
  // 先把函数/方法的"体区间"算出来，交给 transaction：
  //   - 用于剔除函数内部的局部变量（它们不该进符号表）
  //   - 用于把调用点归属到所属函数（调用链靠它）
  if (inTx) {
    for (const s of symbols) {
      if (s.kind !== 'function' && s.kind !== 'method') continue;
      // 关键：先跳过参数表，再找函数体左花括号。
      // 否则 `function f(opts = {}) {` 会把默认值里的 `{}` 误当成函数体，
      // 导致整个函数体区间算错、内部局部变量漏不进"该剔除"的名单。
      const bodyStart = findBodyBrace(clean, s.pos);
      const semi = clean.indexOf(';', s.pos);
      const nl = clean.indexOf('\n', s.pos);
      if (bodyStart >= 0) {
        const close = matchBrace(clean, bodyStart);
        if (close > bodyStart) {
          inTx.bodies.push({ name: s.name, start: s.pos, end: close, headerEnd: bodyStart });
          continue;
        }
      }
      inTx.bodies.push({
        name: s.name,
        start: s.pos,
        end: (semi > 0 ? semi : nl > 0 ? nl : clean.length),
        headerEnd: s.pos
      });
    }
    // 类体也算容器，用于把类内成员归到类上
    for (const c of classBodies) {
      inTx.bodies.push({ name: c.name, start: c.start, end: c.end, headerEnd: c.start });
    }
    for (const s of symbols) if (s.kind !== 'variable' && s.kind !== 'property') inTx.declared.add(s.name);
  }
  const txBodies = inTx ? inTx.bodies : [];

  // 局部变量不入符号表：属于函数/方法体内的一次性名字，不是可被引用的符号
  const moduleVars = [];
  if (txBodies.length) {
    const kept = [];
    for (const s of symbols) {
      if (s.kind !== 'variable') { kept.push(s); continue; }
      const owner = txBodies.find(b => b.start < s.pos && s.pos < b.end && b.name !== '<module>');
      if (owner) continue;   // 函数体内部 → 丢弃
      moduleVars.push(s); kept.push(s);
    }
    symbols.length = 0; symbols.push(...kept);
  }

  // 匹配 ident( ，排除关键字、紧跟 function/def 的声明名
  const callRe = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = callRe.exec(clean))) {
    const name = m[2];
    if (JS_RESERVED.has(name) || JS_GLOBALS.has(name)) continue;
    const idx = m.index + m[1].length;
    const line = lineNoAt(clean, idx);
    // 声明位置本身（function foo( / method( 等）不算调用
    if (symbols.some(d => d.name === name && d.line === line && d.pos === idx)) continue;
    calls.push({ name, line, member: false, arrow: false, pos: idx });
  }

  // ---------- 8) 成员调用 a.b( ：保留 .method 信息，便于与 foo.bar() 精确匹配 ----------
  const memberCallRe = /\.([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = memberCallRe.exec(clean))) {
    const name = m[1];
    if (JS_RESERVED.has(name)) continue;
    const idx = m.index + 1;
    const line = lineNoAt(clean, idx);
    const member = JS_GLOBALS.has(name);   // console.log/map/... 已是"明确的方法名"
    calls.push({ name, line, member: true, arrow: false, pos: idx });
  }

  // ---------- 9) 箭头函数调用：const f = () => ...; f(x) ----------
  for (const s of symbols) {
    if (s.kind !== 'function' || !s.arrow) continue;
    const re = new RegExp('(^|[^\\w$.' + '])' + s.name.replace(/\$/g, '\\$') + '\\s*\\(', 'g');
    let mm;
    while ((mm = re.exec(clean))) {
      const idx = mm.index + mm[1].length;
      const line = lineNoAt(clean, idx);
      if (line === s.line && idx === s.pos) continue;
      calls.push({ name: s.name, line, member: false, arrow: true, pos: idx });
    }
  }

  return { symbols, imports, calls, refs, moduleVars, importedNames };
}

/* ---------------- 调用点归属：每个调用落在哪个函数体里 ---------------- */

/**
 * 把裸调用点（callRe 那一路）挂到所属函数体上。
 * 函数声明位置自身、函数名本身不算"被调用"，避免 foo 定义行被算成 foo 的一次调用。
 * @param {Array} calls 提取器原始调用点
 * @param {Array} bodies [{name, start, end, headerEnd}]
 */
function resolveCallSites(calls, bodies) {
  const out = [];
  const seen = new Set();
  for (const c of calls) {
    let container = null;
    for (const b of bodies) if (c.pos > b.start && c.pos < b.end) container = b.name;
    // 调用点就落在某个函数头（参数表/返回类型）里 → 那是声明而非调用
    for (const b of bodies) {
      if (b.headerEnd && c.pos >= b.start && c.pos <= b.headerEnd && b.name === c.name) { container = null; c.selfDecl = true; break; }
    }
    if (c.selfDecl) continue;
    const key = (container || '') + '|' + c.name + '|' + c.line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: c.name, line: c.line, from: container, member: !!c.member, arrow: !!c.arrow });
  }
  return out;
}

/* ---------------- 私有辅助 ---------------- */

function lineNoAt(text, offset) {
  // 局部实现，避免每个提取器都传 lookup
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findContainer(classBodies, idx) {
  for (const c of classBodies) {
    if (idx > c.start && idx < c.end) return c.name;
  }
  return null;
}

/**
 * 找函数体的左花括号，跳过参数表。
 * 直接用 indexOf('{') 会被默认参数 `opts = {}`、解构 `({a, b})` 骗到，
 * 这里显式走一遍括号配对，跳过 (...) 之后再取第一个 '{'。
 * 返回 -1 表示这看起来不是"带块体的函数"（比如箭头函数的表达式体）。
 */
function findBodyBrace(text, from) {
  // 先找到参数表左括号
  let i = text.indexOf('(', from);
  if (i < 0) return -1;
  // 参数表不跨太多行；太远说明这不是函数头
  if (i - from > 400) return -1;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  // 参数表之后：跳过返回类型注解 `: Foo`、修饰词，找函数体的 '{'。
  // 注意参数表里的 `= {}` 已经在上面被括号配对吃掉了，这里遇到的 '{'
  // 一定是函数体（或箭头函数体）。
  let angle = 0;
  for (let j = i; j < text.length && j < i + 200; j++) {
    const c = text[j];
    if (c === '\n') continue;
    if (c === '<') { angle++; continue; }
    if (c === '>') { if (angle > 0) angle--; continue; }
    if (angle > 0) continue;
    if (c === '{') return j;
    // `=>` 说明是箭头函数：其后若是 '{' 就是块体，否则是表达式体
    if (c === '=' && text[j + 1] === '>') {
      const after = text.indexOf('{', j + 2);
      const nl = text.indexOf('\n', j + 2);
      if (after >= 0 && (nl < 0 || after < nl)) return after;
      return -1;
    }
    // 遇到 ';' 说明这个"函数头"其实已经结束了（不是定义）
    if (c === ';') return -1;
  }
  return -1;
}

function isExported(text, idx, spanText) {
  // idx 可能指在 "export" 之前（正则前缀吞掉了空白），也可能指在关键字上。
  // 先看调用方给出的实际匹配片段里有没有 export——这是最可靠的判据。
  if (spanText && /\bexport\b/.test(spanText)) return true;
  // 回退：看声明所在行及上一非空行是否出现 export
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  const before = text.slice(lineStart, idx);
  if (/\bexport\s+(default\s+)?[^;{}]*$/.test(before)) return true;
  const prev = text.slice(Math.max(0, lineStart - 200), lineStart);
  const prevLines = prev.split('\n').filter(l => l.trim());
  const last = prevLines.length ? prevLines[prevLines.length - 1] : '';
  return /^\s*export\s*$/.test(last);
}

function splitParams(s) {
  if (!s) return [];
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(p => p.replace(/[:=].*$/, '').replace(/\.\.\./, '').trim()).filter(Boolean).slice(0, 12);
}

/** 从类型注解里抽出可能的类型引用（供 refs） */
function collectTypeRefs(text, line, refs) {
  if (!text) return;
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(text))) {
    const n = m[0];
    if (JS_RESERVED.has(n) || JS_GLOBALS.has(n)) continue;
    if (n.length < 2) continue;
    // 只要首字母大写的（类型惯例）或含大写，减少噪声
    if (!/^[A-Z]/.test(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    refs.push({ name: n, line, kind: 'type-ref' });
  }
}

module.exports = {
  javascript: {
    name: 'javascript',
    extract: (src, ctx) => extract(src, Object.assign({ lang: 'javascript' }, ctx))
  },  typescript: {
    name: 'typescript',
    extract: (src, ctx) => extract(src, Object.assign({ lang: 'typescript' }, ctx))
  },
  resolveCallSites
};
