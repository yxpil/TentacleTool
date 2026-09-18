# Search - 聚合搜索 MCP 服务器

零依赖 MCP Streamable HTTP 服务器，聚合**必应 / 百度 / DuckDuckGo**（无需任何搜索引擎 API Key），专为 **Agent 上下文经济**设计：搜索只返回折叠摘要，有价值的结果再按需展开，翻页增量获取。全部用 Node.js 原生模块实现（http / https / zlib / crypto），无需安装任何 npm 包。

## 启动

```powershell
cd TentacleTool\search
# 可选：自定义端口（默认 3000）
$env:SEARCH_PORT = '8343'
$env:SEARCH_HOST = '127.0.0.1'
node src/index.js
```

或直接双击 `start.bat`（固定端口 8343，后台最小化启动）。

## 工具清单

| 工具 | 功能 | 关键参数 |
|------|------|----------|
| `web_search` | 聚合搜索：多引擎并行、轮询交错合并、URL 去重，返回折叠摘要列表；`page`/`pageSize` 翻页，`snippetLen` 控制摘要长度（0 关闭） | query, engines, page, pageSize, snippetLen |
| `search_detail` | 展开全文：抓取结果页转 Markdown，默认 8000 字符截断，附续读提示 | url, maxLength, mode, includeImages |
| `search_suggest` | 搜索词联想：必应 + 百度 suggest 合并去重，用于改写/扩展查询 | query, engines, limit |

## 上下文经济设计

- **折叠**：`web_search` 每条结果只占一行链接 + 一行摘要（`snippetLen=0` 可只留链接），10 条/页约 1-2KB
- **翻页**：`page=2` 增量翻页，各引擎按偏移取对应页
- **按需展开**：`search_detail` 只抓 Agent 选中的那条，默认正文模式 + 无图片 + 8000 字符封顶，被截断时返回续读参数
- **交错合并**：多引擎结果轮询排序（每家第一条先出现），避免单一引擎刷屏；跳转链接（bing /ck、baidu /link、ddg uddg）自动还原为真实地址

## MCP 协议支持

- Streamable HTTP（POST /mcp，兼容根路径 POST /）
- initialize / ping / tools/list / tools/call / notifications/initialized
- 支持 JSON 与 SSE 响应格式

## 架构

```
search/
├── package.json
├── start.bat               # Windows 一键启动（端口 8343）
├── README.md
└── src/
    ├── index.js            # 入口（SEARCH_PORT / SEARCH_HOST 环境变量）
    ├── mcp/
    │   └── server.js       # MCP Streamable HTTP 核心（零依赖）
    ├── tools/
    │   ├── registry.js     # 工具注册表（参数 Schema + 调度）
    │   ├── web-search.js   # 聚合搜索（合并/去重/折叠/翻页）
    │   ├── search-detail.js    # 结果全文展开
    │   └── search-suggest.js   # 搜索词联想
    └── utils/
        ├── fetcher.js      # 抓取器：重定向/解压/字符集/超时（与 webview 同源）
        ├── html-to-md.js   # HTML 分词器（搜索结果解析复用同一套 token 流）
        ├── logger.js       # 文件日志（logs/search.log）
        └── engines/
            ├── common.js       # 区间查找/文本提取/跳转链接还原(bing ck, ddg uddg, baidu link)
            ├── bing.js         # 必应适配器（li.b_algo）
            ├── baidu.js        # 百度适配器（div.result + /link? 还原 + 反爬检测）
            └── duckduckgo.js   # DuckDuckGo 适配器（html 端点，部分网络不可达时优雅降级）
```

## 引擎说明

| 引擎 | Key | 翻页参数 | 备注 |
|------|-----|----------|------|
| 必应 | `bing` | first/count | 默认启用；点击跳转链接自动 base64 解码 |
| 百度 | `baidu` | pn/rn | 默认启用；`/link?url=` 跳转并发还原（每批 5 个）；触发反爬验证时报错提示换引擎 |
| DuckDuckGo | `duckduckgo` | s | 可选；html.duckduckgo.com 免 Key 端点，部分网络环境不可达，失败自动降级不影响其他引擎 |

某引擎失败不影响整体：结果尾部以 `> 引擎 xxx 失败` 标注，可用 `engines` 参数单独重试。
