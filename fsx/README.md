# Fsx

本机文件系统操作 MCP 服务器 —— **让 AI 直接读、写、改、列、搜、复制、移动、删除你显式指定的文件**（零依赖，Streamable HTTP 协议）。

这是 TentacleTool 的第 10 个工具集。与 `find`（只搜不写）不同，fsx 是**有写能力的执行器**，因此删除被设计成四道安全闸（见「删除策略」）。

零依赖（仅用 Node 原生 `fs` / `path` / `os`），MCP Streamable HTTP 协议（2025-03-26）。

## 解决什么问题

AI 经常需要："读一下这个配置文件的第 30 行"、"把这段日志里的 IP 都改掉"、"列出 src 下所有 .ts 文件"、"这个目录结构长啥样"、"删掉刚才生成的临时文件"。fsx 让你把路径交给它，它就只动你指名的那一处，不扫整盘、不猜你的意图。

## 工具一览

| 工具 | 用途 | 亮点 |
|------|------|------|
| `fsx_read` | 读文件 | 行范围(startLine/endLine)、编码、大文件分页、二进制检测、续读提示 |
| `fsx_write` | 写文件 | 覆盖/追加、自动建父目录、返回字节数与行数 |
| `fsx_edit` | 精确文本替换 | oldText/newText、replaceAll，匹配数校验（0 或多处报错），返回改动摘要+行号 |
| `fsx_list` | 列目录 | 递归/深度/glob 过滤/排序(name/size/mtime)/limit + 翻页提示 |
| `fsx_tree` | 目录树 | 可视树形、深度限制、默认忽略 node_modules/.git 等噪声项 |
| `fsx_stat` | 文件属性 | 大小/时间/类型/权限/行数/编码猜测，支持批量多路径 |
| `fsx_grep` | 内容搜索 | 正则或字面量、文件类型过滤、上下文行、命中行号、limit + 翻页提示 |
| `fsx_copy` | 复制 | 文件或目录、覆盖开关 |
| `fsx_move` | 移动/重命名 | 跨盘自动处理（复制后删源） |
| `fsx_delete` | 删除 | 四道安全闸（confirm/recursive/受保护路径/dryRun），默认拒绝 |

## 快速开始

```powershell
cd fsx
node src\index.js        # 或直接运行 start.bat（端口 8350）
```

MCP 客户端配置（Claude / Cursor / WorkBuddy 等）：

```json
{
  "mcpServers": {
    "fsx": {
      "url": "http://127.0.0.1:8350/"
    }
  }
}
```

端口可用环境变量 `FSX_PORT` 覆盖（`start.bat` 默认 8350，与 neton 8341 / webview 8342 / search 8343 / find 8344 / calc 8345 / analyze 8346 / kb 8347 / stamp 8348 / jsonx 8349 错开）。

## 使用示例

```
fsx_read(path="C:\\proj\\app.js", startLine=30, endLine=60)
fsx_write(path="C:\\proj\\out.txt", content="hello", mode="append")
fsx_edit(path="C:\\proj\\cfg.json", oldText="127.0.0.1", newText="10.0.0.1", replaceAll=true)
fsx_list(path="C:\\proj\\src", recursive=true, pattern="*.ts", sort="size", order="desc")
fsx_tree(path="C:\\proj", depth=3)
fsx_stat(paths=["C:\\proj\\a.js", "C:\\proj\\b.js"])
fsx_grep(pattern="TODO", path="C:\\proj\\src", recursive=true, include="*.ts", context=1)
fsx_copy(source="C:\\proj\\a", dest="C:\\proj\\a.bak", overwrite=true)
fsx_move(source="C:\\proj\\old.txt", dest="C:\\proj\\new.txt")
fsx_delete(path="C:\\proj\\tmp", confirm=true, recursive=true)
```

## 工作原理

所有工具都遵循同一套契约：

- **纯本地、零依赖**：只用 `node:fs` / `node:path` / `node:os`，不联网、不引任何 npm 包。
- **路径以你传入的为准**：每个工具只操作你 `path` 参数显式指名的文件/目录，绝不扫描整盘、绝不递归你没要求的范围。
- **结构化 + 面向模型的双输出**：`run` 返回 `{ _text, ...structured }`——`_text` 是给模型读的紧凑纯文本（表格列宽按 CJK 计 2 列、`null` 显示为 `—`、长内容截断 + 翻页提示），`structured` 是给程序消费的机器可读结果，由服务器分别放进 `content[0].text` 与 `structuredContent`，绝不把整个对象当文本回显。
- **上下文经济**：列表/搜索默认小 limit（list 100、grep 50 命中），超量给出翻页提示；读写有行范围与分页，避免把大文件整页塞回上下文。

