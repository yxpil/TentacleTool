'use strict';
/**
 * gitx MCP 端到端自测：自己 spawn 服务器，走完整 JSON-RPC 流程
 *   运行：node test/mcp.e2e.js
 *
 * 测试端口用 18351（= 18000 + 正式端口 8351），避免和真实服务冲突。
 * 断言值全部来自「先跑探针看真实输出、再写期望」的流程，不是凭想象。
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PORT = 18351;
const ROOT = path.join(__dirname, '..');
const GIT = 'C:/Program Files/Git/cmd/git.exe';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? '  —— ' + detail : '')); console.log('  FAIL  ' + name); }
}

/* ---------- 自建临时 git 仓库作为调用目标（不碰用户真实仓库） ---------- */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-e2e-'));
const repo = path.join(base, 'repo');
fs.mkdirSync(repo);
function g(cwd, args) {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '').replace(/\r\n/g, '\n'), err: (r.stderr || '').replace(/\r\n/g, '\n') };
}
g(repo, ['init']);
g(repo, ['config', 'user.email', 'e2e@example.com']);
g(repo, ['config', 'user.name', 'E2E']);
fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\nworld\n');
fs.writeFileSync(path.join(repo, 'b.txt'), 'x\ny\n');
g(repo, ['add', '-A']);
g(repo, ['commit', '-m', 'init']);
fs.appendFileSync(path.join(repo, 'a.txt'), 'more\n');
g(repo, ['add', '-A']);
g(repo, ['commit', '-m', 'edit a']);
g(repo, ['branch', 'feature']);

/* ---------- HTTP JSON-RPC 客户端 ---------- */
let sessionId = null;
function rpc(method, params, id = 1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body)
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', method: 'POST', headers }, res => {
      const sid = res.headers['mcp-session-id'];
      if (sid) sessionId = sid;
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve(null);
        let payload = text;
        if (text.startsWith('event:') || text.startsWith('data:')) {
          const m = text.match(/data:\s*(\{[\s\S]*\})/);
          if (m) payload = m[1];
        }
        try { resolve(JSON.parse(payload)); }
        catch (e) { reject(new Error('非 JSON 响应: ' + text.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function waitPort(port, timeoutMs = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) return reject(new Error('端口 ' + port + ' 等待超时'));
        setTimeout(tick, 120);
      });
    };
    tick();
  });
}

function textOf(resp) {
  if (!resp || !resp.result || !resp.result.content) return '';
  return resp.result.content.map(c => c.text || '').join('\n');
}
function structuredOf(resp) {
  if (!resp || !resp.result) return null;
  return resp.result.structuredContent || null;
}
async function call(name, args, id) {
  const r = await rpc('tools/call', { name, arguments: args }, id);
  return { raw: r, isError: !!(r && r.result && r.result.isError), text: textOf(r), structured: structuredOf(r) };
}

const TOOL_NAMES = ['gitx_status', 'gitx_log', 'gitx_diff', 'gitx_show', 'gitx_blame', 'gitx_file_history', 'gitx_branch', 'gitx_stash', 'gitx_remote', 'gitx_commit'];

