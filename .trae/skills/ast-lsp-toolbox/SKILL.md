---
name: "ast-lsp-toolbox"
description: "Codebook of ast_grep_* and lsp_* tools: when to pick which, concrete call examples, parameter recipes, and workflow patterns. Invoke when user asks about tool selection, code navigation, semantic refactor, or package API exploration."
---

# ast-lsp-toolbox

本 skill 汇总了当前项目（`opencode-plugin-ast-lsp`）提供的两套工具家族 —— **结构化代码检索/改写**（`ast_grep_*`）与**语义化代码导航/重构**（`lsp_*`）—— 的详细用法、选型指南、组合工作流。供 Agent 在执行编码任务时精准挑选工具、撰写可运行的调用参数。

> **一句话分工**
> - **ast_grep_\***：按「代码形状 (AST 模式)」跨语言批量查找/重写；不懂类型、不懂 import；默认不进 `node_modules`。
> - **lsp_\***：按「符号语义」在 tsserver 下做 hover / goto / references / rename；懂类型、跟 re-export、懂 alias。
> - **lsp_package_\***：在只知道「包名 + 符号名」时也能查依赖内的 API，无需 workspace 里已有使用点。

---

## 1. 选型总表（从任务意图 → 首选工具）

| 用户意图（自然语言） | 首选工具 | 兜底 / 替代 |
|---|---|---|
| "把项目所有 `console.log($x)` 改成 `logger.info($x)`" | `ast_grep_replace` | 无（LSP 做不到结构化改写） |
| "查找所有 `await fetch($url)` 的位置" | `ast_grep_search` | `grep` 近似 |
| "跳转到 `Texture2D` 的定义" | `lsp_goto_definition`（光标处） 或 `lsp_package_symbol`（只知道包名） | — |
| "`@sar-engine/core` 导出了哪些类？" | `lsp_package_exports({ kinds:["class"] })` | ast_grep 在 `.d.ts` 里扫（不准、漏 re-export） |
| "这个函数哪些地方用到了？" | `lsp_find_references` | `ast_grep_search` 按名字找（会误匹配同名局部变量） |
| "看一下 `UseMemoOptions` 的签名 / JSDoc" | `lsp_hover`（光标处或 `packageName+symbolName`） | — |
| "给我这个文件的类/方法 outline" | `lsp_symbols({ scope:"document" })` | — |
| "项目里有叫 `UserService` 的类吗？" | `lsp_symbols({ scope:"workspace", query:"UserService" })` | — |
| "改文件前检查是否有 TS 报错" | `lsp_diagnostics` | `tsc --noEmit`（更慢） |
| "安全重命名这个方法，涉及所有文件" | `lsp_prepare_rename` → `lsp_rename` | ast_grep_replace（字面替换，有风险） |
| "结构化重写：把 `useState<boolean>(false)` 改成 `useState(false)`" | `ast_grep_replace` | — |
| "看 `@scope/*` 所有包的某个公共 API" | `lsp_package_exports({ packageName:"@scope/*", query:"..." })` | — |

---

## 2. `ast_grep_*` 工具族

### 2.1 `ast_grep_search` — 结构化搜索

**适合**：
- 跨语言查找特定代码形状（25 种语言）
- 搜索带元变量的模式（`$VAR`、`$$$`）
- 快速统计某种 API 用法分布

**不适合**：
- 找"某符号的所有调用"（字面匹配会误伤同名变量、字符串、注释）
- 探索 `node_modules` 里某包的导出（改用 `lsp_package_exports`）
- 类型级查询（模式匹配不理解类型）

**必须遵守**：pattern 必须是合法的 AST 节点 —— 函数要连带参数与函数体。

**示例**：

```json
// 1) 找所有 console.log 调用
{
  "name": "ast_grep_search",
  "args": {
    "pattern": "console.log($MSG)",
    "lang": "ts",
    "paths": ["src"]
  }
}

// 2) 找所有导出的 async 函数（必须完整 body）
{
  "pattern": "export async function $NAME($$$) { $$$ }",
  "lang": "tsx",
  "paths": ["src"]
}

// 3) Python 中找所有类方法 def
{
  "pattern": "def $FUNC($$$):\n    $$$",
  "lang": "python"
}

// 4) 收窄到特定目录、排除测试
{
  "pattern": "fetch($URL)",
  "lang": "ts",
  "paths": ["src"],
  "globs": ["!**/*.test.ts"]
}
```

