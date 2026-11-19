// Open desk (#617 PR 4b; design docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.4):
// the command template's rule, its filling (parsed back by a real `sh`, twice for {attach}, as ssh
// and the remote shell would), the login shell, the script, and main's handler with every check in
// order. Nothing here opens a terminal or runs ssh or tmux: the terminal runner is recorded, and the
// `ssh` and `tmux` the quoting tests meet are a script in a scratch folder and a shell function.
// Fixtures are synthetic (hub.example.ts.net, studio, laptop, my-desk).
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import deskOpenModule from '../electron/desk-open.cjs'
import rules from '../electron/remote-connect-rules.cjs'
import chatResume from '../electron/chat-resume.cjs'
import type { TerminalCommand, TerminalRun } from '../electron/terminal-launch.cjs'
import { PLACE_NAME } from '../public/place.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { ACTIVITY_MAX, DESK_SCRIPT, createDeskOpen, deskConfirmation, deskRequest, deskScript, fillDeskCommand, loginShell } = deskOpenModule
const { DESK_COMMAND_MAX, PLACE, validDeskCommand } = rules
const { SCRIPT_KEEP_MS, scriptName } = chatResume

afterEach(() => {
  removeScratchDirs()
  vi.restoreAllMocks()
})

const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
const NEL = String.fromCharCode(0x85)

// ── the template rule ────────────────────────────────────────────────────────────

