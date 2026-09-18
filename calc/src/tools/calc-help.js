'use strict';
/**
 * calc_help：语法帮助
 *
 * 按 topic 分节返回，避免一次性把全部函数表灌进上下文。
 * topics: syntax | operators | functions | constants | complex | angle | units | equation | matrix | examples | all
 */
const { FUNCTIONS } = require('../utils/functions');
const { CONSTANTS } = require('../utils/constants');
const { CATEGORIES, categoryList } = require('./calc-convert');

const TOPICS = [
  'syntax', 'operators', 'functions', 'constants', 'complex',
  'angle', 'units', 'equation', 'matrix', 'examples'
];

/* ======================== 各节内容 ======================== */

function secSyntax() {
  return `### syntax 基本语法

\`\`\`
calc_eval(expr="2+3*4")                     普通算式
calc_eval(expr="a=3; b=4; sqrt(a^2+b^2)")   多语句（; 或换行分隔），变量可复用
calc_eval(expr="x=0.1+0.2; x")              变量赋值
calc_eval(expr="x=1; x+=5; x")              复合赋值：+= -= *= /= %= ^=
calc_eval(expr="x=1; x++; x")               自增自减：x++ / x-- / ++x / --x
calc_eval(expr="f(x)=x^2")                  注意：不支持自定义函数，请直接写表达式
\`\`\`

**数字字面量**
| 写法 | 含义 |
|---|---|
| \`123\` \`3.14\` \`.5\` | 十进制 |
| \`1e-3\` \`6.02e23\` \`2.5E+8\` | 科学计数 |
| \`0xff\` \`0b1010\` \`0o17\` | 十六/二/八进制 |
| \`1_000_000\` | 下划线分隔（可读性） |

**隐式乘法**：\`2pi\` \`3x\` \`2(3+4)\` \`(1+2)(3+4)\` \`pi(2)\` 都会自动插入乘号。
但 \`sin(x)\` 是函数调用，不会变成 \`sin*(x)\`。

**注释**：\`#\` 或 \`//\` 到行尾。

**区间字面量**：\`1:5\` → [1,2,3,4,5]；\`1:2:9\` → [1,3,5,7,9]（起点:步长:终点）。
可直接喂给聚合函数：\`sum(1:100)\`、\`avg(1:10)\`。`;
}

function secOperators() {
  return `### operators 运算符（按优先级低 → 高）

| 优先级 | 运算符 | 说明 |
|---|---|---|
| 1 | \`=\` \`+=\` \`-=\` \`*=\` \`/=\` \`%=\` \`^=\` | 赋值（右结合） |
| 2 | \`\\|\\|\` \`&&\` | 逻辑或/与（短路，真=1 假=0） |
| 3 | \`<\` \`>\` \`<=\` \`>=\` \`==\` \`!=\` | 比较（结果 1/0） |
| 4 | \`+\` \`-\` | 加减 |
| 5 | \`*\` \`/\` \`//\` \`%\` | 乘、除、整除、取模 |
| 6 | \`-\` \`+\` \`!\` | 一元负/正、逻辑非（前缀） |
| 7 | \`^\` \`**\` | 幂（**右结合**：\`2^3^2 = 2^9 = 512\`） |
| 8 | \`!\` \`%\` | 后缀：阶乘、百分号 |

**要点**
- \`-2^2 = -4\`（一元负号优先级低于幂，符合数学惯例）；要 \`4\` 请写 \`(-2)^2\`
- \`2^-1\` 合法（指数可用一元负号）
- \`//\` 是向下取整整除：\`-7//2 = -4\`；\`7//2 = 3\`
- \`%\` 取模结果非负：\`-1%3 = 2\`（数论惯例，不是 JS 的 -1）
- \`50%\` = 0.5（后缀百分号）；\`7%3\` = 1（中缀取模）—— 按右侧有无操作数区分
- \`5!\` = 120（阶乘）；\`!0\` = 1（逻辑非）—— 按前缀/后缀区分
- 不支持链式比较 \`a<b<c\`，请用 \`a<b && b<c\``;
}

/** 在注册表里按名字找函数（大小写不敏感），返回 { realName, def } */
function findFn(name) {
  if (Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) return { realName: name, def: FUNCTIONS[name] };
  const lower = String(name).toLowerCase();
  for (const k of Object.keys(FUNCTIONS)) {
    if (k.toLowerCase() === lower) return { realName: k, def: FUNCTIONS[k] };
  }
  return null;
}

