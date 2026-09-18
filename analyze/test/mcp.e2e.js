'use strict';
/**
 * MCP 端到端自测：自己 spawn 服务器，走完整 JSON-RPC 流程
 *   运行：node test/mcp.e2e.js
 *
 * 覆盖：握手 / tools/list schema / 建图 / 符号搜索 / 引用 / 调用链 /
 *       依赖与循环检测 / 最短路径 / 影响面 / 统计 / 错误处理 / ping
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const PORT = 18346;            // 用测试端口，避免和真实 8346 冲突
const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');   // monorepo 根，作为建图样本

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
function structOf(resp) {
  return (resp && resp.result && resp.result.structuredContent) || {};
}

/* ==================================================================== */
(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ANALYZE_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootLog = '';
  child.stdout.on('data', d => { bootLog += d.toString(); });
  child.stderr.on('data', d => { bootLog += d.toString(); });

  const cleanup = () => { try { child.kill(); } catch (e) {} };

  try {
    await waitPort(PORT);
    console.log('\n服务器已启动 (pid=' + child.pid + ', port=' + PORT + ')\n');

    /* ---------------- 握手 ---------------- */
    console.log('=== MCP 握手 ===');
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'analyze-e2e', version: '1.0.0' }
    });
    check('initialize 成功', init && init.result && init.result.serverInfo, JSON.stringify(init).slice(0, 200));
    check('serverInfo.name = analyze',
      init && init.result && init.result.serverInfo.name === 'analyze',
      init && init.result ? init.result.serverInfo.name : '');
    check('instructions 列出 8 个工具',
      init && init.result && init.result.instructions &&
      ['analyze_build', 'analyze_find', 'analyze_refs', 'analyze_callers',
        'analyze_deps', 'analyze_path', 'analyze_impact', 'analyze_stats']
        .every(n => init.result.instructions.includes(n)));
    check('拿到 session id', !!sessionId);

    await rpc('notifications/initialized', {}, undefined);

    /* ---------------- tools/list ---------------- */
    console.log('\n=== tools/list ===');
    const list = await rpc('tools/list', {});
    const tools = list.result.tools || [];
    const names = tools.map(t => t.name);
    check('tools/list 返回 8 个工具', names.length === 8, names.join(', '));
    for (const n of ['analyze_build', 'analyze_find', 'analyze_refs', 'analyze_callers',
      'analyze_deps', 'analyze_path', 'analyze_impact', 'analyze_stats']) {
      check('含 ' + n, names.includes(n), names.join(', '));
    }
    check('每个工具都有 inputSchema',
      tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));

    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    check('analyze_build schema 含 refresh',
      Object.keys(byName.analyze_build.inputSchema.properties).includes('refresh'));
    check('analyze_callers schema 含 direction',
      Object.keys(byName.analyze_callers.inputSchema.properties).includes('direction'));
    check('analyze_impact schema 含 target',
      Object.keys(byName.analyze_impact.inputSchema.properties).includes('target'));
    check('analyze_deps schema 含 cycles',
      Object.keys(byName.analyze_deps.inputSchema.properties).includes('cycles'));

    /* ---------------- 建图 ---------------- */
    console.log('\n=== tools/call: analyze_build（真实仓库样本） ===');
    const r0 = await rpc('tools/call', {
      name: 'analyze_build',
      arguments: { path: REPO, refresh: true, topSymbols: 5 }
    }, 2);
    const t0 = textOf(r0);
    const s0 = structOf(r0);
    check('analyze_build isError=false', r0.result && r0.result.isError === false, t0.slice(0, 300));
    check('建图有文件数', typeof s0.files === 'number' && s0.files > 50, 'files=' + s0.files);
    check('建图有符号数', typeof s0.symbols === 'number' && s0.symbols > 500, 'symbols=' + s0.symbols);
    check('建图有边数', typeof s0.edges === 'number' && s0.edges > 1000, 'edges=' + s0.edges);
    check('解析 errors 为空', Array.isArray(s0.errors) ? s0.errors.length === 0 : !s0.errors,
      'errors=' + JSON.stringify(s0.errors));
    check('识别出多语言', /javascript/i.test(t0) && /(c|cpp)\b/i.test(t0), t0.slice(0, 400));

    /* ---------------- 符号搜索 ---------------- */
    console.log('\n=== tools/call: analyze_find ===');
    const r1 = await rpc('tools/call', {
      name: 'analyze_find',
      arguments: { path: REPO, query: 'formatValue', limit: 10 }
    }, 3);
    const t1 = textOf(r1);
    check('analyze_find 找到 formatValue', /formatValue/.test(t1), t1.slice(0, 300));
    check('analyze_find 标注类型 function', /function/.test(t1), t1.slice(0, 300));
    check('analyze_find 给出定义文件', /format\.js/.test(t1), t1.slice(0, 300));

    const r1b = await rpc('tools/call', {
      name: 'analyze_find',
      arguments: { path: REPO, query: 'format', kinds: ['class'], limit: 10 }
    }, 4);
    const t1b = textOf(r1b);
    check('analyze_find kinds 过滤生效（class 里不含 function 行）',
      !/^\s*\S+\s+\[function/m.test(t1b), t1b.slice(0, 300));

    /* ---------------- 引用查询 ---------------- */
    console.log('\n=== tools/call: analyze_refs ===');
    const r2 = await rpc('tools/call', {
      name: 'analyze_refs',
      arguments: { path: REPO, symbol: 'formatValue', limit: 20 }
    }, 5);
    const t2 = textOf(r2);
    check('analyze_refs 有入边', /被引用 \d+ 处/.test(t2), t2.slice(0, 300));
    check('analyze_refs 显示调用关系', /\[调用\]|\[导入\]/.test(t2), t2.slice(0, 400));

    const r2b = await rpc('tools/call', {
      name: 'analyze_refs',
      arguments: { path: REPO, symbol: 'formatValue', edgeKinds: ['calls'], limit: 20 }
    }, 20);
    const t2b = textOf(r2b);
    check('analyze_refs edgeKinds=calls 过滤掉导入等其它边',
      !/\[导入\]|\[继承\]|\[实现\]/.test(t2b), t2b.slice(0, 400));

    /* ---------------- 调用链 ---------------- */
    console.log('\n=== tools/call: analyze_callers（双向） ===');
    const r3 = await rpc('tools/call', {
      name: 'analyze_callers',
      arguments: { path: REPO, symbol: 'formatValue', direction: 'callers', depth: 2 }
    }, 6);
    const t3 = textOf(r3);
    check('callers 方向向上追踪', /向上|调用者/.test(t3), t3.slice(0, 400));
    check('callers 有第 1 层结果', /第 1 层/.test(t3), t3.slice(0, 400));

    const r4 = await rpc('tools/call', {
      name: 'analyze_callers',
      arguments: { path: REPO, symbol: 'tokenize', direction: 'callees', depth: 2 }
    }, 7);
    const t4 = textOf(r4);
    check('callees 方向向下追踪', /向下|被调用/.test(t4), t4.slice(0, 400));
    check('callees 有第 1 层结果', /第 1 层/.test(t4), t4.slice(0, 400));

    /* ---------------- 依赖 ---------------- */
    console.log('\n=== tools/call: analyze_deps（单文件 + 循环检测） ===');
    const r5 = await rpc('tools/call', {
      name: 'analyze_deps',
      arguments: { path: path.join(REPO, 'calc'), file: 'src/utils/tokenizer.js', depth: 2 }
    }, 8);
    const t5 = textOf(r5);
    check('analyze_deps 列出依赖', /依赖了/.test(t5), t5.slice(0, 400));
    check('analyze_deps 列出被依赖', /被 .* 个文件依赖/.test(t5), t5.slice(0, 400));
    check('analyze_deps tokenizer 依赖 constants.js', /constants\.js/.test(t5), t5.slice(0, 400));

    const r6 = await rpc('tools/call', {
      name: 'analyze_deps',
      arguments: { path: path.join(REPO, 'calc'), cycles: true }
    }, 9);
    const t6 = textOf(r6);
    check('循环检测模式生效', /循环依赖/.test(t6), t6.slice(0, 400));
    check('循环检测给出枢纽文件', /枢纽/.test(t6), t6.slice(0, 500));

    /* ---------------- 最短路径 ---------------- */
    console.log('\n=== tools/call: analyze_path ===');
    const r7 = await rpc('tools/call', {
      name: 'analyze_path',
      arguments: { path: path.join(REPO, 'calc'), from: 'run', to: 'formatValue' }
    }, 10);
    const t7 = textOf(r7);
    check('analyze_path 找到路径', /找到依赖路径/.test(t7), t7.slice(0, 400));
    check('analyze_path 标出边类型', /\[calls\]|\[imports\]/.test(t7), t7.slice(0, 400));

    // 无关符号应明确报告"无路径"并解释边界，而不是静默返回空
    const r8 = await rpc('tools/call', {
      name: 'analyze_path',
      arguments: { path: path.join(REPO, 'calc'), from: 'tokenize', to: 'formatValue' }
    }, 11);
    const t8 = textOf(r8);
    check('analyze_path 对无路径给解释而非沉默', /没有可达路径/.test(t8) && /动态调用/.test(t8), t8.slice(0, 400));

    /* ---------------- 影响面 ---------------- */
    console.log('\n=== tools/call: analyze_impact ===');
    const r9 = await rpc('tools/call', {
      name: 'analyze_impact',
      arguments: { path: ROOT, target: 'loadGraph', depth: 2 }
    }, 12);
    const t9 = textOf(r9);
    check('analyze_impact 列出第 1 层', /第 1 层影响/.test(t9), t9.slice(0, 400));
    check('analyze_impact 给出风险评级', /风险评级/.test(t9), t9.slice(0, 600));
    check('analyze_impact loadGraph 影响到 analyze-find.js', /analyze-find\.js/.test(t9), t9.slice(0, 600));

    /* ---------------- 统计 ---------------- */
    console.log('\n=== tools/call: analyze_stats ===');
    const r10 = await rpc('tools/call', {
      name: 'analyze_stats',
      arguments: { path: ROOT, top: 5 }
    }, 13);
    const t10 = textOf(r10);
    check('analyze_stats 有规模统计', /规模/.test(t10) && /符号/.test(t10), t10.slice(0, 400));
    check('analyze_stats 有语言分布', /语言分布/.test(t10), t10.slice(0, 500));
    check('analyze_stats 有符号类型', /符号类型/.test(t10), t10.slice(0, 500));
    check('analyze_stats 有核心枢纽', /核心枢纽/.test(t10), t10.slice(0, 800));

    /* ---------------- 错误处理 ---------------- */
    console.log('\n=== 错误处理 ===');
    const e1 = await rpc('tools/call', {
      name: 'analyze_find',
      arguments: { path: REPO, query: 'zzz_definitely_not_exist_zzz' }
    }, 14);
    check('搜索不到时给出明确说明（不算崩溃）',
      /未找到|没有|0 个|命中 0/.test(textOf(e1)), textOf(e1).slice(0, 300));

    const e2 = await rpc('tools/call', {
      name: 'analyze_path',
      arguments: { path: path.join(REPO, 'calc'), from: 'no_such_symbol_xyz', to: 'run' }
    }, 15);
    check('起点不存在时提示先 analyze_find',
      /未找到起点/.test(textOf(e2)) && /analyze_find/.test(textOf(e2)), textOf(e2).slice(0, 300));

    const e3 = await rpc('tools/call', {
      name: 'analyze_find',
      arguments: { path: path.join(REPO, 'does-not-exist-dir'), query: 'x' }
    }, 16);
    check('目录不存在时不抛未捕获异常',
      e3 && e3.result && (/不存在|无效|无法|no such/i.test(textOf(e3)) || e3.result.isError === true),
      textOf(e3).slice(0, 300));

    const e4 = await rpc('tools/call', { name: 'no_such_tool', arguments: {} }, 17);
    check('未知工具走 JSON-RPC error 分支',
      !!(e4 && e4.error) || /未知工具/.test(textOf(e4)), JSON.stringify(e4).slice(0, 300));

    /* ---------------- 缓存复用 ---------------- */
    console.log('\n=== 缓存复用 ===');
    const c1 = await rpc('tools/call', {
      name: 'analyze_build', arguments: { path: ROOT, topSymbols: 3 }
    }, 18);
    const cs = structOf(c1);
    check('二次建图命中缓存（memory / disk）',
      cs.from === 'memory' || cs.from === 'disk',
      'from=' + cs.from + ' | ' + textOf(c1).slice(0, 200));
    check('缓存命中时耗时远小于重建',
      typeof cs.ms === 'number' && cs.ms < 100, 'ms=' + cs.ms);

    /* ---------------- ping ---------------- */
    console.log('\n=== ping ===');
    const ping = await rpc('ping', {}, 19);
    check('ping 返回空结果', ping && ping.result && typeof ping.result === 'object');

  } catch (e) {
    fail++; failures.push('运行时异常: ' + e.message);
    console.log('  FAIL  运行时异常: ' + e.message + '\n' + e.stack);
    if (bootLog) console.log('--- 服务器输出 ---\n' + bootLog.slice(-1500));
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
