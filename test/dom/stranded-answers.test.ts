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
import {
  advanceBoardRow, annotateBoardRow, closeProject, getBoard, markRowHandled, updateBoardRow, upsertActivity, upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, expectConsoleError, freshDb, pollTick, repaint, row,
  sendButton, settle, showInbox, type, useDomTest, reach,
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
const EDITED_CHOOSE = 'This ask was edited while you were typing. Read it again, then choose.'
const HELP_ALL = 'Use this text puts a step’s text in its editor; Copy copies a step’s text; Discard removes an entry for good.'
const ANSWERED = 'The response on this step changed before yours was sent. Read it, then send yours.'
const UPDATED = 'This step was updated while you were typing. Read it again, then send.'
const STEP_ASKED = 'This step now has an ask. Your note was not sent.'
const STEP_GONE = 'This step was closed or removed before your text was sent.'
const PROJECT_CLOSED = 'Kept because this project is closed.'
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
// the standing notice, or the sentence a Send or an option click announced through the write-error slot
const noticeIn = (scope: Element | null | undefined) => {
  const standing = scope?.querySelector('.ask-edited')?.textContent
  if (standing) return standing
  const slot = scope?.querySelector<HTMLElement>('.write-error:not(.stale-draft)')
  return slot && !slot.hidden && slot.textContent ? slot.textContent : null
}
const editedNotice = (id: string) => noticeIn(row(id))
const panel = (id: string) => document.querySelector<HTMLElement>(`#boards [data-row-id="${id}"] + .row-panel-row`)
const panelInput = (id: string) => panel(id)?.querySelector<HTMLTextAreaElement>('.reply-input') ?? null
const panelSend = (id: string) => buttonLabelled('Send', panel(id) ?? document)
const notesRow = (d: Database.Database) => getBoard(d, 'alpha', TITLE)!.rows.find((r) => r.label === 'Notes')!
async function noteOn(id: string, text = 'A note on this step'): Promise<void> {
  click(document.querySelector('.tab[data-tab="boards"]'))
  await settle()
  click(await reach(() => document.querySelector(`#boards tr.board-row[data-row-id="${id}"] .row-expand`)))
  await settle()
  type(panelInput(id), text)
}
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
    expect(editedNotice(rowId)).toBe(EDITED_CHOOSE)
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

// What the person reads of an ask is what tells an edit from a write that left it
// alone (#636 review, points 1 and 13): every field, and the response the row
// holds, moves the fate off `same`.
describe('what the person reads', () => {
  it.each([
    ['its outcome', { outcome: 'Tested by hand.' }],
    ['its background', { context: 'Why the install test matters.' }],
    ['what happens after', { next_after: 'The release goes out.' }],
    ['its next step', { next_step: 'Do the install test twice.' }],
    ['who acts', { action_owner: 'approval' }],
    ['which option is recommended', { options: [{ label: 'Ship it' }, { label: 'Hold', recommended: true }] }],
  ] as const)('says the ask was edited when an agent changes %s', async (_what, edit) => {
    const { d, rowId } = seed(true)
    const bridge = await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, edit as RowEdit)
    click(sendButton(rowId))
    await settle()

    expect(annotation(d)).toBeNull()
    expect(editedNotice(rowId)).toBe(EDITED)
    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(annotatePosts(bridge)).toHaveLength(1)
  })

  it('treats a response another window saved as an answer on the step, whatever the response was', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    const board = getBoard(d, 'alpha', TITLE)!
    expect(markRowHandled(d, rowId, board.rows.find((r) => r.id === rowId)!.revision, board.revision)).toBe(true)
    click(sendButton(rowId))
    await settle()

    expect(annotation(d)).toBeNull()
    expect(editedNotice(rowId)).toBe(ANSWERED)
    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(annotatePosts(bridge)).toHaveLength(1)
  })

  it('treats a response whose kind alone changed as an answer on the step', async () => {
    const { d, rowId } = seed()
    const board = getBoard(d, 'alpha', TITLE)!
    expect(annotateBoardRow(d, rowId, 'Same words', 'clarify', board.rows.find((r) => r.id === rowId)!.revision, board.revision)).toBe(true)
    const bridge = await bootApp(d)
    await draftOn(rowId)
    const moved = getBoard(d, 'alpha', TITLE)!
    expect(annotateBoardRow(d, rowId, 'Same words', 'answer', moved.rows.find((r) => r.id === rowId)!.revision, moved.revision)).toBe(true)
    click(sendButton(rowId))
    await settle()

    expect(annotation(d)).toBe('Same words')
    expect(editedNotice(rowId)).toBe(ANSWERED)
    expect(annotatePosts(bridge)).toHaveLength(1)
  })
})

