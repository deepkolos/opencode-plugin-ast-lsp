# Standalone AST & LSP Tools

独立的 OpenCode 插件，提供 ast-grep 和 LSP 工具，无需安装完整的 oh-my-opencode 插件。

## 安装

### 从本地安装

```bash
cd opencode-plugin-ast-lsp
bun install
bun run build
```

然后在 OpenCode 配置中添加插件路径。

## 功能

### AST-Grep 工具

- `ast_grep_search`: 使用 AST 感知匹配搜索代码，支持 25+ 种语言
- `ast_grep_replace`: 使用 AST 感知重写替换代码，默认为干运行模式

### LSP 工具

- `lsp_goto_definition`: 跳转到符号定义位置
- `lsp_find_references`: 查找符号的所有引用
- `lsp_symbols`: 获取文件符号或工作区符号搜索
- `lsp_diagnostics`: 获取语言服务器的诊断信息（错误、警告等）
- `lsp_prepare_rename`: 检查重命名是否有效
- `lsp_rename`: 跨工作区重命名符号
- `lsp_hover`: 获取符号的悬停提示信息（类型定义、文档注释等）

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

### 跳转到定义

```
使用 lsp_goto_definition
  - filePath: "src/index.ts"
  - line: 42
  - character: 10
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

本插件在执行 LSP 命令时（如 `lsp_goto_definition`），会自动检测并调用 `Bun` 将 `typescript-language-server` 及 `vscode-langservers-extracted` 等依赖安装至缓存目录（`~/.cache/opencode-plugin-ast-lsp/npm/`）。

这意味着即使你的项目本身没有配置 TypeScript/ESLint，该插件也能够“自带”语言服务器为你提供最精确的代码分析与重构能力。

## 项目结构

```
opencode-plugin-ast-lsp/
├── src/
│   ├── index.ts              # 插件入口
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
