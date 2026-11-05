// @vitest-environment jsdom
// Issue #412 step 3, PR 3: driven sessions on the page. Settings → Agent
// sessions, the Live drawer's "Started from Agent Inbox" section (New session,
// Stop, Resume and send, the transcript), Approve on an @sessions ask through
// main, the composer's Queued states with Interrupt and send, and the §9 b off
// contract: in a browser, or with the switch off, the page reads nothing new
// and adds no control.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  claimDriverSlot, createLaunch, endLaunch, fileLaunchAsk, getItem, handOffLaunch, holdDriverLeases, insertItem, listSessionMessages, markDriverTurn, markWorktreeRemoved, recordWorktreeSummary,
  parkLaunch, recordActivityCall, recordLaunchProgress, resolveItem, settleLaunchAsk, upsertActivity,
} from '../../src/store.js'
import type { ViewerBridge } from './harness.js'
import { advanceClock, bootApp, buttonLabelled, changedPollTick, click, freshDb, pollTick, row, settle, type, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(async () => {
  const drawerEl = document.getElementById('liveDrawer')
  if (drawerEl) drawerEl.hidden = true
  for (const dialog of document.querySelectorAll('dialog')) dialog.remove()
  await vi.advanceTimersByTimeAsync(300)
  db?.close()
  db = null
  Reflect.deleteProperty(window, 'agentInboxLaunch')
})

const LAUNCH = '11111111-2222-4333-8444-555555555555'
const PARKED = '11111111-2222-4333-8444-666666666666'
const LEASE = { launchId: LAUNCH, pid: 4242, nonce: 'n' }

// the page's start-progress listener, as main would call it (#432 PR 5)
let progress: ((phase: string, launch?: string, startId?: string) => void) | null = null
// the tag of the newest start the page asked main for
const startTag = (api: { start: { mock: { calls: unknown[][] } } }) => (api.start.mock.calls.at(-1)![0] as { startId: string }).startId

type State = { owned: boolean; enabled: boolean; available: boolean; canEnable: boolean; worktreeRoot?: { path: string; isDefault: boolean }; maxSessions?: number }
function launchBridge(state: Partial<State> = {}) {
  const current: State = { owned: true, enabled: true, available: true, canEnable: true, ...state }
  const api = {
    available: vi.fn(async () => ({ ...current })),
    setEnabled: vi.fn(async (enabled: boolean) => { current.enabled = enabled; current.available = enabled; return { ok: true, enabled } }),
    start: vi.fn(async (_request: unknown) => ({ ok: true, launch: LAUNCH })),
    stop: vi.fn(async (_id: string) => ({ ok: true, status: 'stopping' })),
    close: vi.fn(async (_id: string) => ({ ok: true, killed: false })),
    resume: vi.fn(async (_id: string) => ({ ok: true, launch: PARKED })),
    approve: vi.fn(async (_value: unknown) => ({ ok: true })),
    chooseWorktreeRoot: vi.fn(async () => {
      current.worktreeRoot = { path: '/Users/shariqh/Development/copilot-worktrees', isDefault: false }
      return { ok: true, worktreeRoot: current.worktreeRoot }
    }),
    resetWorktreeRoot: vi.fn(async () => ({ ok: true })),
    onStartProgress: vi.fn((listener: ((phase: string, launch?: string, startId?: string) => void) | null) => { progress = listener; return true }),
    setMaxSessions: vi.fn(async (n: number) => { current.maxSessions = n; return { ok: true, maxSessions: n } }),
    removeWorktree: vi.fn(async (_id: string) => ({ ok: true }) as Record<string, unknown>),
    openWorktree: vi.fn(async (_id: string) => ({ ok: true }) as Record<string, unknown>),
    takeOver: vi.fn(async (_id: string) => ({ ok: true }) as Record<string, unknown>),
    chooseFolder: vi.fn(async () => ({ ok: true, folder: '/Users/shariqh/notes', project: 'notes', repository: false }) as Record<string, unknown>),
  }
  Object.defineProperty(window, 'agentInboxLaunch', { configurable: true, value: api })
  return api
}

function newLaunch(d: Database.Database, id = LAUNCH): void {
  createLaunch(d, {
    id, host: 'copilot', project: 'alpha', stream: 'main', cwd: '/work/alpha', mode: 'ask', model: 'claude-haiku-4.5',
    budgetActiveMs: 7_200_000, budgetToolCalls: 500, prompt: 'Fix it.', specVersion: 1, driverPid: 4242,
  })
}

function drivenSession(d: Database.Database, session = 'mcp-1', lease = LEASE): void {
  upsertActivity(d, { session, project: 'alpha', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false, receives_messages: true })
  claimDriverSlot(d, lease, 2)
  holdDriverLeases(d, lease, [session])
}

// every URL the page fetched, GETs included
function recordingBoot(d: Database.Database) {
  const urls: string[] = []
  const boot = bootApp(d, {
    interceptFetch: (input, _init, next) => {
      urls.push(String(input))
      return next()
    },
  })
  return { urls, boot }
}

// #454: a launch is a card in the Agents home, and its actions live in the session panel
const panel = (): HTMLElement => document.querySelector<HTMLElement>('#dashboard .dash-focus')!
const newSessionButton = () => document.querySelector<HTMLButtonElement>('.agents-home .ah-new')
const anyCard = (id: string) => [...document.querySelectorAll<HTMLElement>('[data-session-card]')].find((el) => el.dataset.sessionCard === id) ?? null
function openFolds(): void {
  for (const key of ['ended', 'earlier']) {
    const fold = document.querySelector<HTMLDetailsElement>(`.agents-home [data-ah-fold="${key}"]`)
    if (!fold || fold.hidden || fold.open) continue
    fold.open = true
    fold.dispatchEvent(new Event('toggle'))
  }
}
// the launch's card, wherever it is listed (the Ended and Earlier folds opened for it)
function launchRow(id: string): HTMLElement | null {
  if (!anyCard(`launch:${id}`)) openFolds()
  return anyCard(`launch:${id}`)
}
// the launch's panel, opened from its card
function openLaunch(id: string): HTMLElement {
  if (panel().hidden || panel().dataset.card !== `launch:${id}`) click(launchRow(id)?.querySelector('.sc-doing'))
  return panel()
}
const action = (id: string, name: string) => openLaunch(id).querySelector<HTMLButtonElement>(`[data-launch-action="${name}"]`)
const stateOf = (id: string) => launchRow(id)?.querySelector('.sc-state')?.textContent
const doingOf = (id: string) => launchRow(id)?.querySelector('.sc-doing')?.textContent
const composer = (session: string) => [...panel().querySelectorAll<HTMLElement>('.msg-composer')].find((el) => el.dataset.msgSession === session)
const panelAction = (name: string) => panel().querySelector<HTMLButtonElement>(`[data-launch-action="${name}"]`)
const panelLines = () => [...panel().querySelectorAll('.sp-transcript .launch-line')].map((li) => li.querySelector('.tx-b')?.textContent)

describe('off means off on the page (§9 b)', () => {
  it('in a browser, the page reads no launch route and adds no control, even beside a driven session mid-turn', async () => {
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    markDriverTurn(db, LEASE, 'turn', new Date().toISOString())
    const { urls, boot } = recordingBoot(db)
    await boot
    await changedPollTick(db)
    expect(urls.filter((u) => u.includes('/api/launch'))).toEqual([])
    expect(document.getElementById('launch-settings')).toBeNull()
    // the Agents home (#454): no launch card and no New session; the driven session is a card of its own,
    // and its panel has no action bar, transcript, worktree or Resume and send, and its composer no Interrupt
    click(document.querySelector('[data-session-card="session:mcp-1"] .sc-doing'))
    await settle()
    expect(composer('mcp-1')?.querySelector('.msg-interrupt')).toBeNull()
    expect(document.querySelector('.launch-dialog, .sp-actions [data-launch-action]')).toBeNull()
    for (const part of ['.sp-actions', '.sp-transcript', '.sp-worktree', '.sp-resume']) {
      expect(panel().querySelector<HTMLElement>(part)?.hidden, part).toBe(true)
    }
    expect(urls.filter((u) => u.includes('/api/launch'))).toEqual([])
    expect(document.querySelector('[data-session-card^="launch:"]')).toBeNull()
    expect(document.querySelector<HTMLElement>('.agents-home .ah-new')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-session-card="session:mcp-1"] .sc-agent')?.title).toBe('Copilot · driven')
  })

  it('in the app with the switch off, only the Settings switch is drawn, and nothing is read', async () => {
    const api = launchBridge({ enabled: false, available: false })
    db = freshDb()
    newLaunch(db)
    const { urls, boot } = recordingBoot(db)
    await boot
    await changedPollTick(db)
    const settings = document.getElementById('launch-settings')!
    expect(settings.hidden).toBe(false)
    expect(settings.querySelector<HTMLInputElement>('#launch-switch')!.checked).toBe(false)
    expect(urls.filter((u) => u.includes('/api/launch'))).toEqual([])
    expect(document.querySelector('[data-session-card^="launch:"]')).toBeNull()
    // the switch on: the next tick reads the launches and the launch's card appears
    const toggle = settings.querySelector<HTMLInputElement>('#launch-switch')!
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(api.setEnabled).toHaveBeenCalledWith(true)
    await changedPollTick(db)
    expect(urls.some((u) => u.startsWith('/api/launches'))).toBe(true)
    expect(launchRow(LAUNCH)?.closest('.ah-group')?.querySelector('.ah-group-name')?.textContent).toBe('alpha')
  })

  it('unticks and disables New worktree for a chosen folder that is not a repository, and restores it for one that is (#432)', async () => {
    const api = launchBridge()
    db = freshDb()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: 'seen', repo_root: '/work/alpha' })
    await bootApp(db)
    await changedPollTick(db)
    click(newSessionButton())
    await settle()
    const dialog = document.querySelector<HTMLDialogElement>('.launch-dialog')!
    const project = dialog.querySelector<HTMLSelectElement>('select[name="root"]')!
    const box = dialog.querySelector<HTMLInputElement>('input[name="worktree"]')!
    project.value = ''
    project.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(api.chooseFolder).toHaveBeenCalledWith()
    expect([...project.options].map((o) => o.value)).toEqual(['/work/alpha', '/Users/shariqh/notes', ''])
    expect(project.value).toBe('/Users/shariqh/notes')
    expect({ checked: box.checked, disabled: box.disabled }).toEqual({ checked: false, disabled: true })
    expect(box.closest('label')!.textContent).toContain('Not a git repository: the session runs in this folder.')
    project.value = '/work/alpha'
    project.dispatchEvent(new Event('change', { bubbles: true }))
    expect({ checked: box.checked, disabled: box.disabled }).toEqual({ checked: true, disabled: false })
    expect(box.closest('label')!.textContent).not.toContain('Not a git repository')
    // a cancelled dialog keeps the folder that was selected
    api.chooseFolder.mockResolvedValueOnce({ ok: false, cancelled: true })
    project.value = ''
    project.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(project.value).toBe('/work/alpha')
    project.value = '/Users/shariqh/notes'
    project.dispatchEvent(new Event('change', { bubbles: true }))
    type(dialog.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]'), 'Tidy the notes.')
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ root: '/Users/shariqh/notes', prompt: 'Tidy the notes.' }))
    expect(api.start.mock.calls[0]![0]).not.toHaveProperty('worktree')
  })

  it('with no folder chosen yet, Start asks main’s dialog first, and waits for a second Start when that unticks New worktree (#432)', async () => {
    const api = launchBridge()
    db = freshDb()
    await bootApp(db)
    await changedPollTick(db)
    click(newSessionButton())
    await settle()
    const dialog = document.querySelector<HTMLDialogElement>('.launch-dialog')!
    type(dialog.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]'), 'Tidy the notes.')
    const submit = () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    submit()
    await settle()
    expect(api.chooseFolder).toHaveBeenCalledTimes(1)
    expect(api.start).not.toHaveBeenCalled()
    expect(dialog.querySelector<HTMLInputElement>('input[name="worktree"]')!.disabled).toBe(true)
    submit()
    await settle()
    expect(api.chooseFolder).toHaveBeenCalledTimes(1)
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ root: '/Users/shariqh/notes' }))
    expect(api.start.mock.calls[0]![0]).not.toHaveProperty('worktree')
    // a repository chosen at Start goes straight on, with its worktree
    const again = launchBridge()
    again.chooseFolder.mockResolvedValueOnce({ ok: true, folder: '/work/beta', project: 'beta', repository: true })
    click(newSessionButton())
    await settle()
    const next = document.querySelector<HTMLDialogElement>('.launch-dialog')!
    type(next.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]'), 'Fix it.')
    next.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(again.start).toHaveBeenCalledWith(expect.objectContaining({ root: '/work/beta', worktree: true }))
  })

  it('shows the worktree folder only with the switch on, and chooses it through main with no argument (#432)', async () => {
    const off = launchBridge({ enabled: false, available: false })
    db = freshDb()
    await bootApp(db)
    expect(document.getElementById('launch-settings')!.hidden).toBe(false)
    expect(document.getElementById('launch-worktree-root')).toBeNull()
    expect(document.getElementById('launch-max-sessions')).toBeNull()
    expect(off.chooseWorktreeRoot).not.toHaveBeenCalled()
  })

  it('with the switch on, Settings shows the cap on sessions at once, 1 to 8, and changes it through main (#432)', async () => {
    const api = launchBridge({ maxSessions: 4 })
    db = freshDb()
    await bootApp(db)
    await settle()
    const select = document.querySelector<HTMLSelectElement>('#launch-max-sessions select')!
    expect([...select.options].map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    expect(select.value).toBe('4')
    select.value = '6'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(api.setMaxSessions).toHaveBeenCalledWith(6)
    expect(select.value).toBe('6')
  })

  it('with the switch on, Settings shows where worktrees go, and Choose… asks main’s own dialog', async () => {
    const api = launchBridge({ worktreeRoot: { path: '/Users/shariqh/.agent-inbox/worktrees', isDefault: true } })
    db = freshDb()
    await bootApp(db)
    await settle()
    const row = document.getElementById('launch-worktree-root')!
    expect(row.hidden).toBe(false)
    expect(row.textContent).toContain('/Users/shariqh/.agent-inbox/worktrees (default)')
    expect(buttonLabelled('Use default', row)!.disabled).toBe(true)
    click(buttonLabelled('Choose…', row))
    await settle()
    expect(api.chooseWorktreeRoot).toHaveBeenCalledWith()
    expect(row.textContent).toContain('/Users/shariqh/Development/copilot-worktrees')
    expect(buttonLabelled('Use default', row)!.disabled).toBe(false)
  })

  it('a viewer the app does not own draws no Settings section', async () => {
    launchBridge({ owned: false, enabled: false, available: false, canEnable: false })
    db = freshDb()
    await bootApp(db)
    expect(document.getElementById('launch-settings')?.hidden ?? true).toBe(true)
  })
})

