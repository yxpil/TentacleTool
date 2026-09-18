# WebView - 网页转 Markdown MCP 服务器

零依赖 MCP Streamable HTTP 服务器，把网页抓下来并转换为干净的 Markdown。4 个工具全部用 Node.js 原生模块实现（http / https / zlib / crypto），内置手写 HTML 分词器与 Markdown 渲染器，无需安装任何 npm 包。

## 启动

```powershell
cd TentacleTool\webview
# 可选：自定义端口（默认 8342）
$env:WEBVIEW_PORT = '8342'
$env:WEBVIEW_HOST = '127.0.0.1'
node src/index.js
```

或直接双击 `start.bat`（固定端口 8342，后台最小化启动）。

## 工具清单

| 工具 | 功能 | 关键参数 |
|------|------|----------|
| `web_to_md` | 网页转 Markdown：content 模式智能去噪并定位正文（默认）/ full 模式全量转换，支持标题/列表/表格/代码块/引用/链接/图片 | url, mode, includeImages, includeLinks, maxLength |
| `html_to_md` | HTML 源码转 Markdown：不发起网络请求，适合邮件正文、编辑器内容等已有 HTML 的场景 | html, mode, includeImages, includeLinks |
| `web_links` | 链接提取：相对路径转绝对地址、去重，输出 Markdown 链接清单 + 域名分布统计 | url, sameOriginOnly, limit |
| `web_meta` | 元信息提取：title / OpenGraph / Twitter 卡片 / SEO 字段 / favicon / 页面统计（字数、阅读时长） | url |

## MCP 协议支持

- Streamable HTTP（POST /mcp，兼容根路径 POST /）
- initialize / ping / tools/list / tools/call / notifications/initialized
- 支持 JSON 与 SSE 响应格式

## 架构

```
webview/
├── package.json
├── start.bat               # Windows 一键启动（端口 8342）
├── README.md
└── src/
    ├── index.js            # 入口（WEBVIEW_PORT / WEBVIEW_HOST 环境变量）
    ├── mcp/
    │   └── server.js       # MCP Streamable HTTP 核心（零依赖）
    ├── tools/
    │   ├── registry.js     # 工具注册表（参数 Schema + 调度）
    │   ├── web-to-md.js    # 网页 -> Markdown
    │   ├── html-to-md-tool.js
    │   ├── web-links.js    # 链接提取
    │   └── web-meta.js     # 元信息提取
    └── utils/
        ├── fetcher.js      # 抓取器：重定向/解压(gzip,deflate,br)/字符集(GBK等)/超时/大小上限
        ├── html-to-md.js   # HTML 分词器 + Markdown 渲染器（正文降噪、主内容选取）
        ├── page-parser.js  # 元信息/链接/统计提取
        └── logger.js       # 文件日志（logs/webview.log）
```

## 转换特性

- **两种模式**：`content` 智能提取正文（基于主内容块评分 + 噪声类名/角色过滤）；`full` 保留全部可见内容
- **GFM 表格**：thead/tbody 自动对齐列数，单元格内 `|` 转义
- **代码块**：`<pre><code class="language-xxx">` 自动识别语言，输出围栏代码块
- **嵌套结构**：多级列表（有序/无序混排）、嵌套引用块正确缩进
- **字符集**：HTTP 头 -> meta charset 自动识别，中文 GBK/GB18030/Big5 页面不乱码
- **相对链接**：全部转为绝对地址；空文本链接转为 `<autolink>` 形式

## 测试

零依赖，纯逻辑层，不发起任何网络请求：

```powershell
npm test                 # 等价于 node test/smoke.test.js
```

`test/smoke.test.js` 覆盖 **100 项**断言，分六块：

| 分节 | 覆盖内容 |
|------|----------|
| decodeEntities | 具名/十进制/十六进制实体；`&nbsp;` 等空白类实体有意折叠为普通空格 |
| tokenize | start/text/end 三件套、属性解析、自闭合标签、注释丢弃、raw-text 元素 |
| parseAttrs | 引号风格、无值属性、引号嵌套 |
| htmlToMarkdown | 标题/强调/行内码/代码块/列表（含嵌套）/链接/图片/引用/**表格**/title 前置 |
| htmlToMarkdown 边界 | 空输入、null、未闭合标签、脚本与样式剔除、空行压缩、首尾整洁 |
| page-parser | 元信息提取、链接去重与绝对化、`resolveUrl` 各种形式 |

输出为终端可读格式（`=== 分节 ===` + 失败项清单 + `通过 N 失败 M`），失败时退出码为 1。
