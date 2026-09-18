'use strict';
/**
 * kb_config —— 诊断配置状态 / 重新加载配置
 *
 * 独立存在的理由：环境没配好时其它工具都会失败，
 * 这时 Agent（和用户）最需要的是"到底哪里没配好、该怎么配"，
 * 而不是一个笼统的报错。这个工具专门回答这个问题。
 */

const rt = require('../kb/runtime');
const { findConfigFile, safeSourceView } = require('../kb/config');
const fmt = require('./format');

const name = 'kb_config';
const title = 'Inspect / reload KB config';
const description =
  '查看知识库配置的加载状态：配置文件位置、已加载的数据源与知识库、配置警告、' +
  '以及每个数据源的连通性诊断。配置改完后调用 kb_config(refresh=true) 热重载，无需重启服务器。' +
  '当其它 kb_* 工具报"知识库尚未配置"时，用这个工具看到底缺什么。';

const inputSchema = {
  type: 'object',
  properties: {
    refresh: {
      type: 'boolean',
      description: '强制重新读取配置文件并重建连接池，默认 false',
      default: false
    },
    probe: {
      type: 'boolean',
      description: '是否实际连库探测每个数据源，默认 true',
      default: true
    },
    showExample: {
      type: 'boolean',
      description: '未配置时是否打印完整配置示例，默认 true',
      default: true
    }
  },
  additionalProperties: false
};

const EXAMPLE = `{
  "sources": {
    "local": {
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "你的密码",
      "database": "mydb",
      "readOnly": true
    }
  },
  "knowledgeBases": {
    "我的知识库": {
      "description": "这个知识库包含哪些表",
      "source": "local",
      "tables": [
        "mydb.articles",
        "mydb.comments",
        { "database": "mydb", "table": "users", "redact": ["password", "phone"] }
      ]
    }
  }
}`;

async function run(args = {}) {
  const wasLoaded = rt.peek().loaded;
  const s = args.refresh ? rt.reload() : rt.peek();

  /* ---------- 未配置 ---------- */
  if (!s.loaded) {
    let text = '❌ 知识库未配置\n';
    text += `\n原因：${s.error ? s.error.message : '未知'}`;

    const found = findConfigFile();
    text += `\n\n已查找的配置文件位置（按顺序）：`;
    text += `\n  1. 环境变量 KB_CONFIG（当前：${process.env.KB_CONFIG || '未设置'}）`;
    text += `\n  2. ${require('path').join(__dirname, '..', '..', 'kb.config.json')}`;
    text += `\n  3. ${require('path').join(__dirname, '..', '..', 'kb.config.local.json')}`;
    text += `\n  4. ${require('os').homedir()}/.kb.config.json`;
    text += `\n\n当前找到的配置文件：${found || '（无）'}`;
    text += `\n环境变量 KB_MYSQL_URL：${process.env.KB_MYSQL_URL ? '已设置' : '未设置'}`;

    if (args.showExample !== false) {
      text += `\n\n${'='.repeat(60)}\n配置示例（保存为 kb/kb.config.json 即可）：\n${'='.repeat(60)}\n`;
      text += EXAMPLE;
    }
    text += `\n\n配置好后调用 kb_config(refresh=true) 重新加载。`;

    return {
      configured: false,
      error: s.error ? s.error.message : null,
      configFilePath: found || null,
      kbConfigEnv: process.env.KB_CONFIG || null,
      kbMysqlUrlEnv: !!process.env.KB_MYSQL_URL,
      _text: text
    };
  }

  /* ---------- 已配置 ---------- */
  const { config, configPath, warnings } = s;

  let text = (args.refresh && wasLoaded ? '🔄 配置已重新加载\n' : '✅ 知识库已配置\n');
  text += `\n配置文件：${configPath}`;

  /* 数据源 + 连通性 */
  text += fmt.section('数据源');
  const rows = [];
  for (const [sname, src] of Object.entries(config.sources)) {
    let status = '（未探测）';
    let detail = '';
    if (args.probe !== false) {
      const p = await s.pools.probe(sname);
      status = p.ok ? '✅ 连通 ' + fmt.ms(p.ms) : '❌ 失败';
      detail = p.ok
        ? `${p.version || ''}${p.currentDatabase ? ' · 默认库 ' + p.currentDatabase : ' · 无默认库'}`
        : (p.error || '');
    }
    rows.push([
      sname,
      `${src.host}:${src.port}`,
      src.user,
      src.database || '(无)',
      src.readOnly ? '只读' : '⚠️ 可写',
      status,
      detail
    ]);
  }
  text += '\n' + fmt.table(['名称', '地址', '用户', '默认库', '权限', '状态', '详情'], rows, { colMax: 40 });

  /* 知识库 */
  text += fmt.section('知识库');
  const kbRows = [];
  for (const [kname, kb] of Object.entries(config.knowledgeBases)) {
    const srcs = Array.from(new Set(kb.tables.map(t => t.source))).join(',') || (kb.source || '');
    const dbs = Array.from(new Set(kb.tables.map(t => t.database).filter(Boolean))).join(',');
    kbRows.push([
      kname,
      kb.tables.length || (kb.autoWholeDatabase ? '整库' : 0),
      srcs,
      dbs,
      kb.description || ''
    ]);
  }
  text += '\n' + fmt.table(['名称', '表数', '数据源', '库', '说明'], kbRows, { colMax: 34 });

  /* 输出预算 */
  text += fmt.section('输出限制');
  text += '\n' + fmt.kv([
    ['单次查询默认行数', config.limits.maxRows],
    ['行数硬上限', config.limits.maxRowsHard],
    ['单元格字符上限', config.limits.maxCellChars],
    ['单次输出总预算', config.limits.maxTotalChars]
  ]);

  if (warnings.length) {
    text += fmt.section('⚠️ 配置警告');
    text += '\n' + warnings.map(w => '  · ' + w).join('\n');
  }

  text += '\n\n热重载：kb_config(refresh=true)　|　看表结构：kb_schema()　|　搜内容：kb_search(query="...")';

  // 结构化输出里的凭据字段一律不外传（safeSourceView 直接不含 password）
  const safeConfig = {
    sources: Object.fromEntries(
      Object.entries(config.sources).map(([k, v]) => [k, safeSourceView(v)])
    ),
    knowledgeBases: Object.fromEntries(Object.entries(config.knowledgeBases).map(([k, v]) => [k, {
      description: v.description,
      tableCount: v.tables.length,
      tables: v.tables.map(t => (t.database ? t.database + '.' : '') + t.table)
    }])),
    limits: config.limits
  };

  return {
    configured: true,
    reloaded: !!args.refresh && wasLoaded,
    configPath,
    warnings,
    sourceCount: Object.keys(config.sources).length,
    knowledgeBaseCount: Object.keys(config.knowledgeBases).length,
    config: safeConfig,
    _text: fmt.clip(text, config.limits.maxTotalChars || 24000)
  };
}

module.exports = { name, title, description, inputSchema, run };
