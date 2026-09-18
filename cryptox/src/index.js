'use strict';
/**
 * Cryptox MCP Server 入口
 * 哈希与编码工具集：哈希 / HMAC / 编解码 / JWT 解析 / UUID 与密码生成 / 文件校验和 / AES-256-GCM 加解密
 * 协议：MCP Streamable HTTP (2025-03-26)，零依赖（node:crypto / fs / path）
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
logger.log('[boot] Cryptox MCP Server starting, pid=' + process.pid + ', node=' + process.version + ', cwd=' + process.cwd());

const PORT = parseInt(process.env.CRYPTOX_PORT || process.env.PORT || '8353', 10);
const HOST = process.env.CRYPTOX_HOST || '127.0.0.1';

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'cryptox',
  serverVersion: '1.0.0',
  instructions: [
    'Cryptox - 哈希与编码 MCP 服务器（零依赖，Streamable HTTP 协议）',
    '可用工具：',
    '  - cryptox_hash      哈希：文本或文件；算法 md5/sha1/sha256/sha384/sha512/sha3-256/sha3-512/blake2b512/blake2s256；输出 hex 或 base64',
    '  - cryptox_hmac      HMAC 签名与校验（恒定时间比较），算法集同 hash',
    '  - cryptox_encode    编码：base64 / base64url / hex / url 组件 / querystring / HTML 实体 / Unicode 转义',
    '  - cryptox_decode    解码：以上各项的反向，容错明确（不会静默返回原文）',
    '  - cryptox_jwt       解析 JWT 的 header/payload，exp/iat/nbf 转人类可读并标注是否过期；可选验证 HS256/HS384/HS512',
    '  - cryptox_uuid      生成 uuid v4 / uuid v7 / 短 ID，或校验已有 UUID 的版本与合法性',
    '  - cryptox_password  密码生成（长度 / 字符集 / 排除易混字符）与强度评估（熵 bits + 弱口令模式检测）',
    '  - cryptox_checksum  文件校验和：单文件或目录递归，可与期望值比对',
    '  - cryptox_cipher    AES-256-GCM 加解密，PBKDF2-SHA256 或 scrypt 派生密钥，密文为自描述 base64 封套',
    '安全约定：本工具集是计算工具，不是密码管理器；密钥与明文绝不写入日志或结构化输出。'
  ].join('\n')
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭 Cryptox MCP Server...');
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
    console.error(`端口 ${PORT} 已被占用，可用环境变量 CRYPTOX_PORT 指定其他端口。`);
  }
  process.exit(1);
});
