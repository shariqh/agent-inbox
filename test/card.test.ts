// test/card.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { optionOrder, recommendedWarning, cardSections } from '../public/card.js'
import type { CardItem } from '../public/card.js'

const base: CardItem = {
  id: 'i1', kind: 'question', status: 'open', title: 'Drop the column?',
  detail: 'one line', context: 'why this came up', annotation: null,
  options: null, reply: null, reply_context: null, reply_seen_at: null,
}
const item = (over: Partial<CardItem> = {}): CardItem => ({ ...base, ...over })

describe('optionOrder', () => {
  it('puts the recommended option first and keeps the rest stable', () => {
    const opts = [{ label: 'A' }, { label: 'B' }, { label: 'C', recommended: true }]
    expect(optionOrder(opts).map((o) => o.label)).toEqual(['C', 'A', 'B'])
  })
  it('returns an empty array for null options', () => {
    expect(optionOrder(null)).toEqual([])
  })
})

describe('recommendedWarning', () => {
  it('is null for zero or one recommendation', () => {
    expect(recommendedWarning(null)).toBeNull()
    expect(recommendedWarning([{ label: 'A', recommended: true }, { label: 'B' }])).toBeNull()
  })
  it('warns when the agent marked more than one', () => {
    expect(recommendedWarning([{ label: 'A', recommended: true }, { label: 'B', recommended: true }]))
      .toBe('2 options are marked recommended — one-tap accept is disabled')
  })
})

describe('cardSections', () => {
  it('surfaces context as its own labeled block', () => {
    expect(cardSections(item()).context).toBe('why this came up')
    expect(cardSections(item({ context: '' })).context).toBe('')
  })
  it('shows the answer surface only for an open unanswered question', () => {
    expect(cardSections(item()).showAnswer).toBe(true)
    expect(cardSections(item({ reply: 'go' })).showAnswer).toBe(false)
    expect(cardSections(item({ kind: 'note' })).showAnswer).toBe(false)
    expect(cardSections(item(), { done: true }).showAnswer).toBe(false)
  })
  it('exposes the reply and the answered flag once replied', () => {
    const s = cardSections(item({ reply: 'go ahead' }))
    expect(s.answered).toBe(true)
    expect(s.reply).toBe('go ahead')
  })
  // #29 criterion 3, pinned as ALREADY TRUE rather than fixed: `answered` requires
  // status === 'open', and `reply` is blanked with it, so once a question is resolved
  // no card can render its reply — and therefore none can render a stale
  // "waiting for agent pickup" marker beside it. Both resolve paths (the MCP tool and
  // POST /api/items/:id/resolve) go through the same resolveItem, so this holds
  // whichever channel closed the item.
  it('a resolved question exposes no reply, so no card can render a stale pickup marker', () => {
    expect(cardSections(item({ reply: 'go ahead', status: 'resolved' }), { done: true }))
      .toMatchObject({ reply: '', answered: false })
    expect(cardSections(item({ reply: 'go ahead', status: 'resolved' })))
      .toMatchObject({ reply: '', answered: false }) // and not only in the Done section
  })

  it('hides actions on a done card and carries the multi-recommendation warning', () => {
    expect(cardSections(item(), { done: true }).showActions).toBe(false)
    const s = cardSections(item({ options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }))
    expect(s.recWarning).toContain('2 options are marked recommended')
    expect(s.options.length).toBe(2)
  })
})

