'use strict';
/**
 * 工具注册表：汇总所有工具的定义（名称、描述、参数 Schema）与执行入口
 */
const findFiles = require('./find-files');
const findRecent = require('./find-recent');
const findInFiles = require('./find-in-files');
const findTool = require('./find-tool');

const TOOLS = [
  {
    name: 'find_files',
    title: '本机文件搜索',
    description: '按文件名/路径搜索整台电脑的文件（Everything 风格，基于预建索引秒回）。支持四种模式：sub 子串（默认）、fuzzy 模糊、glob 通配（*.sln / **/*.test.js）、regex 正则；评分排序（文件名精确=100 > 开头=80 > 包含=60 > 路径=30 > 模糊=20），同分按修改时间新→旧。可过滤扩展名/类型/根目录，支持翻页。索引默认跳过 AppData、Windows、Program Files、node_modules、.git 等噪声目录。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '文件名或路径关键词（如 "mcp-server"、"*.sln"、"TentacleTool"）' },
        mode: { type: 'string', enum: ['sub', 'fuzzy', 'glob', 'regex'], description: 'sub=子串（默认），fuzzy=字符按序模糊，glob=通配符（** 跨目录 * 单段 ? 单字符），regex=正则' },
        ext: { type: 'string', description: '扩展名过滤，逗号分隔（如 "js,ts" 或 ".md"）' },
        root: { type: 'string', description: '限定搜索的根目录（如 "C:\\\\Users\\\\me\\\\projects"），加快且结果更准' },
        type: { type: 'string', enum: ['file', 'dir'], description: '只要文件或只要目录（默认都要）' },
        limit: { type: 'number', description: '返回条数（默认 30，上限 200）' },
        offset: { type: 'number', description: '翻页偏移（配合返回值中的翻页提示使用）' },
        refresh: { type: 'boolean', description: '强制重建索引（默认 false，索引 6 小时 TTL 自动过期）' }
      },
      required: ['query']
    },
    run: findFiles.run
  },
  {
    name: 'find_recent',
    title: '最近修改的文件',
    description: '列出最近修改的文件/目录（按索引 mtime 排序，新→旧）。默认近 24 小时，within 支持 "30m"/"2h"/"7d"/"4w" 或小时数。适合"我刚改过的那个文件叫什么来着"、"这个项目最近动了哪些东西"类问题。',
    inputSchema: {
      type: 'object',
      properties: {
        within: { type: 'string', description: '时间窗："30m"/"2h"/"7d"/"4w"，或纯数字按小时（默认 "24h"）' },
        root: { type: 'string', description: '限定根目录（强烈建议指定到项目级别）' },
        ext: { type: 'string', description: '扩展名过滤，逗号分隔（如 "js,md"）' },
        type: { type: 'string', enum: ['file', 'dir'], description: '只要文件或只要目录（默认都要）' },
        limit: { type: 'number', description: '返回条数（默认 30，上限 200）' },
        offset: { type: 'number', description: '翻页偏移' },
        refresh: { type: 'boolean', description: '强制重建索引' }
      }
    },
    run: findRecent.run
  },
  {
    name: 'find_in_files',
    title: '文件内容搜索',
    description: '在文件内容里搜索关键词或正则（grep 风格，带行号与命中行片段）。只扫文本类扩展名白名单（代码/配置/文档等），单文件 ≤1MB，二进制自动跳过；每文件最多 5 处、总计默认 50 处、最多扫 4000 个候选、10 秒时间预算，候选按修改时间新→旧优先。强烈建议配合 root 收窄到项目目录。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '内容关键词，或正则（mode="regex" 时）' },
        mode: { type: 'string', enum: ['sub', 'regex'], description: 'sub=子串（默认），regex=正则' },
        caseSensitive: { type: 'boolean', description: '是否区分大小写（默认 false）' },
        root: { type: 'string', description: '限定根目录（强烈建议，如项目目录）' },
        ext: { type: 'string', description: '扩展名过滤，逗号分隔；不填则用内置文本类白名单' },
        perFile: { type: 'number', description: '每文件最多显示命中数（默认 5，上限 20）' },
        limit: { type: 'number', description: '总命中上限（默认 50，上限 200）' },
        maxFileSize: { type: 'number', description: '单文件大小上限字节（默认 1MB，最大 5MB）' },
        refresh: { type: 'boolean', description: '强制重建索引' }
      },
      required: ['query']
    },
    run: findInFiles.run
  },
  {
    name: 'find_tool',
    title: '可执行工具定位',
    description: '定位本机可执行工具的绝对路径（"AI 要调用某个工具，先找到它在哪"）。先扫 PATH（PATHEXT 逐目录探测，第一个命中即主命令），再在全盘索引里兜底找 exe/bat/cmd/ps1/msc/lnk（不在 PATH 的工具）。返回可直接调用的绝对路径。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工具名（如 "node"、"git"、"code"），不要带路径' },
        all: { type: 'boolean', description: '返回全部命中（默认 false 只给主命令 + 少量备用）' }
      },
      required: ['name']
    },
    run: findTool.run
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
