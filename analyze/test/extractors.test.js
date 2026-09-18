'use strict';
/**
 * 语言提取器冒烟测试（纯逻辑层，不起服务器）
 *
 * 覆盖 11 种语言各一段"有代表性"的样例，断言：
 *   - 关键符号被识别（类/函数/方法/常量）
 *   - 依赖边被识别（import / require / use / #include）
 *   - 注释与字符串里的伪代码**不**产生幽灵符号/幽灵依赖
 *
 * 运行：node test/extractors.test.js
 */

const assert = require('assert');
const L = require('../src/lang/index.js');

let passed = 0, failed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + label);
  } catch (e) {
    failed++;
    failures.push({ label, message: e.message });
    console.log('  FAIL ' + label + ' → ' + e.message);
  }
}

function extract(lang, src) {
  // 与 builder.parseSource 保持一致：带上 transaction，才能触发
  // "剔除局部变量" 与 "调用归属" 这两步后处理
  const transaction = { bodies: [], declared: new Set(), lang };
  return L.LANGUAGES[lang].extract(src, { file: 'sample', lang, transaction });
}
function names(r, kind) {
  return r.symbols.filter(s => !kind || s.kind === kind).map(s => s.name);
}
function deps(r) {
  return r.imports.map(i => i.from);
}

console.log('\n提取器冒烟测试\n');

/* ---------------- JavaScript / TypeScript ---------------- */
const js = [
  '// 下面这行是注释里的幽灵，不该被识别',
  '// import ghost from "./ghost";',
  'import { readFile } from "node:fs";',
  'import path from "./path-utils";',
  'const os = require("node:os");',
  'import "./side-effect";',
  '',
  'export class Walker {',
  '  constructor(root) { this.root = root; }',
  '  async scan(dir) {',
  '    const items = await readFile(dir);',
  '    return this.filter(items);',
  '  }',
  '  filter(list) { return list.map(x => x * 2); }',
  '}',
  '',
  'export function walk(root) {',
  '  const w = new Walker(root);',
  '  return w.scan(root);',
  '}',
  'const helper = (a) => toDouble(a);',
  'export const VERSION = "1.0.0";',
  'const text = "function fake() { }";'
].join('\n');

check('JS: 识别类/函数/方法/常量', () => {
  const r = extract('javascript', js);
  const n = names(r);
  assert(n.includes('Walker'), '缺 Walker');
  assert(n.includes('walk'), '缺 walk');
  assert(n.includes('scan'), '缺 scan');
  assert(n.includes('helper'), '缺 helper');
  assert(n.includes('VERSION'), '缺 VERSION');
  assert(n.includes('constructor'), '缺 constructor');
});

check('JS: 依赖边完整（含裸导入/require）', () => {
  const d = deps(extract('javascript', js));
  for (const m of ['node:fs', './path-utils', 'node:os', './side-effect']) {
    assert(d.includes(m), '缺依赖 ' + m + '，实得 ' + JSON.stringify(d));
  }
});

check('JS: 注释里的 import 不产生幽灵依赖', () => {
  const d = deps(extract('javascript', js));
  assert(!d.includes('./ghost'), '注释里的 ./ghost 被误抓');
});

check('JS: 字符串里的伪代码不产生幽灵符号', () => {
  const n = names(extract('javascript', js));
  assert(!n.includes('fake'), '字符串里的 fake() 被误抓');
});

check('JS: 局部变量不被当作模块符号', () => {
  const r = extract('javascript', js);
  const local = r.symbols.find(s => s.name === 'items');
  assert(!local, '函数内部的 items 不应进入符号表');
});

check('JS: export 标记正确', () => {
  const r = extract('javascript', js);
  const w = r.symbols.find(s => s.name === 'Walker');
  assert(w && w.exported, 'Walker 应标记为导出');
  const h = r.symbols.find(s => s.name === 'helper');
  assert(h && !h.exported, 'helper 未导出，不应标记');
});

/* ---------------- TypeScript ---------------- */
check('TS: interface / type / enum', () => {
  const r = extract('typescript', [
    'export interface User { id: number; }',
    'export type ID = string | number;',
    'export enum Role { Admin, User }',
    'export class Svc implements User { }'
  ].join('\n'));
  const n = names(r);
  assert(n.includes('User'), '缺 interface User');
  assert(n.includes('ID'), '缺 type ID');
  assert(n.includes('Role'), '缺 enum Role');
  assert(r.refs.some(x => x.kind === 'implements' && x.name === 'User'), '缺 implements User');
});

