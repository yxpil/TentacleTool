'use strict';
/**
 * Stamp MCP Server 入口
 *
 * 时间与调度工具集：时间戳转换 / 时长解析 / 时区换算 / 工作日推算 / cron 解析与触发预测。
 * 协议：MCP Streamable HTTP (2025-03-26)，零依赖
 * 端口：8348（STAMP_PORT）
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
logger.log('[boot] Stamp MCP Server starting, pid=' + process.pid +
  ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.STAMP_PORT || process.env.PORT || '8348', 10);
const HOST = process.env.STAMP_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'stamp',
  serverVersion: '1.0.0',
  instructions: [
    'Stamp - 时间与调度 MCP 服务器（零依赖，纯 Node 原生 Date/Intl 实现时区运算）',
    '核心主张：不要相信自己对"现在"的记忆，也不要手算时区。凡涉及时间，先问 Stamp。',
    '可用工具：',
    '  - stamp_now      当前真实时间（多时区墙钟 + epoch 四种量级 + 今天/本周/本月/本年边界）',
    '  - stamp_convert  时间格式万能转换（epoch ↔ 日期字符串，自动识别秒/毫秒/微秒/纳秒）',
    '  - stamp_duration 时长解析与换算（1h30m / 1天2小时 / 90s），也支持两时刻求间隔',
    '  - stamp_zone     时区换算与偏移查询（含夏令时提醒与全年 DST 起止）',
    '  - stamp_workday  工作日推算（加/减 N 工作日、区间统计、判定某天，支持节假日与调休）',
    '  - stamp_cron     cron 解析（中文描述 + 未来 N 次触发预测），会指明日/周 OR 语义陷阱',
    '',
    '关键约定：',
    '  1) 时区一律用 IANA 名（Asia/Shanghai、America/New_York、UTC），不用缩写如 CST（有歧义）。',
    '  2) epoch 量级自动识别：10 位=秒，13 位=毫秒，16 位=微秒，19 位=纳秒。',
    '  3) 8 位/14 位纯数字按紧凑日期（YYYYMMDD / YYYYMMDDHHmmss）而非 epoch 解释。',
    '  4) 工作日默认只排除周末；中国法定节假日与调休必须显式传入 holidays / workdays。',
    '  5) cron 表达式自身不含时区，触发时刻取决于服务器时区，务必用 zone 参数说明假设。',
    '典型流程：先 stamp_now 校准时间 → 用 stamp_convert / stamp_zone 做换算 →',
    '         要算"几天后"用 stamp_workday → 要算"多久"用 stamp_duration → 定时任务用 stamp_cron。'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Stamp MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 STAMP_PORT 指定其他端口。`);
  }
  process.exit(1);
});
