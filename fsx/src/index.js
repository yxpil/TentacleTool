'use strict';
/**
 * Fsx MCP Server 入口
 * 本机文件系统操作工具集：读 / 写 / 改 / 列目录 / 目录树 / 属性 / 内容搜索 / 复制 / 移动 / 删除
 * 协议：MCP Streamable HTTP (2025-03-26)，零依赖（node:fs / path / os）
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
logger.log('[boot] Fsx MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.FSX_PORT || process.env.PORT || '8350', 10);
const HOST = process.env.FSX_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'fsx',
  serverVersion: '1.0.0',
  instructions: [
    'Fsx - 本机文件系统操作 MCP 服务器（零依赖，Streamable HTTP 协议）',
    '可用工具（全部作用于你显式传入的 path，绝不扫描整盘）：',
    '  - fsx_read    读文件：行范围(startLine/endLine)、编码、大文件分页、二进制检测、续读提示',
    '  - fsx_write   写文件：覆盖/追加、自动建父目录、返回字节数与行数',
    '  - fsx_edit    精确文本替换：oldText/newText、replaceAll，匹配数校验（0 或多处报错），返回改动摘要+行号',
    '  - fsx_list    列目录：递归/深度/glob 过滤/排序(name/size/mtime)/limit + 翻页提示',
    '  - fsx_tree    目录树：可视树形、深度限制、默认忽略 node_modules/.git 等',
    '  - fsx_stat    文件属性：大小/时间/类型/权限/行数/编码猜测，支持批量多路径',
    '  - fsx_grep    内容搜索：正则或字面量、文件类型过滤、上下文行数、命中行号、limit + 翻页提示',
    '  - fsx_copy    复制（文件或目录、覆盖开关）',
    '  - fsx_move    移动/重命名（跨盘自动处理）',
    '  - fsx_delete  删除：四道安全闸（confirm/recursive/受保护路径/dryRun），默认拒绝，且绝不删除系统目录/主目录/盘符根',
    '安全约定：fsx_delete 默认拒绝删除，需 confirm=true；删除目录需 recursive=true；受保护路径（盘符根、用户主目录、Windows/Program Files/ProgramData 等）一律拒绝。'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Fsx MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 FSX_PORT 指定其他端口。`);
  }
  process.exit(1);
});