// #636 review, point 3: the row already holds this very text, so a send of it has
// landed (its answer was lost, or another window saved the same words).
describe('text the row already holds', () => {
  it('retires a draft whose send landed though its answer was lost', async () => {
    const { d, rowId } = seed()
    let lose = true
    const bridge = await bootApp(d, {
      interceptFetch: async (input, init, next) => {
        const response = await next()
        if (lose && init?.method === 'POST' && String(input).includes('/annotate')) {
          lose = false
          throw new Error('lost response')
        }
        return response
      },
    })
    expectConsoleError(/lost response|annotate/)
    await draftOn(rowId)
    click(sendButton(rowId))
    await settle()
    expect(annotation(d)).toBe('Half an answer')
    await pollTick()
    await repaint()

    expect(answerInput(rowId)?.value).toBe('')
    expect(editedNotice(rowId)).toBeNull()
    expect(fold()).toBeNull()
    expect(beside(rowId)).toBeNull()
    expect(annotatePosts(bridge)).toHaveLength(1)
  })

  it('retires a draft when another window saved exactly its text, and sends nothing more', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    await draftOn(rowId)
    const board = getBoard(d, 'alpha', TITLE)!
    expect(annotateBoardRow(d, rowId, 'Half an answer', 'answer', board.rows.find((r) => r.id === rowId)!.revision, board.revision)).toBe(true)
    click(sendButton(rowId))
    await settle()

    expect(annotatePosts(bridge)).toHaveLength(1)
    expect(answerInput(rowId)?.value).toBe('')
    expect(editedNotice(rowId)).toBeNull()
    expect(fold()).toBeNull()
    expect(beside(rowId)).toBeNull()
  })
})

