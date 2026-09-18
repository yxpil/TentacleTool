'use strict';
/**
 * analyze_refs —— 查某个符号的所有引用关系（谁用了它 / 它用了谁）
 *
 * 这是"重构前的安全检查"工具。改一个函数的签名之前，
 * 先看清有谁在调它、有谁继承了它、有谁把它当类型用。
 *
 * 输出分三块：
 *   incoming —— 谁依赖我（改我会有影响）
 *   outgoing —— 我依赖谁（我坏了可能是因为它们）
 *   未解析   —— 点名了但连不上的（坦诚交代，别假装完整）
 */

const path = require('path');
const { loadGraph } = require('../utils/cache');

const EDGE_LABEL = {
  calls: '调用',
  extends: '继承',
  implements: '实现',
  'type-ref': '类型引用',
  imports: '导入',
  include: '包含',
  contains: '定义'
};

const TOOL = {
  name: 'analyze_refs',
  title: '查符号引用',
  description:
    '查一个符号的全部引用关系：谁引用了它（调用/继承/实现/类型引用），以及它引用了谁。' +
    '重构、改签名、删函数之前用它评估影响面。',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: '符号名。若有同名，用 "文件路径:符号名" 或 "类名.方法名" 形式精确指定。'
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
        description: '只看这些关系类型。可选：calls / extends / implements / type-ref / imports。默认全部。'
      },
      limit: {
        type: 'number',
        description: '每一类最多返回多少条，默认 30。'
      }
    },
    required: ['symbol']
  },

  run(args = {}) {
    if (!args.symbol) throw new Error('缺少 symbol 参数');
    const root = path.resolve(args.path || process.cwd());
    const { graph } = loadGraph(root, { refresh: !!args.refresh });
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 30));

    const target = resolveTarget(graph, args.symbol);
    if (!target) {
      return {
        symbol: args.symbol,
        found: false,
        _text: [
          `未找到符号 "${args.symbol}"。`,
          '提示：先用 analyze_find 确认符号存在及准确名称（同名符号需带文件名或类名前缀）。'
        ].join('\n')
      };
    }

    const card = graph.cards[target];
    const { incoming, outgoing } = graph.refsOf(target);
    const filter = args.edgeKinds && args.edgeKinds.length ? new Set(args.edgeKinds) : null;

    // 排除 contains 自环：文件"包含"自己的符号不是引用关系，
    // 把它算进"被引用 N 处"会让计数虚高、误导判断。
    const inc = incoming.filter(e => e.kind !== 'contains' && (!filter || filter.has(e.kind)));
    const out = outgoing.filter(e => e.kind !== 'contains' && (!filter || filter.has(e.kind)));

    const nm = card.container ? `${card.container}.${card.name}` : card.name;
    const lines = [];
    lines.push(`${nm}  [${card.kind}]  ${card.file}:${card.line}`);
    if (card.exported) lines.push('（对外导出）');
    if (card.doc) lines.push(`// ${card.doc.slice(0, 160)}`);
    lines.push('');

    lines.push(`被引用 ${inc.length} 处（谁依赖我）：`);
    if (!inc.length) {
      lines.push('  （无——可能是死代码，或只在动态/反射场景里被用到）');
    } else {
      for (const e of inc.slice(0, limit)) {
        const from = graph.cards[e.from];
        const fname = from.kind === 'file'
          ? from.file
          : (from.container ? `${from.container}.${from.name}` : from.name);
        lines.push(`  [${EDGE_LABEL[e.kind] || e.kind}] ${fname}  ${from.file}:${e.line}`);
      }
      if (inc.length > limit) lines.push(`  ...还有 ${inc.length - limit} 处（用 limit 调大）`);
    }

    lines.push('');
    lines.push(`引用了 ${out.length} 处（我依赖谁）：`);
    if (!out.length) {
      lines.push('  （无——叶子节点，通常是自包含的工具函数或常量）');
    } else {
      for (const e of out.slice(0, limit)) {
        const to = graph.cards[e.to];
        const tname = to.kind === 'file'
          ? to.file
          : (to.container ? `${to.container}.${to.name}` : to.name);
        lines.push(`  [${EDGE_LABEL[e.kind] || e.kind}] ${tname}  ${to.file}:${e.line}`);
      }
      if (out.length > limit) lines.push(`  ...还有 ${out.length - limit} 处（用 limit 调大）`);
    }

    return {
      symbol: args.symbol,
      found: true,
      kind: card.kind,
      file: card.file,
      line: card.line,
      exported: !!card.exported,
      incomingCount: inc.length,
      outgoingCount: out.length,
      incoming: inc.slice(0, limit).map(e => edgeView(graph, e, 'from')),
      outgoing: out.slice(0, limit).map(e => edgeView(graph, e, 'to')),
      _text: lines.join('\n')
    };
  }
};

/** 把边转成对外的结构化视图 */
function edgeView(graph, e, side) {
  const c = graph.cards[side === 'from' ? e.from : e.to];
  return {
    kind: e.kind,
    name: c.name,
    container: c.container || null,
    symbolKind: c.kind,
    file: c.file,
    line: e.line
  };
}

/**
 * 解析用户给的符号串，支持三种写法：
 *   tokenize                        —— 直接名字
 *   calc/src/utils/tokenizer.js:tokenize —— 带文件限定
 *   Evaluator.get                   —— 类名.方法名
 */
function resolveTarget(graph, spec) {
  const s = String(spec).trim();

  // 带文件限定
  const colon = s.lastIndexOf(':');
  if (colon > 0 && s.slice(colon + 1)) {
    const filePart = s.slice(0, colon);
    const namePart = s.slice(colon + 1);
    const list = graph.byName.get(namePart) || [];
    const hit = list.find(i => graph.cards[i].file.includes(filePart));
    if (hit !== undefined) return hit;
  }

  // 类名.方法名
  if (s.includes('.')) {
    const dot = s.lastIndexOf('.');
    const container = s.slice(0, dot);
    const name = s.slice(dot + 1);
    const list = graph.byName.get(name) || [];
    const hit = list.find(i => graph.cards[i].container === container
      || graph.cards[i].file.endsWith(container));
    if (hit !== undefined) return hit;
  }

  // 纯名字：有多个就取"被引用最多"的那个，这是最可能的意图
  const list = graph.byName.get(s) || [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  let best = list[0], bestDeg = -1;
  for (const i of list) {
    const deg = graph.edges.filter(e => e.to === i).length;
    if (deg > bestDeg) { bestDeg = deg; best = i; }
  }
  return best;
}

module.exports = TOOL;
module.exports._resolveTarget = resolveTarget;
