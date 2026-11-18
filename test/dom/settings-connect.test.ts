// @vitest-environment jsdom
// test/dom/settings-connect.test.ts — #617 PR 3c: Settings → “Use another Mac’s Inbox”, on this
// Mac’s own page, from a stubbed `agentInboxConnect` (the bridge electron/setup-preload.cjs exposes).
// Values are synthetic: `mbp.example.ts.net`, `MBP`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import remoteConnect from '../../electron/remote-connect.cjs'
import { normaliseCode, refreshConnectSettings, renderConnectSettings } from '../../public/connect-settings.js'
import { bootApp, click, freshDb, settle, useDomTest } from './harness.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ID = '0123abcd'
const ORIGIN = 'https://mbp.example.ts.net'

type State = 'online' | 'retrying' | 'refused' | null
interface Hub { id: string; label: string; origin: string; machine: string | null; state: State; reason: string | null }
interface View { available: boolean; keychain?: boolean; hub?: Hub | null; problem?: string | null; showing?: string | null }

const hub = (state: State = 'online', reason: string | null = null, extra: Partial<Hub> = {}): Hub =>
  ({ id: ID, label: 'MBP', origin: ORIGIN, machine: 'MBP', state, reason, ...extra })
const NONE: View = { available: true, keychain: true, hub: null, problem: null, showing: null }

/** A main process behind agentInboxConnect, as far as this section can tell. */
function connectBridge(start: View = NONE) {
  let view: View = structuredClone(start)
  const listeners = new Set<() => void>()
  const api = {
    view: vi.fn(async (): Promise<View> => structuredClone(view)),
    connect: vi.fn(async (_input: { address: string; code: string; replace?: boolean }): Promise<Record<string, unknown>> => ({ ok: false, reason: 'failed' })),
    forget: vi.fn(async (_id: string): Promise<Record<string, unknown>> => ({ ok: true })),
    show: vi.fn(async (id: string | null): Promise<Record<string, unknown>> => ({ ok: true, showing: id })),
    onChange: vi.fn((callback: () => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }),
  }
  return Object.assign(api, {
    listeners,
    /** main changed something and says so */
    set(next: View) {
      view = structuredClone(next)
      for (const listener of [...listeners]) listener()
    },
    /** what view() answers next, without a change message */
    quietly(next: View) { view = structuredClone(next) },
  })
}

const localDesk = () => ({ connection: vi.fn(async () => ({ mode: 'local' })), onConnection: () => () => {}, available: async () => ({ open: false }) })
const hubDesk = () => ({ connection: vi.fn(async () => ({ mode: 'hub', label: 'MBP', state: 'online', version: '2.13.0' })), onConnection: () => () => {} })

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

