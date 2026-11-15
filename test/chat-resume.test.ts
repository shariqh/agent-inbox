// Resume a chat in Terminal (#586 PR 3): the script builder, the private writer
// and its sweep, main's handler over an injected index, folder check and
// terminal runner, and the IPC gate. Nothing here opens a terminal: every run
// is recorded. Fixtures are synthetic.
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
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
  // #586 phase 2: the driven-sessions switch (left out: the handler's default), and the one-chat route's answer
  isEnabled?: () => boolean
  lookup?: unknown
}

const DIR = '/Users/tester/.agent-inbox/chat-resume'

function chatEntry(over: Record<string, unknown> = {}) {
  return { id: ID, tool: 'claude', cwd: FOLDER, live: false, hidden: [], ...over }
}

function rig({ chats = [chatEntry()], folders = [FOLDER], terminal = 'terminal', platform = 'darwin', run, writeScript, isEnabled, lookup = null }: RigOptions = {}) {
  const state = { quitting: false, clock: 1_000_000, terminal, chats, lookup }
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
        if (route.startsWith('/api/chats/copilot/')) return typeof state.lookup === 'function' ? (state.lookup as (route: string) => unknown)(route) : state.lookup
        return typeof state.chats === 'function' ? (state.chats as (route: string) => unknown)(route) : { chats: state.chats }
      },
    },
    isDirectory: (folder) => folders.includes(folder),
    terminal: {
      read: reads,
      run: run ?? (async (command) => { runs.push([command.file, ...command.args]); return { ok: true } }),
    },
    scriptDir: DIR,
    ...(isEnabled ? { isEnabled } : {}),
    writeScript: writeScript ?? ((dir, name, text) => { written.push([dir, name, text]); return join(dir, name) }),
    now: () => state.clock,
    random: () => (n++).toString(16).padStart(16, '0'),
  })
  return { handler, state, routes, runs, written, reads }
}

const scriptFor = (tool: string, index = 0) => `${DIR}/${tool}-${ID}-${index.toString(16).padStart(16, '0')}.command`

// phase 1's refusals, each opening nothing; the switch-off test below runs them again
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

