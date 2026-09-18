'use strict';
/**
 * MCP 端到端自测：自己 spawn 服务器，走完整 JSON-RPC 流程
 *   运行：node test/mcp.e2e.js
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const PORT = 18345;            // 用测试端口，避免和真实 8345 冲突
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? '  —— ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  —— ' + detail : '')); }
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
        // 可能是 SSE 包装
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

/* ==================================================================== */
(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CALC_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootLog = '';
  child.stdout.on('data', d => { bootLog += d.toString(); });
  child.stderr.on('data', d => { bootLog += d.toString(); });

  const cleanup = () => { try { child.kill(); } catch (e) {} };

  try {
    await waitPort(PORT);
    console.log('\n服务器已启动 (pid=' + child.pid + ', port=' + PORT + ')\n');

    console.log('=== MCP 握手 ===');
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'calc-e2e', version: '1.0.0' }
    });
    check('initialize 成功', init && init.result && init.result.serverInfo, JSON.stringify(init).slice(0, 200));
    check('serverInfo.name = calc', init && init.result && init.result.serverInfo.name === 'calc',
      init && init.result ? init.result.serverInfo.name : '');
    check('拿到 session id', !!sessionId);

    await rpc('notifications/initialized', {}, undefined);

    console.log('\n=== tools/list ===');
    const list = await rpc('tools/list', {});
    const names = (list.result.tools || []).map(t => t.name);
    check('tools/list 返回 5 个工具', names.length === 5, names.join(', '));
    check('含 calc_equation', names.includes('calc_equation'), names.join(', '));

    const eqTool = (list.result.tools || []).find(t => t.name === 'calc_equation');
    check('calc_equation description 提到非线性', /非线性/.test(eqTool.description), eqTool.description.slice(0, 120));
    const props = Object.keys(eqTool.inputSchema.properties || {});
    check('schema 含 searchRange', props.includes('searchRange'), props.join(', '));
    check('schema 含 guesses', props.includes('guesses'), props.join(', '));
    check('schema 含 maxSolutions', props.includes('maxSolutions'), props.join(', '));

    console.log('\n=== tools/call: 线性方程组 ===');
    const r1 = await rpc('tools/call', {
      name: 'calc_equation',
      arguments: { equations: ['2x+3y=8', 'x-y=-1'], variables: ['x', 'y'] }
    }, 2);
    const t1 = textOf(r1);
    check('线性方程组 返回 isError=false', r1.result && r1.result.isError === false);
    check('线性方程组 标注线性', /线性方程组/.test(t1), t1.slice(0, 200));
    check('线性方程组 x=1', /x = \*\*1\*\*/.test(t1), t1);
    check('线性方程组 y=2', /y = \*\*2\*\*/.test(t1), t1);
    check('线性方程组 带代回验证', /代回验证/.test(t1), t1);

    console.log('\n=== tools/call: 非线性方程组（多解） ===');
    const r2 = await rpc('tools/call', {
      name: 'calc_equation',
      arguments: { equations: ['x^2+y^2=25', 'x-y=1'], variables: ['x', 'y'], searchRange: [-10, 10] }
    }, 3);
    const t2 = textOf(r2);
    check('非线性方程组 标注非线性', /非线性方程组/.test(t2), t2.slice(0, 200));
    check('非线性方程组 枚举 2 组解', /解（2 组/.test(t2), t2);
    check('非线性方程组 含 (4,3)', /x = \*\*4\*\*，y = \*\*3\*\*/.test(t2), t2);
    check('非线性方程组 含 (-3,-4)', /x = \*\*-3\*\*，y = \*\*-4\*\*/.test(t2), t2);

    console.log('\n=== tools/call: 超定（最小二乘） ===');
    const r3 = await rpc('tools/call', {
      name: 'calc_equation',
      arguments: { equations: ['x=1', 'y=1', 'x+y=3'], variables: ['x', 'y'], searchRange: [-5, 5] }
    }, 4);
    const t3 = textOf(r3);
    check('超定 返回最小二乘解', /最小二乘/.test(t3), t3.slice(0, 300));
    check('超定 解 ≈ 1.3333', /1\.33333/.test(t3), t3);

    console.log('\n=== tools/call: 3×3 非线性 ===');
    const r4 = await rpc('tools/call', {
      name: 'calc_equation',
      arguments: { equations: ['x^2+y^2+z^2=14', 'x+y+z=6', 'z=2'], variables: ['x', 'y', 'z'], searchRange: [-8, 8] }
    }, 5);
    const t4 = textOf(r4);
    check('3x3 含 (1,3,2)', /x = \*\*1\*\*，y = \*\*3\*\*，z = \*\*2\*\*/.test(t4), t4);
    check('3x3 含 (3,1,2)', /x = \*\*3\*\*，y = \*\*1\*\*，z = \*\*2\*\*/.test(t4), t4);

    console.log('\n=== tools/call: 回归（原能力） ===');
    const r5 = await rpc('tools/call', { name: 'calc_equation', arguments: { equation: 'x^2+1=0' } }, 6);
    check('单方程复根仍工作', /i/.test(textOf(r5)), textOf(r5).slice(0, 200));

    const r6 = await rpc('tools/call', { name: 'calc_eval', arguments: { expr: '2+3*4' } }, 7);
    check('calc_eval 仍工作 (14)', /14/.test(textOf(r6)), textOf(r6).slice(0, 200));

    const r7 = await rpc('tools/call', { name: 'calc_matrix', arguments: { op: 'det', a: [[1, 2], [3, 4]] } }, 8);
    check('calc_matrix 仍工作 (-2)', /-2/.test(textOf(r7)), textOf(r7).slice(0, 200));

    console.log('\n=== 错误处理 ===');
    const r8 = await rpc('tools/call', { name: 'calc_equation', arguments: { equations: ['x+y=1'] } }, 9);
    check('缺 variables 给出清晰提示', /variables/.test(textOf(r8)), textOf(r8).slice(0, 200));

    const r9 = await rpc('tools/call', {
      name: 'calc_equation',
      arguments: { equations: ['x^2+y^2=25', 'x-y=1'], variables: ['x', 'y'], searchRange: [-2, 2] }
    }, 10);
    check('窄 searchRange 不外溢解', !/\*\*解 \d+\*\*/.test(textOf(r9)), textOf(r9).slice(0, 300));

    console.log('\n=== ping ===');
    const ping = await rpc('ping', {}, 11);
    check('ping 返回空结果', ping && ping.result && typeof ping.result === 'object');

  } catch (e) {
    fail++; failures.push('运行时异常: ' + e.message);
    console.log('  FAIL  运行时异常: ' + e.message + '\n' + e.stack);
  } finally {
    cleanup();
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
