'use strict';
/**
 * Find MCP Server 入口
 * 本机搜索工具集：文件名搜索 / 最近修改 / 内容检索 / 可执行工具定位
 * 协议：MCP Streamable HTTP (2025-03-26)，零依赖
 */
const { McpStreamableHttpServer } = require('./mcp/server');
const logger = require('./utils/logger');
const { getIndex } = require('./utils/indexer');

/* ===== 全局崩溃日志钩子：任何未捕获异常/未处理拒绝都写入日志，而不是静默闪退 ===== */
process.on('uncaughtException', (err, origin) => {
  logger.error('[uncaughtException] origin=' + origin, err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[unhandledRejection]', reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('exit', (code) => logger.log('[process exit] code=' + code));
logger.log('[boot] Find MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.FIND_PORT || process.env.PORT || '3000', 10);
const HOST = process.env.FIND_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'find',
  serverVersion: '1.0.0',
  instructions: [
    'Find - 本机文件搜索 MCP 服务器（Everything 风格）',
    '可用工具：',
    '  - find_files     按文件名/路径搜索本机文件（sub/fuzzy/glob/regex 四种模式 + 评分排序 + 翻页）',
    '  - find_recent    列出最近修改的文件（默认近 24 小时，可指定时间段/类型/扩展名）',
    '  - find_in_files  在文件内容里搜关键词/正则（限文本类扩展名，带行号与上下文折叠）',
    '  - find_tool      定位可执行工具（PATH 扫描 + 全盘索引兜底，返回可直接调用的绝对路径）',
    '提示：首次调用会构建全盘索引（几十秒），之后走磁盘缓存（6 小时 TTL）秒回。'
  ].join('\n')
});

/* ===== 启动后台预热：服务一起来就重建/加载索引，首次工具调用即可命中缓存 ===== */
setTimeout(() => {
  getIndex().then(idx => {
    logger.log('[warmup] index ready: count=' + idx.count + ' tookMs=' + idx.tookMs + ' truncated=' + idx.truncated);
  }).catch(e => {
    logger.error('[warmup] index build failed', e);
  });
}, 300);

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Find MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 FIND_PORT 指定其他端口。`);
  }
  process.exit(1);
});
