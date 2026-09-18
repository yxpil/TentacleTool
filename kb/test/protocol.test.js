'use strict';
/**
 * 协议层直连冒烟测试（不经过 MCP）
 *   运行：node test/protocol.test.js
 *
 * 环境变量：KB_TEST_HOST / KB_TEST_PORT / KB_TEST_USER / KB_TEST_PASSWORD / KB_TEST_DB
 */
const { Connection } = require('../src/db/connection');

const CFG = {
  host: process.env.KB_TEST_HOST || '127.0.0.1',
  port: Number(process.env.KB_TEST_PORT || 3306),
  user: process.env.KB_TEST_USER || 'root',
  password: process.env.KB_TEST_PASSWORD !== undefined ? process.env.KB_TEST_PASSWORD : '',
  connectTimeout: 8000,
  queryTimeout: 15000
};

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; failures.push(name + (detail ? '  —— ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  —— ' + detail : '')); }
}

(async () => {
  let conn;
  try {
    console.log('=== 连接握手与认证 ===');
    conn = new Connection(CFG);
    await conn.connect();
    check('TCP 连接 + 握手成功', conn.connected === true);
    check('拿到服务器版本', !!conn.serverVersion, conn.serverVersion);
    check('拿到 thread id', typeof conn.threadId === 'number' && conn.threadId > 0, 'threadId=' + conn.threadId);
    check('解析出 auth plugin', !!conn.authPlugin, conn.authPlugin);
    console.log('       serverVersion = ' + conn.serverVersion
      + ' | authPlugin = ' + conn.authPlugin
      + ' | capabilities = 0x' + conn.serverCapabilities.toString(16));

    console.log('\n=== 简单查询 ===');
    const r1 = await conn.query('SELECT VERSION() AS v, 1+1 AS two, NULL AS n');
    check('返回 resultset', r1.type === 'resultset');
    check('列数为 3', r1.columns.length === 3, 'got ' + r1.columns.length);
    check('行数为 1', r1.rows.length === 1);
    check('VERSION() 非空', !!r1.rows[0].v, JSON.stringify(r1.rows[0]));
    check('1+1 = 2（数字类型）', r1.rows[0].two === 2, 'got ' + JSON.stringify(r1.rows[0].two));
    check('NULL 正确解码为 null', r1.rows[0].n === null, 'got ' + JSON.stringify(r1.rows[0].n));

    console.log('\n=== 各数据类型解码 ===');
    const r2 = await conn.query(
      "SELECT CAST(1 AS SIGNED) AS i, CAST(1.5 AS DECIMAL(10,2)) AS d, " +
      "CAST('2024-03-05 10:20:30' AS DATETIME) AS dt, CAST('abc' AS CHAR(10)) AS s, " +
      "CAST(1.25 AS DOUBLE) AS f, CAST(-5 AS SIGNED) AS neg"
    );
    const row2 = r2.rows[0];
    check('整数 → number', row2.i === 1, 'i=' + JSON.stringify(row2.i));
    check('DECIMAL 保留字符串（不丢精度）', row2.d === '1.50', 'd=' + JSON.stringify(row2.d));
    check('DATETIME → 字符串（dateStrings 默认）', row2.dt === '2024-03-05 10:20:30', 'dt=' + JSON.stringify(row2.dt));
    check('CHAR → string', row2.s === 'abc', 's=' + JSON.stringify(row2.s));
    check('DOUBLE → number', row2.f === 1.25, 'f=' + JSON.stringify(row2.f));
    check('负数 → number', row2.neg === -5, 'neg=' + JSON.stringify(row2.neg));

    console.log('\n=== 大整数与 UTF-8 ===');
    const r3 = await conn.query('SELECT 9223372036854775807 AS big, \'中文测试😀\' AS cn');
    check('BIGINT 超安全范围 → 字符串保留精度',
      r3.rows[0].big === '9223372036854775807', 'big=' + JSON.stringify(r3.rows[0].big));
    check('UTF-8 中文与 emoji 正确', r3.rows[0].cn === '中文测试😀', 'cn=' + JSON.stringify(r3.rows[0].cn));

    console.log('\n=== SHOW / 元数据类语句 ===');
    const r4 = await conn.query('SHOW DATABASES');
    check('SHOW DATABASES 有结果', r4.rows.length > 0, 'rows=' + r4.rows.length);
    const names = r4.rows.map(x => x.Database);
    check('含 information_schema', names.includes('information_schema'), names.join(','));

    console.log('\n=== 错误处理 ===');
    // 先选一个真实存在的库，才能测到"表不存在 1146"而不是"未选库 1046"
    const dbRow = await conn.query('SHOW DATABASES');
    const testDb = (process.env.KB_TEST_DB && dbRow.rows.some(r => r.Database === process.env.KB_TEST_DB))
      ? process.env.KB_TEST_DB
      : (dbRow.rows.map(r => r.Database).find(n => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(n))
         || 'information_schema');
    await conn.query('USE `' + testDb + '`');
    const cur = await conn.query('SELECT DATABASE() AS d');
    check('USE 切换库成功', cur.rows[0].d === testDb, 'current=' + cur.rows[0].d);

    let err = null;
    try { await conn.query('SELECT * FROM definitely_not_exist_table_xyz'); }
    catch (e) { err = e; }
    check('不存在的表 → 抛 MySqlError', err && err.isMySqlError === true);
    check('错误码 1146（表不存在）', err && err.code === 1146, 'code=' + (err && err.code));
    check('错误信息非空', err && err.message.length > 0, err && err.message);
    console.log('       errno=' + (err && err.code) + ' sqlState=' + (err && err.sqlState) + ' msg=' + (err && err.message));

    let err2 = null;
    try { await conn.query('THIS IS NOT SQL AT ALL'); }
    catch (e) { err2 = e; }
    check('语法错误 → 抛 MySqlError', err2 && err2.isMySqlError === true, err2 && err2.message);

    console.log('\n=== 连接仍可用（错误后自愈） ===');
    const r5 = await conn.query('SELECT 42 AS x');
    check('错误查询后连接依然可用', r5.rows[0].x === 42, JSON.stringify(r5.rows[0]));

    console.log('\n=== ping ===');
    check('ping 成功', await conn.ping() === true);

    console.log('\n=== 多行结果 ===');
    const r6 = await conn.query('SELECT 1 AS a UNION ALL SELECT 2 UNION ALL SELECT 3');
    check('返回 3 行', r6.rows.length === 3, 'got ' + r6.rows.length);
    check('行值顺序正确', r6.rows.map(r => r.a).join(',') === '1,2,3', r6.rows.map(r => r.a).join(','));

    console.log('\n=== 重名列 ===');
    const r7 = await conn.query('SELECT 1 AS x, 2 AS x');
    check('重名列不覆盖（第二个带后缀）',
      r7.rows[0].x === 1 && r7.rows[0].x_1 === 2, JSON.stringify(r7.rows[0]));

    console.log('\n=== 空结果集 ===');
    const r8 = await conn.query('SELECT 1 AS a WHERE 1=0');
    check('空结果集返回 0 行', r8.rows.length === 0, 'got ' + r8.rows.length);
    check('空结果集仍有列定义', r8.columns.length === 1);

    console.log('\n=== 非 SELECT 语句返回 OK 包 ===');
    const r9 = await conn.query('SET @kb_probe = 1');
    check('SET 返回 ok 类型', r9.type === 'ok', 'got ' + r9.type);

    console.log('\n=== 关闭 ===');
    await conn.close();
    check('close() 后 destroyed', conn.destroyed === true);
    conn = null;

  } catch (e) {
    fail++;
    failures.push('运行时异常: ' + e.message);
    console.log('  FAIL  运行时异常: ' + e.message);
    console.log(e.stack);
  } finally {
    if (conn) { try { await conn.close(); } catch (x) { /* ignore */ } }
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
