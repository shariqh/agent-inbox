// Type declarations for terminal-launch.cjs (issue #586). Runtime lives in the .cjs.
export type TerminalId = 'terminal' | 'iterm2'
export type TerminalKind = 'folder' | 'script'

export const TERMINAL_IDS: readonly TerminalId[]
export const TERMINALS: Readonly<Record<TerminalId, Readonly<{ name: 'Terminal' | 'iTerm2'; bundleId: string }>>>

/** The id a setting value names; anything off the fixed list, or nothing, is 'terminal'. */
export function terminalId(value: unknown): TerminalId
export function terminalName(value: unknown): 'Terminal' | 'iTerm2'

export interface TerminalCommand {
  file: '/usr/bin/open'
  args: string[]
}

/** null unless `kind` is known and `target` is an absolute path with no control characters. */
export function terminalCommand(terminal: unknown, kind: unknown, target: unknown): TerminalCommand | null

/** What a runner reports: `missing` when the app was not found, `timedOut` when the runner killed it. */
export interface TerminalRun {
  ok: boolean
  missing?: boolean
  timedOut?: boolean
}

/** The runner's report for an execFile callback's error (null when it succeeded). */
export function runOutcome(error: { code?: unknown; killed?: unknown; signal?: unknown } | null | undefined): TerminalRun

export interface TerminalOpen {
  ok: boolean
  /** the app the last attempt used */
  used: TerminalId
  /** the app that could not be found, when Terminal was opened instead */
  fellBackFrom: TerminalId | null
  /** the last attempt was killed by the runner's timeout */
  timedOut: boolean
}

export function openInTerminal(options: {
  terminal: unknown
  kind: unknown
  target: unknown
  /** a throw or rejection counts as a failure that is not `missing` */
  run: (command: TerminalCommand) => Promise<TerminalRun>
}): Promise<TerminalOpen>
