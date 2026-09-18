'use strict';
/**
 * 递归下降解析器（零依赖）→ AST
 *
 * 优先级（低 → 高）：
 *   1. 赋值          x = expr（标识符在左侧）
 *   2. 比较/逻辑     < > <= >= == !=  && ||（左侧为真值时取 1/0）
 *   3. 加法          + -
 *   4. 乘法          * / // %  以及隐式乘法
 *   5. 一元正负      u- u+
 *   6. 幂            ^ **（右结合：2^3^2 = 2^(3^2) = 512）
 *   7. 后缀          ! （阶乘）  % （百分号，写作 50% = 0.5，与取模区分）
 *   8. 基本单元      数字 / 标识符 / 函数调用 / 括号 / 中括号分组
 *
 * AST 节点类型：
 *   {type:'num', value}
 *   {type:'var', name}
 *   {type:'call', name, args:[]}
 *   {type:'unary', op, arg}
 *   {type:'binary', op, left, right}
 *   {type:'postfix', op, arg}                  后缀：! 阶乘 / percent 百分号
 *   {type:'postfixAssign', op:'++'|'--', name} 后缀自增自减（返回旧值）
 *   {type:'assign', name, op:'=', value}
 *   {type:'group', expr}
 *   {type:'array', items:[]}
 *   {type:'range', start, end, step}
 *   {type:'program', body:[]}
 */
const { tokenize, TT, CalcSyntaxError } = require('./tokenizer');

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '**=', '//=', '&=']);
const CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!=']);
const LOGIC_OPS = new Set(['&&', '||']);
const INPLACE_OPS = new Set(['++', '--']);

class Parser {
  constructor(src) {
    this.src = src;
    this.tokens = tokenize(src);
    this.pos = 0;
  }