let host: HTMLElement
function draw(api: ReturnType<typeof connectBridge> | null, desk: unknown = localDesk(), platform = 'MacIntel') {
  host = document.createElement('div')
  document.body.appendChild(host)
  return renderConnectSettings(host, {
    connect: () => api as never,
    desk: () => desk as never,
    documentRef: document,
    platform: () => platform,
  })
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null
const shown = (id: string) => {
  const el = $(id)
  if (!el || !document.contains(el)) return false
  for (let node: HTMLElement | null = el; node; node = node.parentElement) if (node.hidden) return false
  return true
}
const text = (id: string) => (shown(id) ? $(id)?.textContent ?? '' : '')
const type = (id: string, value: string) => {
  const el = $<HTMLInputElement>(id)!
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const submit = () => $('connect-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const press = (id: string) => {
  if (!shown(id)) throw new Error(`press(): #${id} is not shown`)
  $(id)!.click()
}

beforeEach(() => {
  document.body.replaceChildren()
})
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

// ── the reasons, from the controller's own declarations ─────────────────────

const dcts = readFileSync(join(ROOT, 'electron', 'remote-connect.d.cts'), 'utf8')
const typeBlock = (name: string) => {
  const at = dcts.indexOf(`export type ${name} =`)
  if (at < 0) throw new Error(`no type ${name} in remote-connect.d.cts`)
  const end = dcts.indexOf('\nexport ', at + 1)
  return dcts.slice(at, end < 0 ? undefined : end)
}
const words = (block: string) => [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
const HUB_REASONS = words(typeBlock('HubReason'))
const CONNECT_REASONS = [...new Set([
  ...words(typeBlock('ConnectReason')),
  ...HUB_REASONS,
  // ConnectAnswer adds these to ConnectReason
  ...words(/reason: ConnectReason \| ([^;]+);/.exec(typeBlock('ConnectAnswer'))?.[1] ?? ''),
])]
const STORE_PROBLEMS = words(typeBlock('StoreProblem'))
const FALLBACK = 'Agent Inbox couldn’t connect. Try again.'

describe('the controller’s lists, read from electron/remote-connect.d.cts', () => {
  it('are read, so a reason added there reaches the tests below', () => {
    expect(CONNECT_REASONS).toEqual(expect.arrayContaining(['unsupported', 'bad_code', 'hub_exists', 'no_cli', 'tagged_device', 'unreachable', 'refused', 'write_failed', 'too_large', 'forgotten', 'changed', 'failed']))
    expect(CONNECT_REASONS.length).toBeGreaterThanOrEqual(24)
    expect(STORE_PROBLEMS).toEqual(expect.arrayContaining(['unreadable', 'bad_file', 'newer_schema', 'forget_not_saved']))
  })
})

// ── where it is drawn ───────────────────────────────────────────────────────

describe('where the section is drawn', () => {
  it('nowhere without agentInboxConnect', async () => {
    expect(draw(null)).toBeNull()
    await flush()
    expect(host.childElementCount).toBe(0)
  })

  it('never on the hub’s page, and it asks main nothing there', async () => {
    const api = connectBridge()
    draw(api, hubDesk())
    await flush()
    expect($('connect-settings')).toBeNull()
    expect(api.view).not.toHaveBeenCalled()
    expect(api.onChange).not.toHaveBeenCalled()
  })

  it.each([
    ['no agentInboxDesk', null],
    ['a desk that answers null', { connection: async () => null }],
    ['a desk that throws', { connection: async () => { throw new Error('gone') } }],
  ])('not with %s', async (_name, desk) => {
    const api = connectBridge()
    draw(api, desk)
    await flush()
    expect($('connect-settings')).toBeNull()
    expect(api.view).not.toHaveBeenCalled()
  })

  it('on this Mac’s own page, under its heading', async () => {
    draw(connectBridge())
    await flush()
    expect(shown('connect-settings')).toBe(true)
    expect($('connect-settings')?.querySelector('h3')?.textContent).toBe('Use another Mac’s Inbox')
  })
})

// ── not available ───────────────────────────────────────────────────────────

describe('when it is not available', () => {
  it.each([
    ['a Mac, in a viewer the app does not own', 'MacIntel', { available: false }, 'Another Agent Inbox viewer is running on this Mac, so this window can’t use another Mac’s Inbox. Quit it, then reopen Agent Inbox.'],
    ['another system', 'Win32', { available: false }, 'Using another Mac’s Inbox works only on macOS.'],
    ['a Mac without the Keychain', 'MacIntel', { ...NONE, keychain: false }, 'Agent Inbox can’t use this Mac’s Keychain, so it can’t keep the other Mac’s key safe. Unlock this Mac, choose Allow if macOS asks, then open Settings again.'],
  ])('says one sentence for %s, and draws no form', async (_name, platform, view, sentence) => {
    draw(connectBridge(view as View), localDesk(), platform)
    await flush()
    expect(text('connect-hint')).toBe(sentence)
    expect(shown('connect-form')).toBe(false)
    expect(shown('connect-hub')).toBe(false)
  })
})

// ── no Mac connected ────────────────────────────────────────────────────────

describe('with no Mac connected', () => {
  it('asks for the address and the code, with one line of help', async () => {
    draw(connectBridge())
    await flush()
    expect(shown('connect-form')).toBe(true)
    expect(shown('connect-hub')).toBe(false)
    const address = $<HTMLInputElement>('connect-address')!
    const code = $<HTMLInputElement>('connect-code')!
    expect(document.querySelector(`label[for="connect-address"]`)?.textContent).toBe('Address')
    expect(document.querySelector(`label[for="connect-code"]`)?.textContent).toBe('Code')
    expect(address.placeholder).toBe('mac-name.tail1234.ts.net')
    expect(code.placeholder).toBe('10 letters and digits')
    expect($('connect-submit')?.textContent).toBe('Connect')
    expect(($('connect-submit') as HTMLButtonElement).type).toBe('submit')
    expect(text('connect-hint')).toBe('On the other Mac: Settings → Other devices → Add a Mac shows the address and a code.')
    expect(text('connect-message')).toBe('')
  })

  it('sends the code as typed, cleaned the hub’s way, and the address trimmed', async () => {
    const api = connectBridge()
    draw(api)
    await flush()
    type('connect-address', '  mbp.example.ts.net ')
    type('connect-code', 'abcd-efgh jk')
    submit()
    await flush()
    expect(api.connect).toHaveBeenCalledTimes(1)
    expect(api.connect).toHaveBeenCalledWith({ address: 'mbp.example.ts.net', code: 'ABCDEFGHJK', replace: false })
  })

  it('reads I, L and O the hub’s way', async () => {
    const api = connectBridge()
    draw(api)
    await flush()
    type('connect-address', 'mbp.example.ts.net')
    type('connect-code', 'il0o-12 3456')
    submit()
    await flush()
    expect(api.connect).toHaveBeenCalledWith({ address: 'mbp.example.ts.net', code: '1100123456', replace: false })
  })

  it.each([
    ['too short', '12345'],
    ['too long', '12345678901'],
    ['a letter the code never uses', 'ABCDEFGHJU'],
    ['a character it never accepts', 'ABCDE/FGHJ'],
    ['empty', ''],
  ])('never sends a code that is %s, and says what a code is', async (_name, code) => {
    const api = connectBridge()
    draw(api)
    await flush()
    type('connect-address', 'mbp.example.ts.net')
    type('connect-code', code)
    submit()
    await flush()
    expect(api.connect).not.toHaveBeenCalled()
    expect(text('connect-message')).toBe('The code is 10 letters and digits. Check it on the other Mac and try again.')
  })

  it('never sends an empty address', async () => {
    const api = connectBridge()
    draw(api)
    await flush()
    type('connect-address', '   ')
    type('connect-code', 'ABCDEFGHJK')
    submit()
    await flush()
    expect(api.connect).not.toHaveBeenCalled()
    expect(text('connect-message')).toBe('Enter the other Mac’s address.')
  })

  it('disables every control and says “Connecting…” while it connects, then shows the Mac', async () => {
    const api = connectBridge()
    let answer!: (value: Record<string, unknown>) => void
    api.connect.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    draw(api)
    await flush()
    type('connect-address', 'mbp.example.ts.net')
    type('connect-code', 'ABCDEFGHJK')
    $('connect-submit')!.focus()
    submit()
    await flush()
    expect(text('connect-busy')).toBe('Connecting…')
    const controls = [...$('connect-settings')!.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')]
    expect(controls.length).toBeGreaterThanOrEqual(3)
    for (const control of controls) expect(control.disabled, control.id || control.textContent || '').toBe(true)
    // a second press while busy sends nothing more
    submit()
    // main stores the hub while the first check runs: the form stays until the answer
    api.set({ ...NONE, hub: hub('retrying', 'connecting') })
    await flush()
    expect(text('connect-busy')).toBe('Connecting…')
    expect(shown('connect-hub')).toBe(false)
    api.quietly({ ...NONE, hub: hub('online') })
    answer({ ok: true, id: ID, label: 'MBP', state: 'online', reason: null })
    await flush()
    expect(api.connect).toHaveBeenCalledTimes(1)
    expect(text('connect-busy')).toBe('')
    expect(shown('connect-form')).toBe(false)
    expect(text('connect-hub-name')).toBe('MBP’s Inbox')
    // the pressed Connect has gone: focus goes to the next thing to do, not to the page's body
    expect(document.activeElement).toBe($('connect-show'))
    for (const control of [...$('connect-settings')!.querySelectorAll<HTMLButtonElement>('button')].filter((b) => shown(b.id))) {
      expect(control.disabled, control.id).toBe(false)
    }
  })
})

// ── refusals ────────────────────────────────────────────────────────────────

const SENTENCES: Record<string, string> = {
  unsupported: 'Using another Mac’s Inbox works only on macOS.',
  no_keychain: 'Agent Inbox couldn’t use this Mac’s Keychain to keep the other Mac’s key safe. Unlock this Mac, choose Allow if macOS asks, then try again.',
  bad_address: 'That address isn’t right. Copy it from the other Mac: it looks like mac-name.tail1234.ts.net.',
  bad_code: 'The code is 10 letters and digits. Check it on the other Mac and try again.',
  newer_schema: 'A newer Agent Inbox saved this Mac’s connection. Update Agent Inbox on this Mac, then try again.',
  bad_file: 'This Mac’s saved connection can’t be used.',
  hub_exists: 'A Mac is already connected.',
  no_cli: 'Tailscale isn’t installed on this Mac. Install it, sign in, and try again.',
  failed: 'Something went wrong while connecting. Try again. If it keeps happening, check that Tailscale is running on this Mac.',
  not_running: 'Tailscale isn’t running on this Mac, or it’s signed out. Open Tailscale, sign in, and try again.',
  tagged_self: 'In Tailscale, this Mac belongs to a tag, not to your account. Sign this Mac in to Tailscale with your own account, then try again.',
  not_in_tailnet: 'That address isn’t in your Tailscale network. Copy the address the other Mac shows.',
  not_found: 'None of the devices in your Tailscale network has that address. Is the other Mac on and signed in to Tailscale?',
  duplicate_name: 'More than one device in your Tailscale network has that name. Rename one in Tailscale, then try again.',
  not_your_device: 'That Mac isn’t signed in to Tailscale with your account. Use a Mac signed in with your own account.',
  tagged_device: 'In Tailscale, that Mac belongs to a tag, not to your account. Use a Mac signed in to Tailscale with your own account.',
  unreachable: 'Couldn’t reach that Mac. Is it awake, with Agent Inbox open?',
  bad_certificate: 'That Mac’s HTTPS certificate isn’t valid, so nothing was sent. Check this Mac’s date and time, and press Test on the other Mac (Settings → Other devices), then try again.',
  not_agent_inbox: 'That address doesn’t answer as an Agent Inbox. On the other Mac, check Settings → Other devices → Let my other Macs use this Inbox.',
  refused: 'The other Mac said no. The code may be wrong or used up, or its sharing may not allow your Tailscale account. Make a new code there and try again.',
  write_failed: 'This Mac couldn’t save the connection. Try again.',
  too_large: 'This Mac couldn’t save the connection: its saved file is too large.',
  forgotten: 'You disconnected while it was connecting, so nothing is connected.',
  changed: 'The connection changed while it was connecting. Check what is connected, then try again.',
}

async function refusedWith(answer: Record<string, unknown>, view: View = NONE) {
  const api = connectBridge(view)
  api.connect.mockResolvedValue(answer)
  draw(api)
  await flush()
  type('connect-address', 'mbp.example.ts.net')
  type('connect-code', 'ABCDEFGHJK')
  submit()
  await flush()
  return api
}

describe('a refusal', () => {
  it.each(CONNECT_REASONS)('“%s” has its own sentence, and the form stays filled in', async (reason) => {
    await refusedWith({ ok: false, reason })
    const message = text('connect-message')
    expect(message).not.toBe('')
    expect(message).not.toBe(FALLBACK)
    expect(message).not.toMatch(/undefined|null|_|tailnet/)
    expect(SENTENCES[reason], `no sentence pinned here for ${reason}`).toBeDefined()
    expect(message).toBe(SENTENCES[reason])
    expect($<HTMLInputElement>('connect-address')?.value).toBe('mbp.example.ts.net')
    expect($<HTMLInputElement>('connect-code')?.value).toBe('ABCDEFGHJK')
    expect(text('connect-busy')).toBe('')
  })

  it('an unknown word gets the plain fallback', async () => {
    await refusedWith({ ok: false, reason: 'something_new' })
    expect(text('connect-message')).toBe(FALLBACK)
  })

  it.each(['write_failed', 'no_keychain', 'too_large', 'hub_exists'])('after pairing on the other Mac (%s), says to remove this Mac there', async (reason) => {
    await refusedWith({ ok: false, reason, pairedOnHub: true })
    expect(text('connect-message')).toBe('The other Mac now lists this Mac, but this Mac couldn’t save the connection. On the other Mac, remove this Mac under Settings → Other devices, then try again with a new code.')
    expect(shown('connect-replace')).toBe(false)
  })

  it('a connect answered { available: false } asks main again and shows why it is not available', async () => {
    const api = connectBridge()
    api.connect.mockImplementation(async () => {
      api.quietly({ available: false })
      return { available: false }
    })
    draw(api)
    await flush()
    type('connect-address', 'mbp.example.ts.net')
    type('connect-code', 'ABCDEFGHJK')
    submit()
    await flush()
    expect(shown('connect-form')).toBe(false)
    expect(text('connect-hint')).toMatch(/^Another Agent Inbox viewer is running on this Mac/)
  })

  it('a connect that throws reads as the fallback, never a stuck “Connecting…”', async () => {
    const api = connectBridge()
    api.connect.mockRejectedValue(new Error('gone'))
    draw(api)
    await flush()
    type('connect-address', 'mbp.example.ts.net')
    type('connect-code', 'ABCDEFGHJK')
    submit()
    await flush()
    expect(text('connect-busy')).toBe('')
    expect(text('connect-message')).toBe(FALLBACK)
    expect(($('connect-submit') as HTMLButtonElement).disabled).toBe(false)
  })
})

// ── Replace it ──────────────────────────────────────────────────────────────

describe('Replace it', () => {
  it('after “a Mac is already connected”, asks inline, then connects again with replace: true', async () => {
    const api = await refusedWith({ ok: false, reason: 'hub_exists' })
    // main says what is stored now; the offer stays until the person answers it
    api.set({ ...NONE, hub: hub('online', null, { label: 'Studio' }) })
    await flush()
    expect(text('connect-message')).toBe('A Mac is already connected.')
    expect($('connect-replace')?.textContent).toBe('Replace it')
    press('connect-replace')
    await flush()
    expect(text('connect-confirm-text')).toBe('This Mac stops using Studio’s Inbox and uses the new one. Studio keeps this Mac in its list until you remove it there.')
    expect($('connect-confirm-yes')?.textContent).toBe('Replace')
    expect($('connect-confirm-no')?.textContent).toBe('Keep')
    expect(api.connect).toHaveBeenCalledTimes(1)
    api.connect.mockResolvedValue({ ok: true, id: 'feedc0de', label: 'MBP', state: 'online', reason: null, replacedHub: true })
    api.quietly({ ...NONE, hub: hub('online', null, { id: 'feedc0de' }) })
    press('connect-confirm-yes')
    await flush()
    expect(api.connect).toHaveBeenCalledTimes(2)
    expect(api.connect).toHaveBeenLastCalledWith({ address: 'mbp.example.ts.net', code: 'ABCDEFGHJK', replace: true })
    expect(text('connect-hub-name')).toBe('MBP’s Inbox')
    expect(text('connect-message')).toBe('Studio still lists this Mac until you remove it there.')
    // a note, not an error: not in the danger colour
    expect($('connect-message')?.classList.contains('connect-note')).toBe(true)
  })

  it('typing in the form after the refusal drops the offer, so Replace never sends what was typed before', async () => {
    const api = await refusedWith({ ok: false, reason: 'hub_exists' })
    api.quietly({ ...NONE, hub: hub('online', null, { label: 'Studio' }) })
    expect(shown('connect-replace')).toBe(true)
    type('connect-code', 'ZZZZZZZZZZ')
    await flush()
    expect(shown('connect-replace')).toBe(false)
    expect(shown('connect-confirm')).toBe(false)
    expect(api.connect).toHaveBeenCalledTimes(1)
  })

  it('typing while asked to confirm closes the question too', async () => {
    const api = await refusedWith({ ok: false, reason: 'hub_exists' })
    api.quietly({ ...NONE, hub: hub('online', null, { label: 'Studio' }) })
    press('connect-replace')
    await flush()
    expect(shown('connect-confirm')).toBe(true)
    type('connect-address', 'other.tail1234.ts.net')
    await flush()
    expect(shown('connect-confirm')).toBe(false)
    expect(shown('connect-replace')).toBe(false)
  })

  it('Keep sends nothing and shows what is connected', async () => {
    const api = await refusedWith({ ok: false, reason: 'hub_exists' })
    api.quietly({ ...NONE, hub: hub('online') })
    press('connect-replace')
    await flush()
    press('connect-confirm-no')
    await flush()
    expect(api.connect).toHaveBeenCalledTimes(1)
    expect(shown('connect-confirm')).toBe(false)
    expect(text('connect-hub-name')).toBe('MBP’s Inbox')
  })

  it('a saved connection that can’t be used is replaced the same way', async () => {
    const api = await refusedWith({ ok: false, reason: 'bad_file' }, { ...NONE, problem: 'not_json' })
    press('connect-replace')
    await flush()
    expect(text('connect-confirm-text')).toBe('This replaces the saved connection on this Mac.')
    press('connect-confirm-yes')
    await flush()
    expect(api.connect).toHaveBeenLastCalledWith({ address: 'mbp.example.ts.net', code: 'ABCDEFGHJK', replace: true })
  })

  it('is never offered for a newer Agent Inbox’s file, which is never written', async () => {
    await refusedWith({ ok: false, reason: 'newer_schema' })
    expect(shown('connect-replace')).toBe(false)
  })
})

// ── connected ───────────────────────────────────────────────────────────────

const STATUS: Array<[State, string | null, string]> = [
  ['online', null, 'Online'],
  [null, null, 'Checking…'],
  ['retrying', 'connecting', 'Connecting…'],
  ['retrying', 'stopped', 'Reconnecting…'],
  ['retrying', 'unreachable', 'Reconnecting… Can’t reach MBP.'],
  ['retrying', 'bad_certificate', 'Reconnecting… MBP’s HTTPS certificate isn’t valid.'],
  ['retrying', 'not_agent_inbox', 'Reconnecting… MBP isn’t sharing its Inbox. On MBP, check Settings → Other devices → Let my other Macs use this Inbox.'],
  ['retrying', 'no_cli', 'Reconnecting… Tailscale isn’t installed on this Mac.'],
  ['retrying', 'failed', 'Reconnecting… Tailscale on this Mac can’t be read.'],
  ['retrying', 'not_running', 'Reconnecting… Tailscale isn’t running on this Mac, or it’s signed out.'],
  ['retrying', 'no_keychain', 'Reconnecting… This Mac’s Keychain isn’t available yet.'],
  ['retrying', 'something_new', 'Reconnecting…'],
  ['refused', 'refused', 'Not connected. MBP no longer accepts this Mac.'],
  ['refused', 'node_changed', 'Not connected. MBP’s address now belongs to another device.'],
  ['refused', 'secret_unreadable', 'Not connected. This Mac can’t read its key for MBP.'],
  ['refused', 'not_found', 'Not connected. MBP is no longer in your Tailscale network.'],
  ['refused', 'not_in_tailnet', 'Not connected. MBP is no longer in your Tailscale network.'],
  ['refused', 'duplicate_name', 'Not connected. More than one device now has MBP’s name.'],
  ['refused', 'not_your_device', 'Not connected. MBP is no longer signed in to Tailscale with your account.'],
  ['refused', 'tagged_device', 'Not connected. In Tailscale, MBP now belongs to a tag, not to your account.'],
  ['refused', 'tagged_self', 'Not connected. In Tailscale, this Mac now belongs to a tag, not to your account.'],
  ['refused', 'something_new', 'Not connected. MBP no longer accepts this Mac.'],
]

describe('with a Mac connected', () => {
  it('names its Inbox, its address and its status, with Show its Inbox and Disconnect', async () => {
    draw(connectBridge({ ...NONE, hub: hub('online') }))
    await flush()
    expect(shown('connect-form')).toBe(false)
    expect(text('connect-hub-name')).toBe('MBP’s Inbox')
    expect(text('connect-hub-address')).toBe('mbp.example.ts.net')
    expect(text('connect-hub-status')).toBe('Online')
    expect($('connect-show')?.textContent).toBe('Show its Inbox')
    expect($('connect-disconnect')?.textContent).toBe('Disconnect')
    expect(text('connect-hint')).toBe('')
  })

  it.each(STATUS)('state %s, reason %s: “%s”', async (state, reason, sentence) => {
    draw(connectBridge({ ...NONE, hub: hub(state, reason) }))
    await flush()
    expect(text('connect-hub-status')).toBe(sentence)
  })

  it('every refused reason the controller can give says how to pair again', async () => {
    draw(connectBridge({ ...NONE, hub: hub('refused', 'refused') }))
    await flush()
    expect(text('connect-pair-again')).toBe('To pair again: press Disconnect, then connect with a new code from MBP.')
  })

  it('says nothing about pairing again while online', async () => {
    draw(connectBridge({ ...NONE, hub: hub('online') }))
    await flush()
    expect(shown('connect-pair-again')).toBe(false)
  })

  it('Show its Inbox asks main to put it on top', async () => {
    const api = connectBridge({ ...NONE, hub: hub('online') })
    draw(api)
    await flush()
    press('connect-show')
    await flush()
    expect(api.show).toHaveBeenCalledWith(ID)
    expect(text('connect-message')).toBe('')
  })

  it.each([
    ['busy', 'MBP’s Inbox closed itself several times. Try again in a minute.'],
    ['not_found', 'That Mac isn’t connected any more.'],
    ['not_ready', 'MBP’s Inbox isn’t ready yet. Try again in a moment.'],
    ['not_owned', 'Another Agent Inbox viewer is running on this Mac, so this window can’t use another Mac’s Inbox. Quit it, then reopen Agent Inbox.'],
    ['destroyed', 'Agent Inbox couldn’t show it. Try again.'],
  ])('says why Show its Inbox did not (%s)', async (reason, sentence) => {
    const api = connectBridge({ ...NONE, hub: hub('online') })
    api.show.mockResolvedValue({ ok: false, reason })
    draw(api)
    await flush()
    press('connect-show')
    await flush()
    expect(text('connect-message')).toBe(sentence)
  })

  it('a sentence goes when what is shown changes', async () => {
    const api = connectBridge({ ...NONE, hub: hub('online') })
    api.show.mockResolvedValueOnce({ ok: false, reason: 'busy' })
    draw(api)
    await flush()
    press('connect-show')
    await flush()
    expect(text('connect-message')).toBe('MBP’s Inbox closed itself several times. Try again in a minute.')
    // main says the hub is on top now
    api.set({ ...NONE, hub: hub('online'), showing: ID })
    await flush()
    expect(text('connect-message')).toBe('')
    expect($('connect-message')?.classList.contains('connect-note')).toBe(false)
  })

  it('a sentence goes when the hub’s state changes, and when Settings is opened again', async () => {
    const api = connectBridge({ ...NONE, hub: hub('online') })
    api.show.mockResolvedValue({ ok: false, reason: 'not_ready' })
    draw(api)
    await flush()
    press('connect-show')
    await flush()
    expect(text('connect-message')).not.toBe('')
    api.set({ ...NONE, hub: hub('retrying', 'unreachable') })
    await flush()
    expect(text('connect-message')).toBe('')
    press('connect-show')
    await flush()
    expect(text('connect-message')).not.toBe('')
    await refreshConnectSettings()
    await flush()
    expect(text('connect-message')).toBe('')
  })

  it('a refusal stays while nothing changes, and goes when Settings is opened again', async () => {
    const api = await refusedWith({ ok: false, reason: 'unreachable' })
    api.set(NONE)
    await flush()
    expect(text('connect-message')).toBe(SENTENCES.unreachable)
    await refreshConnectSettings()
    await flush()
    expect(text('connect-message')).toBe('')
  })

  it('Disconnect asks inline first; Keep does nothing', async () => {
    const api = connectBridge({ ...NONE, hub: hub('online') })
    draw(api)
    await flush()
    press('connect-disconnect')
    await flush()
    expect(text('connect-confirm-text')).toBe('This Mac stops using MBP’s Inbox. MBP keeps this Mac in its list until you remove it there.')
    expect($('connect-confirm-yes')?.textContent).toBe('Disconnect')
    expect($('connect-confirm-no')?.textContent).toBe('Keep')
    expect(document.activeElement).toBe($('connect-confirm-no'))
    press('connect-confirm-no')
    await flush()
    expect(api.forget).not.toHaveBeenCalled()
    expect(shown('connect-confirm')).toBe(false)
    expect(text('connect-hub-name')).toBe('MBP’s Inbox')
  })

  it('Disconnect, confirmed, forgets the Mac and shows the form again', async () => {
    const api = connectBridge({ ...NONE, hub: hub('online') })
    let answer!: (value: Record<string, unknown>) => void
    api.forget.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    draw(api)
    await flush()
    press('connect-disconnect')
    await flush()
    press('connect-confirm-yes')
    await flush()
    expect(api.forget).toHaveBeenCalledWith(ID)
    expect(text('connect-busy')).toBe('Disconnecting…')
    for (const control of $('connect-settings')!.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) {
      expect(control.disabled, control.id).toBe(true)
    }
    api.quietly(NONE)
    answer({ ok: true })
    await flush()
    expect(shown('connect-form')).toBe(true)
    expect(shown('connect-hub')).toBe(false)
    expect(text('connect-busy')).toBe('')
  })

  // what main answers then (test/remote-connect.test.ts): no hub, and the problem
  const UNSAVED: View = { ...NONE, hub: null, problem: 'forget_not_saved' }
  const UNSAVED_TEXT = 'This Mac has stopped using the other Mac’s Inbox, but couldn’t save that. Connecting a Mac will try again.'

  it('says plainly when a disconnect could not be saved, also after Settings is opened again', async () => {
    draw(connectBridge(UNSAVED))
    await flush()
    expect(text('connect-message')).toBe(UNSAVED_TEXT)
    expect(shown('connect-form')).toBe(true)
    expect(shown('connect-hub')).toBe(false)
  })

  it('a disconnect whose save failed says that, not “couldn’t disconnect”', async () => {
    const api = connectBridge({ ...NONE, hub: hub('online') })
    api.forget.mockImplementation(async () => {
      api.quietly(UNSAVED)
      return { ok: false, reason: 'failed' }
    })
    draw(api)
    await flush()
    press('connect-disconnect')
    await flush()
    press('connect-confirm-yes')
    await flush()
    expect(text('connect-message')).toBe(UNSAVED_TEXT)
    expect(shown('connect-form')).toBe(true)
  })

  it('“a Mac is already connected” with no Mac stored is that same unsaved disconnect, with no Replace', async () => {
    await refusedWith({ ok: false, reason: 'hub_exists' }, UNSAVED)
    expect(text('connect-message')).toBe('This Mac still couldn’t save that it stopped using the other Mac’s Inbox. Try again in a moment.')
    expect(shown('connect-replace')).toBe(false)
  })

  it('says when a disconnect failed', async () => {
    const api = connectBridge({ ...NONE, hub: hub('online') })
    api.forget.mockResolvedValue({ ok: false, reason: 'failed' })
    draw(api)
    await flush()
    press('connect-disconnect')
    await flush()
    press('connect-confirm-yes')
    await flush()
    expect(text('connect-message')).toBe('Agent Inbox couldn’t disconnect. Try again.')
  })
})

// ── a saved file with a problem, and no Mac ─────────────────────────────────

describe('a saved connection with a problem', () => {
  it.each(STORE_PROBLEMS.filter((problem) => problem !== 'forget_not_saved'))('“%s” is said in plain words above the form', async (problem) => {
    draw(connectBridge({ ...NONE, problem }))
    await flush()
    const message = text('connect-message')
    expect(message).not.toBe('')
    expect(message).not.toMatch(/undefined|null|_/)
  })

  it('a newer Agent Inbox’s file hides the form, since it is never written', async () => {
    draw(connectBridge({ ...NONE, problem: 'newer_schema' }))
    await flush()
    expect(text('connect-message')).toBe('A newer Agent Inbox saved this Mac’s connection. Update Agent Inbox on this Mac to change it.')
    expect(shown('connect-form')).toBe(false)
  })
})

// ── text, names and repeated changes ────────────────────────────────────────

describe('what it draws', () => {
  it('sets the label as text: a label holding markup stays text', async () => {
    const label = '<img src=x onerror="globalThis.pwned=1">'
    draw(connectBridge({ ...NONE, hub: hub('refused', 'refused', { label }) }))
    await flush()
    expect(text('connect-hub-name')).toBe(`${label}’s Inbox`)
    expect(text('connect-hub-status')).toBe(`Not connected. ${label} no longer accepts this Mac.`)
    expect($('connect-settings')?.querySelector('img')).toBeNull()
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined()
  })

  it('gives every control a real element and a name', async () => {
    const api = connectBridge({ ...NONE, hub: hub('online') })
    draw(api)
    await flush()
    press('connect-disconnect')
    await flush()
    api.quietly(NONE)
    api.set(NONE)
    await flush()
    const section = $('connect-settings')!
    for (const button of section.querySelectorAll('button')) {
      expect(button.tagName).toBe('BUTTON')
      expect(button.textContent?.trim(), button.id).not.toBe('')
      expect(button.getAttribute('type'), button.id).toMatch(/^(button|submit)$/)
    }
    for (const input of section.querySelectorAll('input')) {
      expect(section.querySelector(`label[for="${input.id}"]`)?.textContent?.trim(), input.id).not.toBe('')
    }
    expect(section.querySelectorAll('[role="button"], div[onclick], span[onclick]').length).toBe(0)
  })

  it('draws once however often main says something changed', async () => {
    const api = connectBridge()
    draw(api)
    await flush()
    for (let i = 0; i < 4; i += 1) api.set(i % 2 ? { ...NONE, hub: hub('online') } : NONE)
    await flush()
    api.set({ ...NONE, hub: hub('online') })
    await flush()
    expect(document.querySelectorAll('#connect-settings').length).toBe(1)
    const section = $('connect-settings')!
    expect(section.querySelectorAll('h3').length).toBe(1)
    expect(section.querySelectorAll('form').length).toBe(1)
    expect(section.querySelectorAll('#connect-show').length).toBe(1)
    expect(api.onChange).toHaveBeenCalledTimes(1)
    expect(text('connect-hub-status')).toBe('Online')
  })

  it('keeps what was typed when main says something changed', async () => {
    const api = connectBridge()
    draw(api)
    await flush()
    type('connect-address', 'mbp.example.ts.net')
    type('connect-code', 'ABCD')
    const before = $('connect-address')
    api.set(NONE)
    await flush()
    expect($('connect-address')).toBe(before)
    expect($<HTMLInputElement>('connect-address')?.value).toBe('mbp.example.ts.net')
    expect($<HTMLInputElement>('connect-code')?.value).toBe('ABCD')
  })

  it('paints the newest answer when two reads cross', async () => {
    const api = connectBridge()
    const answers: Array<(value: View) => void> = []
    api.view.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    draw(api)
    await flush()
    api.set(NONE)
    await flush()
    expect(answers.length).toBe(2)
    answers[1]!({ ...NONE, hub: hub('online') })
    await flush()
    answers[0]!(NONE)
    await flush()
    expect(text('connect-hub-name')).toBe('MBP’s Inbox')
  })
})

// ── the code rule, against the controller's ─────────────────────────────────

describe('the code check on this side', () => {
  it('agrees with the controller’s normaliseCode over many inputs', () => {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -/_.é\t'
    let seed = 7
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed }
    const inputs: unknown[] = ['', ' ', 'ABCDEFGHJK', 'abcd-efgh-jk', 'ABCDE FGHJK', 'IIIIIOOOOO', 'llllloooo0', 'ABCDEFGHJU', null, 42, undefined]
    for (let i = 0; i < 3000; i += 1) {
      const length = next() % 16
      let value = ''
      for (let j = 0; j < length; j += 1) value += alphabet[next() % alphabet.length]
      inputs.push(value)
    }
    for (const input of inputs) expect(normaliseCode(input), JSON.stringify(input)).toBe(remoteConnect.normaliseCode(input))
  })
})

// ── in the app ──────────────────────────────────────────────────────────────

describe('in Settings, in the app', () => {
  useDomTest()
  let db: Database.Database | null = null
  afterEach(() => {
    db?.close()
    db = null
    Reflect.deleteProperty(window, 'agentInboxConnect')
    Reflect.deleteProperty(window, 'agentInboxDesk')
  })

  it('is drawn in this Mac’s own window, and asked again when Settings opens', async () => {
    const api = connectBridge()
    Object.defineProperty(window, 'agentInboxConnect', { configurable: true, value: api })
    Object.defineProperty(window, 'agentInboxDesk', { configurable: true, value: localDesk() })
    db = freshDb()
    await bootApp(db)
    expect(document.querySelectorAll('#setup #connect-settings').length).toBe(1)
    const calls = api.view.mock.calls.length
    click(document.getElementById('gear'))
    await settle()
    expect(api.view.mock.calls.length).toBe(calls + 1)
    expect(document.querySelectorAll('#connect-settings').length).toBe(1)
  })

  it('is not drawn in a browser', async () => {
    db = freshDb()
    await bootApp(db)
    expect(document.getElementById('connect-settings')).toBeNull()
  })
})
