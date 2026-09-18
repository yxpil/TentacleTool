'use strict';
/**
 * MCP Streamable HTTP 服务器（零依赖，Node 原生 http 实现）
 *
 * 遵循 MCP Specification (2025-03-26) 的 Streamable HTTP 传输：
 *  - POST /：JSON-RPC 请求 -> application/json 响应（或 text/event-stream 流式响应）
 *  - GET /：SSE 事件流（服务器主动推送）
 *  - Mcp-Session-Id 会话管理
 *  - 支持 initialize / notifications/initialized / ping / tools/list / tools/call
 *
 * ★ tools/call 按 { text, structured } 契约取值：
 *   executeTool 返回的 text 放进 content[0].text，structured 放进 structuredContent，
 *   绝不把整个返回值 JSON.stringify 进 content（否则 _text 的精心排版全白做）。
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { toMcpTools, executeTool } = require('../tools/registry');
const logger = require('../utils/logger');

const PROTOCOL_VERSION = '2025-03-26';

class McpStreamableHttpServer {
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.host = options.host || '127.0.0.1';
    this.serverName = options.serverName || 'gitx-mcp';
    this.serverVersion = options.serverVersion || '1.0.0';
    this.instructions = options.instructions || 'Gitx Git 仓库操作工具集';

    this.sessions = new Map();
    this.sseClients = new Map();

    this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));
  }

  /* ======================== HTTP 入口 ======================== */

  async handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      this.writeCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    logger.request(req, '[http-in]');

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (e) {
      logger.error('[bad-url] ' + req.method + ' ' + req.url, e);
      this.jsonResponse(res, { jsonrpc: '2.0', error: { code: -32603, message: 'Bad request URL: ' + e.message }, id: null }, 400);
      return;
    }
    const sessionId = this.extractSessionId(req);

    if (sessionId && this.sessions.has(sessionId)) {
      this.sessions.get(sessionId).lastSeen = Date.now();
    }

    try {
      if (req.method === 'GET') {
        await this.handleGet(req, res, url, sessionId);
      } else if (req.method === 'POST') {
        await this.handlePost(req, res, url, sessionId);
      } else {
        this.writeCorsHeaders(res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Method Not Allowed: ' + req.method }, id: null }));
      }
    } catch (e) {
      logger.error('[http-handler-error] ' + req.method + ' ' + req.url, e);
      this.writeCorsHeaders(res);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error: ' + e.message }, id: null }));
    }
  }

  /** GET：SSE 事件流（服务器推送通道） */
  async handleGet(req, res, url, sessionId) {
    let sid = sessionId;
    if (!sid || !this.sessions.has(sid)) {
      sid = this.createSession();
    }

    this.writeCorsHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Mcp-Session-Id': sid
    });
    res.write(': connected\n\n');

    if (!this.sseClients.has(sid)) this.sseClients.set(sid, new Set());
    this.sseClients.get(sid).add(res);

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) {}
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      const set = this.sseClients.get(sid);
      if (set) { set.delete(res); if (set.size === 0) this.sseClients.delete(sid); }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  /** POST：JSON-RPC 请求处理 */
  async handlePost(req, res, url, sessionId) {
    const body = await this.readBody(req);
    if (!body) {
      this.jsonResponse(res, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: empty body' }, id: null }, 400);
      return;
    }

    let message;
    try {
      message = JSON.parse(body);
    } catch (e) {
      logger.error('[rpc-parse-error] body=' + body.slice(0, 200), e);
      this.jsonResponse(res, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON' }, id: null }, 400);
      return;
    }

    try {
      if (message && message.method) {
        const extra = message.method === 'tools/call'
          ? ' params=' + JSON.stringify(message.params || {}).slice(0, 300)
          : '';
        logger.log('[rpc-in] method=' + message.method + ' id=' + message.id + ' session=' + String(sessionId || '').slice(0, 12) + ' bodyLen=' + body.length + extra);
      }
    } catch (e) {}

    const acceptHeader = (req.headers['accept'] || '').toLowerCase();
    const prefersStream = acceptHeader.includes('text/event-stream');

    let sid = sessionId;
    if (message.method === 'initialize') {
      if (!sid || !this.sessions.has(sid)) {
        sid = this.createSession();
      }
    } else if (sid && this.sessions.has(sid)) {
      this.sessions.get(sid).lastSeen = Date.now();
    } else if (message.method !== 'notifications/initialized' && message.method !== 'ping') {
      sid = this.createSession();
    }

    const result = await this.processMessage(message, sid);

    if (result === null || message.id === undefined || message.id === null) {
      this.writeCorsHeaders(res);
      res.writeHead(202, { 'Mcp-Session-Id': sid, 'Content-Length': '0' });
      res.end();
      return;
    }

    const isLongRunning = message.method === 'tools/call';
    if (prefersStream && isLongRunning) {
      this.writeCorsHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Mcp-Session-Id': sid
      });
      res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      res.end();
    } else {
      this.writeCorsHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sid
      });
      res.end(JSON.stringify(result));
    }
  }

  /* ======================== JSON-RPC 处理 ======================== */

  async processMessage(message, sessionId) {
    const { method, params, id } = message;

    if (method === 'notifications/initialized') return null;
    if (method === 'notifications/cancelled') return null;
    if (method === 'notifications/progress') return null;

    switch (method) {
      case 'initialize':
        logger.log('[rpc] initialize params=' + JSON.stringify(params || {}).slice(0, 200));
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false }, logging: {} },
            serverInfo: { name: this.serverName, version: this.serverVersion },
            instructions: this.instructions
          }
        };

      case 'ping':
        return { jsonrpc: '2.0', id: id ?? null, result: {} };

      case 'tools/list':
        logger.log('[rpc] tools/list called');
        return { jsonrpc: '2.0', id: id ?? null, result: { tools: toMcpTools() } };

      case 'tools/call': {
        const toolName = params && params.name;
        const args = (params && params.arguments) || {};
        logger.log('[tools/call] name=' + toolName + ' args=' + JSON.stringify(args).slice(0, 400));
        if (!toolName) {
          logger.error('[tools/call] missing name, params=' + JSON.stringify(params || {}).slice(0, 200));
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: { code: -32602, message: 'tools/call 缺少 name 参数' }
          };
        }
        try {
          const start = Date.now();
          const output = await executeTool(toolName, args);
          const durationMs = Date.now() - start;
          logger.log('[tools/call:ok] name=' + toolName + ' took=' + durationMs + 'ms');

          // ★ 契约：executeTool 返回 { text, structured }
          let text, structured;
          if (typeof output === 'string') {
            text = output;
            structured = { result: output };
          } else if (output && typeof output === 'object' && typeof output.text === 'string') {
            text = output.text;
            structured = output.structured;
          } else {
            text = JSON.stringify(output, null, 2);
            structured = output;
          }
          const result = {
            content: [{ type: 'text', text }],
            isError: false,
            _meta: { durationMs, tool: toolName }
          };
          if (structured && typeof structured === 'object') result.structuredContent = structured;
          return { jsonrpc: '2.0', id: id ?? null, result };
        } catch (e) {
          logger.error('[tools/call:error] name=' + toolName, e);
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: {
              content: [{ type: 'text', text: '工具执行失败: ' + e.message }],
              isError: true
            }
          };
        }
      }

      case 'resources/list':
        return { jsonrpc: '2.0', id: id ?? null, result: { resources: [] } };

      case 'prompts/list':
        return { jsonrpc: '2.0', id: id ?? null, result: { prompts: [] } };

      case 'logging/setLevel':
        return { jsonrpc: '2.0', id: id ?? null, result: {} };

      default:
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32601, message: 'Method not found: ' + method }
        };
    }
  }

  /* ======================== 辅助方法 ======================== */

  createSession() {
    const sid = crypto.randomBytes(16).toString('hex');
    this.sessions.set(sid, { createdAt: Date.now(), lastSeen: Date.now(), clientInfo: null });
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of this.sessions) {
      if (v.lastSeen < cutoff) this.sessions.delete(k);
    }
    return sid;
  }

  extractSessionId(req) {
    const h = req.headers['mcp-session-id'];
    if (h) return String(h).trim();
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('sessionId');
    return q ? String(q).trim() : null;
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        chunks.push(c);
        size += c.length;
        if (size > 10 * 1024 * 1024) {
          reject(new Error('请求体过大'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  writeCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Authorization, Origin, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  }

  jsonResponse(res, obj, statusCode = 200) {
    this.writeCorsHeaders(res);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  /* ======================== 生命周期 ======================== */

  start() {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', (err) => {
        logger.error('[start-failed] port=' + this.port + ' host=' + this.host, err);
        reject(err);
      });
      this.httpServer.listen(this.port, this.host, () => {
        logger.log('[started] listening on http://' + this.host + ':' + this.port + ' pid=' + process.pid);
        console.log('==============================================');
        console.log('  Gitx MCP Server (Git 仓库操作)');
        console.log('----------------------------------------------');
        console.log(`  Endpoint   : http://${this.host}:${this.port}/`);
        console.log(`  SSE Stream : http://${this.host}:${this.port}/ (GET)`);
        console.log(`  Protocol   : MCP ${PROTOCOL_VERSION}`);
        console.log(`  Tools      : ${toMcpTools().map(t => t.name).join(', ')}`);
        console.log('----------------------------------------------');
        console.log(`  客户端配置示例: { "url": "http://${this.host}:${this.port}/" }`);
        console.log('==============================================');
        resolve();
      });
    });
  }

  stop() {
    logger.log('[stop] closing http server');
    return new Promise(resolve => {
      this.httpServer.close(() => {
        logger.log('[stopped] http server closed');
        resolve();
      });
    });
  }
}

module.exports = { McpStreamableHttpServer, PROTOCOL_VERSION };
