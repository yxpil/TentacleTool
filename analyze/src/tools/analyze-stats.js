'use strict';
/**
 * analyze_stats —— 图谱统计与代码健康度概览
 *
 * 用途是"快速摸清一个陌生项目"：
 *   - 规模有多大（文件/符号/关系）
 *   - 用什么语言写的
 *   - 哪些文件是"上帝文件"（符号特别多，通常该拆）
 *   - 哪些符号是枢纽（被依赖最多，改之前要慎重）
 *   - 有没有大文件、有没有死代码（零引用的导出符号）
 *
 * 这些指标不是学术意义的代码质量，而是"给 Agent 一张地图"，
 * 让它知道该先读哪几个文件、哪些地方是雷区。
 */

const path = require('path');
const { loadGraph } = require('../utils/cache');

const TOOL = {
  name: 'analyze_stats',
  title: '图谱统计概览',
  description:
    '输出代码库的整体结构与健康度概览：规模、语言分布、符号类型、上帝文件、' +
    '核心枢纽符号、疑似死代码（零引用导出符号）。适合快速摸清陌生项目。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '代码目录绝对路径。默认当前工作目录。'
      },
      refresh: {
        type: 'boolean',
        description: '是否强制重建图谱（忽略缓存）。刚改过代码时用。默认 false。'
      },
      top: {
        type: 'number',
        description: '各类榜单返回多少条，默认 10。'
      },
      deadCode: {
        type: 'boolean',
        description: '是否扫描疑似死代码（零引用的导出符号）。默认 true。'
      }
    }
  },

  run(args = {}) {
    const root = path.resolve(args.path || process.cwd());
    const { graph } = loadGraph(root, { refresh: !!args.refresh });
    const top = Math.max(1, Math.min(50, Number(args.top) || 10));
    const s = graph.stats();
    const lines = [];

    lines.push(`代码库概览：${root}`);
    lines.push(`构建时间：${s.builtAt || '(未记录)'}`);
    lines.push('');

    // ---- 规模 ----
    lines.push('■ 规模');
    lines.push(`  文件 ${s.files} · 符号 ${s.symbols} · 关系 ${s.edges}`);
    if (s.unresolvedCalls) lines.push(`  未解析调用 ${s.unresolvedCalls} 处（动态调用/同名歧义）`);
    lines.push('');

    if (Object.keys(s.byLang).length) {
      lines.push('■ 语言分布');
      for (const [k, n] of Object.entries(s.byLang).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${String(n).padStart(6)}  ${k}`);
      }
      lines.push('');
    }

    if (Object.keys(s.byKind).length) {
      lines.push('■ 符号类型');
      for (const [k, n] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${String(n).padStart(6)}  ${k}`);
      }
      lines.push('');
    }

    // ---- 上帝文件：符号数最多的文件，通常该考虑拆分 ----
    const byFile = [...graph.files.keys()].map(f => ({
      file: f,
      symbols: graph.files.get(f).symbolCount || 0,
      lines: graph.files.get(f).lineCount || 0
    })).sort((a, b) => b.symbols - a.symbols).slice(0, top);

    if (byFile.length) {
      lines.push('■ 符号最多的文件（"上帝文件"，考虑拆分）');
      for (const f of byFile) {
        lines.push(`  ${String(f.symbols).padStart(4)} 符号 / ${String(f.lines).padStart(5)} 行  ${f.file}`);
      }
      lines.push('');
    }

    // ---- 核心枢纽 ----
    if (s.topDegree.length) {
      lines.push('■ 核心枢纽符号（被依赖最多，改动需谨慎）');
      for (const t of s.topDegree.slice(0, top)) {
        const c = t.card;
        const nm = c.container ? `${c.container}.${c.name}` : c.name;
        lines.push(`  ${String(t.degree).padStart(4)} 度  ${c.kind.padEnd(9)} ${nm.padEnd(26)} ${c.file}:${c.line}`);
      }
      lines.push('');
    }

    // ---- 死代码：导出了但没人引用 ----
    let dead = [];
    if (args.deadCode !== false) {
      dead = findDeadCode(graph);
      lines.push('■ 疑似死代码（已导出但项目内零引用）');
      if (!dead.length) {
        lines.push('  未发现。');
      } else {
        lines.push(`  共 ${dead.length} 个。注意：对外发布的库，导出可能正是给外部用的，`);
        lines.push('  这类"无人引用"是正常的，判断时请结合项目类型。');
        for (const d of dead.slice(0, top)) {
          const nm = d.container ? `${d.container}.${d.name}` : d.name;
          lines.push(`  ${d.kind.padEnd(9)} ${nm.padEnd(26)} ${d.file}:${d.line}`);
        }
        if (dead.length > top) lines.push(`  ...还有 ${dead.length - top} 个（用 top 调大）`);
      }
      lines.push('');
    }

    // ---- 解析失败 ----
    if (s.errors.length) {
      lines.push('■ 解析失败的文件');
      for (const e of s.errors.slice(0, top)) lines.push(`  ${e.file} — ${e.error}`);
      lines.push('');
    }

    lines.push('■ 下一步建议');
    lines.push('  - 想改某处 → 先 analyze_impact 看爆炸半径');
    lines.push('  - 想找代码 → analyze_find 搜符号（比 grep 精准）');
    lines.push('  - 想读调用链 → analyze_callers 追上下游');
    lines.push('  - 想拆模块 → analyze_deps 看循环依赖');

    return {
      root,
      files: s.files,
      symbols: s.symbols,
      edges: s.edges,
      byLang: s.byLang,
      byKind: s.byKind,
      byEdge: s.byEdge,
      topFiles: byFile,
      topDegree: s.topDegree.slice(0, top),
      deadCode: dead.slice(0, top),
      deadCodeCount: dead.length,
      errors: s.errors,
      _text: lines.join('\n')
    };
  }
};

/**
 * 找"导出了但没人引用"的符号。
 * 判定条件：
 *   - card.exported 为真
 *   - 没有任何 incoming 边（除却自己文件里的 contains）
 *   - 排除测试文件（测试里的导出本来就不对外）
 *   - 排除入口/配置类文件
 */
function findDeadCode(graph) {
  const out = [];
  for (let i = 0; i < graph.cards.length; i++) {
    const c = graph.cards[i];
    if (!c.exported) continue;
    if (c.kind === 'file' || c.kind === 'variable') continue;
    if (isTestOrConfig(c.file)) continue;
    const incoming = graph.edges.filter(e => e.to === i && e.kind !== 'contains');
    if (incoming.length === 0) out.push(c);
  }
  return out;
}

function isTestOrConfig(file) {
  return /(^|\/)(test|tests|spec|__tests__|specs)\//i.test(file)
    || /\.(test|spec)\.[jt]sx?$/i.test(file)
    || /(^|\/)(scripts|examples|fixtures|benchmarks)\//i.test(file)
    || /\.config\.[jt]s$/i.test(file);
}

module.exports = TOOL;
module.exports._findDeadCode = findDeadCode;
