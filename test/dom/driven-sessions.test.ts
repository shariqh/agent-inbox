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
  parkLaunch, recordActivityCall, recordLaunchProgress, resolveItem, upsertActivity,
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

const drawer = (): HTMLElement => document.getElementById('liveDrawer') as HTMLElement
const openDrawer = (): void => { if (drawer().hidden) click(document.getElementById('liveStrip')) }
const section = () => drawer().querySelector<HTMLElement>('.live-launches')
const launchRow = (id: string) => section()?.querySelector<HTMLElement>(`[data-launch="${id}"]`) ?? null
const action = (id: string, name: string) => launchRow(id)?.querySelector<HTMLButtonElement>(`[data-launch-action="${name}"]`) ?? null
const composer = (session: string) => [...drawer().querySelectorAll<HTMLElement>('.msg-composer')].find((el) => el.dataset.msgSession === session)
const messageButton = (session: string) => [...drawer().querySelectorAll<HTMLButtonElement>('[data-msg-open]')].find((b) => b.dataset.msgOpen === session)

describe('off means off on the page (§9 b)', () => {
  it('in a browser, the page reads no launch route and adds no control, even beside a driven session mid-turn', async () => {
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    markDriverTurn(db, LEASE, 'turn', new Date().toISOString())
    const { urls, boot } = recordingBoot(db)
    await boot
    await changedPollTick(db)
    openDrawer()
    click(messageButton('mcp-1'))
    await settle()
    expect(urls.filter((u) => u.includes('/api/launch'))).toEqual([])
    expect(section()).toBeNull()
    expect(document.getElementById('launch-settings')).toBeNull()
    expect(composer('mcp-1')?.querySelector('.msg-interrupt')).toBeNull()
    expect(drawer().querySelector('.live-started-here, [data-launch-action="message"]')).toBeNull()
    expect(document.querySelector('.dash-lane-launch, .launch-dialog, .launch-transcript')).toBeNull()
    // the Agents home (#454): no launch card and no New session; the driven session is a card of its own
    expect(document.querySelector('[data-session-card^="launch:"]')).toBeNull()
    expect(document.querySelector<HTMLElement>('.agents-home .ah-new')?.hidden).toBe(true)
    expect(document.querySelector('[data-session-card="session:mcp-1"] .sc-chips')?.textContent).toBe('Copilot · driven')
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
    openDrawer()
    expect(section()).toBeNull()
    // the switch on: the next tick reads the launches and the section appears
    const toggle = settings.querySelector<HTMLInputElement>('#launch-switch')!
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(api.setEnabled).toHaveBeenCalledWith(true)
    await changedPollTick(db)
    expect(urls.some((u) => u.startsWith('/api/launches'))).toBe(true)
    expect(launchRow(LAUNCH)?.textContent).toContain('alpha')
  })

  it('unticks and disables New worktree for a chosen folder that is not a repository, and restores it for one that is (#432)', async () => {
    const api = launchBridge()
    db = freshDb()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: 'seen', repo_root: '/work/alpha' })
    await bootApp(db)
    await changedPollTick(db)
    openDrawer()
    click(section()!.querySelector('.launch-new'))
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
    openDrawer()
    click(section()!.querySelector('.launch-new'))
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
    click(section()!.querySelector('.launch-new'))
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

describe('the Live drawer’s sessions (§3.6, §7)', () => {
  it('shows a launch that ended before its session was ready as “Didn’t start”, with why, in the error tone (#432 PR 5)', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    endLaunch(db, LAUNCH, { reason: 'error:setup', detail: 'Copilot refused to start the session: Model \'x\' does not support reasoning effort configuration' })
    newLaunch(db, PARKED)
    endLaunch(db, PARKED, { reason: 'stopped' })
    await bootApp(db)
    await changedPollTick(db)
    openDrawer()
    expect(launchRow(LAUNCH)!.dataset.state).toBe('failed')
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-status')!.textContent)
      .toBe('Didn’t start: Copilot refused to start the session: Model \'x\' does not support reasoning effort configuration')
    expect(action(LAUNCH, 'transcript')).not.toBeNull()
    expect(launchRow(PARKED)!.dataset.state).toBe('ended')
    expect(launchRow(PARKED)!.querySelector('.live-launch-status')!.textContent).toBe('Stopped')
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
    openDrawer()
    expect(action(LAUNCH, 'open-worktree')?.textContent).toBe('Open in Terminal')
    expect(action(LAUNCH, 'remove-worktree')).toBeNull()
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
    expect(launchRow(OLD)!.textContent).toContain('git said the worktree has changes.')
    api.removeWorktree.mockResolvedValueOnce({ ok: false, cancelled: true, error: 'Not removed.' })
    click(action(OLD, 'remove-worktree'))
    await settle()
    expect(launchRow(OLD)!.textContent).not.toContain('Not removed.')
    // removed: the row says so and offers neither; past the newest five ended, it then leaves the list
    markWorktreeRemoved(db, OLD)
    await changedPollTick(db)
    expect(launchRow(OLD)).toBeNull()
  })

  it('names a launch’s worktree and branch on its row, and says when the worktree was removed (#432)', async () => {
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
    openDrawer()
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-worktree')!.textContent).toBe('Worktree: agent-inbox/fix-it-11111111 · /w/alpha/fix-it-11111111')
    expect(launchRow(PARKED)!.querySelector('.live-launch-worktree')).toBeNull()
    // the driver's turn-end summary, in words (#432 §6)
    recordWorktreeSummary(db, LAUNCH, { v: 1, at: new Date().toISOString(), head: 'b'.repeat(40), branch: 'agent-inbox/fix-it-11111111', ahead: 2, behind: 0, files: 3, dirty: 1 })
    await changedPollTick(db)
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-worktree')!.textContent)
      .toBe('Worktree: agent-inbox/fix-it-11111111 · /w/alpha/fix-it-11111111 · 2 commits ahead, 3 files changed, 1 uncommitted')
    markWorktreeRemoved(db, LAUNCH)
    await changedPollTick(db)
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-worktree')!.textContent).toBe('Worktree removed; its branch agent-inbox/fix-it-11111111 is kept.')
  })

  it('lists a running launch with Stop and its transcript, and Stop goes through main', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    await bootApp(db)
    await changedPollTick(db)
    openDrawer()
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-status')!.textContent).toBe('Running')
    expect(launchRow(LAUNCH)!.textContent).toContain('Copilot · Ask for everything · claude-haiku-4.5 · 0 of 500 tool calls')
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
    openDrawer()
    click(action(LAUNCH, 'park'))
    await settle()
    expect(bridge.posts.map((p) => p.url)).toContain(`/api/launches/${LAUNCH}/park`)
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-note')?.textContent).toMatch(/^Parking: Copilot stops once its turn ends/)
    // the driver parks as the idle timeout would
    parkLaunch(db, LAUNCH, { acpSession: 'acp-1', activeMs: 10, toolCalls: 1 })
    await changedPollTick(db)
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-status')!.textContent).toMatch(/^Parked/)
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-note')).toBeNull()
    expect(action(LAUNCH, 'resume')).not.toBeNull()
  })

  it('Take over in Terminal goes through main, then the row says it was handed off and offers Resume in Terminal (step 5)', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    newLaunch(db, PARKED)
    parkLaunch(db, PARKED, { acpSession: null, activeMs: 0, toolCalls: 0 })
    await bootApp(db)
    await changedPollTick(db)
    openDrawer()
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
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-note')?.textContent).toMatch(/did not hand off within a minute/)
    api.takeOver.mockResolvedValueOnce({ ok: false, cancelled: true, error: 'Not taken over.' })
    click(action(LAUNCH, 'take-over'))
    await settle()
    expect(launchRow(LAUNCH)!.textContent).not.toContain('Not taken over.')
    // the driver handed it off
    handOffLaunch(db, LAUNCH, { acpSession: 'acp-1', activeMs: 10, toolCalls: 1 })
    await changedPollTick(db)
    expect(launchRow(LAUNCH)!.dataset.state).toBe('handed_off')
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-status')!.textContent).toBe('Handed off to a terminal: it goes on in Copilot there.')
    expect(action(LAUNCH, 'take-over')?.textContent).toBe('Resume in Terminal')
    expect(action(LAUNCH, 'stop')).toBeNull()
    expect(action(LAUNCH, 'resume')).toBeNull()
    expect(action(LAUNCH, 'transcript')).not.toBeNull()
    click(action(LAUNCH, 'take-over'))
    await settle()
    expect(api.takeOver).toHaveBeenLastCalledWith(LAUNCH)
  })

  it('reads a running launch with no session for two minutes as not responding, and offers Close', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    await bootApp(db)
    openDrawer()
    await changedPollTick(db)
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-status')!.textContent).toBe('Starting…')
    await vi.advanceTimersByTimeAsync(150_000)
    await changedPollTick(db)
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-status')!.textContent).toMatch(/Not responding/)
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
    openDrawer()
    expect(launchRow(PARKED)!.querySelector('.live-launch-status')!.textContent).toMatch(/^Parked/)
    const box = launchRow(PARKED)!.querySelector<HTMLTextAreaElement>('.live-launch-resume-input')!
    expect(action(PARKED, 'resume')!.disabled).toBe(true)
    type(box, 'Now run the linter too.')
    expect(action(PARKED, 'resume')!.disabled).toBe(false)
    click(action(PARKED, 'resume'))
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
    openDrawer()
    expect(launchRow(PARKED)!.querySelector('.live-launch-status')!.textContent).toBe('Stopped: its session is kept, so it can be resumed.')
    expect(action(PARKED, 'take-over')?.textContent).toBe('Take over in Terminal')
    type(launchRow(PARKED)!.querySelector<HTMLTextAreaElement>('.live-launch-resume-input')!, 'Carry on.')
    click(action(PARKED, 'resume'))
    await settle()
    await settle()
    expect(api.resume).toHaveBeenCalledWith(PARKED)
    expect(listSessionMessages(db).open.map((m) => [m.session, m.text])).toEqual([['mcp-9', 'Carry on.']])
  })

  it('lists ended launches past the newest five on request, so their transcripts stay reachable (step 5)', async () => {
    launchBridge()
    db = freshDb()
    const ids = Array.from({ length: 7 }, (_, n) => `11111111-2222-4333-8444-00000000000${n + 1}`)
    for (const id of ids) {
      newLaunch(db, id)
      endLaunch(db, id, { reason: 'stopped' })
      await vi.advanceTimersByTimeAsync(1000)
    }
    await bootApp(db)
    await changedPollTick(db)
    openDrawer()
    const more = section()!.querySelector<HTMLButtonElement>('[data-launch-action="earlier"]')!
    expect(section()!.querySelectorAll('.live-launch')).toHaveLength(5)
    expect(more.hidden).toBe(false)
    expect(more.textContent).toBe('Earlier sessions (2)')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    click(more)
    await settle()
    expect(section()!.querySelectorAll('.live-launch')).toHaveLength(7)
    expect(more.textContent).toBe('Fewer sessions')
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(action(ids[0]!, 'transcript')).not.toBeNull()
    click(more)
    await settle()
    expect(section()!.querySelectorAll('.live-launch')).toHaveLength(5)
  })

  it('the transcript reads the driver’s event log while open, as plain text', async () => {
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
    openDrawer()
    click(action(LAUNCH, 'transcript'))
    await settle()
    const lines = [...document.querySelectorAll('.launch-transcript .launch-line')].map((li) => li.textContent)
    expect(lines).toEqual(['The task was sent.', 'Looking at <b>the</b> tests.', 'Asked to allow npm test', 'Allowed once'])
    expect(document.querySelector('.launch-transcript b')).toBeNull()
    appendFileSync(join(dir, 'events.ndjson'), `${JSON.stringify({ event: 'ended', reason: 'stopped' })}\n`)
    await vi.advanceTimersByTimeAsync(2100)
    await settle()
    expect([...document.querySelectorAll('.launch-transcript .launch-line')].at(-1)?.textContent).toBe('Session ended (stopped).')
  })
})

