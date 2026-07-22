# Viewer: paginated sections + global fuzzy search

**Date:** 2026-07-21
**Scope:** `public/` viewer only (plus one small testable module + tests). No store,
MCP, or server-route changes.

## Problem

The viewer's section lists grow unbounded. `renderGroups` (Needs you, Notes),
`renderDone`, `renderBoards`, and `renderArchived` each append **every** card to their
host, so a busy inbox becomes an endless scroll. There is also no way to find a specific
item or board other than the coarse project/agent pill filters.

## Goals

1. Cap each section to a page and reveal the rest via a "show more" button.
2. Add one global, typo-tolerant fuzzy search that filters items **and** boards across
   every section at once.

Non-goals: server-side pagination/search (data volume is small — dozens to low hundreds
of rows), re-ranking search results (filter-only), persisting page position across
reloads.

## Decisions (locked)

- **Page sizes:** Needs you = **10**; Notes, Tracking (boards), Done, Archived = **5**.
  "Show more" pages by the same size.
- **Search UI:** a single global search box in the header (`nav#filters`).
- **Fuzzy engine:** **uFuzzy**, vendored as a single IIFE file in `public/` — chosen for
  better results on natural multi-token, out-of-order, typo-tolerant queries than a
  hand-rolled matcher.
- **Verification:** extract the pure logic into a testable module with vitest coverage,
  plus browser verification of the wired-up UI.

## Ordering is already correct

`listItems` returns `created_at DESC` and `listBoards` returns `updated_at DESC`
(`src/store.ts`). The group buckets preserve that order. So "show the latest N" is simply
"render the first N" — no client-side sorting is introduced.

## Architecture

### New module: `public/search.js` (native ES module, no external imports)

Pure, dependency-free, browser-served **and** unit-tested. The fuzzy engine is **injected
as a parameter** so the module never imports uFuzzy — this keeps it testable in Node and
keeps uFuzzy a browser-only global.

Exports:

```js
// Lowercased searchable blob for one entity. Boards are detected by `'rows' in e`.
//   item  → title, detail, context, project, agent, stream, kind, annotation, reply
//   board → title, project, agent, stream + every row's label, note, context, annotation
export function haystackFor(entity) -> string

// entities: array of objects each with a stable `.id`.
// query: the raw search box value.
// filterFn: (haystack: string[], needle: string) => number[] | null   (uFuzzy.filter shape)
// Returns:
//   null            when query is empty/whitespace  → "no search active, show everything"
//   Set<id>         the ids whose haystack matched   (empty Set = query present, 0 matches)
export function searchMatches(entities, query, filterFn) -> Set<string> | null

// Flat list → first `limit`, plus how many are hidden.
export function paginate(items, limit) -> { visible: T[], remaining: number }

// Grouped list ([{ project, items }]) → groups truncated to a shared item budget of
// `limit`, walking groups in order, dropping groups that get zero items.
export function paginateGroups(groups, limit) -> { groups: {project,items}[], remaining: number }
```

`null` vs empty `Set` is the crucial distinction: **no query** shows all; **query with no
match** shows nothing (and a "No matches" empty state).

`public/search.d.ts` — hand-written declarations so the TS test and `npm run typecheck`
resolve the JS module cleanly (base tsconfig has no `allowJs`; a sibling `.d.ts` is the
standard vendored-JS pattern and lets tsc use the types while ignoring the `.js` body).

### Vendored engine: `public/ufuzzy.iife.min.js`

The upstream uFuzzy IIFE build, pinned to a specific version, committed to `public/` with
a one-line provenance header (source URL + version). Loaded via `<script>` **before**
`app.js` in `index.html`, exposing `window.uFuzzy`. No build step; served automatically by
`serveStatic({ root: './public' })`.

For tests only, `@leeoniya/ufuzzy` is added to `devDependencies` so one test can import the
real engine and confirm end-to-end fuzzy matching against our haystack (the browser still
uses the vendored IIFE — the two are the same library, different module format).

### `app.js` wiring

- `index.html`: add the search `<input id="search">` to `nav#filters`; add the two
  `<script>` tags (vendored uFuzzy, then `app.js`); flip `app.js` to
  `<script type="module">` so it can `import` from `/search.js`.
- New module-level state, mirroring the existing poll-surviving state
  (`openContexts`, `collapsedCards`, …):
  ```js
  const PAGE  = { needsYou: 10, notes: 5, done: 5, boards: 5, archived: 5 }
  let   shown = { ...PAGE }        // current visible count per section
  let   searchQuery = ''
  const uf = new window.uFuzzy({ intraMode: 1 })   // single-char typo tolerance
  const fuzzyFilter = (hay, needle) => uf.filter(hay, needle)
  ```
