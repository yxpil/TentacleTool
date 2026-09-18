'use strict';
/**
 * MCP 端到端自测：自 spawn 服务器，走完整 JSON-RPC 流程
 *   运行：node test/mcp.e2e.js
 *
 * 需要有可用的 MySQL 连接（默认读 kb.config.json，可用环境变量覆盖）。
 * 若数据库不可达，连接类断言会被跳过（标记 SKIP），但协议与安全断言仍会执行。
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 18347;            // 测试端口，避免和真实 8347 冲突
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? '  —— ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  —— ' + detail : '')); }
}
function skipped(name, why) { skip++; console.log('  SKIP  ' + name + (why ? '  (' + why + ')' : '')); }

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
function structOf(resp) {
  return (resp && resp.result && resp.result.structuredContent) || {};
}

/* ==================================================================== */
(async () => {
  // 若没有配置文件，先用环境变量造一个临时配置指向本机 MySQL
  const cfgPath = path.join(ROOT, 'kb.config.json');
  const hasCfg = fs.existsSync(cfgPath);
  const env = Object.assign({}, process.env, { KB_PORT: String(PORT) });
  if (!hasCfg && !process.env.KB_MYSQL_URL && !process.env.KB_CONFIG) {
    const example = path.join(ROOT, 'kb.config.example.json');
    if (fs.existsSync(example)) env.KB_CONFIG = example;
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootLog = '';
  child.stdout.on('data', d => { bootLog += d.toString(); });
  child.stderr.on('data', d => { bootLog += d.toString(); });

  const cleanup = () => { try { child.kill(); } catch (e) { /* ignore */ } };

  try {
    await waitPort(PORT);
    console.log('\n服务器已启动 (pid=' + child.pid + ', port=' + PORT + ')\n');

    /* ---------------- 握手 ---------------- */
    console.log('=== MCP 握手 ===');
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'kb-e2e', version: '1.0.0' }
    });
    check('initialize 成功', init && init.result && init.result.serverInfo, JSON.stringify(init).slice(0, 200));
    check('serverInfo.name = kb',
      init && init.result && init.result.serverInfo.name === 'kb',
      init && init.result ? init.result.serverInfo.name : '');
    check('instructions 提到知识库与只读',
      init && init.result && /知识库/.test(init.result.instructions || '') &&
      /只读/.test(init.result.instructions || ''));
    check('拿到 session id', !!sessionId);
    await rpc('notifications/initialized', {}, undefined);

    /* ---------------- tools/list ---------------- */
    console.log('\n=== tools/list ===');
    const list = await rpc('tools/list', {});
    const tools = list.result.tools || [];
    const names = tools.map(t => t.name);
    check('tools/list 返回 6 个工具', names.length === 6, names.join(', '));
    for (const n of ['kb_sources', 'kb_schema', 'kb_search', 'kb_query', 'kb_stats', 'kb_config']) {
      check('含 ' + n, names.includes(n), names.join(', '));
    }
    check('每个工具都有 inputSchema',
      tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    check('kb_query schema 含 sql 且必填',
      byName.kb_query.inputSchema.required &&
      byName.kb_query.inputSchema.required.includes('sql'));
    check('kb_search schema 含 query',
      Object.keys(byName.kb_search.inputSchema.properties).includes('query'));
    check('kb_schema schema 含 table',
      Object.keys(byName.kb_schema.inputSchema.properties).includes('table'));

    /* ---------------- 配置诊断 ---------------- */
    console.log('\n=== tools/call: kb_config ===');
    const rCfg = await rpc('tools/call', { name: 'kb_config', arguments: { probe: true } }, 2);
    const tCfg = textOf(rCfg);
    check('kb_config 返回 isError=false', rCfg.result && rCfg.result.isError === false, tCfg.slice(0, 200));
    const sc = structOf(rCfg);
    check('kb_config 报告配置状态', typeof sc.configured === 'boolean', JSON.stringify(sc).slice(0, 200));
    check('kb_config 输出不含明文密码（password 字段被打码）',
      !/"password"\s*:\s*"(?!\*\*\*)/.test(JSON.stringify(sc)), '检测到疑似明文密码');

    const configured = sc.configured === true;

    /* ---------------- 数据源列表 ---------------- */
    console.log('\n=== tools/call: kb_sources ===');
    const rSrc = await rpc('tools/call', { name: 'kb_sources', arguments: { verbose: true } }, 3);
    const tSrc = textOf(rSrc);
    check('kb_sources isError=false', rSrc.result && rSrc.result.isError === false);
    if (configured) {
      check('列出了数据源', /数据源/.test(tSrc), tSrc.slice(0, 300));
      check('列出了知识库', /知识库/.test(tSrc), tSrc.slice(0, 300));
      const ss = structOf(rSrc);
      check('结构化输出含 knowledgeBases',
        Array.isArray(ss.knowledgeBases) && ss.knowledgeBases.length > 0,
        JSON.stringify(ss).slice(0, 300));
    } else {
      skipped('数据源/知识库断言', '未配置数据库');
      check('未配置时给出配置指引', /配置/.test(tSrc) && /kb\.config/.test(tSrc), tSrc.slice(0, 300));
    }

    /* ---------------- 后续断言都需要连通 ---------------- */
    if (configured) {
      const kbName = (structOf(rSrc).knowledgeBases || [])[0] && structOf(rSrc).knowledgeBases[0].name;

      console.log('\n=== tools/call: kb_schema（多表概览） ===');
      const rSch = await rpc('tools/call', { name: 'kb_schema', arguments: {} }, 4);
      const tSch = textOf(rSch);
      check('kb_schema isError=false', rSch.result && rSch.result.isError === false, tSch.slice(0, 200));
      check('列出了表', /表/.test(tSch) && tSch.length > 100, tSch.slice(0, 200));
      const schStruct = structOf(rSch);
      check('结构化输出含 tables 数组',
        Array.isArray(schStruct.tables) && schStruct.tables.length > 0,
        'tables=' + (schStruct.tables || []).length);
      const firstTable = (schStruct.tables || [])[0];

      if (firstTable) {
        console.log('\n=== tools/call: kb_schema（单表详情） ===');
        const rOne = await rpc('tools/call', {
          name: 'kb_schema',
          arguments: { table: firstTable.database + '.' + firstTable.table }
        }, 5);
        const tOne = textOf(rOne);
        check('单表详情有列定义', /■ 列/.test(tOne), tOne.slice(0, 300));
        const oneStruct = structOf(rOne);
        check('单表详情返回列数组',
          Array.isArray(oneStruct.columns) && oneStruct.columns.length > 0,
          'columns=' + (oneStruct.columns || []).length);
        check('列信息含类型', (oneStruct.columns || []).every(c => !!c.type));
      }

      console.log('\n=== tools/call: kb_stats ===');
      const rStat = await rpc('tools/call', { name: 'kb_stats', arguments: {} }, 6);
      const tStat = textOf(rStat);
      check('kb_stats 有汇总', /汇总/.test(tStat), tStat.slice(0, 300));
      check('kb_stats 有明细表', /明细/.test(tStat), tStat.slice(0, 400));
      const statStruct = structOf(rStat);
      check('kb_stats 返回 tableCount',
        typeof statStruct.tableCount === 'number' && statStruct.tableCount > 0,
        'tableCount=' + statStruct.tableCount);

      console.log('\n=== tools/call: kb_search（跨表搜索） ===');
      // 用一个几乎肯定存在的高频词；退化到表名里的常见片段
      const probeWord = process.env.KB_TEST_SEARCH_WORD || '的';
      const rSea = await rpc('tools/call', {
        name: 'kb_search',
        arguments: { query: probeWord, limit: 10 }
      }, 7);
      const tSea = textOf(rSea);
      check('kb_search isError=false', rSea.result && rSea.result.isError === false, tSea.slice(0, 300));
      check('kb_search 报告扫描表数', /扫描 \d+ 张表/.test(tSea), tSea.slice(0, 300));
      const seaStruct = structOf(rSea);
      check('kb_search 返回 scannedTables',
        typeof seaStruct.scannedTables === 'number', 'scanned=' + seaStruct.scannedTables);
      check('kb_search 命中结果带出处（库.表.列）',
        seaStruct.totalHits === 0 ||
        (Array.isArray(seaStruct.results) && seaStruct.results.every(h => h.database && h.table && h.column)),
        JSON.stringify((seaStruct.results || [])[0] || {}).slice(0, 300));

      console.log('\n=== tools/call: kb_search（无结果时的引导） ===');
      const rNone = await rpc('tools/call', {
        name: 'kb_search',
        arguments: { query: 'zzz_definitely_absent_zzz_9f3a' }
      }, 8);
      const tNone = textOf(rNone);
      check('搜不到时给出可操作建议',
        /没有找到/.test(tNone) && /建议/.test(tNone), tNone.slice(0, 300));

      console.log('\n=== tools/call: kb_query（只读 SQL） ===');
      const rQ = await rpc('tools/call', {
        name: 'kb_query',
        arguments: { sql: 'SELECT 1 AS one, 2 AS two, NULL AS n' }
      }, 9);
      const tQ = textOf(rQ);
      check('kb_query isError=false', rQ.result && rQ.result.isError === false, tQ.slice(0, 300));
      check('kb_query 返回结果表', /one/.test(tQ) && /two/.test(tQ), tQ.slice(0, 300));
      const qStruct = structOf(rQ);
      check('kb_query 结构化返回行数据',
        Array.isArray(qStruct.rows) && qStruct.rows.length === 1 && qStruct.rows[0].one === 1,
        JSON.stringify(qStruct.rows || []).slice(0, 200));

      console.log('\n=== kb_query 自动补 LIMIT ===');
      const rQ2 = await rpc('tools/call', {
        name: 'kb_query',
        arguments: { sql: 'SELECT 1 AS a UNION ALL SELECT 2 UNION ALL SELECT 3', limit: 2 }
      }, 10);
      const tQ2 = textOf(rQ2);
      const qs2 = structOf(rQ2);
      check('自动加 LIMIT 生效', /自动加 LIMIT/.test(tQ2), tQ2.slice(0, 300));
      check('返回行数被限制', qs2.rowCount <= 2, 'rowCount=' + qs2.rowCount);

      /* ---------------- 安全护栏（最重要的断言） ---------------- */
      console.log('\n=== 安全护栏：只读拦截 ===');
      for (const [label, sql] of [
        ['DELETE', 'DELETE FROM sys_user WHERE 1=1'],
        ['UPDATE', "UPDATE sys_user SET username='x' WHERE id=1"],
        ['DROP', 'DROP TABLE sys_user'],
        ['TRUNCATE', 'TRUNCATE TABLE sys_user'],
        ['INSERT', "INSERT INTO sys_user (username) VALUES ('x')"],
        ['ALTER', 'ALTER TABLE sys_user ADD COLUMN zz INT'],
        ['多语句', 'SELECT 1; DROP TABLE sys_user'],
        ['注释绕过', '/* hide */ DELETE FROM sys_user'],
        ['行注释绕过', '-- x\nDELETE FROM sys_user']
      ]) {
        const r = await rpc('tools/call', { name: 'kb_query', arguments: { sql } }, 100 + Math.floor(Math.random() * 1000));
        const t = textOf(r);
        check('拒绝 ' + label + ' 且未执行',
          /只读模式拒绝/.test(t) && !/语句执行成功/.test(t), t.slice(0, 200));
      }

      console.log('\n=== 安全护栏：越界查询 ===');
      if (kbName) {
        // 找一个明确不属于该知识库的业务表来测越界（系统元数据库是刻意放行的）
        const kbTables = new Set((structOf(rSrc).knowledgeBases || [])
          .find(k => k.name === kbName).tableNames.map(t => t.toLowerCase()));
        const outside = (schStruct.tables || []).find(t =>
          !kbTables.has(((t.database ? t.database + '.' : '') + t.table).toLowerCase()) &&
          !kbTables.has(t.table.toLowerCase()));
        if (outside) {
          const outRef = (outside.database ? outside.database + '.' : '') + outside.table;
          const rOut = await rpc('tools/call', {
            name: 'kb_query',
            arguments: { sql: 'SELECT * FROM ' + outRef, knowledgeBase: kbName }
          }, 11);
          check('限定知识库时拒绝查询库外的业务表',
            /之外的表/.test(textOf(rOut)), textOf(rOut).slice(0, 250));
        } else {
          skipped('越界查询断言', '没有找到库外的表可用于测试');
        }
        // 元数据查询是刻意放行的（Agent 常用 SHOW / information_schema 探查结构）
        const rMeta = await rpc('tools/call', {
          name: 'kb_query',
          arguments: { sql: 'SELECT TABLE_NAME FROM information_schema.TABLES LIMIT 3', knowledgeBase: kbName }
        }, 111);
        check('系统元数据库（information_schema）刻意放行',
          rMeta.result && rMeta.result.isError === false, textOf(rMeta).slice(0, 200));
      }

      console.log('\n=== 错误处理：SQL 错误可读 ===');
      const rErr = await rpc('tools/call', {
        name: 'kb_query',
        arguments: { sql: 'SELECT * FROM definitely_not_exist_table_zzz' }
      }, 12);
      const tErr = textOf(rErr);
      check('表不存在时给出可操作提示',
        /查询失败/.test(tErr) && /kb_schema|表不存在/.test(tErr), tErr.slice(0, 300));

      console.log('\n=== 错误处理：SQL 语法错误可读 ===');
      // 故意用"能通过只读闸门但语法错误"的语句，测的是 MySQL 报错后的提示
      const rSyn = await rpc('tools/call', {
        name: 'kb_query', arguments: { sql: 'SELECT FROM WHERE' }
      }, 13);
      const tSyn = textOf(rSyn);
      check('语法错误被捕获且不崩（非只读拦截，而是真的执行后被 MySQL 拒绝）',
        /查询失败/.test(tSyn) && !/只读模式拒绝/.test(tSyn), tSyn.slice(0, 250));

      // 同时验证"非 SELECT 开头"确实被只读闸门提前拦下
      const rNotSql = await rpc('tools/call', {
        name: 'kb_query', arguments: { sql: 'THIS IS NOT SQL' }
      }, 131);
      check('非查询语句被只读闸门提前拦截', /只读模式只允许/.test(textOf(rNotSql)),
        textOf(rNotSql).slice(0, 200));

      console.log('\n=== 错误处理：知识库不存在 ===');
      const rKb = await rpc('tools/call', {
        name: 'kb_schema', arguments: { knowledgeBase: 'no_such_kb_zzz' }
      }, 14);
      check('未知知识库给出可用列表',
        /未找到知识库/.test(textOf(rKb)), textOf(rKb).slice(0, 250));

      console.log('\n=== 参数化查询防注入 ===');
      const rInj = await rpc('tools/call', {
        name: 'kb_query',
        arguments: {
          sql: 'SELECT ? AS v',
          params: ["x' OR '1'='1"]
        }
      }, 15);
      const injStruct = structOf(rInj);
      check('参数里的引号被安全转义（原样返回值而非注入）',
        rInj.result && rInj.result.isError === false &&
        injStruct.rows && injStruct.rows[0] && injStruct.rows[0].v === "x' OR '1'='1",
        JSON.stringify(injStruct.rows || []).slice(0, 200));

      console.log('\n=== 内容为纯文本（不是 JSON 大块） ===');
      check('content[0].text 是纯文本而非 JSON 对象',
        !tQ.trimStart().startsWith('{') && !tQ.trimStart().startsWith('['),
        tQ.slice(0, 120));
      check('structuredContent 不含 _text 键',
        !('_text' in structOf(rQ)), Object.keys(structOf(rQ)).join(','));

    } else {
      skipped('库相关全部断言', '数据库未配置');
    }

    /* ---------------- ping ---------------- */
    console.log('\n=== ping ===');
    const ping = await rpc('ping', {}, 16);
    check('ping 返回空结果', ping && ping.result && typeof ping.result === 'object');

  } catch (e) {
    fail++; failures.push('运行时异常: ' + e.message);
    console.log('  FAIL  运行时异常: ' + e.message + '\n' + e.stack);
    if (bootLog) console.log('--- 服务器输出 ---\n' + bootLog.slice(-2000));
  } finally {
    cleanup();
  }

  console.log('\n' + '='.repeat(52));
  console.log(`  通过 ${pass}  失败 ${fail}  跳过 ${skip}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  · ' + f));
  }
  console.log('='.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
