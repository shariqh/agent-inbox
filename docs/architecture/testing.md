---
paths:
  - "test/**"
  - "vitest.config.ts"
applyTo: "test/**,vitest.config.ts"
---

# Testing and the DOM harness

Test conventions (real SQLite, `scratchDir()`, per-file environments) and what the jsdom harness can and cannot see.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- Store and viewer tests use real temporary SQLite databases through
  `openDb()`; do not mock the store. `test/mcp.integration.test.ts` performs a
  real stdio client/server round trip.
- Make scratch directories with `scratchDir()` from `test/scratch.ts`, never a
  bare `mkdtempSync` under `tmpdir()`, so repeated runs do not fill `$TMPDIR`
  (#240, #245). The `test/scratch-setup.ts` setupFile removes a file's leftovers
  when it ends; call `removeScratchDirs()` from `afterEach` as well when no
  directory is made in `beforeAll` or at module level. The one exception,
  `test/hook.test.ts`'s module-level project repository, is removed by that
  file's own `afterAll`.
- Node is the default Vitest environment. DOM tests opt in per file with
  `// @vitest-environment jsdom`; keep `test/dom/harness.ts` outside the
  `*.test.ts` naming pattern.
- The DOM harness imports the unmodified `public/app.js` module graph and bridges
  `fetch` to the real Hono app. Keep `publicDir: false` and the absolute-module
  alias in `vitest.config.ts`.
- In DOM fixtures, fake timers freeze `Date`; call `advanceClock()` between
  writes when ordering or timestamps matter. Assert rendered state rather than
  listener invocation counts because window/document listeners accumulate
  across repeated boots in one test file.
- jsdom cannot validate this project's media-query layer, unresolved CSS
  variables, silently dropped declarations, the affected `font` shorthand, or
  which of two competing rules wins when one is a selector list.
  Cover those cases with pure-JS behavior or source-level assertions instead of
  treating computed style as evidence.

## Invariants in detail

- **TDD.** Every change: failing test → red → implement → green. Tests use **real** temp
  SQLite DBs (`AGENT_INBOX_DB`/`scratchDir()`), never mock the store. The MCP test is a real
  spawn-the-server round-trip. *(#240, #245)* Scratch directories a test makes come
  from `scratchDir()` in `test/scratch.ts`, so repeated runs do not fill `$TMPDIR`: the
  `test/scratch-setup.ts` setupFile removes a file's leftovers once it ends, and a file whose
  tests are independent also calls `removeScratchDirs()` from `afterEach` (a directory made
  in `beforeAll` or at module level must wait for the file's end). The one exception is
  `test/hook.test.ts`'s module-level project repository: that file removes its scratch
  directories after every test, so it makes the repository with `mkdtempSync` and removes it
  in its own `afterAll`. Hook tests run in a git
  repository whose origin the test names, never the checkout itself, so a copy or fork
  under another name passes them too.
- **Test environments are per-file.** There is no global `test.environment`: the node suite
  (store, mcp, infer) stays on node and a DOM file opts in with a
  `// @vitest-environment jsdom` docblock. `test/dom/harness.ts` is deliberately NOT named
  `*.test.ts` so the `test/**/*.test.ts` glob imports it without collecting it.

## DOM harness — what it can and cannot see

`test/dom/` boots the **real** viewer frontend in jsdom: `test/dom/harness.ts` bridges
`globalThis.fetch` onto the real `createViewer(db)` Hono app over a real temp SQLite DB,
then imports `public/app.js` **unmodified** — top-level side effects and all.
`public/` and `src/` have a **zero-line diff** because of it; keep it that way.

- **jsdom cannot execute `<script type="module">`.** That is why the harness imports the
  module graph directly instead of mounting `public/index.html` and letting it run. Do not
  re-litigate this — it has already cost time twice.

- **`publicDir: false` in `vitest.config.ts` is mandatory.** Without it Vite claims
  `<root>/public` as its static publicDir and hard-errors on any import from it
  ("this file is in /public … can only be referenced via HTML tags"). The companion
  `resolve.alias` (`/^\/([\w.-]+\.js)$/` → `<repo>/public/$1`) is what makes the browser's
  absolute `/x.js` specifiers resolve. Neither touches a byte on disk: `public/` still has
  no build step, and the browser and Electron keep resolving `/x.js` from their own root.

- **Four globals must be stubbed or `render()` throws and `load()`'s catch swallows it** —
  which presents as "nothing rendered", not as an error: `window.uFuzzy` (vendored IIFE,
  constructed at app.js module top level, so it must exist BEFORE the import),
  `window.matchMedia` (3 call sites: `themeName`, `initResponsive`, `initProjectDisclosure`),
  `CSS.escape` (used throughout navigation and rendering), `Element.prototype.scrollIntoView`.
  The harness's **console.error guard is load-bearing**, not cosmetic — it is the only
  thing that turns a swallowed render throw back into a visible failure.

- **`new URL('…', import.meta.url)` does not work in a jsdom test file.** jsdom files run in
  Vite's WEB transform mode, where the asset plugin rewrites that literal pattern into
  `http://localhost:3000/@fs/…` and `readFileSync` dies with "The URL must be of scheme
  file". The rest of `test/` uses that form happily because those files run in the NODE
  environment. Resolve through `node:path` instead (`harness.ts` does).

- **Fake timers freeze `Date`,** so every row seeded inside one test shares one
  `created_at` unless you call the harness's `advanceClock()` between writes. That silently
  breaks `listItems`' `ORDER BY created_at DESC`, `buildDeck`'s sort and — worst —
  `seenWatermark`, whose whole job is comparing stamps. Item timestamps cannot be
  backdated through `store.ts`, so a staleness fixture moves the CLOCK, never the row.

- **Window/document listeners accumulate across boots within one file.**
  `vi.resetModules()` gives a fresh module instance but jsdom's window/document live for
  the whole file, so each boot adds another `hashchange`/`keydown`/`beforeunload` handler.
  Harness rule: **assert rendered state only, never handler-invocation counts.**

CSS: `getComputedStyle` over an attached `public/style.css` genuinely resolves specificity,
source order, `!important`, `:has()` and `color-mix()` — that is what makes the
`.answer-btn` geometry test in `test/dom/css-cascade.test.ts` catch the real 13819d2
regression. **Five verified blind spots; only literal lengths and keywords are trustworthy:**

1. **`@media` never matches.** jsdom's media-list evaluation only answers `all`/`screen`,
   so style.css's single width block, `@media (max-width: 1279px)` — the ENTIRE spec §14
   responsive layer — never applies, and neither does #302's
   `@media (prefers-reduced-motion: reduce)` block (source-pinned in `test/motion-css.test.ts`). Do not assert anything about it; cover the JS half instead
   (`setViewport('narrow')` + readable `railLabel` output, in `test/dom/boot.test.ts`) and
   source-pin compact geometry/container-query rules in `test/editorial-shell.test.ts`.

2. **`var()` is returned unresolved.**

3. **An unparseable declaration is dropped SILENTLY — and therefore reads as "correct".**
   `border: 1px solid color-mix(…)` comes back as `borderStyle: 'none'` /
   `borderTopWidth: 'medium'`, so asserting the `.row-expand { border: none }` half of the
   13819d2 bug would pass VACUOUSLY on the buggy sheet. This is the dangerous one.

4. **The `font:` shorthand clobbers a later longhand.** `.answer-btn` declares
   `font: inherit; … font-weight: 600` and jsdom computes `normal`.

5. **A selector list can outrank a later rule of equal specificity.** With
   `.a > b, .c > d { opacity: .6 }` before `.e > b { opacity: 1 }`, jsdom computes `.6` for
   an element both match, where browsers apply the later rule. When rules that compete for
   one element must be measured, make their selectors disjoint (#247's fold dimming does).

An overstated harness is worse than none. If an assertion falls in one of those five, it is
not evidence — delete it or move it to a source pin.
