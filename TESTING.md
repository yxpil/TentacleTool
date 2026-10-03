# TentacleTool 测试说明

TentacleTool 是多子项目 monorepo（analyze / calc / cryptox / fsx / httpx / jsonx / neton / search …），每个子项目独立零依赖。本次在 **calc** 子项目补齐 node:test 自动化套件。

## 运行方式

```bash
cd calc
npm test
```

会先跑原有的手写冒烟 `node test/equation.test.js`，再跑 node:test 套件。

## 测了什么

新增目录：`calc/tests/`
- `engine.test.cjs` —— 求值引擎全链路（tokenize → parse → evaluateProgram）：
  - 算术优先级/括号/幂右结合/阶乘；
  - 多语句变量复用、区间字面量 `1:5`；
  - 错误路径：除以 0、未闭合字符串、非法字符。

### 注入 / 安全测试
- **任意代码执行防护**：`process.exit()`、`constructor.constructor("return 1")()` 等 JS 风格 payload 均被求值器拒绝抛错，不访问 Node 全局、不终止进程（测试进程存活即证明）。
- **未定义变量**：拼错/未声明变量抛 `未定义` 错误而非 silently 求值。

## 原有测试覆盖
- `calc/test/equation.test.js`：方程求解冒烟，59 断言通过（保留）。
- `analyze/test/extractors.test.js`：11 语言符号/依赖提取冒烟（保留，未改动）。

## 预期结果

```
equation.test.js:  通过 59  失败 0
node:test:         # tests 5   # pass 5   # fail 0
```

> 其余子项目（cryptox/fsx/httpx 等）本次未单独补 node:test；MCP e2e（`*.e2e.js`）需起 Streamable HTTP 服务，不在本套件。