- Search input handler: update `searchQuery`, `resetPaging()`, `render()`. Light debounce
  (~120 ms) so typing stays smooth. `resetPaging()` sets `shown = { ...PAGE }`.
- The project/agent pill `onPick` handlers and the search handler both call
  `resetPaging()` so any filter change lands you on the top of the results.

### Render pipeline changes

Order of operations inside `render()`:

1. `filterData(lastData)` — existing project/agent pill filter (unchanged).
2. **New search step** — `applySearch({g, boards, archived}, matches)` where
   `matches = searchMatches(<all filtered entities>, searchQuery, fuzzyFilter)`. When
   `matches` is `null`, returns its input unchanged; otherwise keeps only entities whose id
   is in the set (grouped items filtered, emptied groups dropped — same shape logic as
   `filterData`). Search thus **composes (AND)** with the pills.
3. **Counts** (`setCount`) are computed from the post-search, pre-pagination set, so a badge
   reads the true number of matches ("Notes (3)"), independent of the page cap.
4. **Pagination** happens inside each render function via `shown[section]`:
   - `renderGroups` (needsYou, notes): `paginateGroups(groups, shown[section])`, render the
     truncated groups, then append a "show more" button when `remaining > 0`.
   - `renderDone` / `renderBoards` / `renderArchived`: `paginate(list, shown[section])`,
     render `visible`, append "show more" when `remaining > 0`.
   - `renderSub` (sidebar links) receives only the **visible** entries, so every sidebar
     link resolves to a rendered card.

### "Show more" button

Helper `moreButton(section, remaining)` → a button labelled
`Show N more` (N = `min(PAGE[section], remaining)`), with the full `remaining` count shown
alongside. Click: `shown[section] += PAGE[section]; render()`. Appended after the section's
list/groups host.

### Empty states

When a search is active and a section has zero matches, its host shows
`No matches for "<query>"` (escaped) instead of the current "Nothing here." / "No boards."
copy. No query → existing empty copy.

### Deliberately unaffected

- **`renderNow`** (the red "Needs you" attention strip) already ignores the pill filters by
  design — it reflects global state so an unanswered question is never hidden. It ignores
  the search box too: it keeps reading `lastData` unfiltered. No change.
- **Triage deck** (`buildDeck` / `renderTriage`) operates on the full needs-input set,
  independent of search/pagination. No change.
- **`escape`ing** — all new user-facing strings (the "No matches" message includes the
  query) go through the existing `esc()`, per the repo's XSS invariant.

## Testing

`test/search.test.ts` (TS, imports `../public/search.js`):

- `haystackFor` — item blob contains title/detail/project/agent/stream/annotation/reply;
  board blob contains title + every row's label/note; output is lowercased.
- `searchMatches` — returns `null` for `''` and whitespace; maps `filterFn` indices back to
  the right ids (injected deterministic `filterFn`); returns an **empty Set** (not `null`)
  when `filterFn` returns `null`/`[]`.
- One real-engine test importing `@leeoniya/ufuzzy` (devDep): a typo/out-of-order query
  (e.g. `"athu bord"`) matches a board whose haystack is "auth board …", proving the seam
  works with the actual engine.
- `paginate` — `visible` length and `remaining` for under/at/over the limit.
- `paginateGroups` — budget spent across multiple groups, last group truncated, emptied
  groups dropped, `remaining` correct; `remaining === 0` when everything fits.

Browser verification (`npm run view`): seed >10 items and >5 boards, confirm each section
caps at its page size, "show more" reveals the next page, counts stay full, and typed
fuzzy queries filter items + boards live with folds/counts updating.

`npm run typecheck` and `npm test` stay green.

## Files touched

- **new** `public/search.js` — pure logic (haystack, search-match mapping, pagination).
- **new** `public/search.d.ts` — declarations for the above.
- **new** `public/ufuzzy.iife.min.js` — vendored engine (pinned, provenance header).
- **new** `test/search.test.ts` — unit + one real-engine test.
- `public/index.html` — search input, script tags, `app.js` → module.
- `public/app.js` — search state, pagination state, `applySearch`, `resetPaging`,
  `moreButton`, and the per-section render changes.
- `package.json` — add `@leeoniya/ufuzzy` to `devDependencies` (test-only).

## Risks / notes

- `app.js` becoming a module is the only structural change to the existing file; it stays a
  single classic-feeling script otherwise. Verify no top-level code relied on non-module
  global timing.
- uFuzzy global must load before the `app.js` module reads `window.uFuzzy`; classic script
  tags execute before module scripts, so ordering is safe, but assert it in `index.html`.
