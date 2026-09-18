# Httpx

零依赖 HTTP 客户端 MCP 服务器 —— **让 AI 安全、可控地发 HTTP 请求**（通用请求 / 下载 / 头探测 / 批量 / JSON / 探测）。

零依赖（仅 Node 原生模块 `http` / `https` / `zlib` / `tls` / `url` / `fs`），MCP Streamable HTTP 协议（2025-03-26）。

## 解决什么问题

AI 经常需要："调一下这个接口"、"把文件下下来"、"看看这个服务返回什么头"、"批量探一批 URL"、"这个证书还有效吗"。Httpx 把这些都做成带安全闸门的工具，输出折叠成紧凑文本 + 机器可读结构化结果，不吃上下文。

## 工具一览

| 工具 | 用途 | 亮点 |
|------|------|------|
| `httpx_request` | 通用 HTTP 请求 | method/headers/query/body(auth)/超时/重定向/自动解压，文本智能截断、二进制只报大小类型 |
| `httpx_download` | 下载到文件 | 大小上限、超时、断点续传（Range、206 续传）、返回路径与字节数 |
| `httpx_head` | 头信息探测 | 状态、全部响应头、重定向链、连接/首字节/总耗时 |
| `httpx_batch` | 并发批量请求 | URL 列表、并发数上限、单条超时、失败重试 1 次、汇总表 |
| `httpx_json` | JSON API 便捷调用 | GET/POST JSON、自动 Content-Type、非 2xx 也返回响应体 |
| `httpx_probe` | 简易探测 | http/https 状态码、重定向去向、HTTPS 证书有效期（tls 直接握证，如实报错） |

## 快速开始

```powershell
cd httpx
node src\index.js        # 或直接运行 start.bat（端口 8352）
```

MCP 客户端配置（Claude / Cursor / WorkBuddy 等）：

```json
{
  "mcpServers": {
    "httpx": {
      "url": "http://127.0.0.1:8352/"
    }
  }
}
```

端口可用环境变量 `HTTPX_PORT` 覆盖（`start.bat` 默认 8352，与 find 8344 / gitx / jsonx 错开）。

## 使用示例

```
httpx_request(url="https://api.github.com/repos/yxpil/TentacleTool", timeout=10000)
httpx_request(url="https://httpbin.org/post", method="POST", body={"a":1}, auth={type:"bearer",token="..."})
httpx_download(url="https://example.com/big.zip", path="C:/tmp/big.zip", maxBytes=10485760)
httpx_head(url="https://example.com")
httpx_batch(urls=["https://a.com","https://b.com"], concurrency=4)
httpx_json(url="https://api.x/u", method="POST", data={"q":"hi"})
httpx_probe(host="example.com")
```

## 工作原理

### 请求引擎（零依赖）

- `httpx_request` 用原生 `http` / `https` 发请求，自动解压 `gzip` / `deflate` / `br`（`zlib`）。
- 重定向跟随上限默认 5（303 自动转 GET），每跳都重新过 SSRF 闸门。
- 超时默认 30s，到点直接销毁连接并明确报错。
- 响应体上限默认 2MB：文本按 `content-type` 智能展示（超出截断并提示），二进制只报类型与大小、不展示正文，避免撑爆上下文。

### 下载与断点续传

`httpx_download` 把响应体写入文件；`resume=true` 时已存在文件会发 `Range: bytes=<已有大小>-`，
命中 `206` 则追加，收到 `416` 视为已完成，普通 `200` 覆盖写。大小上限 `maxBytes` 默认 50MB。

### 头探测与耗时

`httpx_head` 发 HEAD（被拒绝时回退 GET 逻辑一致），报告全部响应头、重定向链，并测量
TCP 连接 / 首字节 / 总耗时三阶段。

### 探测与证书

`httpx_probe` 用 `tls.connect`（**不降级全局 `rejectUnauthorized`**）直接握取对端证书，
如实报告主体、签发者、有效期（已过期 / 尚未生效 / 授权错误如自签名），同时给出 HTTPS 上的 HTTP 状态码。

### SSRF 防护（默认开启）

- **默认拒绝**内网 / 环回 / 链路本地 / 保留地址：`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7`、`fe80::/10`、组播/保留段等。
- 只允许 `http:` / `https:` 协议，拒绝 `file:` / `ftp:` / `gopher:` / `data:` 等。
- 域名类主机做 DNS 解析并**逐地址判定**（防 DNS 重绑定到内网）；重定向目标同样重新校验。
- 需访问内网时显式传 `allowPrivate=true`（这是刻意的高亮开关，让风险可见）。
- **认证头（`auth.token` / `auth.password` / `Authorization`）绝不进入日志**——`server.js` 在记录参数前统一脱敏。
- 证书错误如实上报，**禁用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 之类的全局降级**。

## 目录结构

```
httpx/
├── package.json
├── start.bat              # 端口 8352 一键启动
├── README.md
├── .gitignore
└── src/
    ├── index.js           # 入口：端口(HTTPX_PORT||PORT||8352) + 崩溃钩子 + SIGINT/SIGTERM
    ├── mcp/server.js      # MCP Streamable HTTP 服务器（零依赖，{text,structured} 契约 + auth 日志脱敏）
    ├── tools/
    │   ├── registry.js    # 工具注册表（拆 {text, structured}）
    │   ├── httpx-request.js
    │   ├── httpx-download.js
    │   ├── httpx-head.js
    │   ├── httpx-batch.js
    │   ├── httpx-json.js
    │   └── httpx-probe.js
    └── utils/
        ├── logger.js      # 日志（logs/httpx.log）
        ├── ssrf.js        # SSRF 闸门 + URL 校验（纯函数为主）
        ├── client.js      # 请求引擎（解压/重定向/超时/认证）
        ├── format.js      # CJK 列宽对齐 / 大小 / 截断 / 表格
        └── out.js         # 错误结果构造
```

## 测试

全部为零依赖、纯逻辑或自起本地靶子的端到端，**不请求真实外网**：

```powershell
npm test                 # 等价于 node test/smoke.test.js（纯逻辑单测：IP 分类、SSRF 判定、URL 校验、大小/宽度/截断）
npm run test:e2e         # node test/mcp.e2e.js（自 spawn 服务器 + 本地 http 靶子，走完整 JSON-RPC；靶子为环回地址，测试显式传 allowPrivate=true）
```

`test/smoke.test.js` 覆盖纯逻辑断言；`test/mcp.e2e.js` 覆盖 6 个工具的真实调用 + SSRF 闸门拦截断言
（默认拦截 `127.0.0.1`、放行 `allowPrivate=true`、拒绝 `file:` 协议）。
