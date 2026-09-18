# Cryptox

哈希 / 编码 / 加密 MCP 服务器 —— **让 AI 帮你算摘要、编解码、看 JWT、生成密钥**。

零依赖（只用 Node 原生 `node:crypto` / `fs` / `path`），MCP Streamable HTTP 协议（2025-03-26）。

## 解决什么问题

日常开发和排障里散落着一堆"小抄级"操作：算一个文件的 sha256、把图片转 base64、看看这个 JWT 什么时候过期、生成一个足够的随机密码、比对 HMAC 签名对不对。这些活儿单看都简单，但每次都要临时找网站或写一行脚本 —— 而**在线工具恰恰是最不该拿来处理密钥和明文的地方**（很多"在线 base64/JWT 工具"会把输入回传服务器）。

Cryptox 把这些操作收进本地：数据不出机器，算法全部走 Node 的 `crypto`（OpenSSL 实现），关键结果可对公开测试向量核验。

## 工具一览

| 工具 | 用途 | 亮点 |
|------|------|------|
| `cryptox_hash` | 文本/文件哈希摘要 | 9 种算法（含 sha3、blake2）；批量多输入；hex/base64/base64url |
| `cryptox_hmac` | HMAC 签名与校验 | 给了 `expected` 即返回校验结果，**恒定时间比较**防时序侧信道 |
| `cryptox_checksum` | 文件校验和 | 目录递归 + 扩展名过滤 + 与期望值比对，输出通过/不通过清单 |
| `cryptox_encode` | 文本编码 | base64 / base64url / hex / url / uri / querystring / html / unicode |
| `cryptox_decode` | 文本解码 | 上表各项反向；容错策略**显式**，非法输入报错而非静默返回原文 |
| `cryptox_jwt` | JWT 解析与验证 | iat/nbf/exp 转可读时间并标注状态；可选校验 HS256/384/512 |
| `cryptox_uuid` | UUID 与短 ID | v4 / **v7（时间有序，同毫秒内也递增）** / short id；兼可校验已有 UUID |
| `cryptox_password` | 密码生成与强度评估 | 可剔除易混字符；评估给熵（bits）、等级与弱模式诊断 |
| `cryptox_cipher` | AES-256-GCM 加解密 | PBKDF2 / scrypt 派生；密文是自描述封套（含 salt/iv/tag） |

## 快速开始

```powershell
cd cryptox
node src\index.js        # 或直接运行 start.bat（端口 8353）
```

MCP 客户端配置（Claude / Cursor / WorkBuddy 等）：

```json
{
  "mcpServers": {
    "cryptox": {
      "url": "http://127.0.0.1:8353/"
    }
  }
}
```

端口可用环境变量 `CRYPTOX_PORT` 覆盖（与 fsx 8350 / gitx 8351 / httpx 8352 错开）。

## 使用示例

```
cryptox_hash(input="hello")                              # → sha256 摘要
cryptox_hash(file="C:\\pkg.zip", algorithm="sha3-256")   # 文件摘要
cryptox_checksum(path="C:\\downloads", ext=".zip")       # 递归校验一个目录
cryptox_hmac(key="s3cr3t", input="payload", expected="ab12…")   # 校验签名
cryptox_jwt(token="eyJhbGciOi…")                         # 解析：看到期时间
cryptox_jwt(token="…", secret="your-256-bit-secret")     # 顺带验签
cryptox_uuid(version="v7", count=5)                      # 5 个有序 UUID
cryptox_password(length=24, symbols=true)                # 强随机密码
cryptox_password(password="P@ssw0rd2024")                # 评估强度
cryptox_cipher(mode="encrypt", input="机密", password="pw")
cryptox_cipher(mode="decrypt", input="CRYPT1:…", password="pw")
```

## 工作原理

### 算法与实现来源

| 类别 | 实现 |
|------|------|
| 摘要 / HMAC | `crypto.createHash` / `createHmac`（OpenSSL） |
| 对称加密 | `aes-256-gcm`，随机 12 字节 IV，GCM tag 16 字节 |
| 密钥派生 | `pbkdf2`（SHA-256，默认 10 万次迭代）或 `scrypt`（N=16384） |
| 随机数 | `crypto.randomBytes` / `randomInt` —— **从不使用 `Math.random`** |
| 恒定时间比较 | `crypto.timingSafeEqual`（长度不等时先短路） |

### 密文封套格式

`cryptox_cipher` 的输出是自描述的 base64 封套，形如：

```
CRYPT1:<base64(JSON{ v, alg, kdf, iter, salt, iv, tag, data })>
```

- 前缀 `CRYPT1:` 用于识别格式与版本，解密时校验，不匹配直接报错
- **salt / iv / tag 每次都随机生成并显式写进封套**，绝不复用、绝不隐式推导
- 口令错了不会解出乱码 —— GCM 认证失败会明确报"认证失败"，而不是返回垃圾明文

