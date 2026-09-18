'use strict';
/**
 * 词法分析器（零依赖）
 *
 * 支持的词法单元：
 *   number  123 / 3.14 / .5 / 1e-3 / 2.5E+8 / 0x1F / 0b1010 / 1_000_000
 *   ident   sin / pi / x / myVar（允许字母、数字、下划线，首字符为字母或下划线）
 *   op      + - * / % ^ ** // ! = ( ) [ ] , ; < > <= >= == != && || 以及一元负号
 *   string  'text' / "text"（供 solver 的参数使用）
 *
 * 隐式乘法：在词法阶段插入 '*' 记号 —— 当"前一个 token 能结束一个表达式"
 * 且"后一个 token 能开始一个表达式"时：
 *   2pi → 2*pi      3(4+5) → 3*(4+5)    2sin(x) → 2*sin(x)
 *   (1+2)(3+4) → (1+2)*(3+4)            pi x → pi*x
 * 注意不会插入的场合：2e-3（数字的一部分，已在数字里处理）、函数调用 sin(x)、
 * 数组下标 [..] 无此语法故不存在歧义。
 */

const { CONSTANT_NAMES } = require('./constants');
const CONSTANT_LOWER = new Set([...CONSTANT_NAMES].map((s) => s.toLowerCase()));
/** 已知常量名（大小写不敏感）——用于 `pi(2)` 这类隐式乘法的判定 */
function isKnownConstant(name) {
  return CONSTANT_LOWER.has(String(name).toLowerCase());
}

const TT = {
  NUM: 'num',
  IDENT: 'ident',
  OP: 'op',
  LPAREN: 'lparen',
  RPAREN: 'rparen',
  LBRACKET: 'lbracket',
  RBRACKET: 'rbracket',
  COMMA: 'comma',
  SEMI: 'semi',
  STRING: 'string',
  EOF: 'eof'
};

/** 多字符运算符须按长度降序匹配 */
const OPS = [
  '**', '//', '<=', '>=', '==', '!=', '&&', '||', '<<', '>>',
  '+', '-', '*', '/', '%', '^', '!', '=', '<', '>', '&', '|', '~', ':'
];

class Token {
  constructor(type, value, pos, raw) {
    this.type = type;
    this.value = value;
    this.pos = pos;
    this.raw = raw === undefined ? String(value) : raw;
  }
}

class CalcSyntaxError extends Error {
  constructor(message, expr, pos) {
    super(message);
    this.name = 'CalcSyntaxError';
    this.expr = expr;
    this.pos = pos;
    if (expr != null && pos != null) this.message = message + '\n' + caretLine(expr, pos);
  }
}

/** 生成指向出错位置的插入符提示行 */
function caretLine(expr, pos) {
  const upto = expr.slice(0, Math.max(0, pos));
  // 折叠换行，保证插入符对齐到可视行
  const flat = upto.replace(/\n/g, ' ');
  const prefix = flat.length > 70 ? '...' + flat.slice(-67) : flat;
  const pad = ' '.repeat(prefix.length);
  const tail = expr.slice(pos, pos + 40).replace(/\n/g, ' ');
  return '  ' + prefix + tail + '\n  ' + pad + '^';
}