describe('a launch’s card and session panel (§3.6, §7, #454)', () => {
  it('shows a launch that ended before its session was ready as “Didn’t start”, with why, in the error tone (#432 PR 5)', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    endLaunch(db, LAUNCH, { reason: 'error:setup', detail: 'Copilot refused to start the session: Model \'x\' does not support reasoning effort configuration' })
    newLaunch(db, PARKED)
    endLaunch(db, PARKED, { reason: 'stopped' })
    await bootApp(db)
    await changedPollTick(db)
    expect(launchRow(LAUNCH)!.classList.contains('tone-failed')).toBe(true)
    expect(stateOf(LAUNCH)).toBe('Didn’t start')
    expect(doingOf(LAUNCH)).toBe('Didn’t start: Copilot refused to start the session: Model \'x\' does not support reasoning effort configuration')
    expect(launchRow(LAUNCH)!.querySelector('[data-ah-action="transcript"]')?.textContent).toBe('Details')
    expect(stateOf(PARKED)).toBe('Ended')
    expect(doingOf(PARKED)).toBe('Stopped')
  })

  it('offers Open in Terminal on a worktree, Remove worktree… once its launch ended, and keeps a kept worktree listed (#432)', async () => {
    const api = launchBridge()
    db = freshDb()
    const tree = (id: string, n: number) => createLaunch(db!, {
      id, host: 'copilot', project: 'alpha', stream: `agent-inbox/fix-${n}`, cwd: `/w/alpha/fix-${n}`, mode: 'ask',
      budgetActiveMs: 7_200_000, budgetToolCalls: 500, prompt: 'Fix it.', specVersion: 1, driverPid: 4242,
      worktree: { checkoutRoot: '/work/alpha', branch: `agent-inbox/fix-${n}`, baseSha: 'a'.repeat(40), baseRef: 'refs/heads/main' },
    })
    tree(LAUNCH, 1)
    const OLD = '11111111-2222-4333-8444-000000000001'
    tree(OLD, 0)
    endLaunch(db, OLD, { reason: 'stopped' })
    // six newer ended launches without a worktree push it past the five ended shown
    for (let n = 2; n <= 7; n++) {
      const id = `11111111-2222-4333-8444-00000000000${n}`
      newLaunch(db, id)
      endLaunch(db, id, { reason: 'stopped' })
    }
    await bootApp(db)
    await changedPollTick(db)
    expect(action(LAUNCH, 'open-worktree')?.textContent).toBe('Open in Terminal')
    // Remove only once ended: drawn, disabled with its reason
    expect(action(LAUNCH, 'remove-worktree')?.disabled).toBe(true)
    expect(launchRow(OLD)).not.toBeNull()
    expect(action('11111111-2222-4333-8444-000000000002', 'open-worktree')).toBeNull()
    click(action(LAUNCH, 'open-worktree'))
    await settle()
    expect(api.openWorktree).toHaveBeenCalledWith(LAUNCH)
    click(action(OLD, 'remove-worktree'))
    await settle()
    expect(api.removeWorktree).toHaveBeenCalledWith(OLD)
    api.removeWorktree.mockResolvedValueOnce({ ok: false, error: 'git said the worktree has changes.' })
    click(action(OLD, 'remove-worktree'))
    await settle()
    expect(openLaunch(OLD).querySelector('.sp-note')?.textContent).toBe('git said the worktree has changes.')
    api.removeWorktree.mockResolvedValueOnce({ ok: false, cancelled: true, error: 'Not removed.' })
    click(action(OLD, 'remove-worktree'))
    await settle()
    expect(openLaunch(OLD).textContent).not.toContain('Not removed.')
    // removed: past the newest five ended, its card moves to Earlier sessions
    markWorktreeRemoved(db, OLD)
    await changedPollTick(db)
    expect(anyCard(`launch:${OLD}`)?.closest('[data-ah-fold]')?.getAttribute('data-ah-fold')).toBe('earlier')
  })

  it('an ended launch’s kept worktree is removed from its card, and the Ended fold counts the worktrees kept (#454)', async () => {
    const api = launchBridge()
    db = freshDb()
    const tree = (id: string, n: number) => createLaunch(db!, {
      id, host: 'copilot', project: 'alpha', stream: `agent-inbox/fix-${n}`, cwd: `/w/alpha/fix-${n}`, mode: 'ask',
      budgetActiveMs: 7_200_000, budgetToolCalls: 500, prompt: 'Fix it.', specVersion: 1, driverPid: 4242,
      worktree: { checkoutRoot: '/work/alpha', branch: `agent-inbox/fix-${n}`, baseSha: 'a'.repeat(40), baseRef: 'refs/heads/main' },
    })
    const STOPPED = '11111111-2222-4333-8444-000000000001'
    const FAILED = '11111111-2222-4333-8444-000000000002'
    tree(LAUNCH, 1)
    tree(STOPPED, 2)
    endLaunch(db, STOPPED, { reason: 'stopped' })
    tree(FAILED, 3)
    endLaunch(db, FAILED, { reason: 'error:setup' })
    newLaunch(db, PARKED)
    endLaunch(db, PARKED, { reason: 'stopped' })
    await bootApp(db)
    await changedPollTick(db)
    const fold = () => document.querySelector<HTMLDetailsElement>('.agents-home [data-ah-fold="ended"]')!
    const summary = () => fold().querySelector(':scope > summary')!.textContent
    // counted while the fold is closed
    expect(fold().open).toBe(false)
    expect(summary()).toBe('Ended (3) · 2 worktrees kept')
    const remove = (id: string) => launchRow(id)!.querySelector<HTMLButtonElement>('[data-ah-action="remove-worktree"]')
    // ended with a kept worktree, a stop or a failed start alike; never a running one, nor one with no worktree
    expect(remove(STOPPED)?.textContent).toBe('Remove worktree…')
    expect(remove(FAILED)?.textContent).toBe('Remove worktree…')
    expect(remove(PARKED)).toBeNull()
    expect(remove(LAUNCH)).toBeNull()
    // main checks and asks (its own dialog); a refusal says why in the launch's panel
    click(remove(STOPPED))
    await settle()
    expect(api.removeWorktree).toHaveBeenCalledWith(STOPPED)
    expect(panel().hidden).toBe(true)
    api.removeWorktree.mockResolvedValueOnce({ ok: false, error: 'git said the worktree has changes.' })
    click(remove(STOPPED))
    await settle()
    await settle()
    expect(panel().hidden).toBe(false)
    expect(panel().dataset.card).toBe(`launch:${STOPPED}`)
    expect(panel().querySelector('.sp-note')?.textContent).toBe('git said the worktree has changes.')
    // removed: the card offers it no longer, and the count drops
    markWorktreeRemoved(db, STOPPED)
    await changedPollTick(db)
    expect(remove(STOPPED)).toBeNull()
    expect(summary()).toBe('Ended (3) · 1 worktree kept')
    markWorktreeRemoved(db, FAILED)
    await changedPollTick(db)
    expect(summary()).toBe('Ended (3)')
  })

  it('a card’s refused Remove worktree… opens the panel with its reason, after the panel last showed it running (#460 review)', async () => {
    const api = launchBridge()
    db = freshDb()
    createLaunch(db, {
      id: LAUNCH, host: 'copilot', project: 'alpha', stream: 'agent-inbox/fix-1', cwd: '/w/alpha/fix-1', mode: 'ask',
      budgetActiveMs: 7_200_000, budgetToolCalls: 500, prompt: 'Fix it.', specVersion: 1, driverPid: 4242,
      worktree: { checkoutRoot: '/work/alpha', branch: 'agent-inbox/fix-1', baseSha: 'a'.repeat(40), baseRef: 'refs/heads/main' },
    })
    await bootApp(db)
    await changedPollTick(db)
    // its panel painted while it ran, then closed
    openLaunch(LAUNCH)
    expect(panel().querySelector('.sp-actions-hint')).not.toBeNull()
    click(panel().querySelector('.dash-focus-close'))
    expect(panel().hidden).toBe(true)
    endLaunch(db, LAUNCH, { reason: 'stopped' })
    await changedPollTick(db)
    api.removeWorktree.mockResolvedValueOnce({ ok: false, error: 'git said the worktree has changes.' })
    click(launchRow(LAUNCH)!.querySelector('[data-ah-action="remove-worktree"]'))
    await settle()
    await settle()
    expect(panel().hidden).toBe(false)
    expect(panel().dataset.card).toBe(`launch:${LAUNCH}`)
    expect(panel().querySelector<HTMLElement>('.sp-note')?.hidden).toBe(false)
    expect(panel().querySelector('.sp-note')?.textContent).toBe('git said the worktree has changes.')
  })

  it('a running launch’s panel says Stop comes before Remove worktree…', async () => {
    launchBridge()
    db = freshDb()
    createLaunch(db, {
      id: LAUNCH, host: 'copilot', project: 'alpha', stream: 'agent-inbox/fix-1', cwd: '/w/alpha/fix-1', mode: 'ask',
      budgetActiveMs: 7_200_000, budgetToolCalls: 500, prompt: 'Fix it.', specVersion: 1, driverPid: 4242,
      worktree: { checkoutRoot: '/work/alpha', branch: 'agent-inbox/fix-1', baseSha: 'a'.repeat(40), baseRef: 'refs/heads/main' },
    })
    await bootApp(db)
    await changedPollTick(db)
    const bar = openLaunch(LAUNCH).querySelector('.sp-actions')!
    expect([...bar.children].map((el) => el.textContent))
      .toEqual(['Stop', 'Stop it to remove its worktree', 'Open in Terminal', 'Remove worktree…'])
    expect(action(LAUNCH, 'remove-worktree')!.title).toBe('Only once the session has ended')
    endLaunch(db, LAUNCH, { reason: 'stopped' })
    await changedPollTick(db)
    expect(panel().querySelector('.sp-actions-hint')).toBeNull()
    expect(action(LAUNCH, 'remove-worktree')!.disabled).toBe(false)
  })

  it('a plain browser shows no Remove worktree… on a card', async () => {
    db = freshDb()
    createLaunch(db, {
      id: LAUNCH, host: 'copilot', project: 'alpha', stream: 'agent-inbox/fix-1', cwd: '/w/alpha/fix-1', mode: 'ask',
      budgetActiveMs: 7_200_000, budgetToolCalls: 500, prompt: 'Fix it.', specVersion: 1, driverPid: 4242,
      worktree: { checkoutRoot: '/work/alpha', branch: 'agent-inbox/fix-1', baseSha: 'a'.repeat(40), baseRef: 'refs/heads/main' },
    })
    endLaunch(db, LAUNCH, { reason: 'stopped' })
    await bootApp(db)
    await changedPollTick(db)
    openFolds()
    expect(document.querySelector('[data-ah-action="remove-worktree"], [data-launch-action="remove-worktree"]')).toBeNull()
  })

  it('names a launch’s worktree and branch in its panel, and says when the worktree was removed (#432)', async () => {
    launchBridge()
    db = freshDb()
    createLaunch(db, {
      id: LAUNCH, host: 'copilot', project: 'alpha', stream: 'agent-inbox/fix-it-11111111', cwd: '/w/alpha/fix-it-11111111', mode: 'ask',
      budgetActiveMs: 7_200_000, budgetToolCalls: 500, prompt: 'Fix it.', specVersion: 1, driverPid: 4242,
      worktree: { checkoutRoot: '/work/alpha', branch: 'agent-inbox/fix-it-11111111', baseSha: 'a'.repeat(40), baseRef: 'refs/heads/main' },
    })
    newLaunch(db, PARKED)
    await bootApp(db)
    await changedPollTick(db)
    const box = () => [...panel().querySelectorAll('.sp-worktree-box dd')].map((el) => el.textContent)
    expect(openLaunch(PARKED).querySelector<HTMLElement>('.sp-worktree')?.hidden).toBe(true)
    openLaunch(LAUNCH)
    expect(box()).toEqual(['agent-inbox/fix-it-11111111', '/w/alpha/fix-it-11111111', 'Not read yet'])
    expect(launchRow(LAUNCH)!.querySelector('.sc-worktree')?.textContent).toBe('worktree')
    // the driver's turn-end summary, in words (#432 §6)
    recordWorktreeSummary(db, LAUNCH, { v: 1, at: new Date().toISOString(), head: 'b'.repeat(40), branch: 'agent-inbox/fix-it-11111111', ahead: 2, behind: 0, files: 3, dirty: 1 })
    await changedPollTick(db)
    expect(box()).toEqual(['agent-inbox/fix-it-11111111', '/w/alpha/fix-it-11111111', '2 commits ahead, 3 files changed, 1 uncommitted'])
    expect(launchRow(LAUNCH)!.querySelector('.sc-worktree')?.textContent).toBe('worktree · 2 ahead · 3 files · 1 uncommitted')
    markWorktreeRemoved(db, LAUNCH)
    await changedPollTick(db)
    expect(box()).toEqual(['Removed; its branch agent-inbox/fix-it-11111111 is kept.'])
  })

  it('lists a running launch with Stop and its transcript, and Stop goes through main', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    await bootApp(db)
    await changedPollTick(db)
    // running, its session between turns
    expect(stateOf(LAUNCH)).toBe('Idle')
    expect(openLaunch(LAUNCH).querySelector('.dash-focus-meta')?.textContent)
      .toBe('Copilot · started here · Ask for everything · claude-haiku-4.5 · 0 of 500 tool calls · 0m of 2h active')
    expect(panel().querySelector<HTMLElement>('.sp-transcript')?.hidden).toBe(false)
    click(action(LAUNCH, 'stop'))
    await settle()
    expect(api.stop).toHaveBeenCalledWith(LAUNCH)
  })

  it('Park now asks the driver to park, says so, and the launch then offers Resume and send (PR 4)', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    const bridge = await bootApp(db)
    await changedPollTick(db)
    click(action(LAUNCH, 'park'))
    await settle()
    expect(bridge.posts.map((p) => p.url)).toContain(`/api/launches/${LAUNCH}/park`)
    expect(panel().querySelector('.sp-note')?.textContent).toMatch(/^Parking: Copilot stops once its turn ends/)
    // the driver parks as the idle timeout would
    parkLaunch(db, LAUNCH, { acpSession: 'acp-1', activeMs: 10, toolCalls: 1 })
    await changedPollTick(db)
    expect(stateOf(LAUNCH)).toBe('Parked')
    expect(panel().querySelector<HTMLElement>('.sp-note')?.hidden).toBe(true)
    // Resume and send stands in for the composer
    expect(panel().querySelector<HTMLElement>('.sp-resume')?.hidden).toBe(false)
    expect(launchRow(LAUNCH)!.querySelector('[data-ah-action="resume"]')?.textContent).toBe('Resume…')
  })

  it('Take over in Terminal goes through main, then the card says it is in Terminal and offers Resume in Terminal (step 5)', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    newLaunch(db, PARKED)
    parkLaunch(db, PARKED, { acpSession: null, activeMs: 0, toolCalls: 0 })
    await bootApp(db)
    await changedPollTick(db)
    expect(action(LAUNCH, 'take-over')?.textContent).toBe('Take over in Terminal')
    // a parked launch never prompted has no session for a terminal to resume
    expect(action(PARKED, 'take-over')).toBeNull()
    let finish!: (value: Record<string, unknown>) => void
    api.takeOver.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    click(action(LAUNCH, 'take-over'))
    await settle()
    expect(api.takeOver).toHaveBeenCalledWith(LAUNCH)
    expect(action(LAUNCH, 'take-over')?.textContent).toBe('Handing off…')
    finish({ ok: false, error: 'The session did not hand off within a minute, so it goes on here. Try again, or Stop it.' })
    await settle()
    expect(panel().querySelector('.sp-note')?.textContent).toMatch(/did not hand off within a minute/)
    api.takeOver.mockResolvedValueOnce({ ok: false, cancelled: true, error: 'Not taken over.' })
    click(action(LAUNCH, 'take-over'))
    await settle()
    expect(panel().textContent).not.toContain('Not taken over.')
    // the driver handed it off
    handOffLaunch(db, LAUNCH, { acpSession: 'acp-1', activeMs: 10, toolCalls: 1 })
    await changedPollTick(db)
    expect(stateOf(LAUNCH)).toBe('In Terminal')
    expect(doingOf(LAUNCH)).toBe('was: Handed off to a terminal: it goes on in Copilot there. · 1 of 500 tool calls')
    expect(panel().querySelector<HTMLElement>('.sp-note')?.hidden).toBe(true)
    expect(action(LAUNCH, 'take-over')?.textContent).toBe('Resume in Terminal')
    expect(action(LAUNCH, 'stop')).toBeNull()
    expect(panel().querySelector<HTMLElement>('.sp-resume')?.hidden).toBe(true)
    expect(panel().querySelector<HTMLElement>('.sp-transcript')?.hidden).toBe(false)
    click(action(LAUNCH, 'take-over'))
    await settle()
    expect(api.takeOver).toHaveBeenLastCalledWith(LAUNCH)
  })

  it('reads a running launch with no session for two minutes as not responding, and offers Close', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    await bootApp(db)
    await changedPollTick(db)
    expect(stateOf(LAUNCH)).toBe('Starting…')
    await vi.advanceTimersByTimeAsync(150_000)
    await changedPollTick(db)
    expect(stateOf(LAUNCH)).toBe('Not responding')
    expect(launchRow(LAUNCH)!.querySelector('[data-ah-action="close"]')?.textContent).toBe('Close')
    click(action(LAUNCH, 'close'))
    await settle()
    expect(api.close).toHaveBeenCalledWith(LAUNCH)
  })

  it('Resume and send asks main to resume, waits for the session, then sends the message to it', async () => {
    const lease = { launchId: PARKED, pid: 4243, nonce: 'r' }
    const api = launchBridge()
    db = freshDb()
    newLaunch(db, PARKED)
    parkLaunch(db, PARKED, { acpSession: 'acp-1', activeMs: 10, toolCalls: 2 })
    api.resume.mockImplementation(async () => {
      drivenSession(db!, 'mcp-9', lease)
      return { ok: true, launch: PARKED }
    })
    const bridge: ViewerBridge = await bootApp(db)
    await changedPollTick(db)
    expect(stateOf(PARKED)).toBe('Parked')
    // the card's Resume… opens the session panel at its Resume and send (#454)
    click(launchRow(PARKED)!.querySelector('[data-ah-action="resume"]'))
    await settle()
    expect(panel().hidden).toBe(false)
    const box = panel().querySelector<HTMLTextAreaElement>('.sp-resume-input')!
    expect(document.activeElement).toBe(box)
    // Resume and send stands in for the composer
    expect(panel().querySelector<HTMLElement>('.dash-focus-message')?.hidden).toBe(true)
    expect(panelAction('resume')!.disabled).toBe(true)
    type(box, 'Now run the linter too.')
    expect(panelAction('resume')!.disabled).toBe(false)
    click(panelAction('resume'))
    await settle()
    await settle()
    expect(api.resume).toHaveBeenCalledWith(PARKED)
    expect(bridge.posts.some((p) => p.url === '/api/sessions/mcp-9/messages')).toBe(true)
    expect(listSessionMessages(db).open.map((m) => [m.session, m.text])).toEqual([['mcp-9', 'Now run the linter too.']])
  })

  it('a launch stopped with its session offers Resume and send and Take over in Terminal (step 5, full resume)', async () => {
    const lease = { launchId: PARKED, pid: 4243, nonce: 'r' }
    const api = launchBridge()
    db = freshDb()
    newLaunch(db, PARKED)
    endLaunch(db, PARKED, { reason: 'stopped', acpSession: 'acp-1' })
    api.resume.mockImplementation(async () => {
      drivenSession(db!, 'mcp-9', lease)
      return { ok: true, launch: PARKED }
    })
    await bootApp(db)
    await changedPollTick(db)
    expect(stateOf(PARKED)).toBe('Parked')
    expect(doingOf(PARKED)).toBe('Stopped: its session is kept, so it can be resumed.')
    click(launchRow(PARKED)!.querySelector('[data-ah-action="resume"]'))
    await settle()
    expect(panelAction('take-over')?.textContent).toBe('Take over in Terminal')
    type(panel().querySelector<HTMLTextAreaElement>('.sp-resume-input')!, 'Carry on.')
    click(panelAction('resume'))
    await settle()
    await settle()
    expect(api.resume).toHaveBeenCalledWith(PARKED)
    expect(listSessionMessages(db).open.map((m) => [m.session, m.text])).toEqual([['mcp-9', 'Carry on.']])
  })

  it('the transcript is a section of the session panel, read while the panel shows it, as plain text (#454)', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    const dir = join(dirname(db.name), 'launches', LAUNCH)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'events.ndjson'), [
      { event: 'prompt', kind: 'task' },
      { event: 'agent_text', text: 'Looking at <b>the</b> ' },
      { event: 'agent_text', text: 'tests.' },
      { event: 'permission_request', id: 7, tool: 'npm test', allow: 'allow_once' },
      { event: 'permission_answer', id: 7, answer: 'allow_once' },
    ].map((e) => `${JSON.stringify(e)}\n`).join(''))
    await bootApp(db)
    await changedPollTick(db)
    // the card's Transcript opens the panel there; no modal dialog any more
    click(launchRow(LAUNCH)!.querySelector('[data-ah-action="transcript"]'))
    await settle()
    expect(document.querySelector('dialog.launch-transcript')).toBeNull()
    expect(panel().hidden).toBe(false)
    expect(panelLines()).toEqual(['The task was sent.', 'Looking at <b>the</b> tests.', 'Asked to allow npm test', 'Allowed once'])
    expect([...panel().querySelectorAll('.sp-transcript .tx-k')].map((el) => el.textContent)).toEqual(['Note', 'Agent', 'Ask', 'Answer'])
    expect(panel().querySelector('.sp-transcript b')).toBeNull()
    appendFileSync(join(dir, 'events.ndjson'), `${JSON.stringify({ event: 'ended', reason: 'stopped' })}\n`)
    await vi.advanceTimersByTimeAsync(2100)
    await settle()
    expect(panelLines().at(-1)).toBe('Session ended (stopped).')
    // closed, the panel reads nothing more
    click(panel().querySelector('.dash-focus-close'))
    const spy = vi.spyOn(window, 'fetch')
    await vi.advanceTimersByTimeAsync(6000)
    const reads = spy.mock.calls.map(([input]) => String(input))
    spy.mockRestore()
    expect(reads.filter((url) => url.includes('/events'))).toEqual([])
  })
})

