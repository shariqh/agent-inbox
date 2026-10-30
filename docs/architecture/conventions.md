---
paths:
  - "tsconfig*.json"
  - "package.json"
  - "src/**/*.ts"
  - "public/**/*.js"
  - "test/dead-exports.test.ts"
applyTo: "tsconfig*.json,package.json,src/**/*.ts,public/**/*.js,test/dead-exports.test.ts"
---

# Code conventions

TypeScript ESM rules, the build config, dependencies, the dead-export rule and workspace hygiene.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

`npm run build` must continue to use `tsconfig.build.json`: its `rootDir: "src"`
keeps entries such as `dist/mcp-server.js` flat. The base `tsconfig.json` includes
tests for typechecking and would emit an unwanted `dist/src/` tree.
Run the build before `npm run electron`; the development shell starts the built
`dist/viewer-server.js`.
- TypeScript is strict NodeNext ESM. Source imports use `.js` specifiers even
  when the imported file is `.ts`. `noUncheckedIndexedAccess` is enabled, so
  guard array and map lookups rather than weakening types.
- Keep `zod` as a direct dependency: `src/mcp.ts` uses it for MCP tool schemas.
- Every value export in `src/*.ts` and `public/*.js` must be reachable from
  production code. Tests are not consumers. `test/dead-exports.test.ts` enforces
  this; deliberate exceptions require the existing documented mechanisms.
- Workspace hygiene: the session that merges a PR or publishes a release removes
  its worktree (`git worktree remove`), local and remote branch, reviewer `/tmp`
  trees, release downloads and old `build/` outputs before reporting completion,
  and only after the checks in `docs/workspace-hygiene.md` pass. Never touch the
  live checkout's `dist/`/`node_modules`, `~/.agent-inbox` data, referenced
  runtimes, session state, or other sessions' work; keep and report instead.

## Invariants in detail

- Node 24, TS **ESM** (`"type":"module"`); **imports use `.js` specifiers** even for `.ts`
  sources (NodeNext). Keep this on new imports.
- Strict tsc, `noUncheckedIndexedAccess: true` — array access is `T | undefined`; use `!`/
  guards, keep `npm run typecheck` clean.
- `zod` is a **direct** dependency (used by `mcp.ts` for tool schemas) — keep it in
  `package.json`, don't rely on it resolving transitively via the SDK.
- Build emits via **`tsconfig.build.json`** (rootDir `src`, src-only) so `dist/mcp-server.js`
  is flat. The base `tsconfig.json` (src + test) is for typecheck only. Don't point `build`
  at the base config — it re-nests output under `dist/src/`.
- **Every value export in `public/*.js` AND `src/*.ts` must be reachable from code that
  ships.** Two ways, and nothing else counts: another production module IMPORTS it by name
  and uses that binding, or it is CALLED inside its own module and that module is itself
  imported (or is an entry point). A test is not a consumer: a helper only its own unit test
  calls looks load-bearing (typed, covered, named after a real concept) while shipping
  nothing. `test/dead-exports.test.ts` enforces it. The only deliberate exits are a
  `void X // why` marker at an importing call site (as `app.js` does for `paginateGroups`)
  or an entry in that file's `ALLOWED` map **with a written reason** — the map is the point:
  it turns a silent trap into a list someone has to justify.
  Four such helpers accumulated through the viewer rebuild; `listClosedProjects` (#32) was
  the fifth and got through because the guard's first draft asked only whether `\bNAME\b`
  occurred more than once across a concatenation of the consumer files — so any unrelated
  file containing the same word vouched for it, and `src/` was not scanned at all. **Keep
  the liveness test import-or-call.** Its discrimination is pinned on synthetic module trees
  in the same file (including the exact word-match hole), so a slide back into word-matching
  fails there rather than shipping a sixth. It is a scanner, not a tokenizer: cross-file
  liveness is import-only and airtight, but *within* the declaring file a bare occurrence
  counts however it got there (a local binding, an object key, template-literal text). That
  limit is written down at the `word()` helper — don't restate it more generously.
- **Workspace hygiene.** The session that merges a PR or publishes a release removes what it
  left behind before reporting the work complete: its worktree (`git worktree remove`, never
  `rm -rf`), local and remote branch, reviewers' `/tmp` trees, downloaded release assets and
  old `build/` outputs. Delete only after the clean and safety checks in
  [`docs/workspace-hygiene.md`](../../docs/workspace-hygiene.md) pass; otherwise keep and report.
  Never touch the live checkout's `dist/`/`node_modules`, `~/.agent-inbox` data, referenced
  runtimes (the installer prunes runtimes), session state, or other sessions' work.