### UUID v7 的有序性

v7 前 48 位是毫秒时间戳，天然按时间排序；但**同一毫秒内**若只填随机位，生成的多个 v7 互相之间就无法排序，v7 相对 v4 的价值会丢一半。因此按 RFC 9562 的 Monotonic Random 思路，在同一毫秒内维护一个递增计数器填进随机区，保证**批量生成的 v7 严格递增**（单测里有对应断言）。

### 编码的容错边界

容错是显式的，不猜：

| 输入 | 行为 |
|------|------|
| base64 含空格/换行 | 容忍，先剔除空白 |
| base64 缺 padding | 自动补齐（长度余 1 这种非法情况报错） |
| hex 奇数长度 | 报错（不补位） |
| URL 转义非法（如 `%ZZ`） | 报错并指出位置，**不静默返回原文** |
| unicode 代理对（如 `\ud83d\udd10`） | 正确合并为单个字符（🔐） |

## 隐私与安全边界

- **数据不出本机**：所有计算在本地完成，没有任何网络请求 —— 这正是它相对在线工具的意义
- **密钥与口令绝不进日志**：`cryptox_hmac`、`cryptox_cipher` 的任何日志/诊断输出都不含密钥、口令或明文；诊断只给 `keySet: true/false` 这类布尔标志
- **明确不做**：不伪造 JWT 签名、不做密钥/口令爆破、不做口令字典攻击 —— 这些不是工具能力而是攻击面
- **`cryptox_jwt` 的解析 ≠ 可信**：不带 `secret` 时只解 base64，任何人都能伪造这样的 payload。输出的文本行里会**显式提示**这一点，避免被误读成"已验证"
- **`alg: none` 明确拒绝**：如果给了 `secret` 而 header 里写 `alg: none`，返回"拒绝视为验证通过"而不是通过

> ### ⚠️ 这是工具，不是密码管理器
>
> 生成出来的密钥/口令只在这一次的对话输出里出现。**请立刻存进密码管理器**（1Password / Bitwarden / KeePass 等）。不要把它贴进聊天记录、提交进 Git、或写在便签上。Cryptox 不保存、也看不到你生成过什么。

## 目录结构

```
cryptox/
├── package.json
├── start.bat                # 端口 8353 一键启动
├── README.md
└── src/
    ├── index.js             # 入口
    ├── mcp/server.js        # MCP Streamable HTTP 服务器（零依赖）
    ├── tools/
    │   ├── registry.js         # 工具注册表
    │   ├── cryptox-hash.js     # 哈希摘要
    │   ├── cryptox-hmac.js     # HMAC 签名与校验
    │   ├── cryptox-checksum.js # 文件校验和
    │   ├── cryptox-encode.js   # 文本编码
    │   ├── cryptox-decode.js   # 文本解码
    │   ├── cryptox-jwt.js      # JWT 解析与验证
    │   ├── cryptox-uuid.js     # UUID / 短 ID
    │   ├── cryptox-password.js # 密码生成与评估
    │   └── cryptox-cipher.js   # AES-256-GCM
    └── utils/
        ├── algo.js          # 算法名归一化 / 摘要 / HMAC / 恒定时间比较
        ├── format.js        # kv / 表格（CJK 列宽）/ 缩进块 / 截断
        └── logger.js        # 日志（logs/cryptox.log）
```

## 测试

零依赖，纯逻辑层，不联网、不写用户文件：

```powershell
npm test                 # 单测（node test/smoke.test.js）
node test\mcp.e2e.js     # 端到端（自起服务器，端口 18353）
```

单测 **159 项**、端到端 **66 项** 断言，全部通过。

### 期望值来自公开测试向量

算法类测试最容易掉进"用实现验证实现"的陷阱 —— 自己算一个值再拿它当期望，实现错了测试也跟着错。所以哈希与 HMAC 的断言全部取自公开向量：

| 来源 | 用到的向量 |
|------|-----------|
| RFC 1321 | MD5("abc") = `900150983cd24fb0d6963f7d28e17f72` |
| RFC 3174 | SHA1("abc") = `a9993e364706816aba3e25717850c26c9cd0d89d` |
| RFC 6234 / NIST | SHA-256("abc")、SHA-512("abc") |
| RFC 4231 | HMAC-SHA256 的 test case（key/数据/期望签名） |
| RFC 4648 | base64 标准向量（含 `你好` 的 UTF-8 结果 `5L2g5aW9`） |
| RFC 9562 | UUIDv7 的版本位与变体位结构、同毫秒内递增 |
| jwt.io 官方示例 | HS256 签名验证（`your-256-bit-secret`） |

只有确认过标准向量的部分才按向量断言；其余（如短 ID 字符集、截断提示）用性质断言（正则、单调性、包含关系）。