describe('New session (§8)', () => {
  it('a session started outside the project lens scopes the lens to it, so its card shows (#460 review)', async () => {
    const api = launchBridge()
    db = freshDb()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: 'seen', repo_root: '/work/alpha' })
    insertItem(db, { project: 'beta', stream: 'main', agent: 'copilot', kind: 'note', title: 'seen too', repo_root: '/work/beta' })
    api.start.mockImplementationOnce(async () => {
      newLaunch(db!)
      return { ok: true, launch: LAUNCH }
    })
    await bootApp(db)
    click(document.querySelector('#rail .rail-tab[data-project="beta"]'))
    await settle()
    await changedPollTick(db)
    click(newSessionButton())
    await settle()
    const dialog = document.querySelector<HTMLDialogElement>('.launch-dialog')!
    dialog.querySelector<HTMLSelectElement>('select[name="root"]')!.value = '/work/alpha'
    type(dialog.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]'), 'Fix it.')
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    await settle()
    expect(api.start).toHaveBeenCalled()
    expect(launchRow(LAUNCH)).not.toBeNull()
    expect(document.querySelector('#rail .rail-tab[data-project="alpha"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('says how many sessions the lens hides, and Show all clears it (#460 review)', async () => {
    launchBridge()
    db = freshDb()
    insertItem(db, { project: 'beta', stream: 'main', agent: 'copilot', kind: 'note', title: 'seen', repo_root: '/work/beta' })
    newLaunch(db)
    newLaunch(db, PARKED)
    endLaunch(db, PARKED, { reason: 'stopped' })
    await bootApp(db)
    await changedPollTick(db)
    const line = () => document.querySelector<HTMLElement>('.agents-home .ah-outside')!
    expect(line().hidden).toBe(true)
    click(document.querySelector('#rail .rail-tab[data-project="beta"]'))
    await settle()
    // the running one is hidden; an ended one never counts
    expect(line().hidden).toBe(false)
    expect(line().textContent).toBe('1 session outside this filter · Show all')
    expect(anyCard(`launch:${LAUNCH}`)).toBeNull()
    click(line().querySelector('.ah-outside-all'))
    await settle()
    expect(line().hidden).toBe(true)
    expect(anyCard(`launch:${LAUNCH}`)).not.toBeNull()
  })

  it('sends main the request it checks again, with a known project, and never a path of its own', async () => {
    const api = launchBridge()
    db = freshDb()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: 'seen', repo_root: '/work/alpha' })
    await bootApp(db)
    await changedPollTick(db)
    click(newSessionButton())
    await settle()
    const dialog = document.querySelector<HTMLDialogElement>('.launch-dialog')!
    const project = dialog.querySelector<HTMLSelectElement>('select[name="root"]')!
    expect([...project.options].map((o) => o.value)).toEqual(['/work/alpha', ''])
    expect(dialog.textContent).toContain('Once any shell command is allowed')
    dialog.querySelector<HTMLInputElement>('input[value="plan"]')!.checked = true
    type(dialog.querySelector<HTMLInputElement>('input[name="model"]'), 'claude-haiku-4.5')
    const effort = dialog.querySelector<HTMLSelectElement>('select[name="effort"]')!
    effort.value = 'none'
    type(dialog.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]'), 'Fix the failing test.')
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    // #432: New worktree is on by default, and the page asks for it, naming no path or branch
    expect(api.start).toHaveBeenCalledWith({
      root: '/work/alpha', mode: 'plan', model: 'claude-haiku-4.5', reasoningEffort: 'none',
      budgets: { activeMs: 7_200_000, toolCalls: 500 }, prompt: 'Fix the failing test.', worktree: true,
      // this start's tag, which main echoes with its phases (#432 PR 5 review)
      startId: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(document.querySelector('.launch-dialog')).toBeNull()
  })

  it('stays open after Start, saying each phase main reports, and closes once Copilot is set up (#432 PR 5)', async () => {
    const api = launchBridge()
    let finish!: (result: { ok: boolean; launch?: string; error?: string }) => void
    api.start.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as never }))
    db = freshDb()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: 'seen', repo_root: '/work/alpha' })
    await bootApp(db)
    await changedPollTick(db)
    click(newSessionButton())
    await settle()
    const dialog = document.querySelector<HTMLDialogElement>('.launch-dialog')!
    type(dialog.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]'), 'Fix it.')
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    const message = () => dialog.querySelector('.launch-dialog-message')!.textContent
    expect(message()).toBe('Agent Inbox is asking you to confirm…')
    for (const [phase, text] of [
      ['environment', 'Reading your shell environment…'], ['runtime', 'Checking the runtime…'],
      ['worktree', 'Creating the worktree…'], ['copilot', 'Starting Copilot…'],
    ]) {
      progress!(phase!, LAUNCH, startTag(api))
      expect(message()).toBe(text)
    }
    expect(document.querySelector('.launch-dialog')).not.toBeNull()
    finish({ ok: false, error: 'Copilot refused to start the session: no such model.' })
    await settle()
    expect(message()).toBe('Copilot refused to start the session: no such model.')
    expect(api.onStartProgress).toHaveBeenLastCalledWith(null)
    // started: the dialog closes
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(document.querySelector('.launch-dialog')).toBeNull()
  })

  // review of #449: a start in flight belongs to its dialog until main answers
  async function startPending(api: ReturnType<typeof launchBridge>) {
    let finish!: (result: { ok: boolean; launch?: string; error?: string }) => void
    api.start.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as never }))
    db = freshDb()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: 'seen', repo_root: '/work/alpha' })
    await bootApp(db)
    await changedPollTick(db)
    click(newSessionButton())
    await settle()
    const dialog = document.querySelector<HTMLDialogElement>('.launch-dialog')!
    type(dialog.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]'), 'Fix it.')
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    return { dialog, finish: async (result: { ok: boolean; launch?: string; error?: string }) => { finish(result); await settle() } }
  }

  it('Cancel during a start is Stop starting: it stops the launch once main names it, and Escape does nothing', async () => {
    const api = launchBridge()
    const { dialog, finish } = await startPending(api)
    const cancel = buttonLabelled('Stop starting', dialog)!
    const escape = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    progress!('environment', LAUNCH, startTag(api))
    click(cancel)
    expect(dialog.querySelector('.launch-dialog-message')!.textContent).toBe('Stopping the start…')
    expect(cancel.disabled).toBe(true)
    // no row yet: the Stop goes once the launch is named with its row, at 'copilot'
    expect(api.stop).not.toHaveBeenCalled()
    progress!('runtime', LAUNCH, startTag(api))
    progress!('copilot', LAUNCH, startTag(api))
    expect(api.stop).toHaveBeenCalledWith(LAUNCH)
    expect(dialog.querySelector('.launch-dialog-message')!.textContent).toBe('Stopping the start…')
    expect(document.querySelector('.launch-dialog')).toBe(dialog)
    await finish({ ok: false, error: 'It was stopped before the session started.' })
    expect(dialog.querySelector('.launch-dialog-message')!.textContent).toBe('It was stopped before the session started.')
    expect(buttonLabelled('Cancel', dialog)!.disabled).toBe(false)
    // and once the launch is named, Stop starting stops it at once
    let again!: (result: { ok: boolean; error?: string }) => void
    api.start.mockImplementationOnce(() => new Promise((resolve) => { again = resolve as never }))
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    progress!('copilot', PARKED, startTag(api))
    click(buttonLabelled('Stop starting', dialog))
    expect(api.stop).toHaveBeenLastCalledWith(PARKED)
    again({ ok: false, error: 'It was stopped before the session started.' })
    await settle()
  })

  it('phases of another start (one an earlier load of the page made) never bind this dialog’s Stop starting', async () => {
    const api = launchBridge()
    const { dialog, finish } = await startPending(api)
    const mine = startTag(api)
    const OTHER = '11111111-2222-4333-8444-999999999999'
    // start A, from before a reload, reaches its 'copilot' phase while this dialog's start B runs
    progress!('copilot', OTHER, 'a'.repeat(32))
    progress!('copilot', OTHER)
    expect(dialog.querySelector('.launch-dialog-message')!.textContent).toBe('Agent Inbox is asking you to confirm…')
    click(buttonLabelled('Stop starting', dialog))
    expect(api.stop).not.toHaveBeenCalled()
    // B's own phase names B, and only B is stopped
    progress!('copilot', LAUNCH, mine)
    expect(api.stop).toHaveBeenCalledTimes(1)
    expect(api.stop).toHaveBeenCalledWith(LAUNCH)
    await finish({ ok: false, error: 'It was stopped before the session started.' })
  })

  it('a second New session cannot open while a start is in flight', async () => {
    const api = launchBridge()
    const { dialog, finish } = await startPending(api)
    const button = newSessionButton()!
    expect(button.disabled).toBe(true)
    click(button)
    await settle()
    expect(document.querySelectorAll('.launch-dialog')).toHaveLength(1)
    await finish({ ok: true, launch: LAUNCH })
    expect(document.querySelector('.launch-dialog')).toBeNull()
    expect(dialog.isConnected).toBe(false)
    expect(button.disabled).toBe(false)
  })

  it('a start that finishes after its dialog was closed touches no other dialog, draft or listener', async () => {
    const api = launchBridge()
    const { dialog, finish } = await startPending(api)
    // the switch goes off mid-start: the dialog closes; the start goes on in main
    const toggle = document.querySelector<HTMLInputElement>('#launch-switch')!
    toggle.checked = false
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(dialog.isConnected).toBe(false)
    // a listener someone else registered meanwhile stays
    const other = vi.fn()
    progress = other
    const before = api.onStartProgress.mock.calls.length
    await finish({ ok: true, launch: LAUNCH })
    expect(api.onStartProgress.mock.calls.length - before).toBe(1)
    expect(api.onStartProgress).toHaveBeenLastCalledWith(null)
    // the typed task was not the started dialog's to drop: the next New session has it
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    await changedPollTick(db!)
    click(newSessionButton())
    await settle()
    expect(document.querySelector<HTMLTextAreaElement>('.launch-dialog textarea[name="prompt"]')!.value).toBe('Fix it.')
  })

  it('offers New worktree, ticked; unticked, the request runs in the folder as before (#432)', async () => {
    const api = launchBridge()
    db = freshDb()
    await bootApp(db)
    await changedPollTick(db)
    click(newSessionButton())
    await settle()
    const dialog = document.querySelector<HTMLDialogElement>('.launch-dialog')!
    const box = dialog.querySelector<HTMLInputElement>('input[name="worktree"]')!
    expect(box.checked).toBe(true)
    expect(box.closest('label')!.textContent).toContain('New worktree')
    expect(box.closest('label')!.textContent).toContain('Uncommitted changes stay in your checkout.')
    box.checked = false
    type(dialog.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]'), 'Do it.')
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(api.start.mock.calls[0]![0]).not.toHaveProperty('worktree')
  })

  it('keeps the task and says why when the request is not valid or main refuses it', async () => {
    const api = launchBridge()
    api.start.mockResolvedValueOnce({ ok: false, error: 'Not started.', cancelled: true } as never)
    api.chooseFolder.mockResolvedValue({ ok: true, folder: '/work/alpha', project: 'alpha', repository: true })
    db = freshDb()
    await bootApp(db)
    await changedPollTick(db)
    click(newSessionButton())
    await settle()
    const dialog = document.querySelector<HTMLDialogElement>('.launch-dialog')!
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(dialog.querySelector('.launch-dialog-message')!.textContent).toBe('Describe the task.')
    type(dialog.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]'), 'Do it.')
    // the typed task is a draft: a tick with new data waits for it, like any draft
    await changedPollTick(db)
    expect(document.getElementById('pauseHint')?.textContent ?? '').toMatch(/paused/)
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ root: '/work/alpha', mode: 'ask', prompt: 'Do it.' }))
    expect(dialog.querySelector('.launch-dialog-message')!.textContent).toBe('Not started.')
    expect(dialog.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')!.value).toBe('Do it.')
    // Cancel keeps the task for the next dialog, and it no longer pauses the list
    click(buttonLabelled('Cancel', dialog))
    await settle()
    expect(document.querySelector('.launch-dialog')).toBeNull()
    await changedPollTick(db)
    expect(document.getElementById('pauseHint')?.textContent ?? '').not.toMatch(/paused/)
    click(newSessionButton())
    await settle()
    expect(document.querySelector<HTMLTextAreaElement>('.launch-dialog textarea[name="prompt"]')!.value).toBe('Do it.')
  })
})

