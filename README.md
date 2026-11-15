# Standalone AST & LSP Tools

独立的 AST-Grep 和 LSP 工具集，提供 OpenCode 插件、Bun CLI 和 Node/Bun 包声明发现 SDK。OpenCode 可以作为插件使用，其他 code agent 可以通过 CLI 调用同一批工具。

## 安装

### 从本地安装

```bash
cd opencode-plugin-ast-lsp
bun install
bun run build
```

然后在 OpenCode 配置中添加插件路径。

### CLI 使用

CLI 以 JS 形式发布，要求本机可执行 Bun。构建后会生成 `dist/cli.js`，包的 bin 名称是 `ast-lsp`。

```bash
bun install
bun run build

# 查看工具
bun dist/cli.js list-tools --json

# 调用工具
bun dist/cli.js run lsp_inspect \
  --cwd . \
  --input '{"filePath":"src/index.ts","line":42,"character":10}'

# 从 stdin 传 JSON
echo '{"pattern":"console.log($MSG)","lang":"typescript","paths":["src"]}' \
  | bun dist/cli.js run ast_grep_search --stdin
```

发布安装后可直接使用：

```bash
ast-lsp list-tools --json
ast-lsp run lsp_discover --input '{"packageName":"@scope/pkg","query":"texture"}'
```

也可以通过包执行器调用发布包。推荐使用 `bunx`：

```bash
bunx --bun --package opencode-plugin-ast-lsp ast-lsp list-tools --json
```

`npx` 也可以找到 npm 包里的 `ast-lsp` bin，但该 bin 的 shebang 是 `#!/usr/bin/env bun`，所以机器上仍然需要 Bun 在 `PATH` 中：

```bash
npx --yes --package opencode-plugin-ast-lsp ast-lsp list-tools --json
```

### Node/Bun SDK

`opencode-plugin-ast-lsp/sdk` 支持 Node.js 18+ 和 Bun，通过已安装的包声明发现符号。SDK 不需要 OpenCode 的 PluginInput，不安装或启动语言服务器，也不调用包管理器。ESM 和 CommonJS 使用相同接口：

```ts
import { discoverPackages } from "opencode-plugin-ast-lsp/sdk"
// CommonJS: const { discoverPackages } = require("opencode-plugin-ast-lsp/sdk")

const result = discoverPackages({
  workspaceRoot: process.cwd(),
  packageName: ["@scope/core", "@scope/platform"],
  limit: 5000,
})

for (const pkg of result.packages) {
  console.log(pkg.packageName, pkg.symbols)
}
```

`packageName` 支持包名、数组、glob 和正则字面量；`query` 按符号名称过滤，`kinds` 过滤符号类别。`limit` 是每包上限（默认 200，范围 1–5000），`maxPackages` 限制匹配包数（默认 20，范围 1–500）。结果包含符号的声明位置、签名、文档，以及 `total`、`shown`、`warnings` 和 `truncated`。SDK 沿用 `lsp_discover` 的包声明扫描器与结果格式；文件/工作区模式继续使用 LSP。

## 功能

### AST-Grep 工具

- `ast_grep_search`: 使用 AST 感知匹配搜索代码，支持 25+ 种语言
- `ast_grep_replace`: 使用 AST 感知重写替换代码，默认为干运行模式

### LSP 工具

- `lsp_inspect`: 理解符号/API 的定义、文档、成员、签名和相关类型
- `lsp_discover`: 在文件、工作区或 npm 包中发现可用符号/API
- `lsp_usages`: 查找符号引用和真实调用片段
- `lsp_diagnostics`: 获取语言服务器的诊断信息（错误、警告等）
- `lsp_rename`: 先校验再跨工作区重命名符号，支持 dry-run

底层 LSP 原子能力（hover、definition、references、symbols、package exports 等）作为内部实现使用，不再注册为 agent 可见工具。agent 默认只需要在“理解 / 发现 / 查使用 / 查诊断 / 重命名”这几个意图之间选择。

所有 LSP 工具输出统一为 JSON envelope 字符串：

```json
{
  "ok": true,
  "tool": "lsp_inspect",
  "summary": "Inspected symbol at src/index.ts:42:10.",
  "data": {},
  "hints": [],
  "warnings": [],
  "nextActions": [],
  "truncated": false,
  "errors": []
}
```

其中 `summary` 适合人类快速阅读，`data` 是 agent 应优先消费的结构化结果。

## OpenCode Plugin 与 CLI 对比

Plugin 和 CLI 复用同一个工具 registry，暴露相同的高层工具和 JSON envelope 输出：

- `ast_grep_search`
- `ast_grep_replace`
- `lsp_inspect`
- `lsp_discover`
- `lsp_usages`
- `lsp_diagnostics`
- `lsp_rename`

主要差异：

