# LSP 工具「包名规则」应用范围分析与方案

> 用户原诉求：让**其他 LSP 工具**也应用 `lsp_package_symbol` / `lsp_package_exports` 已实现的「包名规则」（精确名 / 数组 / glob / 正则），这样在只知道 `packageName`（或 `packageName + symbolName`）时，依然可以调用现有的 hover / goto / references / symbols / diagnostics / rename。
>
> 本文档先做深入分析：**每个现有工具的真实定位和推荐使用场景**，据此判断"包名规则是否值得被应用"，再给出**分层执行方案**。

---

## Summary（结论先行）

| 工具 | 现有定位（关键词） | 包名规则是否值得应用 | 推荐覆盖优先级 |
|---|---|---|---|
| `lsp_hover` | 看符号文档 / 签名 / 类型 | ✅ 强相关 | **P0** |
| `lsp_goto_definition` | 跳定义 | ✅ 强相关 | **P0** |
| `lsp_find_references` | 找符号在工作区的所有使用 | ✅ 中等相关 | **P1** |
| `lsp_symbols` (document) | 文件 outline | ⚠️ 弱相关（与 `lsp_package_exports` 重叠） | 不建议 |
| `lsp_symbols` (workspace) | 按名字搜索工作区符号 | ⚠️ 牵强（本就是字符串 query） | 不建议 |
| `lsp_diagnostics` | 拉诊断 | ❌ 不合理（`.d.ts` 基本无诊断） | 不建议 |
| `lsp_prepare_rename` / `lsp_rename` | 跨工作区重命名 | ❌ 反模式（不应该改 node_modules） | **绝对不做** |

**推荐执行**：只对 `lsp_hover` / `lsp_goto_definition` / `lsp_find_references` 三个工具扩展包名规则。

---

## 1. 现有工具详细定位与使用场景分析

### 1.1 `lsp_hover` —— 看文档 / 类型
- **现有定位**：光标驻留一个符号上，拿 tsserver 给的 markdown（签名 + JSDoc）。
- **推荐使用场景**：
  - "这个函数第二个参数是什么类型？"
  - "这个 class 的泛型参数是什么？"
  - "这条导出有 @deprecated 吗？"
- **包名规则是否值得**：✅ **值得**。
  - 典型诉求：只知道 `@sar-engine/core` 和 `Texture2D`，想快速看它的签名。
  - 当前已有 `lsp_package_symbol`（含可选 hover），但它是**面向定位**的，hover 只是副产品；而 `lsp_hover` 是"单纯看文档"的专用入口。支持包名规则可以省去两次调用的心智负担。
- **实现复杂度**：低。复用 `package-resolution` 定位声明位置，再调 `client.hover`。

### 1.2 `lsp_goto_definition` —— 跳定义
- **现有定位**：从"使用点"跳到"声明点"。当前必须先在某个源文件里写出 `Texture2D` 并放光标上。
- **推荐使用场景**：
  - "我只见过 `Texture2D` 这个词，它到底在哪个文件声明的？"
  - "这个类型从哪个包导出？顺便看下源码。"
- **包名规则是否值得**：✅ **值得**。
  - 很常见的工作流：用户从文档/别人的代码里看到 `@sar-engine/core` + `Texture2D`，但本地项目里一次都没用过，传统 goto 根本无从下手。
  - 当前虽然 `lsp_package_symbol` 的输出也是 `path:line:col`，但 `lsp_goto_definition` 在 MCP / Agent 语义层更直觉，有利于工具选择。
- **注意**：`.d.ts` 里的声明可能还有 "declaration navigation"（`export { X } from "./impl"`），这时应进一步沿 re-export 链走到终点。可复用 `scanDtsExports` 里已处理 re-export 的逻辑。

### 1.3 `lsp_find_references` —— 找使用
- **现有定位**：在**整个工作区**（不含依赖包）找对某个 symbol 的所有引用。
- **推荐使用场景**：
  - "我升级了 `@sar-engine/core` 的 `Texture2D`，想看工作区里哪些文件用到了它。"
  - "某个导出要废弃，先盘点影响面。"
