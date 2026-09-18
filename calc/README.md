# Calc

科学计算器 MCP 服务器 —— **让 AI 能算复杂公式和数学表达式**。

零依赖（纯 Node 原生模块，手写词法/语法/求值引擎），MCP Streamable HTTP 协议（2025-03-26）。

## 解决什么问题

LLM 直接做算术容易出错，复杂的数学表达式更是力不从心（浮点噪声、优先级、复数、方程求根）。
Calc 提供一台**真正的科学计算器**：完整的表达式引擎 + 约 100 个函数 + 复数 + 方程求解 + 矩阵运算 + 单位换算，
结果经过浮点噪声清理并附带分数/无理数的友好写法。

## 工具一览

| 工具 | 用途 | 亮点 |
|------|------|------|
| `calc_eval` | 表达式求值 | 多语句变量复用、复数、~100 函数、40 常量、隐式乘法、角度制 |
| `calc_convert` | 单位换算 | 13 类 / 400+ 单位，中英文单位名，温度非线性处理 |
| `calc_equation` | 方程与方程组 | 自动判型：多项式给解析根（含复根），超越方程数值求根 |
| `calc_matrix` | 矩阵运算 | 加/减/乘/数乘/转置/行列式/逆/秩/迹/解 Ax=b/特征值 |
| `calc_help` | 语法帮助 | 按 topic 分节返回，避免一次性灌满上下文 |

## 快速开始

```powershell
cd calc
node src\index.js        # 或直接运行 start.bat（端口 8345）
```

MCP 客户端配置（Claude / Cursor / WorkBuddy 等）：

```json
{
  "mcpServers": {
    "calc": {
      "url": "http://127.0.0.1:8345/"
    }
  }
}
```

端口可用环境变量 `CALC_PORT` 覆盖（`start.bat` 默认 8345，与 neton 8341 / webview 8342 / search 8343 / find 8344 错开）。

## 使用示例

### 表达式求值

```
calc_eval(expr="2+3*4")                                    → 14
calc_eval(expr="sin(pi/4)^2 + cos(pi/4)^2")                → 1        三角恒等式
calc_eval(expr="a=3; b=4; sqrt(a^2+b^2)")                  → 5        多语句 + 变量
calc_eval(expr="x=0.1+0.2; x")                             → 0.3      浮点噪声已清理
calc_eval(expr="10000*(1+0.05/12)^(12*10)")                → 16470.0949769   按月复利
calc_eval(expr="sum(1:100)")                               → 5050     区间字面量
calc_eval(expr="2^3^2")                                    → 512      幂右结合
calc_eval(expr="-2^2")                                     → -4       一元负号优先级低于幂
calc_eval(expr="gcd(1071,462)")                            → 21
calc_eval(expr="sin(deg(90))")                             → 1        与角度制无关的显式换算
calc_eval(expr="sin(30)", angleMode="deg")                 → 0.5
```

### 复数

```
calc_eval(expr="sqrt(-4)")            → 2i
calc_eval(expr="(1+i)/(1-i)")         → i
calc_eval(expr="ln(-1)")              → πi
calc_eval(expr="exp(i*pi)")           → -1        欧拉公式
calc_eval(expr="abs(3+4i)")           → 5
calc_eval(expr="conj(3+4i)")          → 3-4i
calc_eval(expr="polar(3+4i)")         → [5, 0.927295218002]
calc_eval(expr="sqrt(-4) * ln(-1)")   → -2π
```

### 单位换算

```
calc_convert(value=100, from="km/h", to="m/s")     → 27.7777777778
calc_convert(value=1, from="GB", to="MB")          → 1024
calc_convert(value=37, from="c", to="f")           → 98.6
calc_convert(value=1, from="斤", to="kg")          → 0.5
calc_convert(value=1, from="atm", to="psi")        → 14.6959487755
calc_convert(list=true, category="length")         # 列出该类全部单位
```

### 方程求解

```
calc_equation(equation="2x+3=7")                              → x = 2
calc_equation(equation="x^2-5x+6=0")                          → x = 2, 3
calc_equation(equation="x^3-6x^2+11x-6=0")                    → x = 1, 2, 3
calc_equation(equation="x^2+1=0")                             → x = ±i
calc_equation(equation="cos(x)=0.5", range=[-10,10])          → 6 个实根
calc_equation(coeffs=[1,-5,6])                                → x = 2, 3
calc_equation(equations=["2x+3y=8","x-y=-1"], variables=["x","y"])  → x=1, y=2
```

### 矩阵运算

```
calc_matrix(op="mul",  a=[[1,2],[3,4]], b=[[5,6],[7,8]])   → [[19,22],[43,50]]
calc_matrix(op="det",  a=[[1,2],[3,4]])                    → -2
calc_matrix(op="inv",  a=[[1,2],[3,4]])                    → [[-2,1],[1.5,-0.5]]
calc_matrix(op="rank", a=[[1,2],[2,4]])                    → 1
calc_matrix(op="solve", a=[[2,3],[1,-1]], b=[8,-1])        → x = [1, 2]
calc_matrix(op="eig",  a=[[2,0],[0,3]])                    → λ = 3, 2
```

## 工作原理

### 表达式引擎（手写，四阶段）

```
源码 ──tokenize──▶ 记号流 ──Parser──▶ AST ──evaluate──▶ 值 ──format──▶ 字符串
```

