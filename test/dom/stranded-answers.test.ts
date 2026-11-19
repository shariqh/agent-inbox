// @vitest-environment jsdom
// Issue #636: an agent's write to a blocked row while its owner types an answer
// to it. The revision guard stays (an answer never lands on an ask its writer
// did not see), but the text is never stranded:
//   1. the same ask, nothing the person reads of it changed: the page sends the
//      text (or applies the option) against the current revision itself;
//   2. the same ask, its words edited: the text stays in the row's editor, the
//      row says the ask was edited, and the next Send goes to the current ask;
//   3. a new ask, or none: the text is kept beside the row while it is on
//      screen, in the unsent responses otherwise, with Use this text, Copy and
//      Discard.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, getBoard, updateBoardRow, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, freshDb, pollTick, repaint, row,
  sendButton, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  Reflect.deleteProperty(navigator, 'clipboard')
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const
const TITLE = 'Release'
const LABEL = 'Install test'
const EDITED = 'This ask was edited while you were typing. Read it again, then send.'
const ASK_CHANGED = 'The ask changed before your text was sent.'
const STEP_CLOSED = 'This step was closed before your text was sent.'

function seed(options = false): { d: Database.Database, rowId: string } {
  db = freshDb()
  upsertBoard(db, {
    ...AGENT,
    title: TITLE,
    rows: [
      {
        label: LABEL,
        status: 'blocked',
        note: 'The 1.4 build is ready.',
        next_step: 'Do the install test.',
        action_owner: options ? 'decision' : 'task',
        impact: 'Gates the release.',
        ...(options ? { options: [{ label: 'Ship it', recommended: true }, { label: 'Hold' }] } : {}),
      },
      { label: 'Notes', status: 'partial', note: 'Drafting.' },
    ],
  })
  return { d: db, rowId: getBoard(db, 'alpha', TITLE)!.rows.find((r) => r.label === LABEL)!.id }
}

type RowEdit = Omit<Parameters<typeof updateBoardRow>[1], 'project' | 'stream' | 'agent' | 'title' | 'label'>

function agentWrite(d: Database.Database, edit: RowEdit, label = LABEL): void {
  const board = getBoard(d, 'alpha', TITLE)!
  advanceClock()
  updateBoardRow(d, {
    ...AGENT,
    title: TITLE,
    label,
    expectedBoardVersion: board.revision,
    expectedRevision: board.rows.find((r) => r.label === label)!.revision,
    ...edit,
  })
}

function agentAdvance(d: Database.Database): void {
  const board = getBoard(d, 'alpha', TITLE)!
  advanceClock()
  expect(advanceBoardRow(d, {
    project: 'alpha',
    title: TITLE,
    label: LABEL,
    agent: AGENT.agent,
    expectedBoardVersion: board.revision,
    expectedRevision: board.rows.find((r) => r.label === LABEL)!.revision,
    note: 'The 1.5 build is ready.',
    next_step: 'Do the upgrade test.',
    action_owner: 'task',
    impact: 'Gates the next release.',
  }).ok).toBe(true)
}

async function draftOn(rowId: string, text = 'Half an answer'): Promise<void> {
  await showInbox()
  click(row(rowId))
  await settle()
  type(answerInput(rowId), text)
}

const annotation = (d: Database.Database) => getBoard(d, 'alpha', TITLE)!.rows.find((r) => r.label === LABEL)!.annotation
const fold = () => document.querySelector<HTMLDetailsElement>('#needsYouList .stale-drafts-fold')
const beside = (id: string) => row(id)?.querySelector<HTMLElement>('.row-recovery') ?? null
const pill = (id: string, label: string) => [...(row(id)?.querySelectorAll<HTMLButtonElement>('.opt-pill') ?? [])]
  .find((button) => button.textContent?.includes(label)) ?? null
const editedNotice = (id: string) => row(id)?.querySelector('.ask-edited')?.textContent ?? null
const annotatePosts = (bridge: Awaited<ReturnType<typeof bootApp>>) =>
  bridge.posts.filter((post) => post.url.includes('/annotate')).map((post) => JSON.parse(String(post.init?.body)))

