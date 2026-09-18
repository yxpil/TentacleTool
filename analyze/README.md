# Analyze

代码知识图谱 MCP 服务器 —— **让 AI 看懂代码结构，而不是靠 grep 猜**。

零依赖（纯 Node 原生模块），MCP Streamable HTTP 协议（2025-03-26）。

## 解决什么问题

AI 读代码最常见的困境不是"读不到"，而是"看不出结构"：

- 「改这个函数会不会炸别的地方？」—— grep 出 200 个同名匹配，分不清是定义还是调用
- 「谁在调用我？」—— 需要逐个文件跟进去看，靠上下文硬猜
- 「这个模块能拆吗？」—— 不知道有没有循环依赖
- 「`run` 是怎么走到 `formatValue` 的？」—— 中间隔了 3 个文件，人在迷宫里

Analyze 把代码目录解析成一张**符号（节点）+ 关系（边）**的图，
让这些问题变成一次图查询：**影响面、调用链、依赖、最短路径，一次问清**。

输出全部是紧凑文本，不吃上下文。

## 工具一览

| 工具 | 用途 | 亮点 |
|------|------|------|
| `analyze_build` | 解析目录建图 | 11 种语言提取器 + 增量缓存，可按 include/exclude 收窄 |
| `analyze_find` | 按名字搜符号 | 模糊匹配 + 类型过滤 + 注释首句，比 grep 精准（不混调用点） |
| `analyze_refs` | 查符号被谁引用 | 入边清单，可按边类型过滤（只看 calls / 只看 imports） |
| `analyze_callers` | 追调用链 | 双向：`callers` 向上（谁调我）/ `callees` 向下（我在调谁），可递归 N 层 |
| `analyze_deps` | 文件依赖 | 直接依赖 + 传递依赖；`cycles=true` 时用 Tarjan SCC 做全仓循环依赖检测 |
| `analyze_path` | 最短关系路径 | 两符号/文件之间的"六度分隔"，BFS 保最短，可要求备选路径 |
| `analyze_impact` | 改动影响面 | 反向可达集 + **风险评级**（按影响节点数与跨模块比例） |
| `analyze_stats` | 图谱概览 | 规模 / 语言分布 / 符号类型 / 上帝文件 / 核心枢纽 / 死代码候选 |

## 快速开始

```powershell
cd analyze
node src\index.js        # 或直接运行 start.bat（端口 8346）
```

MCP 客户端配置（Claude / Cursor / WorkBuddy 等）：

```json
{
  "mcpServers": {
    "analyze": {
      "url": "http://127.0.0.1:8346/"
    }
  }
}
```

端口可用环境变量 `ANALYZE_PORT` 覆盖（`start.bat` 默认 8346，与 neton 8341 / webview 8342 / search 8343 / find 8344 / calc 8345 错开）。

## 使用示例

```
analyze_build(path="C:\\Users\\me\\proj")                        # 建图（首次）
analyze_find(query="formatValue")                                # 我在哪定义？
analyze_find(query="format", kinds=["function","method"])        # 限定类型

analyze_refs(symbol="formatValue")                               # 谁在引用我？
analyze_refs(symbol="formatValue", edgeKinds=["calls"])           # 只算真实调用
analyze_callers(symbol="formatValue", direction="callers", depth=2)  # 向上 2 层调用者
analyze_callers(symbol="tokenize", direction="callees", depth=2)     # 向下 2 层被调者

analyze_deps(path="proj", file="src/utils/tokenizer.js", depth=2) # 这个文件的依赖网
analyze_deps(path="proj", cycles=true)                            # 全仓循环依赖检测

analyze_path(from="run", to="formatValue")                       # 它俩怎么连上的？
analyze_impact(target="loadGraph", depth=2)                      # 改这个的爆炸半径 + 风险评级
analyze_stats(path="proj")                                       # 图谱全局概览
```

### 一次真实的影响面分析

```
影响面分析：loadGraph  [function]  src/utils/cache.js:48

第 1 层影响（9 个节点）：
  [calls] src/tools/analyze-build.js  src/tools/analyze-build.js:56
  [calls] src/tools/analyze-find.js   src/tools/analyze-find.js:66
  [calls] src/tools/analyze-stats.js  src/tools/analyze-stats.js:49
  ...
第 2 层影响（1 个节点）：
  [imports] src/tools/registry.js  src/tools/registry.js:11

受影响节点合计：10 个（2 层内）
风险评级：高 —— 影响 10 个节点，其中 10 处是跨模块引用；
          建议改前先跑测试，并考虑保留旧签名做兼容。
```

