# LSP 工具重构方案

## 重构目标

把 LSP 工具从“IDE 原子操作”改成“agent 任务工具”。公开工具只保留高层入口，底层 LSP 能力变成内部 service，不再注册给模型。

公开工具建议：

```ts
lsp_inspect
lsp_discover
lsp_usages
lsp_diagnostics
lsp_rename
```

## 1. `lsp_inspect`

用途：理解一个符号/API 怎么用。

输入：

```ts
{
  filePath?: string
  line?: number
  character?: number

  packageName?: string | string[]
  symbolName?: string
  workspaceRoot?: string

  mode?: "surface" | "deep"
  maxDepth?: number
  maxMembers?: number
  maxTypes?: number
  maxBytes?: number
}
```

默认：

```ts
mode: "surface"
maxDepth: 1
maxMembers: 50
maxTypes: 30
maxBytes: 60000
```

行为：

- 支持源码位置和 `packageName + symbolName` 两种入口。
- `surface` 返回：
  - symbol 名称、kind、definition/source
  - hover 文档和签名
  - class/interface/type 的 public members
  - function/method 的参数和返回类型
  - 直接相关类型定义一层展开
- `deep` 返回：
  - surface 全部内容
  - 递归展开相关类型，直到预算耗尽
- 输出必须包含：
  - `Definition`
  - `Documentation`
  - `Usage Surface`
  - `Related Types`
  - `Need More Context`，列出没展开的类型和原因

实现重点：

- LSP 用于定位入口、hover、definition。
- TypeScript AST/checker 用于读取 `.d.ts`、提取成员、参数、返回值、相关类型。
- completion 只作为 fallback，不作为主路径。
- 递归展开时去重，避免循环类型。
- 超预算时输出未展开列表，而不是静默截断。

## 2. `lsp_discover`

用途：模型不知道该 inspect 哪个符号时，用来发现 API。

输入：

```ts
{
  filePath?: string
  packageName?: string | string[]
  workspaceRoot?: string
  query?: string
  kinds?: Array<"class" | "interface" | "type" | "function" | "variable" | "namespace" | "enum">
  limit?: number
  maxPackages?: number
}
```

默认：

```ts
limit: 200
maxPackages: 20
```

行为：

- `filePath`：返回 document symbols。
- `packageName`：返回 package exports。
- `query`：过滤符号名。
- 输出按 kind 分组，并附 definition。
- 对每个重要符号只给简短签名，不展开成员。
- 输出 `Suggested next step`，建议用 `lsp_inspect` 查看具体符号。

替代：

- `lsp_symbols`
- `lsp_package_exports`

## 3. `lsp_usages`

用途：查真实使用方式和改动影响。

输入：

```ts
{
  filePath?: string
  line?: number
  character?: number

  packageName?: string
  symbolName?: string
  workspaceRoot?: string

  includeDeclaration?: boolean
  contextLines?: number
  limit?: number
}
```

默认：

```ts
includeDeclaration: true
contextLines: 3
limit: 100
```

行为：

- 支持源码位置和 package symbol 入口。
- 内部先定位 definition，再查 references。
- 按文件分组输出引用。
- 每个引用附上下文片段。
- 引用太多时输出摘要和截断提示。
- 适合模型学习项目里的真实调用方式。

替代：

- `lsp_find_references`
- 一部分 `lsp_goto_definition`

## 4. `lsp_diagnostics`

用途：修复循环里的错误检查。

保留为公开工具，基本沿用当前实现。

可小幅增强：

```ts
{
  filePath: string
  severity?: "error" | "warning" | "information" | "hint" | "all"
  scope?: "file" | "directory"
  limit?: number
}
```

输出按文件分组，保留原始 message、range、source、code。

## 5. `lsp_rename`

用途：安全重命名。

输入：

```ts
{
  filePath: string
  line: number
  character: number
  newName: string
  dryRun?: boolean
}
```

默认：

```ts
dryRun: false
```

行为：

- 内部先 prepare rename。
- 不再公开 `lsp_prepare_rename`。
- `dryRun: true` 只展示 workspace edit。
- `dryRun: false` 应用 edit。
- 输出影响文件、替换数量、失败原因。

## 内部模块重构

把现在的工具拆成 service 层：

```text
src/lsp/services/hover.ts
src/lsp/services/definition.ts
src/lsp/services/references.ts
src/lsp/services/symbols.ts
src/lsp/services/package-symbol.ts
src/lsp/services/package-exports.ts
src/lsp/services/type-context.ts
src/lsp/services/rename.ts
```