/* ---------------- Python ---------------- */
const py = [
  'import os, sys as system',
  'from typing import List',
  'from .models import User',
  '',
  'class Service(Base):',
  '    """docstring 里 def fake(): 不该被抓"""',
  '    def __init__(self, root):',
  '        self.root = root',
  '',
  '    def load(self, name):',
  '        return read_file(name)',
  '',
  'def run(root):',
  '    svc = Service(root)',
  '    return svc.load(root)',
  '',
  'MAX = 100'
].join('\n');

check('PY: 类/方法/函数/常量', () => {
  const n = names(extract('python', py));
  for (const x of ['Service', '__init__', 'load', 'run', 'MAX']) {
    assert(n.includes(x), '缺 ' + x);
  }
});

check('PY: 相对导入与 from-import', () => {
  const d = deps(extract('python', py));
  assert(d.includes('os'), '缺 os');
  assert(d.includes('typing'), '缺 typing，实得 ' + JSON.stringify(d));
  assert(d.includes('.models'), '缺 .models');
});

check('PY: docstring 里的 def 不产生幽灵符号', () => {
  const n = names(extract('python', py));
  assert(!n.includes('fake'), 'docstring 里的 fake 被误抓');
});

check('PY: 方法归属到类', () => {
  const r = extract('python', py);
  const load = r.symbols.find(s => s.name === 'load');
  assert(load && load.container === 'Service', 'load 应归属 Service');
});

/* ---------------- Go ---------------- */
const go = [
  'package walker',
  '',
  'import (',
  '  "fmt"',
  '  str "strings"',
  ')',
  'import "os"',
  '',
  'type Walker struct { Root string }',
  'type Scanner interface { Scan(string) error }',
  '',
  'func New(root string) *Walker { return &Walker{Root: root} }',
  'func (w *Walker) Scan(dir string) error {',
  '  fmt.Println(str.TrimSpace(dir))',
  '  return w.filter(dir)',
  '}',
  'const MaxDepth = 10'
].join('\n');

check('GO: package/结构体/接口/函数/方法/常量', () => {
  const n = names(extract('go', go));
  for (const x of ['walker', 'Walker', 'Scanner', 'New', 'Scan', 'MaxDepth']) {
    assert(n.includes(x), '缺 ' + x);
  }
});

check('GO: import 块与单行导入', () => {
  const d = deps(extract('go', go));
  for (const m of ['fmt', 'strings', 'os']) assert(d.includes(m), '缺 ' + m + '，实得 ' + JSON.stringify(d));
});

check('GO: 带接收者的方法归属到类型', () => {
  const r = extract('go', go);
  const scan = r.symbols.find(s => s.name === 'Scan' && s.kind === 'method');
  assert(scan && scan.container === 'Walker', 'Scan 应归属 Walker');
});

/* ---------------- Rust ---------------- */
const rs = [
  'use std::collections::HashMap;',
  'use crate::models::{User, Role};',
  'mod util;',
  '',
  'pub struct Walker { root: String }',
  'pub trait Scan { fn run(&self); }',
  '',
  'impl Scan for Walker {',
  '    fn run(&self) { helper(); }',
  '}',
  'impl Walker {',
  '    pub fn new(root: String) -> Self { Walker { root } }',
  '    fn filter(&self, s: &str) -> bool { check(s) }',
  '}'
].join('\n');

check('RS: use 分组导入 / struct / trait / impl 方法', () => {
  const r = extract('rust', rs);
  const d = deps(r);
  assert(d.includes('std::collections::HashMap'), '缺 HashMap 导入');
  assert(d.includes('crate::models'), '缺 crate::models');
  const n = names(r);
  for (const x of ['Walker', 'Scan', 'run', 'new', 'filter', 'util']) {
    assert(n.includes(x), '缺 ' + x);
  }
});

check('RS: impl Trait for Type 记 implements 引用', () => {
  const r = extract('rust', rs);
  assert(r.refs.some(x => x.kind === 'implements' && x.name === 'Scan'), '缺 implements Scan');
});

/* ---------------- Java ---------------- */
check('JAVA: package/import/类/接口/方法/字段/继承', () => {
  const r = extract('java', [
    'package com.app;',
    'import java.util.List;',
    'import static java.lang.Math.abs;',
    'public class Service extends Base implements Runnable, AutoCloseable {',
    '    private String root;',
    '    public Service(String r) { this.root = r; }',
    '    public void run() { load(root); }',
    '}',
    'interface Scan { void go(); }'
  ].join('\n'));
  const d = deps(r);
  assert(d.includes('java.util.List'), '缺 import List');
  const n = names(r);
  for (const x of ['Service', 'root', 'run', 'Scan']) assert(n.includes(x), '缺 ' + x);
  assert(r.refs.some(x => x.kind === 'extends' && x.name === 'Base'), '缺 extends Base');
  assert(r.refs.some(x => x.kind === 'implements' && x.name === 'Runnable'), '缺 implements Runnable');
});

