'use strict';
/**
 * Search MCP Server 入口
 * 聚合搜索工具集：必应 / 百度 / DuckDuckGo
 * 协议：MCP Streamable HTTP (2025-03-26)，零依赖
 *
 * 设计核心：上下文经济
 *  - web_search 默认返回折叠摘要（标题+链接+短摘要），支持翻页
 *  - search_detail 按需展开单个结果全文，默认截断 8000 字符可续读
 *  - 多引擎结果轮询交错合并 + 去重，避免同站点刷屏
 */
const { McpStreamableHttpServer } = require('./mcp/server');
const logger = require('./utils/logger');

/* ===== 全局崩溃日志钩子：任何未捕获异常/未处理拒绝都写入日志，而不是静默闪退 ===== */
process.on('uncaughtException', (err, origin) => {
  logger.error('[uncaughtException] origin=' + origin, err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[unhandledRejection]', reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('exit', (code) => logger.log('[process exit] code=' + code));
logger.log('[boot] Search MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.SEARCH_PORT || process.env.PORT || '8343', 10);
const HOST = process.env.SEARCH_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'search',
  serverVersion: '1.0.0',
  instructions: [
    'Search - 聚合搜索 MCP 服务器（必应 / 百度 / DuckDuckGo），为 Agent 上下文经济设计',
    '可用工具：',
    '  - web_search      聚合搜索：返回折叠摘要列表（标题+链接+短摘要），多引擎并行合并去重，page/pageSize 翻页',
    '  - search_detail   展开单个结果：抓取原文转 Markdown，默认截断 8000 字符，可增大 maxLength 续读',
    '  - search_suggest  搜索词联想：必应 + 百度 suggest 合并，用于改写/扩展查询词'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Search MCP Server...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});

server.start().catch(e => {
  console.error('启动失败:', e.message);
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可用环境变量 SEARCH_PORT 指定其他端口。`);
  }
  process.exit(1);
});
