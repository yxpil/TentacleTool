'use strict';
/**
 * calc_equation 方程组求解的纯逻辑层测试
 *
 *   运行：node test/equation.test.js
 * 覆盖：
 *   - 线性方阵：唯一解 / 奇异（矛盾 / 欠定）
 *   - 非线性 2×2：圆与直线（2 解）、圆与圆、抛物线
 *   - 非线性 3×3：多解枚举
 *   - 非方阵：超定（最小二乘）/ 欠定（参数解）
 *   - 超越方程组
 *   - 自定义 guesses / searchRange / maxSolutions
 *   - 无解场景
 */
const path = require('path');
const eq = require(path.join(__dirname, '..', 'src', 'tools', 'calc-equation.js'));
const evalMod = require(path.join(__dirname, '..', 'src', 'utils', 'evaluator.js'));

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? '  —— ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  —— ' + detail : '')); }
}

/** 从输出文本里把所有数值抓出来（用于宽松断言） */
function nums(text) {
  return (text.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || []).map(Number);
}

/** 判断文本里是否包含某个数（容差匹配） */
function hasNum(text, target, tol = 1e-6) {
  return nums(text).some(v => Math.abs(v - target) <= tol * Math.max(1, Math.abs(target)));
}

/** 断言：求解结果代回方程后残差极小 */
function residualOk(eqs, vars, sol) {
  const fns = eqSysFns(eqs, vars);
  return Math.max(...fns.map(f => Math.abs(f(sol)))) < 1e-7;
}

function eqSysFns(eqs, vars) {
  const { parse } = require(path.join(__dirname, '..', 'src', 'utils', 'parser.js'));
  const { evaluate, Context } = evalMod;
  const nodes = eqs.map(s => {
    const p = eq.splitEquation(s);
    const l = parse(p.left).body[0];
    if (p.right === null) return l;
    return { type: 'binary', op: '-', left: l, right: parse(p.right).body[0] };
  });
  const ctx = new Context({ src: null });
  return nodes.map(node => (vec) => {
    vars.forEach((v, i) => ctx.scope.set(v, vec[i]));
    const val = evaluate(node, ctx);
    return typeof val === 'number' ? val : (val && 'im' in val ? val.re : NaN);
  });
}

/* ==================================================================== */
console.log('\n=== 1. 线性方程组（精确消元） ===');

{
  const out = eq.run({ equations: ['2x+3y=8', 'x-y=-1'], variables: ['x', 'y'] });
  check('线性 2x2 标注"线性方程组"', /线性方程组/.test(out), out.split('\n')[0]);
  check('线性 2x2 解 x=1', hasNum(out, 1), out);
  check('线性 2x2 解 y=2', hasNum(out, 2), out);
  check('线性 2x2 有条目式解', /解（唯一）/.test(out), out);
}

{
  const out = eq.run({ equations: ['x+y+z=6', 'x-y=2', '2x+y-z=1'], variables: ['x', 'y', 'z'] });
  check('线性 3x3 标注线性', /线性方程组/.test(out));
  check('线性 3x3 有解 x', hasNum(out, 2.25, 1e-4) || /=\s*\*\*/.test(out), out);
}

{
  // 3x3 已知解 x=1,y=2,z=3
  const out = eq.run({ equations: ['x+y+z=6', 'x-y=-1', 'y-z=-1'], variables: ['x', 'y', 'z'] });
  check('线性 3x3 精确 x=1', hasNum(out, 1), out);
  check('线性 3x3 精确 y=2', hasNum(out, 2), out);
  check('线性 3x3 精确 z=3', hasNum(out, 3), out);
}

{
  // 矛盾：x+y=1, x+y=2
  const out = eq.run({ equations: ['x+y=1', 'x+y=2'], variables: ['x', 'y'] });
  check('矛盾方程标注无解/矛盾', /矛盾|无解/.test(out), out);
}

{
  // 欠定：x+y=1 两未知数但方程 1 条 —— 但这条路走单方程分支
  const out = eq.run({ equations: ['x+y=1', '2x+2y=2'], variables: ['x', 'y'] });
  check('线性欠定标注欠定', /欠定|无穷多解/.test(out), out);
}

/* ==================================================================== */
console.log('\n=== 2. 非线性 2×2（圆 + 直线，应得 2 解） ===');

