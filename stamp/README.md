# Stamp — 时间与调度 MCP 工具集

> 零依赖的 MCP 服务器（Streamable HTTP, 2025-03-26）。把「时间」这件事做对：
> 时间戳转换、时长解析、时区换算、工作日推算、cron 解析与触发预测。

## 为什么需要它

Agent 在时间上犯的错几乎都长一个样：

- 把训练数据里的年份当成"今年"
- 拿 `Date` 手算时区，得出"东京现在几点"这类算不出来的答案
- 把纽约的偏移写死成 `-05:00`，忘了夏天是 `-04:00`
- 把 cron 的 `0 0 1 * 1` 读成"每月 1 号且是周一"（标准语义其实是 **OR**）

Stamp 用 `Intl.DateTimeFormat` 取真实偏移、严格区分「墙钟时间」与「绝对时刻」，
并在输出里主动标出夏令时与语义陷阱。

## 快速开始

```bash
cd stamp
npm start          # 或双击 start.bat
```

服务默认监听 `127.0.0.1:8348`（用 `STAMP_PORT` 环境变量可改）。

接入 MCP 客户端（在客户端配置里加一个 custom connector，指向 `http://127.0.0.1:8348`）：

```json
{
  "mcpServers": {
    "stamp": { "url": "http://127.0.0.1:8348" }
  }
}
```

## 工具一览

| 工具 | 用途 | 关键点 |
|------|------|--------|
| `stamp_now` | 当前真实时间 | 多时区墙钟 + epoch 四种量级 + 今天/本周/本月/本年边界。**任何涉时任务的第一步** |
| `stamp_convert` | 时间格式万能转换 | epoch ↔ 日期字符串，自动识别秒/毫秒/微秒/纳秒；支持 `now`/`today`/`+3d` 等相对表达 |
| `stamp_duration` | 时长解析与换算 | `1h30m` / `1天2小时` / `1.5h` / `90s`；也支持两时刻求间隔 |
| `stamp_zone` | 时区换算与偏移查询 | 多时区对照 + 夏令时提醒 + 全年 DST 起止 + 跨日提醒 |
| `stamp_workday` | 工作日推算 | 加/减 N 工作日、区间统计、单日判定；支持节假日与**调休** |
| `stamp_cron` | cron 解析与预测 | 中文描述 + 未来 N 次真实触发时刻；主动提示 OR 语义等陷阱 |

## 使用示例

### 校准时间（先做这个）

```json
{ "name": "stamp_now", "arguments": { "timeZones": ["Asia/Shanghai", "America/New_York", "UTC"] } }
```

### 时间戳互转

```json
{ "name": "stamp_convert", "arguments": { "value": 1758180000, "zone": "Asia/Shanghai" } }
```

```json
{ "name": "stamp_convert", "arguments": { "value": "2026-09-18T14:30:00Z", "zone": "Asia/Shanghai", "all": true } }
```

`all: true` 会一次性列出 ISO 8601 / RFC 2822 / 四种 epoch / 本地 / 相对时间等全部格式。

### 时区换算（含夏令时）

```json
{
  "name": "stamp_zone",
  "arguments": {
    "time": "2026-09-18T14:30:00",
    "from": "Asia/Shanghai",
    "toZones": ["Asia/Tokyo", "Europe/London", "America/New_York"]
  }
}
```

查某时区全年的偏移变化：

```json
{ "name": "stamp_zone", "arguments": { "zoneInfo": "America/New_York", "year": 2026 } }
```

```
■ 夏令时区间
| 事件       | 日期       | 偏移变化        |
|------------|------------|-----------------|
| 进入夏令时 | 2026-03-09 | -05:00 → -04:00 |
| 退出夏令时 | 2026-11-02 | -04:00 → -05:00 |
```

### 工作日推算

```json
{ "name": "stamp_workday", "arguments": { "date": "2026-09-18", "days": 5 } }
```

带节假日与调休（中国日历的刚需）：

```json
{
  "name": "stamp_workday",
  "arguments": {
    "date": "2026-09-30",
    "days": 5,
    "holidays": ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"],
    "workdays": ["2026-10-10"]
  }
}
```

统计区间：

```json
{ "name": "stamp_workday", "arguments": { "from": "2026-09-01", "to": "2026-09-30" } }
```

> **为什么节假日要手工传？** 内置一份节假日表看起来方便，实际会制造"看起来对其实过期"的
> 静默错误。显式传入，错了你能看见。

### cron 解析

