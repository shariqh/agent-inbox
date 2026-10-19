// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  advanceBoardRow, annotateBoardRow, answerItem, getBoard, getItem, insertItem, listItems, markAnnotationDelivered,
  markReplySeen, openDb, replyItem, stopBoardRowWatch, stopItemWatch, updateBoardRow, upsertBoard,
} from '../../src/store.js'
import {
  answerInput, badgeCount, bootApp, buttonLabelled, click, collapseRow, freshDb, row, rowTitles,
  pollTick, sendButton, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

function chipText(id: string): string {
  const chip = row(id)?.querySelector('.chip')
  return [...(chip?.childNodes ?? [])]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? '')
    .join('')
    .trim()
}

describe('human disposition controls', () => {
  it('keeps More responses open across a poll rebuild', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Keep secondary responses open',
      action_owner: 'approval',
      options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    click(row(id))
    await settle()

    const before = row(id)?.querySelector<HTMLDetailsElement>('.disposition-menu')!
    before.open = true
    before.dispatchEvent(new Event('toggle'))
    await pollTick()

    const after = row(id)?.querySelector<HTMLDetailsElement>('.disposition-menu')
    expect(after).not.toBe(before)
    expect(after?.open).toBe(true)
  })

  it('snoozes an item into a visible fold and can wake it immediately', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Merge?',
      detail: 'All gates are green.',
      next_step: 'Choose whether to merge.',
      action_owner: 'approval',
      impact: 'Unblocks implementation.',
      options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    expect(badgeCount()).toBe(1)

    click(row(id))
    await settle()
    click(buttonLabelled('Not now · 4h', row(id)!))
    await settle()

    expect(badgeCount()).toBe(0)
    expect(rowTitles()).toContain('Choose whether to merge.')
    expect(chipText(id)).toMatch(/^snoozed /)
    expect(document.querySelector('.snoozed-fold')?.textContent).toContain('Merge?')

    click(buttonLabelled('Wake now', row(id)!))
    await settle()
    expect(badgeCount()).toBe(1)
    expect(chipText(id)).not.toMatch(/^snoozed /)
  })

  it('requests clarification on a row without pretending the work is complete', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Recruit partners',
        status: 'blocked',
        note: 'The outreach kit is ready.',
        next_step: 'Choose the tracker.',
        action_owner: 'decision',
        impact: 'Required before outreach starts.',
        options: [{ label: 'People Pipeline', recommended: true }, { label: 'Scratchpad' }],
      }],
    })
    const rowId = getBoard(d, 'alpha', 'Launch')!.rows[0]!.id
    await bootApp(d)
    click(row(rowId))
    await settle()
    click(buttonLabelled('Needs clarification', row(rowId)!))
    await settle()

    expect(badgeCount()).toBe(0)
    const stored = getBoard(d, 'alpha', 'Launch')!.rows[0]!
    expect(stored.annotation_kind).toBe('clarify')
    expect(stored.status).toBe('blocked')
    expect(rowTitles()).toContain('Recruit partners')
    expect(row(rowId)?.textContent).toContain('Saved · waiting for delivery')
  })

  it('records decline as a distinct response kind', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Publish today?',
      detail: 'The build is ready.',
      next_step: 'Choose whether to publish.',
      action_owner: 'approval',
      impact: 'Makes the release public.',
      options: [{ label: 'Publish', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    click(row(id))
    await settle()
    click(buttonLabelled('Decline', row(id)!))
    await settle()

    expect(listItems(d)[0]).toMatchObject({ reply: 'Declined', reply_kind: 'decline' })
    expect(badgeCount()).toBe(0)
  })

  it('preserves a response rejected because the action changed before Send', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{ label: 'Deploy', status: 'blocked', note: 'Choose a window.' }],
    })
    const original = getBoard(d, 'alpha', 'Launch')!
    const rowId = original.rows[0]!.id
    await bootApp(d)
    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'Tomorrow morning')

    updateBoardRow(d, {
      ...AGENT,
      title: 'Launch',
      label: 'Deploy',
      expectedBoardVersion: original.revision,
      expectedRevision: original.rows[0]!.revision,
      note: 'Choose a window after the hotfix.',
    })
    click(sendButton(rowId))
    await settle()

    expect(getBoard(d, 'alpha', 'Launch')!.rows[0]!.annotation).toBeNull()
    expect(row(rowId)?.textContent).toContain('Preserved answer: Tomorrow morning')

    const current = getBoard(d, 'alpha', 'Launch')!
    updateBoardRow(d, {
      ...AGENT,
      title: 'Launch',
      label: 'Deploy',
      expectedBoardVersion: current.revision,
      expectedRevision: current.rows[0]!.revision,
      status: 'done',
      outcome: 'Action superseded.',
    })
    await pollTick()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Tomorrow morning')
  })

  it('preserves the response kind when clarification loses a revision race', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{ label: 'Deploy', status: 'blocked', note: 'Choose a window.' }],
    })
    const original = getBoard(d, 'alpha', 'Launch')!
    const rowId = original.rows[0]!.id
    await bootApp(d)
    click(row(rowId))
    await settle()

    updateBoardRow(d, {
      ...AGENT,
      title: 'Launch',
      label: 'Other rollout step',
      expectedBoardVersion: original.revision,
      status: 'tracked',
      note: 'Concurrent board change.',
    })
    click(buttonLabelled('Needs clarification', row(rowId)!))
    await settle()

    expect(answerInput(rowId)?.value).toContain('Please clarify')
    await collapseRow(rowId)
    click(row(rowId))
    await settle()
    click(sendButton(rowId))
    await settle()
    expect(getBoard(d, 'alpha', 'Launch')!.rows.find((candidate) => candidate.id === rowId))
      .toMatchObject({ annotation_kind: 'clarify' })
  })
})

