# Find

本机文件搜索 MCP 服务器 —— **让 AI 在你的电脑上翻箱倒柜找到要找的东西**（Everything 风格）。

零依赖（Node 原生模块 + 可选的 C 原生索引器），MCP Streamable HTTP 协议（2025-03-26）。

## 解决什么问题

AI 经常需要："找到那个配置文件"、"我刚改过的文件叫什么"、"这个函数在哪个文件里"、"node 装在哪"。
Find 用一份**预建的全盘索引**（路径 + 大小 + mtime）秒答这些问题，输出全部折叠成紧凑列表，不吃上下文。

## 工具一览

| 工具 | 用途 | 亮点 |
|------|------|------|
| `find_files` | 按文件名/路径搜索 | sub/fuzzy/glob/regex 四模式 + 评分排序 + 翻页 |
| `find_recent` | 最近修改的文件 | 默认近 24h，`within="7d"` 自定义时间窗 |
| `find_in_files` | 文件内容搜索 | grep 风格带行号，文本白名单 + 二进制嗅探 + 多重上限 |
| `find_tool` | 可执行工具定位 | PATH 扫描 + 全盘索引兜底，返回可直接调用的绝对路径 |

## 快速开始

```powershell
cd find
node src\index.js        # 或直接运行 start.bat（端口 8344）
```

MCP 客户端配置（Claude / Cursor / WorkBuddy 等）：

```json
{
  "mcpServers": {
    "find": {
      "url": "http://127.0.0.1:8344/"
    }
  }
}
```

端口可用环境变量 `FIND_PORT` 覆盖（`start.bat` 默认 8344，与 neton 8341 / webview 8342 / search 8343 错开）。

## 使用示例

```
find_files(query="mcp-server")                    # 名字含 mcp-server 的文件/目录
find_files(query="*.sln", mode="glob")            # 通配
find_files(query="tntlclr", mode="fuzzy")         # 只记得大概拼写
find_recent(root="C:\\Users\\me\\proj")           # 这个项目最近 24h 改了什么
find_in_files(query="createServer", root="C:\\Users\\me\\proj", ext="js,ts")
find_tool(name="node")                            # → C:\Program Files\nodejs\node.exe
```

## 工作原理

### 索引（两级实现，原生优先）

| 引擎 | 实现 | 实测（本机 19 万条目） |
|------|------|------------------------|
| **原生 C**（推荐） | `src/native/findidx.exe`，`FindFirstFileW` + 8 线程 | **约 0.5 秒** |
| JS 兜底 | `src/utils/indexer.js`，`readdir` + 并发 `stat` | 约 10 秒 |

服务器启动时**优先调用原生 exe**；exe 不存在（未编译/非 Windows）或执行失败时**自动回退 JS 版**，
两者产出的索引数据与跳过规则完全一致。工具输出页脚会标注当前用的是哪个引擎。

```powershell
# 编译原生索引器（需要 MinGW-w64 gcc；Strawberry Perl 自带的即可）
cd src\native
build.bat
```

原生版为什么快：`FindFirstFileW` **一次系统调用就拿全**目录项的名字/大小/时间（JS 版需要
`readdir` + 每个文件一次 `stat`，约 2 倍系统调用 + 全部 JS 开销）；`\\?\` 前缀支持超长路径；
多线程分摊目录遍历。产物是**与 JS 版完全相同的 TSV** 缓存，Node 端统一从缓存加载。

> 不编译也能用——JS 版功能完全相同，只是首次构建慢一些。

### 通用索引机制

- 服务启动即**后台预热索引**；首次调用若索引未就绪会现场构建，之后走缓存秒回
- 扫描根：用户主目录 + 所有存在的固定盘符；重叠子树自动去重
- 符号链接/junction 一律跳过（防循环）
- 索引条目：路径 / 大小 / mtime / 是否目录，TSV 存储在 `cache/index.tsv`
- **TTL 6 小时**自动过期重建；任意工具传 `refresh=true` 立即重建
- 双上限：深度 12 层、条目 25 万条，超限标记 truncated 并在输出中提示

### 跳过名单（整棵跳过）

- 开发噪声：`node_modules` `.git` `.svn` `__pycache__` `.gradle` `venv` `target` `dist` 等
- 系统区域：`AppData` `Windows` `Program Files` `ProgramData` `Recovery` 等
- 缓存/临时：`cache` `Temp` `Packages` `Google` `Microsoft` `Docker` 等
- 回收站/元数据：`$Recycle.Bin` `System Volume Information` 等（`$` 开头一律跳过）
- **home 根目录下的点目录与云缓存**（如 `.trae-cn` `.workbuddy` `.codebuddy` `WPS Cloud`）：
  IDE/Agent 内部状态与网盘缓存动辄十几万条文件，实测能把整个索引预算撑爆，
  因此只跳过"home 的直接子项"，项目内部的点目录（`.vscode`/`.github`）不受影响

> 被跳过目录里的文件搜不到，这是刻意的——省下预算换取"常用位置"的完整覆盖。
> 需要找 AppData 里的东西时，用 `find_tool`（PATH 扫描不受索引限制）或系统自带 search。

### 内容搜索的成本控制

`find_in_files` 只扫文本类扩展名白名单，单文件 ≤1MB，前 8KB 含 `\0` 判定二进制跳过；
每文件最多 5 处、总计 50 处、最多 4000 个候选、10 秒预算，候选按 mtime 新→旧优先。
非 UTF-8（如 GBK）编码文件中的中文可能匹配不到，ASCII 关键词不受影响。

### 隐私与边界

- **只读**：所有工具只读文件系统，绝不写入/移动/删除任何用户文件
- 唯一写盘行为是 `cache/index.tsv` 索引缓存与 `logs/find.log` 日志（均在工具集目录内）

## 目录结构

```
find/
├── package.json
├── start.bat              # 端口 8344 一键启动
├── README.md
└── src/
    ├── index.js           # 入口：启动 + 后台预热索引
    ├── mcp/server.js      # MCP Streamable HTTP 服务器（零依赖）
    ├── native/
    │   ├── findidx.c      # 原生索引器（C + Win32，多线程，与 JS 版行为一致）
    │   ├── findidx.exe    # 编译产物（缺失时自动回退 JS 版）
    │   └── build.bat      # 编译脚本（gcc -O2）
    ├── tools/
    │   ├── registry.js    # 工具注册表
    │   ├── find-files.js  # 文件名搜索
    │   ├── find-recent.js # 最近修改
    │   ├── find-in-files.js # 内容搜索
    │   └── find-tool.js   # 工具定位
    └── utils/
        ├── indexer.js     # 索引调度：原生优先 + JS 兜底 + TSV 缓存
        ├── matcher.js     # 四模式评分匹配
        ├── format.js      # 大小/时间紧凑格式化
        └── logger.js      # 日志（logs/find.log）
```
