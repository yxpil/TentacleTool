'use strict';
/**
 * analyze_impact —— 影响面分析（改动的爆炸半径）
 *
 * 输入一个符号或文件，输出"改动它会波及到谁"，按层级展开。
 *
 * 和 analyze_callers 的区别：
 *   - callers 只看调用关系，是"精确追踪"
 *   - impact 看所有反向可达关系（调用/继承/实现/导入），是"保守评估"
 * 重构时该用 impact（宁可高估影响面，也不要漏）；读代码时用 callers。
 *
 * 输出还带一个"风险评级"：影响面越大、越靠近入口，风险越高。
 */

const path = require('path');
const { loadGraph } = require('../utils/cache');

const TOOL = {
  name: 'analyze_impact',
  title: '分析影响面',
  description:
    '分析修改某个符号或文件会波及到哪些代码。沿调用、继承、实现、导入等关系反向展开，' +
    '给出分层影响列表与风险评级。重构、改签名、删代码前用它评估爆炸半径。',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '符号名、类名.方法名、或文件路径。'
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
        description: '展开层数，默认 3。'
      },
      edgeKinds: {
        type: 'array',
        items: { type: 'string' },
        description: '考虑哪些关系。默认 calls + extends + implements + type-ref + imports + include。'
      },
      limit: {
        type: 'number',
        description: '每层最多返回多少条，默认 25。'
      }
    },
    required: ['target']
  },

  run(args = {}) {
    if (!args.target) throw new Error('缺少 target 参数');
    const root = path.resolve(args.path || process.cwd());
    const { graph } = loadGraph(root, { refresh: !!args.refresh });
    const depth = Math.max(1, Math.min(8, Number(args.depth) || 3));
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 25));

    const { _resolveTarget } = require('./analyze-refs');
    let idx = _resolveTarget(graph, args.target);
    let isFile = false;
    if (idx === undefined || idx === null) {
      // 退化为文件
      const s = String(args.target).replace(/\\/g, '/');
      for (let i = 0; i < graph.cards.length; i++) {
        if (graph.cards[i].kind === 'file' &&
          (graph.cards[i].file === s || graph.cards[i].file.endsWith(s) || graph.cards[i].file.includes(s))) {
          idx = i; isFile = true; break;
        }
      }
    }
    if (idx === undefined || idx === null) {
      return {
        target: args.target,
        found: false,
        _text: `未找到 "${args.target}"。先用 analyze_find 确认名称，或确认文件路径。`
      };
    }

    const budget = depth + 2;   // 留点余量，最多扫到 depth+2 层
    const levels = graph.impactOf(idx, args.edgeKinds || null, budget);
    const card = graph.cards[idx];
    const nm = card.kind === 'file' ? card.file : (card.container ? `${card.container}.${card.name}` : card.name);

    const lines = [];
    lines.push(`影响面分析：${nm}  [${card.kind}]  ${card.file}:${card.line}`);
    lines.push('');

    const levelCounts = levels.slice(0, depth).map(l => l.edges.length);
    const totalAffected = levelCounts.reduce((a, b) => a + b, 0);

    if (!totalAffected) {
      lines.push('没有发现依赖它的代码。可能：');
      lines.push('  - 它是新加的、还没被使用');
      lines.push('  - 它是对外 API，调用方在项目之外');
      lines.push('  - 它只被动态方式引用（字符串拼接模块名、事件回调注册）');
      lines.push('');
      lines.push('风险评级：低（改动几乎没有内部连带影响）');
      return {
        target: args.target,
        found: true,
        kind: card.kind,
        file: card.file,
        line: card.line,
        totalAffected: 0,
        risk: 'low',
        levels: [],
        _text: lines.join('\n')
      };
    }

    for (const lv of levels.slice(0, depth)) {
      const uniq = dedupeByNode(lv.edges);
      lines.push(`第 ${lv.depth} 层影响（${uniq.length} 个节点）：`);
      for (const u of uniq.slice(0, limit)) {
        const c = graph.cards[u.node];
        const cname = c.kind === 'file' ? c.file : (c.container ? `${c.container}.${c.name}` : c.name);
        lines.push(`  [${u.kind}] ${cname}  ${c.file}:${u.line}`);
      }
      if (uniq.length > limit) lines.push(`  ...还有 ${uniq.length - limit} 个（用 limit 调大）`);
      lines.push('');
    }

    const risk = assessRisk(graph, levels.slice(0, depth), levelCounts);
    lines.push(`受影响节点合计：${dedupeAll(levels.slice(0, depth)).size} 个（${depth} 层内）`);
    lines.push(`风险评级：${risk.level === 'high' ? '高' : risk.level === 'medium' ? '中' : '低'} —— ${risk.reason}`);

    return {
      target: args.target,
      found: true,
      kind: card.kind,
      file: card.file,
      line: card.line,
      depth,
      totalAffected: dedupeAll(levels.slice(0, depth)).size,
      risk: risk.level,
      riskReason: risk.reason,
      levels: levels.slice(0, depth).map(lv => ({
        depth: lv.depth,
        count: dedupeByNode(lv.edges).length,
        entries: dedupeByNode(lv.edges).slice(0, limit).map(u => {
          const c = graph.cards[u.node];
          return {
            kind: c.kind,
            name: c.name,
            container: c.container || null,
            file: c.file,
            line: u.line,
            via: u.kind
          };
        })
      })),
      _text: lines.join('\n')
    };
  }
};

/** 同一节点只保留一条边（取第一次出现的） */
function dedupeByNode(edges) {
  const m = new Map();
  for (const e of edges) {
    if (!m.has(e.from)) m.set(e.from, { node: e.from, kind: e.kind, line: e.line });
  }
  return [...m.values()];
}

function dedupeAll(levels) {
  const s = new Set();
  for (const lv of levels) for (const e of lv.edges) s.add(e.from);
  return s;
}

/**
 * 风险评级：影响面越大越危险。
 * 另外"被文件级导入"（意味着跨模块公开 API）也是危险信号。
 */
function assessRisk(graph, levels, counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  let fileLevelHits = 0;
  for (const lv of levels) {
    for (const e of lv.edges) {
      if (graph.cards[e.from].kind === 'file') fileLevelHits++;
    }
  }
  if (total >= 20 || fileLevelHits >= 3) {
    return { level: 'high', reason: `影响 ${total} 个节点，其中 ${fileLevelHits} 处是跨模块引用；建议改前先跑测试，并考虑保留旧签名做兼容。` };
  }
  if (total >= 5) {
    return { level: 'medium', reason: `影响 ${total} 个节点，集中在同模块内；建议逐个检查调用点。` };
  }
  return { level: 'low', reason: `仅影响 ${total} 个节点，改动可控。` };
}

module.exports = TOOL;
