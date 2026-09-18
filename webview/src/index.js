'use strict';
/**
 * WebView MCP Server 入口
 * 网页转 Markdown 工具集：网页转 MD / HTML 转 MD / 链接提取 / 元信息提取
 * 协议：MCP Streamable HTTP (2025-03-26)，零依赖
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
logger.log('[boot] WebView MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.WEBVIEW_PORT || process.env.PORT || '8342', 10);
const HOST = process.env.WEBVIEW_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'webview',
  serverVersion: '1.0.0',
  instructions: [
    'WebView - 网页转 Markdown MCP 服务器',
    '可用工具：',
    '  - web_to_md    抓取网页并转换为 Markdown（正文模式自动去噪，支持标题/列表/表格/代码块/引用/链接/图片）',
    '  - html_to_md   将已有 HTML 源码直接转换为 Markdown（不发起网络请求）',
    '  - web_links    提取网页全部链接（绝对地址化 + 去重 + 域名分布统计）',
    '  - web_meta     提取网页元信息（title / OpenGraph / SEO / 页面统计 / 阅读时长）'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 WebView MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 WEBVIEW_PORT 指定其他端口。`);
  }
  process.exit(1);
});
