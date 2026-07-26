// test/hardening.test.ts
// Fix round 1 (security sweep + findings triage): two client-side hardening fixes to
// public/app.js, pinned as SOURCE TEXT the same way test/shell.test.ts does for
// load()'s catch behaviour — these assert WHICH construct the code uses, which a
// runtime assertion cannot distinguish. The jsdom harness added in test/dom/ covers
// the observable half (test/dom/toggle-row.test.ts drives the write path end to end).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

// Fix 2: changeAnswer() used to POST to /api/items/:id/reply and throw away the
// response. The server can legitimately refuse (src/store.ts's replyItem guard — an
// already-picked-up reply cannot be silently blanked), returning { ok: false }. Nothing
// read it: the human clicked "Change answer" (or Undo, once staged) and nothing
// happened, with zero explanation.
describe('changeAnswer surfaces a refused undo instead of silently doing nothing (fix 2)', () => {
  it('reads `ok` off the reply response and branches on refusal', () => {
    const m = js.match(/async function changeAnswer\([\s\S]*?\n\}/)
    expect(m, 'changeAnswer() not found').toBeTruthy()
    const body = m![0]
    expect(body).toMatch(/\.ok\b/)
    expect(body).toMatch(/if\s*\(\s*!res\.ok\s*\)/)
  })

  it('mirrors the row Undo flow\'s refusal copy (rowview.js undoRefusal) rather than a second phrasing', () => {
    const m = js.match(/async function changeAnswer\([\s\S]*?\n\}/)
    const body = m![0]
    expect(body).toMatch(/undoRefusal\(/)
  })

  it('does not fall through to load() on refusal, leaving the UI unchanged', () => {
    const m = js.match(/async function changeAnswer\([\s\S]*?\n\}/)
    const body = m![0]
    // the refusal branch must `return` before reaching the trailing load()
    const refusalBranch = body.match(/if\s*\(\s*!res\.ok\s*\)\s*\{([\s\S]*?)\n\s*\}/)
    expect(refusalBranch, 'no refusal branch found').toBeTruthy()
    expect(refusalBranch![1]).toMatch(/return/)
  })

  it('both call sites pass a target element for the refusal message — the card button its own slot, the row Undo its existing label', () => {
    expect(js).toMatch(/changeAnswer\(it,\s*msg\)/)
    expect(js).toMatch(/changeAnswer\(fresh,\s*label\)/)
  })
})

// Fix 3: every write-path fetch used to be a bare `await fetch(...)` with no try/catch
// — a network failure became an unhandled rejection: no console signal, no user
// feedback, and the optimistic UI may already have updated. A single shared helper
// (postJSON) is used everywhere instead of six bespoke try/catch blocks.
describe('every write-path fetch has a catch with a visible signal (fix 3)', () => {
  it('postJSON exists and its catch logs and sets a visible #status signal', () => {
    const m = js.match(/async function postJSON\([\s\S]*?\n\}/)
    expect(m, 'postJSON() not found').toBeTruthy()
    const body = m![0]
    expect(body).toMatch(/catch\s*\(\s*\w+\s*\)\s*\{/)
    const caught = body.match(/catch\s*\(\s*(\w+)\s*\)\s*\{([\s\S]*?)\n\s*\}\s*$/)
    expect(caught, 'no catch(err) { … } block found in postJSON').toBeTruthy()
    const [, errName, catchBody] = caught!
    expect(catchBody).toMatch(new RegExp(`console\\.error\\(.*${errName}`))
    expect(catchBody).toContain("'disconnected'")
    expect(catchBody).toMatch(/return null/)
  })

  it('no write-path call site is a bare unguarded `await fetch(` any more', () => {
    // load() (GET, already wrapped) and renderSetup() (GET, already wrapped) and
    // postJSON's own internal fetch are the only remaining `await fetch(` call sites.
    const bareFetchLines = js
      .split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /await fetch\(/.test(line))
    // every remaining bare `await fetch(` must be inside load(), renderSetup(), or postJSON
    for (const { line, i } of bareFetchLines) {
      const context = js.split('\n').slice(Math.max(0, i - 40), i).join('\n')
      const inKnownWrapped = /async function load\(\)/.test(context.split('\n').slice(-40).join('\n'))
        || /async function renderSetup\(\)/.test(context.split('\n').slice(-40).join('\n'))
        || /async function postJSON\(/.test(context.split('\n').slice(-10).join('\n'))
      expect(inKnownWrapped, `unexpected bare await fetch(: ${line}`).toBe(true)
    }
  })

  it('save(), sendReply(), act(), changeAnswer(), and the board annotate/archive/unarchive handlers all route through postJSON', () => {
    for (const marker of [
      /const save = async \(\) => \{[\s\S]*?postJSON\(/,
      /async function sendReply\([\s\S]*?postJSON\(/,
      /async function act\([\s\S]*?postJSON\(/,
      /async function changeAnswer\([\s\S]*?postJSON\(/,
    ]) expect(js, marker.toString()).toMatch(marker)
    // board row note (shared by the matrix and the triage card since Task 13),
    // the archived-board Un-archive handler, and the Archive-confirm button —
    // a per-function existence check rather than a whole-file occurrence count:
    // a count needs editing on every legitimate refactor of these call sites,
    // and each such edit is a chance to silently weaken the guard.
    const boardsApiPattern = /postJSON\(`\/api\/boards\//

    const rowAnswerEl = js.match(/function rowAnswerEl\([\s\S]*?\n\}/)
    expect(rowAnswerEl, 'rowAnswerEl is missing').toBeTruthy()
    expect(rowAnswerEl![0], 'rowAnswerEl does not call postJSON(').toMatch(boardsApiPattern)

    const unarchiveHandler = js.match(/btn\('Un-archive',[\s\S]*?\}\)\)/)
    expect(unarchiveHandler, 'the board Un-archive handler is missing').toBeTruthy()
    expect(unarchiveHandler![0], 'the Un-archive handler does not call postJSON(').toMatch(boardsApiPattern)

    const archiveBtnFn = js.match(/function archiveBtn\([\s\S]*?\n\}/)
    expect(archiveBtnFn, 'archiveBtn is missing').toBeTruthy()
    expect(archiveBtnFn![0], 'archiveBtn does not call postJSON(').toMatch(boardsApiPattern)
  })
})
