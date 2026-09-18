# TentacleTool

工具集单仓库（monorepo）：**一个文件夹 = 一个独立工具集**，互不依赖，可单独启动。

每个工具集都是一个**零依赖 MCP 服务器**（只依赖 Node 原生模块，不装任何 npm 包），
走 MCP Streamable HTTP 协议（2025-03-26），本地监听一个固定端口。

## 工具集一览

| 文件夹 | 工具集 | 端口 | 工具数 | 说明 |
|--------|--------|------|--------|------|
| [`neton/`](./neton/) | NetON | 8341 | 6 | 局域网网络工具（设备发现 / 端口扫描 / 协议分析 / 抓包） |
| [`webview/`](./webview/) | WebView | 8342 | 4 | 网页转 Markdown（网页转 MD / HTML 转 MD / 链接提取 / 元信息提取） |
| [`search/`](./search/) | Search | 8343 | 3 | 聚合搜索（必应/百度/DuckDuckGo，折叠摘要 + 翻页 + 按需展开全文） |
| [`find/`](./find/) | Find | 8344 | 4 | 本机文件搜索（Everything 风格：文件名 / 最近修改 / 内容检索 / 工具定位，可选 C 原生索引器加速） |
| [`calc/`](./calc/) | Calc | 8345 | 5 | 科学计算器（表达式求值 / 单位换算 / 方程与方程组 / 矩阵运算，手写零依赖引擎） |
| [`analyze/`](./analyze/) | Analyze | 8346 | 8 | 代码知识图谱（符号搜索 / 引用 / 调用链 / 依赖与循环检测 / 最短路径 / 影响面分析，11 种语言零依赖提取器） |
| [`kb/`](./kb/) | KB | 8347 | 6 | MySQL 知识库（把**多张表**组合成一个有业务含义的知识库：跨库跨源组合 / 跨表全文搜索 / 只读 SQL / 结构内省，零依赖自实现 MySQL 客户端协议） |
| [`stamp/`](./stamp/) | Stamp | 8348 | 6 | 时间与调度（时间戳转换 / 时长解析 / 时区换算含 DST / 工作日推算含调休 / cron 解析与触发预测，纯 `Intl` 实现时区运算） |
| [`jsonx/`](./jsonx/) | Jsonx | 8349 | 6 | 数据格式处理（JSON/YAML/CSV/TSV 互转含往返校验 / JSONPath 查询 / 结构推断 / 结构化 diff / 统计聚合，CSV 走完整状态机、类型推断保守化） |
| [`fsx/`](./fsx/) | Fsx | 8350 | 10 | 文件系统操作（读 / 写 / 精确替换 / 列目录 / 目录树 / 属性 / 内容检索 / 复制 / 移动 / **带四道安全闸门的删除**） |
| [`gitx/`](./gitx/) | Gitx | 8351 | 10 | Git 仓库操作（状态 / 历史 / 差异 / 逐行归属 / 文件历史 / 分支 / 暂存 / 远程 / 提交，刻意不做 push 与任何改写历史的操作） |
| [`httpx/`](./httpx/) | Httpx | 8352 | 6 | HTTP 客户端（通用请求 / 下载 / 头探测 / 并发批量 / JSON API / 站点探测，含 SSRF 防护与内网拦截） |

下一个新工具集用 **8353**。测试端口约定：`18000 + 正式端口`（如 8348 → 18348、8352 → 18352）。

## 快速开始

每个工具集自带独立的 `package.json`、`README.md` 和 `start.bat`。两种启动方式：

```powershell
# 方式一：Node 直接跑（推荐，能看到实时日志）
cd kb
node src/index.js

# 方式二：双击或调用 start.bat（后台最小化启动，并自检端口）
```

自定义端口用环境变量覆盖，例如 `$env:KB_PORT=9347; node src/index.js`。

## 接入 MCP 客户端

服务器起来后，在 MCP 客户端里按「Streamable HTTP」类型添加，URL 形如：

```
http://127.0.0.1:8347/
```

连上后先调该工具集的「入口工具」了解可用能力（例如 `kb_sources`、`analyze_stats`，
或 `calc_help`），再按需调用具体工具。

## 测试

每个工具集自带零依赖测试，直接 `node test/<某测试>.js`，也可在文件夹内 `npm test`：

| 文件夹 | 单测 | 端到端 |
|--------|------|--------|
| neton | `npm test`（80 项） | — |
| webview | `npm test`（100 项） | — |
| search | `npm test`（62 项） | — |
| find | `npm test`（74 项） | — |
| calc | `npm test`（59 项） | `node test/mcp.e2e.js`（28 项） |
| analyze | `npm test`（23 项） | `node test/mcp.e2e.js`（57 项） |
| kb | `npm test`（34 项） | `node test/mcp.e2e.js`（60 项） |
| stamp | `npm test`（351 项） | `node test/mcp.e2e.js`（58 项） |
| jsonx | `npm test`（333 项） | `node test/mcp.e2e.js`（159 项） |
| fsx | `npm test`（88 项） | `node test/mcp.e2e.js`（51 项） |
| gitx | `npm test`（75 项） | `node test/mcp.e2e.js`（54 项） |
| httpx | `npm test`（50 项） | `node test/mcp.e2e.js`（65 项） |

合计 **单测 1329 项 + 端到端 532 项**，全部通过、无跳过。

单测是**纯逻辑层**（不联网、不扫盘），可随时回归；端到端会自起服务器走完整 JSON-RPC。
需要外部依赖的用例（数据库、外网）在依赖不可用时会优雅跳过而不是失败。

## 新增工具集

1. 在根目录新建一个文件夹（与其他工具集平级）
2. 文件夹内自带 `README.md`（用途与启动方式）、`package.json`、`start.bat`、`test/`
3. 更新本文件的「工具集一览」表格与端口

## 通用约定

- **零依赖**：只用 Node 原生模块；确需加速时可自带预编译的本地组件（如 `find/` 的 C 索引器）
- **上下文经济**：工具输出默认折叠 + 限制条数 + 给翻页/续读提示，不把整页内容灌回模型
- **失败要可诊断**：错误信息说清「哪一步错了 + 怎么改」，而不是抛原始异常
- `.gitignore` 作用于整个仓库（`node_modules/`、`logs/`、`*.log`、`.env`、`cache/`）
- **凭据类文件一律不入库**：如 `kb/kb.config.json`（数据库连接串含账号密码），
  仓库里只放 `*.example.json` 模板
