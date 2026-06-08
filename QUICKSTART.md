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

### 3. 语言服务器

插件会自动安装内置的 TypeScript/JavaScript LSP 依赖到独立缓存目录，不需要全局安装。

## 使用示例

LSP 工具返回统一 JSON envelope。优先读取 `ok`、`summary`、`data`、`hints`、`warnings`、`nextActions`、`truncated` 和 `errors` 字段。

### AST-Grep 搜索

```
使用 ast_grep_search
  - pattern: "function $NAME($$$) { $$$ }"
  - lang: "typescript"
  - paths: ["src"]
```

### 理解符号/API

```
使用 lsp_inspect
  - filePath: "src/index.ts"
  - line: 10
  - character: 5
  - mode: "surface"
```

### 探索包或文件里的 API

```
使用 lsp_discover
  - packageName: "@scope/pkg"
  - query: "texture"
```

### 查看真实使用方式

```
使用 lsp_usages
  - filePath: "src/index.ts"
  - line: 10
  - character: 5
  - contextLines: 3
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

插件会优先使用项目或缓存中的语言服务器。如果自动安装失败，先确认本机可以运行 `bun install`，再重试相关 LSP 工具。

### 插件无法加载

确保路径指向已构建的 `dist/index.js` 文件，并且有正确的读取权限。
