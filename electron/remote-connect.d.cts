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
/** The hub's name on this Mac: its machine, else (or when the machine reads as `thismac` or `local`, ignoring case, spaces, `-` and `_`) the first label of its address; at most 40 characters. */
export function hubLabelFor(machine: unknown, host: string): string
/** The mesh rule (inTailnet in src/mesh-config.ts). */
export function inTailnet(host: string, suffix: string | undefined): boolean
/** The mesh command line's rule (its suffixFrom). */
export function suffixFrom(json: string): string | undefined
/**
 * The one "is this URL on the hub's origin" decision: a string or `URL`, no user info however
 * written, `https:`, and its parsed origin exactly `origin`. The parsed href, else null.
 */
export function hubHref(url: unknown, origin: unknown): string | null
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
  /** `replacedHub`: a hub was replaced, and this Mac stays paired on it until the device is removed there. */
  | { ok: true; id: string; label: string; state: ConnectionState; reason: string | null; replacedHub?: true }
  /** `forgotten`: forget() removed the new hub during its first probe; `changed`: the store no longer names it. */
  | { ok: false; reason: ConnectReason | 'forgotten' | 'changed' | 'failed'; pairedOnHub?: true }

export type ProbeAnswer =
  | { ok: true; state: 'online' | 'refused' | 'unreachable' | 'not_agent_inbox'; version: string | null; machine: string | null }
  | { ok: false; reason: 'no_hub' | 'stopped' | 'changed' | 'failed' | HubReason | 'node_changed' | 'secret_unreadable' | 'no_keychain' }

/**
 * `bad_file`: a symlink, FIFO, folder, another user's file or one open to group or others;
 * `forget_not_saved`: a forget whose write did not land, so the file still holds that hub.
 */
export type StoreProblem = 'unreadable' | 'bad_file' | 'too_large' | 'not_json' | 'bad_schema' | 'newer_schema' | 'bad_entry' | 'forget_not_saved'
export type ScheduleAnswer = { ok: true } | { ok: false; reason: 'stopped' | 'not_started' | 'failed' }
export interface ConnectView {
  available: boolean
  /**
   * False once the Keychain was needed (a connect, a stored hub) and could not be used. True
   * before anything needed it: view() never asks macOS for the Keychain by itself, because the
   * local page reads it at every start.
   */
  keychain: boolean
  hub: {
    id: string; label: string; origin: string; machine: string | null; state: ConnectionState | null; reason: string | null
    /** #617 PR 4b: the valid stored Open desk command, or null. This Mac's own Settings shows it; it never goes to the hub. */
    deskCommand: string | null
  } | null
  problem: StoreProblem | null
}

/** #617 PR 4b: setDeskCommand's answer. */
export type DeskCommandAnswer =
  | { ok: true }
  | { ok: false; reason: 'bad_request' | 'bad_command' | 'not_found' | 'cancelled' | 'too_large' | 'write_failed' }

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
  /** The user the store must belong to; process.getuid() by default. */
  uid?: number
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
  /**
   * #617 PR 4b: main's native confirmation of an Open desk command (the text to save); true only
   * when the owner pressed Save. Without it no command is ever stored.
   */
  confirmDeskCommand?: (command: string) => Promise<boolean> | boolean
}

export interface RemoteConnect {
  readonly file: string
  findHub(host: unknown): Promise<HubAnswer | { ok: false; reason: 'failed' }>
  connect(input: unknown): Promise<ConnectAnswer>
  forget(id: unknown): Promise<{ ok: true } | { ok: false; reason: string }>
  probeHub(): Promise<ProbeAnswer>
  view(): Promise<ConnectView>
  /**
   * #617 PR 4b: `{ id, command }`. `''` removes the active hub's Open desk command with no question;
   * any other valid command is stored only after confirmDeskCommand answered true.
   */
  setDeskCommand(input: unknown): Promise<DeskCommandAnswer>
  /** #617 PR 4b: the stored active hub's id, machine and valid Open desk command, from the file; null for none. */
  storedHub(): Promise<{ id: string; machine: string | null; deskCommand: string | null } | null>
  connection(): Connection
  /** Called with the new answer each time it changes; returns the unsubscribe function. */
  onConnection(callback: unknown): () => void
  start(): Promise<void>
  /** Ends probing and drops the secret until start(); connect() and forget() still change the store. */
  stop(): void
  kick(): Promise<ScheduleAnswer>
  tick(): Promise<ScheduleAnswer>
  /** The device header's value for a request to `url`, or null. Synchronous. */
  deviceHeaderFor(url: unknown): string | null
  /** A fetch for main's own requests to the hub: refuses any other origin, adds the header, no redirect, a timeout. */
  hubFetch(): (input: unknown, init?: RequestInit) => Promise<Response>
  /** #617 PR 4a: `<origin>/` while `id` is the active hub, else null. From memory: no store read, no Keychain. */
  hubBase(id: unknown): string | null
}

export function createRemoteConnect(options?: RemoteConnectOptions): RemoteConnect