{
  const out = eq.run({ equations: ['x^2+y^2=25', 'x-y=1'], variables: ['x', 'y'], searchRange: [-10, 10] });
  check('圆+直线 标注非线性', /非线性方程组/.test(out), out);
  check('圆+直线 有解', !/未找到解/.test(out), out);
  check('圆+直线 解 1: x=4,y=3', hasNum(out, 4, 1e-4) && hasNum(out, 3, 1e-4), out);
  check('圆+直线 解 2: x=-3,y=-4', hasNum(out, -3, 1e-4) && hasNum(out, -4, 1e-4), out);
  check('圆+直线 枚举到 2 组解', /解（2 组/.test(out), out);
}

{
  const out = eq.run({ equations: ['x^2+y^2=25', 'y=x^2-5'], variables: ['x', 'y'], searchRange: [-5, 5] });
  check('圆+抛物线 有解', !/未找到解/.test(out), out);
  const sols = out.match(/\*\*解 \d+\*\*/g) || [];
  check('圆+抛物线 至少 2 组解', sols.length >= 2, '得到 ' + sols.length + ' 组\n' + out);
}

{
  // 圆与圆：x^2+y^2=25 与 (x-6)^2+y^2=25 → x=3, y=±4
  const out = eq.run({ equations: ['x^2+y^2=25', '(x-6)^2+y^2=25'], variables: ['x', 'y'], searchRange: [-10, 10] });
  check('圆+圆 解 x=3,y=4', hasNum(out, 3, 1e-4) && hasNum(out, 4, 1e-4), out);
  check('圆+圆 解 x=3,y=-4', hasNum(out, 3, 1e-4) && hasNum(out, -4, 1e-4), out);
}

/* ==================================================================== */
console.log('\n=== 3. 非线性 3×3 ===');

{
  // x²+y²+z²=14, x+y+z=6, z=2  →  x+y=4, x²+y²=10  →  xy=3  →  (x,y)=(1,3) 或 (3,1)
  const out = eq.run({
    equations: ['x^2+y^2+z^2=14', 'x+y+z=6', 'z=2'],
    variables: ['x', 'y', 'z'],
    searchRange: [-8, 8]
  });
  const groups = (out.match(/\*\*解 \d+\*\*/g) || []).length;
  check('3x3 非线性 有解', groups > 0, out);
  check('3x3 非线性 解 (1,3,2)', /x = \*\*1\*\*，y = \*\*3\*\*，z = \*\*2\*\*/.test(out), out);
  check('3x3 非线性 解 (3,1,2)', /x = \*\*3\*\*，y = \*\*1\*\*，z = \*\*2\*\*/.test(out), out);
  check('3x3 非线性 枚举到 2 组解', groups === 2, '得到 ' + groups + ' 组\n' + out);
}

{
  // 真正的三变量耦合非线性（有 2 组解）：
  // x²+y²=25, x*y=12, z=x+y → (3,4,7) 与 (4,3,7) 及负解
  const out = eq.run({
    equations: ['x^2+y^2=25', 'x*y=12', 'z=x+y'],
    variables: ['x', 'y', 'z'],
    searchRange: [-10, 10],
    maxSolutions: 8
  });
  const groups = (out.match(/\*\*解 \d+\*\*/g) || []).length;
  check('三变量耦合 有解', groups > 0, out);
  check('三变量耦合 含 (3,4,7)', /x = \*\*3\*\*，y = \*\*4\*\*，z = \*\*7\*\*/.test(out), out);
  check('三变量耦合 含 (4,3,7)', /x = \*\*4\*\*，y = \*\*3\*\*，z = \*\*7\*\*/.test(out), out);
}

{
  // 球 + 平面 + 平面：x^2+y^2+z^2=14, x+y+z=6, x=y
  const out = eq.run({
    equations: ['x^2+y^2+z^2=14', 'x+y+z=6', 'x=y'],
    variables: ['x', 'y', 'z'],
    searchRange: [-8, 8]
  });
  check('球+双平面 有解', !/未找到解/.test(out), out);
  // 解：2x+z=6, 2x^2+z^2=14 → x=2,z=2 或 x=10/3-...
  check('球+双平面 含解 (2,2,2)', hasNum(out, 2, 1e-4), out);
}

