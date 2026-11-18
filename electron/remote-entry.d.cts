// Type declarations for electron/remote-entry.cjs (#617, PR 2c): the hub's remote-entry
// controller for the desktop app's main process. Runtime lives in the .cjs (and its read-only
// Tailscale half in electron/remote-tailscale.cjs, which remote-entry.cjs re-exports).
import type { UpdatePreferencesFs } from './update-preferences.cjs'

/** The removal command the panel shows (from Tailscale's documentation, not yet seen in real output). */
export const REMOVAL_HINT: 'tailscale serve --https=443 off'
/** The only places the Tailscale command line is looked for, in order. */
export const TAILSCALE_PATHS: readonly string[]
/** The only two argument lists this module ever runs. */
/** The only three argument lists ever run: this node without its peers, Serve, and the full peer list. */
export const TAILSCALE_ARGS: { readonly self: readonly string[]; readonly serve: readonly string[]; readonly peers: readonly string[] }

/** `remote.json` beside the hub database: the folder of AGENT_INBOX_DB, else ~/.agent-inbox. */
export function remoteFile(env?: Record<string, string | undefined>, home?: string): string
/** The first fixed path that exists, else null. Never PATH. */
export function tailscaleCli(exists?: (path: string) => boolean): string | null

export type SelfReason = 'no_cli' | 'failed' | 'not_json' | 'not_running' | 'no_dns_name' | 'bad_host' | 'tagged' | 'no_login'
export type TailnetSelf = { ok: true; host: string; login: string } | { ok: false; reason: SelfReason }
export function parseTailnetSelf(text: string): TailnetSelf

export type ServeReason =
  | 'unreadable' | 'bad_request' | 'unknown_shape' | 'foreground' | 'services' | 'funnel' | 'tcp_forward'
  | 'other_proxy' | 'duplicate_host' | 'no_handler' | 'other_path' | 'handler_fields' | 'wrong_target' | 'not_https'
export type ServeAnswer = { ok: true } | { ok: false; reason: ServeReason; present: boolean }
export function parseServeStatus(text: string, host: string, port: number): ServeAnswer

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; encoding: 'utf8'; shell: false; windowsHide: true },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown

export interface RemoteDeviceView { id: string; label: string; pairedAt: string | null }

export type RemoteProblem =
  | 'unsupported' | 'unreadable' | 'not_regular' | 'not_owner' | 'open_to_others' | 'too_large' | 'not_json'
  | 'not_object' | 'no_schema' | 'newer_schema' | 'bad_host' | 'bad_logins' | 'bad_port' | 'bad_devices' | 'other_viewer'

export interface RemoteView {
  available: boolean
  enabled: boolean
  host: string | null
  port: number
  viewerPort: number
  logins: string[]
  devices: RemoteDeviceView[]
  /** device entries the viewer's reader drops (they still count toward its limit of 16) */
  unreadableDevices: number
  problem: RemoteProblem | null
}

export type WriteReason =
  | RemoteProblem | 'missing' | 'bad_id' | 'bad_file' | 'too_large_to_write' | 'not_serialisable' | 'port_clash' | 'write_failed' | 'not_needed' | 'failed'
/** `voidedCode`: a code main asked for in the last 10 minutes was pending, and this write voided it. */
/** `unknownFieldsDropped`: only turnOff, when the document could not be written back (an unknown field nested too deep). */
export type WriteResult = { ok: true; view: RemoteView; voidedCode: boolean; unknownFieldsDropped?: true } | { ok: false; reason: WriteReason }
export type RepairResult = { ok: true; view: RemoteView; voidedCode: boolean; devicesRemoved: number } | { ok: false; reason: WriteReason }
export type RemoveResult = { ok: true; view: RemoteView; voidedCode: boolean; droppedEntries: number } | { ok: false; reason: WriteReason }
export type TurnOnResult =
  | { ok: true; view: RemoteView; voidedCode: boolean; devicesRemoved: number; droppedEntries: number }
  | { ok: false; reason: WriteReason | SelfReason | ServeReason; step: 'file' | 'self' | 'serve' }

export interface EntryStatus {
  on: boolean
  listening: boolean
  port: number | null
  host: string | null
  error: string | null
  codePending: boolean
  /** the last 16 pairings: the device's id and the id of the code it used */
  paired: Array<{ device: string; codeId: string }>
  refused: Record<'host' | 'funnel' | 'login' | 'path' | 'origin' | 'device' | 'route' | 'pair', number>
}

export type CodeResult =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; reason: 'off' | 'no_owner_token' | 'not_listening' | 'refused' | 'unreachable' | 'bad_answer' | 'failed' }

export type SelfTestResult =
  | { ok: true }
  | { ok: false; reason: 'off' | 'no_status' | 'unreachable' | 'not_refused' | 'no_device_count'; rose: string | null }

export interface RemoteWatchState {
  view: RemoteView
  serve: { answer: ServeAnswer; at: number } | null
  /** never the login: only whether it is one the file allows */
  self: { ok: true; host: string; loginAllowed: boolean; at: number } | { ok: false; reason: SelfReason; at: number } | null
  flag: boolean
  /** the digest of the flagged state; pass it to acknowledge() */
  flagDigest: string | null
  stopped: { reason: string; at: number; off: boolean } | null
  removalHint: string | null
}

export interface RemoteEntryController {
  readonly file: string
  readonly port: number
  readonly viewerPort: number
  tailnetSelf(): Promise<TailnetSelf>
  serveState(host: string, port: number): Promise<ServeAnswer>
  view(): Promise<RemoteView>
  turnOn(): Promise<TurnOnResult>
  turnOff(): Promise<WriteResult>
  removeDevice(id: unknown): Promise<RemoveResult>
  /** the one explicit repair: a file with group or other bits is rewritten 0600, off, with no devices */
  repairPermissions(): Promise<RepairResult>
  requestCode(): Promise<CodeResult>
  entryStatus(): Promise<{ ok: true; status: EntryStatus } | { ok: false; reason: 'unreachable' | 'bad_status' | 'bad_shape' }>
  selfTest(): Promise<SelfTestResult>
  start(): void
  stop(): void
  tick(): Promise<void>
  refresh(): Promise<void>
  state(): Promise<RemoteWatchState>
  /** accepts the flagged state only when the file still has this digest */
  acknowledge(digest: unknown): Promise<{ ok: true } | { ok: false; reason: 'bad_digest' | 'changed' | 'failed' }>
}

export function createRemoteEntry(options: {
  isPackaged: boolean
  env?: Record<string, string | undefined>
  home?: string
  /** override the computed ports (tests; main passes neither) */
  port?: number
  viewerPort?: number
  ownerToken?: string
  fsImpl?: UpdatePreferencesFs & { open: (...args: never[]) => Promise<unknown> }
  uid?: number
  execFile?: ExecFileLike
  exists?: (path: string) => boolean
  fetch?: (url: string, init: Record<string, unknown>) => Promise<Response>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  onStopped?: (reason: string, detail: { off: boolean }) => void
  onPaired?: (label: string) => void
  onOutsideChange?: () => void
}): RemoteEntryController
