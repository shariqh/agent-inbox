// Type declarations for electron/desk-open.cjs (#617, PR 4b): Open desk, a session's tmux desk on the
// connected hub opened in this Mac's terminal. Runtime lives in the .cjs.
import type { TerminalCommand, TerminalRun } from './terminal-launch.cjs'

export type DeskOpenReason =
  | 'unavailable' | 'bad_request' | 'no_gesture' | 'busy' | 'no_command' | 'unreachable' | 'not_found' | 'no_desk' | 'not_on_hub' | 'failed'
  | 'terminal_failed'
export type DeskOpenResult = { ok: true; notice?: string } | { ok: false; reason: DeskOpenReason }

/** The hub's activity body read for one open is at most this many bytes. */
export const ACTIVITY_MAX: number
/** `desk-<16 hex>.command`: the only names this module writes or sweeps. */
export const DESK_SCRIPT: RegExp
/** The desk the confirmation dialog fills the command for. */
export const EXAMPLE_DESK: 'example-desk'
export const REASONS: readonly DeskOpenReason[]
/** A session id the page may name: `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`. */
export const SESSION: RegExp

/** The template filled for `desk`: `{desk}` bare, `{attach}` as one shell word; null unless both pass their rules. */
export function fillDeskCommand(template: unknown, desk: unknown): string | null
/** The native confirmation's message, detail (the command filled for the example desk) and buttons; null for an invalid command. */
export function deskConfirmation(command: unknown): { message: string; detail: string; buttons: ['Save', 'Cancel'] } | null
/** `shell` when absolute, free of control characters and listed in `shells` (the text of /etc/shells); else /bin/zsh. */
export function loginShell(shell: unknown, shells: unknown): string
/** The script's whole text: `#!/bin/sh`, a comment, `exec '<shell>' -l -i -c '<command>'`. */
export function deskScript(shell: string, command: string): string
/** The session from exactly `[{ session }]`, or null. */
export function deskRequest(args: unknown): string | null

export interface DeskOpen {
  available(event: unknown, args: unknown[]): Promise<{ open: boolean }>
  open(event: unknown, args: unknown[]): Promise<DeskOpenResult>
}

export function createDeskOpen(options: {
  platform: string
  hubView: () => { trusts(event: unknown): 'hub' | 'offline' | null; takeGesture(event: unknown): string | null } | null
  storedHub: () => Promise<{ id: string; machine: string | null; deskCommand: string | null } | null>
  hubFetch: () => (input: unknown, init?: RequestInit) => Promise<Response>
  hubBase: (id: string) => string | null
  scriptDir: string
  terminal: { read(): Promise<unknown>; run(command: TerminalCommand): Promise<TerminalRun> }
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
  /** os.userInfo().shell */
  userShell?: () => unknown
  /** the text of /etc/shells */
  readShells?: () => unknown
  writeScript?: (dir: string, name: string, text: string) => string | null
  log?: (line: string) => void
}): DeskOpen