describe('New session (§8)', () => {
  it('sends main the request it checks again, with a known project, and never a path of its own', async () => {
    const api = launchBridge()
    db = freshDb()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'note', title: 'seen', repo_root: '/work/alpha' })
    await bootApp(db)
    await changedPollTick(db)
    openDrawer()
    click(section()!.querySelector('.launch-new'))
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
    openDrawer()
    click(section()!.querySelector('.launch-new'))
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
    openDrawer()
    click(section()!.querySelector('.launch-new'))
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
    const button = section()!.querySelector<HTMLButtonElement>('.launch-new')!
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
    click(section()!.querySelector('.launch-new'))
    await settle()
    expect(document.querySelector<HTMLTextAreaElement>('.launch-dialog textarea[name="prompt"]')!.value).toBe('Fix it.')
  })

  it('offers New worktree, ticked; unticked, the request runs in the folder as before (#432)', async () => {
    const api = launchBridge()
    db = freshDb()
    await bootApp(db)
    await changedPollTick(db)
    openDrawer()
    click(section()!.querySelector('.launch-new'))
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
    openDrawer()
    click(section()!.querySelector('.launch-new'))
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
    click(section()!.querySelector('.launch-new'))
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
    openDrawer()
    click(messageButton('mcp-1'))
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

describe('the Dashboard lanes (#304)', () => {
  it('tag a launch’s working session “Started here”, with Stop, only with the switch on', async () => {
    const api = launchBridge()
    db = freshDb()
    newLaunch(db)
    upsertActivity(db, { session: 'mcp-1', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'Fixing the test', idle: false, claim: true, receives_messages: true })
    recordActivityCall(db, 'mcp-1')
    claimDriverSlot(db, LEASE, 2)
    holdDriverLeases(db, LEASE, ['mcp-1'])
    recordLaunchProgress(db, LAUNCH, { sessions: ['mcp-1'] })
    await bootApp(db)
    await changedPollTick(db)
    const lane = document.querySelector<HTMLElement>('.dash-lane[data-lane="mcp-1"]')!
    expect(lane.querySelector('.dash-lane-launch-tag')?.textContent).toBe('Started here')
    click(lane.querySelector('.dash-lane-stop'))
    await settle()
    expect(api.stop).toHaveBeenCalledWith(LAUNCH)
  })

  it('draw nothing new in a browser', async () => {
    db = freshDb()
    newLaunch(db)
    upsertActivity(db, { session: 'mcp-1', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'Fixing the test', idle: false, claim: true })
    recordActivityCall(db, 'mcp-1')
    recordLaunchProgress(db, LAUNCH, { sessions: ['mcp-1'] })
    await bootApp(db)
    await changedPollTick(db)
    expect(document.querySelector('.dash-lane[data-lane="mcp-1"]')).not.toBeNull()
    expect(document.querySelector('.dash-lane-launch')).toBeNull()
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
    expect(card(`launch:${LAUNCH}`)?.querySelector('.sc-chips')?.textContent).toBe('Copilot · started here')
    expect(card(`launch:${LAUNCH}`)?.querySelector('.sc-state')?.textContent).toBe('Working')
    expect(actions(`launch:${LAUNCH}`)).toEqual(['Message'])
    expect(card('session:mcp-1')).toBeNull()
    expect(card('session:mcp-2')?.querySelector('.sc-chips')?.textContent).toBe('Copilot · driven')
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
    expect(drawer().hidden).toBe(false)
    expect(document.activeElement).toBe(launchRow(LAUNCH)?.querySelector('.live-launch-resume-input'))
    drawer().hidden = true
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
    // the drawer lists the newest five ended launches only, until Earlier sessions is open
    expect(launchRow(LAUNCH)).toBeNull()
    click(cardAction(id, 'resume'))
    await settle()
    expect(drawer().hidden).toBe(false)
    expect(document.activeElement).toBe(launchRow(LAUNCH)?.querySelector('.live-launch-resume-input'))
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
    expect(document.querySelector('.launch-transcript')).not.toBeNull()
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

describe('Message on a launch’s row (#412)', () => {
  const launchComposer = (id: string) => launchRow(id)?.querySelector<HTMLElement>('.msg-composer') ?? null

  it('appears only on a running, linked launch, in the granted window', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    await bootApp(db)
    openDrawer()
    await changedPollTick(db)
    // starting: no session linked yet
    expect(action(LAUNCH, 'message')).toBeNull()
    drivenSession(db)
    await changedPollTick(db)
    expect(action(LAUNCH, 'message')?.textContent).toBe('Message')
    parkLaunch(db, LAUNCH, { acpSession: 'acp-1', activeMs: 10, toolCalls: 1 })
    await changedPollTick(db)
    expect(launchRow(LAUNCH)!.querySelector('.live-launch-status')!.textContent).toMatch(/^Parked/)
    expect(action(LAUNCH, 'message')).toBeNull()
  })

  it('opens the session’s composer under the row, shares its draft, and sends through the message route', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    const bridge = await bootApp(db)
    await changedPollTick(db)
    openDrawer()
    click(action(LAUNCH, 'message'))
    await settle()
    const el = launchComposer(LAUNCH)!
    expect(el.dataset.msgSession).toBe('mcp-1')
    expect(el.querySelector('.msg-delivery')!.textContent).toBe('Arrives now: Agent Inbox runs this session.')
    const box = el.querySelector<HTMLTextAreaElement>('textarea')!
    expect(document.activeElement).toBe(box)
    type(box, 'Also run the linter.')
    box.setSelectionRange(5, 9)
    await changedPollTick(db)
    expect(document.activeElement).toBe(box)
    expect([box.selectionStart, box.selectionEnd]).toEqual([5, 9])
    // the session's own row shows the same draft
    click(messageButton('mcp-1'))
    await settle()
    expect(composer('mcp-1')!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Also run the linter.')
    click(el.querySelector('.msg-send'))
    await settle()
    await settle()
    expect(bridge.posts.some((p) => p.url === '/api/sessions/mcp-1/messages')).toBe(true)
    expect(listSessionMessages(db).open.map((m) => m.text)).toEqual(['Also run the linter.'])
    expect(box.value).toBe('')
    expect(composer('mcp-1')!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('')
  })

  it('reads Queued mid-task with Interrupt and send, and Cancel closes it', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    markDriverTurn(db, LEASE, 'turn', new Date(Date.now() - 3 * 60_000).toISOString())
    await bootApp(db)
    await changedPollTick(db)
    openDrawer()
    click(action(LAUNCH, 'message'))
    await settle()
    const el = launchComposer(LAUNCH)!
    expect(el.querySelector('.msg-delivery')!.textContent).toMatch(/^Queued: it’s mid-task/)
    expect(el.querySelector('.msg-interrupt')).not.toBeNull()
    click(el.querySelector('.msg-cancel'))
    await settle()
    expect(launchComposer(LAUNCH)).toBeNull()
  })

  it('adds nothing with the switch off or in a browser, and tags the session’s own row “Started here” only with it on', async () => {
    launchBridge()
    db = freshDb()
    newLaunch(db)
    drivenSession(db)
    await bootApp(db)
    await changedPollTick(db)
    openDrawer()
    const started = () => [...drawer().querySelectorAll('.live-started-here')].map((e) => e.textContent)
    expect(started()).toEqual(['Started here'])
    const settings = document.getElementById('launch-settings')!
    const box = settings.querySelector<HTMLInputElement>('#launch-switch')!
    box.checked = false
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    await changedPollTick(db)
    expect(section()).toBeNull()
    expect(started()).toEqual([])
    expect(drawer().querySelector('[data-launch-action="message"]')).toBeNull()
  })
})
