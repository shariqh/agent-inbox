# Viewer Pagination + Global Fuzzy Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap each viewer section to a page (Needs you 10, others 5) with a "show more" pager, and add one global typo-tolerant fuzzy search that filters items and boards across every section at once.

**Architecture:** Extract pure haystack/search/pagination logic into a new dependency-free ES module `public/search.js` (unit-tested; the fuzzy engine is injected as a callback so the module has no imports). The browser loads the vendored uFuzzy IIFE as `window.uFuzzy` and wires it into `public/app.js`, which becomes a module so it can import the helpers. No store, MCP, or server-route changes.

**Tech Stack:** Vanilla ES-module JS (`public/`), uFuzzy (vendored IIFE for the browser, `@leeoniya/ufuzzy` devDep for tests), Vitest, TypeScript (typecheck + tests only).

## Global Constraints

- **Node 24 only** — run `fnm use 24` before any `npm`/`npx`/`tsx` command in this repo (native `better-sqlite3` binding is built for Node 24).
- **No build step for the viewer** — `public/` is served as-is by `serveStatic({ root: './public' })`; never introduce a compile step for browser assets.
- **TS ESM, `.js` import specifiers** even for `.ts` sources (NodeNext). `npm run typecheck` (strict, `noUncheckedIndexedAccess`) and `npm test` must stay green.
- **Escape all agent-authored text** — any user-facing string built into `innerHTML` (including the search query in the "No matches" message) goes through the existing `esc()`.
- **Page sizes are exactly:** `needsYou: 10, notes: 5, done: 5, boards: 5, archived: 5`.
- **Commit messages** end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work happens on branch `feat/viewer-pagination-fuzzy-search` (already checked out).

---

### Task 1: Pure search + pagination module (`public/search.js`)

**Files:**
- Create: `public/search.js`
- Create: `public/search.d.ts`
- Create: `test/search.test.ts`
- Modify: `package.json` (add `@leeoniya/ufuzzy` to `devDependencies`)

