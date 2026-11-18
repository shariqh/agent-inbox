// Type declarations for electron/remote-connect.cjs (#617, PR 3a): connect mode on the connecting
// Mac, for the desktop app's main process. Runtime lives in the .cjs, and its pure rules in
// electron/remote-connect-rules.cjs, which remote-connect.cjs re-exports in part.

/** The request header that carries the device secret. Only main sets it, only for the hub's origin. */
export const DEVICE_HEADER: 'X-Agent-Inbox-Device'

export type AddressAnswer = { ok: true; origin: string; host: string } | { ok: false; reason: 'bad_address' }
/** `https://<host>` (or a bare host): no user, port, path, query or fragment; the host lowercased, never an IP address. */
export function parseHubOrigin(text: unknown): AddressAnswer
/** The hub's code rule (normaliseCode in src/remote-pair.ts): 10 Crockford characters, or null. */
export function normaliseCode(text: unknown): string | null
/** The hub's device label rule (isDeviceLabel in src/remote-pair.ts). */
export function isDeviceLabel(value: unknown): value is string
/** This Mac's name on the hub, from its host name; `Mac` when nothing usable is left. */
export function deviceLabelFor(name: unknown): string
/** The hub's name on this Mac: its machine, else the first label of its address; at most 40 characters. */
export function hubLabelFor(machine: unknown, host: string): string
/** The mesh rule (inTailnet in src/mesh-config.ts). */
export function inTailnet(host: string, suffix: string | undefined): boolean
/** The mesh command line's rule (its suffixFrom). */
export function suffixFrom(json: string): string | undefined
/** Whether a fetch failure is a certificate the TLS check refused. */
export function certificateFailure(error: unknown): boolean

export type HubReason =
  | 'no_cli' | 'failed' | 'not_running' | 'tagged_self' | 'not_in_tailnet' | 'not_found' | 'duplicate_name' | 'not_your_device' | 'tagged_device'
export type HubAnswer = { ok: true; node: string } | { ok: false; reason: HubReason }
/** The hub among this Mac's peers in `tailscale status --json`. */
export function parsePeers(text: string, host: string): HubAnswer

export type ConnectReason =
  | 'unsupported' | 'no_keychain' | 'bad_address' | 'bad_code' | 'newer_schema' | 'bad_file' | 'hub_exists' | HubReason
  | 'unreachable' | 'bad_certificate' | 'not_agent_inbox' | 'refused' | 'write_failed' | 'too_large'
export type ConnectionState = 'online' | 'retrying' | 'refused'
export type Connection =
  | { mode: 'local' }
  | { mode: 'hub'; id: string; label: string; state: ConnectionState; reason: string | null; version: string | null }

export type ConnectAnswer =
  | { ok: true; id: string; label: string; state: ConnectionState; reason: string | null }
  | { ok: false; reason: ConnectReason | 'failed'; pairedOnHub?: true }

export type ProbeAnswer =
  | { ok: true; state: 'online' | 'refused' | 'unreachable' | 'not_agent_inbox'; version: string | null; machine: string | null }
  | { ok: false; reason: string }

export type StoreProblem = 'unreadable' | 'too_large' | 'not_json' | 'bad_schema' | 'newer_schema' | 'bad_entry'
export interface ConnectView {
  available: boolean
  keychain: boolean
  hub: { id: string; label: string; origin: string; machine: string | null; state: ConnectionState | null; reason: string | null } | null
  problem: StoreProblem | null
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(blob: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface RemoteConnectOptions {
  filePath?: string
  app?: { getPath(name: 'userData'): string }
  fsImpl?: unknown
  execFile?: unknown
  exists?: (path: string) => boolean
  fetch?: unknown
  safeStorage?: SafeStorageLike | unknown
  platform?: string
  hostname?: () => string
  now?: () => number
  randomBytes?: (size: number) => Buffer
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** Called once when /api/version's `current` differs from the last online probe's. */
  onReload?: () => void
}

export interface RemoteConnect {
  readonly file: string
  findHub(host: unknown): Promise<HubAnswer | { ok: false; reason: 'failed' }>
  connect(input: unknown): Promise<ConnectAnswer>
  forget(id: unknown): Promise<{ ok: true } | { ok: false; reason: string }>
  probeHub(): Promise<ProbeAnswer>
  view(): Promise<ConnectView>
  connection(): Connection
  /** Called with the new answer each time it changes; returns the unsubscribe function. */
  onConnection(callback: unknown): () => void
  start(): Promise<void>
  stop(): void
  kick(): Promise<void>
  tick(): Promise<void>
  /** The device header's value for a request to `url`, or null. Synchronous. */
  deviceHeaderFor(url: unknown): string | null
  /** A fetch for main's own requests to the hub: refuses any other origin, adds the header, no redirect, a timeout. */
  hubFetch(): (input: unknown, init?: RequestInit) => Promise<Response>
}

export function createRemoteConnect(options?: RemoteConnectOptions): RemoteConnect
