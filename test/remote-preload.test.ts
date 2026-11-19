// The two bridges of the hub view (#617, PR 3b; design §3.3 "The bridge"):
// electron/remote-preload.cjs is the hub view's only preload and exposes exactly `agentInboxDesk`;
// electron/setup-preload.cjs gains the local `agentInboxDesk` and `agentInboxConnect`. Each preload
// runs for real against a fake `electron`, so its checks are exercised rather than pinned as text.
// Every answer is rebuilt field by field, so a hostile or careless main cannot pass more through.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const read = (rel: string) => readFileSync(join(import.meta.dirname, '..', rel), 'utf8')

type Listener = (...args: unknown[]) => void
type Bridge = Record<string, (...args: unknown[]) => unknown>

function loadPreload(file: string, answer: (channel: string, ...args: unknown[]) => unknown) {
  const exposed: Record<string, unknown> = {}
  const listeners = new Map<string, Set<Listener>>()
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => answer(channel, ...args))
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api } },
    ipcRenderer: {
      invoke,
      on: (channel: string, fn: Listener) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(fn) },
      removeListener: (channel: string, fn: Listener) => { listeners.get(channel)?.delete(fn) },
    },
  }
  const required: string[] = []
  const factory = vm.runInThisContext(`(function (require, process) {\n${read(file)}\n})`, { filename: file }) as
    (require: (id: string) => unknown, process: { argv: string[] }) => void
  factory((id) => {
    required.push(id)
    if (id !== 'electron') throw new Error(`unexpected require ${id}`)
    return electron
  }, { argv: [] })
  const emit = (channel: string, ...args: unknown[]) => { for (const fn of listeners.get(channel) ?? []) fn({ sender: 'main' }, ...args) }
  return { exposed, invoke, emit, listeners, required }
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

const HUB = { mode: 'hub', label: 'studio', state: 'online', version: '2.12.0' }
const HOSTILE = {
  ...HUB, id: '0123abcd', origin: 'https://hub.example.ts.net', reason: 'node_changed', secret: 'q7Rk2mVx9LpZt4WcYb8NsDf3HjGu6EaQo1XiKvTn0yM',
  node: 'nHubStable1CNTRL', device: '3f9c0a1b2d4e5f60', nested: { secret: 'x' },
}