- **包名规则是否值得**：✅ **值得**（P1）。
  - 当前流程：必须先 `goto_definition` → 拿到 `.d.ts` 位置 → 再调 `references`，两步。
  - 包名版：一次调用即可 `references(@sar-engine/core, Texture2D)`，对工作量收益明显。
  - tsserver 的 `references` 参数是位置，不是 symbol；我们在内部先定位到 `.d.ts` 声明再调 `references` 即可。
- **注意**：多个包命中同名 symbol 时，要分别调、结果按包分组。

### 1.4 `lsp_symbols` (document) —— 文件 outline
- **现有定位**：拿一个文件的 outline（class / method 层次树）。
- **推荐使用场景**：阅读一个新文件前快速看结构。
- **包名规则是否值得**：⚠️ **不建议**。
  - 用户大概率不是"想看 `@sar-engine/core` 某个 .d.ts 文件的层次 outline"，而是"想看这个包导出了哪些东西"。后者 `lsp_package_exports` 已覆盖，且更贴近意图。
  - 如果硬要支持，需要定义"包名 → 取哪个文件 outline"，语义含糊（types 入口？所有 .d.ts？）。属于过度工程。

### 1.5 `lsp_symbols` (workspace) —— 工作区符号搜索
- **现有定位**：按名字（字符串 query）在工作区已索引符号里模糊搜索。
- **推荐使用场景**：想找一个叫 `UserService` 的类在项目里哪儿。
- **包名规则是否值得**：⚠️ **不合适**。
  - 这里的"query"本来就是字符串，不是包名；混入 `packageName` 参数会让工具语义混乱。
  - 如果真的想"在某个包里搜索 symbol"，`lsp_package_exports` 配 `query` 参数就是答案。
- **结论**：维持现状。

### 1.6 `lsp_diagnostics` —— 诊断
- **现有定位**：对单文件或一个目录批量拉诊断（错误、警告、提示）。
- **推荐使用场景**：构建前早期发现类型 / lint 错误。
- **包名规则是否值得**：❌ **不合理**。
  - `node_modules/<pkg>/**/*.d.ts` 几乎不会有用户关心的诊断（发布前作者已过编译器）。
  - 让用户用 glob 对 `@sar-engine/*` 批量诊断几乎没有产出；反而可能触发 LSP 大量打开 `.d.ts`，显著拖慢进程。
  - 如果真的要"诊断依赖包"，应该去原包仓库跑 TSC，不是 LSP 工具的职责。
- **结论**：不支持。

### 1.7 `lsp_prepare_rename` / `lsp_rename` —— 跨工作区重命名
- **现有定位**：对符号做安全的跨文件重命名。
- **推荐使用场景**：本地代码重构。
- **包名规则是否值得**：❌ **绝对不要**。
  - 重命名需要定位到声明 → 再把引用全部替换。包名版等价于"用户让我去改 `node_modules/@sar-engine/core/index.d.ts`"，这属于**污染依赖**：
    - `npm install` 再次被覆盖；
    - 上游包升级时会出现神秘 diff；
    - 原包作者的源码和本地 .d.ts 脱节；
  - LSP 层面也不可靠：tsserver 不会主动索引 `node_modules` 的所有 .d.ts（`node_modules` 被 default exclude），`rename` 常常只改到一部分文件，造成不一致。
- **结论**：**主动拒绝**，保持现状。

---

## 2. 提议的执行方案（分阶段）

### 阶段 1（P0，必做）：为 `lsp_hover` / `lsp_goto_definition` 增加包名入参

- 两个工具各自 **新增可选参数** `packageName` + `symbolName`（及 `workspaceRoot / maxPackages`），**保留原 `filePath / line / character`** 作为一等入参。
- 入参规则（在 `execute` 入口 switch）：
  1. 若传了 `packageName` → 走「包名路径」：
     - `expandPackageNames(packageName, root, maxPackages)` → 得到包列表。
     - 对每个包 `resolvePackageRoot` + `getPackageDtsEntries` + `findDtsSymbol(entries, symbolName)` → 得到 `(absFile, line, character)`。
     - 用得到的位置调 `withLspClient(absFile, client => client.hover(...))` / `client.definition(...)`。
     - 多包并发（5 并发），按包分组聚合输出。
  2. 否则若传了 `filePath` + `line` + `character` → 保留原行为（向后兼容）。
  3. 两组都没给 → 错误提示。