// #636 review, point 5: a note typed on a step that is not waiting on the person
describe('a note on a step that is not waiting on the person', () => {
  it('is sent once more when only something the person does not read moved', async () => {
    const { d } = seed()
    const bridge = await bootApp(d)
    const id = notesRow(d).id
    await noteOn(id)
    agentWrite(d, { issue: { repo: 'example/repo', number: 9 } }, 'Notes')
    click(panelSend(id))
    await settle()

    expect(notesRow(d).annotation).toBe('A note on this step')
    expect(annotatePosts(bridge)).toHaveLength(2)
    expect(noticeIn(panel(id))).toBeNull()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })

  it('stays in its editor with a sentence when something the person reads changed', async () => {
    const { d } = seed()
    const bridge = await bootApp(d)
    const id = notesRow(d).id
    await noteOn(id)
    agentWrite(d, { note: 'Drafting, page two.' }, 'Notes')
    click(panelSend(id))
    await settle()

    expect(notesRow(d).annotation).toBeNull()
    expect(panelInput(id)?.value).toBe('A note on this step')
    expect(noticeIn(panel(id))).toBe(UPDATED)
    expect(annotatePosts(bridge)).toHaveLength(1)
    expect(panel(id)?.querySelector('.row-recovery')).toBeNull()

    click(panelSend(id))
    await settle()
    expect(notesRow(d).annotation).toBe('A note on this step')
    expect(noticeIn(panel(id))).toBeNull()
  })

  it('says it was updated when a frame paints the changed step, and Send goes to it', async () => {
    const { d } = seed()
    const bridge = await bootApp(d)
    const id = notesRow(d).id
    await noteOn(id)
    agentWrite(d, { status: 'tracked' }, 'Notes')
    await pollTick()
    await repaint()

    expect(panelInput(id)?.value).toBe('A note on this step')
    expect(noticeIn(panel(id))).toBe(UPDATED)
    click(panelSend(id))
    await settle()
    expect(notesRow(d).annotation).toBe('A note on this step')
    expect(annotatePosts(bridge)).toHaveLength(1)
  })

  it('is kept beside the step with Use this text when the step now has an ask', async () => {
    const { d } = seed()
    await bootApp(d)
    const id = notesRow(d).id
    await noteOn(id)
    agentWrite(d, {
      status: 'blocked', note: 'Need a call.', next_step: 'Pick one.', action_owner: 'task', impact: 'Gates the notes.',
    }, 'Notes')
    click(panelSend(id))
    await settle()

    expect(notesRow(d).annotation).toBeNull()
    const block = beside(id)!
    expect(block.querySelector('.row-recovery-why')?.textContent).toBe(STEP_ASKED)
    expect(block.querySelector('.row-recovery-text')?.textContent).toBe('A note on this step')
    expect([...block.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Use this text', 'Copy', 'Discard'])
    click(buttonLabelled('Use this text', block))
    await settle()
    expect(answerInput(id)?.value).toBe('A note on this step')
    expect(document.activeElement).toBe(answerInput(id))
    expect(beside(id)).toBeNull()
  })

  it('is kept in the unsent responses, with its reason and no Use this text, once the step is gone', async () => {
    const { d } = seed()
    await bootApp(d)
    const id = notesRow(d).id
    await noteOn(id)
    const board = getBoard(d, 'alpha', TITLE)!
    upsertBoard(d, { ...AGENT, title: TITLE, expectedVersion: board.revision, rows: [] })
    await pollTick()
    await showInbox()

    const line = fold()!.querySelector<HTMLElement>('.stale-draft-line')!
    expect(line.textContent).toContain(STEP_GONE)
    expect(line.textContent).toContain('A note on this step')
    expect([...line.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Copy', 'Discard'])
  })

  it.each([['a blocked ask', false], ['a note on a step', true]])('keeps the text of %s with its reason when the project was closed', async (_what, onNotes) => {
    const { d, rowId } = seed()
    await bootApp(d)
    const id = onNotes ? notesRow(d).id : rowId
    if (onNotes) await noteOn(id)
    else await draftOn(rowId)
    agentWrite(d, { issue: { repo: 'example/repo', number: 9 } }, onNotes ? 'Notes' : LABEL)
    expect(closeProject(d, 'alpha')).toBe(true)
    await pollTick()
    await showInbox()

    const line = fold()!.querySelector<HTMLElement>('.stale-draft-line')!
    expect(line.textContent).toContain(PROJECT_CLOSED)
    expect([...line.querySelectorAll('button')].map((b) => b.textContent), 'no editor to put it in').toEqual(['Copy', 'Discard'])
  })
})

// #636 review, points 6 to 10, 12 and 13: what a Send or a click leaves behind
describe('what a Send or a click says and leaves', () => {
  const WRITE_FAILED = 'Not sent — nothing was lost; press Send to retry.'

  it('announces the notice through the write-error slot, once, and draws no second copy', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { note: 'The 1.4.1 build is ready.' })
    click(sendButton(rowId))
    await settle()

    const slot = row(rowId)!.querySelector<HTMLElement>('.write-error:not(.stale-draft)')!
    expect(slot.getAttribute('role')).toBe('status')
    expect(slot.hidden).toBe(false)
    expect(slot.textContent).toBe(EDITED)
    expect(row(rowId)!.querySelector('.ask-edited'), 'one copy, not two').toBeNull()
    expect(row(rowId)!.textContent!.split(EDITED)).toHaveLength(2)
  })

  it('says the response changed, not that "a response was saved", when the done mark moved', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    const board = getBoard(d, 'alpha', TITLE)!
    expect(markRowHandled(d, rowId, board.rows.find((r) => r.id === rowId)!.revision, board.revision)).toBe(true)
    await pollTick()
    await repaint()

    // a frame, not a Send: the standing notice, which is no live region
    const notice = row(rowId)!.querySelector('.ask-edited')!
    expect(notice.textContent).toBe(ANSWERED)
    expect(notice.hasAttribute('role')).toBe(false)
  })

  it('does not send a second time over text typed while the page re-read the step', async () => {
    const { d, rowId } = seed()
    let armed = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const bridge = await bootApp(d, {
      interceptFetch: async (input, init, next) => {
        if (armed && init?.method !== 'POST') await gate
        const response = await next()
        if (init?.method === 'POST' && String(input).includes('/annotate')) armed = true
        return response
      },
    })
    await draftOn(rowId)
    agentWrite(d, { issue: { repo: 'example/repo', number: 7 } })
    click(sendButton(rowId))
    await settle()
    // the first send was refused and the re-read is in flight
    type(answerInput(rowId), 'Newer words')
    release()
    await settle()

    expect(annotatePosts(bridge)).toHaveLength(1)
    expect(annotation(d)).toBeNull()
    expect(answerInput(rowId)?.value).toBe('Newer words')
    expect(row(rowId)?.querySelector('.write-error')?.textContent ?? '').toBe('')
  })

  it('keeps newer text and says an earlier response was not applied when it is typed while the send is in flight', async () => {
    const { d, rowId } = seed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const bridge = await bootApp(d, {
      interceptFetch: async (input, init, next) => {
        const response = await next()
        if (init?.method === 'POST' && String(input).includes('/annotate')) await gate
        return response
      },
    })
    await draftOn(rowId)
    agentWrite(d, { note: 'The 1.4.1 build is ready.' })
    click(sendButton(rowId))
    await settle()
    type(answerInput(rowId), 'Newer words')
    release()
    await settle()

    expect(annotatePosts(bridge)).toHaveLength(1)
    expect(annotation(d)).toBeNull()
    expect(answerInput(rowId)?.value).toBe('Newer words')
    expect(row(rowId)?.querySelector('.write-error')?.textContent)
      .toBe('An earlier response was not applied; your newer draft is preserved.')
  })

  it('leaves what was typed alone when an option click gets no answer', async () => {
    const { d, rowId } = seed(true)
    const bridge = await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'Typed first')
    bridge.failPostsWith(503)
    expectConsoleError(/annotate failed/)
    click(pill(rowId, 'Hold'))
    await settle()

    expect(answerInput(rowId)?.value).toBe('Typed first')
    expect(row(rowId)?.querySelector('.write-error')?.textContent)
      .toBe('Your choice was not applied. Nothing was lost; choose again.')
    bridge.failPostsWith(null)
    click(sendButton(rowId))
    await settle()
    expect(annotation(d)).toBe('Typed first')
  })

  it('says the usual write-failed line, not "kept changing", when the re-read itself failed', async () => {
    const { d, rowId } = seed()
    let armed = false
    const bridge = await bootApp(d, {
      interceptFetch: async (input, init, next) => {
        if (armed && init?.method !== 'POST') throw new Error('reread blocked')
        const response = await next()
        if (init?.method === 'POST' && String(input).includes('/annotate')) armed = true
        return response
      },
    })
    expectConsoleError(/reread blocked/)
    await draftOn(rowId)
    agentWrite(d, { issue: { repo: 'example/repo', number: 7 } })
    click(sendButton(rowId))
    await settle()

    expect(annotatePosts(bridge)).toHaveLength(1)
    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(row(rowId)?.querySelector('.write-error')?.textContent).toBe(WRITE_FAILED)
  })

  it('removes the notice with the text when the editor is emptied', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { note: 'The 1.4.1 build is ready.' })
    click(sendButton(rowId))
    await settle()
    expect(editedNotice(rowId)).toBe(EDITED)

    type(answerInput(rowId), '')
    expect(editedNotice(rowId), 'gone at once').toBeNull()
    await pollTick()
    await repaint()
    expect(editedNotice(rowId)).toBeNull()
    type(answerInput(rowId), 'Fresh words')
    await repaint()
    expect(editedNotice(rowId), 'not carried to the next text').toBeNull()
  })

  it('keeps the notice through more typing, until the send lands', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { note: 'The 1.4.1 build is ready.' })
    click(sendButton(rowId))
    await settle()
    type(answerInput(rowId), 'Half an answer, more')
    click(buttonLabelled('Send', row(rowId)!))
    await settle()
    expect(annotation(d)).toBe('Half an answer, more')
    expect(editedNotice(rowId)).toBeNull()
  })

  it('ends a notice with the ask it was about', async () => {
    const { d, rowId } = seed(true)
    await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    agentWrite(d, { options: [{ label: 'Ship it', recommended: true }, { label: 'Hold', detail: 'Wait for 1.4.1.' }] })
    click(pill(rowId, 'Hold'))
    await settle()
    expect(editedNotice(rowId)).toBe(EDITED_CHOOSE)

    // a new ask: the old sentence is not left against it
    agentAdvance(d)
    await pollTick()
    await repaint()
    expect(editedNotice(rowId)).toBeNull()
  })

  it('ends a notice when the step stops asking', async () => {
    const { d, rowId } = seed(true)
    await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    agentWrite(d, { options: [{ label: 'Ship it', recommended: true }, { label: 'Hold', detail: 'Wait for 1.4.1.' }] })
    click(pill(rowId, 'Hold'))
    await settle()
    expect(editedNotice(rowId)).toBe(EDITED_CHOOSE)

    agentWrite(d, { status: 'partial' })
    await pollTick()
    await repaint()
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(await reach(() => document.querySelector(`#boards tr.board-row[data-row-id="${rowId}"] .row-expand`)))
    await settle()
    expect(panel(rowId)).not.toBeNull()
    expect(noticeIn(panel(rowId))).toBeNull()
  })

  it('says an option click was not applied when its step was closed meanwhile, in one entry with Discard only', async () => {
    const { d, rowId } = seed(true)
    const bridge = await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    agentWrite(d, { status: 'done', outcome: 'Tested by hand.' })
    click(pill(rowId, 'Hold'))
    await settle()

    expect(annotation(d)).toBeNull()
    expect(annotatePosts(bridge)).toHaveLength(1)
    const lines = [...fold()!.querySelectorAll<HTMLElement>('.stale-draft-line')]
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toContain('Your choice "Hold" was not applied: this step was closed first.')
    expect([...lines[0]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Discard'])
    expect(fold()!.querySelector('.stale-drafts-help')?.textContent).toBe('Discard removes an entry for good.')

    click(buttonLabelled('Discard', fold()!))
    await settle()
    expect(fold()).toBeNull()
  })

  it('says an option click was not applied when its project was closed meanwhile, in one entry with Discard only', async () => {
    const { d, rowId } = seed(true)
    const bridge = await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    agentWrite(d, { issue: { repo: 'example/repo', number: 7 } })
    expect(closeProject(d, 'alpha')).toBe(true)
    click(pill(rowId, 'Hold'))
    await settle()

    expect(annotation(d)).toBeNull()
    expect(annotatePosts(bridge)).toHaveLength(1)
    const lines = [...fold()!.querySelectorAll<HTMLElement>('.stale-draft-line')]
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toContain('Your choice "Hold" was not applied: this project was closed first.')
    expect([...lines[0]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Discard'])
  })

  it('keeps typed text and an unapplied click as two entries, and Discard removes only its own', async () => {
    const { d, rowId } = seed(true)
    await bootApp(d)
    await showInbox()
    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'Typed first')
    agentWrite(d, { status: 'done', outcome: 'Tested by hand.' })
    click(pill(rowId, 'Hold'))
    await settle()
    await pollTick()
    await settle()

    const lines = () => [...fold()!.querySelectorAll<HTMLElement>('.stale-draft-line')]
    expect(lines()).toHaveLength(2)
    const choiceLine = lines().find((line) => line.textContent!.includes('was not applied'))!
    click(buttonLabelled('Discard', choiceLine))
    await settle()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]!.textContent).toContain('Typed first')
  })
})

