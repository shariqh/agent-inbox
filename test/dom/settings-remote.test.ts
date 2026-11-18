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
  command: 'tailscale serve --bg 4320', loginItem: { available: true, openAtLogin: false },
}
const ON: View = { ...OFF, enabled: true, host: HOST, wanted: true, serve: { ok: true } }
const LAPTOP = { id: A, label: 'laptop', pairedAt: '2026-07-19T09:00:00.000Z' }

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
      view = { ...view, loginItem: { available: true, openAtLogin: value } }
      return { ok: true, openAtLogin: value }
    }),
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
    ['tailscale_not_running', 'Tailscale is not running', 'Open Tailscale on this Mac and connect. Sharing comes back by itself.'],
    ['tailscale_unreadable', 'Agent Inbox can’t read Tailscale', 'Check that Tailscale is running on this Mac. Sharing comes back by itself.'],
    ['serve_not_ok:foreground', 'another tailscale serve is running', 'Another tailscale serve is running on this Mac. Stop it. Sharing comes back by itself.'],
    ['serve_not_ok:no_handler', 'Tailscale Serve is not set up for Agent Inbox', 'Run this once in Terminal on this Mac, and sharing comes back by itself:'],
    ['serve_not_ok:funnel', 'Tailscale Funnel is on for this Mac', 'Tailscale Funnel would put this Inbox on the internet. Turn Funnel off for this Mac. Sharing comes back by itself.'],
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
    expect(text('.remote-instruction pre')).toBe(waiting === 'serve_not_ok:no_handler' ? 'tailscale serve --bg 4320' : null)
  })

  it('paused with no next try says only why', async () => {
    bridge({ ...OFF, wanted: true, resume: { waiting: 'tailscale_not_running', nextAt: null } })
    await draw()
    expect(status()).toBe('Paused: Tailscale is not running')
  })

  it('needs you: a stop that will not come back by itself, in the notification\'s words, with what to do', async () => {
    bridge({ ...OFF, host: HOST, stopped: { reason: 'funnel', willResume: false } })
    await draw()
    expect(status()).toBe('Needs you: Tailscale Serve is not set up as expected.')
    expect(sw()?.checked).toBe(false)
    expect(instruction()).toBe('Tailscale Funnel would put this Inbox on the internet. Turn Funnel off for this Mac, then switch on again.')
  })

  it('needs you: this Mac\'s name or account changed', async () => {
    bridge({ ...OFF, host: HOST, needsOwner: 'identity_changed', stopped: { reason: 'identity_changed', willResume: false } })
    await draw()
    expect(status()).toBe('Needs you: This Mac’s Tailscale name or account changed.')
    expect(instruction()).toBe('This Mac’s Tailscale name or account changed. Switching on again removes the paired Macs.')
    bridge({ ...OFF, host: HOST, needsOwner: 'identity_changed' })
    document.body.replaceChildren()
    await draw()
    expect(status()).toBe('Needs you: this Mac’s Tailscale name or account changed')
  })

  it('a stop Agent Inbox made to keep sharing off is only Off: the flag says the rest', async () => {
    bridge({ ...OFF, stopped: { reason: 'not_wanted', willResume: false } })
    await draw()
    expect(status()).toBe('Off')
    expect($('.remote-instruction')).toBeNull()
  })

  it.each([
    ['serve', 'no_handler', 'Run this once in Terminal on this Mac, then switch on again:', true],
    ['serve', 'wrong_target', 'Run this once in Terminal on this Mac, then switch on again:', true],
    ['serve', 'foreground', 'Another tailscale serve is running on this Mac. Stop it, then switch on again.', false],
    ['serve', 'services', 'Another tailscale serve is running on this Mac. Stop it, then switch on again.', false],
    ['serve', 'other_path', 'Tailscale Serve on this Mac has other settings that could reach this Inbox. Remove them, then switch on again.', false],
    ['self', 'no_cli', 'Install Tailscale on this Mac and sign in, then switch on again.', false],
    ['self', 'not_running', 'Open Tailscale on this Mac and connect, then switch on again.', false],
    ['self', 'no_login', 'Sign in to Tailscale on this Mac, then switch on again.', false],
    ['self', 'tagged', 'Sharing needs a personal Tailscale login on this Mac. Sign in to Tailscale with your own account, then switch on again.', false],
    ['file', 'other_viewer', 'The other copy of Agent Inbox on this Mac (the installed app or a build from source) is sharing. Switch it off there first.', false],
    ['file', 'newer_schema', 'A newer version of Agent Inbox saved these settings. Update Agent Inbox to change them.', false],
  ])('switching on refused at %s (%s): one instruction', async (step, reason, what, command) => {
    const api = bridge(OFF)
    api.turnOn.mockResolvedValueOnce({ ok: false, reason, step })
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

  it('switching on after a changed identity says how many paired Macs it removed', async () => {
    const api = bridge(OFF)
    api.turnOn.mockImplementationOnce(async () => { api.set(ON); return { ok: true, voidedCode: false, devicesRemoved: 2, droppedEntries: 0 } })
    await draw()
    toggle(sw())
    await settle()
    expect(text('.remote-message')).toBe('Switching on removed 2 paired Macs, because this Mac’s Tailscale name or account changed.')
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
    expect(text('.remote-unreadable span')).toBe('2 entries that can’t be read')
    click(button('Clear'))
    await settle()
    expect(api.clearUnreadable).toHaveBeenCalledOnce()
    expect($('.remote-unreadable')).toBeNull()
    api.set({ ...ON, unreadableDevices: 1 })
    api.ping()
    await settle()
    expect(text('.remote-unreadable span')).toBe('1 entry that can’t be read')
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
  const FLAGGED: View = { ...ON, flag: true, digest: D1, devices: [LAPTOP, { id: B, label: 'stranger', pairedAt: null }] }

  it('is at the very top, says what the settings are now, and Looks right accepts exactly what is shown', async () => {
    const api = bridge(FLAGGED)
    await draw()
    const section = document.getElementById('remote-settings')!
    expect(section.children[1]?.classList.contains('remote-flag')).toBe(true)
    expect($('.remote-flag')?.getAttribute('role')).toBe('alert')
    expect([...$('.remote-flag')!.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'The sharing settings were changed outside Agent Inbox.',
      `Sharing is now on, at https://${HOST}.`,
      'Paired Macs: laptop, stranger.',
    ])
    click(button('Looks right'))
    await settle()
    expect(api.acknowledge).toHaveBeenCalledWith(D1)
    expect($('.remote-flag')).toBeNull()
  })

  it('off with no paired Macs, and entries that can\'t be read', async () => {
    bridge({ ...OFF, flag: true, unreadableDevices: 3 })
    await draw()
    expect([...$('.remote-flag')!.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'The sharing settings were changed outside Agent Inbox.', 'Sharing is now off.', 'No paired Macs.', '3 entries that can’t be read.',
    ])
  })

  it('when it changed again, redraws and says so, and the next Looks right sends the new digest', async () => {
    const api = bridge(FLAGGED)
    api.acknowledge.mockImplementationOnce(async () => {
      api.set({ ...FLAGGED, digest: D2, devices: [LAPTOP, { id: B, label: 'stranger', pairedAt: null }, { id: 'cccccccccccccccc', label: 'third', pairedAt: null }] })
      return { ok: false, reason: 'changed' }
    })
    await draw()
    click(button('Looks right'))
    await settle()
    expect(api.acknowledge).toHaveBeenLastCalledWith(D1)
    expect(text('.remote-flag-message')).toBe('It changed again; check the list.')
    expect(text('.remote-flag p:nth-of-type(3)')).toBe('Paired Macs: laptop, stranger, third.')
    click(button('Looks right'))
    await settle()
    expect(api.acknowledge).toHaveBeenLastCalledWith(D2)
  })

  it('a ping between drawing and pressing redraws first: what is acknowledged is what is on screen', async () => {
    const api = bridge(FLAGGED)
    await draw()
    api.set({ ...FLAGGED, digest: D2, devices: [LAPTOP] })
    api.ping()
    await settle()
    expect(text('.remote-flag p:nth-of-type(3)')).toBe('Paired Macs: laptop.')
    click(button('Looks right'))
    await settle()
    expect(api.acknowledge).toHaveBeenCalledWith(D2)
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
    bridge({ ...OFF, loginItem: { available: false, openAtLogin: false } })
    await draw()
    expect($('#remote-login')).toBeNull()
    expect($('.remote-login-hint')).toBeNull()
  })

  it('says when its record of these settings could not be saved', async () => {
    bridge({ ...ON, stateSaved: false })
    await draw()
    expect(text('.remote-not-saved')).toBe('Agent Inbox could not save its record of these settings; the next start will ask you to review them.')
  })
})

describe('when it is not available', () => {
  it('a viewer this app did not start: quit and reopen', async () => {
    const api = bridge(OFF)
    api.get.mockResolvedValue({ available: false, reason: 'unowned' })
    await draw()
    expect(text('.remote-unavailable')).toBe('Quit and reopen Agent Inbox to change this.')
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
    bridge({ ...ON, flag: true, devices: [{ id: A, label: '<img src=x onerror=alert(1)>', pairedAt: null }] })
    await draw()
    expect(document.querySelector('#remote-settings img')).toBeNull()
    expect(text('.remote-device-label')).toBe('<img src=x onerror=alert(1)>')
    expect(text('.remote-flag p:nth-of-type(3)')).toBe('Paired Macs: <img src=x onerror=alert(1)>.')
    expect($('button[aria-label="Remove <img src=x onerror=alert(1)>"]')).not.toBeNull()
  })

  it('every control is a real button or checkbox with a name, in reading order', async () => {
    bridge({ ...ON, flag: true, devices: [LAPTOP], unreadableDevices: 1, removalHint: null, problem: null })
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
  })

  it('is not drawn in a browser', async () => {
    db = freshDb()
    await bootApp(db)
    expect(document.getElementById('remote-settings')).toBeNull()
  })
})
