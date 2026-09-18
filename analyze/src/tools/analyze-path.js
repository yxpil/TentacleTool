'use strict';
/**
 * analyze_path —— 两个符号之间的依赖路径
 *
 * 回答"它们是怎么扯上关系的"：
 *   - A 是怎么（间接）调用到 B 的？
 *   - 从入口到某个实现，中间经过了哪些层？
 *   - 这两个模块有没有依赖关系（以及最短的那条路）？
 *
 * 用 BFS 求最短路径，保证给的是"最短那条链"，而不是随便一条。
 * 多给几条备选路径也有用——真实项目里往往不止一条链路。
 */

const path = require('path');
const { loadGraph } = require('../utils/cache');

const TOOL = {
  name: 'analyze_path',
  title: '查找依赖路径',
  description:
    '查找两个符号之间的最短依赖/调用路径，回答"它们是怎么关联起来的"。' +
    '可限定走哪类关系（调用/导入/继承）。用于理解代码链路、排查耦合、确认是否存在依赖。',
  inputSchema: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        description: '起点符号名（或 "文件路径:符号名"）。也支持直接给文件路径。'
      },
      to: {
        type: 'string',
        description: '终点符号名（或 "文件路径:符号名"）。也支持直接给文件路径。'
      },
      path: {
        type: 'string',
        description: '代码目录绝对路径。默认当前工作目录。'
      },
      refresh: {
        type: 'boolean',
        description: '是否强制重建图谱（忽略缓存）。刚改过代码时用。默认 false。'
      },
      edgeKinds: {
        type: 'array',
        items: { type: 'string' },
        description: '只允许走这些关系。默认 calls + imports + include + extends + implements。',
        default: ['calls', 'imports', 'include', 'extends', 'implements']
      },
      alternatives: {
        type: 'number',
        description: '除了最短路径，额外再找几条备选路径。默认 0。'
      }
    },
    required: ['from', 'to']
  },

  run(args = {}) {
    if (!args.from || !args.to) throw new Error('需要 from 和 to 两个参数');
    const root = path.resolve(args.path || process.cwd());
    const { graph } = loadGraph(root, { refresh: !!args.refresh });
    const { _resolveTarget } = require('./analyze-refs');

    const srcIdx = resolveAny(graph, args.from, _resolveTarget);
    const dstIdx = resolveAny(graph, args.to, _resolveTarget);

    const lines = [];
    if (srcIdx < 0) {
      return { found: false, _text: `未找到起点 "${args.from}"。先用 analyze_find 确认名称。` };
    }
    if (dstIdx < 0) {
      return { found: false, _text: `未找到终点 "${args.to}"。先用 analyze_find 确认名称。` };
    }
    if (srcIdx === dstIdx) {
      return { found: true, path: [], _text: '起点与终点是同一个符号。' };
    }

    const kinds = Array.isArray(args.edgeKinds) && args.edgeKinds.length
      ? args.edgeKinds
      : ['calls', 'imports', 'include', 'extends', 'implements'];

    const sp = graph.shortestPath(srcIdx, dstIdx, kinds);
    const srcC = graph.cards[srcIdx], dstC = graph.cards[dstIdx];
    const fmt = (c) => c.kind === 'file' ? c.file : (c.container ? `${c.container}.${c.name}` : c.name);

    lines.push(`从 ${fmt(srcC)}（${srcC.file}:${srcC.line}）`);
    lines.push(`到 ${fmt(dstC)}（${dstC.file}:${dstC.line}）`);
    lines.push('');

    if (!sp) {
      lines.push('两者之间没有可达路径（在指定的关系类型下）。');
      lines.push('');
      lines.push('这意味着：它们互不依赖，或依赖关系未被图谱捕捉到。');
      lines.push('若确信有依赖，可尝试：');
      lines.push('  - 放宽 edgeKinds（默认已含 calls/imports/include/extends/implements）');
      lines.push('  - 依赖可能通过动态调用（eval、反射、字符串拼出的模块名）建立，静态分析抓不到');
      return {
        found: true,
        connected: false,
        from: { name: srcC.name, file: srcC.file, line: srcC.line },
        to: { name: dstC.name, file: dstC.file, line: dstC.line },
        _text: lines.join('\n')
      };
    }

    lines.push(`找到依赖路径，长度 ${sp.length} 步：`);
    lines.push('');
    lines.push(`  ${fmt(srcC)}`);
    for (const e of sp) {
      const to = graph.cards[e.to];
      lines.push(`    --[${e.kind}]--> ${fmt(to)}   (${to.file}:${e.line})`);
    }
    lines.push('');

    // 备选路径：去掉最短路径的第一条边再求一次，能挖出不同链路
    const alts = [];
    const wantAlts = Math.max(0, Math.min(3, Number(args.alternatives) || 0));
    if (wantAlts > 0) {
      const firstEdge = sp[0];
      const blocked = new Set([firstEdge.from + '>' + firstEdge.to + '>' + firstEdge.kind]);
      const alt = shortestPathAvoiding(graph, srcIdx, dstIdx, kinds, blocked);
      if (alt && alt.length) {
        alts.push(alt);
        lines.push('备选路径（避开最短路径的首条边）：');
        lines.push(`  ${fmt(srcC)}`);
        for (const e of alt) {
          const to = graph.cards[e.to];
          lines.push(`    --[${e.kind}]--> ${fmt(to)}   (${to.file}:${e.line})`);
        }
      } else {
        lines.push('（未找到其他备选路径，可能这条已是唯一链路）');
      }
    }

    const result = {
      found: true,
      connected: true,
      steps: sp.length,
      from: { name: srcC.name, file: srcC.file, line: srcC.line },
      to: { name: dstC.name, file: dstC.file, line: dstC.line },
      path: sp.map(e => {
        const from = graph.cards[e.from], to = graph.cards[e.to];
        return {
          kind: e.kind,
          from: { name: from.name, container: from.container || null, file: from.file },
          to: { name: to.name, container: to.container || null, file: to.file, line: to.line }
        };
      }),
      alternatives: alts.map(a => a.length),
      _text: lines.join('\n')
    };
    return result;
  }
};

/** 先当符号找，再当文件找 */
function resolveAny(graph, spec, resolveTarget) {
  const t = resolveTarget(graph, spec);
  if (t !== undefined && t !== null) return t;
  const s = String(spec).replace(/\\/g, '/');
  for (const f of graph.files.keys()) {
    if (f === s || f.endsWith(s) || f.includes(s)) {
      for (let i = 0; i < graph.cards.length; i++) {
        if (graph.cards[i].kind === 'file' && graph.cards[i].file === f) return i;
      }
    }
  }
  return -1;
}

/** 带禁边的 BFS，用于找备选路径 */
function shortestPathAvoiding(graph, from, to, kinds, blocked) {
  const allow = new Set(kinds);
  const adj = new Map();
  for (const e of graph.edges) {
    if (!allow.has(e.kind)) continue;
    const k = e.from + '>' + e.to + '>' + e.kind;
    if (blocked.has(k)) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e);
  }
  const prev = new Map();
  const queue = [from];
  const visited = new Set([from]);
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const e of (adj.get(cur) || [])) {
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      prev.set(e.to, { from: cur, edge: e });
      queue.push(e.to);
    }
  }
  if (!visited.has(to)) return null;
  const path = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) break;
    path.unshift(p.edge);
    cur = p.from;
  }
  return path;
}

module.exports = TOOL;
