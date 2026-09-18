'use strict';
/**
 * Calc MCP Server 入口
 * 科学计算器工具集：表达式求值 / 单位换算 / 方程求解 / 矩阵运算 / 语法帮助
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
logger.log('[boot] Calc MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.CALC_PORT || process.env.PORT || '3000', 10);
const HOST = process.env.CALC_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'calc',
  serverVersion: '1.0.0',
  instructions: [
    'Calc - 科学计算器 MCP 服务器',
    '可用工具：',
    '  - calc_eval      数学表达式求值（变量、常量、复数、三角/指数/对数/统计/数论，支持多语句）',
    '  - calc_convert   单位换算（长度/质量/温度/面积/体积/速度/数据/时间/压强/能量）',
    '  - calc_equation  方程与方程组求解（线性/二次/高次多项式/超越方程数值求根）',
    '  - calc_matrix    矩阵运算（加/减/乘/行列式/逆/转置/秩/解线性方程组）',
    '  - calc_help      语法帮助（函数清单、常量、运算符、示例）',
    '提示：不确定语法时先调 calc_help（可按 topic 只取需要的一节，省上下文）'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Calc MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 CALC_PORT 指定其他端口。`);
  }
  process.exit(1);
});
