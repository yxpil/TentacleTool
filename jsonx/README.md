# Jsonx — 数据格式处理 MCP 工具集

> 零依赖的 MCP 服务器（Streamable HTTP, 2025-03-26）。把 JSON / YAML / CSV / TSV
> 一次性吃下：互转、查询、结构推断、结构化 diff、统计聚合。

## 为什么需要它

Agent 处理结构化数据时的翻车姿势高度雷同：

- 拿 `split(',')` 解析 CSV，遇到 `"Wang, Jr"` 直接把一个人切成两列
- 把 `0912` 这样的客户编号转成数字 `912`，把雪花 ID 精度截断
- 用文本 diff 比对 JSON，键顺序一变就报满屏差异，真正改动埋在噪声里
- 手写 YAML 解析，遇到锚点/标签就静默忽略，产出"结构对、值全错"的结果
- 想按条件筛选 JSON，写了 `$[?(@.age>18)]`，得到空数组却分不清是"没匹配"还是"不支持"

Jsonx 的立场很明确：**宁可明确报错，也不静默给出错误结果**。
凡是不支持的能力都直接拒绝并给出替代方案，凡是可能丢信息的操作都做往返校验。

## 快速开始

```bash
cd jsonx
npm start          # 或双击 start.bat
```

服务默认监听 `127.0.0.1:8349`（用 `JSONX_PORT` 环境变量可改）。

接入 MCP 客户端（加一个 custom connector，指向 `http://127.0.0.1:8349`）：

```json
{
  "mcpServers": {
    "jsonx": { "url": "http://127.0.0.1:8349" }
  }
}
```

## 工具一览

| 工具 | 用途 | 关键点 |
|------|------|--------|
| `jsonx_parse` | 解析文本为数据 | 自动识别 JSON/YAML/CSV/TSV；给出形状、列类型、列名与预览 |
| `jsonx_convert` | 格式互转 | → json / yaml / csv / tsv / markdown；**转完自动做往返校验**，报告是否丢信息 |
| `jsonx_query` | JSONPath 取值 | `$` `.key` `[n]` `[*]` `..key` 切片 多选；支持一次多个路径，省往返 |
| `jsonx_schema` | 结构推断 | 字段/类型/可空性/枚举候选/嵌套；**拿陌生数据先调它** |
| `jsonx_diff` | 结构化 diff | 键顺序与缩进不计；数组三种模式 index / byKey / ignoreOrder |
| `jsonx_aggregate` | 统计聚合 | 计数/求和/平均/最值/中位数/标准差/唯一值；支持分组与筛选 |

## 使用示例

### 摸清一份陌生数据

```json
{ "name": "jsonx_schema", "arguments": { "text": "id,name,amount\n1,Alice,100\n2,Bob,200" } }
```

```
▸ CSV 结构推断（自动识别：候选分隔符中 "," 的列数一致性最高（3/3 行））

■ 总体
  形状: 2 行 × 2 列
  列: id, name, amount
  分隔符: comma

■ 列定义
| 列     | 类型   | 可空 | 空值 | 样例       |
|--------|--------|------|------|------------|
| id     | number | 否   | 0    | 1, 2       |
| name   | string | 否   | 0    | Alice, Bob |
| amount | number | 否   | 0    | 100, 200   |
```

### 格式互转（带往返校验）

```json
{ "name": "jsonx_convert", "arguments": { "text": "id,name\n1,Alice\n2,Bob", "to": "yaml" } }
```

```
▸ CSV → YAML（源格式自动识别：候选分隔符中 "," 的列数一致性最高（3/3 行））
  源列：id, name
  ✓ 往返校验通过（转换无信息丢失）

```yaml
- id: 1
  name: Alice
- id: 2
  name: Bob
```
```

`to` 为 `yaml` / `json` 时会自动把输出**重新解析一遍**并与原值做结构化 diff，
直接告诉你有没有丢信息 —— 不用自己怀疑"转完还是原来的数据吗"。

### JSONPath 取值

```json
{
  "name": "jsonx_query",
  "arguments": {
    "text": "{\"users\":[{\"id\":1,\"name\":\"Alice\"},{\"id\":2,\"name\":\"Bob\"}],\"total\":2}",
    "paths": ["$.users[*].name", "$.total"],
    "withPath": true
  }
}
```