公开工具放：

```text
src/lsp/inspect-tool.ts
src/lsp/discover-tool.ts
src/lsp/usages-tool.ts
src/lsp/diagnostics-tool.ts
src/lsp/rename-tool.ts
```

注册入口只导出：

```ts
export {
  lsp_inspect,
  lsp_discover,
  lsp_usages,
  lsp_diagnostics,
  lsp_rename,
}
```

`src/index.ts` 只注册这些 LSP 工具。

## 类型展开策略

`type-context.ts` 是核心。

职责：

- 从 definition node 获取声明文本。
- 提取 public surface：
  - constructors
  - methods
  - properties
  - call signatures
  - overloads
- 从签名中收集相关类型：
  - 参数类型
  - 返回类型
  - property 类型
  - extends / implements
  - type alias RHS
- 解析相关类型定义。
- 递归展开，受预算控制：
  - `maxDepth`
  - `maxTypes`
  - `maxBytes`
- 跳过或摘要：
  - primitive
  - global lib DOM 巨型类型
  - node_modules 深层内部类型，除非被 public API 直接引用
- 输出未展开原因：
  - `maxDepth`
  - `maxTypes`
  - `maxBytes`
  - `external-lib`
  - `unresolved`
  - `circular`

## 输出格式

`lsp_inspect` 输出建议：

```text
Symbol: Texture2D (Class)
Definition: @pkg/core/index.d.ts:10:13

Documentation:
Main texture type.

Usage Surface:
constructor(options: TextureOptions)

Methods:
- sample(coord: TextureCoord): TextureSample
  Documentation: Samples a texel.
- dispose(): void

Properties:
- width: number
- height: number

Related Types:
interface TextureOptions {
  width: number
  height: number
  format?: TextureFormat
}

type TextureFormat = "rgba8" | "bgra8"

Need More Context:
- TextureSample: skipped due to maxDepth. Increase maxDepth or inspect TextureSample.
```

`lsp_discover` 输出建议：

```text
Package: @pkg/core
Found 24 symbols matching "texture"

Classes:
- Texture2D - @pkg/core/index.d.ts:10:13
- TextureLoader - @pkg/core/index.d.ts:45:13

Functions:
- createTexture(options: TextureOptions): Texture2D - @pkg/core/index.d.ts:80:16

Suggested next step:
Use lsp_inspect with symbolName "createTexture" or "Texture2D".
```

## 迁移步骤

1. 新增 service 层，不改外部行为。
2. 新增 `lsp_inspect`，先覆盖 `hover + definition + package symbol + members`。
3. 增加 `type-context.ts`，实现 direct related types。
4. 新增 `lsp_discover`，复用 symbols/package exports。
5. 新增 `lsp_usages`，复用 references/package symbol。
6. 合并 rename：`prepare + rename + dryRun`。
7. 修改 `src/lsp/tools.ts` 和 `src/index.ts`，只注册 5 个公开工具。
8. 删除或停止导出旧底层工具。
9. 更新 README/QUICKSTART，明确 agent 默认路径。

## 测试计划

- `lsp_inspect`
  - source position: 函数、变量、类实例。
  - package symbol: class/function/interface/type alias。
  - surface 展开直接相关类型。
  - deep 递归展开二层类型。
  - 循环类型不会死循环。
  - 超过 `maxTypes/maxBytes` 输出 `Need More Context`。
- `lsp_discover`
  - file symbols。
  - package exports。
  - query/kind/limit。
- `lsp_usages`
  - source references。
  - package symbol references。
  - context snippets。
  - truncation。
- `lsp_rename`
  - prepare 失败。
  - dryRun。
  - apply workspace edit。
- 回归：
  - `bun test`
  - `bun run build`

## 最终取舍

我会直接移除旧工具注册，不保留 agent 可见入口。底层实现可以短期保留为内部 helper，但不再作为 public tool 设计。这样模型看到的是任务意图，而不是 LSP 原语。

---

# 全量 LSP 工具 JSON 输出重构方案

## Summary

将公开高层 LSP 工具和内部底层 LSP 能力统一改为结构化 JSON 输出。目标不是只把字符串包进 JSON，而是让 LSP 层从源头产出结构化数据，公开工具直接返回 JSON envelope，内部工具/service 返回 typed object，只有 README 或调试场景才做文本格式化。