// Issue #217 — "I'll take a while" tells the asking Copilot session's answer
// watcher to stop or to wait quietly. It is not an attention change: the ask
// stays in Needs you, and the badge does not move, before or after.
describe('the human stops an agent from waiting (#217)', () => {
  const COPILOT = { ...AGENT, agent: 'copilot' } as const
  const waitMenu = (id: string) => [...(row(id)?.querySelectorAll('summary') ?? [])]
    .find((summary) => summary.textContent === 'I’ll take a while') ?? null

  it('stops a Copilot question for good and leaves it in Needs you', async () => {
    const d = open()
    const id = insertItem(d, {
      ...COPILOT, kind: 'question', title: 'Approve the release?', detail: 'The build is ready.',
      next_step: 'Approve or hold the release.', action_owner: 'approval', impact: 'Ships 1.4.',
      options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    expect(badgeCount()).toBe(1)
    click(row(id))
    await settle()
    expect(waitMenu(id)).not.toBeNull()

    click(buttonLabelled('Stop waiting', row(id)!))
    await settle()

    expect(getItem(d, id)).toMatchObject({ watch_stopped_at: expect.any(String), watch_stopped_until: null, reply: null })
    expect(badgeCount()).toBe(1)
    expect(rowTitles()).toContain('Approve or hold the release.')
    expect(row(id)?.querySelector('.wait-stop-note')?.textContent)
      .toBe('Agent stopped waiting moments ago · message it after you answer')
    expect(waitMenu(id)).toBeNull()
    expect(buttonLabelled('Stop waiting', row(id)!)).toBeNull()
  })

  it('defers a Copilot blocked row with its revision pins and still lets the human change it', async () => {
    const d = open()
    upsertBoard(d, {
      ...COPILOT,
      title: 'Release',
      rows: [{
        label: 'Install test', status: 'blocked', note: 'The 1.4 build is ready.',
        next_step: 'Install it and report back.', action_owner: 'task', impact: 'Gates the release.',
      }],
    })
    const before = getBoard(d, 'alpha', 'Release')!
    const rowId = before.rows[0]!.id
    await bootApp(d)
    expect(badgeCount()).toBe(1)
    click(row(rowId))
    await settle()

    const clicked = Date.now()
    click(buttonLabelled('Back in ~3 h', row(rowId)!))
    await settle()

    const after = getBoard(d, 'alpha', 'Release')!
    const until = Date.parse(after.rows[0]!.watch_stopped_until!)
    expect(until).toBeGreaterThanOrEqual(clicked + 3 * 60 * 60_000)
    expect(until).toBeLessThanOrEqual(Date.now() + 3 * 60 * 60_000)
    expect(after.rows[0]!.revision).toBe(before.rows[0]!.revision)
    expect(after.revision).toBe(before.revision)
    expect(badgeCount()).toBe(1)
    expect(rowTitles()).toContain('Install it and report back.')
    expect(row(rowId)?.querySelector('.wait-stop-note')?.textContent)
      .toBe('Agent waits quietly · 3h left · answering still wakes it')
    expect(buttonLabelled('Stop waiting', row(rowId)!)).not.toBeNull()
  })

  const copilotQuestion = (d: Database.Database) => insertItem(d, {
    ...COPILOT, kind: 'question', title: 'Approve the release?', detail: 'The build is ready.',
    next_step: 'Approve or hold the release.', action_owner: 'approval', impact: 'Ships 1.4.',
    options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
  })
  const ask = (label: string) => ({
    label, status: 'blocked' as const, note: `${label} is ready.`, next_step: `Do ${label}.`,
    action_owner: 'task' as const, impact: 'Gates the release.',
  })
  const stopNote = (id: string) => row(id)?.querySelector('.wait-stop-note')?.textContent ?? null

  it('follows who raised the row action, not who last wrote the board', async () => {
    const d = open()
    const CLAUDE = { ...AGENT, agent: 'claude-code' } as const
    upsertBoard(d, { ...CLAUDE, title: 'Release', rows: [ask('Deploy'), ask('Upload')] })
    // Copilot edits another row, then advances one of Claude's rows.
    updateBoardRow(d, {
      ...COPILOT, title: 'Release', label: 'Docs', status: 'tracked',
      expectedBoardVersion: getBoard(d, 'alpha', 'Release')!.revision,
    })
    let board = getBoard(d, 'alpha', 'Release')!
    const [deploy, upload] = board.rows
    advanceBoardRow(d, {
      project: 'alpha', title: 'Release', label: 'Upload', agent: 'copilot',
      expectedBoardVersion: board.revision, expectedRevision: upload!.revision,
      note: 'The signed build is ready.', next_step: 'Upload the signed build.', action_owner: 'task', impact: 'Ships 1.4.',
    })
    board = getBoard(d, 'alpha', 'Release')!
    expect(board.agent).toBe('copilot')
    await bootApp(d)

    click(row(deploy!.id))
    await settle()
    expect(row(deploy!.id)?.querySelector('.disposition-menu')).not.toBeNull()
    expect(waitMenu(deploy!.id), 'Claude raised it; its hook ignores the stop').toBeNull()

    click(row(upload!.id))
    await settle()
    expect(waitMenu(upload!.id), 'Copilot raised this action').not.toBeNull()
  })

  it('hides the control and any stop note once an older server starts the next action', async () => {
    const d = open()
    upsertBoard(d, { ...COPILOT, title: 'Release', rows: [ask('Install')] })
    const board = getBoard(d, 'alpha', 'Release')!
    const rowId = board.rows[0]!.id
    expect(stopBoardRowWatch(d, rowId, null, board.rows[0]!.revision, board.revision)).toBe(true)
    // A pre-#217 server's beginNewRowAction: it bumps the action and knows no new columns.
    d.prepare(`UPDATE board_rows SET annotation = NULL, handled_at = NULL, snoozed_until = NULL,
                 action_started_at = ?, action_version = action_version + 1, revision = revision + 1, updated_at = ?
               WHERE id = ?`).run(new Date().toISOString(), new Date().toISOString(), rowId)
    await bootApp(d)
    click(row(rowId))
    await settle()
    expect(stopNote(rowId)).toBeNull()
    expect(waitMenu(rowId)).toBeNull()
  })

  it('hides the control on a question raised by an older server, whose watcher ignores a stop', async () => {
    const d = open()
    const id = copilotQuestion(d)
    d.prepare('UPDATE items SET action_agent = NULL WHERE id = ?').run(id)
    await bootApp(d)
    click(row(id))
    await settle()
    expect(waitMenu(id)).toBeNull()
  })

  it('draws no stop control on a chat-recorded answer, which nothing is waiting on', async () => {
    const d = open()
    const id = copilotQuestion(d)
    expect(answerItem(d, id, 'Approve')).toMatchObject({ ok: true })
    await bootApp(d)
    click(row(id))
    await settle()
    expect(answerInput(id), 'the correction form is still there').not.toBeNull()
    expect(waitMenu(id)).toBeNull()
    expect(stopNote(id)).toBeNull()
  })

  it('keeps the stop-for-good reminder on an answered card until the agent picks the answer up', async () => {
    const d = open()
    const id = copilotQuestion(d)
    expect(stopItemWatch(d, id, null)).toBe(true)
    expect(replyItem(d, id, 'Approve')).toBe(true)
    upsertBoard(d, { ...COPILOT, title: 'Release', rows: [ask('Install')] })
    let board = getBoard(d, 'alpha', 'Release')!
    const rowId = board.rows[0]!.id
    expect(stopBoardRowWatch(d, rowId, null, board.rows[0]!.revision, board.revision)).toBe(true)
    expect(annotateBoardRow(d, rowId, 'Installed; it works.', 'answer', board.rows[0]!.revision, board.revision)).toBe(true)
    await bootApp(d)

    const reminder = 'Agent stopped waiting · message it so it picks up your answer'
    click(row(id))
    await settle()
    expect(stopNote(id)).toBe(reminder)
    click(row(rowId))
    await settle()
    expect(stopNote(rowId)).toBe(reminder)

    markReplySeen(d, id, getItem(d, id)!.replied_at)
    board = getBoard(d, 'alpha', 'Release')!
    markAnnotationDelivered(d, rowId, board.rows[0]!.annotated_at, 'copilot')
    await pollTick()
    expect(stopNote(rowId)).toBeNull()
    click(row(id))
    await settle()
    expect(stopNote(id)).toBeNull()
  })

  it('draws no stop control for an agent that runs no answer watcher', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT, kind: 'question', title: 'Merge?', detail: 'All gates are green.',
      next_step: 'Choose whether to merge.', action_owner: 'approval', impact: 'Unblocks implementation.',
      options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
    })
    await bootApp(d)
    click(row(id))
    await settle()
    expect(row(id)?.querySelector('.disposition-menu')).not.toBeNull()
    expect(waitMenu(id)).toBeNull()
    expect(buttonLabelled('Stop waiting', row(id)!)).toBeNull()
  })
})