/* ==================================================================== */
(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { GITX_PORT: String(PORT), GIT_BINARY: GIT }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootLog = '';
  child.stdout.on('data', d => { bootLog += d.toString(); });
  child.stderr.on('data', d => { bootLog += d.toString(); });
  const cleanup = () => { try { child.kill(); } catch (e) {} };

  let idc = 1;
  const nid = () => ++idc;

  try {
    await waitPort(PORT);
    console.log('\n服务器已在端口 ' + PORT + ' 就绪\n');

    /* ---------------- initialize ---------------- */
    console.log('=== initialize ===');
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'gitx-e2e', version: '1.0.0' }
    }, 1);
    check('initialize 返回结果', !!(init && init.result));
    check('协议版本正确', init && init.result && init.result.protocolVersion === '2025-03-26', init && init.result && init.result.protocolVersion);
    check('serverInfo.name 为 gitx', init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'gitx', init && init.result && init.result.serverInfo && init.result.serverInfo.name);
    check('返回 instructions', !!(init && init.result && init.result.instructions));
    const instr = (init && init.result && init.result.instructions) || '';
    for (const n of TOOL_NAMES) {
      check('instructions 列出 ' + n, instr.indexOf(n) >= 0, '');
    }
    check('instructions 声明安全边界（不做 push 等）', /push/.test(instr) && /rebase/.test(instr), '');

    await rpc('notifications/initialized', {}, 2);

    /* ---------------- tools/list ---------------- */
    console.log('\n=== tools/list ===');
    const tl = await rpc('tools/list', {}, 3);
    const tools = (tl && tl.result && tl.result.tools) || [];
    check('返回 10 个工具', tools.length === 10, '实际 ' + tools.length);
    const names = tools.map(t => t.name).sort();
    check('工具名完全匹配', JSON.stringify(names) === JSON.stringify(TOOL_NAMES.slice().sort()), JSON.stringify(names));
    check('每个工具都有 title', tools.every(t => typeof t.title === 'string' && t.title.length > 0));
    check('每个工具都有 description', tools.every(t => typeof t.description === 'string' && t.description.length > 20));
    check('每个工具都有 inputSchema', tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));
    check('每个工具 inputSchema 都含 repoPath', tools.every(t => t.inputSchema.properties && t.inputSchema.properties.repoPath));
    check('每个工具 inputSchema 都含 gitBinary', tools.every(t => t.inputSchema.properties && t.inputSchema.properties.gitBinary));

    const A = { repoPath: repo };

    /* ---------------- gitx_status ---------------- */
    console.log('\n=== tools/call: gitx_status ===');
    const s1 = await call('gitx_status', A, nid());
    check('status 成功', !s1.isError, s1.text.slice(0, 200));
    check('status 文本是纯文本（不以 { 开头）', !/^\s*\{/.test(s1.text), s1.text.slice(0, 60));
    check('status 文本含分支', /分支/.test(s1.text), '');
    check('status 结构化 branch=master', s1.structured && s1.structured.branch === 'master', s1.structured && s1.structured.branch);
    check('status 结构化 lastCommit 主题', s1.structured && s1.structured.lastCommit && s1.structured.lastCommit.subject === 'edit a', JSON.stringify(s1.structured && s1.structured.lastCommit));
    check('status 结构化不含 _text 键', s1.structured && !('_text' in s1.structured));
    check('status 结构化不含 [object Object]', !/\[object Object\]/.test(s1.text), s1.text.slice(0, 200));

    /* ---------------- gitx_log ---------------- */
    console.log('\n=== tools/call: gitx_log ===');
    const l1 = await call('gitx_log', Object.assign({}, A, { limit: 10 }), nid());
    check('log 成功', !l1.isError, l1.text.slice(0, 200));
    check('log 文本是纯文本', !/^\s*\{/.test(l1.text));
    check('log 结构化 2 条', l1.structured && l1.structured.count === 2, l1.structured && l1.structured.count);
    check('log 最新主题', l1.structured && l1.structured.commits[0].subject === 'edit a', l1.structured && l1.structured.commits[0].subject);
    check('log 结构化不含 _text', l1.structured && !('_text' in l1.structured));

    /* ---------------- gitx_branch list ---------------- */
    console.log('\n=== tools/call: gitx_branch (list) ===');
    const b1 = await call('gitx_branch', Object.assign({}, A, { action: 'list' }), nid());
    check('branch list 成功', !b1.isError, b1.text.slice(0, 200));
    check('branch list 含 master/feature', b1.structured && b1.structured.branches.length === 2, b1.structured && b1.structured.branches.length);
    check('branch list 当前 master', b1.structured && b1.structured.current === 'master', b1.structured && b1.structured.current);

    /* ---------------- gitx_branch 安全闸：删当前分支被拒 ---------------- */
    console.log('\n=== tools/call: gitx_branch (安全闸) ===');
    const b2 = await call('gitx_branch', Object.assign({}, A, { action: 'delete', name: 'master' }), nid());
    check('删当前分支返回 isError', b2.isError, b2.text.slice(0, 200));
    check('删当前分支提示含"当前"', /当前/.test(b2.text), b2.text.slice(0, 200));

    /* ---------------- gitx_diff 暂存区 ---------------- */
    console.log('\n=== tools/call: gitx_diff ===');
    fs.appendFileSync(path.join(repo, 'b.txt'), 'staged\n');
    g(repo, ['add', 'b.txt']);
    const d1 = await call('gitx_diff', Object.assign({}, A, { staged: true }), nid());
    check('diff 成功', !d1.isError, d1.text.slice(0, 200));
    check('diff 结构化 fileCount>=1', d1.structured && d1.structured.fileCount >= 1, d1.structured && d1.structured.fileCount);
    check('diff 结构化不含 _text', d1.structured && !('_text' in d1.structured));

    /* ---------------- gitx_commit ---------------- */
    console.log('\n=== tools/call: gitx_commit ===');
    const c1 = await call('gitx_commit', Object.assign({}, A, { message: 'e2e commit', addAll: true }), nid());
    check('commit 成功', !c1.isError, c1.text.slice(0, 200));
    check('commit 文本含已提交', /已提交/.test(c1.text), '');
    check('commit 结构化 shortHash 7 位', c1.structured && c1.structured.shortHash && c1.structured.shortHash.length === 7, c1.structured && c1.structured.shortHash);
    // 缺 message → isError
    const c2 = await call('gitx_commit', Object.assign({}, A, { addAll: true }), nid());
    check('commit 缺 message 返回 isError', c2.isError, c2.text.slice(0, 200));

    /* ---------------- 未知工具 / 错误处理 ---------------- */
    console.log('\n=== 错误处理 ===');
    const e1 = await call('no_such_tool', {}, nid());
    check('未知工具返回 isError', e1.isError);
    check('未知工具列出可用工具', /gitx_status/.test(e1.text) && /gitx_commit/.test(e1.text), e1.text.slice(0, 300));
    const e2 = await call('gitx_status', { repoPath: base }, nid());
    check('非 git 仓库返回 isError', e2.isError);
    check('非 git 仓库给出明确错误', /不是 Git 仓库/.test(e2.text), e2.text.slice(0, 200));

    /* ---------------- ping / 其它协议方法 ---------------- */
    console.log('\n=== 协议方法 ===');
    const ping = await rpc('ping', {}, nid());
    check('ping 返回空结果', !!(ping && ping.result && typeof ping.result === 'object'));
    const rl = await rpc('resources/list', {}, nid());
    check('resources/list 返回空数组', !!(rl && rl.result && Array.isArray(rl.result.resources)));
    const pl = await rpc('prompts/list', {}, nid());
    check('prompts/list 返回空数组', !!(pl && pl.result && Array.isArray(pl.result.prompts)));

    check('服务器进程仍存活（无崩溃）', child.exitCode === null && !child.killed, 'exitCode=' + child.exitCode);

  } catch (e) {
    fail++;
    failures.push('运行时异常: ' + e.message);
    console.log('  FAIL  运行时异常: ' + e.message + '\n' + e.stack);
  } finally {
    cleanup();
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}
    if (bootLog && fail) { console.log('\n--- 服务器启动日志(排错) ---\n' + bootLog.slice(0, 800)); }
  }

  console.log('\n' + '='.repeat(52));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  · ' + f));
  }
  console.log('='.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