### 2.2 `ast_grep_replace` — 结构化重写

**适合**：
- 批量重构相同形状的代码
- 迁移 API（如把 `oldFn(a, b)` 改为 `newFn({ a, b })`）
- 无需跨文件符号联动的改写

**不适合**：
- 重命名一个"符号"（用 `lsp_rename` —— 会跟 import/export/别名）
- 需要类型上下文判断的改写

**示例**：

```json
// 1) console.log → logger.info
{
  "name": "ast_grep_replace",
  "args": {
    "pattern": "console.log($MSG)",
    "rewrite": "logger.info($MSG)",
    "lang": "ts",
    "paths": ["src"]
  }
}

// 2) 参数改对象化
{
  "pattern": "request($URL, $OPTS)",
  "rewrite": "request({ url: $URL, options: $OPTS })",
  "lang": "ts"
}

// 3) 先 dryRun 再真的写
{
  "pattern": "useState<boolean>($INIT)",
  "rewrite": "useState($INIT)",
  "lang": "tsx",
  "dryRun": true
}
```

### 2.3 经验

- `pattern` 不合法会直接报错；遇到报错时**先用纯代码粘贴**到 playground 验证形状。
- 元变量命名无约束，但建议 `$NAME`（单 token）、`$$$` 或 `$$$ARGS`（多 token）保持一致风格。
- 跨语言时必须显式传 `lang`，别指望从文件后缀推断。
- `paths` / `globs` 在 monorepo 下非常必要，防止扫到 dist / build。

---

## 3. `lsp_*` 工具族

### 3.1 `lsp_hover` — 看文档与签名

**何时用**：
- 想知道某个符号的签名、返回类型、泛型参数、JSDoc
- 想确认是否 `@deprecated`

**两种入参模式**：

```json
// 模式 A：使用点（光标位置）
{
  "name": "lsp_hover",
  "args": { "filePath": "src/app.ts", "line": 42, "character": 10 }
}

// 模式 B：只知道包名 + 符号名（无需 workspace 里已有使用）
{
  "name": "lsp_hover",
  "args": {
    "packageName": "@sar-engine/core",
    "symbolName": "Texture2D"
  }
}

// 模式 B 配合 glob：一次看 scope 下所有含 Vec3 的包
{
  "args": { "packageName": "@sar-engine/*", "symbolName": "Vec3" }
}
```

**注意**：同时给 `filePath` 和 `packageName` 时，`packageName` 优先；返回里会有 `Note: filePath/line/character ignored ...` 提醒。

---

### 3.2 `lsp_goto_definition` — 跳定义

**何时用**：
- "这东西从哪来？"
- 想打开真正的源代码文件（跟 re-export 到底）

**示例**：

```json
// 从使用点跳
{ "filePath": "src/scene.ts", "line": 12, "character": 8 }

// 只知道包名
{ "packageName": "@sar-engine/core", "symbolName": "Scene" }

// 多包同名符号，正则
{ "packageName": "/^@sar-engine\\//", "symbolName": "Entity" }
```

**经验**：
- 对 `.d.ts` 中的 `export { X } from "./impl"`，tsserver 如果不能 definition，本工具会**回退**显示 `.d.ts` 中的声明位置并标 `(declaration)`。

---

### 3.3 `lsp_find_references` — 找所有使用

**何时用**：
- 影响面分析：某个导出要改/废弃
- "这个方法有谁调用？"

**vs `ast_grep_search`**：
- references 是**语义级**：跟 import、alias、命名导出/默认导出都对得上；不会误匹配同名的局部变量、字符串、注释。
- ast_grep 是**结构级**：更适合"找 `foo($$$)` 这种调用形状"，不保证符号同一。

**示例**：

```json
// 使用点模式
{
  "filePath": "src/scene.ts",
  "line": 12, "character": 8,
  "includeDeclaration": true
}

// 包名模式（会分组输出每个命中包的引用）
{
  "packageName": "@sar-engine/core",
  "symbolName": "Scene"
}
```

**输出**：超过默认上限会截断并提示 `Found N references (showing first M):`。

---

### 3.4 `lsp_symbols` — 大纲/工作区符号

**两种 scope**：

```json
// A) 文件 outline
{ "scope": "document", "filePath": "src/scene.ts" }

// B) 工作区按名字模糊搜（依赖 tsserver 已打开并索引）
{ "scope": "workspace", "query": "UserService" }
```

