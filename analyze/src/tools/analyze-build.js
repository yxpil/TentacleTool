'use strict';
/**
 * analyze_build —— 构建/刷新代码知识图谱
 *
 * 这是整个工具集的入口：其它查询工具都需要先有一张图。
 * 首次调用会自动建图（所以严格来说你可以直接跳到别的工具），
 * 但这个工具存在的意义是让 Agent 能**显式控制**：
 *   - 分析哪个目录（一个仓库里可能只想看某个子模块）
 *   - 何时强制重建（刚改完代码，缓存可能过期）
 *   - 有哪些文件没解析成功（了解覆盖度，避免盲信图）
 */

const path = require('path');
const { loadGraph, clearMemory } = require('../utils/cache');

const TOOL = {
  name: 'analyze_build',
  title: '构建代码知识图谱',
  description:
    '把一个代码目录解析成"符号 + 关系"的知识图谱，供后续查询使用。' +
    '支持 JavaScript/TypeScript、Python、Go、Rust、Java、C#、C、C++、Ruby、PHP 共 11 种语言，' +
    '其余语言退化为文件级依赖图。首次构建后会缓存，重复调用直接命中缓存。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要分析的目录绝对路径。默认使用当前工作目录。'
      },
      refresh: {
        type: 'boolean',
        description: '是否强制重建（忽略缓存）。刚改过代码时用。默认 false。'
      },
      include: {
        type: 'string',
        description: '只分析路径中包含该子串的文件，例如 "src/"。'
      },
      exclude: {
        type: 'string',
        description: '跳过路径中包含该子串的文件，例如 "test/"。'
      },
      maxFiles: {
        type: 'number',
        description: '文件数上限，默认 20000。用于防止误扫超大目录。'
      },
      topSymbols: {
        type: 'number',
        description: '返回中心度最高的前 N 个符号，默认 10。传 0 则不返回。'
      }
    }
  },

  run(args = {}) {
    const root = path.resolve(args.path || process.cwd());
    const refresh = !!args.refresh;
    const { graph, from, ms } = loadGraph(root, {
      refresh,
      include: args.include,
      exclude: args.exclude,
      maxFiles: args.maxFiles
    });

    const s = graph.stats();
    const lines = [];

    lines.push(`已构建知识图谱：${root}`);
    lines.push(`来源：${from === 'build' ? '本次新建' : from === 'disk' ? '磁盘缓存' : '内存缓存'}（${ms}ms）`);
    lines.push('');
    lines.push(`文件 ${s.files} 个 · 符号 ${s.symbols} 个 · 关系 ${s.edges} 条`);

    if (Object.keys(s.byKind).length) {
      lines.push('');
      lines.push('符号分布：');
      for (const [k, n] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${k}: ${n}`);
      }
    }

    if (Object.keys(s.byLang).length) {
      lines.push('');
      lines.push('语言分布：');
      for (const [k, n] of Object.entries(s.byLang).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${k}: ${n}`);
      }
    }

    if (Object.keys(s.byEdge).length) {
      lines.push('');
      lines.push('关系分布：');
      for (const [k, n] of Object.entries(s.byEdge).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${k}: ${n}`);
      }
    }

    const topN = args.topSymbols === undefined ? 10 : Number(args.topSymbols);
    if (topN > 0 && s.topDegree.length) {
      lines.push('');
      lines.push(`中心度最高的 ${Math.min(topN, s.topDegree.length)} 个符号（被引用/引用最多，通常是最该先读的）：`);
      for (const t of s.topDegree.slice(0, topN)) {
        const c = t.card;
        const nm = c.container ? `${c.container}.${c.name}` : c.name;
        lines.push(`  ${String(t.degree).padStart(4)}  ${c.kind.padEnd(9)} ${nm.padEnd(28)} ${c.file}:${c.line}`);
      }
    }

    if (s.unresolvedCalls > 0) {
      lines.push('');
      lines.push(`注意：有 ${s.unresolvedCalls} 个调用点无法确定目标（同名多个或动态调用），未连线以免产生假边。`);
    }

    if (s.errors.length) {
      lines.push('');
      lines.push(`有 ${s.errors.length} 个文件解析失败（图里不含其符号）：`);
      for (const e of s.errors.slice(0, 5)) {
        lines.push(`  ${e.file} — ${e.error}`);
      }
      if (s.errors.length > 5) lines.push(`  ...还有 ${s.errors.length - 5} 个`);
    }

    return {
      root,
      from,
      ms,
      files: s.files,
      symbols: s.symbols,
      edges: s.edges,
      byKind: s.byKind,
      byLang: s.byLang,
      byEdge: s.byEdge,
      unresolvedCalls: s.unresolvedCalls,
      errors: s.errors,
      topDegree: topN > 0 ? s.topDegree.slice(0, topN).map(t => ({
        name: t.card.name,
        container: t.card.container || null,
        kind: t.card.kind,
        file: t.card.file,
        line: t.card.line,
        degree: t.degree
      })) : [],
      _text: lines.join('\n')
    };
  }
};

module.exports = TOOL;
