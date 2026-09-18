'use strict';
/**
 * MCP 端到端自测：自己 spawn 服务器，走完整 JSON-RPC 流程
 *   运行：node test/mcp.e2e.js
 *
 * 测试端口用 18349（= 18000 + 正式端口 8349），避免和真实服务冲突。
 *
 * 这里的断言值全部来自「先跑探针看真实输出、再写期望」的流程，
 * 不是凭想象写的 —— 上一轮 stamp 吃过"期望值拍脑袋"的亏。
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const PORT = 18349;
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

/** 调用工具并返回 { text, structured, isError } */
async function call(name, args, id) {
  const r = await rpc('tools/call', { name, arguments: args }, id);
  return {
    raw: r,
    isError: !!(r && r.result && r.result.isError),
    text: textOf(r),
    structured: structuredOf(r)
  };
}

/* ==================================================================== */
(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { JSONX_PORT: String(PORT) }),
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
      clientInfo: { name: 'jsonx-e2e', version: '1.0.0' }
    }, 1);
    check('initialize 返回结果', !!(init && init.result));
    check('协议版本正确', init && init.result && init.result.protocolVersion === '2025-03-26',
      init && init.result && init.result.protocolVersion);
    check('serverInfo.name 为 jsonx',
      init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'jsonx',
      init && init.result && init.result.serverInfo && init.result.serverInfo.name);
    check('返回 instructions', !!(init && init.result && init.result.instructions));
    const instr = (init && init.result && init.result.instructions) || '';
    check('instructions 列出全部 6 个工具',
      ['jsonx_parse', 'jsonx_convert', 'jsonx_query', 'jsonx_schema', 'jsonx_diff', 'jsonx_aggregate']
        .every(n => instr.indexOf(n) >= 0), instr.slice(0, 200));
    check('instructions 声明"先交给 Jsonx"的主张', /不要凭记忆手写解析逻辑/.test(instr));
    check('instructions 声明 CSV 状态机', /状态机/.test(instr));
    check('instructions 声明类型推断保守', /前导零/.test(instr));
    check('instructions 声明 JSONPath 不支持过滤器', /过滤器/.test(instr));

    await rpc('notifications/initialized', {}, 2);

    /* ---------------- tools/list ---------------- */
    console.log('\n=== tools/list ===');
    const tl = await rpc('tools/list', {}, 3);
    const tools = (tl && tl.result && tl.result.tools) || [];
    check('返回 6 个工具', tools.length === 6, '实际 ' + tools.length);
    const names = tools.map(t => t.name).sort();
    const expected = ['jsonx_aggregate', 'jsonx_convert', 'jsonx_diff', 'jsonx_parse', 'jsonx_query', 'jsonx_schema'];
    check('工具名完全匹配', JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
    check('每个工具都有 title', tools.every(t => typeof t.title === 'string' && t.title.length > 0));
    check('每个工具都有 description', tools.every(t => typeof t.description === 'string' && t.description.length > 20));
    check('每个工具都有 inputSchema', tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));
    const parseTool = tools.find(t => t.name === 'jsonx_parse');
    check('jsonx_parse 的 text 为必填',
      !!(parseTool && parseTool.inputSchema.required && parseTool.inputSchema.required.includes('text')));
    const aggTool = tools.find(t => t.name === 'jsonx_aggregate');
    check('jsonx_aggregate 的 aggs 有 enum 限制',
      !!(aggTool && aggTool.inputSchema.properties.aggs.items.enum.length >= 8));

    /* ---------------- jsonx_parse : CSV ---------------- */
    console.log('\n=== tools/call: jsonx_parse (CSV) ===');
    const p1 = await call('jsonx_parse', {
      text: 'name,age,city\nAlice,30,Beijing\nBob,25,Shanghai'
    }, nid());
    check('CSV 解析成功', !p1.isError, p1.text.slice(0, 200));
    check('CSV 文本声明自动识别到逗号',
      /已解析为 CSV/.test(p1.text) && /自动识别/.test(p1.text), p1.text.slice(0, 200));
    check('CSV 形状 2 行 × 3 列', /2 行 × 3 列/.test(p1.text), p1.text.slice(0, 300));
    check('CSV 列名正确', /name, age, city/.test(p1.text));
    check('CSV age 推断为 number', /\|\s*age\s*\|\s*number\s*\|/.test(p1.text));
    check('CSV name 保持 string', /\|\s*name\s*\|\s*string\s*\|/.test(p1.text));
    check('CSV 预览含首行数据', /name=Alice\s+age=30\s+city=Beijing/.test(p1.text));
    const ps1 = p1.structured;
    check('CSV 返回 structuredContent', !!ps1);
    check('CSV 结构化 format=csv', ps1 && ps1.format === 'csv', ps1 && ps1.format);
    check('CSV 结构化 rowCount=2', ps1 && ps1.rowCount === 2, ps1 && ps1.rowCount);
    check('CSV 结构化 records 正确',
      !!(ps1 && ps1.records && ps1.records.length === 2 &&
         ps1.records[0].name === 'Alice' && ps1.records[0].age === 30),
      JSON.stringify(ps1 && ps1.records));
    check('CSV 结构化 columns 是对象数组（与 schema.columns 同形）',
      !!(ps1 && Array.isArray(ps1.columns) &&
         ps1.columns.find(c => c.name === 'age' && c.type === 'number' && c.nullable === false && c.sample.length === 2)),
      JSON.stringify(ps1 && ps1.columns));
    check('CSV 结构化 columnNames 提供纯名字列表',
      !!(ps1 && JSON.stringify(ps1.columnNames) === '["name","age","city"]'),
      JSON.stringify(ps1 && ps1.columnNames));
    check('columns 与 schema.columns 完全一致（不出现同名不同形）',
      JSON.stringify(ps1.columns) === JSON.stringify(ps1.schema.columns),
      JSON.stringify(ps1.columns) + ' vs ' + JSON.stringify(ps1.schema.columns));
    check('jsonx_parse 不泄漏 _text 到结构化结果', ps1 && !('_text' in ps1));
    check('输出文本里没有 [object Object]（列名当对象渲染的回归）',
      !/\[object Object\]/.test(p1.text), p1.text.slice(0, 300));

    /* ---------------- jsonx_parse : 引号 / 换行 / 转义 ---------------- */
    console.log('\n=== tools/call: jsonx_parse (CSV 引号边界) ===');
    const p1q = await call('jsonx_parse', {
      text: 'name,note\n"Wang, Jr","line1\nline2"\n"say ""hi""",ok'
    }, nid());
    check('引号内逗号不被切分', !p1q.isError, p1q.text.slice(0, 200));
    check('引号内逗号保留为一个字段',
      !!(p1q.structured && p1q.structured.records && p1q.structured.records[1] &&
         p1q.structured.records[1].name === 'say "hi"'),
      JSON.stringify(p1q.structured && p1q.structured.records));
    check('引号内换行不拆行（仍是 2 条记录）',
      !!(p1q.structured && p1q.structured.records.length === 2),
      p1q.structured && p1q.structured.records && p1q.structured.records.length);
    check('引号内换行原样保留',
      !!(p1q.structured && p1q.structured.records[0].note === 'line1\nline2'),
      JSON.stringify(p1q.structured && p1q.structured.records[0]));

    /* ---------------- jsonx_parse : 类型推断保守性 ---------------- */
    console.log('\n=== tools/call: jsonx_parse (类型推断保守) ===');
    const p1z = await call('jsonx_parse', { text: 'phone\n0912\n0077\n0100' }, nid());
    check('前导零保持字符串',
      !!(p1z.structured && p1z.structured.records.every(r => typeof r.phone === 'string')),
      JSON.stringify(p1z.structured && p1z.structured.records));
    check('前导零文本也显示 string', /\|\s*phone\s*\|\s*string\s*\|/.test(p1z.text));

    const p1s = await call('jsonx_parse', { text: 'id\n1234567890123456789' }, nid());
    check('超安全整数（雪花 ID）保持字符串',
      !!(p1s.structured && typeof p1s.structured.records[0].id === 'string'),
      JSON.stringify(p1s.structured && p1s.structured.records));

    const p1m = await call('jsonx_parse', { text: 'v\n1\nabc' }, nid());
    check('列内混类型整列退回 string',
      !!(p1m.structured && p1m.structured.records.every(r => typeof r.v === 'string')),
      JSON.stringify(p1m.structured && p1m.structured.records));

    /* ---------------- jsonx_parse : 单列 CSV 不被 YAML 吞掉（回归） ---------------- */
    console.log('\n=== tools/call: jsonx_parse (单列 CSV 回归) ===');
    const p1c = await call('jsonx_parse', { text: 'name\nalice\nbob' }, nid());
    check('多行文本按单列 CSV 处理（不再被 YAML 当标量吞掉）',
      /已解析为 CSV/.test(p1c.text) && /按单列 CSV 处理/.test(p1c.text), p1c.text.slice(0, 220));
    check('单列 CSV 保留了全部行',
      !!(p1c.structured && p1c.structured.records.length === 2 &&
         p1c.structured.records[0].name === 'alice' && p1c.structured.records[1].name === 'bob'),
      JSON.stringify(p1c.structured && p1c.structured.records));

    /* ---------------- jsonx_parse : YAML ---------------- */
    console.log('\n=== tools/call: jsonx_parse (YAML) ===');
    const p2 = await call('jsonx_parse', {
      text: 'server:\n  host: localhost\n  port: 8080\nusers:\n  - name: Alice\n    tags: [a, b]\n'
    }, nid());
    check('YAML 解析成功', !p2.isError, p2.text.slice(0, 200));
    check('YAML 被识别为 YAML 集合', /已解析为 YAML/.test(p2.text));
    check('YAML 结构概览列出 server 与 users', /\|\s*server\s*\|/.test(p2.text) && /\|\s*users\s*\|/.test(p2.text));
    check('YAML 嵌套块被保留（不是空对象）',
      !!(p2.structured && p2.structured.value && p2.structured.value.server &&
         p2.structured.value.server.host === 'localhost' && p2.structured.value.server.port === 8080),
      JSON.stringify(p2.structured && p2.structured.value));
    check('YAML 序列正确',
      !!(p2.structured && p2.structured.value.users && p2.structured.value.users[0].name === 'Alice' &&
         JSON.stringify(p2.structured.value.users[0].tags) === '["a","b"]'),
      JSON.stringify(p2.structured && p2.structured.value && p2.structured.value.users));

    const p2b = await call('jsonx_parse', { text: 'a: yes\nb: no\nc: true', format: 'yaml' }, nid());
    check('YAML 1.2 语义：yes/no 是字符串',
      !!(p2b.structured && p2b.structured.value.a === 'yes' && p2b.structured.value.b === 'no'),
      JSON.stringify(p2b.structured && p2b.structured.value));
    check('YAML true 仍是布尔', p2b.structured && p2b.structured.value.c === true);

    /* ---------------- jsonx_convert ---------------- */
    console.log('\n=== tools/call: jsonx_convert ===');
    const c1 = await call('jsonx_convert', { text: 'name,age\nAlice,30\nBob,25', to: 'yaml' }, nid());
    check('CSV→YAML 成功', !c1.isError, c1.text.slice(0, 200));
    check('CSV→YAML 报告源格式与目标',
      /CSV → YAML/.test(c1.text), c1.text.slice(0, 160));
    check('CSV→YAML 输出 YAML 文档',
      /- name: Alice/.test(c1.text) && /age: 30/.test(c1.text), c1.text.slice(0, 400));
    check('CSV→YAML 往返校验通过',
      /往返校验通过/.test(c1.text) && c1.structured.roundTrip.ok === true,
      JSON.stringify(c1.structured.roundTrip));
    check('CSV→YAML 结构化含 output', typeof c1.structured.output === 'string');
    check('CSV→YAML 源列行正常渲染（不是 [object Object]）',
      /源列：name, age/.test(c1.text) && !/\[object Object\]/.test(c1.text), c1.text.slice(0, 200));

    const c2 = await call('jsonx_convert', {
      text: '{"user":{"name":"Alice","age":30},"ok":true}', to: 'csv', flatten: 'dot'
    }, nid());
    check('嵌套→CSV 用 flatten=dot 成功', !c2.isError, c2.text.slice(0, 300));
    check('flatten=dot 生成点号列名',
      /user\.name/.test(c2.text) && /user\.age/.test(c2.text), c2.text.slice(0, 400));
    check('flatten=dot 输出 CSV 单元格正确',
      !!(c2.structured && /Alice/.test(c2.structured.output)),
      c2.structured && c2.structured.output);

    const c3 = await call('jsonx_convert', {
      text: '[{"id":1,"m":{"x":1}},{"id":2,"m":{"x":2}}]', to: 'markdown', flatten: 'dot'
    }, nid());
    check('JSON→Markdown 生成表格', !c3.isError && /\| id \| m\.x \|/.test(c3.text), c3.text.slice(0, 300));
    check('Markdown 输出是纯表格（无代码围栏内多余内容）',
      typeof c3.structured.output === 'string' && c3.structured.output.split('\n')[0].startsWith('| id'),
      JSON.stringify(c3.structured && c3.structured.output));

    const c4 = await call('jsonx_convert', { text: '{"a":1}', to: 'json', sortKeys: true }, nid());
    check('JSON→JSON 成功且排序', !c4.isError, c4.text.slice(0, 200));

    /* ---------------- jsonx_query ---------------- */
    console.log('\n=== tools/call: jsonx_query ===');
    const DOC = '{"users":[{"id":1,"name":"Alice","tags":["a","b"]},{"id":2,"name":"Bob","tags":[]}],"total":2}';
    const q1 = await call('jsonx_query', {
      text: DOC, paths: ['$.users[*].name', '$.total', '$.nope'], withPath: true
    }, nid());
    check('多路径查询成功', !q1.isError, q1.text.slice(0, 200));
    check('多路径报告数量', /查询 3 个路径/.test(q1.text), q1.text.slice(0, 160));
    check('通配路径取到 2 条', /\$\.users\[\*\]\.name\s+→\s+2 条匹配/.test(q1.text), q1.text.slice(0, 300));
    check('通配路径值正确',
      /\$\.users\[0\]\.name\s+=\s+Alice/.test(q1.text) && /\$\.users\[1\]\.name\s+=\s+Bob/.test(q1.text));
    check('标量路径取到值', /\$\.total\s+=\s+2/.test(q1.text));
    check('无匹配路径不报错但明确标注',
      /\$\.nope\s+→\s+0 条匹配/.test(q1.text) && /（无匹配）/.test(q1.text));
    check('无匹配时给出相近键名提示',
      /没有 "nope" 这个键/.test(q1.text) && /users/.test(q1.text), q1.text.slice(0, 500));
    check('列出顶层可用的键', /顶层可用的键/.test(q1.text));
    check('结构化 results 长度 3',
      !!(q1.structured && q1.structured.results && q1.structured.results.length === 3),
      q1.structured && JSON.stringify(q1.structured.results));
    check('单路径失败不影响其他（第三条 error）',
      !!(q1.structured.results[2].error || q1.structured.results[2].count === 0),
      JSON.stringify(q1.structured.results[2]));

    const q2 = await call('jsonx_query', { text: '[10,20,30,40,50]', path: '$.ids[::-1]' }, nid());
    check('不存在的键返回 0 匹配而非报错', !q2.isError);

    const q3 = await call('jsonx_query', { text: '{"a":[10,20,30,40,50]}', path: '$..*' }, nid());
    check('递归下降可用', !q3.isError, q3.text.slice(0, 200));

    const q4 = await call('jsonx_query', { text: '{"a":[10,20,30,40,50]}', path: '$.a[::-1]' }, nid());
    check('反向切片正确（值是 50,40,30,20,10）',
      !!(q4.structured &&
         JSON.stringify(q4.structured.results[0].matches.map(m => m.value)) === '[50,40,30,20,10]'),
      JSON.stringify(q4.structured && q4.structured.results[0]));
    check('每条匹配都带自己的路径（$ 或 . / [n] 形式）',
      !!(q4.structured &&
         q4.structured.results[0].matches.every(m => typeof m.path === 'string' && m.path.startsWith('$.a['))),
      JSON.stringify(q4.structured && q4.structured.results[0].matches && q4.structured.results[0].matches.map(m => m.path)));

    const q5 = await call('jsonx_query', { text: '[1,2,3,4,5]', path: '$[*]', limit: 2 }, nid());
    check('limit 截断生效', /只显示前 2 条/.test(q5.text), q5.text.slice(0, 300));
    check('limit 给出调大的提示', /另有 3 条/.test(q5.text));
    check('limit 截断后仍报告真实匹配数', /5 条匹配/.test(q5.text));

    const q6 = await call('jsonx_query', {
      text: '[{"id":1,"n":"a"},{"id":2,"n":"b"}]', path: '$[*]'
    }, nid());
    check('对象数组渲染成表格', /\|\s*id\s*\|/.test(q6.text) && /\|\s*n\s*\|/.test(q6.text), q6.text.slice(0, 400));

    /* ---------------- jsonx_schema ---------------- */
    console.log('\n=== tools/call: jsonx_schema ===');
    const s1 = await call('jsonx_schema', { text: 'name,age\nAlice,30\nBob,25' }, nid());
    check('schema 成功', !s1.isError, s1.text.slice(0, 200));
    check('schema 声明 CSV 视角', /CSV 结构推断/.test(s1.text));
    check('schema 形状正确', /2 行 × 2 列/.test(s1.text), s1.text.slice(0, 300));
    check('schema 列定义表含类型与可空',
      /\|\s*name\s*\|\s*string\s*\|/.test(s1.text) && /可空/.test(s1.text));
    check('schema 给出下一步提示', /下一步/.test(s1.text) && /jsonx_query/.test(s1.text));
    check('schema 输出无 [object Object]', !/\[object Object\]/.test(s1.text), s1.text.slice(0, 200));

    const s2 = await call('jsonx_schema', {
      text: '{"server":{"host":"h","port":8080},"users":[{"id":1,"name":"A"},{"id":2,"name":"B"}]}'
    }, nid());
    check('JSON 结构推断成功', !s2.isError, s2.text.slice(0, 300));
    check('JSON 嵌套结构概览含 server/users',
      /\|\s*server\s*\|/.test(s2.text) && /\|\s*users\s*\|/.test(s2.text), s2.text.slice(0, 500));
    check('数组元素类型标注 array<object{2}>',
      /array<object\{2\}>/.test(s2.text), s2.text.slice(0, 500));

    const s3 = await call('jsonx_schema', {
      text: '[{"tags":["x"]},{"tags":[]}]'
    }, nid());
    check('空数组不污染元素类型（回归）',
      !s3.isError && !/unknown/.test(s3.text), s3.text.slice(0, 500));

    /* ---------------- jsonx_diff ---------------- */
    console.log('\n=== tools/call: jsonx_diff ===');
    const d1 = await call('jsonx_diff', { left: '{"a":1,"b":2,"c":3}', right: '{"a":1,"b":9,"d":4}' }, nid());
    check('diff 成功', !d1.isError, d1.text.slice(0, 200));
    check('diff 报告 3 处改动', /发现 3 处改动/.test(d1.text), d1.text.slice(0, 300));
    check('diff 分类统计正确',
      /新增: 1/.test(d1.text) && /删除: 1/.test(d1.text) && /修改: 1/.test(d1.text));
    check('diff 路径用点号形式', /\$\.c/.test(d1.text) && /\$\.d/.test(d1.text));
    check('diff 明细含左右值', /\|\s*修改\s*\|\s*\$\.b\s*\|\s*2\s*\|\s*9\s*\|/.test(d1.text), d1.text.slice(0, 700));
    check('diff 结构化 equal=false', d1.structured.equal === false);
    check('diff 结构化 changes 长度 3',
      !!(d1.structured.changes && d1.structured.changes.length === 3),
      JSON.stringify(d1.structured.changes));

    const d2 = await call('jsonx_diff', { left: '[1,2,3]', right: '[3,1,2]', ignoreOrder: true }, nid());
    check('ignoreOrder 生效（应该是相等）', !d2.isError, d2.text.slice(0, 300));
    check('ignoreOrder 回显生效选项（不静默）', /生效选项.*数组模式=ignoreOrder/.test(d2.text), d2.text.slice(0, 300));
    check('ignoreOrder 判定相等', /两侧结构完全相等/.test(d2.text), d2.text.slice(0, 400));
    check('ignoreOrder 结构化 equal=true', d2.structured.equal === true,
      JSON.stringify(d2.structured.stats));
    check('ignoreOrder 结构化 mode=ignoreOrder', d2.structured.options.arrayMode === 'ignoreOrder',
      d2.structured.options.arrayMode);

    const d2b = await call('jsonx_diff', { left: '[1,2,3]', right: '[3,1,2,4]', ignoreOrder: true }, nid());
    check('ignoreOrder 下多出的元素报为新增',
      !d2b.isError && /发现 1 处改动/.test(d2b.text) && /新增: 1/.test(d2b.text), d2b.text.slice(0, 400));
    check('ignoreOrder 新增路径标注 [?]', /\[\?\]/.test(d2b.text), d2b.text.slice(0, 600));

    const d3 = await call('jsonx_diff', {
      left: '{"a":1,"t":"2026-01-01","x":null}', right: '{"a":1.0,"x":null}'
    }, nid());
    check('数值 1 与 1.0 相等（只报 t 被删除）',
      /发现 1 处改动/.test(d3.text), d3.text.slice(0, 400));

    const d4 = await call('jsonx_diff', {
      left: '[{"id":1,"n":"a"},{"id":2,"n":"b"}]',
      right: '[{"id":1,"n":"a"},{"id":2,"n":"B"}]',
      arrayMode: 'byKey', arrayKey: 'id'
    }, nid());
    check('byKey 数组模式成功', !d4.isError, d4.text.slice(0, 300));
    check('byKey 路径带键条件', /\[id=2\]/.test(d4.text), d4.text.slice(0, 600));
    check('byKey 只报 1 处改动', /发现 1 处改动/.test(d4.text));

    const d5 = await call('jsonx_diff', {
      left: '{"a":1,"updatedAt":"x"}', right: '{"a":2,"updatedAt":"y"}', ignoreKeys: ['updatedAt']
    }, nid());
    check('ignoreKeys 接受裸键名并补成 $.updatedAt',
      !!(d5.structured.options.ignoreKeys.length === 1 &&
         d5.structured.options.ignoreKeys[0] === '$.updatedAt'),
      JSON.stringify(d5.structured && d5.structured.options.ignoreKeys));
    check('ignoreKeys 回显生效选项', /生效选项.*忽略=\$\.updatedAt/.test(d5.text), d5.text.slice(0, 300));
    check('ignoreKeys 忽略指定字段（只剩 a 的 1 处改动）',
      /发现 1 处改动/.test(d5.text) && /修改\s*\|\s*\$\.a\s*\|/.test(d5.text),
      d5.text.slice(0, 400));
    check('ignoreKeys 后明细里不再出现 updatedAt（只在"生效选项"回显行出现一次）',
      (d5.text.match(/updatedAt/g) || []).length === 1 &&
      d5.text.indexOf('生效选项') < d5.text.indexOf('updatedAt'), d5.text.slice(0, 400));
    check('ignoreKeys 忽略的是深层噪声字段时也不误伤',
      !/\$\.updatedAt/.test(d5.text.split('改动明细')[1] || ''),
      (d5.text.split('改动明细')[1] || '').slice(0, 300));

    const d5b = await call('jsonx_diff', {
      left: '{"a":1,"updatedAt":"x"}', right: '{"a":2,"updatedAt":"y"}', ignoreKeys: ['$.updatedAt']
    }, nid());
    check('ignoreKeys 带 $ 前缀写法同样生效',
      /发现 1 处改动/.test(d5b.text) && !/\$\.updatedAt/.test(d5b.text.split('改动明细')[1] || ''),
      d5b.text.slice(0, 400));

    const d6 = await call('jsonx_diff', {
      left: '{"a":1}', right: '{"a":2}', ignoreKeys: ['nope']
    }, nid());
    check('ignoreKeys 里不存在的键明确报错（不静默失效）',
      d6.isError && /都不存在/.test(d6.text), d6.text.slice(0, 300));
    check('ignoreKeys 报错时给出排查手段', /jsonx_schema/.test(d6.text), d6.text.slice(0, 400));

    const d7 = await call('jsonx_diff', {
      left: '{"a":1,"b":2}', right: '{"a":1,"b":2.0000000005}', numericTolerance: 0
    }, nid());
    check('容差为 0 时浮点差异被报出', /发现 1 处改动/.test(d7.text), d7.text.slice(0, 300));
    const d7b = await call('jsonx_diff', {
      left: '{"a":1,"b":2}', right: '{"a":1,"b":2.0000000005}', numericTolerance: 1e-6
    }, nid());
    check('给定容差后浮点差异被吸收',
      /两侧结构完全相等/.test(d7b.text) && /数值容差/.test(d7b.text), d7b.text.slice(0, 300));

    /* ---------------- jsonx_aggregate ---------------- */
    console.log('\n=== tools/call: jsonx_aggregate ===');
    const a1 = await call('jsonx_aggregate', {
      text: 'cat,amount\nEng,120\nSales,90\nEng,100\nSales,95', groupBy: 'cat'
    }, nid());
    check('aggregate 成功', !a1.isError, a1.text.slice(0, 200));
    check('aggregate 分组数正确', /按 cat，共 2 组/.test(a1.text), a1.text.slice(0, 300));
    check('aggregate Eng 组求和 220', /\|\s*Eng\s*\|\s*2\s*\|\s*220\s*\|/.test(a1.text), a1.text.slice(0, 700));
    check('aggregate Sales 组求和 185', /\|\s*Sales\s*\|\s*2\s*\|\s*185\s*\|/.test(a1.text), a1.text.slice(0, 700));
    check('aggregate Eng 平均 110', /\|\s*Eng\s*\|\s*2\s*\|\s*220\s*\|\s*110\s*\|/.test(a1.text));

    const a2 = await call('jsonx_aggregate', {
      text: '[{"amount":10},{"amount":20},{"amount":30}]', aggs: ['count', 'sum', 'avg', 'median', 'stddev']
    }, nid());
    check('中位数与标准差可用', !a2.isError, a2.text.slice(0, 300));
    check('自定义 aggs 的表头按顺序显示',
      /\|\s*字段\s*\|.*条数.*\|.*合计.*\|.*平均.*\|.*中位数.*\|.*标准差/.test(a2.text), a2.text.slice(0, 400));
    check('amount 行：条数 3 / 合计 60 / 平均 20 / 中位数 20 / 标准差 10',
      /\|\s*amount\s*\|\s*3\s*\|\s*60\s*\|\s*20\s*\|\s*20\s*\|\s*10\s*\|/.test(a2.text), a2.text.slice(0, 600));
    check('结构化 fields 给出机器可读的统计量',
      !!(a2.structured.fields && a2.structured.fields[0].median === 20 &&
         a2.structured.fields[0].stddev === 10 && a2.structured.fields[0].numeric === 3),
      JSON.stringify(a2.structured && a2.structured.fields));

    const a2b = await call('jsonx_aggregate', {
      text: '[{"v":1},{"v":2},{"v":3},{"v":4}]', aggs: ['stddev']
    }, nid());
    check('标准差是样本标准差（1,2,3,4 → 1.29099…，非总体 1.118）',
      !!(a2b.structured && Math.abs(a2b.structured.fields[0].stddev - Math.sqrt(5 / 3)) < 1e-9),
      a2b.structured && a2b.structured.fields[0].stddev);

    const a3 = await call('jsonx_aggregate', {
      text: 'cat,amount\nEng,120\nSales,90\nEng,100', filter: { cat: 'Eng' }
    }, nid());
    check('filter 生效', /已筛选 cat="Eng"/.test(a3.text), a3.text.slice(0, 300));
    check('filter 后记录数 2', /记录数: 2/.test(a3.text));
    check('filter 报告筛选前数量', /筛选前: 3/.test(a3.text));
    check('非数值字段 sum 显示 —（不返回 0 误导）',
      /\|\s*cat\s*\|[^|]*\|\s*—\s*\|/.test(a3.text), a3.text.slice(0, 700));
    check('备注解释 sum/avg 不适用', /sum\/avg 不适用/.test(a3.text), a3.text.slice(0, 900));

    const a4 = await call('jsonx_aggregate', {
      text: '{"items":[{"v":1},{"v":2},{"v":3}]}', path: '$.items'
    }, nid());
    check('path 指向嵌套数组', !a4.isError && /统计 \$\.items/.test(a4.text), a4.text.slice(0, 300));

    const a5 = await call('jsonx_aggregate', {
      text: 'cat,amount\nEng,120\nSales,90\nEng,100\nSales,95', groupBy: 'cat', sortBy: 'amount.sum', sortDesc: true
    }, nid());
    check('分组排序生效（Eng 在前）',
      a5.text.indexOf('Eng') < a5.text.indexOf('Sales'), a5.text.slice(0, 700));

    /* ---------------- 工具协作：schema → query → convert → aggregate ---------------- */
    console.log('\n=== 工具串联 ===');
    const workflowText = 'id,user.name,user.age,amount\n1,Alice,30,100\n2,Bob,25,200\n3,Alice,30,300';
    const w1 = await call('jsonx_schema', { text: workflowText }, nid());
    check('串联① schema 输出列定义（点号列名原样保留）', /user\.name/.test(w1.text), w1.text.slice(0, 400));
    const w2 = await call('jsonx_aggregate', {
      text: workflowText, groupBy: 'user.name', fields: ['amount'], sortBy: 'amount.sum', sortDesc: true
    }, nid());
    check('串联② 按点号列名分组求和（Alice 400 / Bob 200）',
      /\|\s*Alice\s*\|\s*2\s*\|\s*400\s*\|/.test(w2.text) && /\|\s*Bob\s*\|\s*1\s*\|\s*200\s*\|/.test(w2.text),
      w2.text.slice(0, 700));
    check('串联② fields 限定后只统计 amount（表头不含 id.user.name 等噪声）',
      !/id\.sum/.test(w2.text) && !/user\.age\.sum/.test(w2.text), w2.text.slice(0, 700));
    const w3 = await call('jsonx_convert', {
      text: workflowText, to: 'json', flatten: 'dot', indent: 2
    }, nid());
    check('串联③ 转 JSON 并往返校验通过',
      !w3.isError && w3.structured.roundTrip.ok === true, w3.text.slice(0, 300));
    const w4 = await call('jsonx_query', { text: '{"a":{"b":{"c":42}}}', path: '$.a.b.c' }, nid());
    check('串联④ 深路径取值',
      !!(w4.structured && w4.structured.results[0].matches[0].value === 42),
      w4.text.slice(0, 300));
    const w5 = await call('jsonx_diff', {
      left: workflowText, right: 'id,user.name,user.age,amount\n1,Alice,30,100\n2,Bob,25,200\n3,Alice,30,999'
    }, nid());
    check('串联⑤ CSV 两侧直接 diff（不需先转 JSON）',
      !w5.isError && /发现 1 处改动/.test(w5.text) && /\$\[2\]\.amount/.test(w5.text), w5.text.slice(0, 600));

    /* ---------------- 错误处理 ---------------- */
    console.log('\n=== 错误处理 ===');
    const e1 = await call('jsonx_convert', { text: '{"a":{"b":1}}', to: 'csv' }, nid());
    check('嵌套转 CSV 返回 isError', e1.isError, e1.text.slice(0, 200));
    check('嵌套转 CSV 给出 flatten=json / dot 两条出路',
      /flatten="json"/.test(e1.text) && /flatten="dot"/.test(e1.text), e1.text.slice(0, 400));
    check('嵌套转 CSV 给出"先 query 再转"的第三条路', /先用 jsonx_query/.test(e1.text));

    const e2 = await call('jsonx_query', { text: '[1,2,3]', path: '$[?(@>1)]' }, nid());
    check('JSONPath 过滤器不静默返回空，而是明确说明',
      /不支持过滤器表达式/.test(e2.text), e2.text.slice(0, 400));
    check('JSONPath 过滤器给出替代方案', /jsonx_aggregate/.test(e2.text));

    const e3 = await call('jsonx_parse', { text: 'a: &x 1\nb: *x', format: 'yaml' }, nid());
    check('YAML 锚点明确报错', e3.isError && /锚点/.test(e3.text), e3.text.slice(0, 300));

    const e4 = await call('jsonx_parse', { text: 'a: !!str 1', format: 'yaml' }, nid());
    check('YAML 标签明确报错', e4.isError && /标签/.test(e4.text), e4.text.slice(0, 300));

    const e5 = await call('jsonx_parse', {}, nid());
    check('缺 text 返回 isError', e5.isError);
    check('缺 text 给出调用示例', /例：/.test(e5.text), e5.text.slice(0, 250));

    const e6 = await call('jsonx_convert', { text: '{"a":1}', to: 'xml' }, nid());
    check('非法目标格式返回 isError', e6.isError);
    check('非法目标格式列出合法值', /json \/ yaml \/ csv \/ tsv \/ markdown/.test(e6.text), e6.text.slice(0, 250));

    const e7 = await call('no_such_tool', {}, nid());
    check('未知工具返回 isError', e7.isError);
    check('未知工具列出可用工具', /jsonx_parse/.test(e7.text) && /jsonx_query/.test(e7.text), e7.text.slice(0, 300));

    const e8 = await call('jsonx_query', { text: '{"a":1}' }, nid());
    check('query 缺 path 返回 isError', e8.isError);
    check('query 缺 path 给出两种写法', /paths/.test(e8.text) && /例：/.test(e8.text), e8.text.slice(0, 300));

    /* ---------------- ping / 其它协议方法 ---------------- */
    console.log('\n=== 协议方法 ===');
    const ping = await rpc('ping', {}, nid());
    check('ping 返回空结果', !!(ping && ping.result && typeof ping.result === 'object'));
    const rl = await rpc('resources/list', {}, nid());
    check('resources/list 返回空数组', !!(rl && rl.result && Array.isArray(rl.result.resources)));
    const pl = await rpc('prompts/list', {}, nid());
    check('prompts/list 返回空数组', !!(pl && pl.result && Array.isArray(pl.result.prompts)));

    check('服务器进程仍存活（无崩溃）', child.exitCode === null && !child.killed,
      'exitCode=' + child.exitCode);

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
