# KB

MySQL 知识库 MCP 服务器 —— **把多个 MySQL 表组合成一个有业务含义的知识库，让 AI 直接问数据**。

零依赖（**自己实现了 MySQL 客户端协议**，不用 `mysql2`），MCP Streamable HTTP 协议（2025-03-26）。

## 解决什么问题

用户想让 AI 回答"我们系统里有哪些角色""这个权限是给谁的""文章表都有哪些字段"。

难点在于：

- 数据库里**表很多**，AI 不知道该看哪几张，也记不住库名表名
- 表结构和字段含义散在 `information_schema` 里，**不读一遍就不知道有哪些列能查**
- 直接给 AI 一个能连库的口子，**风险很大**——它可能写出 `DELETE` 或者 `SELECT *` 把上下文撑爆
- 同一个业务概念分散在多张表甚至多个库，**"知识库"这个层次是缺失的**

KB 把"一个业务概念 = 一批表的集合"这件事显式建模出来，并给全套安全护栏。

## 工具一览

| 工具 | 用途 | 亮点 |
|------|------|------|
| `kb_sources` | 列出数据源与知识库 | 连通性探测 + 表清单，Agent 的入口工具 |
| `kb_schema` | 看表结构 | 列/类型/**注释**/主键/外键/索引；不传 table 可列全部表概览 |
| `kb_search` | **跨表搜索** | 一次搜全部表的全部文本列，返回命中片段 + 出处（库.表.列） |
| `kb_query` | 只读 SQL | 自动补 LIMIT、`?` 参数化、越界拦截、危险列打码 |
| `kb_stats` | 知识库概览 | 行数/列数/主键/有无注释/是否可搜索，含"空表"预警 |
| `kb_config` | 配置诊断 | 看配置状态、连通性诊断、**热重载**（改完配置不用重启） |

## 快速开始

### 1. 配置

复制示例配置改一改：

```powershell
cd kb
copy kb.config.example.json kb.config.json
```

最小配置长这样（注释是支持的，会被自动剥离）：

```jsonc
{
  "sources": {
    "local": {
      "host": "127.0.0.1", "port": 3306,
      "user": "root", "password": "你的密码",
      "database": "mydb",
      "readOnly": true          // 默认就是 true，强烈建议保持
    }
  },
  "knowledgeBases": {
    "系统管理": {
      "description": "后台权限、角色、字典",
      "source": "local",
      "tables": [
        "mydb.sys_user",
        "mydb.sys_role",
        { "database": "mydb", "table": "sys_user", "redact": ["password", "phone"] }
      ]
    }
  }
}
```

不想写配置文件也可以直接给环境变量试：

```powershell
set KB_MYSQL_URL=mysql://root:密码@127.0.0.1:3306/wkstudy
node src\index.js
```

### 2. 启动

```powershell
cd kb
node src\index.js        # 或直接运行 start.bat（端口 8347）
```

MCP 客户端配置：

```json
{
  "mcpServers": {
    "kb": {
      "url": "http://127.0.0.1:8347/"
    }
  }
}
```

端口可用环境变量 `KB_PORT` 覆盖（`start.bat` 默认 8347，与 neton 8341 / webview 8342 / search 8343 / find 8344 / calc 8345 / analyze 8346 错开）。

> 没配数据库服务器也能启动——这时调 `kb_sources` 或 `kb_config` 会告诉你缺什么、怎么配。

## 使用示例

```
kb_sources()                                          # 有什么库、通不通
kb_sources(verbose=true)                              # 连每张表的名字也列出来
kb_schema(knowledgeBase="系统管理")                    # 这个知识库有哪些表
kb_schema(table="mydb.cms_article")                   # 单表结构（重点看注释）
kb_stats(countRows=true)                              # 每张表真实行数，发现空表

kb_search(query="权限")                                # 全库找"权限"出现在哪
kb_search(query="登录 失败", mode="and")               # 两个词都命中
kb_search(query="文章", knowledgeBase="内容管理")       # 限定知识库
kb_search(query="test", offset=10)                    # 翻页

kb_query(sql="SELECT * FROM `mydb`.`sys_user` LIMIT 5")
kb_query(sql="SELECT * FROM `mydb`.`sys_role` WHERE role_code = ?", params=["admin"])
kb_config(refresh=true)                               # 改完配置热重载
```

### 一次真实的完整流程

**问：这个系统里每种角色各有多少人？**

第 1 步，`kb_search(query="管理员", mode="or")` 找到"角色"这个概念落在哪：

```
搜索「管理员」 · 知识库 系统管理/内容管理/图谱配置 · 扫描 11 张表 · 命中 3 条

1. **wkstudy.sys_role.role_desc**  [id=2]
   系统管理员，拥有大部分管理权限
2. **wkstudy.sys_role.role_name**  [id=1]
   超级管理员
3. **wkstudy.sys_role.role_name**  [id=2]
   系统管理员
```

