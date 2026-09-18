'use strict';
/**
 * 工具注册表：汇总所有工具的定义（名称、描述、参数 Schema）与执行入口
 */
const webToMd = require('./web-to-md');
const htmlToMdTool = require('./html-to-md-tool');
const webLinks = require('./web-links');
const webMeta = require('./web-meta');

const TOOLS = [
  {
    name: 'web_to_md',
    title: '网页转 Markdown',
    description: '抓取指定网页并转换为干净的 Markdown。content 模式自动去除导航/广告/页脚等噪声并定位正文主块（默认），full 模式保留全部可见内容。支持标题、列表、表格、代码块、引用、链接、图片等元素。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标网页地址（http/https，可省略协议头）' },
        mode: { type: 'string', enum: ['content', 'full'], description: 'content=正文模式（默认，智能去噪），full=完整模式' },
        includeImages: { type: 'boolean', description: '是否保留图片（默认 true）' },
        includeLinks: { type: 'boolean', description: '是否保留链接（默认 true）' },
        includeTitle: { type: 'boolean', description: '是否在文首插入 # 文档标题（默认 true）' },
        maxLength: { type: 'number', description: '返回 Markdown 最大字符数（默认 60000，超出截断）' },
        timeout: { type: 'number', description: '抓取超时毫秒（默认 20000）' }
      },
      required: ['url']
    },
    run: webToMd.run
  },
  {
    name: 'html_to_md',
    title: 'HTML 转 Markdown',
    description: '将已有的 HTML 源码字符串直接转换为 Markdown，不发起网络请求。适合客户端已拿到 HTML（如邮件正文、编辑器内容、上一步抓取结果）的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'HTML 源码字符串' },
        baseUrl: { type: 'string', description: '可选：基准 URL，用于把相对链接/图片地址解析为绝对地址' },
        mode: { type: 'string', enum: ['content', 'full'], description: 'content=正文模式（默认），full=完整模式' },
        includeImages: { type: 'boolean', description: '是否保留图片（默认 true）' },
        includeLinks: { type: 'boolean', description: '是否保留链接（默认 true）' },
        includeTitle: { type: 'boolean', description: '是否在文首插入 # 文档标题（默认 true）' }
      },
      required: ['html']
    },
    run: htmlToMdTool.run
  },
  {
    name: 'web_links',
    title: '网页链接提取',
    description: '抓取网页并提取全部超链接：相对路径自动转绝对地址、去重、输出 Markdown 链接清单与域名分布统计。可选只保留同源链接。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标网页地址' },
        sameOriginOnly: { type: 'boolean', description: '是否只保留与页面同源的链接（默认 false）' },
        limit: { type: 'number', description: '最多返回链接数（默认 200，上限 2000）' },
        timeout: { type: 'number', description: '抓取超时毫秒（默认 20000）' }
      },
      required: ['url']
    },
    run: webLinks.run
  },
  {
    name: 'web_meta',
    title: '网页元信息提取',
    description: '抓取网页并提取元信息：标题、语言、canonical、description/keywords、OpenGraph/Twitter 卡片、favicon，以及页面统计（标题/段落/图片/链接/表格数量、字数、预计阅读时长）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标网页地址' },
        timeout: { type: 'number', description: '抓取超时毫秒（默认 20000）' }
      },
      required: ['url']
    },
    run: webMeta.run
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
