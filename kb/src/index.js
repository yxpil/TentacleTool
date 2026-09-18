'use strict';
/**
 * KB MCP Server 入口
 *
 * 知识库工具集：把多个 MySQL 表当作一个"知识库"来查询。
 * 协议：MCP Streamable HTTP (2025-03-26)，零依赖
 * 端口：8347（KB_PORT）
 */
const { McpStreamableHttpServer } = require('./mcp/server');
const logger = require('./utils/logger');
const runtime = require('./kb/runtime');

/* ===== 全局崩溃日志钩子：任何未捕获异常/未处理拒绝都写入日志，而不是静默闪退 ===== */
process.on('uncaughtException', (err, origin) => {
  logger.error('[uncaughtException] origin=' + origin, err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[unhandledRejection]', reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('exit', (code) => logger.log('[process exit] code=' + code));
logger.log('[boot] KB MCP Server starting, pid=' + process.pid +
  ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.KB_PORT || process.env.PORT || '8347', 10);
const HOST = process.env.KB_HOST || '127.0.0.1';

/* 启动时尝试加载配置，但不因失败而退出：
   用户第一次跑最需要的是"该怎么配"，服务器起来了才能通过 kb_config 告诉他。 */
(function bootConfig() {
  const s = runtime.init(false);
  if (s.loaded) {
    logger.log('[boot] 配置就绪：' + s.configPath +
      ' | sources=' + Object.keys(s.config.sources).join(',') +
      ' | knowledgeBases=' + Object.keys(s.config.knowledgeBases).join(','));
    if (s.warnings && s.warnings.length) {
      for (const w of s.warnings) logger.warn('[config] ' + w);
    }
  } else {
    logger.warn('[boot] 知识库未配置：' + (s.error ? s.error.message.split('\n')[0] : '未知'));
    console.warn('\n⚠️  知识库尚未配置。服务器仍会启动，调用 kb_config 可查看配置方式。\n');
  }
})();

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'kb',
  serverVersion: '1.0.0',
  instructions: [
    'KB - 知识库 MCP 服务器（把多个 MySQL 表当作知识库来查）',
    '"知识库"= 一批有业务含义的 MySQL 表的集合，可以跨库、跨数据源组合，在 kb.config.json 里定义。',
    '可用工具：',
    '  - kb_sources   列出已配置的知识库与数据源及其连通性（**开头的第一个调用**）',
    '  - kb_schema    看表结构：列/类型/注释/主键/外键/索引（注释里有业务语义，重点看）',
    '  - kb_search    跨多张表搜索关键词，返回命中片段与出处（库.表.列）',
    '  - kb_query     执行只读 SQL（SELECT/SHOW/DESCRIBE/EXPLAIN），无 LIMIT 会自动补上',
    '  - kb_stats     知识库概览：每张表的行数/列数/主键/是否有注释/是否可搜索',
    '  - kb_config    查看配置加载状态、连通性诊断、热重载（refresh=true）',
    '安全边界：数据源默认只读，写操作（INSERT/UPDATE/DELETE/DROP…）会被拒绝；',
    '查询结果有行数与字符预算上限，超限会提示收窄条件而不是把上下文撑爆。',
    '典型流程：kb_sources → kb_schema(看清列与注释) → kb_search(找内容) 或 kb_query(精确查)。'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 KB MCP Server...');
  await runtime.shutdown();
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await runtime.shutdown();
  await server.stop();
  process.exit(0);
});

server.start().catch(e => {
  console.error('启动失败:', e.message);
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可用环境变量 KB_PORT 指定其他端口。`);
  }
  process.exit(1);
});