每条命中都带 `[id=2]` 这样的主键，Agent 可以直接回查，不用再猜。

第 2 步，`kb_schema(table="wkstudy.sys_user_role")` 确认关联表结构，然后 `kb_query` 联表：

```
数据源 local · 耗时 2ms · 返回 3 行（原始查询无 LIMIT，已自动加 LIMIT 200）

| 角色       | 代码  | 用户数 |
|------------|-------|--------|
| 系统管理员 | admin | 1      |
| 超级管理员 | root  | 1      |
| 普通用户   | user  | 1      |

列：角色, 代码, 用户数
```

全程 Agent 没有见过一次 `SHOW TABLES` 的原始输出，也不用猜列名 —— 这就是"表注释"和"知识库"这两层设计的作用。

## 工作原理

### 自实现的 MySQL 客户端协议（零依赖）

不引 `mysql2` 是刻意的（本仓库的约定是每个工具集零依赖）。实际实现范围：

| 环节 | 实现 |
|------|------|
| 握手包 | 协议版本、服务器版本、连接 id、20 字节 salt、capability 低/高位拼装 |
| 认证 | `mysql_native_password`（SHA1 三轮）、`caching_sha2_password`（SHA256 + fast-auth / full-auth）、`mysql_clear_password` |
| 认证切换 | `AuthSwitchRequest` / `AuthMoreData` 状态机 |
| TLS | 服务器支持且 `ssl:true` 时发 SSL_REQUEST 后升级（full-auth 需明文密码，无 TLS 时**宁可失败也不明文发送**） |
| 命令 | `COM_QUERY`（文本协议）、`COM_PING`、`COM_QUIT` |
| 结果集 | 列定义包解析、逐行长度编码字符串、EOF/OK 终止包、`DEPRECATE_EOF` 兼容 |
| 包分片 | payload ≥ 16MB-1 自动拆续包（含"正好整除需补空包"的边界） |

**刻意不做**：预处理语句（binary protocol）、多结果集、LOCAL INFILE、压缩协议。
这些对本工具集没有收益，却会让代码量和出错面翻倍。

### 类型解码的几个关键决定

文本协议下所有值都以字符串到达，还原成 JS 类型时有几处刻意保守：

- **`DECIMAL` 保留字符串**（`'1.50'` 而不是 `1.5`）—— 浮点数存不下它的精度，金额类字段不能悄悄变样
- **超出 `Number.MAX_SAFE_INTEGER` 的 `BIGINT` 保留字符串** —— 雪花 ID 会被 JS 浮点截断，这是很常见的坑
- **`DATETIME` 默认给字符串** —— 避免时区与格式歧义
- **零值日期** `'0000-00-00'` 保留字符串 —— 转 `Date` 会得到 `Invalid Date`
- **`utf8mb4` 映射到 Node 的 `utf8`** —— Node 不认识 `utf8mb4` 这个名字，直接用会抛 `Unknown encoding`
- **`BLOB` + `BINARY` 标志返回 `{$binary:true, bytes:N}`** —— 不把图片二进制塞进 JSON

### 安全：四道闸门

1. **只读闸门**（默认开启）
   把注释剥掉后再判断，`INSERT/UPDATE/DELETE/REPLACE/TRUNCATE/DROP/ALTER/CREATE/GRANT/LOAD DATA/CALL` 全部拒绝；
   **多语句也拒绝**（挡住 `SELECT 1; DROP TABLE x`）；
   只放行 `SELECT / SHOW / DESCRIBE / EXPLAIN / WITH / USE / SET @`。
2. **自动补 LIMIT**
   没有 LIMIT 的 `SELECT`/`WITH` 会被套上 `LIMIT n`（默认 200，硬上限 2000 可配）。避免 `SELECT *` 把上下文撑爆。
3. **越界拦截**
   指定 `knowledgeBase` 时，SQL 里引用的表必须在知识库白名单内。系统元数据库（`information_schema` 等）刻意放行，因为探查结构是高频且无害的操作。
4. **参数化 + 打码**
   `?` 占位符由客户端侧严格转义（数字校验 `isFinite`、字符串转义 `' " \ \0 \n \r \x1a`、对象类型直接拒绝），
   不把对象 `stringify` 进 SQL；配置里 `redact` 的列（如 `password`）在输出中打码。

> 实测：9 种绕过写法（大写混写、注释包裹、`--` 行注释前置、多语句拼接）全部被拦下。

### 输出预算（Agent 上下文经济）

