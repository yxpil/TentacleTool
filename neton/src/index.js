'use strict';
/**
 * NetON MCP Server 入口
 * 局域网网络工具集：设备发现 / 局域网扫描 / 端口扫描 / 端口分析 / 协议分析 / 抓包
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
logger.log('[boot] NetON MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.NETON_PORT || process.env.PORT || '3000', 10);
const HOST = process.env.NETON_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'netonhome',
  serverVersion: '2.0.0',
  instructions: [
    'NetonHome - 家庭安全守护 MCP 服务器（网络安全 + 场景感知）',
    '可用工具：',
    '  - device_discovery  局域网设备发现（ARP + ICMP + 端口探测 -> 设备/MAC/厂商清单）',
    '  - network_scan      局域网扫描（网段存活探测 + 端口扫描 + 服务统计）',
    '  - port_scan         端口扫描（常见端口 / 指定端口 / 全端口，支持 banner）',
    '  - port_analyze      端口分析（服务识别 + banner 指纹 + 风险评级 + 加固建议）',
    '  - protocol_analyze  协议分析（HTTP/SSH/TLS/FTP/SMTP/Redis/MySQL/MQTT/SMB 等深层探测）',
    '  - packet_capture    抓包（pktmon 真实抓包 / 实时 TCP 连接监控）'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 NetON MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 NETON_PORT 指定其他端口。`);
  }
  process.exit(1);
});
