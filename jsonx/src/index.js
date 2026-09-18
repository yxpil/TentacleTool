'use strict';
/**
 * Jsonx MCP Server 入口
 *
 * 数据格式工具集：JSON / YAML / CSV / TSV 互转、JSONPath 查询、
 * 结构推断、结构化 diff、统计聚合。零依赖。
 * 协议：MCP Streamable HTTP (2025-03-26)
 * 端口：8349（JSONX_PORT）
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
logger.log('[boot] Jsonx MCP Server starting, pid=' + process.pid +
  ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.JSONX_PORT || process.env.PORT || '8349', 10);
const HOST = process.env.JSONX_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'jsonx',
  serverVersion: '1.0.0',
  instructions: [
    'Jsonx - 数据格式处理 MCP 服务器（零依赖：JSON / YAML / CSV / TSV 互转、JSONPath 查询、结构推断、结构化 diff、统计聚合）',
    '核心主张：凡是"解析/转换/查询/比较/统计结构化数据"的活，先交给 Jsonx，不要凭记忆手写解析逻辑。',
    '可用工具：',
    '  - jsonx_parse      解析文本为数据（自动识别 JSON/YAML/CSV/TSV，给形状、列类型与预览）',
    '  - jsonx_convert    格式互转（→ json / yaml / csv / tsv / markdown），转完自动做往返校验',
    '  - jsonx_query      JSONPath 取值（$ .key [n] [*] ..key 切片 多选；支持一次多个路径）',
    '  - jsonx_schema     结构推断（字段/类型/可空性/枚举/嵌套；拿陌生数据先调它）',
    '  - jsonx_diff       结构化 diff（键顺序与缩进不计；数组支持 index / byKey / ignoreOrder）',
    '  - jsonx_aggregate  统计聚合（计数/求和/平均/最值/中位数/标准差/唯一值，支持分组与筛选）',
    '',
    '关键约定：',
    '  1) 源格式默认 auto 自动识别；识别不准时用 format 参数显式指定。',
    '  2) CSV 用完整状态机解析，正确处理引号内逗号、字段内换行、转义引号 ""。',
    '  3) 类型推断保守优先：前导零（0912）、超长整数（雪花 ID）一律留字符串，绝不误转数字。',
    '  4) 嵌套对象转 CSV 会明确报错并给出 flatten=json / flatten=dot 两种压平策略，不静默丢数据。',
    '  5) JSONPath 不支持过滤器 [?(...)]，会报错并给出替代方案（不静默返回空数组）。',
    '  6) YAML 不支持锚点 & / 别名 * / 标签 !! —— 遇到会明确报错，不会静默忽略导致值错误。',
    '典型流程：先 jsonx_schema 摸清结构 → jsonx_query 取数 / jsonx_convert 换格式 →',
    '         jsonx_aggregate 统计 → jsonx_diff 比对两版数据。'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Jsonx MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 JSONX_PORT 指定其他端口。`);
  }
  process.exit(1);
});