```json
{
  "name": "stamp_cron",
  "arguments": {
    "expression": "0 9 * * 1-5",
    "zone": "Asia/Shanghai",
    "from": "2026-09-18T10:00:00",
    "count": 5
  }
}
```

```
表达式：`0 9 * * 1-5`
段数：5 段（不含秒）
含义：第 0 分 · 9 点 · 每周一、二、三、四、五
时区：Asia/Shanghai（cron 表达式本身不含时区）
基准时刻：2026-09-18 10:00:00（周五）
■ 未来 5 次触发
| # | 时间                | 星期 | ISO 8601                  | epoch 秒   |
|---|---------------------|------|---------------------------|------------|
| 1 | 2026-09-21 09:00:00 | 周一 | 2026-09-21T09:00:00+08:00 | 1789952400 |
| 2 | 2026-09-22 09:00:00 | 周二 | 2026-09-22T09:00:00+08:00 | 1790038800 |
...
```

## 设计要点

### 时区运算不靠 `Date`

`Date` 只有「本地时区」和「UTC」两种视角，表达不了"东京现在几点"。
所有偏移一律走 `Intl.DateTimeFormat` + `formatToParts` 取真实值，
再手工做墙钟 ↔ UTC 换算。

### 墙钟时间 ≠ 绝对时刻

夏令时跳跃让两者不是一一对应：

- **不存在的时刻**（春季跳表，如纽约 `2026-03-08 02:30`）→ `stamp_zone` 换算返回 `null`，
  `stamp_cron` 里该次触发被正确跳过
- **重复的时刻**（秋季回拨）→ 取更早的那一次

`addWorkdays` 保持**墙钟时刻不变**（下午 3 点加 5 个工作日仍是下午 3 点），
而不是简单加 `5 × 86400` 秒。

### epoch 量级自动识别

| 位数 | 含义 | 典型来源 |
|------|------|----------|
| 10 | 秒 | Unix 标准、多数 API |
| 13 | 毫秒 | JavaScript、Java |
| 16 | 微秒 | Python、PostgreSQL |
| 19 | 纳秒 | Go、高精度计时 |

**例外**：8 位与 14 位纯数字按紧凑日期解释（`20260918` → 2026-09-18，
`20260918143000` → 2026-09-18 14:30）。这是刻意的消歧规则，否则 `20260918` 会被
当成 1970 年的某个时刻。

### cron 日与周是 OR 不是 AND

标准 cron 里，当日字段与周字段**都不是 `*`** 时，语义是 **OR**：

```
0 0 1 * 1      # 每月 1 号 或 每周一（不是"且"）
```

`stamp_cron` 会在描述里明确写出"两者满足其一"并给出提示。
想要 AND 语义 cron 做不到，需要脚本自行判断。

### 永不触发的表达式会被静态拒绝

`0 0 30 2 *`（2 月 30 日）在解析阶段就被拒绝，并说明原因，
而不是让你等几秒才收到一句模糊的"找不到"。
（若周字段也有限定，因 OR 语义仍可能触发，此时不判死。）

## 测试

```bash
cd stamp
npm test           # 单元测试（351 项）
npm run test:e2e   # 端到端（58 项，真起服务器走 JSON-RPC）
npm run test:all   # 全部
```

测试覆盖时区偏移、DST 双向边界（南北半球）、闰年 2 月 29 日、
cron 逐字段跳跃算法、工作日节假日与调休、以及全部错误路径。

## 目录结构

```
stamp/
├── src/
│   ├── index.js              入口（端口 8348）
│   ├── mcp/server.js         MCP Streamable HTTP 服务器（零依赖）
│   ├── tools/
│   │   ├── registry.js       工具注册与派发
│   │   ├── format.js         输出格式化（表格/截断/CJK 宽度）
│   │   ├── stamp-now.js
│   │   ├── stamp-convert.js
│   │   ├── stamp-duration.js
│   │   ├── stamp-zone.js
│   │   ├── stamp-workday.js
│   │   └── stamp-cron.js
│   └── utils/
│       ├── logger.js         文件日志（logs/stamp.log）
│       ├── time.js           时间引擎（时区/解析/时长/工作日）
│       └── cron.js           cron 引擎（解析/匹配/预测/描述）
├── test/
│   ├── smoke.test.js         单元测试
│   └── mcp.e2e.js            端到端测试
├── start.bat
└── package.json
```

## 依赖

无。只用 Node 原生 `Date` / `Intl` / `http`。需要 Node >= 18（`Intl` 需含完整 IANA 时区数据，
Node 官方构建默认自带）。

## License

MIT
