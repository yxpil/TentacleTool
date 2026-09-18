'use strict';
/**
 * 工具注册表：汇总 9 个工具的定义与执行入口
 *
 * 契约（与其它工具集一致）：
 *   - 每个工具导出 { name, title, description, inputSchema, run(args) }
 *   - run 返回值里若含 _text，则作为给 Agent 的纯文本正文；其余字段作为结构化结果。
 *   - executeTool 拆成 { text, structured }，由 server.js 分别放进 content[0].text 与 structuredContent。
 */
const hash = require('./cryptox-hash');
const hmac = require('./cryptox-hmac');
const checksum = require('./cryptox-checksum');
const encode = require('./cryptox-encode');
const decode = require('./cryptox-decode');
const jwt = require('./cryptox-jwt');
const uuid = require('./cryptox-uuid');
const password = require('./cryptox-password');
const cipher = require('./cryptox-cipher');

const TOOLS = [hash, hmac, checksum, encode, decode, jwt, uuid, password, cipher];

/** 转换成 MCP tools/list 返回格式（只映射契约字段，避免把执行体或内部函数暴露出去） */
function toMcpTools() {
  return TOOLS.map(t => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

function getTool(name) {
  return TOOLS.find(t => t.name === name) || null;
}

async function executeTool(name, args) {
  const tool = getTool(name);
  if (!tool) {
    const names = TOOLS.map(t => t.name).join(', ');
    throw new Error(`未知工具 "${name}"。可用工具：${names}`);
  }
  const result = await tool.run(args || {});
  let text, structured;
  if (result && typeof result === 'object' && typeof result._text === 'string') {
    text = result._text;
    const { _text, ...rest } = result;
    structured = rest;
  } else if (typeof result === 'string') {
    text = result;
    structured = { result };
  } else {
    text = JSON.stringify(result, null, 2);
    structured = result;
  }
  return { text, structured };
}

module.exports = { TOOLS, toMcpTools, getTool, executeTool };
