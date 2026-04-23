# LSP 工具扩展方案：按「包名 + 类型名」查询类型定义 / 列出包导出 Symbol

## Summary

当前 LSP 工具（hover / goto_definition / symbols 等）都是**位置驱动**的 — 必须已有一个源码位置（`filePath + line + character`）才能工作。当用户只知道 `packageName`（或 `packageName + symbolName`），且当前项目里并没有使用该类型时，现有工具链无法直接回答"这个类型定义在哪 / 这个包一共导出了哪些类型"。

本方案基于现有 `typescript-language-server` 架构，**新增两个工具**：

1. **`lsp_package_symbol`** — 按 `包名 + 类型名` 精确定位声明位置 + hover 文档。
2. **`lsp_package_exports`** — 按 `包名` 列出该包**公开导出**的所有 symbol（类 / 接口 / 类型别名 / 枚举 / 函数 / 变量 / 命名空间），用于"包内类型总览 / 探索"。

两个工具共享同一套底层策略 — **try-fail-fallback 三级降级**：

1. **首选**：借用 tsserver 的自动导入索引（`textDocument/completion` 自动 import 候选）或 `workspace/symbol`，无需真实写文件。
2. **降级**：动态生成一个"探针文件"（probe file）临时注入 `import * as NS from "package"`，再复用现有 `hover / definition` 或在 `NS.` 后调 `completion`。
3. **兜底**：不依赖 LSP，直接解析 package 的 `.d.ts` 入口，用 TypeScript Compiler API 做 symbol 枚举或搜索。

> 符合项目硬约束：不新增 `dependencies`；沿用 tsserver；保留 try-fail-fallback 风格。

---

## Current State Analysis

### 现有架构关键点

