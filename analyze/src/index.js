'use strict';
/**
 * Analyze MCP Server 入口
 * 代码知识图谱工具集：建图 / 查引用 / 看依赖 / 搜索符号 / 找路径 / 分析影响 / 图统计
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
logger.log('[boot] Analyze MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.ANALYZE_PORT || process.env.PORT || '8346', 10);
const HOST = process.env.ANALYZE_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'analyze',
  serverVersion: '1.0.0',
  instructions: [
    'Analyze - 代码知识图谱 MCP 服务器',
    '把代码目录解析成"符号 + 关系"的图，供 Agent 做结构级理解，而不是靠 grep 猜。',
    '可用工具：',
    '  - analyze_build     解析目录建图（符号定义 + 导入 + 调用 + 继承 + 包含），带增量缓存',
    '  - analyze_find      按名字模糊搜符号（函数/类/方法/变量），返回定义位置与首句注释',
    '  - analyze_refs      查某符号被谁引用/调用（谁在用我），可按边类型过滤',
    '  - analyze_callers   追踪调用链，direction=callers 向上找谁调用我 / callees 向下找我在调谁',
    '  - analyze_deps      看某文件的依赖（导入/包含）与被依赖；cycles=true 时做全仓循环依赖检测',
    '  - analyze_path      两个符号/文件之间的最短关系路径（六度分隔），可要求给出备选路径',
    '  - analyze_impact    改动影响面分析（改动某符号会波及哪些文件，附风险评级）',
    '  - analyze_stats     图谱概览（文件/符号/边数、语言分布、枢纽节点、死代码候选）',
    '支撑语言：JavaScript/TypeScript、Python、Go、Rust、Java、C/C++、C#、Ruby、PHP；',
    '其余语言退化为"文件级"依赖图（仅 import/include 与文件名索引），仍可用。',
    '典型用法：先 analyze_build 建图 → 用 analyze_find 定位符号 → analyze_refs / analyze_impact 摸清改动风险。'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Analyze MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 ANALYZE_PORT 指定其他端口。`);
  }
  process.exit(1);
});
