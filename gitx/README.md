# Gitx

Git 仓库操作 MCP 服务器 —— **让 AI 在你的 Git 仓库里看状态、查历史、看差异、blame、管分支/stash/remote、做本地提交**（零依赖，Streamable HTTP 协议）。

这是 TentacleTool 的第 11 个工具集。与 `find`、`fsx` 不同，gitx 把 Git 的能力以「只读 + 本地安全提交」的方式暴露给模型，所有操作都走 `git -C <repoPath>`，**默认作用于你显式传入的 repoPath，未传则用当前工作目录**。

零依赖（仅用 Node 原生 `child_process` / `fs` / `path`），MCP Streamable HTTP 协议（2025-03-26）。

## 解决什么问题

AI 经常需要："这个仓库现在是什么状态"、"最近谁改了这行"、"这次提交改了哪些文件"、"这个文件的历史"、"切到 feature 分支"、"把暂存的内容提交了"。gitx 让你把仓库路径交给它，它就只动你指名的那一处，不扫整盘、不猜你的意图。

## 工具一览

| 工具 | 用途 | 亮点 |
|------|------|------|
| `gitx_status` | 工作区状态 | 当前分支、暂存/未暂存/未跟踪变更、领先/落后、最近提交摘要 |
| `gitx_log` | 提交历史 | limit、作者/日期/路径过滤、oneline 或详细模式、含每提交文件统计 |
| `gitx_diff` | 差异比较 | 工作区/暂存区/两提交间；stat 模式；路径过滤；限制输出行数 |
| `gitx_show` | 查看提交/文件 | 某提交详情与 diff，或某文件在某提交时的内容 |
| `gitx_blame` | 逐行归属 | 文件 + 可选行范围，输出 行号/提交/作者/日期/内容 |
| `gitx_file_history` | 单文件历史 | 含重命名跟踪（`--follow`） |
| `gitx_branch` | 分支操作 | list/create/switch/delete（★ 安全闸：不删当前分支；删未合并需 force） |
| `gitx_stash` | 暂存管理 | list / save / pop / apply / drop（都是可逆操作） |
| `gitx_remote` | 远程管理 | 远程列表/URL/跟踪关系；可选 fetch（只拉取不改工作区） |
| `gitx_commit` | 本地提交 | 必须显式 message；可选 addAll 先暂存全部 |

## 快速开始

```powershell
cd gitx
node src\index.js        # 或直接运行 start.bat（端口 8351）
```

MCP 客户端配置（Claude / Cursor / WorkBuddy 等）：

```json
{
  "mcpServers": {
    "gitx": {
      "url": "http://127.0.0.1:8351/"
    }
  }
}
```

端口可用环境变量 `GITX_PORT` 覆盖（`start.bat` 默认 8351，与 neton 8341 / webview 8342 / search 8343 / find 8344 / calc 8345 / analyze 8346 / kb 8347 / stamp 8348 / jsonx 8349 / fsx 8350 错开）。

> **git 可执行文件位置**：本机 git 不一定在 PATH 里。`start.bat` 已通过 `GIT_BINARY` 指向 `C:\Program Files\Git\cmd\git.exe`。
> 你也可以在任何调用里传 `gitBinary` 参数，或设置环境变量 `GIT_BINARY` 覆盖默认值（`git`）。

## 使用示例

```
gitx_status(repoPath="C:\\proj")
gitx_log(repoPath="C:\\proj", limit=20, oneline=true)
gitx_diff(repoPath="C:\\proj", staged=true)
gitx_diff(repoPath="C:\\proj", commit="abc1234", commit2="def5678")
gitx_show(repoPath="C:\\proj", ref="HEAD", path="src/app.js")
gitx_blame(repoPath="C:\\proj", path="src/app.js", startLine=10, endLine=30)
gitx_file_history(repoPath="C:\\proj", path="src/app.js")
gitx_branch(repoPath="C:\\proj", action="list")
gitx_branch(repoPath="C:\\proj", action="delete", name="old-feature", force=true)
gitx_stash(repoPath="C:\\proj", action="save", message="WIP", includeUntracked=true)
gitx_remote(repoPath="C:\\proj", action="list")
gitx_commit(repoPath="C:\\proj", message="fix: ...", addAll=true)
```

## 工作原理

所有工具都遵循同一套契约：