function secFunctions() {
  // 按类别分组展示（注册表里没有显式分类，这里按 help 文本粗分类）
  const groups = {
    '三角': ['sin', 'cos', 'tan', 'sec', 'csc', 'cot'],
    '反三角': ['asin', 'acos', 'atan', 'atan2'],
    '双曲': ['sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh'],
    '指数对数': ['exp', 'ln', 'log', 'log2', 'log10'],
    '幂与根': ['sqrt', 'cbrt', 'root', 'pow'],
    '取整与符号': ['abs', 'floor', 'ceil', 'round', 'trunc', 'sign', 'frac'],
    '阶乘与组合': ['fact', 'gamma', 'lgamma', 'nCr', 'nPr', 'fib'],
    '数论': ['gcd', 'lcm', 'isprime', 'nextprime', 'mod', 'idiv'],
    '统计': ['sum', 'avg', 'mean', 'product', 'min', 'max', 'median', 'mode', 'variance', 'stdev', 'pstdev', 'count'],
    '复数与极坐标': ['conj', 'conjugate', 'arg', 're', 'real', 'im', 'imag', 'polar'],
    '杂项': ['hypot', 'radians', 'degrees', 'deg', 'clamp', 'lerp']
  };
  const lines = ['### functions 函数清单', ''];

  const shown = new Set();
  for (const [label, names] of Object.entries(groups)) {
    const items = [];
    for (const n of names) {
      const hit = findFn(n);
      if (!hit) continue;
      shown.add(hit.realName.toLowerCase());
      const def = hit.def;
      const argc = def.min === def.max ? `${def.min}` : (def.max === Infinity ? `${def.min}+` : `${def.min}-${def.max}`);
      items.push(`  ${hit.realName}(${argc === '1' ? 'x' : '...'})`.padEnd(20) + def.help);
    }
    if (items.length) {
      lines.push(`**${label}**`);
      lines.push('```');
      lines.push(...items);
      lines.push('```');
      lines.push('');
    }
  }

  // 剩下没归类到的
  const rest = Object.keys(FUNCTIONS).filter(k => !shown.has(k.toLowerCase()));
  if (rest.length) {
    lines.push('**其他**');
    lines.push('```');
    for (const n of rest) {
      const def = FUNCTIONS[n];
      const argc = def.min === def.max ? `${def.min}` : (def.max === Infinity ? `${def.min}+` : `${def.min}-${def.max}`);
      lines.push(`  ${n}(${argc === '1' ? 'x' : '...'})`.padEnd(20) + def.help);
    }
    lines.push('```');
    lines.push('');
  }

  lines.push(`> 函数名大小写不敏感；别名：arcsin/arccos/arctan、lg→log10、average→avg、std/stddev→stdev、c→nCr、p→nPr。`);
  lines.push(`> 共 ${Object.keys(FUNCTIONS).length} 个函数。`);
  return lines.join('\n');
}

