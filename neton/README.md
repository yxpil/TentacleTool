# NetON - 局域网网络工具 MCP 服务器

零依赖 MCP Streamable HTTP 服务器，提供 6 个局域网网络侦察工具，全部用 Node.js 原生模块实现（child_process / net / http / os / crypto），无需安装任何 npm 包。

## 启动

```powershell
cd TentacleTool\neton
# 可选：自定义端口（默认 3000）
$env:NETON_PORT = '8341'
$env:NETON_HOST = '127.0.0.1'
node src/index.js
```

以管理员身份运行可获得 pktmon 真实抓包能力（普通权限自动降级为实时连接监控）。

## 工具清单

| 工具 | 功能 | 关键参数 |
|------|------|----------|
| `device_discovery` | 局域网设备发现：ARP 表 + ICMP Ping + 常见端口探测，识别 MAC/OUI 厂商/HTTP 服务 | subnet, arp, ping, portProbe |
| `network_scan` | 网段扫描：全量存活探测 + 端口扫描 + 服务统计 | target(网段), ports, timeout |
| `port_scan` | 端口扫描：单个 IP 多端口，支持端口范围/列表，可抓 banner | target(IP), ports, banner |
| `port_analyze` | 端口深度分析：服务识别 + banner 指纹 + 风险评级 | target(IP), ports |
| `protocol_analyze` | 协议分析：HTTP/HTTPS(TLS)/SSH 等探测 + 系统指纹(OS guess by TTL) | target(IP), ports |
| `packet_capture` | 抓包：pktmon 真实抓包(需管理员) / live 实时 TCP 连接监控(netstat) | mode(pktmon/live), duration |

## MCP 协议支持

- Streamable HTTP（POST /mcp）
- initialize / ping / tools/list / tools/call / notifications/initialized
- 支持 JSON 与 SSE 响应格式

## 架构

```
src/
├── index.js                # 入口
├── mcp/
│   └── server.js           # MCP Streamable HTTP 核心（零依赖）
├── tools/
│   ├── registry.js         # 工具注册表（参数 Schema + 调度）
│   ├── device-discovery.js
│   ├── network-scan.js
│   ├── port-scan.js
│   ├── port-analyze.js
│   ├── protocol-analyze.js
│   └── packet-capture.js
└── utils/
    └── network.js          # 核心库：IP/网段/MAC/端口/服务名/ARP/ICMP/TCP/banner
```

## 关键实现细节

1. **中文 Windows 编码坑**：`arp -a` 输出 GBK 编码，需 `execFile(..., {encoding: 'buffer'})` 读字节，再用 `latin1` 解码避免破坏字节，正则不依赖中文匹配 MAC。
2. **端口参数**：接受 `'80,443,445'` / `'21-23,80'` / 数组三种形式，统一展开为数字数组。
3. **并发控制**：TCP 探测用信号量限制并发（默认 32），ICMP 用 concurrency 256。
4. **进程安全**：所有 spawn/exec 均带 windowsHide 与超时，防止挂起。
5. **服务识别**：内置 50+ 常见端口服务名 + IANA 协议映射。

## 测试记录（2026-09-01）

- 全部 6 工具 MCP 调用通过
- ARP 解析：修复 GBK 编码 + 行首空格问题后 3/3 条记录正确
- 端口扫描：80/443/445 识别准确，带延迟毫秒数
- TLS 指纹：TLSv1.3 + cert 信息提取成功
- 实时连接：45 条 TCP 连接含外连(443/8883/8080)全部列出
- 单 /24 网段扫描 256 IP 耗时约 3.7s