## 删除策略（重要）

`fsx_delete` 是天然危险品，**闸门先于功能设计**，共四道：

1. **未确认拒绝执行**：没有 `confirm=true` 一律不删，只返回"将要删除什么"的预览清单（路径 + 大小 + 总数）。
2. **目录需显式 recursive**：删除目录必须 `recursive=true`，否则拒绝（避免一个手滑删掉整个目录树）。
3. **受保护路径拒绝**：盘符根（`C:\`）、用户主目录本身、其上层目录、系统目录（`Windows` / `Program Files` / `ProgramData` 等，含子目录）**一律拒绝**。**路径先 `path.resolve` 规范化再判断**，因此以下绕过手法全部无效：大小写变体（`C:\WINDOWS`）、末尾斜杠（`C:\Windows\`）、`..` 相对穿越（`C:\Windows\..`）、多级穿越（`C:\Users\..\Windows`）。
4. **dryRun 只预览**：`dryRun=true` 只返回预览、不执行删除（与 `confirm` 并存时仍不删）。

所有闸门都有对应测试断言（不只是"正常路径能删"）。正常删除一个你自己的临时文件，按 `confirm=true` 调用即可。

## 隐私与安全边界

- **写能力受控**：除 `fsx_delete` 的四道闸外，复制/移动覆盖现有目标也需 `overwrite=true`，不会静默覆盖。
- **只读系统资产**：受保护路径（系统目录、主目录、盘符根）任何写/删操作都被 `fsx_delete` 拦下；其它工具本身也只动你指名的路径。
- **唯一写盘行为**：除你要求的文件操作外，服务器只写 `logs/fsx.log`（在工具集目录内，已被 `.gitignore` 排除）；不读、不上传、不缓存你的任何文件内容到外部。

## 目录结构

```
fsx/
├── package.json          # name: fsx-mcp-server，端口 8350
├── start.bat             # 一键启动（端口 8350）
├── README.md
├── .gitignore            # 排除 logs/、node_modules/
├── test/
│   ├── smoke.test.js     # 纯逻辑层单测（os.tmpdir 隔离，不碰真实文件）
│   └── mcp.e2e.js        # 端到端：自 spawn 服务器 + 完整 JSON-RPC（端口 18350）
└── src/
    ├── index.js          # 入口：端口兜底 8350 + 崩溃钩子 + SIGINT/SIGTERM
    ├── mcp/server.js     # MCP Streamable HTTP 服务器（零依赖，修正 {text,structured} 契约）
    ├── tools/
    │   ├── registry.js   # 工具注册表（10 个工具）+ executeTool 拆 {text,structured}
    │   ├── fsx-read.js   # 读文件
    │   ├── fsx-write.js  # 写文件
    │   ├── fsx-edit.js   # 精确替换
    │   ├── fsx-list.js   # 列目录
    │   ├── fsx-tree.js   # 目录树
    │   ├── fsx-stat.js   # 文件属性
    │   ├── fsx-grep.js   # 内容搜索
    │   ├── fsx-copy.js   # 复制
    │   ├── fsx-move.js   # 移动
    │   └── fsx-delete.js # 删除（四道安全闸）
    └── utils/
        ├── logger.js     # 日志（logs/fsx.log）
        ├── format.js     # 表格/CJK 列宽/截断
        └── fsutil.js     # glob→正则、二进制检测、编码猜测、行数、权限、受保护路径判定
```

## 测试

零依赖，纯逻辑层：

```powershell
npm test                 # 等价于 node test/smoke.test.js（os.tmpdir 隔离）
npm run test:e2e         # 等价于 node test/mcp.e2e.js（自 spawn 端口 18350）
```

- `smoke.test.js`：在 `os.tmpdir()` 自建临时目录操作，结束清理，**绝不碰用户真实文件**；覆盖读写改/列树/属性/搜索/复制移动/删除四闸及 bypass。
- `mcp.e2e.js`：自己 spawn 服务器，走完整 `initialize → notifications/initialized → tools/list → 各工具真实调用`，并断言 `{text, structured}` 契约与删除安全闸。