// Source-level pins: which shared builder app.js imports, rather than what it
// renders. (The rendered result is covered against jsdom in test/dom/ — see
// test/dom/toggle-row.test.ts for the card's answer surface.)
describe('app.js wiring (source-level pins)', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

  it('imports the shared card builders instead of re-declaring them', () => {
    expect(js).toMatch(/import\s*\{\s*cardSections,\s*optionOrder\s*\}\s*from\s*'\/card\.js'/)
  })

  it('has no separate expansion-state variable — only Task 9\'s openRowId/setOpenRow', () => {
    expect(js).not.toMatch(/\bexpandedRowId\b/)
    expect(js).toMatch(/let\s+openRowId\s*=\s*null/)
    expect(js).toMatch(/function setOpenRow\(/)
    // every write to openRowId other than its `let` declaration happens inside
    // setOpenRow — no other function is allowed to assign it directly
    const withoutDeclaration = js.replace(/let\s+openRowId\s*=\s*null/, '')
    const assignments = withoutDeclaration.match(/openRowId\s*=(?!=)/g) ?? []
    expect(assignments.length).toBe(1)
    const setOpenRowStart = js.indexOf('function setOpenRow(')
    const setOpenRowFn = js.slice(setOpenRowStart, js.indexOf('\nfunction ', setOpenRowStart))
    expect(setOpenRowFn).toMatch(/openRowId\s*=(?!=)/)
  })

  it('toggleRow drives the accordion through renderIfIdle(), never a bare render()', () => {
    const start = js.indexOf('function toggleRow(')
    expect(start, 'toggleRow is missing').toBeGreaterThan(-1)
    const fn = js.slice(start, js.indexOf('\nfunction ', start))
    expect(fn).toContain('setOpenRow(')
    expect(fn).toContain('renderIfIdle()')
    expect(fn).not.toContain('render()')
  })

  it('the inline expanded body is rowCardBodyEl, tagged .nrow-card', () => {
    const start = js.indexOf('function rowCardBodyEl(')
    expect(start, 'rowCardBodyEl is missing').toBeGreaterThan(-1)
    const fn = js.slice(start, js.indexOf('\nfunction ', start))
    expect(fn).toMatch(/className\s*=\s*'nrow-card'/)
  })

  it('needsRowEl wires click/keydown to toggleRow and restores the open row on rebuild', () => {
    const start = js.indexOf('function needsRowEl(')
    const fn = js.slice(start, js.indexOf('\nfunction rowCardBodyEl('))
    expect(fn).toContain('toggleRow(el, m, entry, nowMs)')
    expect(fn).toMatch(/openRowId === m\.id/)
  })

  it('itemCardEl backs both the inline accordion body and the triage lightbox', () => {
    const rowBodyStart = js.indexOf('function rowCardBodyEl(')
    const rowBodyFn = js.slice(rowBodyStart, js.indexOf('\nfunction toggleRow('))
    expect(rowBodyFn).toContain('itemCardEl(')

    const triageStart = js.indexOf('function renderTriage(')
    const triageFn = js.slice(triageStart, js.indexOf('\nfunction initTriage('))
    expect(triageFn).toContain('itemCardEl(')
  })

  it('itemEl delegates its body to itemCardEl rather than duplicating the card markup', () => {
    const start = js.indexOf('function itemEl(')
    const fn = js.slice(start, js.indexOf('\nfunction btn('))
    expect(fn).toContain('itemCardEl(it, { done, header: false })')
  })

  it('the CONTEXT block is labeled and renders through esc()', () => {
    const start = js.indexOf('function itemCardEl(')
    const fn = js.slice(start, js.indexOf('\nasync function changeAnswer('))
    expect(fn).toContain('card-context-label">CONTEXT<')
    expect(fn).toMatch(/card-context-body">\$\{esc\(s\.context\)\}/)
  })

  // #29: an answer an agent recorded from chat must be visibly agent-written, and the
  // pickup marker must live in exactly one place — inside the reply block — so it can
  // never be printed for an item that has no reply to show.
  it('itemCardEl renders via-chat provenance as a fixed literal, inside the s.reply branch', () => {
    const start = js.indexOf('function itemCardEl(')
    const fn = js.slice(start, js.indexOf('\nasync function changeAnswer('))
    // The invariant is "one marker per noun, inside the branch that has something
    // to show" — not "one in the file". Issue #37 gave board rows the same marker;
    // #36 then gave a row TWO nouns (the human's words, and their "I did my part"
    // mark) each with its OWN delivery state, so the marker moved into one shared
    // helper and the guard moved with it into rowHumanStateHtml, where every
    // branch is gated on the field it describes. Pin the helper as the single
    // source and both guards by name, rather than loosening the count.
    expect((fn.match(/waiting for agent pickup/g) ?? []).length).toBe(1)
    const markFn = js.slice(js.indexOf('function pickupMarkHtml('), js.indexOf('function rowHumanStateHtml('))
    expect((markFn.match(/waiting for agent pickup/g) ?? []).length).toBe(1)
    const rowFn = js.slice(js.indexOf('function rowHumanStateHtml('), js.indexOf('\nfunction rowPanelEl('))
    expect(rowFn, 'the row marker is never printed outside a guarded branch').not.toMatch(/waiting for agent pickup/)
    expect(rowFn).toContain('if (r.annotation) parts.push(')
    expect(rowFn).toContain('if (r.handled_at) parts.push(')
    expect((js.match(/waiting for agent pickup/g) ?? []).length, 'exactly one per noun, nowhere else').toBe(2)
    const replyBlock = fn.split('\n').find((l) => l.includes('waiting for agent pickup'))!
    expect(replyBlock).toContain('${s.reply ?')
    expect(replyBlock).toContain('reply-block')
    // the chip is a FIXED string selected by an equality test — interpolating the
    // stored value would regress the "everything through esc() before innerHTML" rule
    expect(replyBlock).toContain("it.reply_source === 'agent'")
    expect(fn).not.toMatch(/esc\(\s*it\.reply_source/)
  })

  it('guards triageRemoveCurrent so saving a blocked row inline (deck closed) cannot throw', () => {
    const start = js.indexOf('function rowCardEl(')
    const fn = js.slice(start, js.indexOf('\nfunction renderTriage('))
    expect(fn).toContain('if (triageDeck) triageRemoveCurrent()')
    // guard against a regression that re-adds an unconditional call elsewhere in the function
    const bareCalls = (fn.match(/(?<!if \(triageDeck\) )triageRemoveCurrent\(\)/g) ?? []).length
    expect(bareCalls).toBe(0)
  })
})
