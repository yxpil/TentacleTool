'use strict';
/**
 * analyze_callers —— 调用链追踪
 *
 * 两个方向：
 *   - callers（谁调用我）：改这个函数前，看看谁会受影响
 *   - callees（我调用谁）：读懂一个函数时，顺着往下追到实现细节
 *
 * 还可以传 depth 做多级追踪，比如"谁间接调用了这个函数"——
 * 排线上问题时，从报错的底层函数倒着爬到入口，非常有用。
 */

const path = require('path');
const { loadGraph } = require('../utils/cache');

const TOOL = {
  name: 'analyze_callers',
  title: '追踪调用链',
  description:
    '追踪函数的调用关系：谁调用了它（含多级间接调用），或它调用了谁。' +
    '常用于评估修改影响面、排查问题根因、理解代码执行路径。',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: '函数/方法名。同名时用 "文件路径:函数名" 或 "类名.方法名" 指定。'
      },
      direction: {
        type: 'string',
        enum: ['callers', 'callees'],
        description: 'callers=谁调用我（默认）；callees=我调用谁。'
      },
      depth: {
        type: 'number',
        description: '追踪层数，默认 1。传 3 可看三层间接调用。'
      },
      path: {
        type: 'string',
        description: '代码目录绝对路径。默认当前工作目录。'
      },
      refresh: {
        type: 'boolean',
        description: '是否强制重建图谱（忽略缓存）。刚改过代码时用。默认 false。'
      },
      limit: {
        type: 'number',
        description: '最多返回多少条，默认 40。'
      }
    },
    required: ['symbol']
  },

  run(args = {}) {
    if (!args.symbol) throw new Error('缺少 symbol 参数');
    const root = path.resolve(args.path || process.cwd());
    const { graph } = loadGraph(root, { refresh: !!args.refresh });
    const direction = args.direction === 'callees' ? 'callees' : 'callers';
    const depth = Math.max(1, Math.min(6, Number(args.depth) || 1));
    const limit = Math.max(1, Math.min(300, Number(args.limit) || 40));

    const { _resolveTarget } = require('./analyze-refs');
    const idx = _resolveTarget(graph, args.symbol);
    if (idx === undefined || idx === null) {
      return {
        symbol: args.symbol,
        found: false,
        _text: `未找到符号 "${args.symbol}"。建议先用 analyze_find 确认名称。`
      };
    }

    const card = graph.cards[idx];
    const nm = card.container ? `${card.container}.${card.name}` : card.name;
    const lines = [];
    lines.push(`${nm}  [${card.kind}]  ${card.file}:${card.line}`);
    lines.push(direction === 'callers' ? '↑ 向上追踪调用者' : '↓ 向下追踪被调用者');
    lines.push('');

    const levels = walk(graph, idx, direction, depth);
    const total = levels.reduce((n, l) => n + l.entries.length, 0);

    if (!total) {
      lines.push(direction === 'callers'
        ? '没有找到调用它的地方。可能原因：'
        : '没有找到它调用的地方（可能是无副作用的纯函数或叶子节点）。');
      if (direction === 'callers') {
        lines.push('  - 它是入口/回调/事件处理器，由框架动态调用');
        lines.push('  - 调用方来自项目外部（如被别的包引用）');
        lines.push('  - 名字在调用处用了别名/解构重命名');
      }
    } else {
      for (const lv of levels) {
        lines.push(`第 ${lv.depth} 层（${lv.entries.length} 处）：`);
        for (const en of lv.entries.slice(0, limit)) {
          const c = graph.cards[en.idx];
          const cname = c.kind === 'file' ? c.file : (c.container ? `${c.container}.${c.name}` : c.name);
          lines.push(`  ${direction === 'callers' ? '←' : '→'} ${cname}  ${c.file}:${en.line}`);
        }
        if (lv.entries.length > limit) lines.push(`  ...还有 ${lv.entries.length - limit} 处`);
        lines.push('');
      }
      lines.push(`合计 ${total} 处。`);
    }

    return {
      symbol: args.symbol,
      found: true,
      kind: card.kind,
      file: card.file,
      line: card.line,
      direction,
      depth,
      total,
      levels: levels.map(lv => ({
        depth: lv.depth,
        entries: lv.entries.slice(0, limit).map(en => {
          const c = graph.cards[en.idx];
          return {
            name: c.name,
            container: c.container || null,
            symbolKind: c.kind,
            file: c.file,
            line: en.line
          };
        })
      })),
      _text: lines.join('\n')
    };
  }
};

/** 逐层走调用边，已访问的不重复展开（避免环） */
function walk(graph, start, direction, maxDepth) {
  const levels = [];
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < maxDepth; d++) {
    const entries = [];
    const next = [];
    for (const cur of frontier) {
      const edges = direction === 'callers'
        ? graph.callersOf(cur)
        : graph.calleesOf(cur);
      for (const e of edges) {
        const other = direction === 'callers' ? e.from : e.to;
        if (seen.has(other)) continue;
        seen.add(other);
        entries.push({ idx: other, line: e.line });
        next.push(other);
      }
    }
    if (!entries.length) break;
    levels.push({ depth: d + 1, entries });
    frontier = next;
  }
  return levels;
}

module.exports = TOOL;