## Public Result Envelope

所有公开工具统一返回：

```ts
interface LspToolResult<T> {
  ok: boolean
  tool: string
  summary: string
  data: T | null
  hints: string[]
  warnings: string[]
  truncated: boolean
  errors: string[]
}
```

规则：

- `ok: true` 表示工具执行成功，即使结果为空或 prepare rename 判断不可重命名。
- `ok: false` 只表示工具执行失败，例如参数错误、LSP 异常、解析异常。
- `warnings` 放可恢复问题。
- `hints` 放下一步建议。
- `truncated` 统一表示输出受 `limit/maxBytes/maxTypes/maxDepth` 影响。

## Internal Service Contract

新增内部 service 结果类型，所有底层能力不再以格式化字符串作为主产物：

```ts
interface ServiceResult<T> {
  ok: boolean
  data: T | null
  warnings: string[]
  errors: string[]
}
```

service 不负责 agent-facing wording，只返回结构化事实和错误。

## Shared Modules

新增：

```text
src/lsp/tool-result.ts
src/lsp/services/hover.ts
src/lsp/services/definition.ts
src/lsp/services/references.ts
src/lsp/services/symbols.ts
src/lsp/services/package-symbol.ts
src/lsp/services/package-exports.ts
src/lsp/services/diagnostics.ts
src/lsp/services/rename.ts
src/lsp/services/type-context.ts
```

`tool-result.ts` 提供：

- `okResult(tool, summary, data, opts?)`
- `errorResult(tool, message, opts?)`
- `serviceOk(data, warnings?)`
- `serviceError(message, warnings?)`
- shared `LocationRef`, `RangeRef`, `SnippetRef`

## Internal JSON Shapes

### Hover Service

```ts
interface HoverInfo {
  source: LocationRef
  definition?: LocationRef
  range?: RangeRef
  signatures: string[]
  documentation: string[]
  tags: string[]
  members?: {
    methods: MemberInfo[]
    properties: MemberInfo[]
    total: number
    truncated: boolean
    incomplete: boolean
  }
  hints: string[]
}
```

Responsibilities:

- Query LSP hover.
- Query definition when requested.
- Collect members when requested.
- Return structured hover/member fields.
- No markdown formatting.

### Definition Service

```ts
interface DefinitionInfo {
  input: SymbolInput
  definitions: LocationRef[]
}
```

Responsibilities:

- Source position definition.
- Package symbol definition.
- Normalize `Location | LocationLink`.
- No string formatting.

### References Service

```ts
interface ReferencesInfo {
  input: SymbolInput
  references: ReferenceInfo[]
  total: number
  truncated: boolean
}

interface ReferenceInfo {
  location: LocationRef
  snippet?: SnippetRef
}
```

Responsibilities:

- Source references.
- Package symbol references.
- Snippet extraction.
- Limit/truncation metadata.

### Symbols Service

```ts
interface SymbolsInfo {
  input: {
    filePath?: string
    query?: string
    scope: "document" | "workspace"
  }
  symbols: SymbolSummary[]
  total: number
  truncated: boolean
}
```

### Package Exports Service

```ts
interface PackageExportsInfo {
  packages: PackageExportGroup[]
  total: number
  truncated: boolean
}

interface PackageExportGroup {
  packageName: string
  packageRoot?: string
  nodeModulesRoot?: string
  symbols: SymbolSummary[]
}
```

### Package Symbol Service

```ts
interface PackageSymbolInfo {
  matches: PackageSymbolMatch[]
}

interface PackageSymbolMatch {
  packageName: string
  symbol: SymbolSummary
  packageRoot?: string
  nodeModulesRoot?: string
}
```

### Type Context Service

```ts
interface TypeContextInfo {
  relatedTypes: RelatedTypeInfo[]
  unresolvedTypes: UnresolvedTypeInfo[]
  truncated: boolean
}

interface RelatedTypeInfo {
  name: string
  kind?: string
  location: LocationRef
  text: string
  depth: number
}

interface UnresolvedTypeInfo {
  name: string
  reason:
    | "maxDepth"
    | "maxTypes"
    | "maxBytes"
    | "external-lib"
    | "unresolved"
    | "circular"
  location?: LocationRef
}
```

### Diagnostics Service

```ts
interface DiagnosticsInfo {
  target: string
  diagnostics: DiagnosticInfo[]
  total: number
  truncated: boolean
}

interface DiagnosticInfo {
  location: {
    filePath?: string
    range: RangeRef
  }
  severity: "error" | "warning" | "information" | "hint" | "unknown"
  source?: string
  code?: string | number
  message: string
}
```