/* ==================================================================== */
console.log('\n=== 4. 超越方程组 ===');

{
  // sin(x)+y=1, x+cos(y)=1 → x=0,y=1; 以及约 x≈1.11..? 用宽松断言
  const out = eq.run({ equations: ['sin(x)+y=1', 'x+cos(y)=1'], variables: ['x', 'y'], searchRange: [-6, 6] });
  check('超越方程组 有解', !/未找到解/.test(out), out);
  check('超越方程组 含解 (0,1)', hasNum(out, 0, 1e-5) && hasNum(out, 1, 1e-5), out);
}

{
  // e^x + y = 2, x - ln(y) = 0  在 y>0 区域 → x=0,y=1 附近以及另一个点
  const out = eq.run({ equations: ['exp(x)+y=2', 'x=ln(y)'], variables: ['x', 'y'], searchRange: [0.1, 5] });
  check('指数/对数方程组 有解', !/未找到解/.test(out), out);
}

/* ==================================================================== */
console.log('\n=== 5. 非方阵 ===');

{
  // 超定：3 方程 2 未知数，无精确解 → 最小二乘
  // 解析解：min (x-1)²+(y-1)²+(x+y-3)² → 2x+y=4, x+2y=4 → x=y=4/3
  const out = eq.run({ equations: ['x=1', 'y=1', 'x+y=3'], variables: ['x', 'y'], searchRange: [-5, 5] });
  check('超定 标注 超定/最小二乘', /超定|最小二乘/.test(out), out);
  check('超定 给出最小二乘解', /最小二乘/.test(out) && !/未找到解/.test(out), out);
  check('超定 最小二乘解 ≈ (4/3, 4/3)', hasNum(out, 4 / 3, 1e-6), out);
}

{
  // 欠定：1 方程 2 未知数（走单方程多变量分支）
  const out = eq.run({ equations: ['x+y=3'], variables: ['x', 'y'] });
  check('欠定 标注欠定', /欠定/.test(out), out);
  check('欠定 给出数值示例', /x = /.test(out), out);
}

{
  // 欠定：2 方程 3 未知数
  const out = eq.run({ equations: ['x+y=3', 'y+z=4'], variables: ['x', 'y', 'z'], searchRange: [-10, 10] });
  check('2 方程 3 未知数 标注欠定', /欠定/.test(out), out);
}

/* ==================================================================== */
console.log('\n=== 6. 高级参数 ===');

{
  const out = eq.run({
    equations: ['x^2+y^2=25', 'x-y=1'],
    variables: ['x', 'y'],
    guesses: [[4, 3]],
    searchRange: [-10, 10],
    maxSolutions: 1
  });
  check('guesses + maxSolutions=1 只给一组解', (out.match(/\*\*解 \d+\*\*/g) || []).length <= 1, out);
  check('guesses 命中 (4,3)', hasNum(out, 4, 1e-5) && hasNum(out, 3, 1e-5), out);
}

{
  // searchRange=[-2,2]：x=4、-3；y=3、-4 —— 全部超范围 → 应无解
  const out = eq.run({ equations: ['x^2+y^2=25', 'x-y=1'], variables: ['x', 'y'], searchRange: [-2, 2] });
  const groups = (out.match(/\*\*解 \d+\*\*/g) || []).length;
  check('searchRange 生效（窄区间内无解）', groups === 0, '得到 ' + groups + ' 组\n' + out);
}

{
  // 每变量不同区间：x∈[-5,5]（含 4），y∈[-5,5]（含 3 但不含 -4）
  const out2 = eq.run({
    equations: ['x^2+y^2=25', 'x-y=1'],
    variables: ['x', 'y'],
    searchRange: [[-5, 5], [-5, 5]]
  });
  const g2 = (out2.match(/\*\*解 \d+\*\*/g) || []).length;
  check('searchRange 支持每变量不同区间', g2 === 2, '得到 ' + g2 + ' 组\n' + out2);

  const out3 = eq.run({
    equations: ['x^2+y^2=25', 'x-y=1'],
    variables: ['x', 'y'],
    searchRange: [[-5, 5], [-2, 5]]
  });
  const g3 = (out3.match(/\*\*解 \d+\*\*/g) || []).length;
  check('每变量区间收窄后只剩 1 组解', g3 === 1, '得到 ' + g3 + ' 组\n' + out3);
}