- **实现落点**：
  - [src/lsp/hover-tool.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/hover-tool.ts)
  - [src/lsp/goto-definition-tool.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/goto-definition-tool.ts)
- **共享 helper**（在 `package-resolution.ts` 中新增）：
  - `resolvePackageSymbolLocations(args): Promise<Array<{ pkg, filePath, line, character }>>`
  - 两个工具都调用这个函数得到定位集合，再做各自的 LSP 调用。

### 阶段 2（P1，推荐）：为 `lsp_find_references` 增加包名入参

- 同样新增可选 `packageName + symbolName`。
- 内部：
  1. 定位声明位置（同上）。
  2. 对位置调 `client.references`。
  3. 多包时按包分组输出；每组独立报 `Found N references` / 截断提示。
- **实现落点**：[src/lsp/find-references-tool.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/find-references-tool.ts)

### 阶段 3（不做）：明确排除的工具

- `lsp_symbols` / `lsp_diagnostics` / `lsp_prepare_rename` / `lsp_rename` 保持现有签名，**不引入 `packageName` 参数**。
- 在 README / 工具 `description` 中写明"按包探索请用 `lsp_package_exports` / `lsp_package_symbol`"，避免 Agent 误选。

---

## 3. 统一入参约定（阶段 1/2 共用）

```ts
// 新增可选组（任一给出即走包名路径）
packageName?: string | string[]    // 精确 | 数组 | glob | /regex/
symbolName?: string                // 必须与 packageName 同时提供
workspaceRoot?: string             // 默认 process.cwd()
maxPackages?: number               // 默认 20
```

**参数校验**：
- `packageName` 给了但 `symbolName` 没给 → 错误 `Error: symbolName is required when packageName is provided`。
- 同时给了 `packageName` 和 `filePath/line/character` → **优先 packageName**，`filePath` 等被忽略；在返回开头加一行 `Note: filePath/line/character ignored because packageName was provided.`。

---

## 4. 输出格式（保持风格一致）

### `lsp_hover`（包名路径）
```
@sar-engine/core :: Texture2D
File: <abs .d.ts>:<line>:<char>
---
<hover markdown>
```
多包命中：各包独立块，`\n\n` 分隔。

### `lsp_goto_definition`（包名路径）
```
@sar-engine/core :: Texture2D
<abs>:<line>:<char>
```
多包：一行一条，按 `<pkg> <path>:<line>:<char>` 输出（保留原 `formatLocation` 风格但加包前缀）。

### `lsp_find_references`（包名路径）
```
=== @sar-engine/core :: Texture2D ===
<n> reference(s):
<ref path>:<line>:<char>
...
```
多包各自分组。

---

## 5. Current State Analysis（已核对）

- [hover-tool.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/hover-tool.ts)、[goto-definition-tool.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/goto-definition-tool.ts)、[find-references-tool.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/find-references-tool.ts) 都通过 `withLspClient(filePath, fn)` 封装；我们在 execute 入口新增分支即可，无需改动 wrapper。
- [package-resolution.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/package-resolution.ts) 已提供 `expandPackageNames / resolvePackageRoot / getPackageDtsEntries / findDtsSymbol`，可直接复用；唯一需要新加的是**聚合 helper** `resolvePackageSymbolLocations`，避免在三处工具里重复 for-loop。
- `findDtsSymbol` 目前只返回第一个命中；若需要要跟 `export { X } from "./impl"` 再下钻到终点，已在 `scanDtsExports` 里递归，默认就会选择带 `export` 修饰符的真实声明优先，符合预期。

---

## 6. Proposed Changes（文件级 diff 清单）

1. **[src/lsp/package-resolution.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/package-resolution.ts)** —— 新增 helper
   ```ts
   export interface PackageSymbolLocation {
     pkg: string
     filePath: string
     line: number
     character: number
     kind: UnifiedSymbolKind
   }
   export function resolvePackageSymbolLocations(
     packageName: string | string[],
     symbolName: string,
     workspaceRoot: string,
     maxPackages?: number,
   ): PackageSymbolLocation[]
   ```
   - 内部调用 `expandPackageNames` → 每个包取 dts entries → `findDtsSymbol` → 汇总。空命中的包静默忽略。

