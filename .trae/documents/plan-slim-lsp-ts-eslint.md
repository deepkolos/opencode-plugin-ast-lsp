## Summary
将 LSP 语言支持精简为仅 TypeScript + ESLint，并把对应的 npm 依赖“内置到插件自身”以做到开箱即用：运行时优先从插件包内的 `node_modules/.bin` 找到并启动语言服务器，不做自动安装。

## Current State Analysis
- 服务器配置集中在 `src/lsp/server-definitions.ts` 的 `BUILTIN_SERVERS` / `LSP_INSTALL_HINTS`，目前包含大量语言服务器（deno/vue/biome/...）。
- 服务器选择逻辑在 `src/lsp/server-resolution.ts`：
  - 遍历 `BUILTIN_SERVERS`，用 `isServerInstalled(server.command)` 判断是否可用，返回第一个匹配且已安装的 server。
  - 未安装则返回 `not_installed` 并提供 `installHint`。
- 安装检测逻辑在 `src/lsp/server-installation.ts`：
  - 仅检查 `PATH` 以及 `process.cwd()/node_modules/.bin`。
  - 这对“把语言服务器作为插件依赖安装在插件包内”并不可靠：运行时 `process.cwd()` 往往是用户 workspace，而不是插件目录。
- LSP 客户端入口 `src/lsp/lsp-client-wrapper.ts` 在 server 未找到/未安装时直接抛错，不会自动安装。

## Goals / Success Criteria
- 仅保留 `typescript` 与 `eslint` 两个 LSP server 配置。
- 插件运行时在多数场景无需用户全局安装：能从插件自身依赖中发现并启动 `typescript-language-server` 与 `vscode-eslint-language-server`。
- 保持现有 LSP 工具对 `.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts` 的可用性，且不引入 Deno 依赖。
- `bun test` 与 `npm run build` 均通过。

## Proposed Changes
### 1) 精简内置 server 列表
- 文件：`src/lsp/server-definitions.ts`
- 修改：
  - `LSP_INSTALL_HINTS`：仅保留 `typescript`、`eslint` 两项。
  - `BUILTIN_SERVERS`：仅保留 `typescript` 与 `eslint` 两项。
  - `eslint` 的 extensions 设为 “TS/JS 系列”：`.ts .tsx .js .jsx .mjs .cjs .mts .cts`（按用户选择）。
- 说明：
  - 保持 `typescript` 在对象中的顺序优先于 `eslint`，确保同一扩展名下优先选中 `typescript-language-server`（避免 goto-definition/rename 等能力被 eslint server 误选）。

### 2) 让 server 安装检测覆盖“插件自身 node_modules/.bin”
- 文件：`src/lsp/server-installation.ts`
- 问题：
  - 现在只检查 `process.cwd()/node_modules/.bin`，无法在插件被安装为依赖时稳定发现插件包内的 bin。
- 修改：
  - 增加一个“插件包根目录 bin”搜索路径：`<packageRoot>/node_modules/.bin`。
  - `packageRoot` 通过 `import.meta.url` 推导当前文件所在目录，然后向上寻找最近的 `package.json`（或直接上溯固定层级到包根，取决于当前目录结构）。
  - 保留现有 `PATH` 与 `process.cwd()/node_modules/.bin` 检测，以兼容用户项目自行安装/全局安装的情况。
- 预期效果：
  - 当插件把语言服务器作为 dependencies 安装时，`isServerInstalled()` 能找到对应可执行文件，从而 `findServerForExtension()` 返回 `found`。

### 3) 将 TypeScript + ESLint server 依赖内置到插件依赖中（不自动安装）
- 文件：`package.json`
- 修改：
  - 确保运行期依赖存在：
    - `typescript-language-server`
    - `typescript`（`typescript-language-server` 运行所需）
    - `vscode-langservers-extracted`（提供 `vscode-eslint-language-server` 可执行文件）
  - 以上应放入 `dependencies`（而非仅 `devDependencies`），确保插件作为依赖被安装时也能拿到 bin。
  - `peerDependencies.typescript` 可保留或移除（决策：保留以提示宿主环境 TS 版本约束，同时在 `dependencies` 里也固定一个可运行版本）。

### 4) （可选）避免对不支持语言的目录诊断“误判扩展名”
- 文件：`src/lsp/infer-extension.ts`
- 背景：
  - `lsp_diagnostics` 的目录模式会调用 `inferExtensionFromDirectory()` 推断扩展名；当前会把 `.py` 等也当成候选（基于 `EXT_TO_LANG`），然后在后续报 “No server found for .py”。
- 修改：
  - 将可扫描的扩展名限制为当前内置 server 支持的扩展名集合（即 typescript+eslint 的 union）。
- 说明：
  - 这一步能让目录诊断在非 TS/JS 项目上更早返回 “No supported source files found”，属于体验优化；若希望严格按“只做精简 server 列表”也可不做。

## Assumptions & Decisions (Locked)
- 不做自动安装（不执行 `npm install -g` / `npm install -D`）。
- eslint server extensions 采用 TS/JS 系列（不含 `.vue`）。
- 运行时默认仍由 `findServerForExtension()` 选 server；通过 server 顺序确保优先 typescript。

## Verification
1. 运行 `bun test`（包含真实 LSP/AST-grep 集成测试）。
2. 运行 `npm run build`（确保类型声明生成与 bundling 正常）。
3. 额外手动验证（可选）：
   - 在一个全新目录（无全局语言服务器）加载插件，确认 `lsp_goto_definition` 能启动 `typescript-language-server` 并返回结果。