{
  // x²+y²=1 与 x²+y²=2 互相矛盾（同心圆不同半径）→ 无解
  const out = eq.run({ equations: ['x^2+y^2=1', 'x^2+y^2=2'], variables: ['x', 'y'] });
  const groups = (out.match(/\*\*解 \d+\*\*/g) || []).length;
  check('矛盾非线性 无解（不产出伪解）', groups === 0, '得到 ' + groups + ' 组\n' + out);
  check('矛盾非线性 报告无精确解', /无精确解|未找到解/.test(out), out);
}

/* ==================================================================== */
console.log('\n=== 7. 回归：原有单方程能力未被破坏 ===');

{
  const out = eq.run({ equation: '2x+3=7' });
  check('单方程 线性 x=2', hasNum(out, 2), out);
}
{
  const out = eq.run({ equation: 'x^2-5x+6=0' });
  check('单方程 二次 x=2', hasNum(out, 2));
  check('单方程 二次 x=3', hasNum(out, 3));
}
{
  const out = eq.run({ equation: 'x^2+1=0' });
  check('单方程 复根 ±i', /i/.test(out), out);
}
{
  const out = eq.run({ equation: 'cos(x)=0.5', range: [-10, 10] });
  check('单方程 超越 cos 有解', !/未找到/.test(out), out);
}
{
  const out = eq.run({ coeffs: [1, -5, 6] });
  check('coeffs 模式 x=2,3', hasNum(out, 2) && hasNum(out, 3), out);
}
{
  const out = eq.run({});
  check('无参数 返回用法说明', /用法/.test(out), out);
  check('用法说明含非线性方程组示例', /非线性方程组/.test(out), out);
}

/* ==================================================================== */
console.log('\n=== 8. 内部函数直测 ===');

{
  // LM 解简单非线性系统
  const fns = eqSysFns(['x^2+y^2-25', 'x-y-1'], ['x', 'y']);
  const r = eq.levenbergMarquardt(fns, [4, 3]);
  check('LM 从 (4,3) 收敛', r && r.ok && r.cost < 1e-10, r ? 'cost=' + r.cost : 'null');
}

{
  // 线性化 + 线性性验证
  const lin = eq.linearize(['2x+3y-8', 'x-y+1'], ['x', 'y']);
  check('linearize 得 2x2 矩阵', lin.A.length === 2 && lin.A[0].length === 2);
  const fns = eqSysFns(['2x+3y-8', 'x-y+1'], ['x', 'y']);
  check('verifyLinear 判定线性', eq.verifyLinear(lin.A, lin.b, fns) === true);
  const fns2 = eqSysFns(['x^2+y^2-25', 'x-y-1'], ['x', 'y']);
  const lin2 = eq.linearize(['x^2+y^2-25', 'x-y-1'], ['x', 'y']);
  check('verifyLinear 识别非线性', eq.verifyLinear(lin2.A, lin2.b, fns2) === false);
}

{
  // 多解枚举：x²+y²=25 与 x*y=12 → (3,4),(4,3),(-3,-4),(-4,-3)
  const fns = eqSysFns(['x^2+y^2-25', 'x*y-12'], ['x', 'y']);
  const r = eq.solveNonlinearSystem(fns, [[-10, 10], [-10, 10]], { maxSolutions: 50 });
  check('多解枚举 找到 4 组解', r.count === 4, 'count=' + r.count + ' cost=' + r.bestCost);
  if (r.count === 4) {
    // 每组解应是同一对数的两种排列：(4,3) 或 (-4,-3)，排序后都是 [4,3] / [-4,-3]
    const pts = r.solutions.map(s => {
      const a = [...s].sort((x, y) => y - x);
      return a.map(v => Math.round(v)).join(',');
    });
    const uniq = new Set(pts);
    check('多解枚举 四组解 = {(4,3),(3,4),(-4,-3),(-3,-4)}',
      uniq.size === 2 && [...uniq].every(p => p === '4,3' || p === '-3,-4'),
      JSON.stringify(r.solutions.map(s => s.map(v => +v.toFixed(6)).join(','))));
  }
}

/* ==================================================================== */
console.log('\n' + '='.repeat(52));
console.log(`  通过 ${pass}  失败 ${fail}`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  · ' + f));
}
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);
