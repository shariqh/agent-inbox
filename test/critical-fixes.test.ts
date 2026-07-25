// test/critical-fixes.test.ts
// Fix round 2 (final whole-branch review): the four CRITICAL findings in
// public/app.js. There is still no jsdom in vitest.config.ts (see the note at the
// top of test/shell.test.ts and test/hardening.test.ts), so the wiring that can
// only be observed through a real render()/click is pinned as SOURCE TEXT here.
// The parts that could be lifted into pure functions were: reconcileOpenRow
// (test/poll.test.ts), seenWatermark (test/notes.test.ts), repliedEntries
// (test/rowview.test.ts) and isAskingQuestion (test/attention.test.ts) carry real
// behavioural coverage; this file pins that app.js actually calls them.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

const fn = (name: string, endMarker: string) => {
  const start = js.indexOf(name)
  expect(start, `${name} not found in public/app.js`).toBeGreaterThan(-1)
  const end = js.indexOf(endMarker, start)
  expect(end, `end marker ${endMarker} not found after ${name}`).toBeGreaterThan(-1)
  return js.slice(start, end)
}

// ── C1: a deep link to a board permanently froze the viewer ─────────────────
// focusItem() ended with an unconditional setOpenRow(id). openRowId is cleared
// only by toggleRow, which is reachable only from a `.nrow` element — and a
// board id (electron/main.cjs deep-links blocked rows with focusHashFor(board.id))
// or a notes/done item id has none. shouldSuspendRender() then stayed true
// forever: load() kept updating lastData while the DOM, all four tab counts and
// document.title froze, with Escape's `collapse` intent a no-op.
describe('C1 · focusItem only claims the accordion for a row that exists (layer 1)', () => {
  const body = fn('function focusItem(', '\nlet bootFocusDone')

  it('guards setOpenRow behind a rendered Needs-you row lookup', () => {
    expect(body).toMatch(/needsYouRowEl\(id\)[\s\S]*setOpenRow\(id\)/)
    // the old unconditional statement must be gone
    expect(body).not.toMatch(/^\s*setOpenRow\(id\)\s*(\/\/.*)?$/m)
  })

  it('looks the row up in the Needs-you list specifically, not any [data-card-id]', () => {
    const helper = fn('function needsYouRowEl(', '\n}')
    expect(helper).toMatch(/#needsYouList\s+\.nrow\[data-card-id/)
  })
})

describe('C1 · render() reconciles openRowId against what it actually rendered (layer 2)', () => {
  const body = fn('function render()', '\n// one age vocabulary')

  it('render() runs the reconciliation', () => {
    expect(body).toMatch(/reconcileOpenRow\(/)
  })

  it('the reconciliation is the pure, unit-tested one from poll.js, not a local re-implementation', () => {
    expect(js).toMatch(/import\s*\{[^}]*reconcileOpenRow[^}]*\}\s*from\s*'\/poll\.js'/)
  })

  it('writes the reconciled value through setOpenRow, which stays the single writer of openRowId', () => {
    expect(body).toMatch(/setOpenRow\(nextOpen,\s*\{\s*resume:\s*false\s*\}\)/)
    // and never re-enters render() from inside render() to do it
    expect(fn('function setOpenRow(', '\nfunction orderedIds')).toMatch(/if \(resume\) resumeRender\(\)/)
  })
})

// ── C2: a refused "Change answer" left an unclearable draft → the same freeze ─
// changeAnswer() wrote draftReplies[it.id] BEFORE the POST. On refusal the item
// is still answered, so cardSections.showAnswer is false and answerEl is never
// built: the draft has no input to live in and no UI can ever clear it, so
// suspendReason() reads 'draft' forever.
describe('C2 · changeAnswer only stages the draft once the server accepted', () => {
  const body = fn('async function changeAnswer(', '\n// notes / done keep')

  it('does not write the draft before the POST', () => {
    const post = body.indexOf('postJSON(')
    const draft = body.indexOf('draftReplies[it.id]')
    expect(post, 'the POST is missing').toBeGreaterThan(-1)
    expect(draft, 'the draft prefill is missing').toBeGreaterThan(-1)
    expect(draft, 'draftReplies is still written before the POST').toBeGreaterThan(post)
  })

  it('leaves no draft behind on either bail-out branch (network failure, refusal)', () => {
    const refusal = body.match(/if \(!res\.ok\) \{[\s\S]*?\n  \}/)
    expect(refusal, 'no refusal branch found').toBeTruthy()
    expect(refusal![0]).toMatch(/return/)
    expect(refusal![0]).not.toMatch(/draftReplies\[it\.id\]\s*=/)
    const netFail = body.slice(body.indexOf('res === null'), body.indexOf('if (!res.ok)'))
    expect(netFail).not.toMatch(/draftReplies\[it\.id\]\s*=/)
  })
})

