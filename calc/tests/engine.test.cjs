'use strict';
/**
 * calc 求值引擎测试 —— tokenize → parse → evaluateProgram 全链路，纯数值不依赖外部。
 * 含注入：恶意 JS 风格输入应抛错，绝不执行任意 JS。
 */
const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/utils/parser');
const { evaluateProgram, Context, CalcEvalError } = require('../src/utils/evaluator');
const { CalcSyntaxError } = require('../src/utils/tokenizer');

function lastValue(expr, opts) {
  const ast = parse(expr);
  const rs = evaluateProgram(ast, new Context({ ...(opts || {}), src: expr }));
  return rs[rs.length - 1].value;
}

test('算术主路径：优先级/括号/幂/阶乘', () => {
  assert.strictEqual(lastValue('2+3*4'), 14);
  assert.strictEqual(lastValue('(2+3)*4'), 20);
  assert.strictEqual(lastValue('2^3'), 8);
  assert.strictEqual(lastValue('2^3^2'), 512, '右结合');
  assert.strictEqual(lastValue('5!'), 120);
});

test('多语句变量复用', () => {
  assert.strictEqual(lastValue('a=3; b=4; sqrt(a^2+b^2)'), 5);
});

test('区间字面量', () => {
  assert.deepStrictEqual(lastValue('1:5'), [1, 2, 3, 4, 5]);
});

test('错误路径：除以 0 / 未闭合字符串 / 非法字符', () => {
  assert.throws(() => lastValue('1/0'), /除以 0/);
  assert.throws(() => lastValue("'abc"), CalcSyntaxError);
  assert.throws(() => lastValue('1 @ 2'), /无法识别的字符/);
});

test('注入防护：恶意 JS 风格输入只抛错，不执行（进程仍存活）', () => {
  // process / constructor 不是白名单常量或函数 → 抛错，而非真的退出/访问全局
  assert.throws(() => lastValue('process.exit()'));
  assert.throws(() => lastValue('constructor.constructor("return 1")()'));
  // 未定义变量抛错
  assert.throws(() => lastValue('undefined_var_xyz + 1'), /未定义/);
  // 能走到这里说明 process.exit() 没有真正执行（否则进程已退出）
  assert.ok(true, '求值进程未被恶意输入终止');
});
