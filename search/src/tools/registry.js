'use strict';
/**
 * 工具注册表：汇总所有工具的定义（名称、描述、参数 Schema）与执行入口
 */
const webSearch = require('./web-search');
const searchDetail = require('./search-detail');
const searchSuggest = require('./search-suggest');

const TOOLS = [
  {
    name: 'web_search',
    title: '聚合搜索',
    description: '聚合必应/百度/DuckDuckGo 的网页搜索。返回折叠摘要（序号+标题链接+短摘要），多引擎并行请求、轮询交错合并、URL 去重，专为节省 Agent 上下文设计。支持 page/pageSize 翻页、snippetLen 控制摘要长度（0 可关闭）。找到目标后用 search_detail 展开全文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        engines: { type: 'array', items: { type: 'string', enum: ['bing', 'baidu', 'duckduckgo'] }, description: '引擎列表，默认 [bing, baidu]；duckduckgo 在部分网络不可达' },
        page: { type: 'number', description: '页码，从 1 开始（默认 1）' },
        pageSize: { type: 'number', description: '每页条数 1-30（默认 10）' },
        snippetLen: { type: 'number', description: '每条摘要字符数 0-300（默认 120，0 关闭摘要进一步省上下文）' },
        timeout: { type: 'number', description: '单引擎超时毫秒（默认 15000）' }
      },
      required: ['query']
    },
    run: webSearch.run
  },
  {
    name: 'search_detail',
    title: '展开搜索结果全文',
    description: '抓取 web_search 结果中的某个链接，转换为 Markdown 全文。默认只返回前 8000 字符（正文模式+无图片）保护上下文，被截断时会给出续读参数提示。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '结果链接（来自 web_search 返回）' },
        maxLength: { type: 'number', description: '返回 Markdown 最大字符数（默认 8000，上限 50000）' },
        mode: { type: 'string', enum: ['content', 'full'], description: 'content=正文模式（默认，去噪），full=完整模式' },
        includeImages: { type: 'boolean', description: '是否保留图片（默认 false）' },
        includeLinks: { type: 'boolean', description: '是否保留链接（默认 true）' },
        timeout: { type: 'number', description: '抓取超时毫秒（默认 20000）' }
      },
      required: ['url']
    },
    run: searchDetail.run
  },
  {
    name: 'search_suggest',
    title: '搜索词联想',
    description: '获取必应+百度的搜索联想词（无需 API Key），用于改写、纠错、扩展查询。多个候选词合并去重返回。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询词前缀' },
        engines: { type: 'array', items: { type: 'string', enum: ['bing', 'baidu'] }, description: '联想引擎，默认 [bing, baidu]' },
        limit: { type: 'number', description: '每个引擎最多返回条数（默认 8）' },
        timeout: { type: 'number', description: '超时毫秒（默认 8000）' }
      },
      required: ['query']
    },
    run: searchSuggest.run
  }
];

/** 转换成 MCP tools/list 返回格式 */
function toMcpTools() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

async function executeTool(name, args) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    throw new Error('未知工具: ' + name);
  }
  const result = await tool.run(args || {});
  return result;
}

module.exports = { TOOLS, toMcpTools, executeTool };
