// test/card.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { actionPresentation, optionOrder, recommendedWarning, cardSections } from '../public/card.js'
import type { CardItem } from '../public/card.js'

const base: CardItem = {
  id: 'i1', kind: 'question', status: 'open', title: 'Drop the column?',
  detail: 'one line', next_step: 'Choose whether to drop it.', context: 'why this came up', annotation: null,
  options: null, reply: null, reply_context: null, reply_seen_at: null, reply_source: null,
}
const item = (over: Partial<CardItem> = {}): CardItem => ({ ...base, ...over })

describe('action-first presentation', () => {
  it('uses the pending request without changing its stored tracking title', () => {
    const source = item({ title: '#132 / release-gate', next_step: 'Approve the release.' })
    expect(actionPresentation(source)).toMatchObject({
      headline: 'Approve the release.',
      headlineField: 'next-step',
      originalTitle: '#132 / release-gate',
      detail: 'one line',
    })
    expect(source.title).toBe('#132 / release-gate')
    expect(actionPresentation({ label: 'QA-17', status: 'blocked', next_step: 'Upload the recording.' }).headline)
      .toBe('Upload the recording.')
  })

  it('keeps legacy, non-action, answered, and completed titles truthful', () => {
    for (const source of [
      item({ next_step: ' \n ' }),
      item({ kind: 'note' }),
      item({ kind: 'done' }),
      item({ reply: 'Yes' }),
      item({ reply_kind: 'decline' }),
      item({ status: 'resolved' }),
      item({ outcome: 'Already published.' }),
    ]) expect(actionPresentation(source).headline).toBe(source.title)
    expect(actionPresentation(item(), { done: true }).headline).toBe(base.title)
    for (const source of [
      { label: 'QA-17', status: 'done', next_step: 'Upload the recording.' },
      { label: 'QA-17', status: 'blocked', next_step: 'Upload the recording.', annotation: 'Uploaded' },
      { label: 'QA-17', status: 'blocked', next_step: 'Upload the recording.', handled_at: '2026-09-01' },
      { label: 'QA-17', status: 'blocked', next_step: 'Upload the recording.', annotation_kind: 'clarify' },
    ]) expect(actionPresentation(source).headline).toBe('QA-17')
  })

  it('removes only exact repetition and preserves full warnings and consequences', () => {
    const warning = 'Do not publish before the backup finishes.\n\nThe old client will stop working.'
    expect(actionPresentation(item({
      detail: warning,
      impact: warning,
      next_after: 'I will verify the backup before publishing.',
    }))).toMatchObject({
      detail: warning,
      impact: '',
      nextAfter: 'I will verify the backup before publishing.',
    })
    expect(actionPresentation(item({
      detail: 'Choose whether to drop it.',
      impact: 'Choose whether to drop it. This permanently deletes data.',
    }))).toMatchObject({
      detail: '',
      impact: 'Choose whether to drop it. This permanently deletes data.',
    })
  })
})

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
  it('surfaces the concrete next step separately from the TL;DR', () => {
    expect(cardSections(item())).toMatchObject({
      detail: 'one line',
      nextStep: 'Choose whether to drop it.',
    })
  })
  it('shows the answer surface only for an open unanswered question', () => {
    expect(cardSections(item()).showAnswer).toBe(true)
    expect(cardSections(item({ reply: 'go' })).showAnswer).toBe(false)
    expect(cardSections(item({ kind: 'note' })).showAnswer).toBe(false)
    expect(cardSections(item(), { done: true }).showAnswer).toBe(false)
  })
  it('reopens the answer surface for an open answer recorded by the agent', () => {
    expect(cardSections(item({
      reply: 'go',
      reply_source: 'agent',
      reply_seen_at: '2026-08-12T17:00:00.000Z',
    })).showAnswer).toBe(true)
  })
  it('exposes the reply and the answered flag once replied', () => {
    const s = cardSections(item({ reply: 'go ahead' }))
    expect(s.answered).toBe(true)
    expect(s.reply).toBe('go ahead')
  })
  it('a resolved question keeps the decision text but is no longer actively answered', () => {
    expect(cardSections(item({ reply: 'go ahead', status: 'resolved' }), { done: true }))
      .toMatchObject({ reply: 'go ahead', answered: false })
    expect(cardSections(item({ reply: 'go ahead', status: 'resolved' })))
      .toMatchObject({ reply: 'go ahead', answered: false })
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
    expect(js).toMatch(/import\s*\{\s*cardSections,\s*optionOrder,\s*actionPresentation\s*\}\s*from\s*'\/card\.js'/)
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

  it('separates idempotent activation from explicit collapse', () => {
    const activateStart = js.indexOf('function activateRow(')
    expect(activateStart, 'activateRow is missing').toBeGreaterThan(-1)
    const activate = js.slice(activateStart, js.indexOf('\nfunction ', activateStart))
    expect(activate).toContain('if (openRowId === m.id)')
    expect(activate).toContain("if (layout !== 'wide')")
    expect(activate).toContain('collapseRow(m.id)')
    expect(activate).toContain('if (selectedId !== m.id)')
    expect(activate).toContain('setOpenRow(m.id, { resume: false })')
    expect(activate).toContain('resumeRender()')
    expect(activate).not.toContain('renderIfIdle()')
    expect(activate).not.toContain('render()')

    const collapseStart = js.indexOf('function collapseRow(')
    expect(collapseStart, 'collapseRow is missing').toBeGreaterThan(-1)
    const collapse = js.slice(collapseStart, js.indexOf('\nfunction ', collapseStart))
    expect(collapse).toContain('setOpenRow(null)')
    expect(collapse).toContain('renderIfIdle()')
    expect(collapse).not.toContain('render()')
  })

  it('the inline expanded body is rowCardBodyEl, tagged .nrow-card', () => {
    const start = js.indexOf('function rowCardBodyEl(')
    expect(start, 'rowCardBodyEl is missing').toBeGreaterThan(-1)
    const fn = js.slice(start, js.indexOf('\nfunction ', start))
    expect(fn).toMatch(/className\s*=\s*'nrow-card'/)
  })

  it('needsRowEl wires activation and explicit collapse, then restores the open row on rebuild', () => {
    const start = js.indexOf('function needsRowEl(')
    const fn = js.slice(start, js.indexOf('\nfunction rowCardBodyEl('))
    expect(fn).toContain('activateRow(el, m, entry, nowMs)')
    expect(fn).toContain('collapseRow(m.id)')
    expect(fn).toMatch(/openRowId === m\.id/)
  })

  it('itemCardEl backs both the inline accordion body and the triage lightbox', () => {
    const rowBodyStart = js.indexOf('function rowCardBodyEl(')
    const rowBodyFn = js.slice(rowBodyStart, js.indexOf('\nfunction activateRow('))
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

  it('the background block is identity-keyed, safely rendered, and rebound after rendering', () => {
    const start = js.indexOf('function itemCardEl(')
    const fn = js.slice(start, js.indexOf('\nasync function changeAnswer('))
    expect(fn).toContain('actionPresentation(it, { done })')
    expect(fn).toContain('actionBlocksHtml(presentation)')
    expect(fn).toContain('cardDetailsHtml(it, it, `item:${it.id}`, presentation, { includeAsked })')
    expect(fn).toContain('bindContextDisclosures(el)')
    const blocks = js.slice(js.indexOf('function cardDetailsHtml('), js.indexOf('\n// the inline expansion'))
    expect(blocks).toContain('data-context-key="${esc(key)}"')
    expect(blocks).toContain("openContexts.has(key) ? ' open' : ''")
    expect(blocks).toMatch(/card-context-body">\$\{renderStructuredText\(entity\.context\)\}/)
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
    expect((fn.match(/Saved · waiting for delivery/g) ?? []).length).toBe(1)
    const markFn = js.slice(js.indexOf('function pickupMarkHtml('), js.indexOf('function rowHumanStateHtml('))
    expect((markFn.match(/Saved · waiting for delivery/g) ?? []).length).toBe(1)
    const rowFn = js.slice(js.indexOf('function rowHumanStateHtml('), js.indexOf('\nfunction rowPanelEl('))
    expect(rowFn, 'the row marker is never printed outside a guarded branch').not.toMatch(/Saved · waiting for delivery/)
    expect(rowFn).toContain('if (r.annotation || r.annotation_kind)')
    expect(rowFn).toContain('if (r.handled_at) parts.push(')
    expect((js.match(/Saved · waiting for delivery/g) ?? []).length, 'exactly one per noun, nowhere else').toBe(2)
    const replyBlock = fn.split('\n').find((l) => l.includes('Saved · waiting for delivery'))!
    expect(replyBlock).toContain('${s.reply || it.reply_kind ?')
    expect(replyBlock).toContain('reply-block')
    // the chip is a FIXED string selected by an equality test — interpolating the
    // stored value would regress the "everything through esc() before innerHTML" rule
    expect(replyBlock).toContain("it.reply_source === 'agent'")
    expect(fn).not.toMatch(/esc\(\s*it\.reply_source/)
  })

  it('keeps inline row saves independent from triage completion ownership', () => {
    const start = js.indexOf('function rowCardEl(')
    const fn = js.slice(start, js.indexOf('\nfunction renderTriage('))
    expect(fn).toContain('rowAnswerEl(b, r, onSaved)')
    expect(fn).not.toContain('triageDeck')
    expect(js).toContain('() => triageRemoveEntry(renderedDeck, renderedEntryKey)')
  })
})
