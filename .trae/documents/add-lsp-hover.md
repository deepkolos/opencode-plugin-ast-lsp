# 新增 `lsp_hover` 方法计划

## 摘要
在当前 LSP 插件工具集中新增 `lsp_hover` 方法，用于获取 TypeScript（及其他支持的语言）符号的悬停提示信息，包括类型定义、方法签名和 JSDoc 文档注释。该方法将完全利用 LSP 的 `textDocument/hover` 能力，并将返回的多态内容（`MarkedString`、`MarkupContent`）格式化为 LLM 易读的 Markdown 文本。

## 当前状态分析
- `src/lsp/lsp-client.ts` 中的 `LSPClient` 类目前已支持 `definition`、`references`、`documentSymbols` 等方法，但尚未实现 `hover` 方法。
- `src/lsp/types.ts` 缺少与 Hover 相关的类型定义。
- `src/lsp/lsp-formatters.ts` 包含各种 LSP 响应的格式化函数，但需要补充解析 `Hover` 对象的方法，因为 Hover 响应的内容结构可能比较复杂（字符串、带有语言标识的对象或数组）。

## 建议更改

### 1. 更新类型定义 (`src/lsp/types.ts`)
新增 LSP 规范中定义的 Hover 相关接口：
- `MarkupContent`: `{ kind: "plaintext" | "markdown", value: string }`
- `MarkedString`: `string | { language: string, value: string }`
- `Hover`: `{ contents: MarkupContent | MarkedString | MarkedString[], range?: Range }`

### 2. 扩展 LSP 客户端 (`src/lsp/lsp-client.ts`)
在 `LSPClient` 类中添加 `hover` 方法：
- 接收 `filePath`、`line`、`character`。
- 确保文件被打开 (`this.openFile`)。
- 调用 `this.sendRequest("textDocument/hover", ...)` 并返回结果。

### 3. 添加格式化器 (`src/lsp/lsp-formatters.ts`)
新增 `formatHover(hover: Hover | null): string` 方法：
- 处理 `hover.contents` 为字符串的情况。
- 处理 `hover.contents` 为数组（多个 `MarkedString`）的情况。
- 处理 `hover.contents` 为 `MarkupContent`（含有 `kind` 和 `value`）的情况。
- 对于指定了 `language` 的 `MarkedString`，使用 Markdown 代码块（如 ` ```typescript\n... \n``` `）进行包装，确保向 LLM 暴露最完整的能力。

### 4. 创建工具定义 (`src/lsp/hover-tool.ts`)
- 新建文件，使用 `@opencode-ai/plugin/tool` 创建 `lsp_hover` 工具。
- 参数：`filePath` (string), `line` (number, 1-based), `character` (number, 0-based)。
- 执行逻辑：通过 `withLspClient` 获取 client，调用 `client.hover`，最后通过 `formatHover` 返回结果。

### 5. 注册与导出
- `src/lsp/tools.ts`: `export { lsp_hover } from "./hover-tool"`
- `src/lsp/index.ts`: 导出 `lsp_hover`
- `src/index.ts`: 将 `lsp_hover` 加入返回的 `tool` 对象中。

### 6. 更新测试 (`test/lsp-tools.test.ts`)
- 添加针对 `lsp_hover` 的集成测试用例，断言能够成功获取 `greet` 函数的签名信息（如 `function greet(name: string): string`）。

### 7. 更新文档
- 在 `README.md` 和 `QUICKSTART.md` 的 LSP 工具列表中补充 `- lsp_hover: 获取符号的悬停提示信息（类型定义、文档注释等）`。

## 假设与决策
- **多态处理**：Hover 内容的格式因语言服务器而异，TypeScript LS 通常返回数组或 `MarkupContent`。我们会统一将它们用换行符（`\n\n`）拼接并进行 Markdown 兼容渲染。
- **缺失处理**：如果没有获取到 Hover 信息（返回 null），工具将返回 `"No hover information found"`，避免异常。

## 验证步骤
1. 执行 `bun test` 确保所有工具的测试（包括新增的 `lsp_hover`）均通过。
2. 执行 `bun run build` 确保 TypeScript 类型检查及构建无误。