  /* ---- token 访问 ---- */
  peek(offset = 0) { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }
  next() { return this.tokens[this.pos++]; }
  at(type, value) {
    const t = this.peek();
    if (t.type !== type) return false;
    return value === undefined || t.value === value;
  }
  atOp(value) { return this.at(TT.OP, value); }
  expect(type, value, what) {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      const got = t.type === TT.EOF ? '表达式结束' : `"${t.raw}"`;
      throw new CalcSyntaxError(`期望 ${what || (value !== undefined ? '"' + value + '"' : type)}，但读到 ${got}`, this.src, t.pos);
    }
    return this.next();
  }
  error(msg, tok) {
    const t = tok || this.peek();
    throw new CalcSyntaxError(msg, this.src, t.pos);
  }

  /* ---- 入口：程序（分号/换行分隔多条语句）---- */
  parseProgram() {
    const body = [];
    while (!this.at(TT.EOF)) {
      // 容错跳过连续分隔符
      while (this.at(TT.SEMI)) this.next();
      if (this.at(TT.EOF)) break;
      const stmt = this.parseStatement();
      // `x=1 y=2` 这类缺少分隔符的写法：赋值语句本身是完整单元，可以接着读下一条
      if (!stmt.isAssignLike && !this.at(TT.SEMI) && !this.at(TT.EOF)) {
        this.error(`多余的记号 "${this.peek().raw}"（多条语句之间请用 ";" 或换行分隔）`);
      }
      body.push(stmt.node);
      if (this.at(TT.SEMI)) this.next();
    }
    return { type: 'program', body };
  }

  parseStatement() {
    const node = this.parseAssign();
    return { node, isAssignLike: node.type === 'assign' };
  }

  /* ---- 赋值 ---- */
  parseAssign() {
    const start = this.pos;
    // 形如 ident (=|+=|... ) expr
    if (this.at(TT.IDENT) && this.peek(1).type === TT.OP && ASSIGN_OPS.has(this.peek(1).value)) {
      const name = this.next().value;
      const op = this.next().value;
      // 复合赋值展开为 x = x <op> value
      if (op !== '=') {
        const rhs = this.parseAssign();
        const baseOp = op === '**=' ? '^' : op.slice(0, -1);
        return {
          type: 'assign', name, op: '=',
          value: { type: 'binary', op: baseOp, left: { type: 'var', name }, right: rhs }
        };
      }
      const value = this.parseAssign();
      return { type: 'assign', name, op: '=', value };
    }
    // 前缀自增自减：++x / --x（等价于 x = x ± 1，返回新值）
    if (this.at(TT.OP) && INPLACE_OPS.has(this.peek().value) &&
        this.peek(1).type === TT.IDENT) {
      this.next();
      const name = this.next().value;
      const baseOp = this.tokens[start].value === '++' ? '+' : '-';
      return {
        type: 'assign', name, op: '=',
        value: { type: 'binary', op: baseOp, left: { type: 'var', name }, right: { type: 'num', value: 1 } }
      };
    }
    this.pos = start;
    return this.parseLogic();
  }

  /* ---- 逻辑/比较（链式比较按数学惯例拒绝，避免 a<b<c 的歧义）---- */
  parseLogic() {
    let left = this.parseComparison();
    while (this.at(TT.OP) && LOGIC_OPS.has(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseComparison();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    if (this.at(TT.OP) && CMP_OPS.has(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseAdditive();
      const node = { type: 'binary', op, left, right };
      if (this.at(TT.OP) && CMP_OPS.has(this.peek().value)) {
        this.error('不支持链式比较（如 a < b < c），请用 and/or 连接两个比较', this.peek(-1));
      }
      return node;
    }
    return left;
  }

  /* ---- 加减 ---- */
  parseAdditive() {
    const left = this.parseMultiplicative();
    // 区间字面量：`1:5` / `1:2:10`（起点:终点 或 起点:步长:终点），交给 calc 层展开
    if (this.at(TT.OP, ':')) {
      const parts = [left];
      while (this.at(TT.OP, ':')) { this.next(); parts.push(this.parseMultiplicative()); }
      if (parts.length === 2) return { type: 'range', start: parts[0], end: parts[1], step: null };
      if (parts.length === 3) return { type: 'range', start: parts[0], step: parts[1], end: parts[2] };
      this.error('区间最多三个部分，形如 `起点:终点` 或 `起点:步长:终点`');
    }
    let node = left;
    while (this.at(TT.OP) && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      node = { type: 'binary', op, left: node, right };
    }
    return node;
  }

  /* ---- 乘除（含隐式乘法已在词法阶段并成 '*'）---- */
  parseMultiplicative() {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type === TT.OP && (t.value === '*' || t.value === '/' || t.value === '//' || t.value === '%')) {
        this.next();
        const right = this.parseUnary();
        left = { type: 'binary', op: t.value, left, right };
        continue;
      }
      // 隐式乘法兜底：万一词法阶段没覆盖（如 ')' 后跟 ident 的边界情形）
      if ((t.type === TT.IDENT || t.type === TT.LPAREN) && this.endsExprNode(left)) {
        const right = this.parseUnary();
        left = { type: 'binary', op: '*', left, right };
        continue;
      }
      break;
    }
    return left;
  }

  endsExprNode(node) {
    return !!node && (node.type === 'num' || node.type === 'var' || node.type === 'call' ||
      node.type === 'group' || node.type === 'array' || node.type === 'postfix');
  }

  /* ---- 一元正负 / 逻辑非 ---- */
  parseUnary() {
    const t = this.peek();
    if (t.type === TT.OP && (t.value === 'u-' || t.value === 'u+')) {
      this.next();
      const arg = this.parseUnary();
      if (t.value === 'u+') return arg;
      return { type: 'unary', op: '-', arg };
    }
    // 前缀 ! = 逻辑非（词法阶段已按位置标成 'not'）
    if (t.type === TT.OP && t.value === 'not') {
      this.next();
      const arg = this.parseUnary();
      return { type: 'unary', op: 'not', arg };
    }
    return this.parsePower();
  }

  /* ---- 幂（右结合）---- */
  parsePower() {
    const base = this.parsePostfix();
    const t = this.peek();
    if (t.type === TT.OP && (t.value === '^' || t.value === '**')) {
      this.next();
      // 右结合：指数部分递归调用 parseUnary 以支持 2^-3
      const exp = this.parseUnary();
      return { type: 'binary', op: '^', left: base, right: exp };
    }
    return base;
  }

  /* ---- 后缀：阶乘、百分号、自增自减 ---- */
  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.type === TT.OP && (t.value === '!' || t.value === 'percent')) {
        // 阶乘 vs 逻辑非：词法已按位置区分（前缀标 not，后缀留 !）
        this.next();
        node = { type: 'postfix', op: t.value === '!' ? '!' : 'percent', arg: node };
        continue;
      }
      if (t.type === TT.OP && INPLACE_OPS.has(t.value)) {
        // 后缀 x++ / x--：仅对变量有意义，等价于返回旧值并把变量加一
        if (node.type !== 'var') this.error(`"${t.value}" 只能作用于变量`, t);
        this.next();
        node = { type: 'postfixAssign', op: t.value, name: node.name };
        continue;
      }
      break;
    }
    return node;
  }

  /* ---- 基本单元 ---- */
  parsePrimary() {
    const t = this.peek();

    if (t.type === TT.NUM) { this.next(); return { type: 'num', value: t.value }; }

    if (t.type === TT.IDENT) {
      this.next();
      // 函数调用
      if (this.at(TT.LPAREN)) {
        const args = this.parseArgs();
        return { type: 'call', name: t.value, args };
      }
      return { type: 'var', name: t.value };
    }

    if (t.type === TT.LPAREN) {
      this.next();
      const expr = this.parseAssign();
      this.expect(TT.RPAREN, undefined, '")"');
      return { type: 'group', expr };
    }

    if (t.type === TT.LBRACKET) {
      this.next();
      const items = [];
      if (!this.at(TT.RBRACKET)) {
        items.push(this.parseAssign());
        while (this.at(TT.COMMA)) { this.next(); items.push(this.parseAssign()); }
      }
      this.expect(TT.RBRACKET, undefined, '"]"');
      return { type: 'array', items };
    }

    if (t.type === TT.EOF) this.error('表达式不完整：末尾缺少操作数');
    this.error(`无法解析的记号 "${t.raw}"`);
  }

  /* ---- 实参列表 ---- */
  parseArgs() {
    this.expect(TT.LPAREN, undefined, '"("');
    const args = [];
    if (!this.at(TT.RPAREN)) {
      args.push(this.parseAssign());
      while (this.at(TT.COMMA)) { this.next(); args.push(this.parseAssign()); }
    }
    this.expect(TT.RPAREN, undefined, '")"');
    return args;
  }
}

function parse(src) {
  const p = new Parser(src);
  return p.parseProgram();
}

/** 解析单个表达式（要求只有一个语句），供需要"单个数值"的工具使用 */
function parseExpression(src) {
  const ast = parse(src);
  if (ast.body.length !== 1) {
    throw new CalcSyntaxError('此处只接受单个表达式（多条语句请用 calc_eval）', src, 0);
  }
  return ast.body[0];
}

module.exports = { parse, parseExpression, Parser, CalcSyntaxError };
