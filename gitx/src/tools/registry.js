'use strict';
/**
 * 工具注册表：汇总 10 个 git 工具的定义与执行入口
 *
 * 契约：
 *  - 每个工具导出 { name, title, description, inputSchema, run(args) }
 *  - run 返回值里若含 _text，则作为给 Agent 的纯文本正文；其余字段作为结构化结果。
 *  - executeTool 拆成 { text, structured }，由 server.js 分别放进 content[0].text 与 structuredContent。
 */
const status = require('./gitx-status');
const log = require('./gitx-log');
const diff = require('./gitx-diff');
const show = require('./gitx-show');
const blame = require('./gitx-blame');
const fileHistory = require('./gitx-file-history');
const branch = require('./gitx-branch');
const stash = require('./gitx-stash');
const remote = require('./gitx-remote');
const commit = require('./gitx-commit');

const TOOLS = [status, log, diff, show, blame, fileHistory, branch, stash, remote, commit];

/** 转换成 MCP tools/list 返回格式（不含 run，避免泄露执行体） */
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
  // 拆成 { text, structured }：_text 是给模型读的纯文本正文，其它字段是结构化结果
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
