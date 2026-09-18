'use strict';
/**
 * MCP 端到端自测：自己 spawn 服务器，走完整 JSON-RPC 流程
 *   运行：node test/mcp.e2e.js
 *
 * 测试端口用 18352（= 18000 + 正式端口 8352），避免和真实服务冲突。
 *
 * 这里**不请求任何真实外网**：在测试进程内起一个本地 http.createServer 当靶子。
 * 靶子是环回地址（127.0.0.1），会被 SSRF 闸门默认拦下 —— 因此测试里显式传
 * allowPrivate=true，这本身就是一条好断言（证明默认确实拦截内网）。
 *
 * 断言值来自「先跑探针看真实输出、再写期望」的流程。
 */
const { spawn, execSync } = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18352;
const ROOT = path.join(__dirname, '..');
const FIXTURE_PORT = 18452;
const OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? '  —— ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  —— ' + detail : '')); }
}

/* ---------- JSON-RPC 客户端（兼容 SSE / JSON） ---------- */
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

/* ---------- 本地靶子服务器（环回，触发 SSRF 闸门） ---------- */
function startFixture() {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(2040, 0x41)]);
  const RANGE_BODY = Buffer.alloc(2000, 0x41);
  const BIG = 'x'.repeat(3 * 1024 * 1024);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const send = (code, ct, body, extra) => {
      res.writeHead(code, Object.assign({ 'Content-Type': ct }, extra || {}));
      res.end(body);
    };
    if (req.method === 'POST' && p === '/echo') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        send(200, 'application/json', JSON.stringify({
          method: req.method, len: raw.length,
          auth: !!req.headers['authorization'], body: raw
        }));
      });
      return;
    }
    if (p === '/') return send(200, 'text/plain', 'ok-root');
    if (p === '/json') return send(200, 'application/json', JSON.stringify({ ok: true, n: 42, list: [1, 2, 3] }));
    if (p === '/hello') return send(200, 'text/plain', 'hello world');
    if (p === '/redirect') { res.writeHead(302, { Location: '/hello' }); return res.end(); }
    if (p === '/gzip') {
      const zlib = require('zlib');
      const gz = zlib.gzipSync(Buffer.from('gzip payload line\n'));
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      return res.end(gz);
    }
    if (p === '/big') return send(200, 'text/plain', BIG);
    if (p === '/binary') return send(200, 'image/png', PNG);
    if (p === '/error') return send(500, 'text/plain', 'server error');
    if (p === '/range') {
      const rng = req.headers['range'];
      const m = rng && rng.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : RANGE_BODY.length - 1;
        const s = Math.max(0, start), e = Math.min(RANGE_BODY.length - 1, end);
        if (s >= RANGE_BODY.length) { res.writeHead(416, { 'Content-Range': 'bytes */' + RANGE_BODY.length }); return res.end(); }
        res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${s}-${e}/${RANGE_BODY.length}` });
        return res.end(RANGE_BODY.slice(s, e + 1));
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' });
      return res.end(RANGE_BODY);
    }
    if (p === '/wait') {
      const ms = parseInt(u.searchParams.get('ms') || '1500', 10);
      return setTimeout(() => send(200, 'text/plain', 'waited'), ms);
    }
    send(404, 'text/plain', 'not found');
  });
  return new Promise(resolve => {
    server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(server));
  });
}

/* ---------- 生自签名证书（供 https 探测 fixture） ---------- */
function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'httpx-cert-'));
  const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
  try {
    execSync(`"${OPENSSL}" req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 2 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`, { stdio: 'ignore' });
    return { key, cert, dir };
  } catch (e) {
    return null;
  }
}

(async () => {
  const fixture = await startFixture();
  const certInfo = makeCert();
  let httpsServer = null, httpsPort = 0;
  if (certInfo) {
    httpsServer = https.createServer(
      { key: fs.readFileSync(certInfo.key), cert: fs.readFileSync(certInfo.cert) },
      (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('https-ok'); }
    );
    httpsPort = await new Promise(resolve => httpsServer.listen(0, '127.0.0.1', () => resolve(httpsServer.address().port)));
  }

  const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { HTTPX_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootLog = '';
  child.stdout.on('data', d => { bootLog += d.toString(); });
  child.stderr.on('data', d => { bootLog += d.toString(); });
  const cleanup = () => {
    try { child.kill(); } catch (e) {}
    try { fixture.close(); } catch (e) {}
    if (httpsServer) try { httpsServer.close(); } catch (e) {}
    if (certInfo) try { fs.rmSync(certInfo.dir, { recursive: true, force: true }); } catch (e) {}
  };

  let idc = 0;
  const nid = () => ++idc;

  try {
    await waitPort(PORT);
    console.log('\n服务器已在端口 ' + PORT + ' 就绪\n');

    /* ---------------- initialize ---------------- */
    console.log('=== initialize ===');
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'httpx-e2e', version: '1.0.0' } }, 1);
    check('initialize 返回结果', !!(init && init.result));
    check('协议版本正确', init && init.result && init.result.protocolVersion === '2025-03-26', init && init.result && init.result.protocolVersion);
    check('serverInfo.name 为 httpx', init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'httpx', init && init.result && init.result.serverInfo && init.result.serverInfo.name);
    check('返回 instructions', !!(init && init.result && init.result.instructions));
    const instr = (init && init.result && init.result.instructions) || '';
    check('instructions 列出全部 6 个工具',
      ['httpx_request', 'httpx_download', 'httpx_head', 'httpx_batch', 'httpx_json', 'httpx_probe'].every(n => instr.indexOf(n) >= 0), instr.slice(0, 120));
    check('instructions 声明 SSRF 防护', /SSRF/.test(instr));
    await rpc('notifications/initialized', {}, 2);

    /* ---------------- tools/list ---------------- */
    console.log('\n=== tools/list ===');
    const tl = await rpc('tools/list', {}, 3);
    const tools = (tl && tl.result && tl.result.tools) || [];
    check('返回 6 个工具', tools.length === 6, '实际 ' + tools.length);
    const names = tools.map(t => t.name).sort();
    const expected = ['httpx_batch', 'httpx_download', 'httpx_head', 'httpx_json', 'httpx_probe', 'httpx_request'];
    check('工具名完全匹配', JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
    check('每个工具都有 title', tools.every(t => typeof t.title === 'string' && t.title.length > 0));
    check('每个工具都有 description', tools.every(t => typeof t.description === 'string' && t.description.length > 20));
    check('每个工具都有 inputSchema', tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));

    /* ---------------- httpx_request ---------------- */
    console.log('\n=== tools/call: httpx_request ===');
    const r1 = await call('httpx_request', { url: BASE + '/json', allowPrivate: true }, nid());
    check('GET /json 成功', !r1.isError, r1.text.slice(0, 200));
    check('GET /json 状态 200', r1.structured && r1.structured.status === 200, r1.structured && r1.structured.status);
    check('GET /json 文本含 ok', /ok/.test(r1.text));
    check('GET /json 结构化 body 含 n=42', r1.structured && r1.structured.body && /"n":42/.test(r1.structured.body), r1.structured && r1.structured.body);
    check('content[0].text 是纯文本（不以 { 开头）', r1.text && !r1.text.startsWith('{'));
    check('structuredContent 不含 _text 键', r1.structured && !('_text' in r1.structured));
    check('结构化含 timings', !!(r1.structured && r1.structured.timings && typeof r1.structured.timings.total === 'number'));

    // gzip 解压
    const rg = await call('httpx_request', { url: BASE + '/gzip', allowPrivate: true }, nid());
    check('gzip 自动解压，正文含 payload', !rg.isError && /gzip payload/.test(rg.text), rg.text.slice(0, 200));

    // 大响应体截断
    const rb = await call('httpx_request', { url: BASE + '/big', allowPrivate: true }, nid());
    check('3MB 响应体被截断', rb.structured && rb.structured.truncated === true, rb.structured && JSON.stringify(rb.structured.truncated));
    check('截断文本提示超出上限', /截断|超出/.test(rb.text), rb.text.slice(0, 200));

    // 二进制只报大小与类型
    const rbin = await call('httpx_request', { url: BASE + '/binary', allowPrivate: true }, nid());
    check('二进制响应不展示正文（binary 字段存在）', !!rbin.structured.binary, JSON.stringify(rbin.structured && rbin.structured.binary));
    check('二进制报类型 image/png', rbin.structured && rbin.structured.binary && /image\/png/.test(rbin.structured.binary.type));
    check('二进制报大小 ~2KB', rbin.structured && rbin.structured.binary && rbin.structured.binary.size === 2048, rbin.structured && rbin.structured.binary && rbin.structured.binary.size);

    // 重定向跟随
    const rr = await call('httpx_request', { url: BASE + '/redirect', allowPrivate: true }, nid());
    check('跟随重定向到 /hello', rr.structured && rr.structured.redirected === true && rr.structured.body && /hello world/.test(rr.structured.body), rr.structured && JSON.stringify(rr.structured.redirectChain));
    check('重定向链记录 1 跳', rr.structured && rr.structured.redirectChain && rr.structured.redirectChain.length === 1);

    // 超时
    const rt = await call('httpx_request', { url: BASE + '/wait?ms=1500', timeout: 200, allowPrivate: true }, nid());
    check('超时返回 isError', rt.isError, rt.text.slice(0, 200));
    check('超时文本报超时', /超时/.test(rt.text), rt.text.slice(0, 200));

    // 认证 + 日志脱敏
    const SECRET = 'SECRET_TOKEN_ABC123';
    const ra = await call('httpx_request', { url: BASE + '/echo', method: 'POST', auth: { type: 'bearer', token: SECRET }, allowPrivate: true }, nid());
    check('带 bearer 认证请求成功', !ra.isError, ra.text.slice(0, 200));
    check('靶子收到 Authorization 头', ra.structured && ra.structured.body && /"auth":true/.test(ra.structured.body), ra.structured && ra.structured.body);
    check('认证令牌绝不写入服务器日志（脱敏）', !bootLog.includes(SECRET), '日志中含明文 token');

    // ★ SSRF 闸门：默认拦截环回
    const rs = await call('httpx_request', { url: BASE + '/', allowPrivate: false }, nid());
    check('SSRF：默认拦截 127.0.0.1（isError）', rs.isError, rs.text.slice(0, 200));
    check('SSRF：结构化 ssrfBlocked=true', rs.structured && rs.structured.ssrfBlocked === true, rs.structured && JSON.stringify(rs.structured.ssrfBlocked));
    check('SSRF：文本提示拦截', /SSRF|拦截|内网/.test(rs.text), rs.text.slice(0, 200));
    const rsOk = await call('httpx_request', { url: BASE + '/', allowPrivate: true }, nid());
    check('SSRF：allowPrivate=true 放行内网', !rsOk.isError, rsOk.text.slice(0, 200));

    // 协议拒绝
    const rf = await call('httpx_request', { url: 'file:///etc/passwd', allowPrivate: true }, nid());
    check('拒绝 file: 协议（isError）', rf.isError && /file/.test(rf.text), rf.text.slice(0, 200));

    /* ---------------- httpx_download ---------------- */
    console.log('\n=== tools/call: httpx_download ===');
    const dlPath = path.join(os.tmpdir(), 'httpx-e2e-dl-' + process.pid + '.bin');
    const d1 = await call('httpx_download', { url: BASE + '/binary', path: dlPath, allowPrivate: true }, nid());
    check('下载二进制成功', !d1.isError, d1.text.slice(0, 200));
    check('下载字节数 2048', d1.structured && d1.structured.bytes === 2048, d1.structured && d1.structured.bytes);
    check('下载文件确实存在', fs.existsSync(dlPath));
    try { fs.unlinkSync(dlPath); } catch (e) {}

    // 断点续传：先放 1000 字节的半成品，再续传拿到 206 + 追加 → 2000；再续传 416 视为完成
    const rp = path.join(os.tmpdir(), 'httpx-e2e-range-' + process.pid + '.bin');
    try { fs.writeFileSync(rp, Buffer.alloc(1000, 0x41)); } catch (e) {}
    const d2 = await call('httpx_download', { url: BASE + '/range', path: rp, resume: true, allowPrivate: true }, nid());
    check('断点续传 206 追加到 2000', d2.structured && d2.structured.bytes === 2000, d2.structured && JSON.stringify(d2.structured));
    check('续传模式为 append', d2.structured && d2.structured.mode === 'append', d2.structured && d2.structured.mode);
    const d3 = await call('httpx_download', { url: BASE + '/range', path: rp, resume: true, allowPrivate: true }, nid());
    check('已完整后再续传：416 视为完成（仍为 2000）', d3.structured && d3.structured.mode === 'complete' && d3.structured.bytes === 2000, d3.structured && JSON.stringify(d3.structured));
    try { fs.unlinkSync(rp); } catch (e) {}

    /* ---------------- httpx_head ---------------- */
    console.log('\n=== tools/call: httpx_head ===');
    const h1 = await call('httpx_head', { url: BASE + '/json', allowPrivate: true }, nid());
    check('head /json 状态 200', h1.structured && h1.structured.status === 200, h1.structured && h1.structured.status);
    check('head 返回响应头含 content-type', h1.structured && h1.structured.headers && /json/.test(h1.structured.headers['content-type'] || ''), JSON.stringify(h1.structured && h1.structured.headers && h1.structured.headers['content-type']));
    check('head 含耗时', h1.structured && h1.structured.timings && typeof h1.structured.timings.total === 'number');
    const h2 = await call('httpx_head', { url: BASE + '/redirect', allowPrivate: true }, nid());
    check('head /redirect 跟随并重定向链 1 跳', h2.structured && h2.structured.redirected === true && h2.structured.redirectChain.length === 1);

    /* ---------------- httpx_batch ---------------- */
    console.log('\n=== tools/call: httpx_batch ===');
    const b1 = await call('httpx_batch', { urls: [BASE + '/', BASE + '/json', BASE + '/hello'], allowPrivate: true }, nid());
    check('批量 3 个全部成功', b1.structured && b1.structured.ok === 3 && b1.structured.failed === 0, b1.structured && JSON.stringify(b1.structured));
    check('批量汇总文本含 成功 3', /成功 3/.test(b1.text), b1.text.slice(0, 200));
    check('批量结构化 results 长度 3', b1.structured && b1.structured.results.length === 3);
    // SSRF 在批量里同样生效
    const b2 = await call('httpx_batch', { urls: [BASE + '/', 'http://127.0.0.1:' + FIXTURE_PORT + '/'], allowPrivate: false }, nid());
    check('批量中含内网 URL 时被拦截（failed>=1）', b2.structured && b2.structured.failed >= 1, b2.structured && JSON.stringify(b2.structured.failed));
    check('批量失败项标记 ssrfBlocked', b2.structured && b2.structured.results.some(r => r.ssrfBlocked === true), b2.structured && JSON.stringify(b2.structured.results));

    /* ---------------- httpx_json ---------------- */
    console.log('\n=== tools/call: httpx_json ===');
    const j1 = await call('httpx_json', { url: BASE + '/json', allowPrivate: true }, nid());
    check('httpx_json /json 成功', !j1.isError, j1.text.slice(0, 200));
    check('httpx_json 解析出 n=42', j1.structured && j1.structured.json && j1.structured.json.n === 42, j1.structured && JSON.stringify(j1.structured.json));
    const j2 = await call('httpx_json', { url: BASE + '/error', allowPrivate: true }, nid());
    check('httpx_json /error 非 2xx 仍返回（isError）', j2.isError, j2.text.slice(0, 200));
    check('httpx_json 非 2xx 响应体原样返回（含 server error）', j2.structured && j2.structured.raw && /server error/.test(j2.structured.raw), j2.structured && j2.structured.raw);

    /* ---------------- httpx_probe ---------------- */
    console.log('\n=== tools/call: httpx_probe ===');
    const p1 = await call('httpx_probe', { host: '127.0.0.1:' + FIXTURE_PORT, allowPrivate: true }, nid());
    check('probe http 可达（status 200）', p1.structured && p1.structured.http && p1.structured.http.reachable === true && p1.structured.http.status === 200, p1.structured && JSON.stringify(p1.structured.http));
    if (httpsPort) {
      const p2 = await call('httpx_probe', { host: '127.0.0.1:' + httpsPort, allowPrivate: true }, nid());
      check('probe https TLS 握证成功', p2.structured && p2.structured.https && p2.structured.https.tlsConnected === true, p2.structured && JSON.stringify(p2.structured.https));
      check('probe https 报自签名证书错误', p2.structured && p2.structured.https && p2.structured.https.authorizationError && /self|signed|self[- ]signed/i.test(p2.structured.https.authorizationError), p2.structured && p2.structured.https && p2.structured.https.authorizationError);
      check('probe https 证书主体含 localhost', p2.structured && p2.structured.https.cert && /localhost/.test(p2.structured.https.cert.subject || ''), p2.structured && JSON.stringify(p2.structured.https.cert));
      check('probe https 证书未过期', p2.structured && p2.structured.https.cert && !p2.structured.https.cert.expired, p2.structured && JSON.stringify(p2.structured.https.cert));
    } else {
      console.log('  (跳过 https 证书探测：openssl 不可用)');
    }

    /* ---------------- 协议方法 ---------------- */
    console.log('\n=== 协议方法 ===');
    const ping = await rpc('ping', {}, nid());
    check('ping 返回空结果', !!(ping && ping.result && typeof ping.result === 'object'));
    const rl = await rpc('resources/list', {}, nid());
    check('resources/list 返回空数组', !!(rl && rl.result && Array.isArray(rl.result.resources)));
    const pl = await rpc('prompts/list', {}, nid());
    check('prompts/list 返回空数组', !!(pl && pl.result && Array.isArray(pl.result.prompts)));
    const e7 = await call('no_such_tool', {}, nid());
    check('未知工具返回 isError', e7.isError);

    check('服务器进程仍存活（无崩溃）', child.exitCode === null && !child.killed, 'exitCode=' + child.exitCode);

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