describe('case 1: the same ask, nothing the person reads changed', () => {
  it('sends the typed text against the current revision when the row moved under it', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { issue: { repo: 'example/repo', number: 7 } })
    click(sendButton(rowId))
    await settle()

    expect(annotation(d)).toBe('Half an answer')
    const current = getBoard(d, 'alpha', TITLE)!
    expect(annotatePosts(bridge).at(-1)).toMatchObject({
      text: 'Half an answer',
      expected_revision: current.rows.find((r) => r.label === LABEL)!.revision - 1,
    })
    expect(fold()).toBeNull()
    expect(beside(rowId)).toBeNull()
    expect(row(rowId)?.querySelector('.write-error')?.textContent ?? '').toBe('')
  })

  it('sends it when only another row of the plan moved', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { note: 'Drafting, page two.' }, 'Notes')
    click(sendButton(rowId))
    await settle()

    expect(annotation(d)).toBe('Half an answer')
    expect(fold()).toBeNull()
  })

  it('applies an option click the same way', async () => {
    const { d, rowId } = seed(true)
    await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    agentWrite(d, { waits_on: ['Notes'] })
    click(pill(rowId, 'Hold'))
    await settle()

    expect(annotation(d)).toBe('Hold')
    expect(fold()).toBeNull()
  })

  it('sends once more only: a plan that keeps moving leaves the text in the editor and says so', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d, {
      // every annotate meets a plan that moved just before it
      interceptFetch: async (input, init, next) => {
        if (init?.method === 'POST' && String(input).includes('/annotate')) agentWrite(d, { note: `Drafting ${Date.now()}.` }, 'Notes')
        return next()
      },
    })
    await draftOn(rowId)
    click(sendButton(rowId))
    await settle()

    expect(annotation(d)).toBeNull()
    expect(annotatePosts(bridge)).toHaveLength(2)
    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(row(rowId)?.querySelector('.write-error')?.textContent)
      .toBe('This step kept changing, so nothing was sent. Try again.')
    expect(fold()).toBeNull()
  })

  it('keeps the text in the editor when a frame paints the moved row', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { issue: { repo: 'example/repo', number: 7 } })
    await pollTick()
    await repaint()

    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(fold()).toBeNull()
    expect(beside(rowId)).toBeNull()
    expect(editedNotice(rowId)).toBeNull()
    click(sendButton(rowId))
    await settle()
    expect(annotation(d)).toBe('Half an answer')
    expect(annotatePosts(bridge)).toHaveLength(1)
  })
})

describe('case 2: the same ask, its words edited', () => {
  it('keeps the text in the editor, says so, and sends the next Send to the current ask', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { note: 'The 1.4.1 build is ready.' })
    click(sendButton(rowId))
    await settle()

    expect(annotation(d)).toBeNull()
    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(editedNotice(rowId)).toBe(EDITED)
    expect(fold()).toBeNull()
    expect(beside(rowId)).toBeNull()
    expect(annotatePosts(bridge)).toHaveLength(1)

    click(sendButton(rowId))
    await settle()
    expect(annotation(d)).toBe('Half an answer')
    expect(editedNotice(rowId)).toBeNull()
    expect(fold()).toBeNull()
  })

  it('does not apply an option click, and the next click is applied', async () => {
    const { d, rowId } = seed(true)
    await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'Typed first')
    agentWrite(d, { options: [{ label: 'Ship it', recommended: true }, { label: 'Hold', detail: 'Wait for 1.4.1.' }] })
    click(pill(rowId, 'Hold'))
    await settle()

    expect(annotation(d)).toBeNull()
    expect(editedNotice(rowId)).toBe(EDITED)
    expect(answerInput(rowId)?.value, 'the typed text is still there').toBe('Typed first')
    expect(fold()).toBeNull()

    click(pill(rowId, 'Hold'))
    await settle()
    expect(annotation(d)).toBe('Hold')
  })

  it('says so when a frame paints the edited row, and Send goes to the current ask', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { impact: 'Gates the release and the beta.' })
    await pollTick()
    await repaint()

    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(editedNotice(rowId)).toBe(EDITED)
    expect(fold()).toBeNull()
    click(sendButton(rowId))
    await settle()
    expect(annotation(d)).toBe('Half an answer')
    expect(annotatePosts(bridge)).toHaveLength(1)
  })
})