### Rename Service

```ts
interface RenameInfo {
  filePath: string
  line: number
  character: number
  newName: string
  dryRun: boolean
  prepare: {
    canRename: boolean
    range?: RangeRef
    placeholder?: string
    message: string
  }
  edit?: {
    totalEdits: number
    files: string[]
    preview?: WorkspaceEdit
    applied: boolean
  }
}
```

## Public Tool Mapping

### `lsp_inspect`

Composes:

- definition service
- hover service
- type-context service
- package-symbol service when input is package-based

Returns:

```ts
interface InspectData {
  input: SymbolInput & {
    mode: "surface" | "deep"
  }
  symbols: InspectedSymbol[]
}
```

### `lsp_discover`

Composes:

- symbols service for file/workspace
- package-exports service for package

Returns:

```ts
interface DiscoverData {
  input: DiscoverInput
  packages?: PackageExportGroup[]
  fileSymbols?: SymbolSummary[]
  workspaceSymbols?: SymbolSummary[]
}
```

### `lsp_usages`

Composes:

- references service
- package-symbol service when package-based

Returns:

```ts
interface UsagesData {
  input: SymbolInput
  groups: Array<{
    filePath: string
    usages: ReferenceInfo[]
  }>
  total: number
  shown: number
}
```

### `lsp_diagnostics`

Composes:

- diagnostics service

Returns diagnostics JSON directly in envelope.

### `lsp_rename`

Composes:

- rename service

Returns rename JSON directly in envelope.

## Raw/Internal Tool Policy

旧的 raw tool files should not stay string-first.

Preferred direction:

- Convert old `*-tool.ts` files into thin wrappers around services only if tests still import them.
- Their `.execute()` should also return `LspToolResult<T>` JSON.
- Eventually remove raw tool exports/tests once service tests cover the behavior.

This means even non-registered tools like `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`, `lsp_package_symbol`, `lsp_package_exports`, and `lsp_prepare_rename` should stop returning plain strings.

## Migration Steps

1. Add `tool-result.ts` with shared result/envelope types and helpers.
2. Convert low-risk services first:
   - definition
   - package-symbol
   - package-exports
   - symbols
3. Convert references service with snippet support.
4. Convert diagnostics service and directory aggregation to structured output.
5. Convert rename service with prepare + dryRun.
6. Convert hover/member logic to structured `HoverInfo`.
7. Convert type-context to structured `TypeContextInfo`; keep optional formatter only for debugging.
8. Update high-level public tools to compose services and return `LspToolResult<T>`.
9. Update raw tool wrappers to return JSON envelopes too, or remove tests importing raw wrappers and test services instead.
10. Update README/QUICKSTART examples.
11. Run:
    - `bunx tsc --noEmit`
    - `bun test`
    - `bun run build`

## Test Strategy

- Add `test/lsp-json-contract.test.ts`:
  - every public high-level tool returns object envelope
  - `ok/tool/summary/data/hints/warnings/truncated/errors` exist
- Update raw tool tests:
  - stop substring assertions on strings
  - assert structured fields
- Add service-level tests where useful:
  - package exports service returns grouped symbols
  - type context service returns related/unresolved types
  - references service returns snippets
- Keep a small number of integration tests through public tools to avoid over-testing raw wrappers.

## Assumptions

- JSON output is now the contract for all LSP tool `.execute()` functions, registered or not.
- `summary` remains human-readable, but all machine-consumable content must be in `data`.
- Formatting helpers can remain for docs/debug, but should not be used as primary tool output.

---

# AST-Grep 工具优化方案

## Summary

保留 `ast_grep_search` 和 `ast_grep_replace` 两个工具，但重新定位为“结构化语法搜索/批量改写”工具，而不是代码理解工具。统一输出为 JSON envelope，补充更清晰的 agent 使用边界，并增强结果结构，方便 agent 判断是否继续搜索、改写或切换到 LSP 工具。

## Tool Positioning

公开工具仍保留：

```ts
ast_grep_search
ast_grep_replace
```

不建议合并。两个意图足够清晰：

- `ast_grep_search`: 查找某种 AST 形态。
- `ast_grep_replace`: 批量结构化改写，默认 dry-run。

描述需要明确：

