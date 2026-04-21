# Repository Guidelines

## Project Structure & Module Organization
Core source code is in `src/`, split by capability:
- `src/ast-grep/`: AST-aware search/replace tooling.
- `src/lsp/`: LSP client, server bootstrap, and language tooling.
- `src/shared/`: shared helpers (logging, plugin context, downloader utilities).

Tests live in `test/` and mirror major features (for example, `lsp-tools.test.ts`, `ast-grep-tools.test.ts`). Build output and type declarations are generated into `dist/` and should not be edited manually.

## Build, Test, and Development Commands
- `bun install`: install dependencies.
- `bun run build`: bundle `src/index.ts` to `dist/` and emit `.d.ts` files.
- `bun test`: run all tests in `test/` using Bun’s test runner.
- `bun run clean`: remove `dist/`.

Typical local loop:
```bash
bun install
bun run build
bun test
```

## Coding Style & Naming Conventions
This project is TypeScript-first with ESM modules and `strict` type checking enabled in `tsconfig.json`.
- Indentation: 2 spaces.
- Strings: prefer double quotes (as used across `src/` and `test/`).
- File names: kebab-case for modules (for example, `find-references-tool.ts`).
- Exports/tool IDs: keep existing naming patterns (`lsp_*`, `ast_grep_*`) for consistency.

There is currently no dedicated lint script; keep style aligned with surrounding code and ensure `bun run build` succeeds.

## Testing Guidelines
Use Bun test APIs from `bun:test` (`describe`, `it`, `expect`).  
Test files follow `*.test.ts` in `test/`, usually grouped by feature.  
Prefer integration-style tests that exercise real tool behavior (see `test/lsp-tools.test.ts`).

Before opening a PR, run:
```bash
bun test
bun run build
```

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit style, including scoped commits (for example, `feat(lsp): ...`).
- Use prefixes like `feat:`, `fix:`, `refactor:`, `test:`, `docs:`.
- Keep commits focused and atomic.

PRs should include:
- A short description of behavioral changes.
- Linked issue/task (if available).
- Notes on test coverage or manual verification.
- Example output/snippets when changing tool-facing behavior.