- 行数：默认 200 / 硬上限 2000，超限时提示"加 WHERE 收窄 / 先 COUNT 看总量"
- 单元格：默认截断 500 字符，换行转成 `␤` 以免破坏表格
- 总量：单次输出默认 24000 字符，超出时按行丢弃并**明确告知丢了多少行**
- Markdown 表格按**等宽显示宽度**对齐（CJK 字符算 2 列），终端里不会错位

### 连接池

- 每数据源一个池，默认最多 4 条连接，闲置 60s 回收
- 池满时 FIFO 排队而非报错（Agent 侧表现为"稍慢一点"）
- 连接被服务器掐断时**自动换连接重试一次**，不把 `PROTOCOL_CONNECTION_LOST` 抛给 Agent

### Schema 缓存

`information_schema` 查询结果缓存 5 分钟（`kb_stats` 的 `countRows`、`kb_schema` 的 `refresh` 可绕过）。
表结构变化不频繁，缓存能显著减少往返。

### 隐私与边界

- **只读**：默认拒绝一切写操作；唯一写盘行为是 `logs/kb.log`（含 SQL 审计）与内存缓存
- **凭据不外传**：`kb_config` 的输出里数据源只给 `passwordSet: true/false`，**根本不包含密码字段**
- 日志里的 SQL 截断到 300 字符；`kb_query` 的审计条目含数据源、行数、耗时
- 静态能力边界：只能查**已配置的表**；动态拼 SQL、存储过程内部逻辑抓不到

## 目录结构

```
kb/
├── package.json
├── start.bat                      # 端口 8347 一键启动
├── kb.config.example.json         # 配置示例（支持注释）
├── README.md
├── test/
│   ├── protocol.test.js           # MySQL 协议层直连测试（34 项，无需 MCP）
│   └── mcp.e2e.js                 # 端到端：自起服务器 + JSON-RPC（60 项）
└── src/
    ├── index.js                   # 入口：崩溃钩子 + 启动时尝试加载配置但不因此退出
    ├── mcp/server.js              # MCP Streamable HTTP 服务器（零依赖）
    ├── db/
    │   ├── protocol.js            # 包编解码：长度编码整数/字符串、16MB 分片
    │   ├── types.js               # 列类型常量、字符集映射、值解码
    │   ├── connection.js          # 握手 / 认证 / COM_QUERY / 结果集解析 / 参数转义
    │   └── pool.js                # 连接池（复用、排队、闲置回收）
    │   └── pool-manager.js        # 多数据源路由 + 只读闸门
    ├── kb/
    │   ├── config.js              # 配置加载/规范化/URL 解析/凭据脱敏
    │   ├── schema.js              # information_schema 内省 + 缓存
    │   └── runtime.js             # 配置+池+schema 的单例（懒加载，失败不崩）
    ├── tools/
    │   ├── registry.js            # 工具注册表
    │   ├── kb-sources.js  kb-schema.js  kb-search.js
    │   ├── kb-query.js    kb-stats.js   kb-config.js
    │   └── format.js              # 表格/CJK 宽度/截断
    └── utils/logger.js            # 日志 + SQL 审计（logs/kb.log）
```

## 测试

```powershell
cd kb

# 协议层：直连 MySQL 跑 34 项断言（握手/认证/各类型解码/错误码/多行/重名列/空结果集）
node test\protocol.test.js

# 端到端：自起服务器 + 完整 JSON-RPC（含 9 种注入绕过 + 越界 + 参数化防注入）
node test\mcp.e2e.js

# 一起跑
npm run test:all
```

连接参数可用环境变量覆盖：`KB_TEST_HOST` / `KB_TEST_PORT` / `KB_TEST_USER` / `KB_TEST_PASSWORD` / `KB_TEST_DB`。

数据库不可达时，端到端测试会把依赖数据的断言标记为 `SKIP`，但**协议与安全断言仍会执行**——安全护栏的测试不依赖真实数据。

## 实测结果

在本机 **MariaDB 12.3.3**（`wkstudy` 库，14 张表 / 161 列）上：

| 项目 | 结果 |
|------|------|
| 协议层测试 | **34 / 34 通过** |
| 端到端测试 | **60 / 60 通过** |
| 语法检查 | 21 个源文件全部通过 |
| 只读绕过测试 | 9 种写法全部拦下 |
| 结果正确性 | 与本机 `mysql.exe` 输出**逐行一致**（交叉验证过联表计数） |

连通性开销：首次连接 ~6ms，缓存后的 schema 查询与联表查询均在 2~10ms 量级。

> 兼容性说明：实现基于 MySQL 客户端/服务器协议的公共部分，已在 MariaDB 上充分实测；
> MySQL 8 的默认认证 `caching_sha2_password` 也已实现（fast-auth 走缓存，full-auth 需 `ssl:true`）。