| 维度 | OpenCode Plugin | Bun CLI |
| --- | --- | --- |
| 适用场景 | OpenCode 内部工具调用 | Claude Code、Codex、Cursor agent、shell-based agent 等外部调用 |
| 运行方式 | 宿主加载插件并调用工具 | `ast-lsp run <tool> --input ...` 单次命令 |
| 进程生命周期 | 通常随 agent 会话复用 | 默认 single-shot，执行完退出 |
| LSP 性能 | LSP server 可在会话内复用，连续调用更快 | 每次调用可能有 Bun 启动和 LSP 初始化成本 |
| 输出 | JSON envelope 字符串 | stdout 输出 JSON envelope，stderr 预留给日志/进度 |
| 工作目录 | 由 OpenCode `PluginInput.directory` 提供 | 由 `--cwd` 或当前目录决定 |
| 交互能力 | 可接入宿主 metadata / abort signal | 第一版不支持交互式权限确认 |

如果外部 agent 高频调用 LSP 工具，后续可以增加 `ast-lsp serve --stdio` 作为常驻进程模式，复用 LSP server，减少 single-shot CLI 的冷启动成本。

## 语言支持

### AST-Grep

支持 25+ 种语言，包括：JavaScript、TypeScript、Python、Java、Go、Rust 等。

### LSP

目前该插件专注于提供开箱即用的前端（TypeScript/JavaScript）支持。
内置并**自动安装**了以下语言服务器：

- **TypeScript / JavaScript**: `typescript-language-server`
- **ESLint**: `vscode-eslint-language-server`

*注：LSP 语言服务器会在插件首次使用相关功能时，自动下载至插件独立的本地缓存中，不会污染你的全局系统环境。*

## 使用示例

### 搜索代码模式

```
使用 ast_grep_search 搜索
  - pattern: "console.log($MSG)"
  - lang: "typescript"
  - paths: ["src"]
```

### 理解符号/API

```
使用 lsp_inspect
  - filePath: "src/index.ts"
  - line: 42
  - character: 10
  - mode: "surface"
```

或者直接检查包内 API：

```
使用 lsp_inspect
  - packageName: "@scope/pkg"
  - symbolName: "Texture2D"
  - mode: "deep"
```

### 发现可用 API

```
使用 lsp_discover
  - packageName: "@scope/pkg"
  - query: "texture"
```

### 获取诊断信息

```
使用 lsp_diagnostics
  - filePath: "src/"
  - severity: "error"
```

## 依赖说明

### AST-Grep

插件会自动下载 ast-grep 二进制文件。如果需要手动安装，可以使用以下方式：

```bash
# 使用 Homebrew
brew install ast-grep

# 使用 Cargo
cargo install ast-grep --locked
```

### LSP 服务器

无需手动安装！

本插件在执行 LSP 命令时（如 `lsp_inspect`），会自动检测并调用 `Bun` 将 `typescript-language-server` 及 `vscode-langservers-extracted` 等依赖安装至缓存目录（`~/.cache/opencode-plugin-ast-lsp/npm/`）。

这意味着即使你的项目本身没有配置 TypeScript/ESLint，该插件也能够“自带”语言服务器为你提供最精确的代码分析与重构能力。

## 测试发布包入口

除了普通测试，还可以用本地 tarball 模拟发布后的包执行路径：

```bash
# 直接运行源码 CLI
bun test test/cli.test.ts

# npm pack 后用 bunx --package <tgz> 调用 ast-lsp
bun run test:bunx:pack

# npm pack 后用 npx --package <tgz> 调用 ast-lsp
# 注意：npx 只负责安装/定位 bin，实际运行仍需要 Bun。
bun run test:npx:pack
```

## 项目结构

```
opencode-plugin-ast-lsp/
├── src/
│   ├── index.ts              # 插件入口
│   ├── cli.ts                # Bun CLI 入口
│   ├── tool-registry.ts      # Plugin/CLI 共用工具注册表
│   ├── ast-grep/             # AST-Grep 工具
│   │   ├── index.ts
│   │   ├── tools.ts
│   │   ├── cli.ts
│   │   ├── downloader.ts
│   │   ├── constants.ts
│   │   ├── types.ts
│   │   ├── result-formatter.ts
│   │   └── ...
│   ├── lsp/                  # LSP 工具
│   │   ├── index.ts
│   │   ├── tools.ts
│   │   ├── lsp-server.ts
│   │   ├── lsp-client.ts
│   │   ├── server-definitions.ts
│   │   ├── types.ts
│   │   └── ...
│   └── shared/               # 共享工具
│       ├── logger.ts
│       ├── binary-downloader.ts
│       └── plugin-identity.ts
├── package.json
├── tsconfig.json
└── README.md
```

## 与 oh-my-opencode 的区别

本插件是从 oh-my-opencode 中抽离出的精简版本，只包含：

- ✅ AST-Grep 搜索和替换工具
- ✅ LSP 相关工具
- ❌ 其他 oh-my-opencode 功能（如代理、多模态等）

## 许可证

MIT