describe('Approve on an @sessions ask (§4.3)', () => {
  function launchAsk(d: Database.Database): string {
    newLaunch(d)
    return fileLaunchAsk(d, LAUNCH, {
      project: '@sessions', stream: 'alpha · main', agent: 'copilot', kind: 'question', title: 'Allow copilot to run `npm test`?',
      detail: 'A session Agent Inbox drives is waiting for your approval.', next_step: 'Approve or decline in the Agent Inbox app.',
      action_owner: 'approval', impact: 'The agent waits until you answer.',
      options: [{ label: 'Allow once', detail: 'Lets this one tool call run.' }, { label: 'Deny', detail: 'Declining stops the agent’s current turn.' }],
    }, [{ optionId: 'allow_once', label: 'Allow once' }, { optionId: 'reject_once', label: 'Deny' }]).itemId
  }

  it('in the app’s own window, a choice goes to main, which signs it; the reply route is never called', async () => {
    const api = launchBridge()
    db = freshDb()
    const id = launchAsk(db)
    const bridge = await bootApp(db)
    await changedPollTick(db)
    click(row(id))
    await settle()
    click(buttonLabelled('Deny', row(id)!))
    await settle()
    expect(api.approve).toHaveBeenCalledWith({ item: id, revision: 0, optionId: 'reject_once' })
    expect(bridge.posts.filter((p) => p.url.includes(`/api/items/${id}`))).toEqual([])
  })

  it.each([
    ['context typed for it', { text: '', context: 'Careful with the cache.' }],
    ['its option typed as an answer', { text: 'Allow once', context: '' }],
  ])('text kept from before (%s) waits in the unsent responses, never pauses the list, and an approval still lands (review of #431)', async (_, typed) => {
    const api = launchBridge()
    db = freshDb()
    const id = launchAsk(db)
    // text an earlier page kept for this ask, when approval cards still had text boxes
    localStorage.setItem('agent-inbox-drafts-v1', JSON.stringify({ v: 1, entries: {
      [`reply:${id}`]: { savedAt: Date.now(), draft: { type: 'reply', itemId: id, title: 'Allow copilot to run `npm test`?', ...typed, answer: { at: null, source: null, kind: null, text: null }, intent: null } },
    } }))
    await bootApp(db)
    await changedPollTick(db)
    expect(document.getElementById('pauseHint')?.textContent ?? '').toBe('')
    expect(document.querySelector('#needsYouList .stale-drafts-fold')?.textContent).toContain('Not sent: this approval takes only its own options.')
    click(row(id))
    await settle()
    click(buttonLabelled('Allow once', row(id)!))
    await settle()
    expect(api.approve).toHaveBeenCalledWith({ item: id, revision: 0, optionId: 'allow_once' })
    for (let i = 0; i < 3; i++) await changedPollTick(db)
    expect(document.getElementById('pauseHint')?.textContent ?? '').toBe('')
    // the driver settles the ask
    resolveItem(db, id)
    await changedPollTick(db)
    expect(row(id)).toBeNull()
    expect(document.getElementById('pauseHint')?.textContent ?? '').toBe('')
  })

  it('anywhere else the route refuses it, with the plain message', async () => {
    const api = launchBridge({ available: false })
    db = freshDb()
    const id = launchAsk(db)
    await bootApp(db)
    await changedPollTick(db)
    click(row(id))
    await settle()
    click(buttonLabelled('Allow once', row(id)!))
    await settle()
    expect(api.approve).not.toHaveBeenCalled()
    expect(row(id)!.querySelector('.write-error')?.textContent).toBe('Not sent — approve this from Agent Inbox’s own window.')
    expect(getItem(db, id)!.reply).toBeNull()
  })
})