**Interfaces:**
- Produces:
  - `haystackFor(entity): string` — lowercased searchable blob. Board detected by `Array.isArray(entity.rows)`.
  - `searchMatches(entities, query, filterFn): Set<string> | null` — `null` when query is empty/whitespace; else a Set of matching `entity.id` (empty Set when `filterFn` returns `null`/`[]`). `filterFn: (haystack: string[], needle: string) => number[] | null` (uFuzzy's `.filter` shape).
  - `paginate(items, limit): { visible, remaining }`.
  - `paginateGroups(groups, limit): { groups, remaining }` — groups are `{ project, items }`; walks in order spending a shared item budget, drops emptied groups.

- [ ] **Step 1: Write the failing test**

Create `test/search.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import uFuzzy from '@leeoniya/ufuzzy'
import { haystackFor, searchMatches, paginate, paginateGroups } from '../public/search.js'

describe('haystackFor', () => {
  it('includes item fields, lowercased', () => {
    const h = haystackFor({ id: '1', title: 'Fix Auth', detail: 'JWT bug', project: 'API', agent: 'claude', reply: 'go ahead' })
    expect(h).toBe('fix auth api claude jwt bug go ahead')
  })
  it('includes board row text and is lowercased', () => {
    const h = haystackFor({ id: 'b1', title: 'Rollout', project: 'Web', rows: [{ label: 'Deploy', note: 'Staging first' }] })
    expect(h).toContain('deploy')
    expect(h).toContain('staging first')
    expect(h).toContain('rollout')
    expect(h).toBe(h.toLowerCase())
  })
})

describe('searchMatches', () => {
  const ents = [{ id: 'a', title: 'alpha' }, { id: 'b', title: 'beta' }, { id: 'c', title: 'gamma' }]
  it('returns null for empty/whitespace query', () => {
    expect(searchMatches(ents, '', () => [])).toBeNull()
    expect(searchMatches(ents, '   ', () => [])).toBeNull()
  })
  it('maps filter indices back to ids', () => {
    expect(searchMatches(ents, 'x', () => [0, 2])).toEqual(new Set(['a', 'c']))
  })
  it('returns an empty Set (not null) when the filter finds nothing', () => {
    expect(searchMatches(ents, 'x', () => null)).toEqual(new Set())
    expect(searchMatches(ents, 'x', () => [])).toEqual(new Set())
  })
  it('works end-to-end with the real uFuzzy engine', () => {
    const uf = new uFuzzy({ intraMode: 1 })
    const rows = [
      { id: 'x', title: 'Auth board', project: 'api' },
      { id: 'y', title: 'Billing rollout', project: 'web' },
    ]
    const set = searchMatches(rows, 'auth', (hay, needle) => uf.filter(hay, needle))
    expect(set.has('x')).toBe(true)
    expect(set.has('y')).toBe(false)
  })
})

describe('paginate', () => {
  it('slices to the limit and reports the remainder', () => {
    expect(paginate([1, 2, 3, 4, 5], 3)).toEqual({ visible: [1, 2, 3], remaining: 2 })
  })
  it('remaining is 0 when under the limit', () => {
    expect(paginate([1, 2], 5)).toEqual({ visible: [1, 2], remaining: 0 })
  })
})

describe('paginateGroups', () => {
  const groups = [
    { project: 'a', items: [1, 2, 3] },
    { project: 'b', items: [4, 5] },
    { project: 'c', items: [6] },
  ]
  it('spends the budget across groups and truncates the last', () => {
    const r = paginateGroups(groups, 4)
    expect(r.groups).toEqual([{ project: 'a', items: [1, 2, 3] }, { project: 'b', items: [4] }])
    expect(r.remaining).toBe(2)
  })
  it('drops groups past the budget', () => {
    const r = paginateGroups(groups, 3)
    expect(r.groups).toEqual([{ project: 'a', items: [1, 2, 3] }])
    expect(r.remaining).toBe(3)
  })
  it('remaining is 0 when everything fits', () => {
    expect(paginateGroups(groups, 10).remaining).toBe(0)
  })
})
```

- [ ] **Step 2: Add the devDependency the test imports**

Run:
```bash
fnm use 24 && npm install --save-dev @leeoniya/ufuzzy
```
Expected: `@leeoniya/ufuzzy` appears in `package.json` `devDependencies`; `package-lock.json` updated. (Verify `better-sqlite3` still loads: `npm run typecheck` in a later step will confirm.)

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
fnm use 24 && npx vitest run test/search.test.ts
```
Expected: FAIL — `Failed to resolve import "../public/search.js"` (module not created yet).

- [ ] **Step 4: Write the module**

Create `public/search.js`:

```js
// Pure search + pagination helpers for the viewer.
// No external imports: the fuzzy engine is injected as `filterFn`, so this
// module stays dependency-free and unit-testable in Node. The browser passes
// in window.uFuzzy's .filter; tests pass a stub or the real engine.

// One lowercased searchable string for an entity. Boards carry `.rows`; items
// do not — that is how the two shapes are told apart.
export function haystackFor(entity) {
  const parts = [entity.title, entity.project, entity.agent, entity.stream]
  if (Array.isArray(entity.rows)) {
    for (const r of entity.rows) parts.push(r.label, r.note, r.context, r.annotation)
  } else {
    parts.push(entity.detail, entity.context, entity.kind, entity.annotation, entity.reply)
  }
  return parts.filter(Boolean).join(' ').toLowerCase()
}

// Map a fuzzy filter over entities. null = no query (show everything); a Set of
// matching ids otherwise (empty Set = query present but nothing matched).
export function searchMatches(entities, query, filterFn) {
  const needle = (query ?? '').trim()
  if (!needle) return null
  const haystack = entities.map(haystackFor)
  const idxs = filterFn(haystack, needle)
  const ids = new Set()
  if (idxs) for (const i of idxs) { const e = entities[i]; if (e) ids.add(e.id) }
  return ids
}

// Flat list → first `limit` items plus how many remain hidden.
export function paginate(items, limit) {
  return { visible: items.slice(0, limit), remaining: Math.max(0, items.length - limit) }
}

// Grouped list ([{ project, items }]) → groups truncated to a shared item
// budget of `limit`, walking in order and dropping groups that get nothing.
export function paginateGroups(groups, limit) {
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const out = []
  let budget = Math.max(0, limit)
  for (const g of groups) {
    if (budget <= 0) break
    const items = g.items.slice(0, budget)
    if (items.length === 0) continue
    out.push({ ...g, items })
    budget -= items.length
  }
  return { groups: out, remaining: Math.max(0, total - limit) }
}
```

Create `public/search.d.ts` (so the TS test and `npm run typecheck` resolve the JS module cleanly — base tsconfig has no `allowJs`, so a sibling `.d.ts` is required):

```ts
export interface HaystackEntity {
  id: string
  title?: string
  project?: string
  agent?: string
  stream?: string
  detail?: string
  context?: string
  kind?: string
  annotation?: string
  reply?: string
  rows?: Array<{ label?: string; note?: string; context?: string; annotation?: string }>
}

export function haystackFor(entity: HaystackEntity): string
export function searchMatches(
  entities: HaystackEntity[],
  query: string,
  filterFn: (haystack: string[], needle: string) => number[] | null,
): Set<string> | null
export function paginate<T>(items: T[], limit: number): { visible: T[]; remaining: number }
export function paginateGroups<G extends { items: unknown[] }>(
  groups: G[],
  limit: number,
): { groups: G[]; remaining: number }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
fnm use 24 && npx vitest run test/search.test.ts
```
Expected: PASS — all cases green, including the real-uFuzzy case.

- [ ] **Step 6: Verify typecheck and the full suite are green**

Run:
```bash
fnm use 24 && npm run typecheck && npm test
```
Expected: `tsc --noEmit` clean; full vitest suite passes.

- [ ] **Step 7: Commit**

```bash
git add public/search.js public/search.d.ts test/search.test.ts package.json package-lock.json
git commit -m "feat(viewer): pure search + pagination module

Dependency-free public/search.js (haystackFor, searchMatches, paginate,
paginateGroups) with the fuzzy engine injected as a callback, plus unit tests
covering the null/empty-Set search contract, index→id mapping, group-budget
pagination, and one real-uFuzzy end-to-end case.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pagination wiring in the viewer (caps + "show more")

**Files:**
- Modify: `public/index.html` (turn `app.js` into a module script)
- Modify: `public/app.js` (import helpers; add page state; paginate each section; reset paging on pill change)
- Modify: `public/style.css` (a `.show-more` button style)

**Interfaces:**
- Consumes: `paginate`, `paginateGroups` from `public/search.js` (Task 1).
- Produces: module-level `PAGE`, `shown`, `resetPaging()`, `moreButton(section, remaining)` used by Task 3.

- [ ] **Step 1: Make `app.js` a module script**

In `public/index.html`, change the script tag near the end from:
```html
  <script src="/app.js"></script>
```
to:
```html
  <script type="module" src="/app.js"></script>
```

- [ ] **Step 2: Add the import and page state at the top of `app.js`**

At the very top of `public/app.js` (above `let lastData = null`), add:
```js
import { paginate, paginateGroups } from '/search.js'

// per-section visible-card caps; `shown` grows as the user clicks "show more"
const PAGE = { needsYou: 10, notes: 5, done: 5, boards: 5, archived: 5 }
let shown = { ...PAGE }
function resetPaging() { shown = { ...PAGE } }
```

- [ ] **Step 3: Add the `moreButton` helper**

In `public/app.js`, immediately after the existing `btn` function (`function btn(label, onClick) { … }`), add:
```js
// the pager at the foot of a capped section — reveals PAGE[section] more cards
function moreButton(section, remaining) {
  const n = Math.min(PAGE[section], remaining)
  const b = btn(`Show ${n} more (${remaining} hidden)`, () => { shown[section] += PAGE[section]; render() })
  b.className = 'show-more'
  return b
}
```

- [ ] **Step 4: Paginate the grouped sections (`renderGroups`)**

Replace the whole `renderGroups` function in `public/app.js` with:
```js
function renderGroups(sectionId, groups) {
  const host = document.querySelector(`#${sectionId} .groups`)
  const { groups: page, remaining } = paginateGroups(groups, shown[sectionId])
  host.innerHTML = groups.length ? '' : '<p class="empty">Nothing here.</p>'
  for (const grp of page) {
    const box = document.createElement('div')
    box.className = 'project'
    box.innerHTML = `<h3>${esc(grp.project)}</h3>`
    const byAgent = new Map()
    for (const it of grp.items) {
      const arr = byAgent.get(it.agent) ?? []
      arr.push(it)
      byAgent.set(it.agent, arr)
    }
    if (byAgent.size > 1) {
      for (const [agent, items] of byAgent) {
        const head = document.createElement('h4')
        head.className = 'agent-head'
        head.textContent = agent
        box.appendChild(head)
        for (const it of items) box.appendChild(itemEl(it, false, true))
      }
    } else {
      for (const it of grp.items) box.appendChild(itemEl(it))
    }
    host.appendChild(box)
  }
  if (remaining > 0) host.appendChild(moreButton(sectionId, remaining))
  renderSub(sectionId, page.flatMap((g) => g.items.map((it) => ({ id: it.id, label: it.title }))))
}
```

- [ ] **Step 5: Paginate `renderDone`**

Replace `renderDone` with:
```js
function renderDone(items) {
  const host = document.querySelector('#done .items')
  const { visible, remaining } = paginate(items, shown.done)
  host.innerHTML = items.length ? '' : '<p class="empty">Nothing yet.</p>'
  for (const it of visible) host.appendChild(itemEl(it, it.status !== 'open'))
  if (remaining > 0) host.appendChild(moreButton('done', remaining))
  renderSub('done', visible.map((it) => ({ id: it.id, label: it.title })))
}
```

- [ ] **Step 6: Paginate `renderBoards` and `renderArchived`**

Replace `renderBoards` with:
```js
function renderBoards(boards) {
  const host = document.querySelector('#boards .boards')
  const { visible, remaining } = paginate(boards, shown.boards)
  host.innerHTML = boards.length ? '' : '<p class="empty">No boards.</p>'
  for (const b of visible) host.appendChild(boardEl(b))
  if (remaining > 0) host.appendChild(moreButton('boards', remaining))
  renderSub('boards', visible.map((b) => ({ id: b.id, label: b.title })))
}
```

Replace `renderArchived` with:
```js
function renderArchived(boards) {
  const host = document.querySelector('#archived .boards')
  const { visible, remaining } = paginate(boards, shown.archived)
  host.innerHTML = boards.length ? '' : '<p class="empty">Nothing archived.</p>'
  for (const b of visible) host.appendChild(boardEl(b, true))
  if (remaining > 0) host.appendChild(moreButton('archived', remaining))
  renderSub('archived', visible.map((b) => ({ id: b.id, label: b.title })))
}
```

- [ ] **Step 7: Reset paging when a pill filter changes**

In `render()`, inside the two `renderPills` callbacks, add `resetPaging()` before the `render()` call. Change the project callback body from:
```js
    projectFilter = v
    if (v) localStorage.setItem(PROJECT_KEY, v)
    else localStorage.removeItem(PROJECT_KEY)
    render()