## 工作原理

### 图模型：符号（card）+ 关系（edge）

- **符号**：`{name, kind, file, line, exported, container, signature, doc}`
  - `kind` ∈ `function` / `method` / `class` / `variable` / `property` / `field` / `macro` / `type` / `module`
  - `container` 记录所属类/模块，`doc` 是紧邻注释的首句（截断 200 字符）
- **关系**：`{from, to, kind, file, line}`

| 边类型 | 含义 | 来源 |
|--------|------|------|
| `contains` | 文件含符号 / 类含方法 | 声明位置 |
| `imports` | ES import / require / from-import | 模块导入语句 |
| `include` | C/C++ `#include`、PHP include | 预处理/包含语句 |
| `calls` | 函数调用 | 调用表达式（仅函数/方法体内） |
| `extends` | 类继承 | `extends` / Go 内嵌 / Python 基类 |
| `implements` | 接口实现 | `implements` / C# 冒号基类 |
| `type-ref` | 类型引用 | 类型注解、泛型参数 |

### 语言支撑（11 种，零依赖）

| 语言 | 提取能力 |
|------|----------|
| JavaScript / TypeScript | 函数、箭头函数、类、方法、变量、import/require、调用、extends/implements |
| Python | `def` / `class` / 模块级变量、`import` / `from ... import`、调用、基类 |
| Go | `func` / `type` / 方法接收者、import、调用、结构体内嵌 |
| Rust | `fn` / `struct` / `enum` / `trait` / `impl`、`use`、调用、trait 实现 |
| Java / C# | 类、方法、字段、接口、`extends` / `implements`、调用 |
| C / C++ | 函数定义、`struct` / `class` / `#define` 宏、`#include`、调用 |
| Ruby | `def` / `class` / `module`、`require`、调用 |
| PHP | `function` / `class`、`include` / `require` / `use`、调用 |
| 其他语言 | 退化为**文件级**依赖图：仅 `import` / `include` 嗅探 + 文件名索引，仍可用于 `analyze_deps` |

### 为什么不用真 AST

真 AST 需要引入 `@babel/parser` / tree-sitter 等重型依赖，与本仓库"一个文件夹一个工具集、零依赖"的
约定冲突，且要为 11 种语言各找一个解析器。Analyze 改用**轻量状态机净化 + 锚点正则**：

1. **净化（`lang/clean.js`）**：一个手写状态机把源码扫一遍，产出"可安全正则匹配"的文本
   - 注释 → 替换为**等长空格**（保留换行与列号，所以行号永远准确）
   - 字符串 → **引号保留、内容替换为等长 `~`**；真实值同时收进 `strings` 数组，用 `stringAt()` 按位置回查
     - 这一步是关键：`import x from "./mod"` 的模块名如果被抹掉，依赖边就全丢了
   - 状态机覆盖：行注释 / 块注释 / 双引号串 / 单引号串 / 模板串 / Python 三引号串
   - 模板串里的 `${...}` 会**递归当代码处理**，所以 `` `${fn(x)}` `` 里的 `fn(x)` 照样能抓成调用
2. **锚点正则**：净化后的文本上跑各语言的声明/导入/调用锚点正则
3. **函数体区间**：`findBodyBrace()` 先跳过参数表（含 `= {}` 默认值、泛型 `<T>`、`=>`）再定位函数体 `{`，
   把 `foo(` 归属到所属函数——否则所有调用都挂在文件上
4. **就近解析**：符号名解析遵循"同文件优先 → 同容器优先 → 全局唯一才连跨文件"

这样做的取舍很明确：**不追求 100% 语法覆盖，换取零依赖 + 多语言 + 实用精度**。
在真实仓库（本 monorepo，117 文件 / 1377 符号 / 3891 关系）上解析 **0 error，约 250ms**。

### 假边防治

静态分析最怕"把局部变量连成枢纽"。Analyze 的三道闸：

