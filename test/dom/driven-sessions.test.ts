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
  claimDriverSlot, createLaunch, fileLaunchAsk, getItem, holdDriverLeases, insertItem, listSessionMessages, markDriverTurn,
  parkLaunch, recordActivityCall, recordLaunchProgress, upsertActivity,
} from '../../src/store.js'
import type { ViewerBridge } from './harness.js'
import { bootApp, buttonLabelled, changedPollTick, click, freshDb, row, settle, type, useDomTest } from './harness.js'

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

type State = { owned: boolean; enabled: boolean; available: boolean; canEnable: boolean }
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
    expect(document.querySelector('.dash-lane-launch, .launch-dialog, .launch-transcript')).toBeNull()
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

  it('a viewer the app does not own draws no Settings section', async () => {
    launchBridge({ owned: false, enabled: false, available: false, canEnable: false })
    db = freshDb()
    await bootApp(db)
    expect(document.getElementById('launch-settings')?.hidden ?? true).toBe(true)
  })
})

describe('the Live drawer’s sessions (§3.6, §7)', () => {
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
    expect(api.start).toHaveBeenCalledWith({
      root: '/work/alpha', mode: 'plan', model: 'claude-haiku-4.5', reasoningEffort: 'none',
      budgets: { activeMs: 7_200_000, toolCalls: 500 }, prompt: 'Fix the failing test.',
    })
    expect(document.querySelector('.launch-dialog')).toBeNull()
  })

  it('keeps the task and says why when the request is not valid or main refuses it', async () => {
    const api = launchBridge()
    api.start.mockResolvedValueOnce({ ok: false, error: 'Not started.', cancelled: true } as never)
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
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ root: null, mode: 'ask', prompt: 'Do it.' }))
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
