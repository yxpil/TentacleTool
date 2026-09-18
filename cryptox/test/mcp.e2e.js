'use strict';
/**
 * cryptox 端到端测试：自 spawn 服务器 + 完整 JSON-RPC 往返（端口 18353 = 18000 + 8353）
 *
 * 为什么必须有这一层：单测直接调工具模块，会绕开 server.js 的组装逻辑。
 * e2e 才验证得到「工具层 → MCP 协议层」这一段：
 *   - content[0].text 是纯文本（不是整坨 JSON）
 *   - structuredContent 是结构化结果且不含 _text
 *   - 参数按 inputSchema 里声明的名字传（而不是按实现里的名字）真的生效
 *   - 工具报错时 isError=true 而不是把服务器打挂
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 18353;
const HOST = '127.0.0.1';
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function t(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; failures.push({ name, actual: a, expected: e }); }
}
function tOk(name, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push({ name, actual: 'falsy' + (detail ? ' (' + detail + ')' : ''), expected: 'truthy' }); }
}
function section(s) { console.log('\n=== ' + s + ' ==='); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function waitPort(port, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect(port, HOST);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`端口 ${port} 未就绪`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

let idSeq = 0;
let SID = null;
let serverOut = '';

async function rpc(method, params, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (SID) headers['Mcp-Session-Id'] = SID;
  const res = await fetch(`http://${HOST}:${PORT}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++idSeq, method, params })
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) SID = sid;
  const text = await res.text();
  if (res.status === 202 || !text.trim()) return { status: res.status, payload: null };
  let payload;
  if (/^(event|data):/m.test(text)) {
    const line = text.split('\n').find(l => l.startsWith('data:'));
    payload = JSON.parse(line.slice(5).trim());
  } else {
    payload = JSON.parse(text);
  }
  if (opts.raw) return { status: res.status, payload, raw: text };
  return { status: res.status, payload };
}

/** 调工具，返回 { text, structured, isError } */
async function callTool(name, args) {
  const { payload } = await rpc('tools/call', { name, arguments: args });
  if (!payload || !payload.result) return { error: payload && payload.error ? payload.error.message : '无 result', isError: true };
  const r = payload.result;
  const content = (r.content && r.content[0]) || {};
  return {
    text: content.text || '',
    structured: r.structuredContent || null,
    isError: !!r.isError,
    meta: r._meta || {}
  };
}

