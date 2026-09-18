'use strict';
/**
 * fsx 纯逻辑层单测（不启动 MCP、不扫描真实磁盘）
 *
 * 所有用例只在 os.tmpdir() 下自建临时目录操作，结束后清理，绝不碰用户真实文件。
 * 期望值来自「先跑探针看真实行为、再写期望」的流程，不是凭想象。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const read = require('../src/tools/fsx-read');
const write = require('../src/tools/fsx-write');
const edit = require('../src/tools/fsx-edit');
const list = require('../src/tools/fsx-list');
const tree = require('../src/tools/fsx-tree');
const stat = require('../src/tools/fsx-stat');
const grep = require('../src/tools/fsx-grep');
const copy = require('../src/tools/fsx-copy');
const move = require('../src/tools/fsx-move');
const del = require('../src/tools/fsx-delete');
const { isProtected } = require('../src/utils/fsutil');

let pass = 0, fail = 0;
const failures = [];
function t(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + '  → 实际 ' + a + '  期望 ' + e); console.log('  FAIL  ' + name); }
}
function tOk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? '  —— ' + detail : '')); console.log('  FAIL  ' + name); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* ==================================================================== */
let base;
try {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fsx-smoke-'));

  /* ---------------- fsx_write ---------------- */
  section('fsx_write');
  const wf = path.join(base, 'hello.txt');
  const wr = write.run({ path: wf, content: 'hello\nworld\n' });
  t('write 字节数正确', wr.bytes, 12);
  t('write 行数正确', wr.lines, 2);
  t('write 新建标记', wr.created, true);
  const wa = write.run({ path: wf, content: 'more\n', mode: 'append' });
  t('append 后字节数', wa.bytes, 17);
  t('append 不是新建', wa.created, false);
  t('append 后文件内容', fs.readFileSync(wf, 'utf8'), 'hello\nworld\nmore\n');

  /* ---------------- fsx_read ---------------- */
  section('fsx_read');
  const rf = path.join(base, 'lines.txt');
  write.run({ path: rf, content: 'line1\nline2\nline3\nline4\nline5\n' });
  const rr = read.run({ path: rf });
  t('read 字节数', rr.bytes, 30);
  t('read 总行数', rr.totalLines, 5);
  t('read 行内容', rr.lines.length, 5);
  const rr2 = read.run({ path: rf, startLine: 2, endLine: 4 });
  t('read 行范围 start', rr2.startLine, 2);
  t('read 行范围 end', rr2.endLine, 4);
  t('read 行范围内容', rr2.lines, ['line2', 'line3', 'line4']);
  const rr3 = read.run({ path: rf, limit: 3 });
  tOk('read 分页截断', rr3.truncated === true, 'truncated=' + rr3.truncated);
  t('read 分页显示行数', rr3.lines.length, 3);
  tOk('read 分页含续读提示', /续读/.test(rr3._text), '');
  // 二进制检测
  const bf = path.join(base, 'bin.bin');
  fs.writeFileSync(bf, Buffer.from([0, 1, 2, 0, 3, 4]));
  const br = read.run({ path: bf });
  tOk('二进制文件被识别', br.binary === true, 'binary=' + br.binary);
  tOk('二进制不回显内容', !/[\s\S]/.test(br.lines ? br.lines.join('') : '') && br.binary, '');

  /* ---------------- fsx_edit ---------------- */
  section('fsx_edit');
  const ef = path.join(base, 'edit.txt');
  write.run({ path: ef, content: 'a\nb\nTARGET\nc\n' });
  const er = edit.run({ path: ef, oldText: 'TARGET', newText: 'REPLACED' });
  t('edit 匹配数', er.matches, 1);
  t('edit 替换数', er.replaced, 1);
  t('edit 改动行号', er.changedLines, [3]);
  t('edit 写入结果', fs.readFileSync(ef, 'utf8'), 'a\nb\nREPLACED\nc\n');
  // 多处无 replaceAll → 拒绝
  const ef2 = path.join(base, 'dup.txt');
  write.run({ path: ef2, content: 'x\ny\nx\nz\nx\n' });
  let threwMulti = false, multiMsg = '';
  try { edit.run({ path: ef2, oldText: 'x' }); } catch (e) { threwMulti = true; multiMsg = e.message; }
  tOk('edit 多处无 replaceAll 抛错', threwMulti, multiMsg);
  tOk('edit 多处错误提示含"找到"和"replaceAll"', /找到/.test(multiMsg) && /replaceAll/.test(multiMsg), multiMsg);
  // 0 处匹配 → 抛错
  let threwZero = false, zeroMsg = '';
  try { edit.run({ path: ef, oldText: 'NOPE' }); } catch (e) { threwZero = true; zeroMsg = e.message; }
  tOk('edit 0 处匹配抛错', threwZero, zeroMsg);
  tOk('edit 0 处错误提示', /未找到匹配/.test(zeroMsg), zeroMsg);
  // replaceAll
  const er2 = edit.run({ path: ef2, oldText: 'x', newText: 'X', replaceAll: true });
  t('edit replaceAll 替换数', er2.replaced, 3);
  t('edit replaceAll 结果', fs.readFileSync(ef2, 'utf8'), 'X\ny\nX\nz\nX\n');

  /* ---------------- fsx_list ---------------- */
  section('fsx_list');
  const ls = path.join(base, 'ls');
  fs.mkdirSync(ls);
  fs.writeFileSync(path.join(ls, 'app.js'), 'const a=1;\n'.repeat(10));     // 20 字节
  fs.writeFileSync(path.join(ls, 'data.csv'), 'k,v\n');                      // 5 字节
  fs.writeFileSync(path.join(ls, 'notes.txt'), 'note\n'.repeat(10));         // 50 字节
  fs.mkdirSync(path.join(ls, 'sub'));
  fs.writeFileSync(path.join(ls, 'sub', 'inner.md'), '# hi\n');
  const l1 = list.run({ path: ls });
  t('list 非递归总数', l1.total, 4);
  const l2 = list.run({ path: ls, recursive: true });
  t('list 递归总数', l2.total, 5);
  const l3 = list.run({ path: ls, pattern: '*.js' });
  t('list glob *.js 命中', l3.total, 1);
  t('list glob *.js 文件名', l3.entries[0].name, 'app.js');
  const l4 = list.run({ path: ls, sort: 'size', order: 'desc' });
  t('list 按大小降序首位', l4.entries[0].name, 'app.js');
  // 翻页
  const pg = path.join(base, 'pg');
  fs.mkdirSync(pg);
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(pg, 'f' + i + '.txt'), 'x');
  const lp1 = list.run({ path: pg, limit: 3, offset: 0 });
  t('list 翻页 shown', lp1.shown, 3);
  tOk('list 翻页截断', lp1.truncated === true, 'truncated=' + lp1.truncated);
  tOk('list 翻页提示', /翻页/.test(lp1._text), '');
  const lp2 = list.run({ path: pg, limit: 3, offset: 9 });
  t('list 末页 shown', lp2.shown, 3);
  tOk('list 末页不截断', lp2.truncated === false, 'truncated=' + lp2.truncated);

  /* ---------------- fsx_tree ---------------- */
  section('fsx_tree');
  const tr = tree.run({ path: ls, depth: 3 });
  tOk('tree 含根目录名', tr._text.includes('ls'), '');
  tOk('tree 含子目录标记', tr._text.includes('sub/'), '');
  tOk('tree 含嵌套文件', tr._text.includes('inner.md'), '');
  tOk('tree 节点数 >= 含子项', tr.nodeCount >= 5, 'nodeCount=' + tr.nodeCount);
  // 深度限制：depth=0 只显示根
  const tr0 = tree.run({ path: ls, depth: 0 });
  t('tree depth=0 只根节点', tr0.nodeCount, 1);
  // 深度限制：depth=1 显示根 + 直接子项（4 个）
  const tr1 = tree.run({ path: ls, depth: 1 });
  t('tree depth=1 节点数', tr1.nodeCount, 5);

  /* ---------------- fsx_stat ---------------- */
  section('fsx_stat');
  const sr = stat.run({ path: rf });
  t('stat 文件类型', sr.items[0].type, 'file');
  t('stat 行数', sr.items[0].lines, 5);
  tOk('stat 编码猜测 UTF-8', /UTF-8/.test(sr.items[0].encoding), sr.items[0].encoding);
  const sr2 = stat.run({ paths: [rf, ef, ls] });
  t('stat 批量数量', sr2.items.length, 3);
  const sr3 = stat.run({ path: path.join(base, 'nope.txt') });
  t('stat 不存在标记', sr3.items[0].exists, false);
  const sr4 = stat.run({ path: ls });
  t('stat 目录类型', sr4.items[0].type, 'dir');

  /* ---------------- fsx_grep ---------------- */
  section('fsx_grep');
  const gf = path.join(base, 'code.js');
  write.run({ path: gf, content: 'foo()\nbar()\nfoo() again\n' });
  const g1 = grep.run({ pattern: 'foo', path: base, recursive: true });
  t('grep 字面量命中', g1.total, 2);
  const g2 = grep.run({ pattern: 'FOO', path: base, recursive: true, caseSensitive: true });
  t('grep 区分大小写 0 命中', g2.total, 0);
  const g3 = grep.run({ pattern: 'foo', path: base, recursive: true, include: '*.js' });
  t('grep include *.js', g3.total, 2);
  const g4 = grep.run({ pattern: 'f.o', path: base, recursive: true, mode: 'regex' });
  t('grep 正则 f.o', g4.total, 2);
  // 上下文行
  const g5 = grep.run({ pattern: 'bar', path: gf, context: 1 });
  t('grep 上下文 before 行数', g5.matches[0].contextBefore.length, 1);
  t('grep 上下文 after 行数', g5.matches[0].contextAfter.length, 1);
  // 翻页
  const gpf = path.join(base, 'hits.txt');
  write.run({ path: gpf, content: Array.from({ length: 10 }, (_, i) => 'row' + i + ' TARGET').join('\n') + '\n' });
  const g6 = grep.run({ pattern: 'TARGET', path: gpf, limit: 3, offset: 0 });
  t('grep 翻页 shown', g6.shown, 3);
  tOk('grep 翻页截断', g6.truncated === true, 'truncated=' + g6.truncated);
  const g7 = grep.run({ pattern: 'TARGET', path: gpf, limit: 3, offset: 9 });
  t('grep 末页 shown', g7.shown, 1);

  /* ---------------- fsx_copy ---------------- */
  section('fsx_copy');
  const cpSrc = path.join(base, 'cp.txt');
  write.run({ path: cpSrc, content: 'copy me' });
  const cpDst = path.join(base, 'cp_out.txt');
  const cp1 = copy.run({ source: cpSrc, dest: cpDst });
  t('copy 项数', cp1.items, 1);
  t('copy 字节数', cp1.bytes, 7);
  tOk('copy 目标存在', fs.existsSync(cpDst), '');
  t('copy 内容一致', fs.readFileSync(cpDst, 'utf8'), 'copy me');
  let cpErr = false, cpMsg = '';
  try { copy.run({ source: cpSrc, dest: cpDst }); } catch (e) { cpErr = true; cpMsg = e.message; }
  tOk('copy 覆盖需 overwrite', cpErr && /目标已存在/.test(cpMsg), cpMsg);
  // 目录复制
  const cpDirSrc = path.join(base, 'cpdir');
  fs.mkdirSync(cpDirSrc);
  write.run({ path: path.join(cpDirSrc, 'x.txt'), content: 'x' });
  write.run({ path: path.join(cpDirSrc, 'y.txt'), content: 'y' });
  const cp2 = copy.run({ source: cpDirSrc, dest: path.join(base, 'cpdir_out') });
  tOk('copy 目录项数>1', cp2.items >= 2, 'items=' + cp2.items);
  tOk('copy 目录目标存在', fs.existsSync(path.join(base, 'cpdir_out', 'y.txt')), '');

  /* ---------------- fsx_move ---------------- */
  section('fsx_move');
  const mvSrc = path.join(base, 'mv.txt');
  write.run({ path: mvSrc, content: 'move me' });
  const mvDst = path.join(base, 'mv_out.txt');
  const mv1 = move.run({ source: mvSrc, dest: mvDst });
  tOk('move 同盘非跨设备', mv1.crossDevice === false, 'cross=' + mv1.crossDevice);
  tOk('move 源消失', !fs.existsSync(mvSrc), '');
  tOk('move 目标存在', fs.existsSync(mvDst), '');
  let mvErr = false, mvMsg = '';
  try { move.run({ source: path.join(base, 'mv_out.txt'), dest: path.join(base, 'cp_out.txt') }); } catch (e) { mvErr = true; mvMsg = e.message; }
  tOk('move 覆盖需 overwrite', mvErr && /目标已存在/.test(mvMsg), mvMsg);

  /* ---------------- fsx_delete ---------------- */
  section('fsx_delete');
  // 正常确认删除
  const dFile = path.join(base, 'del.txt');
  write.run({ path: dFile, content: 'bye' });
  const d1 = del.run({ path: dFile, confirm: true });
  tOk('delete 确认后文件消失', !fs.existsSync(dFile), '');
  t('delete 确认项数', d1.items, 1);
  // 无 confirm → 预览，不删
  const dKeep = path.join(base, 'keep.txt');
  write.run({ path: dKeep, content: 'keep' });
  const d2 = del.run({ path: dKeep });
  tOk('delete 无 confirm 不删除', fs.existsSync(dKeep), '');
  tOk('delete 无 confirm 返回预览', d2.preview === true, '');
  // dryRun → 预览，不删
  const dDry = path.join(base, 'dry.txt');
  write.run({ path: dDry, content: 'dry' });
  const d3 = del.run({ path: dDry, dryRun: true });
  tOk('delete dryRun 不删除', fs.existsSync(dDry), '');
  tOk('delete dryRun 返回预览', d3.preview === true && d3.dryRun === true, '');
  // 目录无 recursive → 拒绝
  const dDir = path.join(base, 'ddir');
  fs.mkdirSync(dDir);
  fs.writeFileSync(path.join(dDir, 'z.txt'), 'z');
  let dErrRec = false, dRecMsg = '';
  try { del.run({ path: dDir, confirm: true }); } catch (e) { dErrRec = true; dRecMsg = e.message; }
  tOk('delete 目录需 recursive', dErrRec && /recursive/.test(dRecMsg), dRecMsg);
  tOk('delete 目录未删（未授权）', fs.existsSync(dDir), '');
  // 目录 recursive → 成功
  const d4 = del.run({ path: dDir, confirm: true, recursive: true });
  tOk('delete 目录 recursive 后消失', !fs.existsSync(dDir), '');
  t('delete 目录 recursive 项数', d4.items, 2);

  /* ---------------- isProtected（delete 安全闸绕过测试） ---------------- */
  section('isProtected 安全闸');
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  tOk('保护: 系统目录', isProtected(sysRoot) !== null, sysRoot);
  tOk('保护: 盘符根 C:\\', isProtected('C:\\') !== null, '');
  tOk('保护: 末尾斜杠 C:\\Windows\\', isProtected('C:\\Windows\\') !== null, '');
  tOk('保护: 大小写变体 C:\\WINDOWS', isProtected('C:\\WINDOWS') !== null, '');
  tOk('保护: .. 穿越 C:\\Windows\\..', isProtected('C:\\Windows\\..') !== null, '');
  tOk('保护: 相对穿越 C:\\Users\\..\\Windows', isProtected('C:\\Users\\..\\Windows') !== null, '');
  tOk('保护: 用户主目录', isProtected(os.homedir()) !== null, '');
  // 一个临时路径不应被保护（可被正常删除）
  tOk('非保护: 临时文件可删', isProtected(dFile) === null, '');
  // 受保护路径即使 confirm 也拒绝执行
  let dProt = false, dProtMsg = '';
  try { del.run({ path: sysRoot, confirm: true, recursive: true }); } catch (e) { dProt = true; dProtMsg = e.message; }
  tOk('delete 受保护路径拒绝执行', dProt && /受保护/.test(dProtMsg), dProtMsg);

} catch (e) {
  fail++;
  failures.push('运行时异常: ' + e.message + '\n' + e.stack);
  console.log('  FAIL  运行时异常: ' + e.message);
} finally {
  if (base) { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {} }
}

console.log('\n' + '='.repeat(52));
console.log(`  通过 ${pass}  失败 ${fail}`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  · ' + f));
}
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);
