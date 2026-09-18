'use strict';
/**
 * 工具注册表：汇总所有工具的定义（名称、描述、参数 Schema）与执行入口
 */
const calcEval = require('./calc-eval');
const calcConvert = require('./calc-convert');
const calcEquation = require('./calc-equation');
const calcMatrix = require('./calc-matrix');
const calcHelp = require('./calc-help');

const TOOLS = [
  {
    name: 'calc_eval',
    title: '数学表达式求值',
    description: '科学计算器：对数学表达式求值，支持复杂公式。能力覆盖：四则运算与优先级、幂（^/**，右结合）、整除 //、取模 %、阶乘 !、百分号、逻辑与比较、赋值与复合赋值、多语句（; 或换行分隔，变量可复用）；~100 个函数（三角/反三角/双曲/指数对数/幂根/取整/阶乘gamma/组合nCr nPr/数论gcd lcm isprime nextprime/统计sum avg median variance stdev 等）；复数运算（3+4i、sqrt(-4)→2i、ln(-1)→πi、exp(i*pi)→-1）；约 40 个常量（pi/e/φ/光速/普朗克等）；隐式乘法（2pi、3(x+1)）；区间字面量 1:5；角度制 rad/deg/grad。浮点噪声已清理（sqrt(2)^2=2、sin(pi)=0），结果附带分数/无理数友好写法。',
    inputSchema: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: '要计算的表达式；多语句用 ; 或换行分隔（如 "a=3; b=4; sqrt(a^2+b^2)"）。变量赋值后可复用，如 "x=0.1+0.2; x"' },
        angleMode: { type: 'string', enum: ['rad', 'deg', 'grad'], description: '角度制（默认 rad）。也可用 deg()/radians() 显式换算，与模式无关' },
        precision: { type: 'number', description: '有效数字位数（1-17，默认 12）' },
        polar: { type: 'boolean', description: '复数结果是否额外显示极坐标（默认 false）' }
      },
      required: ['expr']
    },
    run: calcEval.run
  },
  {
    name: 'calc_convert',
    title: '单位换算',
    description: '在 13 类单位之间换算：长度（m/km/mi/ft/里/海里/光年…）、质量（kg/g/lb/斤/两/克拉…）、面积（m2/亩/公顷/acre…）、体积（l/gal/加仑/立方米…）、时间（s/h/d/年…）、速度（m/s km/h mph 节 马赫 光速）、数据（B/KB/MB/GB/TB，1024 进制）、压强（Pa/bar/atm/mmHg/psi）、能量（J/cal/kcal/kWh/eV/BTU）、功率（W/kW/马力）、角度（rad/deg/grad/圈）、频率（Hz/kHz/MHz/rpm）、温度（c/f/k/r 非线性）。中英文单位名都支持。list=true 可列出全部单位。',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'number', description: '要换算的数值' },
        from: { type: 'string', description: '原单位（如 "km/h"、"GB"、"斤"、"c"）' },
        to: { type: 'string', description: '目标单位（如 "m/s"、"MB"、"kg"、"f"）' },
        category: { type: 'string', description: '限定类别（length/mass/area/volume/time/speed/data/pressure/energy/power/angle/frequency/temperature），单位名有歧义时用' },
        list: { type: 'boolean', description: '设为 true 时列出可用单位（可配合 category 只看一类）' },
        precision: { type: 'number', description: '有效数字位数（默认 12）' }
      }
    },
    run: calcConvert.run
  },
  {
    name: 'calc_equation',
    title: '方程与方程组求解',
    description: '求解方程。三种输入方式：① equation + variable —— 单方程，自动判型：线性/多项式给出精确系数与全部根（含复根，如 x^2+1=0 → ±i），超越方程（含 sin/cos/ln/exp）用区间扫描+二分+牛顿数值求根，range 指定搜索区间；② equations + variables —— 线性方程组（高斯消元）；③ coeffs —— 直接给多项式系数（降幂）。',
    inputSchema: {
      type: 'object',
      properties: {
        equation: { type: 'string', description: '单个方程，如 "2x+3=7"、"x^2-5x+6=0"、"cos(x)=0.5"。没有等号时视为 =0' },
        variable: { type: 'string', description: '未知数名（默认自动识别，通常为 x）' },
        range: { type: 'array', items: { type: 'number' }, description: '数值求根的搜索区间 [lo, hi]（默认 [-50, 50]），如 [-10, 10]' },
        equations: { type: 'array', items: { type: 'string' }, description: '线性方程组，如 ["2x+3y=8", "x-y=-1"]（须同时给 variables）' },
        variables: { type: 'array', items: { type: 'string' }, description: '方程组的未知数名，如 ["x","y"]' },
        coeffs: { type: 'array', items: { type: 'number' }, description: '多项式系数（降幂），如 [1,-5,6] 表示 x²-5x+6' },
        angleMode: { type: 'string', enum: ['rad', 'deg', 'grad'], description: '方程里三角函数的角制（默认 rad）' }
      }
    },
    run: calcEquation.run
  },
  {
    name: 'calc_matrix',
    title: '矩阵运算',
    description: '矩阵运算，矩阵用二维数组表示（如 [[1,2],[3,4]]）。支持 op：add 加、sub 减、mul 乘、scale 数乘、transpose 转置、det 行列式、inv 逆矩阵（会校验 A·A⁻¹）、rank 秩、trace 迹、solve 解线性方程组 Ax=b（b 为一维数组）、eig 特征值（幂迭代）。形状不匹配会给出清晰报错。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'sub', 'mul', 'scale', 'transpose', 'det', 'inv', 'rank', 'trace', 'solve', 'eig'], description: '运算类型' },
        a: { type: 'array', description: '矩阵 A（二维数组），如 [[1,2],[3,4]]' },
        b: { type: 'array', description: '矩阵 B（add/sub/mul），或向量 b（solve 时为一维数组）' },
        k: { type: 'number', description: 'scale 时的数乘系数' },
        precision: { type: 'number', description: '有效数字位数（默认 12）' }
      },
      required: ['op']
    },
    run: calcMatrix.run
  },
  {
    name: 'calc_help',
    title: '计算器语法帮助',
    description: '科学计算器的语法参考，按 topic 分节返回（省上下文）。topic 可选：syntax 基本语法与字面量、operators 运算符优先级与 // % ! 的区分、functions 全部约 100 个函数清单、constants 数学与物理常量、complex 复数运算、angle 角度制与换算、units 单位换算、equation 方程求解、matrix 矩阵运算、examples 常见用法示例、all 全部。不传 topic 返回目录概览。不确定怎么写表达式时先调本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: ['syntax', 'operators', 'functions', 'constants', 'complex', 'angle', 'units', 'equation', 'matrix', 'examples', 'all'], description: '要查看的章节（不传则返回目录）' }
      }
    },
    run: calcHelp.run
  }
];

/** 转换成 MCP tools/list 返回格式 */
function toMcpTools() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

async function executeTool(name, args) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    throw new Error('未知工具: ' + name);
  }
  return tool.run(args || {});
}

module.exports = { TOOLS, toMcpTools, executeTool };