**经验**：
- workspace 搜的是**已打开文件**的 symbol，若项目刚启动可能漏；先对关键目录跑一次 `lsp_diagnostics` 触发索引。
- 想看"一个包导出了什么"**不要用 workspace symbols**，用 `lsp_package_exports`。

---

### 3.5 `lsp_diagnostics` — 拉诊断

**两种输入**：

```json
// 单文件
{ "filePath": "src/app.ts" }

// 目录批量
{ "filePath": "src/features/user" }
```

**何时用**：
- 改完代码没跑 build 前的快速校验
- 给 AI 反馈"这次修改有没有引入类型错误"

**不适合**：
- 对 `node_modules/<pkg>` 跑（.d.ts 基本无诊断且会拖慢 LSP）

---

### 3.6 `lsp_prepare_rename` / `lsp_rename` — 安全重命名

**标准流程**：

```json
// Step 1：验证光标是否落在可重命名的标识符上
{
  "name": "lsp_prepare_rename",
  "args": { "filePath": "src/scene.ts", "line": 10, "character": 14 }
}

// Step 2：真的执行
{
  "name": "lsp_rename",
  "args": {
    "filePath": "src/scene.ts",
    "line": 10, "character": 14,
    "newName": "SceneGraph"
  }
}
```

**硬规则**：
- ❌ 不要对 `node_modules` 内的符号 rename —— 会污染依赖、npm install 后消失、可能漏改（tsserver 默认不索引所有 .d.ts）。
- ❌ 不要用 `ast_grep_replace` 代替 rename —— 会误改字符串、注释、同名变量。

---

### 3.7 `lsp_package_symbol` — 包名定位符号

**何时用**：
- 文档 / Issue / 他人代码里出现了 `@sar-engine/core` 的 `Texture2D`，但你的项目里一次都没用过
- 想快速拿到 `.d.ts` 的精确位置（path:line:col）

**示例**：

```json
// 精确包名
{ "packageName": "@sar-engine/core", "symbolName": "Texture2D" }

// 多包命中，自动合并
{ "packageName": ["@sar-engine/core", "@sar-engine/physics"], "symbolName": "Collider" }

// scope 下所有包
{ "packageName": "@sar-engine/*", "symbolName": "Vec3" }

// 正则
{ "packageName": "/^@sar-engine\\//", "symbolName": "Entity", "maxPackages": 50 }
```

**内部策略**（三级 try-fail-fallback）：
1. `lsp-completion`：真的走 tsserver 补全表 —— 最准
2. `probe`：在临时 `.ts` 文件里虚构 `import { X } from "pkg"` 调 definition
3. `dts-scan`：直接用 TS Compiler API 扫 `.d.ts` 找声明

前面失败就自动回退到下一级。用户无感。

---

### 3.8 `lsp_package_exports` — 列包导出

**何时用**：
- 想通览 `@sar-engine/core` 的 API 表面
- 想知道"scope 下所有包公共导出里叫 `Render*` 的都有啥"

**示例**：

```json
// 1) 列全部导出
{ "packageName": "@sar-engine/core" }

// 2) 按类型过滤 + 前缀搜索
{
  "packageName": "@sar-engine/core",
  "kinds": ["class", "interface"],
  "query": "Render"
}

// 3) 多包 + 分组
{
  "packageName": "@sar-engine/*",
  "groupByPackage": true,
  "limit": 200
}
```

**字段含义**：
- `kinds`: 可选 `"class" | "interface" | "type" | "enum" | "function" | "variable" | "namespace"`
- `query`: 子串匹配 export 名
- `groupByPackage`: 按包分节输出

**vs 在 node_modules 跑 ast_grep_search**：
- 本工具**跟 re-export 链**、包含 `export type`、命名空间合并，ast_grep 都做不到。

---

## 4. 组合工作流（高频场景剧本）

### 4.1 "我想升级 `@sar-engine/core` 的某个类"

```
1. lsp_package_exports({ packageName:"@sar-engine/core", query:"Texture" })
   → 确认当前包导出哪些 Texture*
2. lsp_hover({ packageName:"@sar-engine/core", symbolName:"Texture2D" })
   → 看签名，确认接口变更面
3. lsp_find_references({ packageName:"@sar-engine/core", symbolName:"Texture2D" })
   → 盘点工作区使用点
4. 按影响面决定是用 lsp_rename / 手动编辑 / ast_grep_replace
```

### 4.2 "给第三方文档里的 API 跳到源"