// #636 review, point 13 (M26): a Send reads the ask as ITS editor showed it, not as
// the draft's stored meta, which another editor of the same row may have moved on.
describe('two editors of one row', () => {
  it('refuses a Send from the editor that still shows the old ask, though the draft moved on in the other', async () => {
    const { d, rowId } = seed()
    const bridge = await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Answer', document.querySelector(`#boards tr.board-row[data-row-id="${rowId}"]`)!))
    await settle()
    type(panelInput(rowId), 'Half an answer')
    agentWrite(d, { note: 'The 1.4.1 build is ready.' })
    // the typed draft holds the Plans panel as it was
    await pollTick()
    expect(panel(rowId)?.textContent).toContain('The 1.4 build is ready.')
    // the Review queue draws its own editor from the new data, and moves the draft's meta to it
    click(buttonLabelled('Review queue'))
    await settle()
    expect(document.getElementById('lightbox')!.textContent).toContain('The 1.4.1 build is ready.')

    click(panelSend(rowId))
    await settle()
    expect(annotation(d), 'the old editor never lands text on an ask its writer did not read').toBeNull()
    expect(annotatePosts(bridge)).toHaveLength(1)
  })
})

// #636 second review, A: the Dashboard's session panel paints its asks before the
// frame's reconcile runs, so its editor sees the newer row before any follow has.
describe('the session panel’s editor', () => {
  async function typeInPanel(d: Database.Database, rowId: string) {
    upsertActivity(d, { ...AGENT, session: 'here', doing: 'Working', idle: false })
    const bridge = await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(document.querySelector('#dashboard [data-session-card="session:here"] .sc-doing'))
    await settle()
    const block = () => document.querySelector<HTMLElement>(`#dashboard .dash-focus [data-panel-ask="${rowId}"]`)
    type(block()!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Half an answer')
    return { bridge, block }
  }

  it('keeps the text when an agent moved only what the person does not read, and a tab is clicked', async () => {
    const { d, rowId } = seed()
    const { block } = await typeInPanel(d, rowId)
    agentWrite(d, { issue: { repo: 'example/repo', number: 7 } })
    await pollTick()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()

    expect(block()!.querySelector<HTMLTextAreaElement>('.reply-input')?.value).toBe('Half an answer')
    expect(block()!.querySelector('.row-recovery')).toBeNull()
    expect(fold()).toBeNull()
    expect(noticeIn(block())).toBeNull()
  })

  it('keeps the text and its notice when an agent edited the ask, and a tab is clicked', async () => {
    const { d, rowId } = seed()
    const { block } = await typeInPanel(d, rowId)
    agentWrite(d, { note: 'The 1.4.1 build is ready.' })
    await pollTick()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()

    expect(block()!.querySelector<HTMLTextAreaElement>('.reply-input')?.value).toBe('Half an answer')
    expect(block()!.querySelector('.row-recovery')).toBeNull()
    expect(noticeIn(block())).toBe(EDITED)
    expect(fold()).toBeNull()
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

  it('lists a closed step in the unsent responses, with Use this text, Copy and Discard', async () => {
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
    expect([...line.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Use this text', 'Copy', 'Discard'])
    expect(fold()!.querySelector('.stale-drafts-help')?.textContent).toBe(HELP_ALL)

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

  it('puts a closed step’s text in its Plans panel with Use this text', async () => {
    const { d, rowId } = seed()
    await bootApp(d)
    await draftOn(rowId)
    agentWrite(d, { status: 'done', outcome: 'Tested by hand.' })
    click(sendButton(rowId))
    await settle()
    click(buttonLabelled('Use this text', fold()!))
    await settle()

    expect(panelInput(rowId)?.value).toBe('Half an answer')
    expect(document.activeElement).toBe(panelInput(rowId))
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
    expect(annotation(d)).toBeNull()
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
    expect(fold()!.querySelector('.stale-drafts-help')?.textContent).toBe(HELP_ALL)

    click(buttonLabelled('Use this text', fold()!))
    await settle()
    expect(answerInput(rowId)?.value).toBe('Half an answer')
    expect(document.activeElement).toBe(answerInput(rowId))
    expect(fold()).toBeNull()
  })
})