```
✓ $.users[*].name  →  2 条匹配
    $.users[0].name  =  Alice
    $.users[1].name  =  Bob

✓ $.total  →  1 条匹配
    $.total  =  2
```

路径没有匹配时会扫描全文档键名，给出「你是不是想找 `users`」这类提示，
而不是干巴巴回一个空数组。

### 结构化 diff

```json
{
  "name": "jsonx_diff",
  "arguments": {
    "left":  "{\"user\":{\"name\":\"Alice\",\"age\":30}}",
    "right": "{\"user\":{\"name\":\"Alice\",\"age\":31},\"ok\":true}"
  }
}
```

```
▸ 结构化比较：JSON vs JSON（数组模式 index）

✗ 发现 2 处改动
  新增: 1
  删除: 0
  修改: 1
  其中类型变化: 0
  未变: 1

■ 改动明细（显示前 2 条）
| 类型 | 路径       | 左 | 右   | 说明 |
|------|------------|----|------|------|
| 新增 | $.ok       |    | true |      |
| 修改 | $.user.age | 30 | 31   |      |
```

长列表增删用 `arrayMode: "byKey"` + `arrayKey: "id"`，
数组当集合用 `arrayMode: "ignoreOrder"`（或 `ignoreOrder: true`）。
`ignoreKeys` 排除时间戳等噪声，`numericTolerance` 吸收浮点误差。

生效的选项会在输出里**显式回显** —— diff 的"选项静默无效"最危险，
因为不报错、只多出几条假差异，很容易被当成真实改动。

### 统计聚合

```json
{
  "name": "jsonx_aggregate",
  "arguments": {
    "text": "cat,amount\nEng,120\nSales,90\nEng,100\nSales,95",
    "groupBy": "cat"
  }
}
```

```
■ 分组统计（按 cat，共 2 组）
| cat   | 组内记录数 | amount.sum | amount.avg | amount.min | amount.max | amount.distinct |
|-------|------------|------------|------------|------------|------------|-----------------|
| Eng   | 2          | 220        | 110        | 100        | 120        | 2               |
| Sales | 2          | 185        | 92.5       | 90         | 95         | 2               |
```

非数值字段的 `sum`/`avg` 显示 `—` 并在备注里说明"不适用"，
**不会返回 0** —— 返回 0 会让人以为"这个字段加起来是 0"。

## 典型工作流

```
jsonx_schema      摸清有哪些字段、什么类型
    ↓
jsonx_query       取出你要的那一层
    ↓
jsonx_convert     换成目标格式（自动往返校验）
    ↓
jsonx_aggregate   统计/分组
    ↓
jsonx_diff        比对新旧两版数据
```

## 设计要点

### CSV 用状态机解析，不是 `split`

逐字符状态机，正确处理：

- 引号内的分隔符（`"Wang, Jr"` 是一个字段）
- 字段内的换行（不拆行，原样保留）
- 转义引号 `""` → `"`
- CRLF / LF / CR 混用
- 末尾空字段（`a,b,` 是三个字段，第三个为空）
- 行首注释、引号未闭合（明确报错并给出行号）

### 类型推断保守优先

**只推断 `number` / `boolean` / `null`**，其余一律留字符串。具体地：

| 输入 | 结果 | 原因 |
|------|------|------|
| `age` 列全是 `30`/`25` | `number` | 安全 |
| `phone` 列 `0912`/`0077` | **`string`** | 前导零是有效信息，转数字会丢 |
| `id` 列 `1234567890123456789` | **`string`** | 超出安全整数，转数字精度截断 |
| 一列里混了 `1` 和 `abc` | **`string`** | 整列退回（标记 `mixed-types`） |
| `2026-09-18` | `string` | **默认不推断日期**（`inferDates: true` 才开）|

默认不推断日期是因为歧义太大：`01/02/2026` 在美国是 1 月 2 日、在欧洲是 2 月 1 日，
猜错比不猜更糟。

### YAML 子集：要么支持，要么明确拒绝

支持映射、序列、标量、块标量（`|` `>` 及 `-` `+` 指示符）、流式 `{}` `[]`、
多文档、注释、引号转义。

**明确不支持**（遇到即抛错并说明）：