2. **[src/lsp/hover-tool.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/hover-tool.ts)** ——
   - 扩展 args schema：`filePath / line / character` 改为 optional；新增 `packageName / symbolName / workspaceRoot / maxPackages`。
   - execute 开头分支：若 `packageName` 存在 → 走包名路径；否则保留原逻辑。
   - 更新 `description`：注明两种入参方式。

3. **[src/lsp/goto-definition-tool.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/goto-definition-tool.ts)** —— 同上。

4. **[src/lsp/find-references-tool.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/src/lsp/find-references-tool.ts)** —— 同上。

5. **不修改**：`symbols-tool.ts` / `diagnostics-tool.ts` / `rename-tools.ts`。

6. **测试新增**：
   - [test/lsp-hover-by-package.test.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/test/lsp-hover-by-package.test.ts)
   - [test/lsp-goto-by-package.test.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/test/lsp-goto-by-package.test.ts)
   - [test/lsp-references-by-package.test.ts](file:///Users/bytedance/opensource/standalone-ast-lsp-tools/test/lsp-references-by-package.test.ts)
   - 每个至少覆盖：
     - 精确包名命中 + 返回格式
     - glob 多包命中
     - 未命中 symbol → 友好错误文案
     - 与原 `filePath + line + character` 调用共存（向后兼容）

---

## 7. Assumptions & Decisions

1. **向后兼容优先**：原 `filePath + line + character` 入参保持一等公民；仅把它们从 required 降为 optional，新增的 `packageName` 作为替代分支。对老调用方零影响。
2. **不改 wrapper/LSPClient**：`withLspClient` 已能处理任意 `filePath`，我们把 `.d.ts` 路径丢给它即可（tsserver 能正常 hover / definition / references 一个 `.d.ts` 文件）。
3. **`description` 显著提醒**：三个工具的 description 写明"优先使用 packageName + symbolName 场景"。让 Agent 更易于选对入参。
4. **默认 maxPackages=20**，和 `lsp_package_symbol` 一致，行为可预测。
5. **排除工具的 description 更新**：在 `lsp_symbols / lsp_diagnostics / lsp_rename` description 补一句"For by-package lookup use lsp_package_symbol / lsp_package_exports"，减少 Agent 误判。
6. **不新增 npm deps**、**不改 capabilities**、**不影响 lsp-server 进程逻辑**。

---

## 8. Verification Steps

1. `bun run build` —— 类型必须通过。
2. 针对新测试：
   ```bash
   bun test test/lsp-hover-by-package.test.ts \
            test/lsp-goto-by-package.test.ts \
            test/lsp-references-by-package.test.ts
   ```
3. 回归：
   ```bash
   bun test
   ```
   确保原 `lsp-tools.test.ts` / `lsp-package-symbol.test.ts` / `lsp-package-exports.test.ts` 全绿。
4. 手动验证（真实项目）：
   - `lsp_hover({ packageName: "@sar-engine/core", symbolName: "Texture2D" })` → 返回 hover markdown。
   - `lsp_goto_definition({ packageName: "@sar-engine/*", symbolName: "Vec3" })` → scope 下所有含 `Vec3` 的包位置。
   - `lsp_find_references({ packageName: "@sar-engine/core", symbolName: "Texture2D" })` → 返回本工作区对 Texture2D 的使用点。
   - 老式调用 `lsp_hover({ filePath, line, character })` 行为不变。

---

## 9. 决策请求（用户拍板）

**推荐执行范围**：仅阶段 1 + 阶段 2（`hover` / `goto_definition` / `find_references`），排除其余工具。

可选备选：
- 方案 A（推荐）：只做上述三个工具 ← 默认
- 方案 B：在 A 基础上再加 `lsp_symbols` (document) 的包名变体，用于列单个 .d.ts 的层次 outline
- 方案 C：全覆盖（含 rename / diagnostics）— **不建议**，有维护与正确性风险

若你同意方案 A，我将直接进入执行。