describe('createChatResume', () => {
  it('opens a script that cds to the index’s folder, in Terminal', async () => {
    const r = rig()
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: true, terminal: 'terminal' })
    expect(r.routes).toEqual(['/api/chats'])
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

  it('finds a chat the default list shows but the capped ?all=1 list leaves out', async () => {
    // more hidden chats than the 2,000 cap can push a listed chat out of ?all=1 alone
    const r = rig({ chats: (route: string) => ({ chats: route === '/api/chats' ? [chatEntry()] : [chatEntry({ id: ID2, hidden: ['non-interactive'] })] }) })
    expect(await r.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: true, terminal: 'terminal' })
    expect(r.routes).toEqual(['/api/chats'])
  })

  it('falls back to ?all=1 for a hidden chat, and refuses one neither list has', async () => {
    const hidden = rig({ chats: (route: string) => ({ chats: route === '/api/chats' ? [] : [chatEntry({ hidden: ['temp-folder'] })] }) })
    expect(await hidden.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: true, terminal: 'terminal' })
    expect(hidden.routes).toEqual(['/api/chats', '/api/chats?all=1'])
    const neither = rig({ chats: [chatEntry({ id: ID2 })] })
    expect(await neither.handler.resume({ tool: 'claude', id: ID })).toMatchObject({ ok: false, reason: 'missing' })
    expect(neither.routes).toEqual(['/api/chats', '/api/chats?all=1'])
    const unreadable = rig({ chats: (route: string) => (route === '/api/chats' ? { chats: [] } : null) })
    expect(await unreadable.handler.resume({ tool: 'claude', id: ID })).toMatchObject({ ok: false, reason: 'index' })
    expect(unreadable.runs).toEqual([])
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

// #586 phase 2 (design §3.5): with the driven-sessions switch on, Resume in Terminal never opens a
// second Copilot on a chat a launch of this app holds; with it off it reads and does what phase 1 did
describe('Resume in Terminal beside driven sessions (#586 phase 2)', () => {
  const LOOKUP = `/api/chats/copilot/${ID}`
  const copilot = () => [chatEntry({ tool: 'copilot' })]
  const held = 'This chat has a session here: use Show session, then Take over.'

  it.each([
    ['running', { status: 'running' }],
    ['parked', { status: 'parked', resumable: true }],
    ['stopped with its session', { status: 'ended', end_reason: 'stopped', resumable: true }],
  ])('with the switch on, refuses a chat a launch here holds (%s), and nothing opens or is written', async (_, launch) => {
    const r = rig({ chats: copilot(), isEnabled: () => true, lookup: { chat: chatEntry({ tool: 'copilot' }), launch: { id: ID2, ...launch } } })
    expect(await r.handler.resume({ tool: 'copilot', id: ID })).toEqual({ ok: false, reason: 'driven', error: held })
    expect(r.routes).toEqual(['/api/chats', LOOKUP])
    expect([r.runs, r.written]).toEqual([[], []])
  })

  it.each([
    ['no launch', null],
    ['a handed-off launch', { status: 'ended', end_reason: 'handed_off', resumable: true }],
    ['a launch that ended in an error', { status: 'ended', end_reason: 'error:load', resumable: false }],
    ['a launch stopped before its first message', { status: 'ended', end_reason: 'stopped', resumable: false }],
  ])('with the switch on, opens a chat with %s', async (_, launch) => {
    const r = rig({ chats: copilot(), isEnabled: () => true, lookup: { chat: chatEntry({ tool: 'copilot' }), launch } })
    expect(await r.handler.resume({ tool: 'copilot', id: ID })).toEqual({ ok: true, terminal: 'terminal' })
    expect(r.routes).toEqual(['/api/chats', LOOKUP])
    expect(r.runs).toHaveLength(1)
  })

  it('with the switch on, refuses when the route cannot be read or reads the chat live, and reads nothing new for Claude', async () => {
    for (const lookup of [null, 'x', { chat: null }, () => { throw new Error('gone') }]) {
      const r = rig({ chats: copilot(), isEnabled: () => true, lookup })
      expect(await r.handler.resume({ tool: 'copilot', id: ID })).toEqual({ ok: false, reason: 'index', error: 'Agent Inbox could not read the chat list.' })
      expect(r.runs).toEqual([])
    }
    const live = rig({ chats: copilot(), isEnabled: () => true, lookup: { chat: chatEntry({ tool: 'copilot', live: true }), launch: null } })
    expect(await live.handler.resume({ tool: 'copilot', id: ID })).toEqual({ ok: false, reason: 'live', error: 'This chat is live in another process.' })
    expect(live.runs).toEqual([])
    const claude = rig({ isEnabled: () => true, lookup: { chat: null, launch: { status: 'running' } } })
    expect(await claude.handler.resume({ tool: 'claude', id: ID })).toEqual({ ok: true, terminal: 'terminal' })
    expect(claude.routes).toEqual(['/api/chats'])
  })

  it('reads the switch on every resume', async () => {
    let on = false
    const r = rig({ chats: copilot(), isEnabled: () => on, lookup: { chat: chatEntry({ tool: 'copilot' }), launch: { status: 'running' } } })
    expect(await r.handler.resume({ tool: 'copilot', id: ID })).toMatchObject({ ok: true })
    on = true
    r.state.clock += REOPEN_MS
    expect(await r.handler.resume({ tool: 'copilot', id: ID })).toMatchObject({ ok: false, reason: 'driven' })
  })

  // phase 1's cases, run with the switch off and a route that would refuse every one of them: the
  // same answers, the same reads, the same scripts and opens as with no switch at all
  const cases: Array<[string, Partial<RigOptions>, unknown]> = [
    ['a Copilot chat', { chats: copilot() }, { tool: 'copilot', id: ID }],
    ['a Claude chat', {}, { tool: 'claude', id: ID }],
    ['a hidden chat', { chats: (route: string) => ({ chats: route === '/api/chats' ? [] : copilot() }) }, { tool: 'copilot', id: ID }],
    ...refusals.map(([name, options, request]) => [name, options, request] as [string, Partial<RigOptions>, unknown]),
    // and each as a Copilot chat, the only tool the route answers for
    ...refusals.filter(([, , request]) => (request as { tool?: string })?.tool === 'claude').map(([name, options, request]) => [
      `${name} (Copilot)`,
      { ...options, chats: Array.isArray(options.chats) ? options.chats.map((entry) => ({ ...(entry as object), tool: 'copilot' })) : options.chats ?? copilot() },
      { ...(request as object), tool: 'copilot' },
    ] as [string, Partial<RigOptions>, unknown]),
  ]
  it.each(cases)('with the switch off, %s gets phase 1’s result and no new read', async (_, options, request) => {
    const before = rig(options as RigOptions)
    const off = rig({ ...(options as RigOptions), isEnabled: () => false, lookup: () => { throw new Error('read with the switch off') } })
    const expected = await before.handler.resume(request)
    expect(await off.handler.resume(request)).toEqual(expected)
    expect(off.routes).toEqual(before.routes)
    expect(off.routes.some((route) => route.startsWith('/api/chats/copilot/'))).toBe(false)
    expect([off.runs, off.written]).toEqual([before.runs, before.written])
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

const REPO = join(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')

describe('main’s wiring (source)', () => {
  const main = read('electron/main.cjs')
  const at = main.indexOf('registerChatResumeIpc({')
  const call = main.slice(at, main.indexOf('})', at))
  const made = main.slice(main.indexOf('const chatResumeFor = () =>'), at)

  it('registers the channels once, after the launch IPC and outside the link slice the link tests run', () => {
    expect(main.match(/registerChatResumeIpc\(/g)).toHaveLength(1)
    expect(at).toBeGreaterThan(main.indexOf('registerLaunchIpc({'))
    const sliceEnd = main.indexOf("ipcMain.handle('agent-inbox:set-theme-preference'")
    expect(at).toBeGreaterThan(sliceEnd)
    expect(main).not.toMatch(/ipcMain\.handle\('agent-inbox:chat-resume/)
  })

  it('gates on the owned viewer after the re-proof, on this platform', () => {
    expect(call).toContain('platform: process.platform,')
    expect(call).toContain('settled: () => installBinding?.settled() ?? Promise.resolve(),')
    expect(call).toContain('isOwned: (event) => linkSender(event) && linkFilesPermitted(event),')
    expect(call).toContain('chatResume: chatResumeFor,')
  })

  it('reads the index through the viewer and runs the launchers’ own terminal runner', () => {
    expect(made).toContain('isQuitting: () => installGate.quitting(),')
    expect(made).toContain('viewer: launchViewer,')
    expect(made).toContain('return statSync(folder).isDirectory()')
    expect(made).toContain('terminal: { read: () => linkPrefs().readTerminal(), run: runTerminalCommand },')
    expect(made).toContain("scriptDir: path.join(path.dirname(launchHubPath()), 'chat-resume'),")
    // #586 phase 2: the driven-sessions switch as main holds it, read on each resume
    expect(made).toContain('isEnabled: () => launchEnabled === true,')
    // one runner, so both callers share its env and its 10 s timeout
    expect(main.match(/execFile\(command\.file, command\.args, \{ env: \{ PATH: '\/usr\/bin:\/bin' \}, timeout: 10_000 \}/g)).toHaveLength(1)
    expect(main).toContain('run: runTerminalCommand,')
  })
})

type ChatsBridge = {
  resumeAvailable(...args: unknown[]): Promise<unknown>
  resume(...args: unknown[]): Promise<unknown>
}

function loadPreload(answer: (channel: string, ...args: unknown[]) => unknown) {
  const exposed: Record<string, unknown> = {}
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => answer(channel, ...args))
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api } },
    ipcRenderer: { invoke, on: () => {}, removeListener: () => {} },
  }
  const factory = vm.runInThisContext(
    `(function (require, process) {\n${read('electron/setup-preload.cjs')}\n})`,
    { filename: 'setup-preload.cjs' },
  ) as (require: (id: string) => unknown, process: { argv: string[] }) => void
  factory((id) => {
    if (id !== 'electron') throw new Error(`unexpected require ${id}`)
    return electron
  }, { argv: [] })
  return { chats: exposed.agentInboxChats as ChatsBridge, invoke }
}

describe('the agentInboxChats bridge', () => {
  it('has the two methods, and sends a fresh { tool, id } and nothing else', async () => {
    const { chats, invoke } = loadPreload(() => ({ ok: true, terminal: 'iterm2' }))
    expect(Object.keys(chats)).toEqual(['resumeAvailable', 'resume'])
    expect(await chats.resume({ tool: 'claude', id: ID, cwd: '/x', command: 'sh' })).toEqual({ ok: true, terminal: 'iterm2' })
    expect(invoke.mock.calls).toEqual([['agent-inbox:chat-resume', { tool: 'claude', id: ID }]])
  })

  it.each([
    [[]],
    [[{ tool: 'claude', id: ID }, 'second']],
    [[null]],
    [[ID]],
    [[[{ tool: 'claude', id: ID }]]],
    [[{ tool: 'sh', id: ID }]],
    [[{ tool: 'copilot', id: ID.toUpperCase().replace('0000-4000', 'ABCD-4000') }]],
    [[{ tool: 'copilot', id: `${ID};id` }]],
  ])('refuses %j without asking main', async (args) => {
    const { chats, invoke } = loadPreload(() => ({ ok: true, terminal: 'terminal' }))
    expect(await chats.resume(...args)).toEqual({ ok: false, reason: 'invalid', error: 'This chat can’t be resumed.' })
    expect(invoke).not.toHaveBeenCalled()
  })

  const noAnswer = { ok: false, reason: 'unavailable', error: 'Agent Inbox did not answer.' }
  it.each([
    ['a refusal', { ok: false, reason: 'live', error: 'This chat is live in another process.', extra: 1 }, { ok: false, reason: 'live', error: 'This chat is live in another process.' }],
    // #586 phase 2: a chat driven here, with the switch on
    ['a driven chat', { ok: false, reason: 'driven', error: 'This chat has a session here: use Show session, then Take over.' }, { ok: false, reason: 'driven', error: 'This chat has a session here: use Show session, then Take over.' }],
    ['a refusal with a long error', { ok: false, reason: 'open', error: 'x'.repeat(900) }, { ok: false, reason: 'open', error: 'x'.repeat(500) }],
    ['a success with the fallback notice', { ok: true, terminal: 'terminal', notice: 'n'.repeat(600), folder: '/x' }, { ok: true, terminal: 'terminal', notice: 'n'.repeat(500) }],
    ['an unknown reason', { ok: false, reason: 'shell', error: 'x' }, noAnswer],
    ['a refusal with no error', { ok: false, reason: 'live' }, noAnswer],
    ['an unknown terminal', { ok: true, terminal: 'Hyper' }, noAnswer],
    ['no object', 'yes', noAnswer],
  ])('filters the answer: %s', async (_, answer, expected) => {
    const { chats } = loadPreload(() => answer)
    expect(await chats.resume({ tool: 'copilot', id: ID })).toEqual(expected)
  })

  it('turns a rejection into an answer', async () => {
    const { chats } = loadPreload(() => { throw new Error('No handler registered') })
    expect(await chats.resume({ tool: 'copilot', id: ID })).toEqual(noAnswer)
    expect(await chats.resumeAvailable()).toEqual({ available: false, terminal: 'terminal' })
  })

  it('says whether this window can resume, and with which terminal', async () => {
    const { chats, invoke } = loadPreload(() => ({ available: true, terminal: 'iterm2', extra: true }))
    expect(await chats.resumeAvailable()).toEqual({ available: true, terminal: 'iterm2' })
    expect(invoke.mock.calls).toEqual([['agent-inbox:chat-resume-available']])
    expect(await chats.resumeAvailable('x')).toEqual({ available: false, terminal: 'terminal' })
    for (const answer of [{ available: true, terminal: 'Hyper' }, { available: 'yes', terminal: 'terminal' }, null]) {
      expect(await loadPreload(() => answer).chats.resumeAvailable()).toEqual({ available: false, terminal: 'terminal' })
    }
  })
})