(async () => {
  // ── 启动服务器（不设环境变量，顺带验证端口兜底值是 18353 之外的正式端口逻辑不受影响） ──
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, CRYPTOX_PORT: String(PORT), CRYPTOX_HOST: HOST },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => { serverOut += d.toString(); });
  child.stderr.on('data', d => { serverOut += d.toString(); });

  try {
    await waitPort(PORT);
  } catch (e) {
    console.error('服务器未启动：', e.message);
    console.error(serverOut.slice(-2000));
    child.kill();
    process.exit(1);
  }

  try {
    /* ───────── 协议握手 ───────── */
    section('协议握手');
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'cryptox-e2e', version: '1.0.0' }
    });
    t('initialize 返回 200', init.status, 200);
    t('protocolVersion', init.payload.result.protocolVersion, '2025-03-26');
    t('serverInfo.name', init.payload.result.serverInfo.name, 'cryptox');
    tOk('instructions 非空', typeof init.payload.result.instructions === 'string' && init.payload.result.instructions.includes('cryptox_hash'));
    tOk('会话 id 已下发', typeof SID === 'string' && SID.length > 0);

    await rpc('notifications/initialized', {});
    const ping = await rpc('ping', {});
    t('ping 返回空对象', ping.payload.result, {});

    const list = await rpc('tools/list', {});
    const tools = list.payload.result.tools;
    t('工具数量', tools.length, 9);
    t('工具名齐备', tools.map(x => x.name).sort(), [
      'cryptox_checksum', 'cryptox_cipher', 'cryptox_decode', 'cryptox_encode', 'cryptox_hash',
      'cryptox_hmac', 'cryptox_jwt', 'cryptox_password', 'cryptox_uuid'
    ]);
    tOk('每个工具都有 title 与 description', tools.every(x => x.title && x.description));
    tOk('每个工具都有 inputSchema', tools.every(x => x.inputSchema && x.inputSchema.type === 'object'));
    tOk('tools/list 不泄露内部函数', tools.every(x => !('run' in x) && !('encodeOne' in x) && !('normalizeFormat' in x)));

    /* ───────── 哈希 / HMAC / 校验和 ───────── */
    section('哈希 / HMAC / 校验和');
    const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

    const h1 = await callTool('cryptox_hash', { input: 'abc' });
    t('hash 不报错', h1.isError, false);
    t('hash 结构化结果', h1.structured.results[0].hash, SHA256_ABC);
    tOk('hash 文本是纯文本而非 JSON', !h1.text.trimStart().startsWith('{'));
    tOk('hash 文本不含 [object Object]', !/\[object Object\]/.test(h1.text));
    t('hash 结构化里不含 _text', h1.structured._text, undefined);
    tOk('hash 有耗时元信息', typeof h1.meta.durationMs === 'number' && h1.meta.tool === 'cryptox_hash');

    // 文档里写的参数名（algorithm / encoding）必须真的生效
    const h2 = await callTool('cryptox_hash', { input: 'abc', algorithm: 'md5', encoding: 'base64' });
    t('文档参数 algorithm 生效', h2.structured.algorithm, 'md5');
    t('文档参数 encoding 生效', h2.structured.encoding, 'base64');
    t('md5+base64 结果正确', h2.structured.results[0].hash, Buffer.from('900150983cd24fb0d6963f7d28e17f72', 'hex').toString('base64'));

    const hErr = await callTool('cryptox_hash', { input: 'a', algorithm: 'md5x' });
    t('参数错误 → isError=true', hErr.isError, true);
    tOk('错误信息说清可用算法', hErr.text.includes('不支持的算法') && hErr.text.includes('sha256'));

    const hm1 = await callTool('cryptox_hmac', { key: 'key', input: 'The quick brown fox jumps over the lazy dog' });
    t('hmac 标准向量', hm1.structured.results[0].signature, 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');

    const hm2 = await callTool('cryptox_hmac', {
      key: 'key', input: 'The quick brown fox jumps over the lazy dog',
      expected: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
    });
    t('hmac 校验命中', hm2.structured.results[0].matches, true);
    tOk('hmac 输出不含密钥明文', !JSON.stringify(hm2.structured).includes('"key":"key"'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryptox-e2e-'));
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'abc');
    const cs1 = await callTool('cryptox_checksum', { path: path.join(tmpDir, 'a.txt'), expected: SHA256_ABC });
    t('checksum 匹配', cs1.structured.expectedMatched, true);
    t('checksum 单文件结果', cs1.structured.count, 1);

    /* ───────── 编解码 ───────── */
    section('编解码');
    const en1 = await callTool('cryptox_encode', { input: '你好', format: 'base64' });
    t('encode base64', en1.structured.output, '5L2g5aW9');
    const de1 = await callTool('cryptox_decode', { input: '5L2g5aW9', format: 'base64' });
    t('decode base64', de1.structured.output, '你好');
    const en2 = await callTool('cryptox_encode', { input: 'a b&c', format: 'url' });
    t('encode url', en2.structured.output, 'a%20b%26c');
    const de2 = await callTool('cryptox_decode', { input: 'a%20b%26c', format: 'url' });
    t('decode url', de2.structured.output, 'a b&c');
    const en3 = await callTool('cryptox_encode', { input: '🔐', format: 'unicode' });
    t('encode unicode 代理对', en3.structured.output, '\\ud83d\\udd10');
    const de3 = await callTool('cryptox_decode', { input: '\\ud83d\\udd10', format: 'unicode' });
    t('decode unicode 代理对', de3.structured.output, '🔐');
    const deErr = await callTool('cryptox_decode', { input: '!!!!', format: 'base64' });
    t('非法 base64 → isError', deErr.isError, true);
    tOk('错误信息明确', deErr.text.includes('不是合法的 base64'));

    /* ───────── JWT ───────── */
    section('JWT');
    const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const j1 = await callTool('cryptox_jwt', { token: TOKEN, secret: 'your-256-bit-secret' });
    t('jwt 解析 payload', j1.structured.payload.name, 'John Doe');
    t('jwt 签名验证通过', j1.structured.verify.valid, true);
    t('jwt header alg', j1.structured.algorithm, 'HS256');
    tOk('提供 secret 时文本报告验证通过', j1.text.includes('签名验证：✓ 通过'));
    // 不带 secret：应跳过验证，并在文本里明确"解析 ≠ 可信"（防误读为已验证）
    const j2 = await callTool('cryptox_jwt', { token: TOKEN });
    t('无 secret 时不发起验证', j2.structured.verify.attempted, false);
    tOk('无 secret 文本提示解析不等于可信', j2.text.includes('并不能证明'));

    /* ───────── UUID / 密码 ───────── */
    section('UUID / 密码');
    const u1 = await callTool('cryptox_uuid', { version: 'v4' });
    tOk('uuid v4 格式', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u1.structured.ids[0]), u1.structured.ids[0]);
    const u2 = await callTool('cryptox_uuid', { version: 'v7', count: 5 });
    t('uuid v7 数量', u2.structured.ids.length, 5);
    tOk('uuid v7 严格递增', u2.structured.ids.every((x, i) => i === 0 || u2.structured.ids[i - 1] < x));
    const u3 = await callTool('cryptox_uuid', { validate: '01a0b4f4-0060-7bdf-b9a5-bdeb22e2f06a' });
    t('uuid 校验版本', u3.structured.result.version, 7);
    const u4 = await callTool('cryptox_uuid', { version: 'short', count: 3 });
    tOk('short id 是 URL 安全字符', u4.structured.ids.every(x => /^[A-Za-z0-9_-]+$/.test(x)));

    const p1 = await callTool('cryptox_password', { password: '123456' });
    t('密码评估等级', p1.structured.result.level, '极弱');
    tOk('密码评估列出弱模式', p1.structured.result.issues.includes('纯数字'));
    const p2 = await callTool('cryptox_password', { length: 24, symbols: true, count: 3 });
    t('密码生成数量', p2.structured.passwords.length, 3);
    tOk('密码长度正确', p2.structured.passwords.every(x => x.length === 24));
    tOk('密码四类齐全', p2.structured.passwords.every(x => /[a-z]/.test(x) && /[A-Z]/.test(x) && /[0-9]/.test(x) && /[^a-zA-Z0-9]/.test(x)));
    tOk('密码文本提示存进密码管理器', p2.text.includes('密码管理器'));

    /* ───────── 加解密（往返 + 篡改） ───────── */
    section('AES-256-GCM');
    const c1 = await callTool('cryptox_cipher', { input: '端到端机密 🔐', password: 'pw-e2e' });
    tOk('cipher 封套前缀', c1.structured.envelope.startsWith('CRYPTOX1:'));
    const c2 = await callTool('cryptox_cipher', { mode: 'decrypt', input: c1.structured.envelope, password: 'pw-e2e' });
    t('cipher 往返一致', c2.structured.plaintext, '端到端机密 🔐');
    tOk('往返结果同时出现在文本里', c2.text.includes('端到端机密'));
    const c3 = await callTool('cryptox_cipher', { mode: 'decrypt', input: c1.structured.envelope, password: '错的' });
    t('错口令 → isError', c3.isError, true);
    tOk('错口令提示不提明文', !c3.text.includes('端到端机密'));
    // scrypt 分支
    const c4 = await callTool('cryptox_cipher', { input: 'x', password: 'p', kdf: 'scrypt' });
    const c5 = await callTool('cryptox_cipher', { mode: 'decrypt', input: c4.structured.envelope, password: 'p' });
    t('scrypt 往返', c5.structured.plaintext, 'x');
    t('scrypt 封套记录 kdf', c4.structured.kdf, 'scrypt');

    /* ───────── 错误与健壮性 ───────── */
    section('错误与健壮性');
    const bad = await callTool('cryptox_not_exist', {});
    t('未知工具 → isError', bad.isError, true);
    tOk('未知工具列出可用清单', /可用工具/.test(bad.text) && bad.text.includes('cryptox_hash'));

    const noArgs = await callTool('cryptox_hash', {});
    t('缺必填参数 → isError', noArgs.isError, true);
    tOk('提示哪些参数必须给', noArgs.text.includes('必须提供'));

    const badMethod = await rpc('tools/nonexistent', {});
    tOk('未知方法返回 JSON-RPC 错误', !!badMethod.payload.error && badMethod.payload.error.code === -32601);

    const listAfter = await rpc('tools/list', {});
    t('多轮调用后服务器仍正常响应', listAfter.payload.result.tools.length, 9);
    tOk('服务器进程存活（未崩溃）', child.exitCode === null && !child.killed);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    fail++;
    failures.push({ name: 'e2e 主流程异常', actual: e.message + '\n' + String(e.stack).split('\n').slice(1, 4).join('\n'), expected: '无异常' });
  } finally {
    child.kill();
    await sleep(300);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  console.log('\n' + '='.repeat(52));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  console.log('='.repeat(52));
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  ✗ ${f.name}\n      实际: ${f.actual}\n      期望: ${f.expected}`);
  }
  process.exit(fail ? 1 : 0);
})();

const MD5_ABC_HEX = '900150983cd24fb0d6963f7d28e17f72';
