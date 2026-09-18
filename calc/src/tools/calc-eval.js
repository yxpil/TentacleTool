'use strict';
/**
 * calc_eval：数学表达式求值
 *
 * 支持：
 *   - 多语句（`;` 或换行分隔），变量可在后续语句复用
 *   - 复数（3+4i / sqrt(-4) / ln(-1)）
 *   - 三角/反三角/双曲/指对/统计/数论等 ~100 个函数
 *   - 角度制（rad / deg / grad）、输出精度、极坐标展示
 *   - 区间字面量 `1:5`、`1:2:9`
 */
const { parse } = require('../utils/parser');
const {
  evaluateProgram, Context, CalcEvalError
} = require('../utils/evaluator');
const { formatValue, fmtPolar } = require('../utils/format');
const { CalcSyntaxError } = require('../utils/tokenizer');

const MAX_EXPR_LEN = 20000;

/** 从结果里挑出"值得展示"的变量（去掉内部临时名） */
function collectVars(ctx) {
  const out = [];
  for (const [k, v] of ctx.scope.vars) {
    if (/^__/.test(k)) continue;
    out.push({ name: k, value: v });
  }
  return out;
}

/**
 * 把错误渲染成带插入符提示的多行文本
 */
function renderError(e, src) {
  if (e instanceof CalcSyntaxError && e.pos != null && src != null) {
    // CalcSyntaxError 的 message 已经带了插入符行
    return '**语法错误**: ' + e.message;
  }
  if (e instanceof CalcEvalError) {
    let head = '**求值错误**: ' + e.message;
    if (e.pos != null && src != null) {
      head += '\n' + caretHint(src, e.pos);
    }
    return head;
  }
  return '**错误**: ' + (e && e.message ? e.message : String(e));
}

function caretHint(src, pos) {
  const flat = src.slice(0, Math.max(0, pos)).replace(/\n/g, ' ');
  const prefix = flat.length > 70 ? '...' + flat.slice(-67) : flat;
  const tail = src.slice(pos, pos + 40).replace(/\n/g, ' ');
  return '  ' + prefix + tail + '\n  ' + ' '.repeat(prefix.length) + '^';
}

function run(args = {}) {
  const expr = args.expr != null ? String(args.expr) : (args.expression != null ? String(args.expression) : '');
  if (!expr.trim()) {
    return '用法: calc_eval(expr="sin(pi/4)^2 + cos(pi/4)^2")\n\n'
      + '支持多语句，用 `;` 或换行分隔，变量可复用：\n'
      + '  calc_eval(expr="a=3; b=4; sqrt(a^2+b^2)")\n\n'
      + '不确定语法时先调 calc_help。';
  }
  if (expr.length > MAX_EXPR_LEN) {
    return `表达式过长（${expr.length} 字符，上限 ${MAX_EXPR_LEN}）。请拆成多次调用。`;
  }

  const opts = {
    angleMode: args.angleMode || 'rad',
    precision: args.precision || 12,
    src: expr
  };

  const out = [];
  out.push('## calc_eval');
  out.push('');
  out.push('```');
  out.push(expr);
  out.push('```');
  out.push('');

  let ast;
  try {
    ast = parse(expr);
  } catch (e) {
    out.push(renderError(e, expr));
    return out.join('\n');
  }

  const ctx = new Context(opts);
  let results;
  try {
    results = evaluateProgram(ast, ctx);
  } catch (e) {
    out.push(renderError(e, expr));
    return out.join('\n');
  }

  const multi = results.length > 1;
  if (multi) {
    out.push('**分步结果:**');
    out.push('');
    results.forEach((r, i) => {
      const { text, extra } = formatValue(r.value, { precision: opts.precision });
      const label = nodeLabel(r.node);
      out.push(`${i + 1}. ${label}${label ? ' ' : ''}**${text}**${extra ? `  _(${extra})_` : ''}`);
    });
    out.push('');
    const last = results[results.length - 1];
    const { text, extra } = formatValue(last.value, { precision: opts.precision });
    out.push(`**结果: ${text}**${extra ? `  _(${extra})_` : ''}`);
  } else {
    const { text, extra } = formatValue(results[0].value, { precision: opts.precision });
    out.push(`**结果: ${text}**${extra ? `  _(${extra})_` : ''}`);
    if (args.polar && isComplexish(results[0].value)) {
      out.push('');
      out.push('极坐标: ' + fmtPolar(results[0].value));
    }
  }

  const vars = collectVars(ctx);
  if (vars.length) {
    out.push('');
    out.push('**变量:**');
    for (const v of vars) {
      const { text, extra } = formatValue(v.value, { precision: opts.precision });
      out.push(`- ${v.name} = ${text}${extra ? `  _(${extra})_` : ''}`);
    }
  }

  out.push('');
  out.push(`> 角度制: ${ctx.angleMode}　精度: ${opts.precision} 位有效数字`);
  return out.join('\n');
}

function nodeLabel(node) {
  if (!node) return '';
  if (node.type === 'assign') return `${node.name} =`;
  if (node.type === 'postfixAssign') return `${node.name}${node.op} →`;
  return '';
}

function isComplexish(v) {
  return v && typeof v === 'object' && 'im' in v;
}

module.exports = { run };
