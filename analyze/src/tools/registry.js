'use strict';
/**
 * 工具注册表：把各个工具声明汇总成 MCP 的 tools 列表，并负责派发调用。
 *
 * 契约（与其它工具集一致，改动会影响 server.js）：
 *   - 每个工具导出 { name, title, description, inputSchema, run(args) }
 *   - run 返回值里若含 _text 字段，则作为给 Agent 的纯文本正文；
 *     其余字段作为 structuredContent（机器可读的完整结果）。
 */

const build = require('./analyze-build');
const find = require('./analyze-find');
const refs = require('./analyze-refs');
const deps = require('./analyze-deps');
const callers = require('./analyze-callers');
const pathTool = require('./analyze-path');
const impact = require('./analyze-impact');
const stats = require('./analyze-stats');

const TOOLS = [
  build,
  find,
  refs,
  callers,
  deps,
  impact,
  pathTool,
  stats
];

/** 转成 MCP 协议的 tools 数组（去掉 run，它不外传） */
function toMcpTools() {
  return TOOLS.map(t => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

/** 按名字查工具 */
function getTool(name) {
  return TOOLS.find(t => t.name === name) || null;
}

/**
 * 执行工具
 * @returns {{ text: string, structured: object }}
 */
function executeTool(name, args) {
  const tool = getTool(name);
  if (!tool) {
    const names = TOOLS.map(t => t.name).join(', ');
    throw new Error(`未知工具 "${name}"。可用工具：${names}`);
  }
  const result = tool.run(args || {});
  const text = (result && result._text) ? result._text : JSON.stringify(result, null, 2);
  // _text 只是给模型看的正文，从结构化结果里摘掉，避免重复占空间
  let structured = result;
  if (result && typeof result === 'object' && '_text' in result) {
    const { _text, ...rest } = result;
    structured = rest;
  }
  return { text, structured };
}

module.exports = { TOOLS, toMcpTools, getTool, executeTool };