describe('the composer’s Queued states and Interrupt and send (§5.3)', () => {
  it('says the message is queued mid-task or behind an approval, and Interrupt and send sends then interrupts', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    markDriverTurn(db, LEASE, 'turn', new Date(Date.now() - 12 * 60_000).toISOString())
    const bridge = await bootApp(db)
    await changedPollTick(db)
    click(launchRow(LAUNCH)!.querySelector('[data-ah-action="message"]'))
    await settle()
    const el = composer('mcp-1')!
    expect(el.querySelector('.msg-delivery')!.textContent).toBe('Queued: it’s mid-task (12m). It arrives when the turn ends.')
    markDriverTurn(db, LEASE, 'approval', new Date(Date.now() - 12 * 60_000).toISOString())
    await changedPollTick(db)
    expect(el.querySelector('.msg-delivery')!.textContent).toBe('Queued: it’s waiting on your approval. It arrives when the turn ends.')
    const interrupt = el.querySelector<HTMLButtonElement>('.msg-interrupt')!
    expect(interrupt.disabled).toBe(true)
    type(el.querySelector('textarea'), 'Stop and run lint instead.')
    expect(interrupt.disabled).toBe(false)
    click(interrupt)
    await settle()
    await settle()
    const posted = bridge.posts.map((p) => p.url)
    expect(posted.indexOf('/api/sessions/mcp-1/messages')).toBeGreaterThan(-1)
    expect(posted.indexOf(`/api/launches/${LAUNCH}/interrupt`)).toBeGreaterThan(posted.indexOf('/api/sessions/mcp-1/messages'))
    markDriverTurn(db, LEASE, null)
    await changedPollTick(db)
    expect(el.querySelector('.msg-delivery')!.textContent).toBe('Arrives now: Agent Inbox runs this session.')
    expect(el.querySelector('.msg-interrupt')).toBeNull()
  })
})