// ── C3: a failed write silently discarded what the human typed ───────────────
// sendReply() and rowAnswerEl's save() both deleted the draft BEFORE the POST.
// postJSON returning null (viewer server restarted — routine for the Electron
// app) then left the typed answer gone: #status's "disconnected" is wiped by the
// next successful poll ≤3s later and the next render rebuilds an empty input.
describe('C3 · a failed write restores the draft and leaves a persistent inline error', () => {
  const send = fn('async function sendReply(', '\n// the answer surface')
  const save = fn('  const save = async () => {', '\n  input.addEventListener')

  it('sendReply clears the drafts only after the write succeeded', () => {
    const post = send.indexOf('postJSON(')
    expect(send.indexOf('delete draftReplies[id]')).toBeGreaterThan(post)
  })

  it('sendReply restores what the human typed when the write failed', () => {
    const fail = send.slice(send.indexOf('res === null'))
    expect(fail).toMatch(/draftReplies\[id\]\s*=/)
    expect(fail).toMatch(/showWriteError\(/)
  })

  it('the row answer save does the same', () => {
    const post = save.indexOf('postJSON(')
    expect(save.indexOf('delete rowDrafts[r.id]')).toBeGreaterThan(post)
    const fail = save.slice(save.indexOf('res === null'))
    expect(fail).toMatch(/rowDrafts\[r\.id\]\s*=/)
    expect(fail).toMatch(/showWriteError\(/)
  })

  it('the error is a persistent inline slot, NOT the auto-clearing #status', () => {
    const helper = fn('function showWriteError(', '\n}')
    expect(helper).toMatch(/\.write-error|write-error/)
    expect(helper).not.toContain("getElementById('status')")
    // agent- and human-authored text alike: textContent, never innerHTML (SECURITY)
    expect(helper).toMatch(/textContent/)
    expect(helper).not.toMatch(/innerHTML/)
  })

  it('both answer surfaces render that slot, so the message survives the poll rebuild', () => {
    expect(js).toMatch(/function writeErrorEl\(/)
    expect(fn('function answerEl(', '\n// THE card')).toMatch(/writeErrorEl\(/)
    expect(fn('function rowAnswerEl(', '\n// the inline expansion')).toMatch(/writeErrorEl\(/)
  })
})

// ── C4: postJSON treated every non-2xx response as success ───────────────────
// It never checked res.ok: a 500 returns a text body, res.json() throws, the
// .catch(() => ({})) hands the caller {} and it calls load() as if the write
// landed. A server-side throw on reply/resolve/dismiss/annotate/archive was
// completely silent.
describe('C4 · postJSON fails loudly on a non-2xx response', () => {
  const body = fn('async function postJSON(', '\nfunction allItems')

  it('checks the HTTP status before parsing the body', () => {
    expect(body).toMatch(/if\s*\(\s*!res\.ok\s*\)/)
  })

  it('logs, signals visibly and returns null so every existing `res === null` bail-out fires', () => {
    const branch = body.slice(body.indexOf('if (!res.ok)'), body.indexOf('return await res.json'))
    expect(branch).toMatch(/console\.error\(/)
    expect(branch).toMatch(/getElementById\('status'\)/)
    expect(branch).toMatch(/return null/)
  })

  it('does not swallow a legitimate 200 carrying { ok: false } — that is C2 refusal, a different case', () => {
    // the guard must key on the Response, never on the parsed body's own `ok`
    const branch = body.slice(body.indexOf('if (!res.ok)'), body.indexOf('return await res.json'))
    expect(branch).not.toMatch(/json\(\)/)
    // changeAnswer still reads the BODY's ok and shows the refusal copy
    expect(fn('async function changeAnswer(', '\n// notes / done keep')).toMatch(/undoRefusal\(/)
  })
})