/* ---------------- C# ---------------- */
check('CS: using 别名 / class : Base / 属性', () => {
  const r = extract('csharp', [
    'using System;',
    'using Models = App.Models;',
    'namespace App {',
    '  public class Svc : Base, IScan {',
    '    private string root;',
    '    public string Root { get; set; }',
    '    public void Go() { Helper(); }',
    '  }',
    '}'
  ].join('\n'));
  const d = deps(r);
  assert(d.includes('System'), '缺 using System');
  assert(d.includes('App.Models'), '缺 using 别名解析');
  assert(r.refs.some(x => x.name === 'IScan'), '缺基类 IScan');
});

/* ---------------- C / C++ ---------------- */
const c = [
  '#include <stdio.h>',
  '#include "local.h"',
  'static int counter = 0;',
  'typedef struct Node { int v; } Node;',
  'int helper(int a);',
  'int helper(int a) {',
  '  if (a > 0) { return a; }',
  '  for (int i = 0; i < a; i++) { helper(i); }',
  '  return 0;',
  '}',
  'int main(void) { return helper(1); }'
].join('\n');

check('C: 系统/本地 include 区分', () => {
  const r = extract('c', c);
  const sys = r.imports.find(i => i.from === 'stdio.h');
  const loc = r.imports.find(i => i.from === 'local.h');
  assert(sys && sys.kind === 'include-system', 'stdio.h 应为系统头');
  assert(loc && loc.kind === 'include-local', 'local.h 应为本地头');
});

check('C: 函数定义与原型区分，控制语句不误判', () => {
  const r = extract('c', c);
  const defs = r.symbols.filter(s => s.name === 'helper' && s.kind === 'function');
  assert(defs.length === 2, 'helper 应有原型+定义两条，实得 ' + defs.length);
  assert(defs.some(d => d.prototypeOnly), '缺原型标记');
  assert(defs.some(d => !d.prototypeOnly), '缺定义标记');
  const n = names(r);
  assert(!n.includes('if') && !n.includes('for'), '控制语句被误判为函数');
  assert(n.includes('counter'), '缺全局变量 counter');
  assert(n.includes('Node'), '缺 struct Node');
});

/* ---------------- Ruby ---------------- */
check('RB: require / class 继承 / 方法', () => {
  const r = extract('ruby', [
    'require "json"',
    'require_relative "./helper"',
    'class Foo < Base',
    '  def bar(x)',
    '    helper(x)',
    '  end',
    'end'
  ].join('\n'));
  const d = deps(r);
  assert(d.includes('json'), '缺 require json');
  assert(d.includes('./helper'), '缺 require_relative ./helper');
  const n = names(r);
  assert(n.includes('Foo'), '缺 class Foo');
  assert(n.includes('bar'), '缺 method bar');
});

/* ---------------- PHP ---------------- */
check('PHP: namespace / use / require / 类 / 方法', () => {
  const r = extract('php', [
    '<?php',
    'namespace App;',
    'use App\\Models\\User;',
    'require_once "lib/x.php";',
    'class Svc extends Base {',
    '  public function go($x) { return helper($x); }',
    '}'
  ].join('\n'));
  const d = deps(r);
  assert(d.includes('App/Models/User') || d.includes('App\\Models\\User'), '缺 use 导入，实得 ' + JSON.stringify(d));
  assert(d.includes('lib/x.php'), '缺 require_once');
  const n = names(r);
  assert(n.includes('Svc'), '缺 class Svc');
  assert(n.includes('go'), '缺 method go');
});

/* ---------------- 兜底：未知语言 ---------------- */
check('未知扩展名 → langOf 返回 null（走文件级依赖图）', () => {
  assert(L.langOf('a.unknownext') === null, '应返回 null');
  assert(L.langOf('a.js') === 'javascript', 'a.js 应为 javascript');
  assert(L.langOf('a.tsx') === 'typescript', 'a.tsx 应为 typescript');
});

/* ---------------- 结果 ---------------- */
console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项\n');
if (failed) {
  for (const f of failures) console.log('  ✗ ' + f.label + ': ' + f.message);
  process.exit(1);
}