describe('session cards for launches (#454, #412)', () => {
  function working(d: Database.Database, session: string, lease: { launchId: string; pid: number; nonce: string }) {
    upsertActivity(d, { session, project: 'alpha', stream: 'main', agent: 'copilot', doing: 'Fixing the test', idle: false, claim: true, receives_messages: true })
    recordActivityCall(d, session)
    claimDriverSlot(d, lease, 3)
    holdDriverLeases(d, lease, [session])
  }
  const card = (id: string) => [...document.querySelectorAll<HTMLElement>('[data-session-card]')].find((el) => el.dataset.sessionCard === id) ?? null
  const actions = (id: string) => [...card(id)?.querySelectorAll<HTMLButtonElement>('[data-ah-action]') ?? []].map((b) => b.textContent)
  const cardAction = (id: string, name: string) => card(id)?.querySelector<HTMLButtonElement>(`[data-ah-action="${name}"]`) ?? null

  it('joins a launch and its driven session into one “started here” card; another driver’s session is “driven”', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    working(db, 'mcp-1', LEASE)
    recordLaunchProgress(db, LAUNCH, { sessions: ['mcp-1'] })
    // a terminal driver's session: driven, but no launch of this app
    working(db, 'mcp-2', { launchId: PARKED, pid: 4244, nonce: 't' })
    await bootApp(db)
    await pollTick()
    await changedPollTick(db)
    await settle()
    expect(card(`launch:${LAUNCH}`)?.querySelector<HTMLElement>('.sc-agent')?.title).toBe('Copilot · started here')
    expect(card(`launch:${LAUNCH}`)?.querySelector('.sc-here')?.textContent).toBe('A')
    expect(card(`launch:${LAUNCH}`)?.querySelector('.sc-state')?.textContent).toBe('Working')
    expect(actions(`launch:${LAUNCH}`)).toEqual(['Message'])
    expect(card('session:mcp-1')).toBeNull()
    expect(card('session:mcp-2')?.querySelector('.sc-origin')?.textContent).toBe('driven')
  })

  it('a parked launch offers Take over and Resume…, which opens its Resume and send, focused', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    parkLaunch(db, LAUNCH, { acpSession: 'acp-1', activeMs: 10, toolCalls: 3 })
    await bootApp(db)
    await changedPollTick(db)
    await settle()
    const id = `launch:${LAUNCH}`
    expect(card(id)?.querySelector('.sc-state')?.textContent).toBe('Parked')
    expect(actions(id)).toEqual(['Take over in Terminal', 'Resume…'])
    click(cardAction(id, 'resume'))
    await settle()
    expect(panel().hidden).toBe(false)
    expect(document.activeElement).toBe(panel().querySelector('.sp-resume-input'))
    click(cardAction(id, 'take-over'))
    await settle()
    expect(api.takeOver).toHaveBeenCalledWith(LAUNCH)
  })

  it('Resume… on a resumable launch past the newest five still lands on its Resume and send (#458 review)', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    parkLaunch(db, LAUNCH, { acpSession: 'acp-1', activeMs: 10, toolCalls: 3 })
    endLaunch(db, LAUNCH, { reason: 'stopped' })
    for (let n = 0; n < 5; n++) {
      advanceClock()
      const id = `11111111-2222-4333-8444-${String(800 + n).padStart(12, '0')}`
      newLaunch(db, id)
      endLaunch(db, id, { reason: 'stopped' })
    }
    await bootApp(db)
    await changedPollTick(db)
    await settle()
    const id = `launch:${LAUNCH}`
    expect(card(id)?.querySelector('.sc-state')?.textContent).toBe('Parked')
    // the drawer lists the newest five ended launches only; the session panel draws any launch (#454)
    click(cardAction(id, 'resume'))
    await settle()
    expect(panel().hidden).toBe(false)
    expect(document.activeElement).toBe(panel().querySelector('.sp-resume-input'))
  })

  it('folds an ended launch under Ended, whose card opens its transcript', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    endLaunch(db, LAUNCH, { reason: 'stopped' })
    await bootApp(db)
    await changedPollTick(db)
    await settle()
    const fold = document.querySelector<HTMLDetailsElement>('.agents-home [data-ah-fold="ended"]')!
    expect([fold.hidden, fold.querySelector('summary')?.textContent]).toEqual([false, 'Ended (1)'])
    fold.open = true
    fold.dispatchEvent(new Event('toggle'))
    expect(actions(`launch:${LAUNCH}`)).toEqual(['Transcript'])
    click(cardAction(`launch:${LAUNCH}`, 'transcript'))
    await settle()
    expect(panel().hidden).toBe(false)
    expect(panel().querySelector<HTMLElement>('.sp-transcript')?.hidden).toBe(false)
  })

  it('keeps the launches past the newest five under Earlier sessions, inside Ended', async () => {
    launchBridge()
    db = freshDb()
    const ids = Array.from({ length: 6 }, (_, i) => `11111111-2222-4333-8444-${String(900 + i).padStart(12, '0')}`)
    for (const id of ids) {
      newLaunch(db, id)
      endLaunch(db, id, { reason: 'stopped' })
      advanceClock()
    }
    await bootApp(db)
    await changedPollTick(db)
    await settle()
    const ended = document.querySelector<HTMLDetailsElement>('.agents-home [data-ah-fold="ended"]')!
    const earlier = document.querySelector<HTMLDetailsElement>('.agents-home [data-ah-fold="earlier"]')!
    expect(ended.querySelector('summary')?.textContent).toBe('Ended (5) · Earlier sessions (1)')
    ended.open = true
    ended.dispatchEvent(new Event('toggle'))
    expect(ended.querySelectorAll(':scope > .ah-cards > [data-session-card]')).toHaveLength(5)
    expect(earlier.querySelectorAll('[data-session-card]')).toHaveLength(0)
    earlier.open = true
    earlier.dispatchEvent(new Event('toggle'))
    expect([...earlier.querySelectorAll<HTMLElement>('[data-session-card]')].map((el) => el.dataset.sessionCard)).toEqual([`launch:${ids[0]}`])
  })

  it('the panel carries the launch’s action bar, its worktree and its approval, answered in place (#454 Q3)', async () => {
    const api = launchBridge()
    db = freshDb()
    createLaunch(db, {
      id: LAUNCH, host: 'copilot', project: 'alpha', stream: 'main', cwd: '/work/wt/fix-it', mode: 'ask', model: 'claude-haiku-4.5',
      budgetActiveMs: 7_200_000, budgetToolCalls: 500, prompt: 'Fix it.', specVersion: 1, driverPid: 4242,
      worktree: { checkoutRoot: '/work/alpha', branch: 'agent-inbox/fix-it', baseSha: 'a'.repeat(40), baseRef: 'refs/heads/main' },
    })
    recordWorktreeSummary(db, LAUNCH, { v: 1, at: new Date().toISOString(), head: 'b'.repeat(40), branch: 'agent-inbox/fix-it', ahead: 2, behind: 0, files: 3, dirty: 1 })
    drivenSession(db)
    recordLaunchProgress(db, LAUNCH, { sessions: ['mcp-1'] })
    const ask = fileLaunchAsk(db, LAUNCH, {
      project: '@sessions', stream: 'alpha · main', agent: 'copilot', kind: 'question', session: 'mcp-1', title: 'Allow shell: npm test',
      action_owner: 'approval', options: [{ label: 'Allow once' }, { label: 'Deny' }],
    }, [{ optionId: 'allow_once', label: 'Allow once' }, { optionId: 'reject_once', label: 'Deny' }])
    await bootApp(db)
    await changedPollTick(db)
    await settle()
    const id = `launch:${LAUNCH}`
    expect(card(id)?.querySelector('.sc-state')?.textContent).toBe('Needs you')
    click(cardAction(id, 'review'))
    await settle()
    expect(panel().querySelector('.sp-state')?.textContent).toBe('Needs you')
    expect([...panel().querySelectorAll('.sp-actions [data-launch-action]')].map((b) => [b.textContent, (b as HTMLButtonElement).disabled]))
      .toEqual([['Stop', false], ['Park now', false], ['Take over in Terminal', false], ['Open in Terminal', false], ['Remove worktree…', true]])
    expect([...panel().querySelectorAll('.sp-worktree-box dd')].map((el) => el.textContent))
      .toEqual(['agent-inbox/fix-it', '/work/wt/fix-it', '2 commits ahead, 3 files changed, 1 uncommitted'])
    // the approval: its own options only, no editor, and the shell warning; the card's one ask, as its count says
    const appr = panel().querySelector<HTMLElement>('.sp-approval')!
    expect(appr.querySelector('.sp-appr-title')?.textContent).toBe('Allow shell: npm test')
    expect(appr.querySelector('.sp-approval-count')?.textContent).toMatch(/^1 open/)
    expect(appr.querySelector('textarea, input')).toBeNull()
    // Review lands on the heading, never on an option a stray Space or held Enter would press
    expect(document.activeElement).toBe(appr.querySelector('h3'))
    expect(document.activeElement?.closest('.sp-option')).toBeNull()
    click([...appr.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Deny'))
    await settle()
    await settle()
    expect(api.approve).toHaveBeenCalledWith({ item: ask.itemId, revision: ask.revision, optionId: 'reject_once' })
    // Stop in the bar is the drawer's own handler
    click(panelAction('stop'))
    await settle()
    expect(api.stop).toHaveBeenCalledWith(LAUNCH)
  })

  it('holds every option while an answer is in flight and just after, so the next approval never answers unseen', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    recordLaunchProgress(db, LAUNCH, { sessions: ['mcp-1'] })
    const file = (title: string) => fileLaunchAsk(db!, LAUNCH, {
      project: '@sessions', stream: 'alpha · main', agent: 'copilot', kind: 'question', session: 'mcp-1', title,
      action_owner: 'approval', options: [{ label: 'Allow once' }, { label: 'Deny' }],
    }, [{ optionId: 'allow_once', label: 'Allow once' }, { optionId: 'reject_once', label: 'Deny' }])
    const first = file('Allow shell: npm test')
    advanceClock()
    const second = file('Allow shell: rm -rf build')
    let finish!: (value: { ok: boolean }) => void
    api.approve.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await bootApp(db)
    await changedPollTick(db)
    await settle()
    click(cardAction(`launch:${LAUNCH}`, 'review'))
    await settle()
    const option = (item: string, label: string) => [...panel().querySelectorAll<HTMLButtonElement>('.sp-appr')]
      .find((el) => el.dataset.focusApproval === item)?.querySelector<HTMLButtonElement>(`.sp-option:nth-of-type(${label === 'Allow once' ? 1 : 2})`) ?? null
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    option(first.itemId, 'Allow once')!.focus()
    click(option(first.itemId, 'Allow once'))
    await settle()
    // in flight: the other approval's options are held, and focus stays in the panel
    expect(option(second.itemId, 'Allow once')?.getAttribute('aria-disabled')).toBe('true')
    expect(panel().contains(document.activeElement)).toBe(true)
    click(option(second.itemId, 'Allow once'))
    // the driver settles the first; the page repaints with the second one in its place
    settleLaunchAsk(db, first.itemId, 'Allowed once')
    finish({ ok: true })
    await settle()
    await settle()
    expect(option(first.itemId, 'Allow once')).toBeNull()
    // the answered block is gone: focus falls to the Approval heading, never out of the panel
    expect(document.activeElement).toBe(panel().querySelector('.sp-approval h3'))
    // a click landing on where the first one's option was, just after the repaint, answers nothing
    expect(option(second.itemId, 'Allow once')?.getAttribute('aria-disabled')).toBe('true')
    click(option(second.itemId, 'Allow once'))
    await settle()
    expect(api.approve).toHaveBeenCalledTimes(1)
    expect(api.approve).toHaveBeenCalledWith({ item: first.itemId, revision: first.revision, optionId: 'allow_once' })
    // after the calm, it answers as any option does
    await vi.advanceTimersByTimeAsync(800)
    expect(option(second.itemId, 'Allow once')?.hasAttribute('aria-disabled')).toBe(false)
    // Esc still closes the panel from where focus landed
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(panel().hidden).toBe(true)
    hasFocus.mockRestore()
  })

  it('keeps focus in the panel when an answer fails and the approval stays (#459 review)', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    recordLaunchProgress(db, LAUNCH, { sessions: ['mcp-1'] })
    const ask = fileLaunchAsk(db, LAUNCH, {
      project: '@sessions', stream: 'alpha · main', agent: 'copilot', kind: 'question', session: 'mcp-1', title: 'Allow shell: npm test',
      action_owner: 'approval', options: [{ label: 'Allow once' }, { label: 'Deny' }],
    }, [{ optionId: 'allow_once', label: 'Allow once' }, { optionId: 'reject_once', label: 'Deny' }])
    api.approve.mockResolvedValueOnce({ ok: false, error: 'Not sent.' } as never)
    await bootApp(db)
    await changedPollTick(db)
    await settle()
    click(cardAction(`launch:${LAUNCH}`, 'review'))
    await settle()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const allow = panel().querySelector<HTMLButtonElement>(`[data-focus-approval="${ask.itemId}"] .sp-option`)!
    allow.focus()
    click(allow)
    await settle()
    await settle()
    expect(panel().querySelector(`[data-focus-approval="${ask.itemId}"] .write-error`)?.textContent).toBe('Not sent.')
    expect(panel().contains(document.activeElement)).toBe(true)
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(panel().hidden).toBe(true)
    hasFocus.mockRestore()
  })

  it('an empty transcript read leaves the lines alone, so a selection in the last one stays', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    const dir = join(dirname(db.name), 'launches', LAUNCH)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'events.ndjson'), [
      { event: 'prompt', kind: 'task' },
      { event: 'agent_text', text: 'Reading the tests.' },
    ].map((e) => `${JSON.stringify(e)}\n`).join(''))
    await bootApp(db)
    await changedPollTick(db)
    click(document.querySelector(`[data-session-card="launch:${LAUNCH}"] .sc-doing`))
    await settle()
    const last = panel().querySelector('.sp-transcript .launch-line:last-child')!
    const text = last.querySelector('.tx-b')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 7)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    await vi.advanceTimersByTimeAsync(2100)
    await settle()
    expect(panel().querySelector('.sp-transcript .launch-line:last-child')).toBe(last)
    expect(last.querySelector('.tx-b')!.firstChild).toBe(text)
    expect(String(getSelection())).toBe('Reading')
    // a line that grows keeps its node; a new one is appended
    appendFileSync(join(dir, 'events.ndjson'), `${JSON.stringify({ event: 'agent_text', text: ' Done.' })}\n${JSON.stringify({ event: 'tool_call', title: 'Run npm test' })}\n`)
    await vi.advanceTimersByTimeAsync(2100)
    await settle()
    const lines = [...panel().querySelectorAll('.sp-transcript .launch-line')]
    expect(lines.map((li) => li.querySelector('.tx-b')?.textContent)).toEqual(['The task was sent.', 'Reading the tests. Done.', 'Run npm test'])
    expect(lines[1]).toBe(last)
    getSelection()!.removeAllRanges()
  })

  it('New session… sits in the header, and says why it is off outside a granted window', async () => {
    launchBridge()
    db = freshDb()
    await bootApp(db)
    await changedPollTick(db)
    await settle()
    const start = document.querySelector<HTMLButtonElement>('.agents-home .ah-new')!
    expect([start.hidden, start.disabled]).toEqual([false, false])
    expect(document.querySelector<HTMLElement>('.agents-home .ah-note')?.hidden).toBe(true)
    click(start)
    await settle()
    expect(document.querySelector<HTMLDialogElement>('.launch-dialog')?.open).toBe(true)
  })

  it('New session… is disabled, with its note, when the window is not granted', async () => {
    launchBridge({ available: false })
    db = freshDb()
    await bootApp(db)
    await changedPollTick(db)
    await settle()
    expect(document.querySelector<HTMLButtonElement>('.agents-home .ah-new')?.disabled).toBe(true)
    expect(document.querySelector('.agents-home .ah-note')?.textContent).toBe('Starting and approving sessions works only in Agent Inbox’s own window.')
  })
})