- 查定义、类型、API 用法：优先 `lsp_inspect`。
- 查真实引用/调用影响：优先 `lsp_usages`。
- 探索包/项目符号：优先 `lsp_discover`。
- 查语法形态、代码模式、做 codemod：使用 ast-grep。

## JSON Result Envelope

和 LSP 工具统一：

```ts
interface ToolResult<T> {
  ok: boolean
  tool: string
  summary: string
  data: T | null
  hints: string[]
  warnings: string[]
  truncated: boolean
  errors: string[]
}
```

实际返回仍是 JSON 字符串，保持兼容 `@opencode-ai/plugin` 的 `ToolResult` 类型。

## `ast_grep_search` Data Shape

```ts
interface AstGrepSearchData {
  input: {
    pattern: string
    lang: string
    paths: string[]
    globs?: string[]
    context?: number
  }
  matches: AstGrepMatch[]
  total: number
  shown: number
}

interface AstGrepMatch {
  filePath: string
  language: string
  range: {
    startLine: number
    endLine: number
  }
  text: string
  contextBefore?: string
  contextAfter?: string
}
```

Behavior:

- `ok: true` when ast-grep runs successfully, even if matches are empty.
- No matches:
  - `summary: "No matches found."`
  - pattern-specific hints go into `hints`.
- Too many matches:
  - `truncated: true`
  - `hints` suggests narrowing `paths/globs/pattern` or increasing limit if supported.
- ast-grep CLI failure:
  - `ok: false`
  - `errors` includes stderr / error message.

## `ast_grep_replace` Data Shape

```ts
interface AstGrepReplaceData {
  input: {
    pattern: string
    rewrite: string
    lang: string
    paths: string[]
    globs?: string[]
    dryRun: boolean
  }
  rewriteTemplate: string
  total: number
  shown: number
  applied: boolean
  afterTextReliable: boolean
  matches: AstGrepMatch[]
  truncatedReason?: string
}

interface AstGrepMatch {
  filePath: string
  language: string
  location: {
    line: number
    column: number
  }
  range: {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }
  byteRange: {
    start: number
    end: number
  }
  text: string
  lines: string
  leadingChars: number
  trailingChars: number
}
```

Note: `sg --json=compact` reports the matched snippet. It does not reliably return the fully expanded replacement text after meta-variable substitution on the apply path, so the canonical rewrite template stays in `input.rewrite` / `rewriteTemplate`, `afterTextReliable` is `false`, and `matches` remains a list of located matched snippets.

Behavior:

- `dryRun` defaults to `true`.
- Dry-run:
  - `applied: false`
  - summary says how many replacements would be made.
  - hint says rerun with `dryRun: false` to apply.
- Apply:
  - `applied: true`
  - summary says how many replacements were applied.
- No replacements:
  - `ok: true`
  - `total: 0`
  - hints may include pattern correction suggestions.
- CLI failure:
  - `ok: false`.

## Implementation Changes

- Add shared result helper for AST tools or reuse a generic `tool-result.ts` outside `src/lsp`.
  - Best option: move common envelope helpers to `src/shared/tool-result.ts`.
  - LSP imports should be updated from `src/lsp/tool-result.ts` or re-export through it.
- Refactor `formatSearchResult` and `formatReplaceResult`:
  - Keep optional text formatters only for docs/debug.
  - Add structured builders:
    - `buildSearchResultData(result, input)`
    - `buildReplaceResultData(result, input)`
- Update `createAstGrepTools`:
  - Return JSON envelope strings.
  - Use `hints` for pattern correction messages.
  - Keep `context.metadata({ metadata: { result } })` if useful, but primary output is JSON string.
- Update tool descriptions to clarify LSP-vs-ast-grep selection.

## Tests

- Add/modify AST tests to assert JSON envelope:
  - `ast_grep_search` returns `ok/tool/summary/data/hints/warnings/truncated/errors`.
  - no-match Python class pattern returns hint.
  - search results include structured `matches`.
  - dry-run replace returns `applied: false`.
  - non-dry-run replace returns `applied: true` and updates files.
  - CLI error returns `ok: false`.
- Keep existing formatter tests only if text formatters remain; otherwise replace them with structured builder tests.
- Run:
  - `bunx tsc --noEmit`
  - `bun test`
  - `bun run build`

## Assumptions

- AST tools remain registered publicly.
- AST tools should use the same JSON envelope as LSP tools.
- AST tools are for syntax-pattern workflows; semantic symbol understanding stays with LSP high-level tools.
