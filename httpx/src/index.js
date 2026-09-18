'use strict';
/**
 * Httpx MCP Server 入口
 * HTTP 客户端工具集：通用请求 / 下载 / 头探测 / 批量 / JSON / 探测，Streamable HTTP 协议
 */
const { McpStreamableHttpServer } = require('./mcp/server');
const logger = require('./utils/logger');

/* ===== 全局崩溃日志钩子 ===== */
process.on('uncaughtException', (err, origin) => {
  logger.error('[uncaughtException] origin=' + origin, err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[unhandledRejection]', reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('exit', (code) => logger.log('[process exit] code=' + code));
logger.log('[boot] Httpx MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.HTTPX_PORT || process.env.PORT || '8352', 10);
const HOST = process.env.HTTPX_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'httpx',
  serverVersion: '1.0.0',
  instructions: [
    'Httpx - 零依赖 HTTP 客户端 MCP 服务器',
    '可用工具：',
    '  - httpx_request  通用 HTTP 请求（method/url/headers/query/body/auth/超时/重定向/解压，文本智能截断、二进制只报大小类型）',
    '  - httpx_download 下载到文件（大小上限、超时、断点续传 Range、返回路径与字节数）',
    '  - httpx_head     头信息探测（状态、全部响应头、重定向链、各阶段耗时）',
    '  - httpx_batch    并发批量请求（URL 列表、并发数上限、单条超时、失败重试 1 次、汇总表）',
    '  - httpx_json     JSON API 便捷调用（GET/POST JSON、自动 Content-Type、非 2xx 也返回响应体）',
    '  - httpx_probe    简易探测（http/https 状态码、重定向去向、HTTPS 证书有效期）',
    '安全：默认拒绝内网/环回/链路本地地址（SSRF 防护），需访问内网传 allowPrivate=true；只支持 http/https；认证头绝不进日志。'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Httpx MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 HTTPX_PORT 指定其他端口。`);
  }
  process.exit(1);
});