describe('validDeskCommand: the one rule for a stored or proposed template', () => {
  it.each([
    'ssh -t studio {attach}',
    'mydesk studio {desk}',
    '{attach}',
    '{desk}',
    'ssh -t studio {attach} # {desk}',
    `ssh -t studio {attach}${' '.repeat(DESK_COMMAND_MAX - 'ssh -t studio {attach}'.length)}`,
  ])('accepts %j', (text) => {
    expect(validDeskCommand(text)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['no placeholder', 'ssh -t studio tmux attach'],
    ['one character too long', `{desk}${'x'.repeat(DESK_COMMAND_MAX - 5)}`],
    ['a newline', 'ssh studio\n{attach}'],
    ['a carriage return', 'ssh studio\r{attach}'],
    ['a tab', 'ssh\t-t studio {attach}'],
    ['a NUL', 'ssh -t studio {attach}\u0000'],
    ['an escape', '\u001b[31m{desk}'],
    ['U+001F', '{desk}\u001f'],
    ['DEL', '{desk}\u007f'],
    ['a C1 next-line', `{desk}${NEL}`],
    ['a line separator', `{desk}${LS}x`],
    ['a paragraph separator', `{desk}${PS}x`],
    ['the cut {host}', 'ssh -t {host} {attach}'],
    ['the cut {target}', 'tmux attach -t {target}'],
    ['a placeholder in capitals', 'mydesk {Desk}'],
    ['a placeholder with spaces', 'mydesk { desk }'],
    ['a stray opening brace', 'mydesk { {desk}'],
    ['a stray closing brace', 'mydesk {desk} }'],
    ['doubled braces', 'mydesk {{desk}}'],
    ['an unclosed placeholder', 'mydesk {desk'],
    ['a shell brace group', '{ ssh studio {attach}; }'],
    ['a brace expansion', 'echo {a,b} {desk}'],
  ])('refuses %s', (_label, text) => {
    expect(validDeskCommand(text)).toBe(false)
  })

  it.each([null, undefined, 7, ['{desk}'], { toString: () => '{desk}' }])('refuses a value that is not text: %j', (value) => {
    expect(validDeskCommand(value)).toBe(false)
  })

  it('caps at 512', () => {
    expect(DESK_COMMAND_MAX).toBe(512)
  })
})

// ── filling ──────────────────────────────────────────────────────────────────────

const EDGE_DESKS = ['a', '_x', 'a.b-c_d', `A${'b'.repeat(62)}9`]
// The shells that read the command: /bin/sh, and zsh where it exists (the usual login shell, and the
// one that reads a word starting with `=` as a command's path unless it is quoted). `-f`: zsh reads
// no startup file; sh does no globbing.
const READERS = ['/bin/sh', ...(existsSync('/bin/zsh') ? ['/bin/zsh'] : [])]
const READS = READERS.flatMap((reader) => EDGE_DESKS.map((desk) => [reader, desk] as const))

/** A real shell (`reader`) reading `command`; its stdout. */
const sh = (reader: string, command: string, env: Record<string, string> = {}) =>
  execFileSync(reader, ['-f', '-c', command], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' })

describe('fillDeskCommand', () => {
  it('puts the bare desk for {desk} and the quoted attach command for {attach}', () => {
    expect(fillDeskCommand('mydesk studio {desk}', 'my-desk')).toBe('mydesk studio my-desk')
    expect(fillDeskCommand('ssh -t studio {attach}', 'my-desk')).toBe(`ssh -t studio 'tmux attach -t '\\''=my-desk'\\'''`)
    expect(fillDeskCommand('{desk} {attach} {desk}', 'my-desk')).toBe(`my-desk 'tmux attach -t '\\''=my-desk'\\''' my-desk`)
  })

  it('reads no replacement pattern in the template', () => {
    expect(fillDeskCommand("echo '$&' \"$'\" {desk}", 'my-desk')).toBe("echo '$&' \"$'\" my-desk")
  })

  it('pins the desk pattern to the page’s PLACE_NAME', () => {
    expect(PLACE.source).toBe(PLACE_NAME.source)
    expect(PLACE.flags).toBe(PLACE_NAME.flags)
  })

  it.each([['', 'empty'], ['-x', 'a leading dash'], ['a b', 'a space'], ["a'b", 'a quote'], ['a;b', 'a semicolon'], ['$(id)', 'a substitution'],
    ['a\nb', 'a newline'], [`a${'b'.repeat(64)}`, '65 characters'], ['.x', 'a leading dot']])('refuses the desk %j (%s)', (desk) => {
    expect(fillDeskCommand('mydesk {desk}', desk)).toBeNull()
    expect(fillDeskCommand('ssh -t studio {attach}', desk)).toBeNull()
  })

  it('refuses a template that fails its rule, and a desk that is not text', () => {
    expect(fillDeskCommand('ssh -t {host} {attach}', 'my-desk')).toBeNull()
    expect(fillDeskCommand('no placeholder', 'my-desk')).toBeNull()
    expect(fillDeskCommand('{desk}', 7)).toBeNull()
  })

  it.each(READS)('%s reads {desk} and {attach} back as one word each, for the desk %j', (reader, desk) => {
    expect(PLACE.test(desk)).toBe(true)
    const filled = fillDeskCommand("printf '%s\\n' {desk} {attach}", desk)!
    expect(sh(reader, filled).split('\n').slice(0, -1)).toEqual([desk, `tmux attach -t '=${desk}'`])
  })

  it.each(READS)('through ssh’s join and a second read by %s, tmux gets exactly attach -t =<desk>, for the desk %j', (reader, desk) => {
    const dir = scratchDir('desk-open-ssh-')
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    // a stand-in for ssh: drops `-t <host>`, joins the rest with spaces as ssh does, and has a second
    // shell ($READER) read the result, where `tmux` is a function that prints its arguments
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nshift 2\nexec "$READER" -f -c "tmux() { printf \'%s\\n\' \\"\\$@\\"; }; $*"\n')
    chmodSync(join(bin, 'ssh'), 0o755)
    const filled = fillDeskCommand('ssh -t studio {attach}', desk)!
    expect(sh(reader, filled, { PATH: `${bin}:/usr/bin:/bin`, READER: reader }).split('\n').slice(0, -1)).toEqual(['attach', '-t', `=${desk}`])
  })
})

describe('deskConfirmation', () => {
  it('shows the command filled for the example desk, and where it runs', () => {
    expect(deskConfirmation('ssh -t studio {attach}')).toEqual({
      message: 'Run this in your terminal when you press Open desk?',
      detail: `ssh -t studio 'tmux attach -t '\\''=example-desk'\\'''\n\nIt runs on this Mac, in your login shell.`,
      buttons: ['Save', 'Cancel'],
    })
    expect(deskConfirmation('mydesk studio {desk}')!.detail.split('\n')[0]).toBe('mydesk studio example-desk')
  })

  it('has nothing to show for an invalid command', () => {
    for (const command of ['', 'ssh studio', 'ssh {host}', 'a\n{desk}', 7]) expect(deskConfirmation(command)).toBeNull()
  })
})

// ── the login shell and the script ───────────────────────────────────────────────

const SHELLS = '# List of acceptable shells\n\n/bin/bash\n/bin/csh\n/bin/sh\n/bin/zsh\n/opt/homebrew/bin/fish  \n'

describe('loginShell', () => {
  it.each([
    ['a listed shell', '/bin/bash', '/bin/bash'],
    ['a listed shell with spaces after it in the file', '/opt/homebrew/bin/fish', '/opt/homebrew/bin/fish'],
    ['a shell /etc/shells does not list', '/usr/local/bin/evil', '/bin/zsh'],
    ['a relative path', 'bin/bash', '/bin/zsh'],
    ['a bare name', 'bash', '/bin/zsh'],
    ['a path with a newline', '/bin/bash\n/bin/sh', '/bin/zsh'],
    ['a path with a NUL', '/bin/bash\u0000', '/bin/zsh'],
    ['a comment line', '# List of acceptable shells', '/bin/zsh'],
    ['nothing', null, '/bin/zsh'],
    ['an empty path', '', '/bin/zsh'],
  ])('%s', (_label, shell, expected) => {
    expect(loginShell(shell, SHELLS)).toBe(expected)
  })

  it('is /bin/zsh when /etc/shells could not be read', () => {
    expect(loginShell('/bin/bash', null)).toBe('/bin/zsh')
    expect(loginShell('/bin/bash', '')).toBe('/bin/zsh')
  })
})

describe('deskScript', () => {
  const COMMAND = `ssh -t studio 'tmux attach -t '\\''=my-desk'\\'''`

  it('is #!/bin/sh, a comment, and exec of the login shell with -l -i -c and the command as one word', () => {
    // a POSIX shell word written the plain way: single quotes, each ' as '\''
    const word = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
    expect(deskScript('/bin/zsh', COMMAND)).toBe([
      '#!/bin/sh',
      '# Agent Inbox: Open desk (#617)',
      `exec '/bin/zsh' -l -i -c ${word(COMMAND)}`,
      '',
    ].join('\n'))
    expect(word('a\'b')).toBe("'a'\\''b'")
  })

  it.each(EDGE_DESKS)('hands the login shell exactly -l, -i, -c and the filled command, for the desk %j', (desk) => {
    const dir = scratchDir('desk-open-script-')
    // a stand-in login shell that prints what it was given
    const shell = join(dir, 'login shell')
    writeFileSync(shell, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n')
    chmodSync(shell, 0o755)
    const filled = fillDeskCommand('ssh -t studio {attach}', desk)!
    const script = join(dir, 'desk.command')
    writeFileSync(script, deskScript(shell, filled), { mode: 0o700 })
    expect(execFileSync('/bin/sh', [script], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })).toBe(`-l\n-i\n-c\n${filled}\n`)
  })
})

describe('deskRequest', () => {
  it('reads exactly [{ session }]', () => {
    expect(deskRequest([{ session: '00000000-0000-4000-8000-000000000001' }])).toBe('00000000-0000-4000-8000-000000000001')
    expect(deskRequest([{ session: 'launch:abc' }])).toBe('launch:abc')
    expect(deskRequest([{ session: 'a'.repeat(128) }])).toBe('a'.repeat(128))
  })

  it.each([
    ['no argument', []],
    ['two arguments', [{ session: 'a' }, {}]],
    ['not a list', { session: 'a' }],
    ['a string', ['a']],
    ['a list inside', [['a']]],
    ['an extra key', [{ session: 'a', desk: 'my-desk' }]],
    ['no session', [{}]],
    ['a session that is not text', [{ session: 1 }]],
    ['an empty session', [{ session: '' }]],
    ['129 characters', [{ session: 'a'.repeat(129) }]],
    ['a leading dash', [{ session: '-a' }]],
    ['a space', [{ session: 'a b' }]],
    ['an object with another prototype', [Object.assign(Object.create({ evil: true }), { session: 'a' })]],
  ])('refuses %s', (_label, args) => {
    expect(deskRequest(args)).toBeNull()
  })
})

// ── main's handler ───────────────────────────────────────────────────────────────

const ID = '0123abcd'
const BASE = 'https://hub.example.ts.net/'
const SESSION = '00000000-0000-4000-8000-000000000001'
const DIR = '/Users/tester/.agent-inbox/desk-open'
const COMMAND = 'ssh -t studio {attach}'
const HUB_EVENT = { trust: 'hub' }

interface RigOptions {
  platform?: string
  stored?: unknown
  rows?: unknown
  activity?: (url: string, init: unknown) => Response | Promise<Response>
  base?: string | null
  terminal?: unknown
  run?: (command: TerminalCommand) => Promise<TerminalRun>
  writeScript?: ((dir: string, name: string, text: string) => string | null) | 'real'
  scriptDir?: string
  userShell?: () => unknown
  shells?: string
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function rig(options: RigOptions = {}) {
  const state = {
    clock: 1_000_000,
    input: true,
    stored: options.stored === undefined ? { id: ID, machine: 'studio', deskCommand: COMMAND } : options.stored,
    rows: options.rows === undefined ? [{ session: SESSION, machine: 'studio', desk: 'my-desk' }] : options.rows,
  }
  const gestures: unknown[] = []
  const fetches: Array<[string, unknown]> = []
  const runs: string[][] = []
  const written: Array<[string, string, string]> = []
  const logs: string[] = []
  let n = 0
  const hubView = {
    trusts: (event: unknown) => (event as { trust?: string } | null)?.trust as 'hub' | 'offline' | null ?? null,
    // one press, one open: the real view's rule (test/hub-view.test.ts), kept as a flag here
    takeGesture: (event: unknown) => {
      gestures.push(event)
      if ((event as { trust?: string })?.trust !== 'hub' || !state.input) return null
      state.input = false
      return ID
    },
  }
  const hubFetch = vi.fn(() => async (url: unknown, init: unknown) => {
    fetches.push([String(url), init])
    return options.activity ? options.activity(String(url), init) : json(state.rows)
  })
  const writeScript = options.writeScript === 'real' ? undefined
    : options.writeScript ?? ((dir: string, name: string, text: string) => { written.push([dir, name, text]); return join(dir, name) })
  const desk = createDeskOpen({
    platform: options.platform ?? 'darwin',
    hubView: () => hubView,
    storedHub: async () => state.stored as never,
    hubFetch,
    hubBase: (id: string) => (options.base === undefined ? (id === ID ? BASE : null) : options.base),
    scriptDir: options.scriptDir ?? DIR,
    terminal: {
      read: async () => {
        if (options.terminal instanceof Error) throw options.terminal
        return options.terminal ?? 'terminal'
      },
      run: options.run ?? (async (command) => { runs.push([command.file, ...command.args]); return { ok: true } }),
    },
    now: () => state.clock,
    randomBytes: (size: number) => Buffer.from((n++).toString(16).padStart(size * 2, '0'), 'hex'),
    userShell: options.userShell ?? (() => '/bin/zsh'),
    readShells: () => options.shells ?? SHELLS,
    ...(writeScript ? { writeScript } : {}),
    log: (line: string) => logs.push(line),
  })
  /** One open with a fresh press, two seconds after the last. */
  const press = async (args: unknown[] = [{ session: SESSION }], event: unknown = HUB_EVENT) => {
    state.input = true
    state.clock += 2_000
    return desk.open(event, args)
  }
  return { desk, state, gestures, fetches, runs, written, logs, hubFetch, press }
}

const scriptAt = (index = 0) => `${DIR}/desk-${index.toString(16).padStart(16, '0')}.command`

describe('createDeskOpen: an open that works', () => {
  it('reads the hub’s activity, fills the command with the row’s desk, writes the script and opens it in Terminal', async () => {
    const r = rig()
    expect(await r.press()).toEqual({ ok: true })
    expect(r.fetches).toEqual([[`${BASE}api/activity`, { method: 'GET' }]])
    expect(r.written).toEqual([[DIR, 'desk-0000000000000000.command', deskScript('/bin/zsh', fillDeskCommand(COMMAND, 'my-desk')!)]])
    expect(r.runs).toEqual([['/usr/bin/open', '-b', 'com.apple.Terminal', '--', scriptAt(0)]])
    expect(r.logs).toEqual(['desk-open: opened'])
  })

  it('opens iTerm2 when chosen, and falls back to Terminal with a notice when iTerm2 is missing', async () => {
    const iterm = rig({ terminal: 'iterm2' })
    expect(await iterm.press()).toEqual({ ok: true })
    expect(iterm.runs).toEqual([['/usr/bin/open', '-b', 'com.googlecode.iterm2', '--', scriptAt(0)]])
    const runs: string[][] = []
    const missing = rig({
      terminal: 'iterm2',
      run: async (command) => { runs.push(command.args); return command.args[1] === 'com.googlecode.iterm2' ? { ok: false, missing: true } : { ok: true } },
    })
    expect(await missing.press()).toEqual({ ok: true, notice: 'iTerm2 could not be opened, so Terminal was opened instead.' })
    expect(runs.map((args) => args[1])).toEqual(['com.googlecode.iterm2', 'com.apple.Terminal'])
  })

  it('reads Settings → Terminal on each open, and a throw or an unknown value means Terminal', async () => {
    for (const terminal of [new Error('unreadable'), 'xterm', 7]) {
      const r = rig({ terminal })
      expect(await r.press()).toEqual({ ok: true })
      expect(r.runs[0]![2]).toBe('com.apple.Terminal')
    }
  })

  it('runs the command in the user’s listed login shell, else /bin/zsh', async () => {
    const bash = rig({ userShell: () => '/bin/bash' })
    await bash.press()
    expect(bash.written[0]![2]).toContain("exec '/bin/bash' -l -i -c ")
    for (const userShell of [() => '/usr/local/bin/unlisted', () => 'bash', () => '/bin/bash\n', () => { throw new Error('no user') }]) {
      const r = rig({ userShell })
      await r.press()
      expect(r.written[0]![2]).toContain("exec '/bin/zsh' -l -i -c ")
    }
  })

  it('fills {desk} bare for a shell function of the owner’s own', async () => {
    const r = rig({ stored: { id: ID, machine: 'studio', deskCommand: 'mydesk studio {desk}' } })
    await r.press()
    expect(r.written[0]![2].split('\n')[2]).toBe("exec '/bin/zsh' -l -i -c 'mydesk studio my-desk'")
  })

  it('reads the activity through the given hub fetch only, never the global fetch', async () => {
    const global = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('the global fetch was used') })
    const r = rig()
    expect(await r.press()).toEqual({ ok: true })
    expect(r.hubFetch).toHaveBeenCalledTimes(1)
    expect(global).not.toHaveBeenCalled()
  })

  it('takes nothing from the hub but the desk: the row’s other fields never reach the script', async () => {
    const r = rig({ rows: [{ session: SESSION, machine: 'studio', desk: 'my-desk', pane: '%1', remote_session: 'session_x', project: "'; rm -rf ~; '", doing: '$(id)' }] })
    await r.press()
    const text = r.written[0]![2]
    for (const value of ['%1', 'session_x', 'rm -rf', '$(id)', SESSION]) expect(text.includes(value), value).toBe(false)
  })
})

describe('createDeskOpen: each check, in order', () => {
  it('1. the sender: anything but the hub view on the hub’s page is unavailable, before anything else', async () => {
    const r = rig()
    for (const event of [{ trust: 'offline' }, { trust: null }, null, {}]) {
      expect(await r.press([{ session: SESSION }], event)).toEqual({ ok: false, reason: 'unavailable' })
    }
    const linux = rig({ platform: 'linux' })
    expect(await linux.press()).toEqual({ ok: false, reason: 'unavailable' })
    expect([r.gestures, linux.gestures, r.fetches, r.written, r.runs]).toEqual([[], [], [], [], []])
  })

  it('1. the request: anything but exactly { session } is bad_request, and uses no press', async () => {
    const r = rig()
    for (const args of [[], [{ session: SESSION }, 'x'], [{ session: SESSION, desk: 'my-desk' }], [{ session: 'a b' }], ['x'], [null]]) {
      expect(await r.press(args)).toEqual({ ok: false, reason: 'bad_request' })
    }
    expect(r.gestures).toEqual([])
    expect(r.state.input).toBe(true)
  })

  it('2. the gesture: no fresh press is no_gesture, and one press opens one desk', async () => {
    const r = rig()
    r.state.input = false
    expect(await r.desk.open(HUB_EVENT, [{ session: SESSION }])).toEqual({ ok: false, reason: 'no_gesture' })
    expect(await r.press()).toEqual({ ok: true })
    r.state.clock += 10_000
    // the same press again, well past the rate limit
    expect(await r.desk.open(HUB_EVENT, [{ session: SESSION }])).toEqual({ ok: false, reason: 'no_gesture' })
    expect(r.runs).toHaveLength(1)
  })

  it('3. the rate: one open per 2 seconds, three per minute', async () => {
    const r = rig()
    expect(await r.press()).toEqual({ ok: true })
    r.state.input = true
    r.state.clock += 1_999
    expect(await r.desk.open(HUB_EVENT, [{ session: SESSION }])).toEqual({ ok: false, reason: 'busy' })
    // t0 + 2s and t0 + 4s: the second and third in the minute
    r.state.clock -= 1_999
    expect(await r.press()).toEqual({ ok: true })
    expect(await r.press()).toEqual({ ok: true })
    expect(await r.press()).toEqual({ ok: false, reason: 'busy' })
    // a minute after the first, one more may go
    r.state.input = true
    r.state.clock += 54_000
    expect(await r.desk.open(HUB_EVENT, [{ session: SESSION }])).toEqual({ ok: true })
    expect(r.runs).toHaveLength(4)
  })

  it('3. the rate: never two at once', async () => {
    let release!: () => void
    const r = rig({ activity: () => new Promise<Response>((resolve) => { release = () => resolve(json([{ session: SESSION, desk: 'my-desk' }])) }) })
    const first = r.press()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    r.state.input = true
    r.state.clock += 60_000
    expect(await r.desk.open(HUB_EVENT, [{ session: SESSION }])).toEqual({ ok: false, reason: 'busy' })
    release()
    expect(await first).toEqual({ ok: true })
  })

  it('3. a clock that is not a number is busy', async () => {
    const r = rig()
    r.state.clock = Number.NaN
    r.state.input = true
    expect(await r.desk.open(HUB_EVENT, [{ session: SESSION }])).toEqual({ ok: false, reason: 'busy' })
  })

  it.each([
    ['no stored hub', null],
    ['no command', { id: ID, machine: 'studio', deskCommand: null }],
    ['a stored command that fails its rule', { id: ID, machine: 'studio', deskCommand: 'ssh -t {host} {attach}' }],
    ['another hub stored than the view shows', { id: 'ffffffff', machine: 'studio', deskCommand: COMMAND }],
  ])('4. %s is no_command, read before the hub', async (_label, stored) => {
    const r = rig({ stored })
    expect(await r.press()).toEqual({ ok: false, reason: 'no_command' })
    expect([r.fetches, r.written, r.runs]).toEqual([[], [], []])
  })

  it.each([
    ['no base for the hub (not the active one)', { base: null }],
    ['a fetch that throws (refused while the hub is checked again)', { activity: () => { throw Object.assign(new Error('not the hub origin'), { code: 'not_hub_origin' }) } }],
    ['a 403', { activity: () => json([], 403) }],
    ['a 500', { activity: () => json([], 500) }],
    ['a body that is not a list', { activity: () => json({ rows: [] }) }],
    ['a body that is not JSON', { activity: () => new Response('<html>', { status: 200 }) }],
    ['a body over 5 MB', { activity: () => new Response(`[${'"x",'.repeat(Math.ceil(ACTIVITY_MAX / 4))}"x"]`, { status: 200 }) }],
  ])('5. %s is unreachable', async (_label, options) => {
    const r = rig(options as RigOptions)
    expect(await r.press()).toEqual({ ok: false, reason: 'unreachable' })
    expect([r.written, r.runs]).toEqual([[], []])
  })

  it('5. no row for the session is not_found', async () => {
    const r = rig({ rows: [{ session: 'other', desk: 'my-desk' }, null, 'x', [SESSION]] })
    expect(await r.press()).toEqual({ ok: false, reason: 'not_found' })
  })

  it.each([
    ['no desk', undefined],
    ['a desk with a space', 'my desk'],
    ['a desk with a quote', "my'desk"],
    ['a desk with a substitution', '$(id)'],
    ['a desk that starts with a dash', '-x'],
    ['a desk of 65 characters', 'a'.repeat(65)],
    ['a desk with a newline', 'my\ndesk'],
    ['a desk that is not text', 7],
  ])('5. %s from the hub is no_desk, and nothing is written or opened', async (_label, desk) => {
    const r = rig({ rows: [{ session: SESSION, machine: 'studio', ...(desk === undefined ? {} : { desk }) }] })
    expect(await r.press()).toEqual({ ok: false, reason: 'no_desk' })
    expect([r.written, r.runs]).toEqual([[], []])
  })

  it.each([
    ['equal machines', 'studio', 'studio', { ok: true }],
    ['different machines', 'laptop', 'studio', { ok: false, reason: 'not_on_hub' }],
    ['no machine on the row', undefined, 'studio', { ok: true }],
    ['a row machine that fails the pattern (read as none)', 'stu dio', 'studio', { ok: true }],
    ['no machine stored for the hub yet', 'laptop', null, { ok: true }],
  ])('6. %s', async (_label, machine, hubMachine, expected) => {
    const r = rig({
      stored: { id: ID, machine: hubMachine, deskCommand: COMMAND },
      rows: [{ session: SESSION, desk: 'my-desk', ...(machine === undefined ? {} : { machine }) }],
    })
    expect(await r.press()).toEqual(expected)
    expect(r.runs).toHaveLength(expected.ok ? 1 : 0)
  })

  it('7. a script that cannot be written is failed, and nothing is opened', async () => {
    const r = rig({ writeScript: () => null })
    expect(await r.press()).toEqual({ ok: false, reason: 'failed' })
    expect(r.runs).toEqual([])
  })

  it('8. a terminal that does not open is terminal_failed', async () => {
    for (const run of [async () => ({ ok: false }), async () => ({ ok: false, timedOut: true }), async () => { throw new Error('x') }]) {
      const r = rig({ run: run as never })
      expect(await r.press()).toEqual({ ok: false, reason: 'terminal_failed' })
    }
  })

  it('logs only the reason word: no host, session, desk or command', async () => {
    const r = rig()
    await r.press([{ session: SESSION }], { trust: 'offline' })
    await r.press([{ session: 'x y' }])
    r.state.rows = [{ session: SESSION, machine: 'laptop', desk: 'my-desk' }]
    await r.press()
    r.state.rows = [{ session: SESSION, machine: 'studio', desk: 'my-desk' }]
    await r.press()
    expect(r.logs).toEqual(['desk-open: unavailable', 'desk-open: bad_request', 'desk-open: not_on_hub', 'desk-open: opened'])
  })
})

describe('createDeskOpen: available()', () => {
  it('is open only for the hub’s page, on macOS, with no argument, while the active hub has a valid command', async () => {
    expect(await rig().desk.available(HUB_EVENT, [])).toEqual({ open: true })
    expect(await rig().desk.available({ trust: 'offline' }, [])).toEqual({ open: false })
    expect(await rig().desk.available(null, [])).toEqual({ open: false })
    expect(await rig().desk.available(HUB_EVENT, ['x'])).toEqual({ open: false })
    expect(await rig({ platform: 'linux' }).desk.available(HUB_EVENT, [])).toEqual({ open: false })
    expect(await rig({ stored: null }).desk.available(HUB_EVENT, [])).toEqual({ open: false })
    expect(await rig({ stored: { id: ID, machine: null, deskCommand: null } }).desk.available(HUB_EVENT, [])).toEqual({ open: false })
    expect(await rig({ stored: { id: ID, machine: null, deskCommand: 'ssh {host}' } }).desk.available(HUB_EVENT, [])).toEqual({ open: false })
    expect(await rig({ base: null }).desk.available(HUB_EVENT, [])).toEqual({ open: false })
  })

  it('uses no press and reads nothing from the hub', async () => {
    const r = rig()
    await r.desk.available(HUB_EVENT, [])
    expect([r.gestures, r.fetches]).toEqual([[], []])
  })
})

// ── the real writer ──────────────────────────────────────────────────────────────

describe('createDeskOpen with the real private writer', () => {
  const mode = (p: string) => statSync(p).mode & 0o777

  it('writes desk-<16 hex>.command at 0700 in a 0700 desk-open folder, with exactly the script', async () => {
    const dir = join(scratchDir('desk-open-w-'), 'hub', 'desk-open')
    const r = rig({ writeScript: 'real', scriptDir: dir })
    expect(await r.press()).toEqual({ ok: true })
    const names = readdirSync(dir)
    expect(names).toEqual(['desk-0000000000000000.command'])
    expect(DESK_SCRIPT.test(names[0]!)).toBe(true)
    const file = join(dir, names[0]!)
    expect([mode(file), mode(dir)]).toEqual([0o700, 0o700])
    expect(readFileSync(file, 'utf8')).toBe(deskScript('/bin/zsh', fillDeskCommand(COMMAND, 'my-desk')!))
    expect(r.runs).toEqual([['/usr/bin/open', '-b', 'com.apple.Terminal', '--', file]])
  })

  it('never writes over a file already at its name (O_EXCL), nor through a link there', async () => {
    const dir = join(scratchDir('desk-open-w-'), 'desk-open')
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, 'desk-0000000000000000.command'), 'theirs')
    const r = rig({ writeScript: 'real', scriptDir: dir })
    expect(await r.press()).toEqual({ ok: false, reason: 'failed' })
    expect(readFileSync(join(dir, 'desk-0000000000000000.command'), 'utf8')).toBe('theirs')
    const victim = join(dir, '..', 'victim')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, join(dir, 'desk-0000000000000001.command'))
    expect(await r.press()).toEqual({ ok: false, reason: 'failed' })
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(r.runs).toEqual([])
  })

  it('refuses a desk-open folder that is a symlink', async () => {
    const base = scratchDir('desk-open-w-')
    const target = join(base, 'elsewhere')
    mkdirSync(target)
    const dir = join(base, 'desk-open')
    symlinkSync(target, dir)
    const r = rig({ writeScript: 'real', scriptDir: dir })
    expect(await r.press()).toEqual({ ok: false, reason: 'failed' })
    expect(readdirSync(target)).toEqual([])
  })

  it('tightens a folder that is too open', async () => {
    const dir = join(scratchDir('desk-open-w-'), 'desk-open')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    expect(await rig({ writeScript: 'real', scriptDir: dir }).press()).toEqual({ ok: true })
    expect(mode(dir)).toBe(0o700)
  })

  it('sweeps only its own day-old scripts: not fresh ones, not chat resume’s, not links or folders', async () => {
    const base = scratchDir('desk-open-w-')
    const dir = join(base, 'desk-open')
    mkdirSync(dir, { mode: 0o700 })
    const r = rig({ writeScript: 'real', scriptDir: dir })
    const nowMs = Date.now()
    r.state.clock = nowMs
    const old = (p: string) => utimesSync(p, new Date(nowMs - SCRIPT_KEEP_MS - 60_000), new Date(nowMs - SCRIPT_KEEP_MS - 60_000))
    const stale = join(dir, `desk-${'1'.repeat(16)}.command`)
    const fresh = join(dir, `desk-${'2'.repeat(16)}.command`)
    const chat = join(dir, scriptName('claude', '00000000-0000-4000-8000-000000000001', 'a'.repeat(16)))
    const foreign = join(dir, 'notes.txt')
    const folder = join(dir, `desk-${'3'.repeat(16)}.command`)
    const link = join(dir, `desk-${'4'.repeat(16)}.command`)
    writeFileSync(stale, 'old')
    writeFileSync(fresh, 'new')
    writeFileSync(chat, 'chat')
    writeFileSync(foreign, 'theirs')
    mkdirSync(folder)
    const target = join(base, 'target')
    writeFileSync(target, 'kept')
    symlinkSync(target, link)
    for (const p of [stale, chat, foreign, folder, target]) old(p)
    // the clock moves 2 seconds before the open; still well within the day
    expect(await r.press()).toEqual({ ok: true })
    expect([existsSync(stale), existsSync(fresh), existsSync(chat), existsSync(foreign), existsSync(folder), lstatSync(link).isSymbolicLink()])
      .toEqual([false, true, true, true, true, true])
    expect(readFileSync(target, 'utf8')).toBe('kept')
  })
})

describe('the source', () => {
  const code = readFileSync(join(import.meta.dirname, '..', 'electron', 'desk-open.cjs'), 'utf8')

  it('fetches nothing itself, runs nothing itself, and shares chat resume’s writer instead of copying it', () => {
    expect(code).not.toMatch(/globalThis\.fetch|(?<![.\w])fetch\(|child_process|execFile|spawn\(|console\./)
    expect(code).toContain("const { shellWord, writePrivateScript } = require('./chat-resume.cjs')")
    expect(code).not.toMatch(/openSync|O_EXCL|O_NOFOLLOW|unlinkSync/)
  })
})
