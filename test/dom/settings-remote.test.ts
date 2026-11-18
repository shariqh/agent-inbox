// @vitest-environment jsdom
// test/dom/settings-remote.test.ts — #617 PR 2d: Settings → Other devices, the hub's sharing panel
// (public/remote-settings.js), drawn from a stubbed agentInboxRemoteEntry bridge. Most tests draw
// the section into a bare host; the last ones boot the real app to check where it sits.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { T0, bootApp, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

const HOST = 'hub.example.ts.net'
const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const D1 = '1'.repeat(64)
const D2 = '2'.repeat(64)
const CODE = '7K3QX-9M2PD'

type View = Record<string, unknown>

const OFF: View = {
  available: true, enabled: false, host: null, port: 4320, devices: [], unreadableDevices: 0, problem: null, flag: false, digest: D1,
  wanted: false, stopped: null, resume: null, needsOwner: null, stateSaved: true, serve: null, removalHint: null,
  command: 'tailscale serve --bg 4320', loginItem: { available: true, openAtLogin: false, needsApproval: false }, listening: false,
  listenError: null, changes: null, refusal: null,
}
const ON: View = { ...OFF, enabled: true, host: HOST, wanted: true, serve: { ok: true }, listening: true }
const LAPTOP = { id: A, label: 'laptop', pairedAt: '2026-07-19T09:00:00.000Z' }
const NONE_CHANGES = {
  unknown: false, missing: false, unreadable: false, switched: null, address: false, account: false, port: false,
  added: [], removed: [], keyChanged: [], unreadableAdded: 0, unreadableRemoved: 0,
}

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  Reflect.deleteProperty(window, 'agentInboxRemoteEntry')
  Reflect.deleteProperty(navigator, 'clipboard')
  document.body.replaceChildren()
})

/** A main process as far as the panel can tell: get() answers `view`, and each operation is a spy. */
function bridge(start: View = OFF) {
  let view: View = structuredClone(start)
  let listener: (() => void) | null = null
  const api = {
    get: vi.fn(async () => structuredClone(view)),
    turnOn: vi.fn(async (): Promise<View> => { view = { ...view, ...ON, devices: view.devices }; return { ok: true, voidedCode: false, devicesRemoved: 0, droppedEntries: 0 } }),
    turnOff: vi.fn(async (): Promise<View> => { view = { ...view, enabled: false, wanted: false }; return { ok: true, voidedCode: false } }),
    removeDevice: vi.fn(async (id: string): Promise<View> => {
      view = { ...view, devices: (view.devices as Array<{ id: string }>).filter((d) => d.id !== id), digest: D2 }
      return { ok: true, voidedCode: true }
    }),
    clearUnreadable: vi.fn(async (): Promise<View> => { view = { ...view, unreadableDevices: 0 }; return { ok: true, voidedCode: false, removed: 2 } }),
    repairPermissions: vi.fn(async (): Promise<View> => { view = { ...OFF }; return { ok: true, voidedCode: false, devicesRemoved: 1 } }),
    acknowledge: vi.fn(async (_digest: string): Promise<View> => { view = { ...view, flag: false }; return { ok: true } }),
    test: vi.fn(async (): Promise<View> => ({ ok: true })),
    addDevice: vi.fn(async (): Promise<View> => ({ ok: true, code: CODE, expiresAt: new Date(Date.now() + 600_000).toISOString() })),
    setOpenAtLogin: vi.fn(async (value: boolean): Promise<View> => {
      view = { ...view, loginItem: { available: true, openAtLogin: value, needsApproval: false } }
      return { ok: true, openAtLogin: value }
    }),
    turnOnRemovingDevices: vi.fn(async (): Promise<View> => {
      view = { ...view, ...ON, devices: [], refusal: null }
      return { ok: true, voidedCode: false, devicesRemoved: 2, droppedEntries: 0 }
    }),
    recheck: vi.fn(async (): Promise<View> => ({ ok: true })),
    onChange: vi.fn((fn: (() => void) | null) => { listener = fn; return true }),
  }
  Object.defineProperty(window, 'agentInboxRemoteEntry', { configurable: true, value: api })
  return Object.assign(api, {
    set(next: View) { view = structuredClone(next) },
    current: () => view,
    ping() { listener?.() },
  })
}

async function draw(): Promise<HTMLElement | null> {
  const mod = await import('../../public/remote-settings.js')
  const host = document.createElement('div')
  host.id = 'host'
  document.body.appendChild(host)
  const section = mod.renderRemoteSettings(host)
  await settle()
  return section as HTMLElement | null
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(`#remote-settings ${selector}`)
const text = (selector: string) => $(selector)?.textContent ?? null
const sw = () => $<HTMLInputElement>('#remote-switch')
const status = () => text('#remote-status')
const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>('#remote-settings button')].find((b) => b.textContent === label) ?? null
const toggle = (el: HTMLInputElement | null) => {
  if (!el) throw new Error('no checkbox')
  el.click()
}
const instruction = () => text('.remote-instruction p')

/** main refusing the next switch-on, as it does: the refusal comes back in get() (review round 1, item 4) */
function refuse(api: ReturnType<typeof bridge>, reason: string, step: string, devices: number | null = null) {
  api.turnOn.mockImplementationOnce(async () => {
    api.set({ ...api.current(), refusal: { reason, step, devices, at: Date.now() } })
    return devices === null ? { ok: false, reason, step } : { ok: false, reason, step, devices }
  })
}

