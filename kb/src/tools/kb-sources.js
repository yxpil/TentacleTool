'use strict';
/**
 * kb_sources —— 列出可用的数据源与知识库
 *
 * 这是 Agent 的入口工具：先看有什么，再决定查什么。
 * 输出刻意精简（只给名字、表数、连通性），细节交给 kb_schema。
 */

const rt = require('../kb/runtime');
const fmt = require('./format');

const name = 'kb_sources';
const title = 'List knowledge bases';
const description =
  '列出已配置的知识库（knowledge base）及其包含的表，以及各 MySQL 数据源的连通性。' +
  '开始任何数据库相关任务前先调用它，确认有哪些知识库可用、各自包含哪些表。' +
  '可选参数 probe=false 跳过连通性探测（更快）；verbose=true 显示每张表的描述。';

const inputSchema = {
  type: 'object',
  properties: {
    probe: {
      type: 'boolean',
      description: '是否探测各数据源连通性（会实际连库，默认 true）',
      default: true
    },
    verbose: {
      type: 'boolean',
      description: '是否列出每张表的描述与限定名，默认 false 只给表名和数量',
      default: false
    },
    knowledgeBase: {
      type: 'string',
      description: '只看某一个知识库的详情'
    }
  },
  additionalProperties: false
};

async function run(args = {}) {
  const s = rt.peek();

  /* ---- 未配置：给出清晰的配置指引，而不是报错崩掉 ---- */
  if (!s.loaded) {
    const text = [
      '知识库尚未配置。',
      '',
      (s.error ? s.error.message : ''),
      '',
      '配置方式（任选一种）：',
      '  1) 复制 kb.config.example.json 为 kb.config.json，填好 sources 与 knowledgeBases',
      '  2) 设置环境变量 KB_CONFIG=<配置文件绝对路径>',
      '  3) 设置环境变量 KB_MYSQL_URL=mysql://user:password@host:3306/dbname 快速试用',
      '',
      '配置好后调用 kb_config(refresh=true) 重新加载。'
    ].join('\n');
    return { configured: false, error: s.error ? s.error.message : null, _text: text };
  }

  const { config, configPath, warnings } = s;
  const probe = args.probe !== false;

  /* ---- 数据源 ---- */
  const sourceRows = [];
  for (const [sname, src] of Object.entries(config.sources)) {
    let status = '—';
    let version = '';
    if (probe) {
      const p = await s.pools.probe(sname);
      status = p.ok ? '✅ 连通' : '❌ ' + (p.error || '失败');
      version = p.ok ? (p.version || '') : '';
      if (!p.ok && version === '') version = 'code=' + (p.code || '?');
    }
    sourceRows.push([
      sname,
      `${src.host}:${src.port}`,
      src.user,
      src.database || '(未指定)',
      src.readOnly ? '只读' : '可写',
      status + (version ? ' ' + version : '')
    ]);
  }

  /* ---- 知识库 ---- */
  const kbs = args.knowledgeBase
    ? Object.keys(config.knowledgeBases).filter(k => k === args.knowledgeBase)
    : Object.keys(config.knowledgeBases);

  if (args.knowledgeBase && kbs.length === 0) {
    return {
      configured: true,
      error: 'knowledge base not found',
      _text: `未找到知识库 "${args.knowledgeBase}"。可用的有：\n  ` +
        Object.keys(config.knowledgeBases).join('\n  ')
    };
  }

  let text = '';
  text += `已配置 ${Object.keys(config.sources).length} 个数据源、` +
    `${Object.keys(config.knowledgeBases).length} 个知识库`;
  text += `\n配置来源：${configPath}`;
  if (warnings.length) {
    text += '\n\n⚠️ 配置警告：\n  ' + warnings.join('\n  ');
  }

  text += fmt.section('数据源');
  text += '\n' + fmt.table(
    ['名称', '地址', '用户', '默认库', '权限', probe ? '连通性' : '（未探测）'],
    sourceRows,
    { colMax: 48 }
  );

  text += fmt.section('知识库');
  const kbRows = [];
  for (const k of kbs) {
    const kb = config.knowledgeBases[k];
    const auto = kb.autoWholeDatabase ? '（整库自动展开）' : '';
    kbRows.push([
      k,
      kb.tables.length || (kb.autoWholeDatabase ? '整库' : 0),
      kb.description || kb.label || '',
      auto
    ]);
  }
  text += '\n' + fmt.table(['知识库', '表数', '说明', ''], kbRows, { colMax: 40 });

  if (args.verbose) {
    for (const k of kbs) {
      const kb = config.knowledgeBases[k];
      if (!kb.tables.length) continue;
      text += fmt.section(`知识库「${k}」的表`);
      text += '\n' + fmt.list(kb.tables.map(t =>
        '`' + (t.database ? t.database + '.' : '') + t.table + '`' +
        (t.label ? ' — ' + t.label : '') +
        (t.description ? ' — ' + t.description : '') +
        (t.where ? `  [过滤: ${t.where}]` : '') +
        (t.columns ? `  [只暴露列: ${t.columns.join(',')}]` : '') +
        (t.redact ? `  [打码列: ${t.redact.join(',')}]` : '')
      ));
    }
  }

  text += '\n\n下一步：kb_schema(knowledgeBase="<名字>") 看表结构；' +
    'kb_search(query="关键词") 跨表搜索内容。';

  return {
    configured: true,
    configPath,
    warnings,
    warningsText: warnings.join('; '),
    sources: Object.entries(config.sources).map(([k, v]) => ({
      name: k, host: v.host, port: v.port, user: v.user,
      database: v.database || null, readOnly: v.readOnly
    })),
    knowledgeBases: kbs.map(k => ({
      name: k,
      description: config.knowledgeBases[k].description || '',
      tableCount: config.knowledgeBases[k].tables.length,
      tableNames: config.knowledgeBases[k].tables.map(t =>
        (t.database ? t.database + '.' : '') + t.table),
      autoWholeDatabase: !!config.knowledgeBases[k].autoWholeDatabase
    })),
    _text: text
  };
}

module.exports = { name, title, description, inputSchema, run };