- 入口工具注册：[index.ts:16-31](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/index.ts#L16-L31)
- LSP 工具聚合出口：[src/lsp/tools.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/tools.ts) & [src/lsp/index.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/index.ts)
- Client 封装（唯一与 LSP 直接通信的层）：[LSPClient](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/lsp-client.ts#L9-L137)，目前暴露 `definition / references / documentSymbols / workspaceSymbols / diagnostics / hover / rename` 等方法，**未暴露** `completion / completionItem/resolve`。
- 连接工厂：[withLspClient()](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/lsp-client-wrapper.ts#L70-L107) — 所有工具都通过 `filePath` 找 workspace root、启动/复用 tsserver。
- 工作区根目录探测：[findWorkspaceRoot](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/lsp-client-wrapper.ts#L25-L46)，以 `package.json / .git / tsconfig` 等为 marker。
- 工具参数统一结构：所有现有 LSP 工具都强制要求 `filePath`，[例如 lsp_hover](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/hover-tool.ts#L9-L14)。这是本方案需要突破的关键约束。
- TS server 配置：`BUILTIN_SERVERS.typescript` 在 [server-definitions.ts:9](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/server-definitions.ts#L9)。
- `initialize` 的客户端 capabilities 中**未声明** `completion`：[lsp-client-connection.ts:13-25](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/lsp-client-connection.ts#L13-L25)。要使用 `textDocument/completion` 需补声明。

### 关键限制

1. `workspace/symbol` 在 tsserver 默认**不索引 `node_modules`**，所以直接用它查 `Texture2D` 通常会空或漏。
2. `textDocument/completion` 在 "自动导入" 模式下能命中 `node_modules`，但需要一个**实际的源码上下文**（有 `import ` 前缀的行）。
3. tsserver 需要项目里存在 `tsconfig.json`，否则 inferred project 对 `node_modules` 的类型索引能力会更弱。

---

## Proposed Changes

### 1. 新增工具：`lsp_package_symbol`

**文件**：`src/lsp/package-symbol-tool.ts`（新建）

**工具签名**：

```ts
lsp_package_symbol({
  packageName: string | string[], // 单包 | 多包 | glob；见下方「包名匹配规则」
  symbolName: string,             // "Texture2D"
  workspaceRoot?: string,
  includeHover?: boolean,         // 默认 true
  strategy?: "auto" | "lsp-completion" | "probe" | "dts-scan",
  maxPackages?: number,           // glob/正则展开后允许的最大包数，默认 20
})
```

**返回**（与现有 formatter 对齐）：

```
@sar-engine/core :: Texture2D
Definition: <abs path>:<line>:<char>
Kind: Class
---
<hover markdown>
```

多个候选时按 `<package> > main > types > re-export` 排序输出。

### 2. 新增工具：`lsp_package_exports`

**文件**：`src/lsp/package-exports-tool.ts`（新建）

**工具签名**：

```ts
lsp_package_exports({
  packageName: string | string[], // 单包 | 多包 | glob；见下方「包名匹配规则」
  workspaceRoot?: string,
  kinds?: Array<"class" | "interface" | "type" | "enum" | "function" | "variable" | "namespace">,
  query?: string,                 // 可选：名称子串筛选（不区分大小写）
  limit?: number,                 // 默认 200；超过则截断
  includeReExports?: boolean,     // 默认 true
  strategy?: "auto" | "lsp-completion" | "probe" | "dts-scan",
  maxPackages?: number,           // glob/正则展开后允许的最大包数，默认 20
  groupByPackage?: boolean,       // 默认 true；多包匹配时按包分组输出
})
```

**返回**（列表式，与 `formatSymbolInfo` / `formatDocumentSymbol` 风格对齐）：

```
@sar-engine/core exports (N symbols, showing M):
Texture2D (Class)      - <abs path>:<line>:<char>
Texture3D (Class)      - <abs path>:<line>:<char>
TextureFormat (Enum)   - <abs path>:<line>:<char>
WrapMode (TypeAlias)   - <abs path>:<line>:<char>
createTexture (Function) - <abs path>:<line>:<char>
...
```

- 无结果时返回 `No exports found for "<packageName>"`。
- 被 `limit` 截断时在第一行提示 `Found N exports (showing first M)`。
- 多包匹配时（见下节）按 `groupByPackage` 分组输出：

  ```
  Matched 3 packages (showing 2):
  === @sar-engine/core (42 symbols) ===
  Texture2D (Class) - /.../texture-2d.d.ts:12:0
  ...
  === @sar-engine/physics (17 symbols) ===
  RigidBody (Class) - /.../rigid-body.d.ts:9:0
  ...
  ```

### 3. 包名匹配规则（两个工具共用）

`packageName` 支持以下四种形态：

| 输入形态 | 示例 | 含义 |
|---|---|---|
| 精确包名 | `"@sar-engine/core"` / `"typescript"` | 单包 |
| 字符串数组 | `["@sar-engine/core", "typescript"]` | 多包并集 |
| glob 模式 | `"@sar-engine/*"` / `"@sar-*/core"` / `"react-*"` | 通配匹配 |
| 正则（`/pattern/flags` 字面量） | `"/^@sar-engine\\//"` | 正则匹配（必须用 `/.../` 包裹） |

**判定顺序**（在 `package-resolution.ts` 的 `expandPackageNames()` helper 里实现）：

1. 如果传入是数组 → 逐元素递归展开后去重合并。
2. 如果字符串首尾是 `/…/…` → 解析为 `RegExp`。
3. 否则如果含 `*` / `?` → 视为 glob（简单转 RegExp：`*` → `[^/]*`，`?` → `.`，其它字面量转义；scope `@foo/*` 允许匹配到 `@foo/bar` 但不会跨 scope）。
4. 否则 → 精确匹配。

**枚举候选包的来源**（命中 glob / 正则时执行）：

1. 以 `workspaceRoot`（或 `process.cwd()`）为起点，遍历 `node_modules/`：
   - 非 scope 目录：直接视为候选 `name = dir`。
   - scope 目录（`@foo/`）：递归一层，`name = @foo/bar`。
2. 对每个候选读取 `package.json` 的 `name` 字段做权威名（避免目录别名漂移）。
3. 用步骤 1~4 的匹配器过滤。
4. 沿着目录树往上递归：如果当前目录找不到 `node_modules`，回到父目录继续；到 workspace root 或文件系统根停止（复用 `findWorkspaceRoot` 风格的上溯逻辑）。
5. 去重（同名包只取第一个命中的版本，Node 解析语义）。

**安全阀**：

- `maxPackages`（默认 20）限制展开后的包数；超出时返回 `Error: Too many packages matched (N > maxPackages). Narrow the pattern.`。
- 对 `lsp_package_symbol`，多包模式下对每个包独立尝试并**并发执行**（`Promise.all`，限 5 并发），只把**命中 `symbolName` 的包**收入结果；空匹配的包静默忽略。
- 返回里若多个包都命中同名 symbol，按包名字母序输出全部，不去重。

### 4. 三级策略

> 两个工具共享下列策略栈；单包时直接走；多包时外层用 `expandPackageNames()` 展开后对每个包分别走一遍，最后合并结果。

#### Strategy A — `lsp-completion`（首选，无磁盘写入）

**通用前置**：

1. 解析 package root：`require.resolve.paths` + 遍历向上找 `node_modules/<packageName>/package.json`（受 workspaceRoot 限定）。读取 `types / typings / exports.types`，确认有 `.d.ts`。
2. 若项目内存在任一 `.ts` 文件，取其作为 **anchor**（优先取 `src/**/*.ts` 第一个）给 `withLspClient` 使用。没有则进入 Strategy B。

**针对 `lsp_package_symbol`**：

3. 通过 `LSPClient.openFile(anchor)` 让 tsserver 打开 anchor，然后发送 **didChange** 临时把末尾追加一行：
   - `import { Texture2D } from "@sar-engine/core";`
4. 在该行 **`{ ` 之后的位置**调用 `textDocument/completion`；筛选 `label === symbolName` 且 `data.source === packageName` 的候选。
5. 对命中的 item 调用 `completionItem/resolve` 获取详细 `detail / documentation`。
6. 再基于 import 语句里 `Texture2D` 的位置，调 `textDocument/definition` 得到跳转坐标；调 `textDocument/hover` 得到 markdown。
7. 结束后通过一次 **didChange 回滚** 把虚拟的 import 行删除（不 save 也不写盘）。

**针对 `lsp_package_exports`**：

3. didChange 追加：
   ```ts
   import * as __pkg from "@sar-engine/core";
   __pkg.
   ```
4. 在 `__pkg.` 之后的位置调 `textDocument/completion`（`triggerKind = 2, triggerCharacter = "."`），tsserver 会返回**命名空间的所有公开导出**（值 + 类型）。对每条：
   - `label` → name
   - `kind` → 映射为 `SymbolKind`（`Class/Interface/Enum/Variable/Function/...`）
   - 需要定位时：对该行 `__pkg.<name>` 的位置发 `textDocument/definition`，得到 `.d.ts` 源位置。
5. 可选 `includeReExports=true` 时直接信任 tsserver 的输出（已含 re-export）；若 `false` 则通过 C 策略的 AST 辅助过滤掉 re-export。
6. didChange 回滚。

> 说明：didChange 只在内存里变更，不触发磁盘写入；tsserver 基于该 in-memory snapshot 解析 import。

#### Strategy B — `probe`（降级）

当前项目没有 anchor `.ts` 文件（纯 JS 项目 / 无 tsconfig / 或 Strategy A 解析失败）时：

1. 在 workspace root 下创建临时目录 `<root>/.trae-probe/`。
2. 写入 `probe.ts`：
   - 针对 `lsp_package_symbol`：
     ```ts
     import { Texture2D } from "@sar-engine/core";
     type __probe = typeof Texture2D;
     ```
   - 针对 `lsp_package_exports`：
     ```ts
     import * as __pkg from "@sar-engine/core";
     __pkg.
     ```
3. 复用现有 client 调用（`withLspClient(probe.ts, …)`)：
   - `lsp_package_symbol`：取第 1 行 `Texture2D` 的坐标做 hover / definition。
   - `lsp_package_exports`：在 `__pkg.` 末尾位置调 completion，按 Strategy A 的方式解析。
4. 结束后删除 `.trae-probe/` 目录（`try { rmSync } finally {}`，忽略失败）。

> 注意：为了避免污染真实 tsconfig include，probe 文件放在**不被 tsconfig 扫描**的目录更安全，也因此只适合作降级。

#### Strategy C — `dts-scan`（兜底，不依赖 LSP）

当 tsserver 不可用、或 A/B 都返回空：

1. 解析 package root，收集候选 `.d.ts` 入口（`types` / `typings` / `exports.*.types` / `index.d.ts`）。
2. 用 **TypeScript Compiler API** 处理入口文件：
   - `ts.createSourceFile(fileName, text, Latest, true)`。
   - 对每个顶层 statement：
     - 若是 `ClassDeclaration | InterfaceDeclaration | TypeAliasDeclaration | EnumDeclaration | FunctionDeclaration | VariableStatement | ModuleDeclaration` 且带 `export` 修饰符 → 收集。
     - 若是 `ExportDeclaration`（`export { X, Y } from "./foo"` 或 `export * from "./foo"`）→ 按 `moduleSpecifier` 递归解析目标文件。
     - 若是 `export default` → 记作 `default`。
3. 针对 `lsp_package_symbol`：匹配 `name.text === symbolName`，命中即返回声明位置 + 第一行签名作为简化 hover。
4. 针对 `lsp_package_exports`：汇总所有顶层导出，按 `kinds / query / limit / includeReExports` 过滤后返回。
5. 去重：以 `(absFilePath, symbolName)` 为 key 去重，优先保留带 `export` 修饰符的原始声明，其次保留 re-export。

### 5. LSPClient 能力补齐

**文件**：`src/lsp/lsp-client.ts`

在 `LSPClient` 上新增方法（与既有风格一致）：

```ts
async completion(filePath, line, character, triggerKind?, triggerCharacter?): Promise<unknown>
async resolveCompletionItem(item: unknown): Promise<unknown>
async applyInMemoryEdit(filePath: string, newText: string): Promise<void>  // 封装 didChange 递增 version，不写盘
async revertInMemoryEdit(filePath: string): Promise<void>                  // 恢复到磁盘原文
```

- `completion` / `resolveCompletionItem` 使用 `textDocument/completion` 和 `completionItem/resolve`；`completion` 支持可选 `triggerKind=2 + triggerCharacter="."`，用于命中 `__pkg.` 后的成员补全（Strategy A 的 exports 分支必需）。
- `applyInMemoryEdit` / `revertInMemoryEdit` 基于现有 `lastSyncedText`、`documentVersions` 做 in-memory snapshot，不触发 `didSave`，避免改动用户文件。

### 6. 客户端 capabilities 声明补齐

**文件**：`src/lsp/lsp-client-connection.ts`

在 `textDocument` 里补充：

```ts
completion: {
  completionItem: {
    snippetSupport: false,
    resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
  },
  contextSupport: true,
},
```

### 7. 共享工具模块

**文件**：`src/lsp/package-resolution.ts`（新建）

抽出两个工具共用的辅助：

- `expandPackageNames(input, workspaceRoot, maxPackages): string[]` — 解析精确名 / 数组 / glob / 正则，扫描 `node_modules` 后返回实际包名列表；超过 `maxPackages` 抛错。
- `resolvePackageRoot(packageName, workspaceRoot): string | null`
- `getPackageDtsEntries(packageRoot): string[]`
- `findAnchorTsFile(workspaceRoot): string | null`
- `withProbeFile<T>(workspaceRoot, content, fn: (probePath) => Promise<T>): Promise<T>`
- `mapCompletionKindToSymbolKind(kind: number): string`
- `scanDtsExports(entryFiles: string[], opts): Array<{ name; kind; filePath; line; character; isReExport }>`

`lsp_package_symbol` 与 `lsp_package_exports` 都引用此模块，避免重复实现。

### 8. 工具注册

**文件**：`src/lsp/tools.ts` 与 `src/lsp/index.ts`

```ts
// tools.ts
export { lsp_package_symbol } from "./package-symbol-tool"
export { lsp_package_exports } from "./package-exports-tool"

// index.ts
export { ..., lsp_package_symbol, lsp_package_exports } from "./tools"
```

**文件**：`src/index.ts`

在 `return { tool: { ... } }` 中添加 `lsp_package_symbol` 与 `lsp_package_exports`。

### 9. 测试

**文件**：
- `test/lsp-package-symbol.test.ts`（新建）
- `test/lsp-package-exports.test.ts`（新建）

覆盖点（按现有 `test/lsp-tools.test.ts` 风格）：

- `lsp_package_symbol`：
  - Strategy A（单包）：基于本项目已依赖的 `typescript` 包，查询 `CompilerOptions`，期望拿到 `.d.ts` 位置 + hover。
  - **数组多包**：传 `["typescript", "bun-types"]` 查 `VariableDeclaration`，期望两个包各自的命中都能出现。
  - **glob 多包**：构造 fixture 含 `@fixture/a` / `@fixture/b` 两个虚拟包，查 `{ packageName: "@fixture/*", symbolName: "Shared" }`，期望两个包都返回。
  - **正则多包**：同上 fixture，传 `"/^@fixture\\//"`，行为等价。
  - `maxPackages` 溢出：命中 > maxPackages 时返回 `Error: Too many packages matched`。
  - Strategy C：构造仅有 `.d.ts` 的 fixture package，验证兜底可用。
  - 错误路径：包不存在 / symbol 不存在 → `Error:` 文案。
- `lsp_package_exports`：
  - Strategy A：查询 `typescript` 包，断言返回列表非空、包含已知 symbol（如 `CompilerOptions`）。
  - **多包 + groupByPackage=true**：glob `@fixture/*`，输出按包分组，各组有独立总数头。
  - **多包 + groupByPackage=false**：平铺输出，每行附 `[pkg]` 前缀。
  - `kinds` 过滤：只请求 `interface` 时不返回 class / function。
  - `query` 子串过滤：大小写不敏感。
  - Strategy C：fixture package 同时包含 `export class` + `export { X } from "./sub"`，验证 `includeReExports=true/false`。
  - `limit` 截断：多包汇总时 `limit` 基于总数。

---

## Assumptions & Decisions

1. **不新增 npm 依赖**：`typescript` 已随 `typescript-language-server` 安装到 `.bin` 同级 `node_modules`，通过 `require` 路径即可引入；遵循 project_memory 中「LSP server 不打包到 deps」的约束。
2. **in-memory didChange 不落盘**：新增的 `applyInMemoryEdit` 只发 `didChange`，不发 `didSave`，无磁盘副作用；`lsp_package_exports` 的 `__pkg.` 成员补全与 `lsp_package_symbol` 的命名导入补全都复用这套机制。
3. **probe 文件写盘**只在 Strategy B 生效，且放在 `.trae-probe/` 临时目录并最终删除；`withProbeFile` helper 用 finally 保证清理。
4. **对外返回格式**：
   - `lsp_package_symbol` 对齐 `formatLocation + formatHover`。
   - `lsp_package_exports` 对齐 `formatSymbolInfo` 的 `Name (Kind) - path:line:char` 风格，批量输出前附一行总数/截断提示。
5. **默认 strategy = `auto`**，顺序为 A → B → C；每步失败即进入下一步，与用户偏好的 try-fail-fallback 一致。
6. **exports 去重规则**：tsserver 的 namespace 补全已天然去重；`dts-scan` 自己实现 `(name, kind)` 去重，re-export 与原始声明冲突时保留原始声明。
7. **不修改现有工具签名**，保持向后兼容；新增的 `completion` capabilities 是增量声明，不会破坏 hover / goto / rename 等既有路径。
8. **kind 映射**：完成统一 `SymbolKind` 字符串（"Class" / "Interface" / "TypeAlias" / "Enum" / "Function" / "Variable" / "Namespace" / "Default"），dts-scan 与 LSP 的 CompletionItemKind 都收敛到这一套，避免两个来源输出格式不一致。
9. **多包语义**：
   - 精确匹配依旧优先（输入不含 `*` / `?` / `/…/`）；只有识别为 glob/正则才扫 `node_modules`，避免常规调用的性能退化。
   - 不引入 `minimatch` 之类的新 npm 依赖；`expandPackageNames` 用内置 `String.replace` + `RegExp` 手搓 glob 转 regex，足够覆盖 `*` / `?` / scope 用法。
   - 针对 scope（`@foo/*`），匹配器保证 `*` 不跨越 `/`（即不会把 `@foo/bar/baz` 误配给 `@foo/*`）。
   - 多包执行失败（如某个包解析失败、tsserver 超时）时，该包单独降级或跳过，不影响其他包的结果；错误以 `[pkg] <msg>` 附在返回末尾的 "Warnings:" 区块。

---

## Verification Steps

1. 构建：
   ```bash
   bun run build
   ```
2. 单测：
   ```bash
   bun test test/lsp-package-symbol.test.ts
   bun test test/lsp-package-exports.test.ts
   bun test
   ```
3. 手工验证（在一个包含 `@sar-engine/core` 的真实项目内）：
   - `lsp_package_symbol({ packageName: "@sar-engine/core", symbolName: "Texture2D" })` → `.d.ts` 位置 + 类声明 hover。
   - `lsp_package_exports({ packageName: "@sar-engine/core" })` → 返回所有公开导出，含 `Texture2D / Texture3D / ...`。
   - `lsp_package_exports({ packageName: "@sar-engine/core", kinds: ["class"], query: "tex" })` → 过滤后只剩纹理相关 class。
   - **多包 glob**：`lsp_package_exports({ packageName: "@sar-engine/*" })` → 列出 scope 下所有包及其导出，按 `groupByPackage` 分组输出。
   - **多包数组**：`lsp_package_symbol({ packageName: ["@sar-engine/core", "@sar-engine/physics"], symbolName: "Vector3" })` → 如果两个包都有同名类型，两个位置都返回。
   - **正则**：`lsp_package_exports({ packageName: "/^@sar-engine\\//" })` 等价于 `@sar-engine/*`。
   - `maxPackages` 边界：将 `maxPackages: 1` 与 glob 组合 → 返回 `Error: Too many packages matched`。
   - 断网 / 卸载 `typescript-language-server` 后再次调用，应回落到 Strategy C 并仍能返回列表。
4. 回归：
   ```bash
   bun test test/lsp-tools.test.ts
   ```
   确认现有 hover / goto / symbols 行为未变。
