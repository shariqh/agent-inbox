// Issue #412, step 2 — the driver's terminal: what the human reads and types,
// and how the process's signals stop a session. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §4.3 and §7.
//
// Every string written to the terminal goes through ONE writer that makes
// agent-controlled text visible (terminalSafe): a tool title, command, kind,
// input, agent text or error message can carry ESC sequences that erase the
// real ask and print a fake one, OSC 52 clipboard writes, or bidi and invisible
// characters that reorder or hide text. The only raw bytes this module writes
// are the SGR reset before each ask.
import type { AskView, DriverUi } from './driver.js'
import { terminalSafe } from './driver-policy.js'

/** Resets colours and attributes a previous write may have left on. */
const SGR_RESET = '\u001b[0m'

export interface Terminal {
  ui: DriverUi
  /** Writes a line of the driver's own (still through the sanitizer). */
  print(text: string): void
  /** The human typed a line: an answer to the open ask, or a command. */
  line(text: string): void
  /** The terminal is gone (an `EIO`, a hang-up): every later write is a no-op. */
  silence(): void
}

export function createTerminal(opts: {
  write: (text: string) => void
  answer: (askId: string, approve: boolean) => void
  stop: () => void
  interrupt: () => void
}): Terminal {
  // a write to a terminal that has gone must never throw into the driver's
  // cleanup; once one fails, the terminal is silent for good
  let dead = false
  const raw = (text: string) => {
    if (dead) return
    try {
      opts.write(text)
    } catch {
      dead = true
    }
  }
  const write = (text: string) => raw(terminalSafe(text))
  const asks: AskView[] = []
  const showAsk = () => {
    const ask = asks[0]
    if (!ask) return
    raw(SGR_RESET)
    write(`\n\n── ${ask.title}\n${ask.detail}\n`)
    write(ask.kind === 'plan'
      ? 'Approve the plan and let the agent carry it out? [y/N] '
      : 'Allow once? Declining stops the agent’s current turn. [y/N] ')
  }
  const ui: DriverUi = {
    ask(ask) {
      asks.push(ask)
      if (asks.length === 1) showAsk()
    },
    settled(askId, outcome) {
      const index = asks.findIndex((a) => a.id === askId)
      if (index === -1) return
      asks.splice(index, 1)
      write(`${outcome}\n`)
      if (index === 0) showAsk()
    },
    text(chunk) { write(chunk) },
    notice(text) { write(`\n[agent-inbox] ${text}\n`) },
  }
  return {
    ui,
    print: write,
    silence() { dead = true },
    line(text) {
      const answer = text.trim().toLowerCase()
      const ask = asks[0]
      if (ask) {
        opts.answer(ask.id, answer === 'y' || answer === 'yes')
        return
      }
      if (answer === 'stop') opts.stop()
      else if (answer === 'interrupt') opts.interrupt()
      else if (answer) ui.notice('Type "interrupt" to interrupt the running turn and send queued messages, or "stop" to end the session.')
    },
  }
}

/**
 * Stops the session on Ctrl-C, SIGHUP (the terminal closed), SIGTERM and the
 * end of the terminal's input, through the driver's ordered stop. A hang-up
 * silences the terminal first and prints nothing: a write to a closed terminal
 * fails with EIO. A second Ctrl-C, or a stop that has not finished within
 * `boundMs`, forces it: the driver's synchronous cleanup runs, then `exit`.
 */
export function installStopHandlers(opts: {
  signals: { on(signal: 'SIGINT' | 'SIGHUP' | 'SIGTERM', handler: () => void): unknown }
  input: { on(event: 'close', handler: () => void): unknown }
  driver: { stop(): void; forceStop(): void; isFinished(): boolean }
  exit: (code: number) => void
  notice: (text: string) => void
  silence: () => void
  boundMs?: number
}): void {
  let stopping = false
  const force = (code: number) => {
    opts.driver.forceStop()
    opts.exit(code)
  }
  const tell = (text: string) => {
    try {
      opts.notice(text)
    } catch { /* the terminal is gone; the stop goes on */ }
  }
  const stop = (why: string | null, code: number) => {
    if (stopping || opts.driver.isFinished()) return
    stopping = true
    opts.driver.stop()
    if (why) tell(why)
    const timer = setTimeout(() => {
      if (!opts.driver.isFinished()) force(code)
    }, opts.boundMs ?? 15_000)
    timer.unref()
  }
  let interrupts = 0
  opts.signals.on('SIGINT', () => {
    // the second Ctrl-C forces, even after the driver finished: a child that
    // ignores its closed stdin still has to go (forceStop signals it)
    if (++interrupts === 1 && !opts.driver.isFinished()) return stop('Stopping the session… (Ctrl-C again to force)', 130)
    if (interrupts === 1) return tell('Waiting for Copilot to exit… (Ctrl-C again to force)')
    force(130)
  })
  opts.signals.on('SIGHUP', () => {
    opts.silence()
    stop(null, 129)
  })
  opts.signals.on('SIGTERM', () => stop('Asked to terminate: stopping the session.', 143))
  opts.input.on('close', () => stop('The terminal’s input ended: stopping the session.', 1))
}

/**
 * The CLI's forced exit, after `forceStop` sent SIGTERM: wait synchronously up
 * to `graceMs` for the child's process group to go, then SIGKILL it. Every
 * effect is injected, so it is tested without a process.
 */
export function reapProcessGroup(pgid: number, io: {
  kill: (pid: number, signal: NodeJS.Signals | 0) => void
  sleep: (ms: number) => void
  graceMs?: number
}): 'gone' | 'killed' {
  const alive = () => {
    try {
      io.kill(-pgid, 0)
      return true
    } catch {
      return false
    }
  }
  const grace = io.graceMs ?? 2000
  for (let waited = 0; waited < grace && alive(); waited += 50) io.sleep(50)
  if (!alive()) return 'gone'
  try {
    io.kill(-pgid, 'SIGKILL')
  } catch { /* gone in between */ }
  return 'killed'
}