function secConstants() {
  const groups = {
    '数学': ['pi', 'π', 'tau', 'τ', 'e', 'phi', 'φ', 'golden', 'i', 'j', 'inf', 'infinity', 'nan'],
    '常用根与对数': ['sqrt2', 'sqrt3', 'sqrt5', 'ln2', 'ln10', 'log2e', 'log10e'],
    '物理常量': ['c', 'g', 'G', 'h', 'hbar', 'k', 'Na', 'R', 'qe', 'me', 'mp', 'atm', 'au', 'ly']
  };
  const lines = ['### constants 常量', ''];
  for (const [label, names] of Object.entries(groups)) {
    const items = [];
    for (const n of names) {
      if (!Object.prototype.hasOwnProperty.call(CONSTANTS, n)) continue;
      const v = CONSTANTS[n];
      const vs = typeof v === 'object' ? `${v.re}${v.im >= 0 ? '+' : '-'}${Math.abs(v.im)}i` : String(v);
      items.push(`  ${n}`.padEnd(12) + vs);
    }
    if (items.length) {
      lines.push(`**${label}**`);
      lines.push('```');
      lines.push(...items);
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('> 常量名大小写不敏感（PI / Pi / pi 均可）。');
  return lines.join('\n');
}

function secComplex() {
  return `### complex 复数

**写法**：直接写 \`3+4i\`，或 \`i\` / \`j\` 作虚数单位。

\`\`\`
calc_eval(expr="sqrt(-4)")          → 2i
calc_eval(expr="(1+i)/(1-i)")       → i
calc_eval(expr="ln(-1)")            → πi
calc_eval(expr="exp(i*pi)")         → -1       欧拉公式
calc_eval(expr="abs(3+4i)")         → 5        模
calc_eval(expr="conj(3+4i)")        → 3-4i     共轭
calc_eval(expr="arg(1+i)")          → π/4      辐角
calc_eval(expr="re(3+4i)")          → 3        实部
calc_eval(expr="im(3+4i)")          → 4        虚部
calc_eval(expr="polar(3+4i)")       → [5, 0.927]  极坐标 [模, 辐角]
calc_eval(expr="(2+3i)+(4-5i)")     → 6-2i
\`\`\`

**规则**
- 实数运算走快路径；一旦出现虚部自动升级复数，虚部归零则退回实数
- \`sqrt(-4)\`、\`ln(-1)\`、\`asin(2)\` 等在实数域无定义时自动给复数主值
- 纯虚数显示为 \`i\` / \`-2i\`（不写 \`0+1i\`）
- 大多数统计/数论函数只接受实数，收到复数会明确报错`;
}

function secAngle() {
  return `### angle 角度制

\`calc_eval\` 的 \`angleMode\` 参数（默认 \`rad\`）：

| 值 | 说明 |
|---|---|
| \`rad\` | 弧度（默认） |
| \`deg\` | 角度 |
| \`grad\` | 百分度 |

\`\`\`
calc_eval(expr="sin(pi/6)")                          rad → 0.5
calc_eval(expr="sin(30)", angleMode="deg")           deg → 0.5
calc_eval(expr="asin(0.5)", angleMode="deg")         deg → 30
\`\`\`

**与模式无关的显式换算**（推荐，避免记错模式）：
\`\`\`
calc_eval(expr="sin(deg(90))")      → 1     deg() = 把角度当弧度用
calc_eval(expr="sin(radians(30))")  → 0.5
calc_eval(expr="radians(180)")      → π
calc_eval(expr="degrees(pi)")       → 180
\`\`\`
\`deg()\` / \`radians()\` 在任何模式下都返回相同的物理角度，因此 \`sin(deg(90))\` 恒为 1。`;
}

function secUnits() {
  const cats = categoryList();
  const lines = ['### units 单位换算', ''];
  lines.push('用 `calc_convert`：');
  lines.push('```');
  lines.push('calc_convert(value=100, from="km/h", to="m/s")');
  lines.push('calc_convert(value=1, from="GB", to="MB")');
  lines.push('calc_convert(value=37, from="c", to="f")        温度用 c/f/k/r');
  lines.push('calc_convert(list=true)                          列出全部单位');
  lines.push('calc_convert(list=true, category="length")       只看一类');
  lines.push('```');
  lines.push('');
  lines.push(`**支持的类别（${cats.length} 类）:**`);
  lines.push('');
  for (const c of cats) {
    if (c === 'temperature') { lines.push(`- temperature：c(°C) f(°F) k(K) r(°R)`); continue; }
    const u = CATEGORIES[c];
    const names = Object.keys(u.units);
    lines.push(`- ${c}（基准 ${u.base}，${names.length} 个单位）：${names.slice(0, 14).join(', ')}${names.length > 14 ? ' ...' : ''}`);
  }
  lines.push('');
  lines.push('> 中英文单位名都支持（如 公里 / 米 / 斤 / 亩 / 摄氏度）。');
  return lines.join('\n');
}

function secEquation() {
  return `### equation 方程求解

用 \`calc_equation\`，自动判型：

\`\`\`
calc_equation(equation="2x+3=7")                        线性
calc_equation(equation="x^2-5x+6=0")                    二次（给解析解）
calc_equation(equation="x^3-6x^2+11x-6=0")              高次（实根 + 复根）
calc_equation(equation="cos(x)=0.5", range=[-10,10])    超越方程（数值求根）
calc_equation(equation="x^2+1=0")                       只有复根时给出 ±i
calc_equation(coeffs=[1,-5,6])                          直接给系数（降幂）
\`\`\`

#### 联立方程组（多方程求解）

\`\`\`
# 线性方阵 → 高斯消元，精确解 + 代回验证
calc_equation(equations=["2x+3y=8","x-y=-1"], variables=["x","y"])
#   → x=1, y=2

# 非线性 → 阻尼最小二乘 + 多起点，自动枚举多组解
calc_equation(equations=["x^2+y^2=25","x-y=1"], variables=["x","y"])
#   → 解 1: x=4, y=3     解 2: x=-3, y=-4

# 三变量耦合
calc_equation(equations=["x^2+y^2+z^2=14","x+y+z=6","z=2"], variables=["x","y","z"])
#   → (x,y,z) = (1,3,2) 与 (3,1,2)

# 超越方程组
calc_equation(equations=["sin(x)+y=1","x+cos(y)=1"], variables=["x","y"], searchRange=[-6,6])

# 非方阵：3 方程 2 未知数 → 最小二乘解
calc_equation(equations=["x=1","y=1","x+y=3"], variables=["x","y"])
#   → x=y=4/3（使残差平方和最小）

# 欠定：2 方程 3 未知数 → 最小范数解，并提示解集维数
calc_equation(equations=["x+y=3","y+z=4"], variables=["x","y","z"])
\`\`\`

**方程组可选参数**

| 参数 | 作用 |
|---|---|
| \`searchRange=[lo,hi]\` | 多解搜索范围，默认 \`[-10,10]\`（可给 \`[[lox,hix],[loy,hiy]]\` 每变量不同） |
| \`guesses=[[1,1],[3,-2]]\` | 自定义初值，定位特定分支的解 |
| \`maxSolutions=n\` | 最多返回多少组解（默认 50） |

**工作原理**
- 把 \`lhs = rhs\` 变成 \`f(x) = lhs - rhs\`
- 单方程：先用采样插值判断是不是多项式，是则给出**精确**系数并用 Durand-Kerner 求全部复根；
  不是多项式则在整个区间扫描符号变化 → 二分 + 牛顿精化
- 方程组先做**线性性试探**：若恰好方阵且确实是线性的 → 直接高斯消元（精确、不迭代）；
  矩阵奇异时区分"矛盾（无解）"与"欠定（无穷多解）"，矛盾情形给最小二乘近似解
- 其余情形（非线性 / 非方阵）→ **阻尼最小二乘（Levenberg-Marquardt）** 迭代，
  在搜索框内撒一批起点分别收敛，再去重，从而**枚举出多组解**；
  解不出来时按坐标轴扫描找残差低谷兜底
- 每个解都附**代回验证表**（各方程残差），数值解的可信度一目了然

**注意**
- 单方程的数值求根只覆盖指定区间，默认 \`[-50,50]\`，漏根时请放大 range
- 方程组的解是**数值迭代**结果：可能有遗漏（尤其重根 / 切线相切处，或孤立解在起点网格外），
  放大 \`searchRange\` 或用 \`guesses\` 指定初值可改善
- 方程组只求**实数解**；需要复根请用单方程模式
- 非线性方程组的解不保证全部找到 —— 多起点法覆盖性有限，这是数值方法的固有局限`;
}

function secMatrix() {
  return `### matrix 矩阵运算

用 \`calc_matrix\`，矩阵是二维数组：

\`\`\`
calc_matrix(op="add",       a=[[1,2],[3,4]], b=[[5,6],[7,8]])
calc_matrix(op="sub",       a=[[1,2],[3,4]], b=[[5,6],[7,8]])
calc_matrix(op="mul",       a=[[1,2],[3,4]], b=[[5,6],[7,8]])
calc_matrix(op="scale",     a=[[1,2],[3,4]], k=3)
calc_matrix(op="transpose", a=[[1,2,3],[4,5,6]])
calc_matrix(op="det",       a=[[1,2],[3,4]])
calc_matrix(op="inv",       a=[[1,2],[3,4]])
calc_matrix(op="rank",      a=[[1,2],[3,4]])
calc_matrix(op="trace",     a=[[1,2],[3,4]])
calc_matrix(op="solve",     a=[[2,3],[1,-1]], b=[8,-1])    解 Ax=b
calc_matrix(op="eig",       a=[[2,0],[0,3]])                特征值
\`\`\`

**说明**
- \`mul\` 要求左列数 = 右行数，报错会讲清楚形状
- \`det\`/\`inv\`/\`trace\`/\`eig\` 要求方阵
- \`inv\` 会额外校验 \`A·A⁻¹\` 与单位阵的偏差
- \`solve\` 的 b 是一维数组
- \`eig\` 用幂迭代 + 收缩，适合主特征值明显的情形；重根/复特征值可能不准`;
}

function secExamples() {
  return `### examples 常见用法

**日常计算**
\`\`\`
calc_eval(expr="(1+2.5)*3/4 - 0.5")
calc_eval(expr="2^10")
calc_eval(expr="100!")
calc_eval(expr="sin(pi/4)^2 + cos(pi/4)^2")     恒等式验证 → 1
\`\`\`

**复利 / 金融**
\`\`\`
calc_eval(expr="10000*(1+0.05)^10")              本金 1 万，5% 年利率，10 年
calc_eval(expr="10000*(1+0.05/12)^(12*10)")      按月复利
\`\`\`

**统计**
\`\`\`
calc_eval(expr="sum(1:100)")                     1 到 100 求和 → 5050
calc_eval(expr="avg(85,92,78,95,88)")
calc_eval(expr="stdev(1,2,3,4,5)")
calc_eval(expr="median([3,1,4,1,5,9,2,6])")
\`\`\`

**数论**
\`\`\`
calc_eval(expr="gcd(1071, 462)")                 → 21
calc_eval(expr="lcm(12, 18)")                    → 36
calc_eval(expr="isprime(97)")                    → 1
calc_eval(expr="nextprime(100)")                 → 101
\`\`\`

**物理**
\`\`\`
calc_eval(expr="0.5*2*3^2")                      动能 = ½mv²
calc_eval(expr="G*5.97e24*1.99e30/1.5e11^2")     万有引力
\`\`\`

**单位 + 方程 + 矩阵**
\`\`\`
calc_convert(value=100, from="km/h", to="m/s")
calc_equation(equation="x^2-5x+6=0")
calc_matrix(op="mul", a=[[1,2],[3,4]], b=[[5],[6]])
\`\`\`

**典型工作流**：先 calc_help(topic="...") 只取需要的一节 → 再用 calc_eval 算。`;
}

/* ======================== 组装 ======================== */

const SECTIONS = {
  syntax: secSyntax,
  operators: secOperators,
  functions: secFunctions,
  constants: secConstants,
  complex: secComplex,
  angle: secAngle,
  units: secUnits,
  equation: secEquation,
  matrix: secMatrix,
  examples: secExamples
};

function overview() {
  return `## calc_help 科学计算器语法帮助

按 topic 取具体某一节（**建议按需取，省上下文**）：

| topic | 内容 |
|---|---|
| \`syntax\` | 基本语法、数字字面量、隐式乘法、区间 |
| \`operators\` | 运算符优先级、\`//\` \`%\` \`!\` 的区分 |
| \`functions\` | 全部函数清单（按类别） |
| \`constants\` | 数学常量与物理常量 |
| \`complex\` | 复数运算 |
| \`angle\` | 角度制与换算 |
| \`units\` | 单位换算（calc_convert） |
| \`equation\` | 方程求解 / **联立方程组（线性·非线性·多解枚举）** |
| \`matrix\` | 矩阵运算（calc_matrix） |
| \`examples\` | 常见用法与工作流 |

调用方式：\`calc_help(topic="functions")\`；\`calc_help(topic="all")\` 一次拿全部。

**五个工具速查**
- \`calc_eval\` — 表达式求值（变量、复数、函数、多语句）
- \`calc_convert\` — 单位换算
- \`calc_equation\` — 方程/方程组求解
- \`calc_matrix\` — 矩阵运算
- \`calc_help\` — 本帮助`;
}

function run(args = {}) {
  const topic = args.topic ? String(args.topic).toLowerCase().trim() : null;

  if (!topic) return overview();

  if (topic === 'all' || topic === '*') {
    const parts = [overview(), ''];
    for (const t of TOPICS) {
      parts.push(SECTIONS[t]());
      parts.push('');
    }
    return parts.join('\n');
  }

  const key = TOPICS.find(t => t === topic);
  if (!key) {
    return `未知 topic "${topic}"。可用: ${TOPICS.join(', ')}, all\n\n` + overview();
  }
  return SECTIONS[key]();
}

module.exports = { run, TOPICS };