1. 调用归属：`attributeCalls()` 只认函数体内的调用点，`[file]` 级别的散落调用不会乱连
2. 成员调用限定：`obj.filter(...)` 这种成员调用**只能**命中 `method` / `property` / `function` / `field`，
   绝不连到同名 `variable`
   - 效果：`filter` 这个角色的入边从 70 条降到 1 条
3. 类型过滤：`analyze_find` 的 `kinds`、`analyze_refs` 的 `edgeKinds` 让你随时手动收窄

### 缓存

- 内存 `Map`（进程内，同一次会话的所有查询共用一张图）
- 磁盘 `.analyze-cache/graph-<hash>.json`（hash 由根目录 + 文件 mtime/大小集合算出）
- TTL 默认 **10 分钟**自动过期；任意工具传 `refresh=true` 立即重建
- 输出页脚会标注本次图来自 `memory` / `disk` / `build`

### 跳过与上限

- 跳过目录：`node_modules` `.git` `__pycache__` `target` `dist` `build` `venv` `.venv` `vendor` 等
- 二进制扩展名白名单外一律跳过；单文件上限 2MB
- `maxFiles` 默认 5000，超限标记 truncated 并在输出中提示

### 隐私与边界

- **只读**：所有工具只读源码，绝不写入/移动/删除任何用户文件
- 唯一写盘行为是 `.analyze-cache/` 图缓存与 `logs/analyze.log` 日志（均在工具集目录内）
- 静态分析抓不到**动态调用**（`eval`、反射、字符串拼出的模块名、依赖注入）——
  工具在查不到路径时会明确提示这一边界，而不是假装"没有依赖"

## 目录结构

```
analyze/
├── package.json
├── start.bat                  # 端口 8346 一键启动
├── README.md
├── test/
│   ├── extractors.test.js     # 提取器冒烟测试（23 项，npm test）
│   └── mcp.e2e.js             # 端到端：自起服务器 + JSON-RPC 全流程（npm run test:e2e）
└── src/
    ├── index.js               # 入口：启动 + 崩溃日志钩子
    ├── mcp/server.js          # MCP Streamable HTTP 服务器（零依赖）
    ├── lang/
    │   ├── tables.js          # 扩展名→语言、注释风格、花括号语言表（破除循环依赖）
    │   ├── clean.js           # 状态机净化器（核心）：注释/字符串处理 + strings 回查
    │   ├── index.js           # 语言注册表：langOf / extractorFor / LANGUAGES
    │   ├── js.js              # JS / TS 提取器（含 findBodyBrace / isExported / TS implements）
    │   ├── python.js  go.js  rust.js
    │   ├── javalike.js        # Java / C#
    │   ├── clike.js           # C / C++
    │   ├── ruby.js  php.js
    ├── tools/
    │   ├── registry.js        # 工具注册表（TOOLS + toMcpTools + executeTool）
    │   ├── analyze-build.js   analyze-find.js   analyze-refs.js
    │   ├── analyze-callers.js analyze-deps.js   analyze-path.js
    │   ├── analyze-impact.js  analyze-stats.js
    │   └── format.js          # 共享输出格式化
    └── utils/
        ├── builder.js         # 建图调度：collectFiles / parseSource / attributeCalls
        ├── graph.js           # 图存储与查询原语（_findSymbol / refsOf / impactOf / stats …）
        ├── cache.js           # 内存 + 磁盘图缓存（loadGraph / clearMemory / clearDiskCache）
        └── logger.js          # 日志（logs/analyze.log）
```

## 测试

```powershell
cd analyze
node test\extractors.test.js    # 提取器层：11 种语言的声明/导入/调用/继承逐项断言
node test\mcp.e2e.js            # 端到端：spawn 服务器 + initialize / tools/list / tools/call
```

## 一个可复现的实测

在 117 个文件的本仓库上跑 `analyze_deps(path=".", cycles=true)`：

```
扫描 22 个文件的依赖关系      ← calc 子集
未发现循环依赖。

依赖枢纽（出入度最高的文件）：
  ←  1  →  6  src/tools/calc-equation.js
  ←  6  →  1  src/utils/format.js
  ←  1  →  5  src/tools/registry.js
```

也就是说：`format.js` 被 6 个文件依赖（改了它 6 处受影响），而它自己只依赖 1 个文件——
典型的"底层工具模块"，属于**高扇入低扇出**，是最该保持稳定的那一类文件。