describe('Settings → Other devices: what it shows', () => {
  it('off: the switch, the status, the risk sentence, Add a Mac disabled, open at login; nothing else', async () => {
    bridge(OFF)
    const section = await draw()
    expect(section?.id).toBe('remote-settings')
    expect(text('h3')).toBe('Other devices')
    expect(sw()?.type).toBe('checkbox')
    expect(sw()?.getAttribute('role')).toBe('switch')
    expect(sw()?.checked).toBe(false)
    expect(document.querySelector(`label[for="remote-switch"]`)?.textContent).toBe('Let my other Macs use this Inbox')
    expect(status()).toBe('Off')
    expect(text('.remote-risk')).toBe('A paired Mac can read everything in this Inbox and send messages to your sessions, which may act without asking.')
    expect(button('Add a Mac')?.disabled).toBe(true)
    expect($('.remote-instruction')).toBeNull()
    expect($('.remote-flag')).toBeNull()
    expect($('.remote-devices')).toBeNull()
    expect($('#remote-test')).toBeNull()
    expect($('.remote-removal')).toBeNull()
    expect($('.remote-not-saved')).toBeNull()
    expect(document.querySelector('label[for="remote-login"]')?.textContent).toBe('Open Agent Inbox at login')
    expect(text('.remote-login-hint')).toBe('Needed for sharing to come back after this Mac restarts.')
  })

  it('on: the address with Copy address, Add a Mac and Test', async () => {
    bridge({ ...ON, devices: [LAPTOP] })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await draw()
    expect(sw()?.checked).toBe(true)
    expect(status()).toBe(`On, at https://${HOST}`)
    click(button('Copy address'))
    await settle()
    expect(writeText).toHaveBeenCalledWith(`https://${HOST}`)
    expect(button('Add a Mac')?.disabled).toBe(false)
    expect(button('Test')).not.toBeNull()
  })

  it('switching on asks main, and switching off too', async () => {
    const api = bridge(OFF)
    await draw()
    toggle(sw())
    await settle()
    expect(api.turnOn).toHaveBeenCalledOnce()
    expect(status()).toBe(`On, at https://${HOST}`)
    toggle(sw())
    await settle()
    expect(api.turnOff).toHaveBeenCalledOnce()
    expect(status()).toBe('Off')
  })

  it.each([
    ['tailscale_not_running', 'Tailscale is not running', 'Open Tailscale on this Mac and connect. Sharing then comes back by itself.'],
    ['tailscale_unreadable', 'Agent Inbox can’t read Tailscale', 'Check that Tailscale is running on this Mac. Sharing then comes back by itself.'],
    // review round 1, item 11: what Tailscale said, when main knows it
    ['self_not_ok:no_login', 'Tailscale is signed out', 'Sign in to Tailscale on this Mac. Sharing then comes back by itself.'],
    ['self_not_ok:no_cli', 'Tailscale is not installed', 'Install Tailscale on this Mac and sign in. Sharing then comes back by itself.'],
    ['serve_not_ok:foreground', 'another tailscale serve is running', 'Another tailscale serve is running on this Mac. Stop it. Sharing then comes back by itself.'],
    ['serve_not_ok:services', 'a Tailscale Service is set up on this Mac', 'A Tailscale Service is set up on this Mac, and Agent Inbox can’t check what it forwards. Remove it. Sharing then comes back by itself.'],
    ['serve_not_ok:no_handler', 'Tailscale Serve is not set up for Agent Inbox', 'Run this once in Terminal on this Mac, and sharing comes back by itself:'],
    ['serve_not_ok:wrong_target', 'Tailscale Serve on this Mac forwards this address to something else', 'Tailscale Serve on this Mac is forwarding this address to something else. This replaces it:'],
    ['serve_not_ok:unknown_shape', 'Tailscale Serve on this Mac is set up in a way Agent Inbox doesn’t recognise', 'Tailscale Serve on this Mac is set up in a way Agent Inbox doesn’t recognise. Run this in Terminal to see it:'],
    ['serve_not_ok:funnel', 'Tailscale Funnel is on for this Mac', 'Tailscale Funnel would put this Inbox on the internet. Turn Funnel off for this Mac. Sharing then comes back by itself.'],
    ['write_failed', 'Agent Inbox couldn’t save the sharing settings', 'Agent Inbox couldn’t save its sharing settings file. It tries again by itself.'],
    ['changed_outside', 'the sharing settings were changed outside Agent Inbox', 'Agent Inbox is checking the changed settings.'],
  ])('paused (%s): why, the next try, and what to do', async (waiting, why, what) => {
    const nextAt = T0 + 5 * 60_000
    bridge({ ...OFF, host: HOST, wanted: true, stopped: { reason: 'not_running', willResume: true }, resume: { waiting, nextAt } })
    await draw()
    const at = new Date(nextAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    expect(status()).toBe(`Paused: ${why}, next try at ${at}`)
    expect(sw()?.checked).toBe(true)
    expect(instruction()).toBe(what)
    const command = { 'serve_not_ok:no_handler': 'tailscale serve --bg 4320', 'serve_not_ok:wrong_target': 'tailscale serve --bg 4320', 'serve_not_ok:unknown_shape': 'tailscale serve status' }
    expect(text('.remote-instruction pre')).toBe(command[waiting as keyof typeof command] ?? null)
  })

  it('paused with no next try says only why', async () => {
    bridge({ ...OFF, wanted: true, resume: { waiting: 'tailscale_not_running', nextAt: null } })
    await draw()
    expect(status()).toBe('Paused: Tailscale is not running')
  })

  it('needs you: a stop that will not come back by itself, with its reason and what to do', async () => {
    bridge({ ...OFF, host: HOST, stopped: { reason: 'funnel', willResume: false } })
    await draw()
    expect(status()).toBe('Needs you: Tailscale Funnel is on for this Mac')
    expect(sw()?.checked).toBe(false)
    expect(instruction()).toBe('Tailscale Funnel would put this Inbox on the internet. Turn Funnel off for this Mac, then switch on again.')
  })

  it('needs you: this Mac\'s name or account changed', async () => {
    bridge({ ...OFF, host: HOST, needsOwner: 'identity_changed', stopped: { reason: 'identity_changed', willResume: false } })
    await draw()
    expect(status()).toBe('Needs you: this Mac’s Tailscale name or account changed')
    expect(instruction()).toBe('This Mac’s Tailscale name or account changed. Switching on again removes the paired Macs.')
    bridge({ ...OFF, host: HOST, needsOwner: 'identity_changed' })
    document.body.replaceChildren()
    await draw()
    expect(status()).toBe('Needs you: this Mac’s Tailscale name or account changed')
  })

  // review round 1, item 11
  it('a stop that will not resume while sharing is still wanted shows its real reason', async () => {
    bridge({ ...OFF, host: HOST, wanted: true, resume: { waiting: 'needs_owner', nextAt: null }, stopped: { reason: 'funnel', willResume: false } })
    await draw()
    expect(status()).toBe('Needs you: Tailscale Funnel is on for this Mac')
    expect(instruction()).toBe('Tailscale Funnel would put this Inbox on the internet. Turn Funnel off for this Mac, then switch on again.')
  })

  it('a stop Agent Inbox made to keep sharing off is only Off: the flag says the rest', async () => {
    bridge({ ...OFF, stopped: { reason: 'not_wanted', willResume: false } })
    await draw()
    expect(status()).toBe('Off')
    expect($('.remote-instruction')).toBeNull()
  })

  it.each([
    ['serve', 'no_handler', 'Run this once in Terminal on this Mac, then switch on again:', true],
    ['serve', 'wrong_target', 'Tailscale Serve on this Mac is forwarding this address to something else. This replaces it:', true],
    ['serve', 'handler_fields', 'Tailscale Serve on this Mac is forwarding this address to something else. This replaces it:', true],
    ['serve', 'foreground', 'Another tailscale serve is running on this Mac. Stop it, then switch on again.', false],
    ['serve', 'services', 'A Tailscale Service is set up on this Mac, and Agent Inbox can’t check what it forwards. Remove it, then switch on again.', false],
    ['serve', 'other_path', 'Tailscale Serve on this Mac has other settings that could reach this Inbox. Remove them, then switch on again.', false],
    ['self', 'no_cli', 'Install Tailscale on this Mac and sign in, then switch on again.', false],
    ['self', 'not_running', 'Open Tailscale on this Mac and connect, then switch on again.', false],
    ['self', 'no_login', 'Sign in to Tailscale on this Mac, then switch on again.', false],
    ['self', 'tagged', 'Sharing needs a personal Tailscale login on this Mac. Sign in to Tailscale with your own account, then switch on again.', false],
    ['file', 'other_viewer', 'The other copy of Agent Inbox on this Mac (the installed app or a build from source) is sharing. Switch it off there first.', false],
    ['file', 'newer_schema', 'A newer version of Agent Inbox saved these settings. Update Agent Inbox to change them.', false],
  ])('switching on refused at %s (%s): one instruction', async (step, reason, what, command) => {
    const api = bridge(OFF)
    refuse(api, reason, step)
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await draw()
    toggle(sw())
    await settle()
    expect(sw()?.checked).toBe(false)
    expect(status()).toMatch(/^Needs you: /)
    expect(document.querySelectorAll('#remote-settings .remote-instruction')).toHaveLength(1)
    expect(instruction()).toBe(what)
    if (command) {
      expect(text('.remote-instruction pre')).toBe('tailscale serve --bg 4320')
      click(button('Copy', $('.remote-instruction')!))
      await settle()
      expect(writeText).toHaveBeenCalledWith('tailscale serve --bg 4320')
    } else {
      expect($('.remote-instruction pre')).toBeNull()
    }
    // switching on again that works clears it
    toggle(sw())
    await settle()
    expect($('.remote-instruction')).toBeNull()
  })

  it('a command to look at Serve, not to change it, for a shape it doesn\'t recognise', async () => {
    const api = bridge(OFF)
    refuse(api, 'not_https', 'serve')
    await draw()
    toggle(sw())
    await settle()
    expect(instruction()).toBe('Tailscale Serve on this Mac is set up in a way Agent Inbox doesn’t recognise. Run this in Terminal to see it:')
    expect(text('.remote-instruction pre')).toBe('tailscale serve status')
  })

  it('a file other accounts can read: says so and offers to make it private', async () => {
    const api = bridge({ ...OFF, problem: 'open_to_others' })
    await draw()
    expect(status()).toBe('Needs you: other accounts on this Mac can read the sharing settings')
    expect(instruction()).toBe('Other accounts on this Mac can read the sharing settings file. Making it private switches sharing off and removes the paired Macs.')
    click(button('Make it private'))
    await settle()
    expect(api.repairPermissions).toHaveBeenCalledOnce()
    expect(status()).toBe('Off')
    expect(text('.remote-message')).toBe('The sharing settings file is private again. Sharing is off, and 1 paired Mac was removed.')
  })

  // review round 1, item 8
  it('asks before switching on removes the paired Macs, and removes them only when told to', async () => {
    const api = bridge({ ...OFF, devices: [LAPTOP, { id: B, label: 'desk', pairedAt: null }] })
    refuse(api, 'would_remove_devices', 'file', 2)
    await draw()
    toggle(sw())
    await settle()
    expect(sw()?.checked).toBe(false)
    expect(status()).toBe('Needs you: this Mac’s Tailscale name or account changed')
    expect(instruction()).toBe('This Mac’s Tailscale name or account is not the one these Macs were paired under. Switching on removes the 2 paired Macs; pair them again afterwards.')
    click(button('Switch on and remove them'))
    await settle()
    expect(api.turnOnRemovingDevices).toHaveBeenCalledOnce()
    expect(status()).toBe(`On, at https://${HOST}`)
    expect(text('.remote-message')).toBe('Switching on removed 2 paired Macs. Pair them again with Add a Mac.')
  })

  it('Cancel leaves sharing off and the paired Macs as they are', async () => {
    const api = bridge({ ...OFF, devices: [LAPTOP] })
    refuse(api, 'would_remove_devices', 'file', 1)
    await draw()
    toggle(sw())
    await settle()
    expect(instruction()).toBe('This Mac’s Tailscale name or account is not the one this Mac was paired under. Switching on removes the paired Mac; pair it again afterwards.')
    click(button('Cancel'))
    await settle()
    expect(api.turnOnRemovingDevices).not.toHaveBeenCalled()
    expect($('.remote-instruction')).toBeNull()
    expect(status()).toBe('Off')
    expect(text('.remote-device-label')).toBe('laptop')
  })

  // review round 1, item 4: what is drawn comes from get() alone
  it('a refusal goes when main says so: after making the file private, one sentence and no second button', async () => {
    const api = bridge({ ...OFF, problem: 'open_to_others' })
    refuse(api, 'open_to_others', 'file')
    api.repairPermissions.mockImplementationOnce(async () => { api.set({ ...OFF }); return { ok: true, voidedCode: false, devicesRemoved: 1 } })
    await draw()
    toggle(sw())
    await settle()
    click(button('Make it private'))
    await settle()
    expect(status()).toBe('Off')
    expect(button('Make it private')).toBeNull()
    expect($('.remote-instruction')).toBeNull()
    expect(text('.remote-message')).toBe('The sharing settings file is private again. Sharing is off, and 1 paired Mac was removed.')
  })

  it('a refusal main dropped because the file changed is not drawn: the newer problem is', async () => {
    const api = bridge(OFF)
    refuse(api, 'no_handler', 'serve')
    await draw()
    toggle(sw())
    await settle()
    expect(instruction()).toBe('Run this once in Terminal on this Mac, then switch on again:')
    api.set({ ...OFF, problem: 'open_to_others' })
    api.ping()
    await settle()
    expect(status()).toBe('Needs you: other accounts on this Mac can read the sharing settings')
    expect(instruction()).toMatch(/^Other accounts on this Mac can read/)
    expect(document.querySelectorAll('#remote-settings .remote-instruction')).toHaveLength(1)
  })

  // review round 1, item 3
  it('a port another program holds: needs you, what to do, and Test says the same', async () => {
    const api = bridge({ ...ON, listening: false, listenError: 'port_in_use' })
    api.test.mockResolvedValueOnce({ ok: false, reason: 'port_in_use', rose: null })
    await draw()
    expect(status()).toBe('Needs you: another program on this Mac is using port 4320')
    expect(sw()?.checked).toBe(true)
    expect(instruction()).toBe('Quit that program, or switch sharing off. Until then Tailscale forwards your other Macs to it.')
    expect(button('Add a Mac')?.disabled).toBe(true)
    click(button('Test'))
    await settle()
    expect(text('.remote-test-result')).toBe('Another program on this Mac is using port 4320. Quit that program, or switch sharing off. Until then Tailscale forwards your other Macs to it.')
  })
})

// #617 PR 2d, from the real-app run: the viewer opens the listener a moment after the file says on
describe('while the Inbox is starting to answer', () => {
  it('on but not listening yet: "On, starting…", with Test and Add a Mac disabled until it listens', async () => {
    const api = bridge({ ...ON, listening: false })
    await draw()
    expect(status()).toBe('On, starting…')
    expect(sw()?.checked).toBe(true)
    expect(button('Test')?.disabled).toBe(true)
    expect(button('Add a Mac')?.disabled).toBe(true)
    expect(button('Copy address')).toBeNull()
    api.set({ ...ON, listening: true })
    api.ping()
    await settle()
    expect(status()).toBe(`On, at https://${HOST}`)
    expect(button('Test')?.disabled).toBe(false)
    expect(button('Add a Mac')?.disabled).toBe(false)
  })

  it('a Test result goes when a new test starts', async () => {
    const api = bridge(ON)
    await draw()
    api.test.mockResolvedValueOnce({ ok: false, reason: 'no_backend', rose: null })
    click(button('Test'))
    await settle()
    expect(text('.remote-test-result')).toBe('Tailscale is forwarding, but this Inbox isn’t answering.')
    let finish!: (value: View) => void
    api.test.mockImplementationOnce(() => new Promise<View>((resolve) => { finish = resolve }))
    click(button('Test'))
    await settle()
    expect($('.remote-test-result')).toBeNull()
    finish({ ok: true })
    await settle()
    expect(text('.remote-test-result')).toBe('Working: Tailscale reaches this Inbox, and it asks for a paired Mac.')
  })

  it('a Test result goes when the switch changes, even if the change is refused', async () => {
    const api = bridge(ON)
    api.turnOff.mockResolvedValueOnce({ ok: false, reason: 'write_failed' })
    await draw()
    click(button('Test'))
    await settle()
    expect($('.remote-test-result')).not.toBeNull()
    toggle(sw())
    await settle()
    expect(status()).toBe(`On, at https://${HOST}`)
    expect($('.remote-test-result')).toBeNull()
  })

  it.each([
    ['paused', { ...ON, enabled: false, resume: { waiting: 'tailscale_not_running', nextAt: null } }],
    ['off', { ...OFF }],
    ['on, starting again', { ...ON, listening: false }],
    ['on at another address', { ...ON, host: 'other.example.ts.net' }],
  ])('a Test result goes when the state it described changes (%s)', async (_name, next) => {
    const api = bridge(ON)
    await draw()
    click(button('Test'))
    await settle()
    expect($('.remote-test-result')).not.toBeNull()
    api.set(next)
    api.ping()
    await settle()
    expect($('.remote-test-result')).toBeNull()
  })

  it('a Test result stays while nothing it described changed', async () => {
    const api = bridge(ON)
    await draw()
    click(button('Test'))
    await settle()
    api.set({ ...ON, devices: [LAPTOP], digest: D2 })
    api.ping()
    await settle()
    expect(text('.remote-test-result')).toBe('Working: Tailscale reaches this Inbox, and it asks for a paired Mac.')
  })
})

describe('paired Macs', () => {
  it('lists each with its label and when it was paired, and removes one after an inline confirm', async () => {
    const api = bridge({ ...ON, devices: [LAPTOP, { id: B, label: 'desk', pairedAt: null }] })
    await draw()
    expect(text('.remote-devices h4')).toBe('Paired Macs')
    const items = [...document.querySelectorAll('#remote-settings .remote-device')]
    expect(items.map((li) => li.querySelector('.remote-device-label')?.textContent)).toEqual(['laptop', 'desk'])
    const day = new Date(LAPTOP.pairedAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
    expect(items[0]?.querySelector('.remote-device-when')?.textContent).toBe(`Paired ${day}`)
    expect(items[1]?.querySelector('.remote-device-when')).toBeNull()

    click($('button[aria-label="Remove laptop"]'))
    await settle()
    expect(api.removeDevice).not.toHaveBeenCalled()
    expect(text('.remote-confirm p')).toBe('Remove laptop?')
    expect(document.activeElement?.textContent).toBe('Keep')
    click(button('Keep'))
    await settle()
    expect($('.remote-confirm')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove laptop')

    click($('button[aria-label="Remove laptop"]'))
    await settle()
    click(button('Remove', $('.remote-confirm')!))
    await settle()
    expect(api.removeDevice).toHaveBeenCalledWith(A)
    expect([...document.querySelectorAll('#remote-settings .remote-device-label')].map((el) => el.textContent)).toEqual(['desk'])
  })

  it('counts the entries that can\'t be read, and Clear drops them', async () => {
    const api = bridge({ ...ON, devices: [LAPTOP], unreadableDevices: 2 })
    await draw()
    expect(text('.remote-unreadable span')).toBe('2 paired Macs that can’t be read (they can no longer connect)')
    click(button('Clear'))
    await settle()
    expect(api.clearUnreadable).toHaveBeenCalledOnce()
    expect($('.remote-unreadable')).toBeNull()
    api.set({ ...ON, unreadableDevices: 1 })
    api.ping()
    await settle()
    expect(text('.remote-unreadable span')).toBe('1 paired Mac that can’t be read (it can no longer connect)')
  })
})

describe('Add a Mac', () => {
  const codeShown = () => text('.remote-code')

  it('shows the code large, what to do on the other Mac, the address and a countdown', async () => {
    bridge({ ...ON, devices: [LAPTOP] })
    await draw()
    click(button('Add a Mac'))
    await settle()
    expect(codeShown()).toBe(CODE)
    expect(text('.remote-code-help')).toBe('On the other Mac: Settings → Use another Mac’s Inbox, then enter this Mac’s address and this code. It works once, for 10 minutes.')
    expect(text('.remote-code-address')).toBe(`Address: https://${HOST}`)
    expect(text('.remote-code-time')).toBe('Time left: 10:00')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(text('.remote-code-time')).toBe('Time left: 8:59')
  })

  it('goes away when it expires', async () => {
    bridge({ ...ON })
    await draw()
    click(button('Add a Mac'))
    await settle()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(codeShown()).toBeNull()
    expect(text('.remote-add-message')).toBe('That code ran out. Make a new one.')
  })

  it('goes away when it is used, and says which Mac it paired', async () => {
    const api = bridge({ ...ON, devices: [LAPTOP] })
    await draw()
    click(button('Add a Mac'))
    await settle()
    api.set({ ...ON, devices: [LAPTOP, { id: B, label: 'desk', pairedAt: null }], digest: D2 })
    api.ping()
    await settle()
    expect(codeShown()).toBeNull()
    expect(text('.remote-add-message')).toBe('desk can now use this Inbox.')
  })

  it('says it was cancelled when a later change voided it', async () => {
    const api = bridge({ ...ON, devices: [LAPTOP] })
    await draw()
    click(button('Add a Mac'))
    await settle()
    api.set({ ...ON, devices: [LAPTOP], digest: D2 })
    api.ping()
    await settle()
    expect(codeShown()).toBeNull()
    expect(text('.remote-add-message')).toBe('That code was cancelled. Make a new one.')
  })

  it('says it was cancelled when one of its own changes voided it', async () => {
    const api = bridge({ ...ON, devices: [LAPTOP, { id: B, label: 'desk', pairedAt: null }] })
    api.removeDevice.mockImplementationOnce(async () => ({ ok: true, voidedCode: true }))
    await draw()
    click(button('Add a Mac'))
    await settle()
    click($('button[aria-label="Remove desk"]'))
    await settle()
    click(button('Remove', $('.remote-confirm')!))
    await settle()
    expect(codeShown()).toBeNull()
    expect(text('.remote-add-message')).toBe('That code was cancelled. Make a new one.')
  })

  it('says why no code was made', async () => {
    const api = bridge(ON)
    api.addDevice.mockResolvedValueOnce({ ok: false, reason: 'not_listening' })
    await draw()
    click(button('Add a Mac'))
    await settle()
    expect(codeShown()).toBeNull()
    expect(text('.remote-add-message')).toBe('Sharing isn’t ready yet. Try again in a moment.')
  })
})

describe('changed outside Agent Inbox', () => {
  const NONE = {
    unknown: false, missing: false, unreadable: false, switched: null, address: false, account: false, port: false,
    added: [], removed: [], keyChanged: [], unreadableAdded: 0, unreadableRemoved: 0,
  }
  const FLAGGED: View = {
    ...ON, flag: true, digest: D1, devices: [LAPTOP, { id: B, label: 'stranger', pairedAt: null }], changes: { ...NONE, added: ['stranger'] },
  }
  const lines = () => [...$('.remote-flag')!.querySelectorAll('p, li')].map((el) => el.textContent)
  const END = 'If you didn’t make this change, switch sharing off and remove the paired Macs.'

  it('is at the very top, says what changed and how it is now, and Looks right accepts exactly what is shown', async () => {
    const api = bridge(FLAGGED)
    await draw()
    const section = document.getElementById('remote-settings')!
    expect(section.children[1]?.classList.contains('remote-flag')).toBe(true)
    expect($('.remote-flag')?.getAttribute('role')).toBe('alert')
    expect(lines()).toEqual([
      'The sharing settings were changed outside Agent Inbox.',
      'Mac added: stranger.',
      'This is how the settings are now:',
      `Sharing is on, at https://${HOST}.`,
      'Paired Macs: laptop, stranger.',
      END,
    ])
    click(button('Looks right'))
    await settle()
    expect(api.acknowledge).toHaveBeenCalledWith(D1)
    expect($('.remote-flag')).toBeNull()
  })

  // review round 1, item 7: a change the old box could not show
  it('names every kind of change, with labels only', async () => {
    bridge({
      ...FLAGGED,
      changes: {
        ...NONE, switched: 'on', address: true, account: true, port: true, added: ['desk'], removed: ['old'], keyChanged: ['laptop'], unreadableAdded: 2, unreadableRemoved: 1,
      },
    })
    await draw()
    expect([...$('.remote-flag ul')!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Sharing was switched on.', 'The address changed.', 'The allowed Tailscale account changed.', 'The port changed.',
      'Mac added: desk.', 'Mac removed: old.', 'The key of laptop changed.',
      '2 paired Macs that can’t be read were added.', '1 paired Mac that can’t be read was removed.',
    ])
  })

  it('when it can\'t tell what changed (the app was closed), says so and shows how it is now', async () => {
    bridge({ ...OFF, flag: true, unreadableDevices: 3, changes: { ...NONE, unknown: true } })
    await draw()
    expect(lines()).toEqual([
      'The sharing settings were changed outside Agent Inbox.',
      'Agent Inbox can’t tell what changed, because it happened while the app was closed. This is how the settings are now:',
      'Sharing is off.', 'No paired Macs.', '3 paired Macs that can’t be read (they can no longer connect).', END,
    ])
    expect(button('Looks right')).not.toBeNull()
  })

  it('a file it can\'t read: says so, offers no Looks right, and never says "No paired Macs."', async () => {
    for (const view of [{ ...OFF, flag: true, problem: 'not_json', changes: { ...NONE, unreadable: true } }, { ...OFF, flag: true, problem: 'bad_devices', changes: { ...NONE } }]) {
      document.body.replaceChildren()
      bridge(view)
      await draw()
      expect(lines()).toEqual([
        'The sharing settings were changed outside Agent Inbox.',
        'Agent Inbox can’t read the sharing settings file, so it can’t show what is in it.', END,
      ])
      expect(button('Looks right')).toBeNull()
    }
  })

  it('a file that was removed', async () => {
    bridge({ ...OFF, flag: true, changes: { ...NONE, missing: true } })
    await draw()
    expect(lines()).toEqual([
      'The sharing settings were changed outside Agent Inbox.', 'The sharing settings file was removed.',
      'This is how the settings are now:', 'Sharing is off.', 'No paired Macs.', END,
    ])
  })

  it('when it changed again, redraws and says so, and the next Looks right sends the new digest', async () => {
    const api = bridge(FLAGGED)
    api.acknowledge.mockImplementationOnce(async () => {
      api.set({
        ...FLAGGED, digest: D2, devices: [LAPTOP, { id: B, label: 'stranger', pairedAt: null }, { id: 'cccccccccccccccc', label: 'third', pairedAt: null }],
        changes: { ...NONE, added: ['stranger', 'third'] },
      })
      return { ok: false, reason: 'changed' }
    })
    await draw()
    click(button('Looks right'))
    await settle()
    expect(api.acknowledge).toHaveBeenLastCalledWith(D1)
    expect(text('.remote-flag-message')).toBe('It changed again; check the list.')
    expect(lines()).toContain('Paired Macs: laptop, stranger, third.')
    click(button('Looks right'))
    await settle()
    expect(api.acknowledge).toHaveBeenLastCalledWith(D2)
  })

  it('"It changed again" goes once the flag goes', async () => {
    const api = bridge(FLAGGED)
    api.acknowledge.mockImplementationOnce(async () => { api.set({ ...FLAGGED, digest: D2 }); return { ok: false, reason: 'changed' } })
    await draw()
    click(button('Looks right'))
    await settle()
    expect(text('.remote-flag-message')).toBe('It changed again; check the list.')
    api.set({ ...FLAGGED, digest: D2, flag: false, changes: null })
    api.ping()
    await settle()
    api.set({ ...FLAGGED, digest: D2 })
    api.ping()
    await settle()
    expect($('.remote-flag-message')).toBeNull()
  })

  it('a ping between drawing and pressing redraws first: what is acknowledged is what is on screen', async () => {
    const api = bridge(FLAGGED)
    await draw()
    api.set({ ...FLAGGED, digest: D2, devices: [LAPTOP], changes: { ...NONE, keyChanged: ['laptop'] } })
    api.ping()
    await settle()
    expect(lines()).toContain('Paired Macs: laptop.')
    click(button('Looks right'))
    await settle()
    expect(api.acknowledge).toHaveBeenCalledWith(D2)
  })
})

// review round 1, item 5
describe('while an operation runs', () => {
  const controls = () => [...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#remote-settings button, #remote-settings input')]

  it.each([
    ['turnOn', OFF, () => toggle(sw()), 'Switching on…'],
    ['turnOff', ON, () => toggle(sw()), 'Switching off…'],
    ['test', ON, () => click(button('Test')), 'Testing…'],
    ['addDevice', ON, () => click(button('Add a Mac')), 'Making a code…'],
  ] as const)('%s: every control is disabled and the status says so; the switch shows what the file says', async (op, start, act, words) => {
    const api = bridge(start)
    let finish!: (value: View) => void
    ;(api[op] as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<View>((resolve) => { finish = resolve }))
    await draw()
    act()
    await settle()
    expect(status()).toBe(words)
    expect(sw()?.checked).toBe(start.enabled)
    expect(controls().length).toBeGreaterThan(2)
    for (const el of controls()) expect(el.disabled, el.textContent || el.id).toBe(true)
    // a click on the switch now changes nothing
    toggle(sw())
    await settle()
    expect(api.turnOn.mock.calls.length + api.turnOff.mock.calls.length).toBe(op === 'turnOn' || op === 'turnOff' ? 1 : 0)
    finish(op === 'addDevice' ? { ok: false, reason: 'failed' } : { ok: true })
    await settle()
    expect(controls().some((el) => !el.disabled)).toBe(true)
  })

  it('Removing… while a paired Mac is removed', async () => {
    const api = bridge({ ...ON, devices: [LAPTOP] })
    let finish!: (value: View) => void
    api.removeDevice.mockImplementationOnce(() => new Promise<View>((resolve) => { finish = resolve }))
    await draw()
    click($('button[aria-label="Remove laptop"]'))
    await settle()
    click(button('Remove', $('.remote-confirm')!))
    await settle()
    expect(status()).toBe('Removing…')
    finish({ ok: true })
    await settle()
  })

  it('switching off while switching on is still running: the click is not taken, and the switch shows the file', async () => {
    const api = bridge(OFF)
    let finish!: () => void
    api.turnOn.mockImplementationOnce(() => new Promise<View>((resolve) => { finish = () => { api.set(ON); resolve({ ok: true }) } }))
    await draw()
    toggle(sw())
    await settle()
    expect(sw()?.checked).toBe(false)
    toggle(sw())
    await settle()
    expect(api.turnOff).not.toHaveBeenCalled()
    finish()
    await settle()
    expect(status()).toBe(`On, at https://${HOST}`)
    expect(sw()?.checked).toBe(true)
    expect(sw()?.disabled).toBe(false)
  })
})

// review round 1, item 10
describe('messages last only as long as what they speak of', () => {
  it('"<label> can now use this Inbox." goes when that Mac is removed', async () => {
    const api = bridge(ON)
    await draw()
    click(button('Add a Mac'))
    await settle()
    api.set({ ...ON, devices: [LAPTOP], digest: D2 })
    api.ping()
    await settle()
    expect(text('.remote-add-message')).toBe('laptop can now use this Inbox.')
    click($('button[aria-label="Remove laptop"]'))
    await settle()
    click(button('Remove', $('.remote-confirm')!))
    await settle()
    expect($('.remote-add-message')).toBeNull()
  })

  it('and when sharing goes off', async () => {
    const api = bridge(ON)
    await draw()
    click(button('Add a Mac'))
    await settle()
    api.set({ ...ON, devices: [LAPTOP], digest: D2 })
    api.ping()
    await settle()
    toggle(sw())
    await settle()
    expect(status()).toBe('Off')
    expect($('.remote-add-message')).toBeNull()
  })

  it('and after 2 minutes at the latest, as any other message', async () => {
    const api = bridge({ ...OFF, problem: 'open_to_others' })
    await draw()
    click(button('Make it private'))
    await settle()
    expect($('.remote-message')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(119_000)
    expect($('.remote-message')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    expect($('.remote-message')).toBeNull()
    void api
  })

  it('a failure line goes at the next change', async () => {
    const api = bridge(ON)
    api.turnOff.mockResolvedValueOnce({ ok: false, reason: 'write_failed' })
    await draw()
    toggle(sw())
    await settle()
    expect(text('.remote-message')).toBe('Agent Inbox couldn’t save its sharing settings file. Try again.')
    api.set({ ...ON, digest: D2 })
    api.ping()
    await settle()
    expect($('.remote-message')).toBeNull()
  })
})

describe('Test, the removal command, open at login and the saved record', () => {
  it.each([
    [{ ok: true }, 'Working: Tailscale reaches this Inbox, and it asks for a paired Mac.'],
    [{ ok: false, reason: 'unreachable', rose: null }, `This Mac couldn’t reach https://${HOST} through Tailscale. Check Tailscale Serve.`],
    [{ ok: false, reason: 'not_refused', rose: null }, `https://${HOST} answered without asking for a paired Mac. Check Tailscale Serve.`],
    [{ ok: false, reason: 'no_device_count', rose: 'login' }, 'Tailscale reached this Inbox without your login. Check that this Mac is signed in to Tailscale as you.'],
  ])('Test says %j in words', async (result, words) => {
    const api = bridge(ON)
    api.test.mockResolvedValueOnce(result)
    await draw()
    click(button('Test'))
    await settle()
    expect(text('.remote-test-result')).toBe(words)
  })

  it('off, with a Tailscale configuration still there: the command that removes it, with Copy', async () => {
    bridge({ ...OFF, host: HOST, removalHint: 'tailscale serve --https=443 off' })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await draw()
    expect(text('.remote-removal p')).toBe('Tailscale is still forwarding to this Mac. To stop it:')
    expect(text('.remote-removal pre')).toBe('tailscale serve --https=443 off')
    click(button('Copy', $('.remote-removal')!))
    await settle()
    expect(writeText).toHaveBeenCalledWith('tailscale serve --https=443 off')
  })

  it('open at login: set through main; absent in a checkout build', async () => {
    const api = bridge(OFF)
    await draw()
    const box = $<HTMLInputElement>('#remote-login')
    expect(box?.type).toBe('checkbox')
    toggle(box)
    await settle()
    expect(api.setOpenAtLogin).toHaveBeenCalledWith(true)
    expect($<HTMLInputElement>('#remote-login')?.checked).toBe(true)
    document.body.replaceChildren()
    bridge({ ...OFF, loginItem: { available: false, openAtLogin: false, needsApproval: false } })
    await draw()
    expect($('#remote-login')).toBeNull()
    expect($('.remote-login-hint')).toBeNull()
  })

  it('says when its record of these settings could not be saved', async () => {
    bridge({ ...ON, stateSaved: false })
    await draw()
    expect(text('.remote-not-saved')).toBe('Agent Inbox couldn’t save its record of these settings; the next start will ask you to review them.')
  })

  // review round 1, item 12
  it('says when macOS wants the login item allowed', async () => {
    bridge({ ...OFF, loginItem: { available: true, openAtLogin: true, needsApproval: true } })
    await draw()
    expect(text('.remote-login-approval')).toBe('Allow Agent Inbox in System Settings → General → Login Items.')
    document.body.replaceChildren()
    bridge({ ...OFF, loginItem: { available: true, openAtLogin: true, needsApproval: false } })
    await draw()
    expect($('.remote-login-approval')).toBeNull()
  })
})

describe('when it is not available', () => {
  it('a viewer this app did not start: quit and reopen', async () => {
    const api = bridge(OFF)
    api.get.mockResolvedValue({ available: false, reason: 'unowned' })
    await draw()
    expect(text('.remote-unavailable')).toBe('Another Agent Inbox viewer is running on this Mac, so this window can’t change sharing. Quit it, then reopen Agent Inbox.')
    expect(sw()).toBeNull()
    expect($('.remote-risk')).toBeNull()
  })

  it('another platform: says where it works', async () => {
    const api = bridge(OFF)
    api.get.mockResolvedValue({ available: false, reason: 'unsupported' })
    await draw()
    expect(text('.remote-unavailable')).toBe('Sharing this Inbox with your other Macs works on macOS.')
    expect(sw()).toBeNull()
  })

  it('no bridge at all (a browser, or this page on another Mac): nothing is drawn', async () => {
    expect(await draw()).toBeNull()
    expect(document.getElementById('remote-settings')).toBeNull()
    expect(document.getElementById('host')?.children).toHaveLength(0)
  })
})

describe('safety and keyboard', () => {
  it('every string is text: a label holding markup stays text', async () => {
    const label = '<img src=x onerror=alert(1)>'
    bridge({ ...ON, flag: true, devices: [{ id: A, label, pairedAt: null }], changes: { ...NONE_CHANGES, added: [label], keyChanged: [label] } })
    await draw()
    expect(document.querySelector('#remote-settings img')).toBeNull()
    expect(text('.remote-device-label')).toBe(label)
    const flagText = [...$('.remote-flag')!.querySelectorAll('p, li')].map((el) => el.textContent)
    expect(flagText).toContain(`Paired Macs: ${label}.`)
    expect(flagText).toContain(`Mac added: ${label}.`)
    expect(flagText).toContain(`The key of ${label} changed.`)
    expect($('button[aria-label="Remove <img src=x onerror=alert(1)>"]')).not.toBeNull()
  })

  it('every control is a real button or checkbox with a name, in reading order', async () => {
    bridge({ ...ON, flag: true, devices: [LAPTOP], unreadableDevices: 1, removalHint: null, problem: null, changes: { ...NONE_CHANGES, unknown: true } })
    await draw()
    const controls = [...document.querySelectorAll<HTMLElement>('#remote-settings button, #remote-settings input, #remote-settings [tabindex]')]
    const name = (el: HTMLElement) => el.getAttribute('aria-label') ?? (el instanceof HTMLInputElement ? document.querySelector(`label[for="${el.id}"]`)?.textContent : el.textContent)
    expect(controls.map((el) => [el.tagName, (el as HTMLInputElement).type, name(el)])).toEqual([
      ['BUTTON', 'button', 'Looks right'],
      ['INPUT', 'checkbox', 'Let my other Macs use this Inbox'],
      ['BUTTON', 'button', 'Copy address'],
      ['BUTTON', 'button', 'Remove laptop'],
      ['BUTTON', 'button', 'Clear'],
      ['BUTTON', 'button', 'Add a Mac'],
      ['BUTTON', 'button', 'Test'],
      ['INPUT', 'checkbox', 'Open Agent Inbox at login'],
    ])
    for (const el of controls) expect(el.tabIndex, name(el) ?? '').toBe(0)
  })

  it('nothing is drawn twice on repeated changes, and focus stays where it was', async () => {
    const api = bridge({ ...ON, devices: [LAPTOP], removalHint: null })
    await draw()
    button('Test')!.focus()
    for (let i = 0; i < 5; i += 1) api.ping()
    await settle()
    expect(document.querySelectorAll('#remote-settings')).toHaveLength(1)
    expect(document.querySelectorAll('#remote-settings #remote-switch')).toHaveLength(1)
    expect(document.querySelectorAll('#remote-settings .remote-device')).toHaveLength(1)
    expect(document.querySelectorAll('#remote-settings .remote-risk')).toHaveLength(1)
    expect(document.activeElement?.textContent).toBe('Test')
    expect(api.onChange).toHaveBeenCalledOnce()
  })
})

describe('in the app', () => {
  it('sits after the other Settings sections, and asks main again when Settings opens', async () => {
    const api = bridge(OFF)
    db = freshDb()
    await bootApp(db)
    const section = document.getElementById('remote-settings')
    expect(section).not.toBeNull()
    for (const id of ['link-settings', 'terminal-settings']) {
      const other = document.getElementById(id)
      if (other) expect(other.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    const calls = api.get.mock.calls.length
    click(document.getElementById('gear'))
    await settle()
    expect(api.get.mock.calls.length).toBeGreaterThan(calls)
    // review round 1, item 6: and main reads Serve again for the removal hint
    expect(api.recheck).toHaveBeenCalled()
  })

  it('is not drawn in a browser', async () => {
    db = freshDb()
    await bootApp(db)
    expect(document.getElementById('remote-settings')).toBeNull()
  })
})
