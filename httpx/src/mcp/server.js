'use strict';
/**
 * MCP Streamable HTTP 服务器（零依赖，Node 原生 http 实现）
 *
 * 遵循 MCP Specification (2025-03-26) 的 Streamable HTTP 传输。
 * 工具结果按 { text, structured } 契约分别写入 content[0].text 与 structuredContent。
 * 认证相关字段（auth.token / auth.password / Authorization 头）在日志中一律脱敏。
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { toMcpTools, executeTool } = require('../tools/registry');
const logger = require('../utils/logger');

const PROTOCOL_VERSION = '2025-03-26';

/** 深拷贝并对认证字段脱敏，避免口令进入日志 */
function redactArgs(args) {
  if (args == null) return args;
  if (Array.isArray(args)) return args.map(redactArgs);
  if (typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    const lk = k.toLowerCase();
    if (lk === 'auth' && v && typeof v === 'object') {
      out[k] = { type: v.type || '?', redacted: true };
    } else if ((lk === 'token' || lk === 'password' || lk === 'authorization') && typeof v === 'string') {
      out[k] = '<redacted>';
    } else if (v && typeof v === 'object') {
      out[k] = redactArgs(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

class McpStreamableHttpServer {
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.host = options.host || '127.0.0.1';
    this.serverName = options.serverName || 'httpx-mcp';
    this.serverVersion = options.serverVersion || '1.0.0';
    this.instructions = options.instructions || 'Httpx HTTP 客户端工具集';

    this.sessions = new Map();
    this.sseClients = new Map();

    this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));
  }

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

  async handleGet(req, res, url, sessionId) {
    let sid = sessionId;
    if (!sid || !this.sessions.has(sid)) sid = this.createSession();
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
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
    const cleanup = () => {
      clearInterval(heartbeat);
      const set = this.sseClients.get(sid);
      if (set) { set.delete(res); if (set.size === 0) this.sseClients.delete(sid); }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  async handlePost(req, res, url, sessionId) {
    const body = await this.readBody(req);
    if (!body) {
      this.jsonResponse(res, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: empty body' }, id: null }, 400);
      return;
    }
    let message;
    try { message = JSON.parse(body); }
    catch (e) {
      logger.error('[rpc-parse-error] body=' + body.slice(0, 200), e);
      this.jsonResponse(res, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON' }, id: null }, 400);
      return;
    }

    try {
      if (message && message.method) {
        const extra = message.method === 'tools/call'
          ? ' params=' + JSON.stringify(redactArgs(message.params || {})).slice(0, 300)
          : '';
        logger.log('[rpc-in] method=' + message.method + ' id=' + message.id + ' session=' + String(sessionId || '').slice(0, 12) + ' bodyLen=' + body.length + extra);
      }
    } catch (e) {}

    const acceptHeader = (req.headers['accept'] || '').toLowerCase();
    const prefersStream = acceptHeader.includes('text/event-stream');

    let sid = sessionId;
    if (message.method === 'initialize') {
      if (!sid || !this.sessions.has(sid)) sid = this.createSession();
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
        logger.log('[tools/call] name=' + toolName + ' args=' + JSON.stringify(redactArgs(args)).slice(0, 400));
        if (!toolName) {
          logger.error('[tools/call] missing name, params=' + JSON.stringify(params || {}).slice(0, 200));
          return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: 'tools/call 缺少 name 参数' } };
        }
        try {
          const start = Date.now();
          const output = await executeTool(toolName, args);
          logger.log('[tools/call:ok] name=' + toolName + ' took=' + (Date.now() - start) + 'ms');
          const durationMs = Date.now() - start;
          // output 为 { text, structured }
          let text = output.text, structured = output.structured;
          if (typeof text !== 'string') {
            text = JSON.stringify(text, null, 2);
            structured = text === undefined ? {} : structured;
          }
          const isError = !!(structured && structured.isError);
          const result = {
            content: [{ type: 'text', text }],
            isError,
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
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: 'Method not found: ' + method } };
    }
  }

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
        if (size > 10 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
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

  start() {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', (err) => {
        logger.error('[start-failed] port=' + this.port + ' host=' + this.host, err);
        reject(err);
      });
      this.httpServer.listen(this.port, this.host, () => {
        logger.log('[started] listening on http://' + this.host + ':' + this.port + ' pid=' + process.pid);
        console.log('==============================================');
        console.log('  Httpx MCP Server (HTTP 客户端)');
        console.log('----------------------------------------------');
        console.log(`  Endpoint   : http://${this.host}:${this.port}/`);
        console.log(`  SSE Stream : http://${this.host}:${this.port}/ (GET)`);
        console.log(`  Protocol   : MCP ${PROTOCOL_VERSION}`);
        console.log(`  Tools      : ${toMcpTools().map(t => t.name).join(', ')}`);
        console.log('----------------------------------------------');
        console.log(`    "url": "http://${this.host}:${this.port}/"`);
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
