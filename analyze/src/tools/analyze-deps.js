'use strict';
/**
 * analyze_deps —— 文件级依赖分析
 *
 * 回答三个最常问的问题：
 *   - 这个文件依赖了哪些文件？（改了它，我得一起看哪些）
 *   - 这个文件被谁依赖？（动了它，谁会受影响）
 *   - 整个项目里有没有**循环依赖**？（会导致加载顺序诡异、难以拆分）
 *
 * 循环依赖检测是这个工具的核心价值：手工排查循环引用极其费劲，
 * 而在图上做一次 SCC（强连通分量）就出来了。
 */

const path = require('path');
const { loadGraph } = require('../utils/cache');

const TOOL = {
  name: 'analyze_deps',
  title: '分析文件依赖',
  description:
    '分析文件之间的依赖关系：某文件导入了谁、被谁导入，以及全项目的循环依赖。' +
    '支持只看直接依赖，也可以看传递依赖（闭包）。',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: '文件路径（相对仓库根的相对路径或子串即可）。不传则做全局循环依赖检测。'
      },
      path: {
        type: 'string',
        description: '代码目录绝对路径。默认当前工作目录。'
      },
      refresh: {
        type: 'boolean',
        description: '是否强制重建图谱（忽略缓存）。刚改过代码时用。默认 false。'
      },
      depth: {
        type: 'number',
        description: '传递依赖的层数。默认 1（只看直接依赖）；传 3 看三层；传 0 表示不限层数。'
      },
      cycles: {
        type: 'boolean',
        description: '是否输出循环依赖检测结果。默认 true。'
      }
    }
  },

  run(args = {}) {
    const root = path.resolve(args.path || process.cwd());
    const { graph } = loadGraph(root, { refresh: !!args.refresh });
    const depthArg = args.depth === undefined ? 1 : Number(args.depth);
    const lines = [];

    // ---- 单文件模式 ----
    if (args.file) {
      const target = findFile(graph, args.file);
      if (!target) {
        lines.push(`未找到文件 "${args.file}"。`);
        lines.push('提示：传入路径子串即可，例如 "src/index.js"。');
        return { file: args.file, found: false, _text: lines.join('\n') };
      }
      const { out, in: inn } = graph.depsOf(target);
      lines.push(`文件：${target}`);
      lines.push('');

      lines.push(`依赖了 ${out.length} 个文件：`);
      if (!out.length) lines.push('  （无——不导入任何项目内文件）');
      for (const e of out) lines.push(`  → ${graph.cards[e.to].file}`);

      lines.push('');
      lines.push(`被 ${inn.length} 个文件依赖：`);
      if (!inn.length) lines.push('  （无——通常是入口文件）');
      for (const e of inn) lines.push(`  ← ${graph.cards[e.from].file}`);

      // 传递闭包
      if (depthArg !== 1) {
        const closure = transitive(graph, target, depthArg);
        lines.push('');
        lines.push(`传递依赖（${depthArg === 0 ? '不限层数' : depthArg + ' 层'}）共 ${closure.size - 1} 个文件：`);
        const list = [...closure].filter(f => f !== target);
        for (const f of list.slice(0, 40)) lines.push(`  → ${f}`);
        if (list.length > 40) lines.push(`  ...还有 ${list.length - 40} 个`);
      }

      const result = {
        file: target,
        found: true,
        dependsOn: out.map(e => graph.cards[e.to].file),
        dependedBy: inn.map(e => graph.cards[e.from].file),
        _text: lines.join('\n')
      };
      if (args.cycles !== false) {
        const cyc = detectCycles(graph);
        const involved = cyc.filter(c => c.includes(target));
        result.cycles = involved;
        if (involved.length) {
          lines.push('');
          lines.push(`⚠ 该文件处于 ${involved.length} 个循环依赖中：`);
          for (const c of involved) lines.push('  ' + c.join(' → ') + ' → ' + c[0]);
        }
        lines.join('\n');
        result._text = lines.join('\n');
      }
      return result;
    }

    // ---- 全局模式：循环依赖 ----
    const cyc = detectCycles(graph);
    lines.push(`扫描 ${graph.files.size} 个文件的依赖关系`);
    lines.push('');
    if (!cyc.length) {
      lines.push('未发现循环依赖。');
    } else {
      lines.push(`发现 ${cyc.length} 组循环依赖：`);
      for (const c of cyc.slice(0, 20)) {
        lines.push('');
        lines.push('  ' + c.join('\n   → ') + '\n   → ' + c[0]);
      }
      if (cyc.length > 20) lines.push(`\n...还有 ${cyc.length - 20} 组`);
    }

    // 顺便给出最"重"的文件（依赖最多 + 被依赖最多），常用于找架构枢纽
    const fanOut = [...graph.files.keys()].map(f => {
      const d = graph.depsOf(f);
      return { file: f, out: d.out.length, in: d.in.length };
    }).filter(x => x.out || x.in).sort((a, b) => (b.out + b.in) - (a.out + a.in)).slice(0, 10);

    if (fanOut.length) {
      lines.push('');
      lines.push('依赖枢纽（出入度最高的文件）：');
      for (const f of fanOut) {
        lines.push(`  ←${String(f.in).padStart(3)}  →${String(f.out).padStart(3)}  ${f.file}`);
      }
    }

    return {
      files: graph.files.size,
      cycles: cyc,
      hubs: fanOut,
      _text: lines.join('\n')
    };
  }
};

/** 按子串找文件节点 */
function findFile(graph, spec) {
  const s = String(spec).replace(/\\/g, '/');
  if (graph.files.has(s)) return s;
  for (const f of graph.files.keys()) {
    if (f.endsWith(s) || f.includes(s)) return f;
  }
  return null;
}

/** 传递依赖闭包（只沿 imports/include 走） */
function transitive(graph, start, maxDepth) {
  const seen = new Set([start]);
  let frontier = [start];
  const limit = maxDepth === 0 ? Infinity : maxDepth;
  for (let d = 0; d < limit; d++) {
    const next = [];
    for (const f of frontier) {
      for (const e of graph.depsOf(f).out) {
        const to = graph.cards[e.to].file;
        if (seen.has(to)) continue;
        seen.add(to);
        next.push(to);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return seen;
}

/**
 * 循环依赖检测：Tarjan 强连通分量。
 * 只沿文件级 imports/include 边跑，SCC 大小 > 1 即为循环。
 */
function detectCycles(graph) {
  const nodes = [...graph.files.keys()];
  const adj = new Map();
  for (const n of nodes) adj.set(n, []);
  const fileIdx = new Map();
  for (let i = 0; i < graph.cards.length; i++) {
    if (graph.cards[i].kind === 'file') fileIdx.set(graph.cards[i].file, i);
  }
  for (const e of graph.edges) {
    if (e.kind !== 'imports' && e.kind !== 'include') continue;
    const a = graph.cards[e.from].file;
    const b = graph.cards[e.to].file;
    if (a !== b && adj.has(a)) adj.get(a).push(b);
  }

  const index = new Map(), low = new Map(), onStack = new Set();
  const stack = [];
  let counter = 0;
  const sccs = [];

  const strongconnect = (v) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop(); onStack.delete(w); comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp.reverse());
    }
  };

  for (const n of nodes) if (!index.has(n)) strongconnect(n);
  return sccs;
}

module.exports = TOOL;
module.exports._detectCycles = detectCycles;
