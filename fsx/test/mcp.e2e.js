'use strict';
/**
 * fsx 端到端自测：自己 spawn 服务器，走完整 JSON-RPC 流程
 *   运行：node test/mcp.e2e.js
 *
 * 测试端口用 18350（= 18000 + 正式端口 8350），避免和真实服务冲突。
 * 只在 os.tmpdir() 下自建临时目录操作真实文件，结束清理；不碰用户真实文件。
 * 断言值来自「先跑探针看真实输出、再写期望」的流程，不是凭想象。
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 18350;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? '  —— ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  —— ' + detail : ''));
  }
}

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

function waitPort(port, timeoutMs = 12000) {
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

/* ==================================================================== */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsx-e2e-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { FSX_PORT: String(PORT) }),
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
      clientInfo: { name: 'fsx-e2e', version: '1.0.0' }
    }, 1);
    check('initialize 返回结果', !!(init && init.result));
    check('协议版本正确', init && init.result && init.result.protocolVersion === '2025-03-26',
      init && init.result && init.result.protocolVersion);
    check('serverInfo.name 为 fsx',
      init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'fsx',
      init && init.result && init.result.serverInfo && init.result.serverInfo.name);
    check('返回 instructions', !!(init && init.result && init.result.instructions));
    const instr = (init && init.result && init.result.instructions) || '';
    check('instructions 列出全部 10 个工具',
      ['fsx_read', 'fsx_write', 'fsx_edit', 'fsx_list', 'fsx_tree', 'fsx_stat', 'fsx_grep', 'fsx_copy', 'fsx_move', 'fsx_delete']
        .every(n => instr.indexOf(n) >= 0), instr.slice(0, 200));
    check('instructions 声明删除需 confirm', /confirm/.test(instr));

    await rpc('notifications/initialized', {}, 2);

    /* ---------------- tools/list ---------------- */
    console.log('\n=== tools/list ===');
    const tl = await rpc('tools/list', {}, 3);
    const tools = (tl && tl.result && tl.result.tools) || [];
    check('返回 10 个工具', tools.length === 10, '实际 ' + tools.length);
    const names = tools.map(t => t.name).sort();
    const expected = ['fsx_copy', 'fsx_delete', 'fsx_edit', 'fsx_grep', 'fsx_list', 'fsx_move', 'fsx_read', 'fsx_stat', 'fsx_tree', 'fsx_write'];
    check('工具名完全匹配', JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
    check('每个工具都有 title', tools.every(t => typeof t.title === 'string' && t.title.length > 0));
    check('每个工具都有 description', tools.every(t => typeof t.description === 'string' && t.description.length > 20));
    check('每个工具都有 inputSchema', tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));
    check('fsx_delete 的 description 声明 confirm', /confirm/.test((tools.find(t => t.name === 'fsx_delete') || {}).description || ''));

    /* ---------------- 工具调用（真实文件系统，在 tmp 下） ---------------- */
    const f1 = path.join(tmp, 'doc.txt');
    console.log('\n=== tools/call: fsx_write / read / edit ===');
    const w1 = await call('fsx_write', { path: f1, content: 'alpha\nbeta\ngamma\n' }, nid());
    check('fsx_write 成功', !w1.isError, w1.text.slice(0, 200));
    check('fsx_write 结构化 bytes=17', w1.structured && w1.structured.bytes === 17, w1.structured && w1.structured.bytes);
    check('★ 契约：content[0].text 不以 { 开头', w1.text && !w1.text.trimStart().startsWith('{'), w1.text.slice(0, 20));
    check('★ 契约：structuredContent 不含 _text', w1.structured && !('_text' in w1.structured));

    const r1 = await call('fsx_read', { path: f1 }, nid());
    check('fsx_read 成功', !r1.isError, r1.text.slice(0, 200));
    check('fsx_read 文本含内容行', /gamma/.test(r1.text));
    check('fsx_read 结构化 totalLines=3', r1.structured && r1.structured.totalLines === 3, r1.structured && r1.structured.totalLines);

    const e1 = await call('fsx_edit', { path: f1, oldText: 'beta', newText: 'BETA' }, nid());
    check('fsx_edit 成功', !e1.isError, e1.text.slice(0, 200));
    check('fsx_edit 匹配数=1', e1.structured && e1.structured.matches === 1, e1.structured && e1.structured.matches);
    check('fsx_edit 改动行=2', e1.structured && JSON.stringify(e1.structured.changedLines) === '[2]', e1.structured && JSON.stringify(e1.structured.changedLines));

    console.log('\n=== tools/call: fsx_list / tree / stat / grep ===');
    const f2 = path.join(tmp, 'sub');
    fs.mkdirSync(f2);
    fs.writeFileSync(path.join(f2, 'note.md'), '# note\n');
    const l1 = await call('fsx_list', { path: tmp, recursive: true }, nid());
    check('fsx_list 递归列出 tmp', !l1.isError && l1.structured.total >= 3, l1.structured && l1.structured.total);
    const t1 = await call('fsx_tree', { path: tmp, depth: 3 }, nid());
    check('fsx_tree 成功且含子目录', !t1.isError && /sub\//.test(t1.text), t1.text.slice(0, 200));
    const s1 = await call('fsx_stat', { paths: [f1, f2] }, nid());
    check('fsx_stat 批量 2 项', s1.structured && s1.structured.items.length === 2, s1.structured && s1.structured.items.length);
    check('fsx_stat 区分文件/目录', s1.structured &&
      s1.structured.items.some(i => i.type === 'file') && s1.structured.items.some(i => i.type === 'dir'));
    const g1 = await call('fsx_grep', { pattern: 'BETA', path: tmp, recursive: true }, nid());
    check('fsx_grep 命中编辑后的内容', !g1.isError && g1.structured.total >= 1, g1.structured && g1.structured.total);
    check('fsx_grep 命中带行号', g1.structured && g1.structured.matches[0] && g1.structured.matches[0].line >= 1);

    console.log('\n=== tools/call: fsx_copy / move ===');
    const c1 = await call('fsx_copy', { source: f1, dest: path.join(tmp, 'copy.txt') }, nid());
    check('fsx_copy 成功', !c1.isError && c1.structured.items === 1, c1.text.slice(0, 200));
    check('fsx_copy 目标存在', fs.existsSync(path.join(tmp, 'copy.txt')));
    const m1 = await call('fsx_move', { source: path.join(tmp, 'copy.txt'), dest: path.join(tmp, 'moved.txt') }, nid());
    check('fsx_move 成功', !m1.isError, m1.text.slice(0, 200));
    check('fsx_move 源消失', !fs.existsSync(path.join(tmp, 'copy.txt')));
    check('fsx_move 目标存在', fs.existsSync(path.join(tmp, 'moved.txt')));

    console.log('\n=== fsx_delete 安全闸（e2e 真实调用） ===');
    const dKeep = path.join(tmp, 'keep.txt');
    fs.writeFileSync(dKeep, 'keep');
    const dNoConfirm = await call('fsx_delete', { path: dKeep }, nid());
    check('delete 无 confirm 不报错（返回预览）', !dNoConfirm.isError, dNoConfirm.text.slice(0, 200));
    check('delete 无 confirm 返回 preview=true', dNoConfirm.structured && dNoConfirm.structured.preview === true);
    check('delete 无 confirm 文件仍在', fs.existsSync(dKeep));
    const dConfirm = await call('fsx_delete', { path: dKeep, confirm: true }, nid());
    check('delete 有 confirm 执行删除', !dConfirm.isError && dConfirm.structured.deleted === true, dConfirm.text.slice(0, 200));
    check('delete 有 confirm 文件已消失', !fs.existsSync(dKeep));
    const dDry = await call('fsx_delete', { path: path.join(tmp, 'moved.txt'), dryRun: true }, nid());
    check('delete dryRun 不删且 preview', dDry.structured && dDry.structured.preview === true && dDry.structured.dryRun === true);
    check('delete dryRun 文件仍在', fs.existsSync(path.join(tmp, 'moved.txt')));
    // 目录无 recursive → 拒绝
    const dDir = path.join(tmp, 'dd');
    fs.mkdirSync(dDir); fs.writeFileSync(path.join(dDir, 'x.txt'), 'x');
    const dNoRec = await call('fsx_delete', { path: dDir, confirm: true }, nid());
    check('delete 目录无 recursive 报错', dNoRec.isError && /recursive/.test(dNoRec.text), dNoRec.text.slice(0, 200));
    check('delete 目录无 recursive 未删', fs.existsSync(dDir));
    const dRec = await call('fsx_delete', { path: dDir, confirm: true, recursive: true }, nid());
    check('delete 目录 recursive 成功', !dRec.isError && dRec.structured.deleted === true);
    check('delete 目录 recursive 已消失', !fs.existsSync(dDir));
    // 受保护路径即使 confirm 也拒绝
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const dProt = await call('fsx_delete', { path: sysRoot, confirm: true, recursive: true }, nid());
    check('delete 受保护路径报错', dProt.isError && /受保护/.test(dProt.text), dProt.text.slice(0, 200));
    check('delete 受保护路径错误文本含拒绝说明', dProt.isError && /拒绝删除/.test(dProt.text), dProt.text.slice(0, 200));

    console.log('\n=== 协议方法 ===');
    const ping = await rpc('ping', {}, nid());
    check('ping 返回空结果', !!(ping && ping.result && typeof ping.result === 'object'));
    const rl = await rpc('resources/list', {}, nid());
    check('resources/list 返回空数组', !!(rl && rl.result && Array.isArray(rl.result.resources)));
    const pl = await rpc('prompts/list', {}, nid());
    check('prompts/list 返回空数组', !!(pl && pl.result && Array.isArray(pl.result.prompts)));
    const unknown = await call('no_such_tool', {}, nid());
    check('未知工具返回 isError', unknown.isError);

    check('服务器进程仍存活（无崩溃）', child.exitCode === null && !child.killed, 'exitCode=' + child.exitCode);

  } catch (e) {
    fail++;
    failures.push('运行时异常: ' + e.message);
    console.log('  FAIL  运行时异常: ' + e.message + '\n' + e.stack);
  } finally {
    cleanup();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
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