| 特性 | 为什么拒绝 |
|------|------------|
| 锚点 `&` / 别名 `*` | 需要共享引用语义，零依赖实现展开容易出错 |
| 标签 `!!` | 需要类型系统，超出范围 |
| 指令 `%YAML` | 版本协商不在范围内 |
| 复杂键 `? ... : ...` | 罕见，且会引入歧义 |

静默忽略这些会产出「结构正确但值错误」的结果 —— 这是最坏的一类失败，
因为调用方看不出任何异常。

序列化时会做往返一致性处理：`"123"` `"true"` `"null"` `""` 这些
**会被解析成非字符串的值一律加引号**。另外 `yes`/`no`/`on`/`off` 按 YAML 1.2
解析为字符串，但序列化时仍然加引号 —— 兼容那些还在用 YAML 1.1 的解析器。

### JSONPath 支持子集，不支持会报错

| 语法 | 支持 |
|------|------|
| `$` 根 | ✓ |
| `.key` / `['key']` / `["key"]` | ✓ |
| `[n]`（含负数 `[-1]`） | ✓ |
| `[*]` 通配 | ✓ |
| `..key` 递归下降 | ✓ |
| `[start:end:step]` 切片（含负步长） | ✓ |
| `[a,b]` 多选 | ✓ |
| `.length` / `.keys` / `.values` | ✓ |
| `[?(...)]` 过滤器 | **✗ 明确报错** |
| `[(...)]` 脚本表达式 | **✗ 明确报错** |

过滤器/脚本会执行任意逻辑，安全边界和实现成本都不可控。写了过滤器会收到
「不支持过滤器表达式」+「请改用 `jsonx_query` 取出数组后用 `jsonx_aggregate`」，
而不是一个看起来像"没有匹配"的空数组。

`renderPath` 与 JSONPath 解析器**严格互逆**：diff 报出的路径可以直接喂回 query，
包括键名里有引号、反斜杠、控制字符、中文、空串等边界情况。

### 数组 diff 的三种模式

| 模式 | 适用场景 | 行为 |
|------|----------|------|
| `index`（默认） | 定长、位置有意义的数组 | 按下标逐个比，长度变化单独报 |
| `byKey` | 长列表有稳定主键 | 按 `arrayKey`（默认 `id`）匹配，插入元素不会全盘报差异 |
| `ignoreOrder` | 数组当集合 | 无视顺序做多重集比较 |

`byKey` 路径形如 `$[id=7].name`；缺主键的元素退回索引匹配并标注 `[#i]`。

## 测试

```bash
cd jsonx
npm test           # 单元测试（333 项）
npm run test:e2e   # 端到端（159 项，真起服务器走 JSON-RPC）
npm run test:all   # 全部
```

覆盖 CSV 状态机全部边界、YAML 子集与不支持语法的报错、JSONPath 全部语法与
`renderPath` 往返互逆、类型推断保守性、diff 三种数组模式、6 个工具的正常与错误路径。

## 目录结构

```
jsonx/
├── src/
│   ├── index.js              入口（端口 8349）
│   ├── mcp/server.js         MCP Streamable HTTP 服务器（零依赖）
│   ├── tools/
│   │   ├── registry.js       工具注册与派发
│   │   ├── format.js         输出格式化（表格/截断/CJK 宽度）
│   │   ├── jsonx-parse.js
│   │   ├── jsonx-convert.js
│   │   ├── jsonx-query.js
│   │   ├── jsonx-schema.js
│   │   ├── jsonx-diff.js
│   │   └── jsonx-aggregate.js
│   └── utils/
│       ├── logger.js         文件日志（logs/jsonx.log）
│       ├── csv.js            CSV 状态机（解析/序列化/分隔符嗅探）
│       ├── yaml.js           YAML 子集解析器 + 序列化器
│       ├── jsonpath.js       JSONPath 引擎（词法/求值/切片）
│       ├── infer.js          类型推断（单值/整列/表格/JSON schema）
│       └── diff.js           结构化 diff 引擎
├── test/
│   ├── smoke.test.js         单元测试
│   └── mcp.e2e.js            端到端测试
├── start.bat
└── package.json
```

## 依赖

无。只用 Node 原生 `http` / `util` / `path` / `fs`。需要 Node >= 18。

## License

MIT