function isDigit(c) { return c >= '0' && c <= '9'; }
function isHex(c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
function isIdentStart(c) { return /[A-Za-z_\u4e00-\u9fa5]/.test(c); }
function isIdentPart(c) { return /[A-Za-z0-9_\u4e00-\u9fa5]/.test(c); }

/**
 * 词法分析
 * @param {string} src 表达式源码
 * @param {object} opts { angleMode: 'rad'|'deg' } —— 词法不需要，但保留参数位以便扩展
 * @returns {Token[]}
 */
function tokenize(src, opts = {}) {
  if (typeof src !== 'string') throw new CalcSyntaxError('表达式必须是字符串', String(src), 0);
  const tokens = [];
  let i = 0;
  const n = src.length;

  // 判断"前一个 token 结束了一个完整表达式"——用于隐式乘法
  const endsExpr = (t) => !!t && (
    t.type === TT.NUM || t.type === TT.IDENT ||
    t.type === TT.RPAREN || t.type === TT.RBRACKET ||
    (t.type === TT.OP && t.value === 'percent')
  );
  // 判断"后一个 token 能开始一个表达式"
  const startsExpr = (t) => !!t && (
    t.type === TT.NUM || t.type === TT.IDENT ||
    t.type === TT.LPAREN || t.type === TT.LBRACKET
  );
  const lastReal = () => {
    for (let k = tokens.length - 1; k >= 0; k--) {
      if (tokens[k].type !== TT.OP || (tokens[k].value !== '~')) return tokens[k];
    }
    return null;
  };
  const push = (t) => { tokens.push(t); return t; };

  const eqOpOf = (op) => (op === '=' || op === '==' ? '==' : op + '=');
  const inPlaceOps = new Set(['++', '--']);

  while (i < n) {
    const c = src[i];

    // 空白
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }

    // 注释：# 或 // 到行尾（// 与整除冲突，以"遇到数字/标识符才算整除"区分）
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nxt = src[i + 2];
      // `4//2` 是整除；`4 // 注释` 或行尾的 // 视为注释
      if (!(nxt != null && (isDigit(nxt) || nxt === '.' || isIdentStart(nxt) || nxt === '('))) {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
    }

    // 字符串
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1, buf = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) { buf += src[j + 1]; j += 2; }
        else { buf += src[j]; j++; }
      }
      if (j >= n) throw new CalcSyntaxError('字符串未闭合', src, i);
      tokens.push(new Token(TT.STRING, buf, i, src.slice(i, j + 1)));
      i = j + 1;
      continue;
    }

    // 数字
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i;
      let raw = '';
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        while (i < n && (isHex(src[i]) || src[i] === '_')) { if (src[i] !== '_') raw += src[i]; i++; }
        if (!raw) throw new CalcSyntaxError('十六进制字面量缺少数字', src, start);
        tokens.push(new Token(TT.NUM, parseInt(raw, 16), start, src.slice(start, i)));
        continue;
      }
      if (c === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
        i += 2;
        while (i < n && (src[i] === '0' || src[i] === '1' || src[i] === '_')) { if (src[i] !== '_') raw += src[i]; i++; }
        if (!raw) throw new CalcSyntaxError('二进制字面量缺少数字', src, start);
        tokens.push(new Token(TT.NUM, parseInt(raw, 2), start, src.slice(start, i)));
        continue;
      }
      if (c === '0' && (src[i + 1] === 'o' || src[i + 1] === 'O')) {
        i += 2;
        while (i < n && ((src[i] >= '0' && src[i] <= '7') || src[i] === '_')) { if (src[i] !== '_') raw += src[i]; i++; }
        if (!raw) throw new CalcSyntaxError('八进制字面量缺少数字', src, start);
        tokens.push(new Token(TT.NUM, parseInt(raw, 8), start, src.slice(start, i)));
        continue;
      }
      while (i < n && (isDigit(src[i]) || src[i] === '_')) { if (src[i] !== '_') raw += src[i]; i++; }
      if (src[i] === '.') {
        raw += '.'; i++;
        while (i < n && (isDigit(src[i]) || src[i] === '_')) { if (src[i] !== '_') raw += src[i]; i++; }
      }
      // 指数部分：e/E 后必须跟数字（否则 2e 里的 e 应是常数 e → 隐式乘法）
      if ((src[i] === 'e' || src[i] === 'E')) {
        const save = i;
        let exp = src[i]; i++;
        if (src[i] === '+' || src[i] === '-') { exp += src[i]; i++; }
        if (isDigit(src[i])) {
          while (i < n && isDigit(src[i])) { exp += src[i]; i++; }
          raw += exp;
        } else {
          i = save;   // 回退：把 e 当常数
        }
      }
      const val = parseFloat(raw);
      if (!isFinite(val) && !/^[0-9]/.test(raw)) throw new CalcSyntaxError('非法数字: ' + raw, src, start);
      // 隐式乘法：上一个记号能结束表达式、且它本身不是运算符（否则 7%3 会变成 7%*3）
      const prev = lastReal();
      if (prev && prev.type !== TT.OP && endsExpr(prev)) {
        push(new Token(TT.OP, '*', start, '*'));
      }
      push(new Token(TT.NUM, val, start, src.slice(start, i)));
      continue;
    }

    // 标识符（函数名/常量/变量）
    if (isIdentStart(c)) {
      const start = i;
      let name = '';
      while (i < n && isIdentPart(src[i])) { name += src[i]; i++; }
      const prev = lastReal();
      // 隐式乘法：`2pi`、`3x`。但 `f(` 是函数调用，绝不能插乘号。
      // 判断依据：跳过空白后下一个字符是否为 '(' —— 此时只有"已知常量"才插乘号
      // （如 pi(2) → pi*(2)），函数名交给 parser 走调用路径。
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      const followsCall = src[j] === '(';
      const asMul = prev && endsExpr(prev) && (!followsCall || isKnownConstant(name));
      if (asMul) push(new Token(TT.OP, '*', start, '*'));
      push(new Token(TT.IDENT, name, start, name));
      continue;
    }

    // 括号
    if (c === '(') {
      const prev = lastReal();
      // 前一个 token 是标识符时不插乘号（那是函数调用，由 parser 处理）
      const isCall = prev && prev.type === TT.IDENT;
      if (prev && prev.type !== TT.OP && endsExpr(prev) && !isCall) push(new Token(TT.OP, '*', i, '*'));
      push(new Token(TT.LPAREN, '(', i));
      i++;
      continue;
    }
    if (c === ')') { push(new Token(TT.RPAREN, ')', i)); i++; continue; }
    // 中括号：作为"分组"处理（数组字面量由 parser 在特定位置识别）
    if (c === '[') {
      const prev = lastReal();
      if (prev && prev.type !== TT.OP && endsExpr(prev)) push(new Token(TT.OP, '*', i, '*'));
      push(new Token(TT.LBRACKET, '[', i));
      i++;
      continue;
    }
    if (c === ']') { push(new Token(TT.RBRACKET, ']', i)); i++; continue; }
    if (c === ',') { push(new Token(TT.COMMA, ',', i)); i++; continue; }
    if (c === ';') { push(new Token(TT.SEMI, ';', i)); i++; continue; }

    // 自增自减：取最长匹配，避免 `x++ + 1` 被切成 `x + (+ + 1)`
    if ((c === '+' || c === '-') && src[i + 1] === c) {
      push(new Token(TT.OP, inPlaceOps.has(c + c) ? c + c : c + c, i, c + c));
      i += 2;
      continue;
    }

    // 多字符 / 单字符运算符
    let matched = null;
    for (const op of OPS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    // 复合赋值：+= -= *= /= %= ^= **= //= 以及 &=(按位与赋) 等一律归一化为 `<op>=`
    if (matched && src[i + matched.length] === '=' &&
        ['+', '-', '*', '/', '%', '^', '**', '//', '&', '|'].includes(matched)) {
      push(new Token(TT.OP, eqOpOf(matched), i, matched + '='));
      i += matched.length + 1;
      continue;
    }
    if (matched) {
      // 一元正负号归一化：+/- 出现在"表达式开头或运算符/左括号之后"时标记为一元
      const prev = lastReal();
      const unaryContext = !prev || (prev.type === TT.OP && prev.value !== '!' && prev.value !== '%'
        && prev.value !== 'percent' && prev.value !== '!' && prev.value !== 'not'
        && prev.value !== '++' && prev.value !== '--')
        || prev.type === TT.LPAREN || prev.type === TT.LBRACKET
        || prev.type === TT.COMMA || prev.type === TT.SEMI;
      if (matched === '-' && unaryContext) {
        push(new Token(TT.OP, 'u-', i, '-'));
      } else if (matched === '+' && unaryContext) {
        push(new Token(TT.OP, 'u+', i, '+'));
      } else if (matched === '!' && unaryContext) {
        // 前缀 ! = 逻辑非；后缀 ! = 阶乘（由 parser 按位置区分）
        push(new Token(TT.OP, 'not', i, '!'));
      } else if (matched === '%') {
        // 取模 vs 百分号：右侧出现操作数 → 取模；右侧空缺/运算符 → 百分号
        let k = i + 1;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
        const nc = src[k];
        const hasRhs = nc != null && (isDigit(nc) || nc === '.' || isIdentStart(nc) || nc === '(');
        push(new Token(TT.OP, hasRhs ? '%' : 'percent', i, '%'));
      } else {
        push(new Token(TT.OP, matched, i, matched));
      }
      i += matched.length;
      continue;
    }

    throw new CalcSyntaxError(`无法识别的字符: "${c}"`, src, i);
  }

  tokens.push(new Token(TT.EOF, null, n, ''));
  return tokens;
}

module.exports = { tokenize, Token, TT, CalcSyntaxError, caretLine };
