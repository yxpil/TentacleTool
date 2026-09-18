'use strict';
/**
 * 工具注册表：汇总各工具声明成 MCP tools 列表，并派发调用。
 *
 * 契约（与其它工具集一致）：
 *   - 每个工具导出 { name, title, description, inputSchema, run(args) }
 *   - run 返回值里若含 _text，则作为给 Agent 的纯文本正文；
 *     其余字段作为结构化结果（机器可读）。
 *   - executeTool 拆成 { text, structured }，由 server.js 分别放进
 *     content[0].text 与 structuredContent。
 */

const parse = require('./jsonx-parse');
const convert = require('./jsonx-convert');
const query = require('./jsonx-query');
const schema = require('./jsonx-schema');
const diff = require('./jsonx-diff');
const aggregate = require('./jsonx-aggregate');

const TOOLS = [parse, convert, query, schema, diff, aggregate];

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
  const text = (result && typeof result === 'object' && typeof result._text === 'string')
    ? result._text
    : (typeof result === 'string' ? result : JSON.stringify(result, null, 2));

  let structured = result;
  if (result && typeof result === 'object' && '_text' in result) {
    const { _text, ...rest } = result;
    structured = rest;
  }
  return { text, structured };
}

module.exports = { TOOLS, toMcpTools, getTool, executeTool };