| 阶段 | 文件 | 职责 |
|------|------|------|
| 词法 | `utils/tokenizer.js` | 数字字面量（含 `0x`/`0b`/`0o`/下划线/科学计数）、隐式乘法插入、一元符号归一化、`%` `!` 的前后缀判定 |
| 语法 | `utils/parser.js` | 递归下降，优先级：赋值 → 逻辑/比较 → 加减 → 乘除 → 一元 → 幂（右结合）→ 后缀 → 基本单元 |
| 求值 | `utils/evaluator.js` | 作用域链、角度制换算、逻辑短路、浮点噪声清理、编辑距离拼写提示 |
| 格式化 | `utils/format.js` | 整数快路径、噪声归零、科学计数、连分数找分数、无理数识别（`√2`/`π`/`φ`）、复数与纯虚数简写 |

### 几个刻意的设计

**隐式乘法但不动函数调用**：`2pi` → `2*pi`、`3(4+5)` → `3*(4+5)`、`(1+2)(3+4)` → 相乘，
但 `sin(x)` 保持函数调用。判定依据是"标识符后是否紧跟 `(`" —— 是则视为调用；若该标识符是
已知常量（`pi(2)`）才插入乘号。

**`%` 与 `!` 按位置消歧**：词法阶段看右侧有无操作数 —— `7%3` 是取模，`50%` 是百分号；
看见 `!` 在表达式开头（或运算符后）标为逻辑非，否则留作后缀阶乘。

**实数快路径 + 复数自动升级**：绝大多数运算走 `Number`，只有出现虚部才升级 `{re, im}`；
虚部归零时 `simp()` 退回实数。三角/对数等函数在实数域返回 `NaN` 时自动切复数分支，
于是 `sqrt(-4)` → `2i`、`ln(-1)` → `πi`、`asin(2)` → 复数主值。

**浮点噪声清理让结果像计算器**：`EPS = 1e-12` 归零噪声，因此 `sqrt(2)^2 = 2`、`sin(pi) = 0`、
`0.1+0.2 = 0.3`（而不是 `0.30000000000000004`）。输出另附连分数推出的分数或常见无理数写法。

**数论惯例的取模**：`-1 % 3 = 2`（非负），不同于 JS 的 `-1`。

**上下文注入不进数据**：函数注册表约定 `fn(...args, ctx)`，求值器把 `markCtx(ctx)` 追加在末尾，
不定参函数据 `stripCtx()` 剔除，避免 `avg(1,2,3)` 把 ctx 当成第 4 个数字。固定形参的可选参数
（如 `log(x[, base])`）同样要先 `stripCtx` 再判断缺省。

### 方程求解怎么判型

1. 把 `lhs = rhs` 变成残差函数 `f(x) = lhs - rhs`
2. **多项式检测**：在 deg = 1..8 上等距采样，用高斯消元解范德蒙德方程组得候选系数，
   再用额外采样点验证。命中则用 **Durand-Kerner** 迭代求**全部复根**（实数解与复数解分开列出）
3. **非多项式**：在区间内扫描符号变化（默认 `[-50, 50]`，可传 `range`），
   对每个变号区间二分 + 牛顿精化，最后按相对阈值去重
4. 线性方程组对每条方程采样 `n+1` 次确定系数矩阵（要求线性），再用带部分主元的高斯消元求解；
   奇异矩阵会明确报"无唯一解"

### 单位换算的数据结构

每类有一个基准单位，各单位给出"到基准的换算因子"（`1 个该单位 = 因子 × 基准`），
于是任意两单位互换只需 `值 × from因子 ÷ to因子`。温度是仿射变换（不是比例），单独用
`toC`/`fromC` 两个函数处理。数据在 `tools/calc-convert.js` 顶部，13 类共 400+ 单位，
含中文单位名（公里/斤/亩/摄氏度/马力…）。

### 上下文成本控制

`calc_help` 按 topic 分 10 节，`calc_help(topic="functions")` 只返回函数表；
不传 topic 只返回目录。工具描述里也写清了能力边界，避免 AI 反复试探。

## 目录结构

```
calc/
├── package.json
├── start.bat              # 端口 8345 一键启动
├── README.md
└── src/
    ├── index.js           # 入口：启动
    ├── mcp/server.js      # MCP Streamable HTTP 服务器（零依赖）
    ├── tools/
    │   ├── registry.js        # 工具注册表
    │   ├── calc-eval.js       # calc_eval
    │   ├── calc-convert.js    # calc_convert（含 13 类单位表）
    │   ├── calc-equation.js   # calc_equation（多项式检测 + Durand-Kerner + 数值求根）
    │   ├── calc-matrix.js     # calc_matrix（高斯消元 + 幂迭代特征值）
    │   └── calc-help.js       # calc_help（按 topic 分节）
    └── utils/
        ├── tokenizer.js   # 词法分析
        ├── parser.js      # 递归下降 → AST
        ├── evaluator.js   # AST 求值 + 作用域 + 角度制
        ├── functions.js   # 函数库（~100 个）
        ├── constants.js   # 常量（数学 + 物理）
        ├── complex.js     # 复数运算
        ├── format.js      # 数值格式化
        └── logger.js      # 日志（logs/calc.log）
```

## 能力边界

- **不自定义函数**：不支持 `f(x)=x^2` 这类用户函数定义，请直接写表达式
- **不支持符号计算**：不给 `d/dx` 之类的解析导数或代数化简
- **不支持链式比较**：`a<b<c` 会报错，请写 `a<b && b<c`
- **方程组只支持线性且方阵**：方程数须等于未知数数
- **超越方程求根是数值的**：只覆盖指定区间，可能漏根；重根需手动缩小 range
- **特征值用幂迭代**：适合主特征值明显的情形，重根/复特征值可能不准
- **无大数/精确有理数**：走 IEEE 754 双精度（约 15-17 位有效数字），超大整数如 `100!` 会有精度损失
