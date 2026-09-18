'use strict';
/**
 * MCP 端到端自测：自己 spawn 服务器，走完整 JSON-RPC 流程
 *   运行：node test/mcp.e2e.js
 *
 * 测试端口用 18348（= 18 + 正式端口 8348），避免和真实服务冲突。
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const PORT = 18348;
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

/* ==================================================================== */
(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { STAMP_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootLog = '';
  child.stdout.on('data', d => { bootLog += d.toString(); });
  child.stderr.on('data', d => { bootLog += d.toString(); });

  const cleanup = () => { try { child.kill(); } catch (e) {} };

  try {
    await waitPort(PORT);
    console.log('\n服务器已在端口 ' + PORT + ' 就绪\n');

    /* ---------------- initialize ---------------- */
    console.log('=== initialize ===');
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'stamp-e2e', version: '1.0.0' }
    }, 1);
    check('initialize 返回结果', !!(init && init.result));
    check('协议版本正确', init && init.result && init.result.protocolVersion === '2025-03-26',
      init && init.result && init.result.protocolVersion);
    check('serverInfo.name 为 stamp',
      init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'stamp',
      init && init.result && init.result.serverInfo && init.result.serverInfo.name);
    check('返回 instructions', !!(init && init.result && init.result.instructions));
    check('instructions 提到 stamp_now',
      init && init.result && /stamp_now/.test(init.result.instructions || ''));

    await rpc('notifications/initialized', {}, 2);

    /* ---------------- tools/list ---------------- */
    console.log('\n=== tools/list ===');
    const tl = await rpc('tools/list', {}, 3);
    const tools = (tl && tl.result && tl.result.tools) || [];
    check('返回 6 个工具', tools.length === 6, '实际 ' + tools.length);
    const names = tools.map(t => t.name).sort();
    const expected = ['stamp_convert', 'stamp_cron', 'stamp_duration', 'stamp_now', 'stamp_workday', 'stamp_zone'];
    check('工具名完全匹配', JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
    check('每个工具都有 title', tools.every(t => typeof t.title === 'string' && t.title.length > 0));
    check('每个工具都有 description', tools.every(t => typeof t.description === 'string' && t.description.length > 20));
    check('每个工具都有 inputSchema', tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));

    /* ---------------- stamp_now ---------------- */
    console.log('\n=== tools/call: stamp_now ===');
    const r1 = await rpc('tools/call', { name: 'stamp_now', arguments: {} }, 4);
    check('stamp_now 调用成功', !!(r1 && r1.result && !r1.result.isError), JSON.stringify(r1).slice(0, 200));
    check('stamp_now 文本含"现在"', /现在/.test(textOf(r1)));
    check('stamp_now 文本含时区表', /Asia\/Shanghai/.test(textOf(r1)));
    const s1 = structuredOf(r1);
    check('stamp_now 返回 structuredContent', !!s1, '无 structuredContent');
    check('stamp_now 结构化字段完整',
      !!(s1 && s1.now && s1.epoch && s1.timeZones && s1.bounds),
      JSON.stringify(s1 && Object.keys(s1)));
    check('stamp_now epoch 秒为 10 位',
      s1 && String(s1.epoch.seconds).length === 10, s1 && s1.epoch && String(s1.epoch.seconds));
    check('stamp_now 含 today/week/month/year 边界',
      s1 && s1.bounds && !!(s1.bounds.today && s1.bounds.week && s1.bounds.month && s1.bounds.year),
      s1 && s1.bounds && Object.keys(s1.bounds).join(','));
    check('stamp_now 不泄漏 _text 到结构化结果', s1 && !('_text' in s1));

    /* ---------------- stamp_convert ---------------- */
    console.log('\n=== tools/call: stamp_convert ===');
    const r2 = await rpc('tools/call', {
      name: 'stamp_convert',
      arguments: { value: '2026-09-18T14:30:00Z', zone: 'Asia/Shanghai', all: true }
    }, 5);
    check('stamp_convert 调用成功', !!(r2 && r2.result && !r2.result.isError));
    check('stamp_convert 文本含 ISO 8601', /ISO 8601/.test(textOf(r2)));
    check('stamp_convert 文本含 RFC 2822', /RFC 2822/.test(textOf(r2)));
    check('stamp_convert 上海时间 22:30',
      /2026-09-18 22:30:00/.test(textOf(r2)), textOf(r2).slice(0, 300));
    const s2 = structuredOf(r2);
    check('stamp_convert 结构化含 formats', !!(s2 && Array.isArray(s2.formats) && s2.formats.length >= 12));
    check('stamp_convert epoch 毫秒正确',
      s2 && s2.epoch && s2.epoch.milliseconds === 1789741800000,
      s2 && s2.epoch && s2.epoch.milliseconds);

    const r2b = await rpc('tools/call', {
      name: 'stamp_convert',
      arguments: { value: 1758180000, zone: 'UTC' }
    }, 6);
    check('stamp_convert 数字时间戳秒级识别', /seconds/.test(textOf(r2b)), textOf(r2b).slice(0, 200));

    const r2c = await rpc('tools/call', {
      name: 'stamp_convert',
      arguments: { values: ['now', '20260918', 1758180000], zone: 'Asia/Shanghai' }
    }, 7);
    check('stamp_convert 批量成功', /共 3 个值/.test(textOf(r2c)), textOf(r2c).slice(0, 200));

    /* ---------------- stamp_duration ---------------- */
    console.log('\n=== tools/call: stamp_duration ===');
    const r3 = await rpc('tools/call', {
      name: 'stamp_duration',
      arguments: { value: '1h30m' }
    }, 8);
    check('stamp_duration 调用成功', !!(r3 && r3.result && !r3.result.isError));
    check('stamp_duration 5400 秒', /5400/.test(textOf(r3)), textOf(r3).slice(0, 300));
    check('stamp_duration 人类可读 1h 30m', /1h 30m/.test(textOf(r3)));
    const s3 = structuredOf(r3);
    check('stamp_duration 结构化 ms 正确', s3 && s3.ms === 5400000, s3 && s3.ms);

    const r3b = await rpc('tools/call', {
      name: 'stamp_duration',
      arguments: { from: '2026-09-18', to: '2026-09-25' }
    }, 9);
    check('stamp_duration 间隔模式', /间隔/.test(textOf(r3b)), textOf(r3b).slice(0, 200));
    check('stamp_duration 间隔为 1 周', /1w/.test(textOf(r3b)));

    /* ---------------- stamp_zone ---------------- */
    console.log('\n=== tools/call: stamp_zone ===');
    const r4 = await rpc('tools/call', {
      name: 'stamp_zone',
      arguments: {
        time: '2026-09-18T14:30:00', from: 'Asia/Shanghai',
        toZones: ['Asia/Tokyo', 'America/New_York', 'UTC']
      }
    }, 10);
    check('stamp_zone 调用成功', !!(r4 && r4.result && !r4.result.isError));
    check('stamp_zone 东京 15:30', /2026-09-18 15:30:00/.test(textOf(r4)), textOf(r4).slice(0, 400));
    check('stamp_zone 提到夏令时', /夏令时/.test(textOf(r4)));
    const s4 = structuredOf(r4);
    check('stamp_zone 结构化 3 个时区', !!(s4 && s4.timeZones && s4.timeZones.length === 3));
    check('stamp_zone 纽约偏移 -04:00',
      s4 && s4.timeZones.some(z => z.timeZone === 'America/New_York' && z.utcOffset === '-04:00'),
      JSON.stringify(s4 && s4.timeZones));

    const r4b = await rpc('tools/call', {
      name: 'stamp_zone',
      arguments: { zoneInfo: 'Australia/Sydney', year: 2026 }
    }, 11);
    check('stamp_zone 时区信息查询', /Australia\/Sydney/.test(textOf(r4b)));
    check('stamp_zone 南半球夏令时正确（10 月进入）',
      /2026-10-04/.test(textOf(r4b)), textOf(r4b).slice(0, 400));

    /* ---------------- stamp_workday ---------------- */
    console.log('\n=== tools/call: stamp_workday ===');
    const r5 = await rpc('tools/call', {
      name: 'stamp_workday',
      arguments: { date: '2026-09-18', days: 5 }
    }, 12);
    check('stamp_workday 调用成功', !!(r5 && r5.result && !r5.result.isError));
    check('stamp_workday 5 工作日后为 09-25',
      /2026-09-25/.test(textOf(r5)), textOf(r5).slice(0, 300));
    const s5 = structuredOf(r5);
    check('stamp_workday 结构化 resultLocal', s5 && s5.resultLocal === '2026-09-25 00:00:00', s5 && s5.resultLocal);

    const r5b = await rpc('tools/call', {
      name: 'stamp_workday',
      arguments: {
        from: '2026-09-28', to: '2026-10-11',
        holidays: ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'],
        workdays: ['2026-10-10']
      }
    }, 13);
    check('stamp_workday 含节假日统计', /法定假期/.test(textOf(r5b)), textOf(r5b).slice(0, 300));
    check('stamp_workday 调休被识别', /调休/.test(textOf(r5b)));

    /* ---------------- stamp_cron ---------------- */
    console.log('\n=== tools/call: stamp_cron ===');
    const r6 = await rpc('tools/call', {
      name: 'stamp_cron',
      arguments: { expression: '0 9 * * 1-5', zone: 'Asia/Shanghai', from: '2026-09-18T10:00:00', count: 3 }
    }, 14);
    check('stamp_cron 调用成功', !!(r6 && r6.result && !r6.result.isError));
    check('stamp_cron 中文描述正确', /每周一、二、三、四、五/.test(textOf(r6)), textOf(r6).slice(0, 300));
    check('stamp_cron 第一次触发为 09-21',
      /2026-09-21 09:00:00/.test(textOf(r6)), textOf(r6).slice(0, 400));
    const s6 = structuredOf(r6);
    check('stamp_cron 结构化 nextRuns 长度 3', !!(s6 && s6.nextRuns && s6.nextRuns.length === 3));
    check('stamp_cron 结构化描述', s6 && s6.description === '第 0 分 · 9 点 · 每周一、二、三、四、五', s6 && s6.description);

    const r6b = await rpc('tools/call', {
      name: 'stamp_cron',
      arguments: { expression: '0 0 1 * 1', zone: 'Asia/Shanghai', from: '2026-09-18T10:00:00', count: 2 }
    }, 15);
    check('stamp_cron 提示 OR 语义', /OR/.test(textOf(r6b)), textOf(r6b).slice(0, 400));

    /* ---------------- 错误处理 ---------------- */
    console.log('\n=== 错误处理 ===');
    const e1 = await rpc('tools/call', {
      name: 'stamp_convert', arguments: { values: ['now'], zone: 'Not/AZone' }
    }, 16);
    check('无效时区返回 isError', !!(e1 && e1.result && e1.result.isError), JSON.stringify(e1).slice(0, 300));
    check('无效时区错误信息可读', /无效的时区名/.test(textOf(e1)), textOf(e1).slice(0, 200));

    const e2 = await rpc('tools/call', { name: 'no_such_tool', arguments: {} }, 17);
    check('未知工具返回 isError', !!(e2 && e2.result && e2.result.isError));
    check('未知工具列出可用工具', /stamp_now/.test(textOf(e2)), textOf(e2).slice(0, 300));

    const e3 = await rpc('tools/call', {
      name: 'stamp_cron', arguments: { expression: '0 0 30 2 *', zone: 'Asia/Shanghai' }
    }, 18);
    check('永不触发的 cron 返回错误', !!(e3 && e3.result && e3.result.isError));
    check('永不触发错误信息解释原因', /永远不会触发/.test(textOf(e3)), textOf(e3).slice(0, 300));

    const e4 = await rpc('tools/call', {
      name: 'stamp_workday', arguments: { date: '2026-09-18', days: 0 }
    }, 19);
    check('days=0 返回错误', !!(e4 && e4.result && e4.result.isError));

    /* ---------------- ping ---------------- */
    console.log('\n=== ping ===');
    const ping = await rpc('ping', {}, 20);
    check('ping 返回空结果', !!(ping && ping.result && typeof ping.result === 'object'));

  } catch (e) {
    fail++;
    failures.push('运行时异常: ' + e.message);
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
