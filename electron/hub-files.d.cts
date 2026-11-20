// Type declarations for electron/hub-files.cjs (#634): a card's file on the connected hub, fetched by
// main, saved as a private copy and opened on this Mac. Runtime lives in the .cjs.

export type HubFileReason =
  | 'unavailable' | 'bad_request' | 'no_gesture' | 'busy' | 'unreachable' | 'old_hub' | 'refused'
  | 'not_linked' | 'not_a_document' | 'too_large' | 'not_found' | 'unreadable' | 'failed' | 'open_failed'
export type HubFileResult = { ok: true } | { ok: false; reason: HubFileReason }
export interface HubFileRequest { kind: 'item' | 'row'; id: string; path: string }

/** The hub's list of document extensions (src/remote-file.ts), lowercase with the dot. */
export const DOCUMENT_EXTENSIONS: readonly string[]
/** The hub's allowed roots besides `~/` (src/remote-file.ts ALLOWED_ROOTS). */
export const ALLOWED_ROOTS: readonly string[]
/** The first version whose hub serves GET /api/remote/file: a 403 from an older hub is `old_hub`. */
export const FILES_FROM: string
/** The largest file fetched, in bytes (25 MB). */
export const FILE_MAX: number
/** How long a copy is kept before an open sweeps it. */
export const KEEP_MS: number
export const REASONS: readonly HubFileReason[]

/** A name ending in a listed extension, compared without case. */
export function documentName(name: unknown): boolean
/** The hub's path rule: absolute or `~/`, no control character, no empty, `.` or `..` segment, at most 4,096 characters. */
export function linkedPathForm(value: unknown): boolean
/** The cleaned last segment a copy is saved under, or null when it has no listed extension. */
export function copyName(filePath: unknown): string | null
/** Whether any segment starts with `.` (a hidden file or folder). */
export function hiddenPath(filePath: string): boolean
/** The hub's servablePath: the form rule, `~/` or an allowed root, a listed name, no hidden segment. */
export function servablePath(filePath: string): boolean
/** `{ kind, id, path }` from exactly `[{ kind, id, path }]` with a path by the hub's form rule, or null. */
export function fileRequest(args: unknown): HubFileRequest | null
/** Removes copies older than a day under `root` (ours only, never through a link) and the folders left empty. */
export function sweepCopies(root: string, nowMs: number): void

export interface HubFiles {
  available(event: unknown, args: unknown[]): Promise<{ files: boolean }>
  open(event: unknown, args: unknown[]): Promise<HubFileResult>
}

export function createHubFiles(options: {
  platform: string
  hubView: () => { trusts(event: unknown): 'hub' | 'offline' | null; takeGesture(event: unknown): string | null } | null
  connect: () => {
    connection(): Record<string, unknown>
    hubBase(id: string): string | null
    hubFetch(): (url: string, init?: { method?: string; timeoutMs?: number }) => Promise<Response>
  } | null
  /** the hub-files folder beside the local database */
  dir: string
  /** electron/link-open.cjs openHubCopy for this folder: `{ ok: true }` when the copy opened */
  openCopy: (file: string) => Promise<{ ok: boolean; reason?: string }>
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
  log?: (line: string) => void
}): HubFiles
