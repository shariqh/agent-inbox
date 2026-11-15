// Resume a chat in Terminal (#586 PR 3): the script builder, the private writer
// and its sweep, main's handler over an injected index, folder check and
// terminal runner, and the IPC gate. Nothing here opens a terminal: every run
// is recorded. Fixtures are synthetic.
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import chatResume from '../electron/chat-resume.cjs'
import type { ChatResumeResult } from '../electron/chat-resume.cjs'
import type { TerminalCommand, TerminalRun } from '../electron/terminal-launch.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { CHANNELS, SCRIPT_KEEP_MS, REOPEN_MS, chatResumeRequest, chatResumeScript, createChatResume, registerChatResumeIpc, scriptName, writeChatScript } = chatResume

afterEach(() => {
  removeScratchDirs()
})

const ID = '00000000-0000-4000-8000-000000000001'
const ID2 = '00000000-0000-4000-8000-000000000002'
const RANDOM = '0123456789abcdef'
const FOLDER = '/Users/tester/dev/alpha'

describe('the resume script (#586)', () => {
  it('builds cd then exec for each tool', () => {
    expect(chatResumeScript({ tool: 'claude', id: ID, cwd: FOLDER })).toBe([
      '#!/bin/sh',
      '# Agent Inbox: Resume a chat in Terminal (#586, claude 00000000)',
      `cd -- '${FOLDER}' || exit 1`,
      `exec claude --resume ${ID}`,
      '',
    ].join('\n'))
    expect(chatResumeScript({ tool: 'copilot', id: ID, cwd: FOLDER })!.split('\n').slice(2)).toEqual([
      `cd -- '${FOLDER}' || exit 1`,
      `exec copilot --resume=${ID}`,
      '',
    ])
  })

  it.each([
    ['a space', 'my folder'],
    ['a single quote', "it's"],
    ['a double quote', 'say "hi"'],
    ['a command substitution', '$(touch pwned)'],
    ['backticks', '`touch pwned`'],
    ['a semicolon', 'a; touch pwned'],
    ['a variable', '$HOME'],
    ['a leading dash', '-rf'],
  ])('quotes a folder with %s so nothing in it is expanded', (_, name) => {
    const dir = scratchDir('chat-resume-sh-')
    const folder = join(dir, name)
    mkdirSync(folder)
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    for (const tool of ['claude', 'copilot']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nprintf "%s\\n" "$PWD" ${tool} "$@" > "$OUT"\n`)
      chmodSync(join(bin, tool), 0o755)
    }
    for (const [tool, arg] of [['claude', ['--resume', ID]], ['copilot', [`--resume=${ID}`]]] as const) {
      const file = join(dir, `${tool}.command`)
      writeFileSync(file, chatResumeScript({ tool, id: ID, cwd: folder })!, { mode: 0o700 })
      const out = join(dir, 'out.txt')
      execFileSync('/bin/sh', [file], { env: { PATH: `${bin}:/usr/bin:/bin`, OUT: out }, cwd: dir })
      expect(readFileSync(out, 'utf8').split('\n').slice(0, -1)).toEqual([folder, tool, ...arg])
    }
    expect(existsSync(join(dir, 'pwned'))).toBe(false)
    expect(existsSync(join(folder, 'pwned'))).toBe(false)
  })

  it.each(['\n', '\r', '\t', '\u0000', '\u001b', '\u007f', '\u0085', '\u2028', '\u2029'])('refuses a folder holding %j', (char) => {
    expect(chatResumeScript({ tool: 'claude', id: ID, cwd: `/Users/tester/a${char}b` })).toBeNull()
  })

  it.each([
    ['a dash folder', { tool: 'claude', id: ID, cwd: '-x' }],
    ['a relative folder', { tool: 'claude', id: ID, cwd: 'rel/x' }],
    ['no folder', { tool: 'claude', id: ID, cwd: null }],
    ['an option for an id', { tool: 'claude', id: '--help', cwd: FOLDER }],
    ['an uppercase UUID', { tool: 'claude', id: ID.toUpperCase().replace('0000-4000', 'AAAA-4000'), cwd: FOLDER }],
    ['a UUID with a command after it', { tool: 'copilot', id: `${ID};id`, cwd: FOLDER }],
    ['a UUID with a newline after it', { tool: 'copilot', id: `${ID}\n`, cwd: FOLDER }],
    ['an unknown tool', { tool: 'sh', id: ID, cwd: FOLDER }],
  ])('refuses %s', (_, chat) => {
    expect(chatResumeScript(chat)).toBeNull()
  })

  it('reads only tool and id from a request', () => {
    expect(chatResumeRequest({ tool: 'claude', id: ID, cwd: '/evil', command: 'sh' })).toEqual({ tool: 'claude', id: ID })
    expect(chatResumeRequest({ tool: 'copilot', id: ID })).toEqual({ tool: 'copilot', id: ID })
    for (const bad of [null, undefined, 'claude', 7, [ID], { tool: 'sh', id: ID }, { tool: 'claude', id: 'x' }, { tool: 'claude' }]) {
      expect(chatResumeRequest(bad)).toBeNull()
    }
  })

  it('names each script fresh: tool, id, random, .command', () => {
    expect(scriptName('copilot', ID, RANDOM)).toBe(`copilot-${ID}-${RANDOM}.command`)
  })
})

describe('writeChatScript', () => {
  const mode = (p: string) => statSync(p).mode & 0o777

  it('writes 0700 in a 0700 folder it creates', () => {
    const dir = join(scratchDir('chat-resume-w-'), 'hub', 'chat-resume')
    const file = writeChatScript({ dir, name: scriptName('claude', ID, RANDOM), text: 'echo hi\n' })
    expect(file).toBe(join(dir, `claude-${ID}-${RANDOM}.command`))
    expect([mode(file!), mode(dir), readFileSync(file!, 'utf8')]).toEqual([0o700, 0o700, 'echo hi\n'])
  })

  it('tightens a folder that is too open', () => {
    const dir = join(scratchDir('chat-resume-w-'), 'chat-resume')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    expect(writeChatScript({ dir, name: scriptName('claude', ID, RANDOM), text: 'x' })).not.toBeNull()
    expect(mode(dir)).toBe(0o700)
  })

  it('refuses a folder that is a symlink', () => {
    const base = scratchDir('chat-resume-w-')
    const target = join(base, 'elsewhere')
    mkdirSync(target)
    const dir = join(base, 'chat-resume')
    symlinkSync(target, dir)
    expect(writeChatScript({ dir, name: scriptName('claude', ID, RANDOM), text: 'x' })).toBeNull()
    expect(readdirSync(target)).toEqual([])
  })

  it('never writes through a symlink or over a file at its name', () => {
    const base = scratchDir('chat-resume-w-')
    const dir = join(base, 'chat-resume')
    mkdirSync(dir, { mode: 0o700 })
    const victim = join(base, 'victim')
    writeFileSync(victim, 'keep')
    const linked = scriptName('claude', ID, RANDOM)
    symlinkSync(victim, join(dir, linked))
    expect(writeChatScript({ dir, name: linked, text: 'x' })).toBeNull()
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(lstatSync(join(dir, linked)).isSymbolicLink()).toBe(true)
    const taken = scriptName('claude', ID, 'fedcba9876543210')
    writeFileSync(join(dir, taken), 'theirs')
    expect(writeChatScript({ dir, name: taken, text: 'x' })).toBeNull()
    expect(readFileSync(join(dir, taken), 'utf8')).toBe('theirs')
  })

  it('refuses a name that is not one of its own', () => {
    const dir = join(scratchDir('chat-resume-w-'), 'chat-resume')
    for (const name of ['../x.command', 'x.command', `claude-${ID}.command`, `sh-${ID}-${RANDOM}.command`]) {
      expect(writeChatScript({ dir, name, text: 'x' })).toBeNull()
    }
    expect(existsSync(dir)).toBe(false)
  })

  it('sweeps only its own old scripts', () => {
    const base = scratchDir('chat-resume-w-')
    const dir = join(base, 'chat-resume')
    mkdirSync(dir, { mode: 0o700 })
    const nowMs = Date.now()
    const old = (p: string) => utimesSync(p, new Date(nowMs - SCRIPT_KEEP_MS - 60_000), new Date(nowMs - SCRIPT_KEEP_MS - 60_000))
    const ours = (n: string) => scriptName('claude', ID, n.repeat(16))
    const stale = join(dir, ours('1'))
    const fresh = join(dir, ours('2'))
    const foreign = join(dir, 'notes.txt')
    const folder = join(dir, ours('3'))
    const link = join(dir, ours('4'))
    writeFileSync(stale, 'old')
    writeFileSync(fresh, 'new')
    writeFileSync(foreign, 'theirs')
    mkdirSync(folder)
    const target = join(base, 'target')
    writeFileSync(target, 'kept')
    symlinkSync(target, link)
    for (const p of [stale, foreign, folder, target]) old(p)
    expect(writeChatScript({ dir, name: ours('5'), text: 'x', now: () => nowMs })).not.toBeNull()
    expect([existsSync(stale), existsSync(fresh), existsSync(foreign), existsSync(folder), lstatSync(link).isSymbolicLink()])
      .toEqual([false, true, true, true, true])
    expect(readFileSync(target, 'utf8')).toBe('kept')
  })
})

interface RigOptions {
  chats?: unknown
  folders?: string[]
  terminal?: unknown
  platform?: string
  run?: (command: TerminalCommand) => Promise<TerminalRun>
  writeScript?: (dir: string, name: string, text: string) => string | null
}

const DIR = '/Users/tester/.agent-inbox/chat-resume'

function chatEntry(over: Record<string, unknown> = {}) {
  return { id: ID, tool: 'claude', cwd: FOLDER, live: false, hidden: [], ...over }
}

function rig({ chats = [chatEntry()], folders = [FOLDER], terminal = 'terminal', platform = 'darwin', run, writeScript }: RigOptions = {}) {
  const state = { quitting: false, clock: 1_000_000, terminal, chats }
  const routes: string[] = []
  const runs: string[][] = []
  const written: Array<[string, string, string]> = []
  const reads = vi.fn(async () => {
    if (state.terminal instanceof Error) throw state.terminal
    return state.terminal
  })
  let n = 0
  const handler = createChatResume({
    platform,
    isQuitting: () => state.quitting,
    viewer: {
      getJson: async (route: string) => {
        routes.push(route)
        return typeof state.chats === 'function' ? (state.chats as () => unknown)() : { chats: state.chats }
      },
    },
    isDirectory: (folder) => folders.includes(folder),
    terminal: {
      read: reads,
      run: run ?? (async (command) => { runs.push([command.file, ...command.args]); return { ok: true } }),
    },
    scriptDir: DIR,
    writeScript: writeScript ?? ((dir, name, text) => { written.push([dir, name, text]); return join(dir, name) }),
    now: () => state.clock,
    random: () => (n++).toString(16).padStart(16, '0'),
  })
  return { handler, state, routes, runs, written, reads }
}

const scriptFor = (tool: string, index = 0) => `${DIR}/${tool}-${ID}-${index.toString(16).padStart(16, '0')}.command`

describe('createChatResume', () => {
  it('opens a script that cds to the index’s folder, in Terminal', async () => {
    const r = rig()
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: true, terminal: 'terminal' })
    expect(r.routes).toEqual(['/api/chats?all=1'])
    expect(r.written).toEqual([[DIR, `claude-${ID}-0000000000000000.command`, chatResumeScript({ tool: 'claude', id: ID, cwd: FOLDER })]])
    expect(r.runs).toEqual([['/usr/bin/open', '-b', 'com.apple.Terminal', '--', scriptFor('claude')]])
  })

  it('opens iTerm2 when chosen, for a Copilot chat', async () => {
    const r = rig({ terminal: 'iterm2', chats: [chatEntry({ tool: 'copilot' })] })
    expect(await r.handler.resume({ tool: 'copilot', id: ID })).toEqual({ ok: true, terminal: 'iterm2' })
    expect(r.written[0]![2]).toContain(`exec copilot --resume=${ID}`)
    expect(r.runs).toEqual([['/usr/bin/open', '-b', 'com.googlecode.iterm2', '--', scriptFor('copilot')]])
  })

  it('falls back to Terminal once when iTerm2 is missing, and says so', async () => {
    const runs: string[][] = []
    const r = rig({
      terminal: 'iterm2',
      run: async (command) => {
        runs.push(command.args)
        return command.args[1] === 'com.googlecode.iterm2' ? { ok: false, missing: true } : { ok: true }
      },
    })
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toEqual({
      ok: true, terminal: 'terminal', notice: 'iTerm2 could not be opened, so Terminal was opened instead.',
    })
    expect(runs.map((args) => args[1])).toEqual(['com.googlecode.iterm2', 'com.apple.Terminal'])
  })

  it('does not retry after a timeout, and names what could not open', async () => {
    const runs: string[][] = []
    const timedOut = rig({ terminal: 'iterm2', run: async (command) => { runs.push(command.args); return { ok: false, timedOut: true } } })
    expect(await timedOut.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: false, reason: 'open', error: 'Could not open iTerm2.' })
    expect(runs).toHaveLength(1)
    const both = rig({ terminal: 'iterm2', run: async () => ({ ok: false, missing: true }) })
    expect(await both.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: false, reason: 'open', error: 'Could not open iTerm2 or Terminal.' })
    const thrown = rig({ run: async () => { throw new Error('spawn failed') } })
    expect(await thrown.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: false, reason: 'open', error: 'Could not open Terminal.' })
  })

  it('takes the folder from the index, never from the request', async () => {
    const r = rig()
    expect(await r.handler.resume({ tool: 'claude', id: ID, cwd: '/evil', command: 'rm -rf /' })).toMatchObject({ ok: true })
    const text = r.written[0]![2]
    expect(text).toContain(`cd -- '${FOLDER}' || exit 1`)
    expect(text).not.toContain('evil')
    expect(text).not.toContain('rm -rf')
  })

  it('reads the terminal once per resume, and a throw means Terminal', async () => {
    const r = rig({ chats: [chatEntry(), chatEntry({ id: ID2 })], terminal: new Error('unreadable') })
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: true, terminal: 'terminal' })
    expect(r.reads).toHaveBeenCalledTimes(1)
    r.state.terminal = 'iterm2'
    expect(await r.handler.resume({ tool: 'claude', id: ID2 })).toEqual({ ok: true, terminal: 'iterm2' })
    expect(r.reads).toHaveBeenCalledTimes(2)
    r.state.terminal = 'Hyper'
    expect(await r.handler.available()).toEqual({ available: true, terminal: 'terminal' })
  })

  const refusals: Array<[string, RigOptions, unknown, Partial<ChatResumeResult> & { reason: string }]> = [
    ['an invalid request', {}, { tool: 'claude', id: 'nope' }, { reason: 'invalid', error: 'This chat can’t be resumed.' }],
    ['a request that is not an object', {}, 'claude', { reason: 'invalid' }],
    ['another platform', { platform: 'linux' }, { tool: 'claude', id: ID }, { reason: 'unavailable', error: 'Resume in Terminal works only in Agent Inbox’s own window on macOS.' }],
    ['an unreadable index', { chats: () => null }, { tool: 'claude', id: ID }, { reason: 'index', error: 'Agent Inbox could not read the chat list.' }],
    ['an index with no list', { chats: () => ({}) }, { tool: 'claude', id: ID }, { reason: 'index' }],
    ['a chat the index does not list', { chats: [chatEntry({ id: ID2 })] }, { tool: 'claude', id: ID }, { reason: 'missing', error: 'This chat is no longer listed.' }],
    ['the same id under the other tool', { chats: [chatEntry({ tool: 'copilot' })] }, { tool: 'claude', id: ID }, { reason: 'missing' }],
    ['a live chat', { chats: [chatEntry({ live: true })] }, { tool: 'claude', id: ID }, { reason: 'live', error: 'This chat is live in another process.' }],
    ['a live chat whose folder is gone', { chats: [chatEntry({ live: true, cwd: '/gone' })] }, { tool: 'claude', id: ID }, { reason: 'live' }],
    ['no folder', { chats: [chatEntry({ cwd: null })] }, { tool: 'claude', id: ID }, { reason: 'folder', error: 'Its folder no longer exists.' }],
    ['a relative folder', { chats: [chatEntry({ cwd: 'dev/alpha' })], folders: ['dev/alpha'] }, { tool: 'claude', id: ID }, { reason: 'folder' }],
    ['a folder that is not a directory', { folders: [] }, { tool: 'claude', id: ID }, { reason: 'folder' }],
    ['a folder with a newline', { chats: [chatEntry({ cwd: '/Users/tester/a\nb' })], folders: ['/Users/tester/a\nb'] }, { tool: 'claude', id: ID }, { reason: 'invalid' }],
    ['a folder with U+2028', { chats: [chatEntry({ cwd: '/Users/tester/a\u2028b' })], folders: ['/Users/tester/a\u2028b'] }, { tool: 'claude', id: ID }, { reason: 'invalid' }],
    ['a script that cannot be written', { writeScript: () => null }, { tool: 'claude', id: ID }, { reason: 'write', error: 'Agent Inbox could not write the Terminal script.' }],
  ]

  it.each(refusals)('refuses %s and opens nothing', async (_, options, request, expected) => {
    const r = rig(options)
    expect(await r.handler.resume(request)).toEqual({ ok: false, error: expect.any(String), ...expected })
    expect(r.runs).toEqual([])
    if (expected.reason !== 'write') expect(r.written).toEqual([])
  })

  it('refuses while quitting, before reading the index', async () => {
    const r = rig()
    r.state.quitting = true
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: false, reason: 'quitting', error: 'Agent Inbox is quitting, so nothing was opened.' })
    expect([r.routes, r.runs]).toEqual([[], []])
  })

  it('refuses a second resume while one is in flight', async () => {
    let release: (value: unknown) => void = () => {}
    const r = rig({ chats: [chatEntry(), chatEntry({ id: ID2 })] })
    const listed = { chats: r.state.chats }
    r.state.chats = () => new Promise((resolve) => { release = resolve })
    const first = r.handler.resume({ tool: 'claude', id: ID })
    expect(await r.handler.resume({ tool: 'claude', id: ID2 })).toEqual({ ok: false, reason: 'busy', error: 'Another chat is opening. Try again in a moment.' })
    release(listed)
    expect(await first).toMatchObject({ ok: true })
    r.state.chats = () => listed
    expect(await r.handler.resume({ tool: 'claude', id: ID2 })).toMatchObject({ ok: true })
  })

  it('refuses the same chat again until the index can say it is live', async () => {
    const r = rig({ terminal: 'iterm2', chats: [chatEntry(), chatEntry({ id: ID2 })] })
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toMatchObject({ ok: true })
    r.state.clock += REOPEN_MS - 1
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toEqual({
      ok: false, reason: 'opened', error: 'This chat was opened in iTerm2 moments ago. If it did not open, try again in two minutes.',
    })
    // another chat still opens, and the first one opens again once the window has passed
    expect(await r.handler.resume({ tool: 'claude', id: ID2 })).toMatchObject({ ok: true })
    r.state.clock += 1
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toMatchObject({ ok: true })
    expect(r.runs).toHaveLength(3)
  })

  it('does not hold a chat back after an open that failed', async () => {
    let ok = false
    const r = rig({ run: async () => ({ ok }) })
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toMatchObject({ ok: false, reason: 'open' })
    ok = true
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toMatchObject({ ok: true })
  })

  it('is available on macOS only, with the chosen terminal', async () => {
    expect(await rig({ terminal: 'iterm2' }).handler.available()).toEqual({ available: true, terminal: 'iterm2' })
    expect(await rig({ platform: 'linux', terminal: 'iterm2' }).handler.available()).toEqual({ available: false, terminal: 'terminal' })
  })
})

describe('registerChatResumeIpc', () => {
  function world({ platform = 'darwin', owned = true, settled = () => Promise.resolve() } = {}) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const handler = { available: vi.fn(async () => ({ available: true, terminal: 'iterm2' as const })), resume: vi.fn(async () => ({ ok: true as const, terminal: 'terminal' as const })) }
    const make = vi.fn(() => handler)
    const isOwned = vi.fn(() => owned)
    registerChatResumeIpc({
      ipcMain: { handle: (channel: string, fn: (event: never, ...args: never[]) => unknown) => { handlers.set(channel, fn as never) } },
      platform, settled, isOwned, chatResume: make,
    })
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { id: 1 } }, ...args)
    return { handlers, handler, make, isOwned, call }
  }

  it.each(['linux', 'win32'])('registers nothing on %s', (platform) => {
    expect(world({ platform }).handlers.size).toBe(0)
  })

  it('registers the two channels on macOS', () => {
    expect([...world().handlers.keys()]).toEqual(['agent-inbox:chat-resume-available', 'agent-inbox:chat-resume'])
    expect(CHANNELS).toEqual({ available: 'agent-inbox:chat-resume-available', resume: 'agent-inbox:chat-resume' })
  })

  it('answers the owned viewer, passing the request on', async () => {
    const w = world()
    expect(await w.call(CHANNELS.available)).toEqual({ available: true, terminal: 'iterm2' })
    expect(await w.call(CHANNELS.resume, { tool: 'claude', id: ID })).toEqual({ ok: true, terminal: 'terminal' })
    expect(w.handler.resume).toHaveBeenCalledWith({ tool: 'claude', id: ID })
  })

  it('answers any other window with nothing, and never makes the handler', async () => {
    const w = world({ owned: false })
    expect(await w.call(CHANNELS.available)).toEqual({ available: false, terminal: 'terminal' })
    expect(await w.call(CHANNELS.resume, { tool: 'claude', id: ID })).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(w.make).not.toHaveBeenCalled()
  })

  it('takes exact arguments', async () => {
    const w = world()
    expect(await w.call(CHANNELS.available, 'x')).toEqual({ available: false, terminal: 'terminal' })
    expect(await w.call(CHANNELS.resume)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await w.call(CHANNELS.resume, { tool: 'claude', id: ID }, 'extra')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(w.make).not.toHaveBeenCalled()
    expect(w.isOwned).not.toHaveBeenCalled()
  })

  it('waits for a re-proof in flight before it checks the window', async () => {
    let finish: () => void = () => {}
    const w = world({ settled: () => new Promise<void>((resolve) => { finish = resolve }) })
    const answer = w.call(CHANNELS.resume, { tool: 'claude', id: ID }) as Promise<unknown>
    await Promise.resolve()
    expect(w.isOwned).not.toHaveBeenCalled()
    finish()
    expect(await answer).toEqual({ ok: true, terminal: 'terminal' })
    expect(w.isOwned).toHaveBeenCalledTimes(1)
  })
})