describe('case 3: a different ask, or none', () => {
  it('keeps the text beside the row on screen, with Use this text, Copy and Discard', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    agentAdvance(d)
    click(sendButton(rowId))
    await settle()

    expect(annotation(d)).toBeNull()
    const block = beside(rowId)!
    expect(block.querySelector('.row-recovery-why')?.textContent).toBe(ASK_CHANGED)
    expect(block.querySelector('.row-recovery-text')?.textContent).toBe('Half an answer')
    expect([...block.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Use this text', 'Copy', 'Discard'])
    expect(answerInput(rowId)?.value).toBe('')
    expect(fold(), 'not also at the foot of the page').toBeNull()

    click(buttonLabelled('Use this text', beside(rowId)!))
    await settle()
    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(document.activeElement).toBe(answerInput(rowId))
    expect(beside(rowId)).toBeNull()
    expect(annotatePosts(bridge), 'Use this text sends nothing').toHaveLength(1)

    click(sendButton(rowId))
    await settle()
    expect(annotation(d)).toBe('Half an answer')
  })

  it('keeps it beside the row when a frame paints the new ask', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentAdvance(d)
    await pollTick()
    await repaint()

    expect(answerInput(rowId)?.value).toBe('')
    expect(beside(rowId)?.querySelector('.row-recovery-why')?.textContent).toBe(ASK_CHANGED)
    expect(fold()).toBeNull()
  })

  it('returns the keyboard to the row’s editor after Discard beside it', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentAdvance(d)
    click(sendButton(rowId))
    await settle()
    expect(document.activeElement, 'a refused Send leaves the keyboard on the kept text').toBe(beside(rowId))

    const discard = buttonLabelled('Discard', beside(rowId)!)!
    discard.focus()
    click(discard)
    await settle()
    expect(beside(rowId)).toBeNull()
    expect(fold()).toBeNull()
    expect(document.activeElement).toBe(answerInput(rowId))
  })

  it('does not keep an option clicked for an ask that was replaced', async () => {
    const { d, rowId } = seed(true)
    const bridge = await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    agentAdvance(d)
    click(pill(rowId, 'Hold'))
    await settle()

    expect(annotation(d)).toBeNull()
    expect(annotatePosts(bridge)).toHaveLength(1)
    expect(row(rowId)?.querySelector('.write-error')?.textContent)
      .toBe('This step changed before your click, so nothing was applied. Check it and try again.')
    expect(beside(rowId)).toBeNull()
    expect(fold()).toBeNull()
  })

  it('puts the text after what the new ask’s editor already holds', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentAdvance(d)
    click(sendButton(rowId))
    await settle()
    type(answerInput(rowId), 'New words')
    click(buttonLabelled('Use this text', beside(rowId)!))
    await settle()
    expect(answerInput(rowId)?.value).toBe('New words\n\nHalf an answer')
  })

  it('lists a closed step in the unsent responses, with Copy and Discard only', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { status: 'done', outcome: 'Tested by hand.' })
    click(sendButton(rowId))
    await settle()

    expect(row(rowId)).toBeNull()
    const line = fold()!.querySelector<HTMLElement>('.stale-draft-line')!
    expect(line.textContent).toContain(STEP_CLOSED)
    expect(line.textContent).toContain('Half an answer')
    expect([...line.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Copy', 'Discard'])
    expect(fold()!.querySelector('.stale-drafts-help')?.textContent)
      .toBe('Copy copies a response; Discard removes it for good.')

    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    click(buttonLabelled('Copy', fold()!))
    await settle()
    expect(writeText).toHaveBeenCalledWith('Half an answer')

    buttonLabelled('Discard', fold()!)!.focus()
    click(buttonLabelled('Discard', fold()!))
    await settle()
    expect(fold()).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('offers Use this text in the unsent responses once the row asks again', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentAdvance(d)
    click(sendButton(rowId))
    await settle()
    // the card closes: the row is on screen, its editor is not
    row(rowId)!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(beside(rowId)).toBeNull()
    const line = fold()!.querySelector<HTMLElement>('.stale-draft-line')!
    expect(line.textContent).toContain(ASK_CHANGED)
    expect(fold()!.querySelector('.stale-drafts-help')?.textContent)
      .toBe('Use this text puts a response in its step’s editor; Copy copies it; Discard removes it for good.')

    click(buttonLabelled('Use this text', fold()!))
    await settle()
    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(document.activeElement).toBe(answerInput(rowId))
    expect(fold()).toBeNull()
  })
})
