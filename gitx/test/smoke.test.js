'use strict';
/**
 * gitx 纯逻辑层单测（不启动 MCP、不碰用户真实仓库）
 *
 * 所有用例只在 os.tmpdir() 下自建临时 git 仓库操作，结束后清理。
 * 期望值来自「先跑探针看真实行为、再写期望」的流程，不是凭想象。
 * 通过 GIT_BINARY 环境变量指定本机 git 路径（本机 git 不在 PATH）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

process.env.GIT_BINARY = 'C:/Program Files/Git/cmd/git.exe';

const reg = require('../src/tools/registry');
const status = reg.getTool('gitx_status');
const log = reg.getTool('gitx_log');
const diff = reg.getTool('gitx_diff');
const show = reg.getTool('gitx_show');
const blame = reg.getTool('gitx_blame');
const fileHistory = reg.getTool('gitx_file_history');
const branch = reg.getTool('gitx_branch');
const stash = reg.getTool('gitx_stash');
const remote = reg.getTool('gitx_remote');
const commit = reg.getTool('gitx_commit');

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

const GIT = process.env.GIT_BINARY;
function g(cwd, args) {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '').replace(/\r\n/g, '\n'), err: (r.stderr || '').replace(/\r\n/g, '\n') };
}

let repo, upstream, base;
try {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-smoke-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  upstream = path.join(base, 'upstream.git');
  // 初始化仓库 + 身份
  g(repo, ['init']);
  g(repo, ['config', 'user.email', 'smoke@example.com']);
  g(repo, ['config', 'user.name', 'Smoke']);

  // 第 1 个提交：a.txt / b.txt
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\nworld\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'line1\nline2\nline3\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-m', 'init: two files']);

  // 第 2 个提交：改 a.txt、新增 c.txt
  fs.appendFileSync(path.join(repo, 'a.txt'), 'more\n');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'ccc\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-m', 'add c and edit a']);

  // 创建并切回 feature 分支
  g(repo, ['branch', 'feature']);
  g(repo, ['switch', 'master']);

  // 工作区改动：b.txt 未暂存改动；c.txt 暂存改动；d.txt 未跟踪
  fs.appendFileSync(path.join(repo, 'b.txt'), 'unstaged\n');
  fs.appendFileSync(path.join(repo, 'c.txt'), 'staged\n');
  g(repo, ['add', 'c.txt']);
  fs.writeFileSync(path.join(repo, 'd.txt'), 'd\n');

  const A = { repoPath: repo };

  /* ---------------- gitx_status ---------------- */
  section('gitx_status');
  const st = status.run(A);
  t('status 分支名', st.branch, 'master');
  t('status upstream 为空', st.upstream, null);
  tOk('status 不干净', st.clean === false, 'clean=' + st.clean);
  t('status 暂存 1 个(c.txt)', st.staged.length, 1);
  t('status 暂存路径', st.staged[0] && st.staged[0].path, 'c.txt');
  t('status 未暂存 1 个(b.txt)', st.unstaged.length, 1);
  t('status 未暂存路径', st.unstaged[0] && st.unstaged[0].path, 'b.txt');
  t('status 未跟踪 1 个(d.txt)', st.untracked.length, 1);
  t('status 未跟踪路径', st.untracked[0], 'd.txt');
  tOk('status 最近提交存在', !!st.lastCommit);
  t('status 最近提交主题', st.lastCommit && st.lastCommit.subject, 'add c and edit a');
  tOk('status 最近提交短哈希 7 位', st.lastCommit && st.lastCommit.shortHash.length === 7);
  tOk('status 文本含分支', /分支: master/.test(st._text));
  tOk('status 文本含未跟踪段', /未跟踪/.test(st._text));
  tOk('status 文本无 [object Object]', !/\[object Object\]/.test(st._text));

  /* ---------------- gitx_log ---------------- */
  section('gitx_log');
  const lg = log.run(Object.assign({}, A, { limit: 10 }));
  t('log 提交数', lg.count, 2);
  t('log 最新主题', lg.commits[0].subject, 'add c and edit a');
  t('log 最旧主题', lg.commits[1].subject, 'init: two files');
  t('log 最新提交文件数', lg.commits[0].files.length, 2);
  t('log 最新提交增行', lg.commits[0].added, 2);
  t('log 最新提交含 a.txt', lg.commits[0].files.some(f => f.path === 'a.txt'), true);
  tOk('log 文本含两提交', /add c and edit a/.test(lg._text) && /init: two files/.test(lg._text));
  const lg2 = log.run(Object.assign({}, A, { oneline: false, limit: 1 }));
  tOk('log 详细模式含增删行', /\+\d+ \/ -\d+/.test(lg2._text), '');
  const lg3 = log.run(Object.assign({}, A, { author: 'Nope' }));
  t('log 按作者过滤 0 命中', lg3.count, 0);

  /* ---------------- gitx_diff ---------------- */
  section('gitx_diff');
  const dfStaged = diff.run(Object.assign({}, A, { staged: true }));
  t('diff 暂存区文件数', dfStaged.fileCount, 1);
  t('diff 暂存区路径', dfStaged.files[0].path, 'c.txt');
  t('diff 暂存区增行', dfStaged.added, 1);
  tOk('diff 暂存区文本含 c.txt', /c\.txt/.test(dfStaged._text));
  const dfWork = diff.run(Object.assign({}, A, {}));
  tOk('diff 工作区含 b.txt', dfWork.files.some(f => f.path === 'b.txt'), JSON.stringify(dfWork.files));
  const dfRange = diff.run(Object.assign({}, A, { commit: lg.commits[1].shortHash, commit2: lg.commits[0].shortHash }));
  t('diff 两提交文件数', dfRange.fileCount, 2);
  t('diff 两提交增行', dfRange.added, 2);
  const dfStat = diff.run(Object.assign({}, A, { staged: true, stat: true }));
  t('diff stat 文件数', dfStat.fileCount, 1);
  tOk('diff stat 文本含 c.txt', /c\.txt/.test(dfStat._text));

  /* ---------------- gitx_show ---------------- */
  section('gitx_show');
  const shC = show.run(Object.assign({}, A, { ref: 'HEAD' }));
  t('show 提交类型', shC.type, 'commit');
  tOk('show 提交文件数 2', shC.commit && shC.commit.files.length === 2, JSON.stringify(shC.commit && shC.commit.files));
  t('show 提交主题', shC.commit && shC.commit.subject, 'add c and edit a');
  const shF = show.run(Object.assign({}, A, { ref: 'HEAD', path: 'a.txt' }));
  t('show 文件类型', shF.type, 'file');
  t('show 文件大小', shF.size, 17);   // hello\nworld\nmore\n = 17 字节
  tOk('show 文件内容含 more', /more/.test(shF.content), shF.content);
  tOk('show 文件文本含路径', /a\.txt/.test(shF._text));

  /* ---------------- gitx_blame ---------------- */
  section('gitx_blame');
  const bl = blame.run(Object.assign({}, A, { path: 'a.txt' }));
  t('blame 行数', bl.count, 3);
  t('blame 第1行内容', bl.lines[0].content, 'hello');
  t('blame 第3行内容', bl.lines[2].content, 'more');
  t('blame 第1行作者', bl.lines[0].author, 'Smoke');
  tOk('blame 文本含行号表头', /行号/.test(bl._text));
  const blR = blame.run(Object.assign({}, A, { path: 'a.txt', startLine: 2, endLine: 2 }));
  t('blame 行范围只 1 行', blR.count, 1);
  t('blame 行范围内容', blR.lines[0].content, 'world');

  /* ---------------- gitx_file_history ---------------- */
  section('gitx_file_history');
  const fh = fileHistory.run(Object.assign({}, A, { path: 'a.txt' }));
  t('file_history 命中数', fh.count, 2);
  t('file_history 最新主题', fh.commits[0].subject, 'add c and edit a');
  tOk('file_history 文本含 a.txt', /a\.txt/.test(fh._text));
  const fhN = fileHistory.run(Object.assign({}, A, { path: 'd.txt' }));
  t('file_history 未跟踪文件 0 命中', fhN.count, 0);

  /* ---------------- gitx_branch ---------------- */
  section('gitx_branch');
  const brL = branch.run(Object.assign({}, A, { action: 'list' }));
  t('branch 列表数 2', brL.branches.length, 2);
  t('branch 当前', brL.current, 'master');
  tOk('branch 列表含 feature', brL.branches.some(b => b.name === 'feature'), '');
  const brC = branch.run(Object.assign({}, A, { action: 'create', name: 'tmp' }));
  t('branch 创建成功', brC.action, 'create');
  const brL2 = branch.run(Object.assign({}, A, { action: 'list' }));
  t('branch 创建后 3 个', brL2.branches.length, 3);
  // 不能删当前分支
  let delCurErr = false, delCurMsg = '';
  try { branch.run(Object.assign({}, A, { action: 'delete', name: 'master' })); }
  catch (e) { delCurErr = true; delCurMsg = e.message; }
  tOk('branch 删当前分支被拒', delCurErr && /当前/.test(delCurMsg), delCurMsg);
  // 删 tmp（非当前，已合并）
  const brD = branch.run(Object.assign({}, A, { action: 'delete', name: 'tmp' }));
  tOk('branch 删非当前成功', brD.action === 'delete', '');
  // 未合并分支删需 force
  g(repo, ['switch', '-c', 'exp']);                 // 新建并切到 exp
  fs.appendFileSync(path.join(repo, 'a.txt'), 'exp\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-m', 'exp only commit']);
  g(repo, ['switch', 'master']);
  let delExpErr = false, delExpMsg = '';
  try { branch.run(Object.assign({}, A, { action: 'delete', name: 'exp' })); }
  catch (e) { delExpErr = true; delExpMsg = e.message; }
  tOk('branch 删未合并需 force（被拒）', delExpErr && /force/.test(delExpMsg), delExpMsg);
  const brDF = branch.run(Object.assign({}, A, { action: 'delete', name: 'exp', force: true }));
  tOk('branch force 删未合并成功', brDF.force === true, '');

  /* ---------------- gitx_stash ---------------- */
  section('gitx_stash');
  // 自建确定性的工作区改动：b.txt 未暂存、c.txt 暂存、d.txt 未跟踪
  fs.appendFileSync(path.join(repo, 'b.txt'), 'stash-test\n');
  fs.appendFileSync(path.join(repo, 'c.txt'), 'stash-stage\n');
  g(repo, ['add', 'c.txt']);
  const stSave = stash.run(Object.assign({}, A, { action: 'save', message: 'smoke stash', includeUntracked: true }));
  t('stash 保存成功', stSave.action, 'save');
  const stList = stash.run(Object.assign({}, A, { action: 'list' }));
  t('stash 列表 1 条', stList.count, 1);
  tOk('stash 描述含说明', stList.items.length === 1 && /smoke stash/.test(stList.items[0].description), JSON.stringify(stList.items));
  const stDrop = stash.run(Object.assign({}, A, { action: 'drop', index: 0 }));
  t('stash drop 成功', stDrop.action, 'drop');
  const stList2 = stash.run(Object.assign({}, A, { action: 'list' }));
  t('stash drop 后 0 条', stList2.count, 0);

  /* ---------------- gitx_remote ---------------- */
  section('gitx_remote');
  // 建一个本地裸仓库作为上游，避免联网
  g(base, ['init', '--bare', '-q', 'upstream.git']);
  g(repo, ['remote', 'add', 'origin', upstream]);
  const rmList = remote.run(Object.assign({}, A, { action: 'list' }));
  t('remote 列表 1 个', rmList.remotes.length, 1);
  t('remote 名称', rmList.remotes[0].name, 'origin');
  tOk('remote fetch URL 指向裸仓库', /upstream\.git/.test(rmList.remotes[0].fetch), rmList.remotes[0].fetch);
  const rmFetch = remote.run(Object.assign({}, A, { action: 'fetch', name: 'origin' }));
  t('remote fetch 成功', rmFetch.action, 'fetch');
  tOk('remote fetch 文本含已 fetch', /已 fetch/.test(rmFetch._text));

  /* ---------------- gitx_commit ---------------- */
  section('gitx_commit');
  fs.appendFileSync(path.join(repo, 'd.txt'), 'committed\n');
  const cm = commit.run(Object.assign({}, A, { message: 'smoke commit', addAll: true }));
  tOk('commit 成功返回 7 位短哈希', !!cm.shortHash && cm.shortHash.length === 7, cm.shortHash);
  t('commit 所在分支', cm.branch, 'master');
  t('commit 说明', cm.message, 'smoke commit');
  // 无 message → 报错
  let cmErr = false, cmMsg = '';
  try { commit.run(Object.assign({}, A, { addAll: true })); }
  catch (e) { cmErr = true; cmMsg = e.message; }
  tOk('commit 缺 message 报错', cmErr && /message/.test(cmMsg), cmMsg);

  /* ---------------- 错误路径 ---------------- */
  section('错误处理');
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-notrepo-'));
  let stErr = false, stErrMsg = '';
  try { status.run({ repoPath: notRepo }); }
  catch (e) { stErr = true; stErrMsg = e.message; }
  tOk('非 git 仓库给出明确错误', stErr && /不是 Git 仓库/.test(stErrMsg), stErrMsg);
  fs.rmSync(notRepo, { recursive: true, force: true });

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