describe('remote-preload.cjs: the hub view’s only bridge', () => {
  it('exposes exactly agentInboxDesk, with exactly its five members, and requires only electron', () => {
    const { exposed, required } = loadPreload('electron/remote-preload.cjs', () => null)
    expect(Object.keys(exposed)).toEqual(['agentInboxDesk'])
    // #617 PR 4b: `open` added deliberately, for Open desk
    expect(Object.keys(exposed.agentInboxDesk as object).sort()).toEqual(['available', 'connection', 'onConnection', 'open', 'retry'])
    expect(required).toEqual(['electron'])
  })

  // #617 PR 4b
  it('available() asks main, and passes on only whether Open desk may show', async () => {
    const yes = loadPreload('electron/remote-preload.cjs', () => ({ open: true, command: 'ssh -t studio {attach}' }))
    const desk = yes.exposed.agentInboxDesk as Bridge
    expect(await desk.available!()).toEqual({ open: true })
    expect(yes.invoke.mock.calls).toEqual([['agent-inbox:desk-available']])
    expect(await desk.available!('extra')).toEqual({ open: false })
    expect(yes.invoke).toHaveBeenCalledTimes(1)
    for (const answer of [{ open: 'yes' }, { available: false }, null, [true], { open: 1 }]) {
      expect(await (loadPreload('electron/remote-preload.cjs', () => answer).exposed.agentInboxDesk as Bridge).available!()).toEqual({ open: false })
    }
    const failing = loadPreload('electron/remote-preload.cjs', () => { throw new Error('gone') })
    expect(await (failing.exposed.agentInboxDesk as Bridge).available!()).toEqual({ open: false })
  })

  it('open() sends a fresh { session } and nothing else', async () => {
    const { exposed, invoke } = loadPreload('electron/remote-preload.cjs', () => ({ ok: true }))
    const desk = exposed.agentInboxDesk as Bridge
    const given = { session: '00000000-0000-4000-8000-000000000001' }
    expect(await desk.open!(given)).toEqual({ ok: true })
    expect(await desk.open!({ session: 'launch:11111111-2222-4333-8444-555555555555' })).toEqual({ ok: true })
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:desk-open', { session: '00000000-0000-4000-8000-000000000001' }],
      ['agent-inbox:desk-open', { session: 'launch:11111111-2222-4333-8444-555555555555' }],
    ])
    expect(invoke.mock.calls[0]![1]).not.toBe(given)
  })

  it.each([
    ['nothing', []],
    ['two arguments', [{ session: 'abc' }, 'extra']],
    ['a string', ['abc']],
    ['null', [null]],
    ['a list', [['abc']]],
    ['another key beside session', [{ session: 'abc', desk: 'my-desk' }]],
    ['a desk instead of a session', [{ desk: 'my-desk' }]],
    ['a session that is not text', [{ session: 7 }]],
    ['an empty session', [{ session: '' }]],
    ['a session with a space', [{ session: 'a b' }]],
    ['a session with a quote', [{ session: "a'b" }]],
    ['a session that starts with a dash', [{ session: '-x' }]],
    ['a session of 129 characters', [{ session: 'a'.repeat(129) }]],
  ])('open() refuses %s itself, without asking main', async (_label, args) => {
    const { exposed, invoke } = loadPreload('electron/remote-preload.cjs', () => ({ ok: true }))
    expect(await (exposed.agentInboxDesk as Bridge).open!(...args)).toEqual({ ok: false, reason: 'bad_request' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['an open', { ok: true, terminal: 'iterm2', file: '/Users/x/desk.command' }, { ok: true }],
    ['an open with a notice', { ok: true, notice: 'iTerm2 could not be opened, so Terminal was opened instead.' },
      { ok: true, notice: 'iTerm2 could not be opened, so Terminal was opened instead.' }],
    ['a notice with a control character', { ok: true, notice: 'a\u0000b' }, { ok: true }],
    ['a notice over 200 characters', { ok: true, notice: 'x'.repeat(201) }, { ok: true }],
    ['each fixed refusal', { ok: false, reason: 'not_on_hub', detail: 'studio' }, { ok: false, reason: 'not_on_hub' }],
    ['a refusal word that is not one of them', { ok: false, reason: 'rm -rf' }, { ok: false, reason: 'failed' }],
    ['ok that is not true', { ok: 'yes' }, { ok: false, reason: 'failed' }],
    ['nothing', null, { ok: false, reason: 'failed' }],
  ])('open() reduces %s', async (_label, value, expected) => {
    const { exposed } = loadPreload('electron/remote-preload.cjs', () => value)
    expect(await (exposed.agentInboxDesk as Bridge).open!({ session: 'abc' })).toEqual(expected)
  })

  it('open() passes each fixed refusal word on, and a main that throws reads as failed', async () => {
    for (const reason of ['unavailable', 'bad_request', 'no_gesture', 'busy', 'no_command', 'unreachable', 'not_found', 'no_desk', 'not_on_hub', 'failed', 'terminal_failed']) {
      const { exposed } = loadPreload('electron/remote-preload.cjs', () => ({ ok: false, reason }))
      expect(await (exposed.agentInboxDesk as Bridge).open!({ session: 'abc' })).toEqual({ ok: false, reason })
    }
    const failing = loadPreload('electron/remote-preload.cjs', () => { throw new Error('gone') })
    expect(await (failing.exposed.agentInboxDesk as Bridge).open!({ session: 'abc' })).toEqual({ ok: false, reason: 'failed' })
  })

  it('connection() rebuilds main’s answer field by field: mode, label, state and version only', async () => {
    const { exposed, invoke } = loadPreload('electron/remote-preload.cjs', () => HOSTILE)
    const desk = exposed.agentInboxDesk as Bridge
    const answer = await desk.connection!()
    expect(answer).toEqual(HUB)
    expect(Object.keys(answer as object)).toEqual(['mode', 'label', 'state', 'version'])
    expect(invoke.mock.calls).toEqual([['agent-inbox:desk-connection']])
  })

  it.each([
    ['main refused', { available: false }, null],
    ['not a hub', { mode: 'local' }, null],
    ['an unknown state', { ...HUB, state: 'gone' }, null],
    ['a list', [HUB], null],
    ['nothing', null, null],
    ['a label over 40 characters', { ...HUB, label: 'x'.repeat(41) }, { ...HUB, label: '' }],
    ['a label with a control character', { ...HUB, label: 'stu\u0000dio' }, { ...HUB, label: '' }],
    ['a label that is not text', { ...HUB, label: { toString: (): string => 'x' } }, { ...HUB, label: '' }],
    ['a version over 64 characters', { ...HUB, version: '1'.repeat(65) }, { ...HUB, version: null }],
    ['a version that is a number', { ...HUB, version: 2 }, { ...HUB, version: null }],
    ['no version', { ...HUB, version: null }, { ...HUB, version: null }],
  ])('connection() for %s', async (_label, value, expected) => {
    const { exposed } = loadPreload('electron/remote-preload.cjs', () => value)
    expect(await (exposed.agentInboxDesk as Bridge).connection!()).toEqual(expected)
  })

  it('connection() with arguments, or a main that throws, answers null', async () => {
    const extra = loadPreload('electron/remote-preload.cjs', () => HUB)
    expect(await (extra.exposed.agentInboxDesk as Bridge).connection!('please')).toBeNull()
    expect(extra.invoke).not.toHaveBeenCalled()
    const failing = loadPreload('electron/remote-preload.cjs', () => { throw new Error('gone') })
    expect(await (failing.exposed.agentInboxDesk as Bridge).connection!()).toBeNull()
  })

  it('onConnection(callback) asks main again on each change, ignores what the message carries, and unsubscribes', async () => {
    let state = 'online'
    const { exposed, emit, listeners, invoke } = loadPreload('electron/remote-preload.cjs', () => ({ ...HOSTILE, state }))
    const desk = exposed.agentInboxDesk as Bridge
    const seen: unknown[] = []
    const unsubscribe = desk.onConnection!((value: unknown) => seen.push(value)) as () => void
    expect(typeof unsubscribe).toBe('function')
    emit('agent-inbox:desk-changed', { ...HOSTILE, carried: 'x' })
    await settle()
    state = 'retrying'
    emit('agent-inbox:desk-changed')
    await settle()
    expect(seen).toEqual([HUB, { ...HUB, state: 'retrying' }])
    expect(invoke.mock.calls).toEqual([['agent-inbox:desk-connection'], ['agent-inbox:desk-connection']])
    unsubscribe()
    expect(listeners.get('agent-inbox:desk-changed')!.size).toBe(0)
    emit('agent-inbox:desk-changed')
    await settle()
    expect(seen).toHaveLength(2)
  })

  it('onConnection() calls back nothing main refuses, and survives a callback that throws', async () => {
    let answer: unknown = { available: false }
    const { exposed, emit } = loadPreload('electron/remote-preload.cjs', () => answer)
    const desk = exposed.agentInboxDesk as Bridge
    const seen: unknown[] = []
    desk.onConnection!((value: unknown) => seen.push(value))
    desk.onConnection!(() => { throw new Error('page bug') })
    emit('agent-inbox:desk-changed')
    await settle()
    expect(seen).toEqual([])
    answer = HUB
    emit('agent-inbox:desk-changed')
    await settle()
    expect(seen).toEqual([HUB])
  })

  it('onConnection() without a function registers nothing', () => {
    const { exposed, listeners } = loadPreload('electron/remote-preload.cjs', () => HUB)
    const unsubscribe = (exposed.agentInboxDesk as Bridge).onConnection!('not a function')
    expect(typeof unsubscribe).toBe('function')
    expect(listeners.size).toBe(0)
  })

  it('retry() asks main and passes on only whether it was taken', async () => {
    const { exposed, invoke } = loadPreload('electron/remote-preload.cjs', () => ({ ok: true, state: 'online', secret: 'x' }))
    const desk = exposed.agentInboxDesk as Bridge
    expect(await desk.retry!()).toEqual({ ok: true })
    expect(invoke.mock.calls).toEqual([['agent-inbox:desk-retry']])
    expect(await desk.retry!('now')).toEqual({ ok: false })
    expect(invoke).toHaveBeenCalledTimes(1)
    const refused = loadPreload('electron/remote-preload.cjs', () => ({ ok: 'yes' }))
    expect(await (refused.exposed.agentInboxDesk as Bridge).retry!()).toEqual({ ok: false })
    const failing = loadPreload('electron/remote-preload.cjs', () => { throw new Error('x') })
    expect(await (failing.exposed.agentInboxDesk as Bridge).retry!()).toEqual({ ok: false })
  })

  it('names no channel but its own four and the change message', () => {
    const source = read('electron/remote-preload.cjs')
    expect([...new Set([...source.matchAll(/'agent-inbox:[a-z-]+'/g)].map((m) => m[0]))].sort()).toEqual(
      ["'agent-inbox:desk-available'", "'agent-inbox:desk-changed'", "'agent-inbox:desk-connection'", "'agent-inbox:desk-open'", "'agent-inbox:desk-retry'"],
    )
    expect(source.match(/exposeInMainWorld\(/g)).toHaveLength(1)
  })
})

describe('setup-preload.cjs: agentInboxDesk on This Mac', () => {
  // #617 PR 4b: Open desk is the hub page's only; This Mac's bridge keeps { open: false } and has no open()
  it('answers mode local, no terminal action and no changes, without asking main', async () => {
    const { exposed, invoke, listeners } = loadPreload('electron/setup-preload.cjs', () => HOSTILE)
    const desk = exposed.agentInboxDesk as Bridge
    expect(Object.keys(desk).sort()).toEqual(['available', 'connection', 'onConnection'])
    expect(await desk.connection!()).toEqual({ mode: 'local' })
    expect(await desk.available!()).toEqual({ open: false })
    const unsubscribe = desk.onConnection!(() => {})
    expect(typeof unsubscribe).toBe('function')
    expect(invoke).not.toHaveBeenCalled()
    expect([...listeners.keys()].filter((name) => name.includes('desk'))).toEqual([])
  })
})

const VIEW = {
  available: true, keychain: true, problem: null, showing: '0123abcd',
  hub: { id: '0123abcd', label: 'studio', origin: 'https://hub.example.ts.net', machine: 'studio', state: 'online', reason: null, deskCommand: 'ssh -t studio {attach}' },
}

describe('setup-preload.cjs: agentInboxConnect', () => {
  const load = (answer: (channel: string, ...args: unknown[]) => unknown) => {
    const loaded = loadPreload('electron/setup-preload.cjs', answer)
    return { ...loaded, connect: loaded.exposed.agentInboxConnect as Bridge }
  }

  it('has exactly its six members', () => {
    // #617 PR 4b: setDeskCommand added deliberately
    expect(Object.keys(load(() => null).connect).sort()).toEqual(['connect', 'forget', 'onChange', 'setDeskCommand', 'show', 'view'])
  })

  // #617 PR 4b
  it('setDeskCommand() sends a fresh { id, command } and nothing else, and rebuilds the answer', async () => {
    const { connect, invoke } = load(() => ({ ok: false, reason: 'cancelled', command: 'x' }))
    const given = { id: '0123abcd', command: 'ssh -t studio {attach}' }
    expect(await connect.setDeskCommand!(given)).toEqual({ ok: false, reason: 'cancelled' })
    expect(await connect.setDeskCommand!({ id: '0123abcd', command: '' })).toEqual({ ok: false, reason: 'cancelled' })
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:connect-desk-command', { id: '0123abcd', command: 'ssh -t studio {attach}' }],
      ['agent-inbox:connect-desk-command', { id: '0123abcd', command: '' }],
    ])
    expect(invoke.mock.calls[0]![1]).not.toBe(given)
    expect(await load(() => ({ ok: true, deskCommand: 'x' })).connect.setDeskCommand!(given)).toEqual({ ok: true })
  })

  it.each([
    ['nothing', []],
    ['two arguments', [{ id: '0123abcd', command: 'x {desk}' }, 'extra']],
    ['no command', [{ id: '0123abcd' }]],
    ['no id', [{ command: 'x {desk}' }]],
    ['a third key', [{ id: '0123abcd', command: 'x {desk}', host: 'studio' }]],
    ['a command that is not text', [{ id: '0123abcd', command: 7 }]],
    ['an id that is not text', [{ id: 7, command: 'x {desk}' }]],
    ['a list', [['0123abcd', 'x {desk}']]],
  ])('setDeskCommand() refuses %s without asking main', async (_label, args) => {
    const { connect, invoke } = load(() => ({ ok: true }))
    expect(await connect.setDeskCommand!(...args)).toEqual({ available: false })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('passes each call on with exactly its arguments, as a fresh copy', async () => {
    const { connect, invoke } = load(() => ({ ok: true }))
    await connect.view!()
    await connect.connect!({ address: 'hub.example.ts.net', code: '7K3QX-9M2PD', replace: true, extra: 'dropped' })
    await connect.connect!({ address: 'hub.example.ts.net', code: '7K3QX-9M2PD' })
    await connect.forget!('0123abcd')
    await connect.show!(null)
    await connect.show!('0123abcd')
    expect(invoke.mock.calls).toEqual([
      ['agent-inbox:connect-view'],
      ['agent-inbox:connect-connect', { address: 'hub.example.ts.net', code: '7K3QX-9M2PD', replace: true }],
      ['agent-inbox:connect-connect', { address: 'hub.example.ts.net', code: '7K3QX-9M2PD', replace: false }],
      ['agent-inbox:connect-forget', '0123abcd'],
      ['agent-inbox:connect-show', null],
      ['agent-inbox:connect-show', '0123abcd'],
    ])
  })

  it.each([
    ['view', ['extra']],
    ['connect', []],
    ['connect', ['hub.example.ts.net']],
    ['connect', [{ address: 'hub.example.ts.net' }]],
    ['connect', [{ address: 1, code: '7K3QX-9M2PD' }]],
    ['connect', [{ address: 'hub.example.ts.net', code: '7K3QX-9M2PD', replace: 'yes' }]],
    ['connect', [{ address: 'h', code: 'c' }, 'extra']],
    ['forget', []],
    ['forget', [7]],
    ['forget', ['x'.repeat(65)]],
    ['show', []],
    ['show', [undefined]],
    ['show', [7]],
    ['show', ['0123abcd', 'extra']],
  ])('refuses %s with %j without asking main', async (method, args) => {
    const { connect, invoke } = load(() => ({ ok: true }))
    expect(await connect[method]!(...args)).toEqual({ available: false })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rebuilds view() field by field', async () => {
    const hostile = { ...VIEW, secret: 'x', hub: { ...VIEW.hub, node: 'nHub', device: '3f9c0a1b2d4e5f60', secret: 'blob' } }
    const { connect } = load(() => hostile)
    expect(await connect.view!()).toEqual(VIEW)
    const odd = load(() => ({ ...VIEW, hub: { ...VIEW.hub, id: 'ZZZ', origin: 'javascript:x' }, problem: 'forget_not_saved', showing: 'nope' }))
    expect(await odd.connect.view!()).toEqual({ available: true, keychain: true, problem: 'forget_not_saved', showing: null, hub: null })
    // #617 PR 4b: a saved command that is not text of 1 to 512 characters reads as none
    for (const deskCommand of [7, '', 'x'.repeat(513), null]) {
      const got = await load(() => ({ ...VIEW, hub: { ...VIEW.hub, deskCommand } })).connect.view!() as { hub: { deskCommand: unknown } }
      expect(got.hub.deskCommand).toBeNull()
    }
  })

  it.each([
    ['a connect that worked', { ok: true, id: '0123abcd', label: 'studio', state: 'online', reason: null, replacedHub: true, secret: 'x' },
      { ok: true, id: '0123abcd', label: 'studio', state: 'online', reason: null, replacedHub: true }],
    ['a refusal', { ok: false, reason: 'refused', pairedOnHub: true, body: 'x' }, { ok: false, reason: 'refused', pairedOnHub: true }],
    ['a refusal with an odd word', { ok: false, reason: 'Refused <b>' }, { ok: false, reason: 'failed' }],
    ['a show', { ok: true, showing: null }, { ok: true, showing: null }],
    ['main refusing the sender', { available: false, rules: [] }, { available: false }],
    ['nothing', undefined, { ok: false, reason: 'failed' }],
  ])('rebuilds %s', async (_label, value, expected) => {
    const { connect } = load(() => value)
    expect(await connect.connect!({ address: 'hub.example.ts.net', code: '7K3QX-9M2PD' })).toEqual(expected)
  })

  it('onChange(callback) calls back with nothing on each change message, and unsubscribes', () => {
    const { connect, emit, listeners } = load(() => null)
    const seen: unknown[][] = []
    const unsubscribe = connect.onChange!((...args: unknown[]) => seen.push(args)) as () => void
    emit('agent-inbox:connect-changed', { secret: 'x' })
    expect(seen).toEqual([[]])
    unsubscribe()
    expect(listeners.get('agent-inbox:connect-changed')!.size).toBe(0)
    expect(typeof connect.onChange!('nope')).toBe('function')
  })
})
