'use strict';
/**
 * Gitx MCP Server 入口
 * Git 仓库操作工具集：状态 / 日志 / 差异 / 查看 / blame / 文件历史 / 分支 / stash / remote / 提交
 * 协议：MCP Streamable HTTP (2025-03-26)，零依赖（child_process / fs / path）
 *
 * ★ 安全边界：本工具集刻意不做 push / force push / reset --hard / clean -fdx / rebase
 *   等改写历史或破坏工作区的操作——这些交给用户自己在终端完成。详见 README。
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
logger.log('[boot] Gitx MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

// ★ 端口兜底必须是 8351（不能是 3000）
const PORT = parseInt(process.env.GITX_PORT || process.env.PORT || '8351', 10);
const HOST = process.env.GITX_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'gitx',
  serverVersion: '1.0.0',
  instructions: [
    'Gitx - Git 仓库操作 MCP 服务器（零依赖，Streamable HTTP 协议）',
    '可用工具（默认作用于你显式传入的 repoPath，未传则用当前工作目录）：',
    '  - gitx_status        工作区状态：当前分支、暂存/未暂存/未跟踪变更、领先/落后、最近提交',
    '  - gitx_log           提交历史：limit、作者/日期/路径过滤、oneline 或详细模式、含文件统计',
    '  - gitx_diff          差异：工作区/暂存区/两提交间比较、stat 模式、路径过滤、限制输出',
    '  - gitx_show          查看某提交详情，或某文件在某提交时的内容',
    '  - gitx_blame         逐行归属：文件 + 可选行范围，输出 行号/提交/作者/日期/内容',
    '  - gitx_file_history  单文件提交历史（含重命名跟踪 --follow）',
    '  - gitx_branch        列出/创建/切换/删除分支（★ 不能删当前分支；删未合并分支需 force=true）',
    '  - gitx_stash         list / save / pop / apply / drop（可逆操作）',
    '  - gitx_remote        远程列表、URL、跟踪关系；可选 fetch（只拉取不改工作区）',
    '  - gitx_commit        提交已暂存内容（必须显式 message；可选 addAll 先暂存全部）',
    '安全约定：本工具集只读与本地安全提交为主，刻意不做 push / force push / reset --hard / clean -fdx / rebase —— 改写历史或破坏工作区的操作请在你的终端完成。'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Gitx MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 GITX_PORT 指定其他端口。`);
  }
  process.exit(1);
});
