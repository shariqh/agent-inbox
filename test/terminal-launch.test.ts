// Terminal of choice (#586): the argv for each terminal and kind, the setting's
// fixed list, and the one fallback to Terminal.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import launch from '../electron/terminal-launch.cjs'

const { TERMINAL_IDS, TERMINALS, openInTerminal, runOutcome, terminalCommand, terminalId, terminalName } = launch
const SCRIPT = '/hub/launches/0d1f8a52-1111-4222-8333-444455556666/take-over.command'
const ITERM = 'com.googlecode.iterm2'
const bundleOf = (command: { args: string[] }) => command.args[1]

describe('Terminal of choice (#586)', () => {
  it('builds open -b argv for Terminal for a folder and a script', () => {
    expect(terminalCommand('terminal', 'folder', '/w/a b')).toEqual({ file: '/usr/bin/open', args: ['-b', 'com.apple.Terminal', '--', '/w/a b'] })
    expect(terminalCommand('terminal', 'script', SCRIPT)).toEqual({ file: '/usr/bin/open', args: ['-b', 'com.apple.Terminal', '--', SCRIPT] })
  })

  it('builds open -b argv for iTerm2 for a folder and a script', () => {
    expect(terminalCommand('iterm2', 'folder', '/w/a b')).toEqual({ file: '/usr/bin/open', args: ['-b', ITERM, '--', '/w/a b'] })
    expect(terminalCommand('iterm2', 'script', SCRIPT)).toEqual({ file: '/usr/bin/open', args: ['-b', ITERM, '--', SCRIPT] })
  })

  it('reads an unknown or missing setting as Terminal', () => {
    for (const value of [undefined, null, '', 'iTerm2', 'Terminal', 'hyper', '__proto__', 'constructor', 'toString', {}, 1, ['iterm2']]) {
      expect(terminalId(value)).toBe('terminal')
      expect(terminalName(value)).toBe('Terminal')
      expect(terminalCommand(value, 'folder', '/w')?.args[1]).toBe('com.apple.Terminal')
    }
    expect(terminalId('iterm2')).toBe('iterm2')
    expect(terminalName('iterm2')).toBe('iTerm2')
  })

  it('refuses a relative, empty, non-string or control-character path and an unknown kind', () => {
    for (const target of ['w/a', '', 42, null, '/w/a\nb', '/w/\u0000', '/w/\u007f']) expect(terminalCommand('terminal', 'folder', target)).toBeNull()
    expect(terminalCommand('terminal', 'shell', '/w')).toBeNull()
    expect(terminalCommand('terminal', undefined, '/w')).toBeNull()
    expect(terminalCommand('terminal', '__proto__', '/w')).toBeNull()
  })

  it('opens the chosen terminal once and does not fall back when it works', async () => {
    const seen: string[] = []
    const result = await openInTerminal({ terminal: 'iterm2', kind: 'script', target: SCRIPT, run: async (c) => { seen.push(bundleOf(c)); return { ok: true } } })
    expect(seen).toEqual([ITERM])
    expect(result).toEqual({ ok: true, used: 'iterm2', fellBackFrom: null, timedOut: false })
  })

  it('falls back to Terminal once when iTerm2 cannot be found', async () => {
    const seen: string[] = []
    const result = await openInTerminal({
      terminal: 'iterm2', kind: 'folder', target: '/w',
      run: async (c) => { seen.push(bundleOf(c)); return bundleOf(c) === ITERM ? { ok: false, missing: true } : { ok: true } },
    })
    expect(seen).toEqual([ITERM, 'com.apple.Terminal'])
    expect(result).toEqual({ ok: true, used: 'terminal', fellBackFrom: 'iterm2', timedOut: false })
  })

  it('opens nothing else after a timeout, so a script is never run twice', async () => {
    const seen: string[] = []
    const result = await openInTerminal({ terminal: 'iterm2', kind: 'script', target: SCRIPT, run: async (c) => { seen.push(bundleOf(c)); return { ok: false, timedOut: true } } })
    expect(seen).toEqual([ITERM])
    expect(result).toEqual({ ok: false, used: 'iterm2', fellBackFrom: null, timedOut: true })
  })

  it('does not fall back after a failure that is not a missing app', async () => {
    const seen: string[] = []
    const result = await openInTerminal({ terminal: 'iterm2', kind: 'folder', target: '/w', run: async (c) => { seen.push(bundleOf(c)); return { ok: false } } })
    expect(seen).toEqual([ITERM])
    expect(result.ok).toBe(false)
    expect(result.fellBackFrom).toBeNull()
  })

  it('does not retry Terminal itself', async () => {
    const seen: string[] = []
    const run = async (c: { args: string[] }) => { seen.push(bundleOf(c)); return { ok: false, missing: true } }
    expect(await openInTerminal({ terminal: 'terminal', kind: 'folder', target: '/w', run })).toEqual({ ok: false, used: 'terminal', fellBackFrom: null, timedOut: false })
    expect(seen).toEqual(['com.apple.Terminal'])
    seen.length = 0
    expect(await openInTerminal({ terminal: 'iterm2', kind: 'folder', target: '/w', run })).toEqual({ ok: false, used: 'terminal', fellBackFrom: 'iterm2', timedOut: false })
    expect(seen).toEqual([ITERM, 'com.apple.Terminal'])
  })

  it('treats a runner that throws or rejects, or answers nonsense, as a failure', async () => {
    for (const run of [async () => { throw new Error('x') }, () => { throw new Error('x') }, async () => true, async () => undefined, async () => ({ ok: 'yes' })]) {
      const result = await openInTerminal({ terminal: 'terminal', kind: 'folder', target: '/w', run: run as never })
      expect(result.ok).toBe(false)
    }
  })

  it('runs nothing for a refused path or kind', async () => {
    let runs = 0
    const run = async () => { runs += 1; return { ok: true } }
    expect(await openInTerminal({ terminal: 'iterm2', kind: 'folder', target: 'relative', run })).toEqual({ ok: false, used: 'iterm2', fellBackFrom: null, timedOut: false })
    expect(await openInTerminal({ terminal: 'Hyper', kind: 'nope', target: '/w', run })).toMatchObject({ ok: false, used: 'terminal' })
    expect(runs).toBe(0)
  })

  it('maps an open that exited to missing, a killed one to timedOut, and success to ok', () => {
    expect(runOutcome(null)).toEqual({ ok: true })
    expect(runOutcome({ code: 1, killed: false, signal: null })).toEqual({ ok: false, missing: true })
    expect(runOutcome({ code: null, killed: true, signal: 'SIGTERM' })).toEqual({ ok: false, timedOut: true })
    expect(runOutcome({ code: 1, killed: true, signal: 'SIGTERM' })).toEqual({ ok: false, timedOut: true })
    expect(runOutcome({ code: 'ENOENT' })).toEqual({ ok: false })
  })

  it('names apps by bundle id only and builds no shell string', () => {
    for (const id of TERMINAL_IDS) {
      const command = terminalCommand(id, 'script', SCRIPT)
      expect(command?.args.every((arg) => typeof arg === 'string')).toBe(true)
      expect(command?.args.slice(0, 2)).toEqual(['-b', TERMINALS[id].bundleId])
      expect(command?.args[2]).toBe('--')
    }
    const source = readFileSync(new URL('../electron/terminal-launch.cjs', import.meta.url), 'utf8')
    for (const banned of ["'-a'", 'shell:', 'osascript', 'spawn', 'exec(']) expect(source.replace(/^\/\/.*$/gm, '')).not.toContain(banned)
    expect(Object.isFrozen(TERMINAL_IDS)).toBe(true)
    expect(Object.isFrozen(TERMINALS)).toBe(true)
    expect(Object.isFrozen(TERMINALS.iterm2)).toBe(true)
    expect(TERMINAL_IDS).toEqual(['terminal', 'iterm2'])
  })
})
