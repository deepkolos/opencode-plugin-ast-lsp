# 快速开始指南

## 前置要求

- Bun 1.0+
- OpenCode CLI

## 安装步骤

### 1. 构建插件

```bash
cd opencode-plugin-ast-lsp
bun install
bun run build
```

### 2. 在 OpenCode 中配置

编辑你的 OpenCode 配置文件（通常是 `~/.config/opencode/config.json`）：

```json
{
  "plugins": [
    {
      "name": "opencode-plugin-ast-lsp",
      "path": "/path/to/opencode-plugin-ast-lsp/dist/index.js"
    }
  ]
}
```

### 3. 安装所需的语言服务器（可选但推荐）

```bash
# TypeScript
npm install -g typescript-language-server typescript

# Python
pip install basedpyright

# Rust
rustup component add rust-analyzer

# Go
go install golang.org/x/tools/gopls@latest
```

## 使用示例

### AST-Grep 搜索

```
使用 ast_grep_search
  - pattern: "function $NAME($$$) { $$$ }"
  - lang: "typescript"
  - paths: ["src"]
```

### 查找定义

```
使用 lsp_goto_definition
  - filePath: "src/index.ts"
  - line: 10
  - character: 5
```

### 获取悬停提示（类型/文档）

```
使用 lsp_hover
  - filePath: "src/index.ts"
  - line: 10
  - character: 5
```

### 检查错误

```
使用 lsp_diagnostics
  - filePath: "src/"
  - severity: "error"
```

## 故障排除

### ast-grep 无法下载

如果自动下载失败，可以手动安装：

```bash
brew install ast-grep  # macOS
cargo install ast-grep --locked  # 使用 Cargo
```

### LSP 服务器找不到

确保语言服务器已安装并且在 PATH 中。你可以通过以下命令检查：

```bash
# 检查特定服务器
which typescript-language-server
which pyright
```

### 插件无法加载

确保路径指向已构建的 `dist/index.js` 文件，并且有正确的读取权限。
