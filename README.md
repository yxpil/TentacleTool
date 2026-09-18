# TentacleTool

网络工具集单仓库（monorepo）：**一个文件夹 = 一个独立工具集**，互不依赖，可单独启动。

## 目录结构

| 文件夹 | 工具集 | 说明 |
|--------|--------|------|
| [`neton/`](./neton/) | NetON | 局域网网络工具 MCP 服务器（设备发现 / 端口扫描 / 协议分析 / 抓包） |
| [`webview/`](./webview/) | WebView | 网页转 Markdown MCP 服务器（网页转 MD / HTML 转 MD / 链接提取 / 元信息提取） |
| [`search/`](./search/) | Search | 聚合搜索 MCP 服务器（必应/百度/DuckDuckGo，折叠摘要 + 翻页 + 按需展开全文） |
| [`find/`](./find/) | Find | 本机文件搜索 MCP 服务器（Everything 风格：文件名/最近修改/内容检索/工具定位，可选 C 原生索引器加速） |
| [`calc/`](./calc/) | Calc | 科学计算器 MCP 服务器（表达式求值 / 复数 / 方程求解 / 矩阵运算 / 单位换算，手写零依赖引擎） |

## 使用方式

每个工具集自带独立的 `package.json`、`README.md` 和启动脚本，进入对应文件夹按其 README 操作即可。例如启动 WebView：

```powershell
cd webview
node src/index.js        # 或直接运行 start.bat
```

## 新增工具集

1. 在根目录新建一个文件夹（与 `neton/` 平级）
2. 文件夹内自带 `README.md`（说明用途与启动方式）和 `package.json`（如为 Node.js 项目）
3. 更新本表格

## 通用约定

- `.gitignore` 作用于整个仓库（`node_modules/`、`logs/`、`*.log`、`.env`、`cache/`）
- 各工具集保持零依赖或各自管理依赖，根目录不放公共代码