```
to:
```js
    projectFilter = v
    if (v) localStorage.setItem(PROJECT_KEY, v)
    else localStorage.removeItem(PROJECT_KEY)
    resetPaging()
    render()
```
And the agent callback from:
```js
    agentFilter = v
    if (v) localStorage.setItem(FILTER_KEY, v)
    else localStorage.removeItem(FILTER_KEY)
    render()
```
to:
```js
    agentFilter = v
    if (v) localStorage.setItem(FILTER_KEY, v)
    else localStorage.removeItem(FILTER_KEY)
    resetPaging()
    render()
```

- [ ] **Step 8: Style the "show more" button**

Append to `public/style.css`:
```css
.show-more {
  display: block;
  width: 100%;
  margin: 8px 0 4px;
  padding: 8px;
  background: transparent;
  border: 1px dashed var(--border, #3a3a3a);
  border-radius: 6px;
  color: var(--muted, #9aa0a6);
  cursor: pointer;
  font-size: 13px;
}
.show-more:hover { color: var(--fg, #e8e8e8); border-color: var(--muted, #9aa0a6); }
```
(If those CSS variables are not defined in this file, substitute the literal colors already used by other buttons in `style.css` — match the existing button palette.)

- [ ] **Step 9: Seed demo data for browser verification**

Create `seed-demo.mjs` in the repo root (a throwaway verification scaffold — do NOT commit it):
```js
import { openDb, insertItem, upsertBoard, resolveItem } from './src/store.js'

const db = openDb(process.env.AGENT_INBOX_DB)
const projects = ['api', 'web', 'infra']
const topics = ['auth', 'billing', 'deploy', 'cache', 'search']

const noteIds = []
for (let i = 0; i < 13; i++) {
  insertItem(db, { project: projects[i % 3], stream: 'main', agent: 'claude',
    kind: 'question', title: `Question ${i} — ${topics[i % 5]} decision`, detail: `needs a call on ${topics[i % 5]}` })
}
for (let i = 0; i < 8; i++) {
  noteIds.push(insertItem(db, { project: projects[i % 3], stream: 'main', agent: 'claude',
    kind: 'note', title: `Note ${i} — ${topics[i % 5]} caveat`, detail: `heads up about ${topics[i % 5]}` }))
}
for (let k = 0; k < 6; k++) resolveItem(db, noteIds[k]) // populate Done (>5)
for (let b = 0; b < 8; b++) {
  upsertBoard(db, { project: projects[b % 3], stream: 'main', agent: 'claude',
    title: `Board ${b} — ${['rollout', 'migration', 'qa', 'audit'][b % 4]}`,
    rows: [
      { label: `Deploy step ${b}`, status: 'done', note: 'shipped to staging' },
      { label: `Verify ${b}`, status: 'tracked', note: `pending ${topics[b % 5]} checks` },
    ] })
}
console.log('seeded', process.env.AGENT_INBOX_DB)
```
Run it against a throwaway DB and launch the viewer on it:
```bash
fnm use 24 && AGENT_INBOX_DB=/tmp/inbox-demo.db npx tsx seed-demo.mjs
AGENT_INBOX_DB=/tmp/inbox-demo.db npm run view
```
Expected console: `seeded /tmp/inbox-demo.db`, then the viewer serving on `http://localhost:4319`.

- [ ] **Step 10: Verify pagination in the browser**

Open `http://localhost:4319`. Confirm:
- **Needs you** shows 10 question cards + a "Show 3 more (3 hidden)" pager; clicking reveals the rest and the pager disappears.
- **Notes** shows 2 (8 seeded − 6 resolved) — under the cap, so **no** pager. (To see the Notes pager, temporarily lower `resolveItem` count to 1 in the seed and re-run.)
- **Done** shows 5 + a "Show 1 more" pager (6 resolved).
- **Tracking** shows 5 boards + a "Show 3 more" pager.
- Section count badges show the **full** totals (e.g. "Tracking (8)"), not the capped 5.
- Switching a project pill resets every section back to its first page.
- No console errors (module loaded, imports resolved).

Stop the viewer (Ctrl-C) when done. Leave `/tmp/inbox-demo.db` and `seed-demo.mjs` in place for Task 3.

- [ ] **Step 11: Confirm the suite still passes, then commit**

Run:
```bash
fnm use 24 && npm run typecheck && npm test
```
Expected: green (no automated tests changed; this confirms nothing regressed).

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat(viewer): cap sections with a show-more pager

Needs you caps at 10, Notes/Done/Tracking/Archived at 5, each with a
show-more button that pages by the same size. app.js becomes a module to
import paginate/paginateGroups; count badges keep full totals; changing a
project/agent pill resets paging to the first page.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Global fuzzy search wiring

**Files:**
- Create: `public/ufuzzy.iife.min.js` (vendored engine, copied from the Task 1 devDep)
- Modify: `public/index.html` (search input + vendored script tag)
- Modify: `public/app.js` (import `searchMatches`; uFuzzy instance; `applySearch`; search-aware empty text; reset paging on input)
- Modify: `public/style.css` (search input style)

**Interfaces:**
- Consumes: `searchMatches` from `public/search.js` (Task 1); `resetPaging`, `render`, `allItems`, `esc`, `filterData` (existing in `app.js`); `window.uFuzzy` (vendored global).

- [ ] **Step 1: Vendor the uFuzzy IIFE into `public/`**

Confirm the dist filename, then copy it with a provenance header:
```bash
ls node_modules/@leeoniya/ufuzzy/dist/
node -p "require('./node_modules/@leeoniya/ufuzzy/package.json').version"
```
Expected: a file named `uFuzzy.iife.min.js` in that dir; a version like `1.0.x`. Then:
```bash
{ echo "/* Vendored uFuzzy v$(node -p "require('./node_modules/@leeoniya/ufuzzy/package.json').version") — https://github.com/leeoniya/uFuzzy (MIT). Do not edit; re-copy from node_modules to update. */"; cat node_modules/@leeoniya/ufuzzy/dist/uFuzzy.iife.min.js; } > public/ufuzzy.iife.min.js
```
Verify it defines the global:
```bash
grep -c "uFuzzy" public/ufuzzy.iife.min.js
```
Expected: a non-zero count. (If the dist filename differs, use the actual `*.iife.min.js` name printed by `ls`.)

- [ ] **Step 2: Add the search box and vendored script to `index.html`**

In `public/index.html`, add the search input inside `nav#filters` (after the three `<div class="tabs">` lines, before `</nav>`):
```html
      <input id="search" class="search-box" type="search" placeholder="Search everything…" aria-label="Search items and boards" autocomplete="off" />
```
And load the vendored engine **before** the app module (change the script block at the end of `<body>` to):
```html
  <script src="/ufuzzy.iife.min.js"></script>
  <script type="module" src="/app.js"></script>
```

- [ ] **Step 3: Add the search import, engine, and state to `app.js`**

At the top of `public/app.js`, extend the import line and add search state. Change:
```js
import { paginate, paginateGroups } from '/search.js'
```
to:
```js
import { paginate, paginateGroups, searchMatches } from '/search.js'

// typo-tolerant fuzzy filtering; the engine is a vendored browser global
const uf = new window.uFuzzy({ intraMode: 1 })
const fuzzyFilter = (hay, needle) => uf.filter(hay, needle)
let searchQuery = ''
```

- [ ] **Step 4: Add `applySearch` and a search-aware empty message**

In `public/app.js`, add these two helpers next to `filterData`:
```js
// narrow the pill-filtered data to the fuzzy-search matches (composes AND with
// the project/agent pills). No query → returned unchanged.
function applySearch({ g, boards, archived }) {
  const matches = searchMatches([...allItems(g), ...boards, ...archived], searchQuery, fuzzyFilter)
  if (!matches) return { g, boards, archived }
  const keep = (x) => matches.has(x.id)
  const only = (groups) => groups
    .map((gr) => ({ ...gr, items: gr.items.filter(keep) }))
    .filter((gr) => gr.items.length > 0)
  return {
    g: { needsYou: only(g.needsYou), notes: only(g.notes), done: g.done.filter(keep) },
    boards: boards.filter(keep),
    archived: archived.filter(keep),
  }
}

// section empty-state text: search-aware when a query is active
function emptyMsg(base) {
  const q = searchQuery.trim()
  return q ? `No matches for &ldquo;${esc(q)}&rdquo;` : base
}
```

- [ ] **Step 5: Route the render pipeline through `applySearch`**

In `render()`, change:
```js
  const { g, boards, archived } = filterData(lastData)
```
to:
```js
  const { g, boards, archived } = applySearch(filterData(lastData))
```
(Everything downstream — `setCount`, `renderGroups`, `renderBoards`, etc. — now sees the searched set, so count badges reflect match totals automatically.)

- [ ] **Step 6: Use the search-aware empty text in each section**

In `public/app.js`, update the four empty-state strings to call `emptyMsg`:
- In `renderGroups`: `host.innerHTML = groups.length ? '' : `<p class="empty">${emptyMsg('Nothing here.')}</p>``
- In `renderDone`: `host.innerHTML = items.length ? '' : `<p class="empty">${emptyMsg('Nothing yet.')}</p>``
- In `renderBoards`: `host.innerHTML = boards.length ? '' : `<p class="empty">${emptyMsg('No boards.')}</p>``
- In `renderArchived`: `host.innerHTML = boards.length ? '' : `<p class="empty">${emptyMsg('Nothing archived.')}</p>``

(Note these use template literals with backticks — replace the existing single-quoted string assignments exactly.)

- [ ] **Step 7: Wire the search input (debounced) and init it**

In `public/app.js`, add an init function next to `initSections`:
```js
function initSearch() {
  const input = document.getElementById('search')
  let t = null
  input.addEventListener('input', () => {
    clearTimeout(t)
    t = setTimeout(() => { searchQuery = input.value; resetPaging(); render() }, 120)
  })
}
```
And call it in the bottom init block. Change:
```js
initSections()
initTriage()
renderSetup()
load()
```
to:
```js
initSections()
initTriage()
initSearch()
renderSetup()
load()
```

- [ ] **Step 8: Style the search box**

Append to `public/style.css`:
```css
.search-box {
  min-width: 220px;
  padding: 6px 10px;
  background: var(--panel, #1a1a1a);
  border: 1px solid var(--border, #3a3a3a);
  border-radius: 6px;
  color: var(--fg, #e8e8e8);
  font-size: 13px;
}
.search-box::placeholder { color: var(--muted, #9aa0a6); }
.search-box:focus { outline: none; border-color: var(--accent, #4a9eff); }
```
(If these variables are not defined in `style.css`, match the literal colors the existing filter pills/header use.)

- [ ] **Step 9: Verify search in the browser**

Relaunch the viewer on the demo DB seeded in Task 2:
```bash
AGENT_INBOX_DB=/tmp/inbox-demo.db npm run view
```
Open `http://localhost:4319`. Confirm:
- Typing `auth` narrows **every** section live to auth-related items/boards; count badges drop to the match counts; pagers recompute against matches.
- A fuzzy/typo query (e.g. `atuh`, `billin`, `rollout`) still matches — proves uFuzzy typo tolerance and that board rows/notes are searched (e.g. `staging` matches boards via row notes).
- A no-match query (e.g. `zzzzz`) shows `No matches for "zzzzz"` in each section (properly escaped).
- Clearing the box restores everything and resets each section to its first page.
- Search composes with the project pills (pick a project, then search — results stay within that project).
- No console errors; `window.uFuzzy` loaded before the module.

Stop the viewer, then clean up the scaffold:
```bash
rm -f seed-demo.mjs /tmp/inbox-demo.db
```

- [ ] **Step 10: Final suite check, then commit**

Run:
```bash
fnm use 24 && npm run typecheck && npm test
```
Expected: green.

```bash
git add public/ufuzzy.iife.min.js public/index.html public/app.js public/style.css
git commit -m "feat(viewer): global fuzzy search across items and boards

One header search box powered by vendored uFuzzy (typo-tolerant, multi-token)
filters items and boards across every section at once, composing with the
project/agent pills and resetting paging to the first page on each keystroke.
Empty sections show a search-aware 'No matches' message.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Page sizes 10/5/5/5/5 → Task 2 `PAGE`. ✓
- Show-more pager → Task 2 `moreButton` + per-section wiring. ✓
- Latest-first (no client sort) → relies on store order; no sort added. ✓
- Global search box in header → Task 3 Steps 2, 8. ✓
- uFuzzy vendored IIFE + `intraMode:1` → Task 3 Steps 1, 3. ✓
- `searchMatches` null/empty-Set contract + haystack fields → Task 1. ✓
- Compose AND with pills → Task 3 `applySearch`. ✓
- Counts = full match totals (pre-pagination) → Task 3 Step 5 note. ✓
- Sidebar sub-links reflect visible set → Task 2 `renderSub(..., page/visible ...)`. ✓
- Search-aware empty states, escaped → Task 3 `emptyMsg`. ✓
- `renderNow` / triage untouched → not modified in any task. ✓
- Test module + one real-engine test → Task 1. ✓
- `@leeoniya/ufuzzy` test-only devDep → Task 1 Step 2. ✓
- `public/search.d.ts` for typecheck → Task 1 Step 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. The only conditional ("if CSS variables aren't defined, use literal colors") is a concrete fallback instruction, not a placeholder. ✓

**Type/name consistency:** `PAGE`/`shown`/`resetPaging`/`moreButton` defined in Task 2, consumed in Tasks 2–3. `paginate`/`paginateGroups`/`searchMatches`/`haystackFor` names match between `search.js`, `search.d.ts`, the test, and `app.js` imports. `applySearch`/`emptyMsg`/`fuzzyFilter`/`searchQuery` all defined and used in Task 3. Section keys (`needsYou`,`notes`,`done`,`boards`,`archived`) match `PAGE` keys and the `#section .host` selectors. ✓