```
1. lsp_package_symbol({ packageName:"@vendor/sdk", symbolName:"TrackingEvent" })
   → 拿到 .d.ts 位置
2. lsp_hover(...) / lsp_goto_definition(...) 同位置跟到实现
```

### 4.3 "重构：把一个导出方法改名并同步所有使用"

```
1. lsp_prepare_rename({ filePath, line, character })   // 确认可改
2. lsp_rename({ filePath, line, character, newName })  // 执行
3. lsp_diagnostics({ filePath: "src" })                // 验证没有坏边
```

### 4.4 "批量迁移一个已废弃 API 的调用形态"

```
1. ast_grep_search({ pattern:"oldApi($A,$B)", dryRun:true })  // 先看影响
2. ast_grep_replace({ pattern:"oldApi($A,$B)", rewrite:"newApi({a:$A,b:$B})", dryRun:true })
3. 审核差异，再去掉 dryRun 真跑
4. lsp_diagnostics 验证
```

### 4.5 "排查：这个 symbol 到底来自哪个包？"

```
1. lsp_goto_definition（光标模式）→ 若跳到 .d.ts，看路径即可
2. 或 lsp_package_exports({ packageName:"@scope/*", query:"<symbolName>" })
   → 倒推是哪个包导出的
```

---

## 5. 选型误区与纠偏

| 误区 | 应改为 |
|---|---|
| 用 `ast_grep_search` 找 symbol 所有调用 | `lsp_find_references`（语义准确） |
| 用 `ast_grep_replace` 做符号重命名 | `lsp_rename`（跟 import/export） |
| 用 `lsp_symbols` 列包导出 | `lsp_package_exports`（符号级，跟 re-export） |
| 用 `lsp_diagnostics` 扫 node_modules | `lsp_package_exports` / `lsp_package_symbol` 探索 API |
| 用 `lsp_rename` 改 node_modules 里的符号 | 绝对禁止（污染依赖） |
| 用 `lsp_goto_definition` 列一个包的所有导出 | `lsp_package_exports` |
| 没有 workspace 使用点却想 `goto_definition` | 用 `lsp_package_symbol` / `lsp_goto_definition` 的 packageName 模式 |

---

## 6. 公共参数速查

**`packageName` 支持格式**（`lsp_hover` / `lsp_goto_definition` / `lsp_find_references` / `lsp_package_symbol` / `lsp_package_exports` 共享）：

| 形式 | 语义 | 示例 |
|---|---|---|
| 精确 | 单包 | `"@sar-engine/core"` |
| 数组 | 多包并集 | `["@sar-engine/core","@sar-engine/physics"]` |
| glob | scope 下模糊 | `"@sar-engine/*"`（`*` 不跨 `/`） |
| 正则 | 最灵活 | `"/^@sar-engine\\/(core|physics)$/"` |

**其他共用参数**：
- `workspaceRoot`: 省略则取 `process.cwd()`
- `maxPackages`: 默认 20，安全阀，防止 glob/regex 命中爆表
- 同时给 `packageName` 和 `filePath+line+character`：`packageName` 优先；回显里会加 `Note: filePath/line/character ignored because packageName was provided.`
- 仅给 `packageName` 不给 `symbolName` → 直接报错 `symbolName is required when packageName is provided`

---

## 7. 调试技巧

- **LSP 冷启动慢**：第一个 lsp_* 调用可能 1–5 秒；后续共享进程变快。
- **pattern 不匹配**：把 `pattern` 替换成真实代码片段先试；元变量从简单开始加。
- **packageName 无命中**：
  - 确认 workspace 下 `node_modules/<pkg>` 实际存在
  - 确认 `package.json` 有 `types` / `typings` / `exports.types` 字段
  - 开 glob/regex 后注意 `maxPackages` 是否限制了范围
- **rename 结果少改**：多为某些文件 tsserver 尚未索引；先 `lsp_diagnostics` 扫一下触发索引再 rename。
- **ast_grep 结果很多**：先加 `paths` + `globs` 再 `head`/分页；`dryRun` 一定先用。

---

## 8. 语言支持

- `lsp_*` 目前链路绑定 `typescript-language-server`，主要覆盖 TS/JS/TSX/JSX（`.d.ts` 同样支持）。
- `ast_grep_*` 支持 25 种语言（ts/tsx/js/jsx/py/go/rs/java/kotlin/cpp/c/cs/rb/php/... 等），通过 `lang` 参数指定。

