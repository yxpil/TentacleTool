'use strict';
/**
 * analyze_find —— 按名字/关键字搜符号
 *
 * 和全文 grep 的区别：这里搜的是**图谱里的符号**，所以：
 *   - 结果自带结构信息（kind / 所在类 / 是否导出 / 定义位置）
 *   - 不会命中注释、字符串、变量引用里的一堆噪音
 *   - 可以按类型过滤（只找类、只找函数）
 *   - 排序按"匹配质量"（精确 > 前缀 > 包含 > 文档命中）
 *
 * 典型用法：Agent 拿到一个模糊需求，先找相关符号在哪，
 * 再去读那几个文件——比漫无目的 grep 快得多。
 */

const path = require('path');
const { loadGraph } = require('../utils/cache');

const TOOL = {
  name: 'analyze_find',
  title: '搜索符号',
  description:
    '在代码知识图谱里按名字或关键字搜索符号（类、函数、方法、接口、变量等）。' +
    '结果带类型、所在类、导出状态和定义位置，可按类型过滤。' +
    '比全文搜索更精准：不会命中注释和字符串里的噪音。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '要搜索的名字或关键字。支持部分匹配；也会匹配符号的文档注释。'
      },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description:
          '只返回这些类型的符号。可选：class / function / method / interface / type / enum / ' +
          'struct / trait / property / field / variable / const / macro / package / namespace。'
      },
      path: {
        type: 'string',
        description: '代码目录绝对路径。默认当前工作目录。'
      },
      refresh: {
        type: 'boolean',
        description: '是否强制重建图谱（忽略缓存）。刚改过代码时用。默认 false。'
      },
      file: {
        type: 'string',
        description: '只在路径包含该子串的文件里搜，例如 "utils/"。'
      },
      exportedOnly: {
        type: 'boolean',
        description: '只返回对外导出的符号。默认 false。'
      },
      limit: {
        type: 'number',
        description: '最多返回多少条，默认 25。'
      }
    },
    required: ['query']
  },

  run(args = {}) {
    if (!args.query) throw new Error('缺少 query 参数');
    const root = path.resolve(args.path || process.cwd());
    const { graph } = loadGraph(root, { refresh: !!args.refresh });

    const limit = Math.max(1, Math.min(200, Number(args.limit) || 25));
    const hits = graph.findSymbol(args.query, {
      kinds: args.kinds,
      file: args.file,
      exportedOnly: !!args.exportedOnly
    });

    const lines = [];
    lines.push(`搜索 "${args.query}"：命中 ${hits.length} 个符号`);

    if (!hits.length) {
      lines.push('');
      // 空结果要给出可操作的下一步，而不是只说"没找到"
      const sample = graph.findSymbol(args.query.slice(0, Math.max(2, Math.floor(args.query.length / 2))), {}).slice(0, 5);
      if (sample.length) {
        lines.push('未精确命中。放宽后的相近符号：');
        for (const h of sample) lines.push(`  ${h.card.kind} ${h.card.container ? h.card.container + '.' : ''}${h.card.name} @ ${h.card.file}:${h.card.line}`);
      } else {
        lines.push('未找到任何相近符号。可能原因：');
        lines.push('  - 该符号属于不支持的语言（当前支持 JS/TS、Python、Go、Rust、Java、C#、C/C++、Ruby、PHP）');
        lines.push('  - 名字拼写不同，或用了别名');
        lines.push('  - 文件被 exclude/skipDirs 跳过了（如 node_modules、构建产物）');
      }
      return { query: args.query, total: 0, results: [], _text: lines.join('\n') };
    }

    if (args.kinds && args.kinds.length) lines.push(`类型过滤：${args.kinds.join(', ')}`);
    if (args.file) lines.push(`路径过滤：${args.file}`);
    if (args.exportedOnly) lines.push('仅导出符号');

    lines.push('');
    const shown = hits.slice(0, limit);
    for (const h of shown) {
      const c = h.card;
      const nm = c.container ? `${c.container}.${c.name}` : c.name;
      const tags = [c.kind];
      if (c.exported) tags.push('exported');
      if (c.params && c.params.length) tags.push('(' + c.params.join(', ') + ')');
      lines.push(`${nm}  [${tags.join(' ')}]`);
      lines.push(`    ${c.file}:${c.line}${c.typeName ? '  : ' + c.typeName : ''}`);
      if (c.doc) lines.push(`    // ${c.doc.slice(0, 120)}`);
    }
    if (hits.length > limit) {
      lines.push('');
      lines.push(`（共 ${hits.length} 条，已显示前 ${limit} 条；可用 limit 调大）`);
    }

    return {
      query: args.query,
      total: hits.length,
      results: shown.map(h => ({
        name: h.card.name,
        container: h.card.container || null,
        kind: h.card.kind,
        file: h.card.file,
        line: h.card.line,
        exported: !!h.card.exported,
        params: h.card.params || [],
        typeName: h.card.typeName || null,
        doc: h.card.doc || ''
      })),
      _text: lines.join('\n')
    };
  }
};

module.exports = TOOL;