- **零依赖**：只用 `node:child_process` / `node:fs` / `node:path`，不联网、不引任何 npm 包。
- **一律 `git -C <repoPath>`**：路径以你传入的为准；repoPath 默认当前目录；非 git 仓库会给出明确错误（「不是 Git 仓库」或「路径不存在」）而非崩溃。
- **git 二进制可覆盖**：`gitBinary` 参数 或 `GIT_BINARY` 环境变量，默认 `git`（本机不在 PATH 时用它们指向真实路径）。
- **结构化 + 面向模型的双输出**：`run` 返回 `{ _text, ...structured }`——`_text` 是给模型读的紧凑纯文本（表格列宽按 CJK 计 2 列、`null` 显示为 `—`、长内容截断 + 续读提示），`structured` 是给程序消费的机器可读结果，由服务器分别放进 `content[0].text` 与 `structuredContent`，绝不把整个对象当文本回显。
- **上下文经济**：历史/blame/差异默认小 limit、限制输出行数；超量给出截断与续读提示，避免把大仓库内容整页塞回上下文。

## ★ 安全边界（刻意不做的事）

**gitx 刻意不做以下操作，请在你自己的终端完成：**

- `git push` / `git push --force`（推送到远端）
- `git reset --hard`（丢弃工作区/暂存区改动）
- `git clean -fdx`（删除未跟踪文件）
- `git rebase`（改写历史）
- 任何其它改写历史或破坏工作区的危险操作

原因：这些操作不可逆、且涉及远端协作与历史完整性，交给人类在终端显式执行更安全、更可控。gitx 的定位是「只读 + 本地安全提交」——`gitx_commit` 只做本地提交（且必须你显式给 message），绝不自动 push。

分支删除这道闸也遵循同一思路：`gitx_branch(action="delete")` **不能删除当前分支**；删除**未合并**分支必须显式 `force=true`（`git branch -D`），否则用 `-d` 且未合并会被 git 拒绝、工具会提示你用 force。

## 隐私与安全边界

- **只读与本地提交为主**：除 `gitx_commit` 的本地提交外，其余工具都不改写仓库；唯一写盘行为是 `logs/gitx.log`（在工具集目录内，已被 `.gitignore` 排除）。
- **不读写你的代码内容到外部**：工具只调用本地 git 并返回结果，不联网、不上传。
- **不碰你的真实仓库**：本工具集的测试全部在 `os.tmpdir()` 自建临时 git 仓库里跑，测完清理，绝不触碰 TentacleTool 仓库本身。

## 目录结构

```
gitx/
├── package.json          # name: gitx-mcp-server，端口 8351
├── start.bat             # 一键启动（端口 8351，已设 GIT_BINARY）
├── README.md
├── .gitignore            # 排除 logs/、node_modules/
├── test/
│   ├── smoke.test.js     # 纯逻辑层单测（os.tmpdir 自建临时 git 仓库，不碰真实仓库）
│   └── mcp.e2e.js        # 端到端：自 spawn 服务器 + 完整 JSON-RPC（端口 18351）
└── src/
    ├── index.js          # 入口：端口兜底 8351 + 崩溃钩子 + SIGINT/SIGTERM
    ├── mcp/server.js     # MCP Streamable HTTP 服务器（零依赖，修正 {text,structured} 契约）
    ├── tools/
    │   ├── registry.js   # 工具注册表（10 个工具）+ executeTool 拆 {text,structured}
    │   ├── gitx-status.js
    │   ├── gitx-log.js
    │   ├── gitx-diff.js
    │   ├── gitx-show.js
    │   ├── gitx-blame.js
    │   ├── gitx-file-history.js
    │   ├── gitx-branch.js
    │   ├── gitx-stash.js
    │   ├── gitx-remote.js
    │   └── gitx-commit.js
    └── utils/
        ├── logger.js     # 日志（logs/gitx.log）
        └── gitutil.js   # git 二进制解析、仓库校验、命令执行、CJK 宽字符排版、截断
```

## 测试

零依赖，纯逻辑层 + MCP 端到端：

```powershell
npm test                 # 等价于 node test/smoke.test.js（os.tmpdir 临时 git 仓库）
npm run test:e2e         # 等价于 node test/mcp.e2e.js（自 spawn 端口 18351）
```

- `smoke.test.js`：在 `os.tmpdir()` 自建临时 git 仓库，覆盖 10 个工具的核心行为与安全闸（分支删除保护、commit 缺 message、非 git 仓库报错等），结束清理，**绝不碰用户真实文件**。
- `mcp.e2e.js`：自己 spawn 服务器，走完整 `initialize → notifications/initialized → tools/list → 各工具真实调用`，并断言 `{text, structured}` 契约（content[0].text 为纯文本、structuredContent 不含 `_text`）、工具清单与分支安全闸。
