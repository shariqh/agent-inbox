// Type declarations for electron/link-open.cjs (issue #300). The runtime lives
// in the .cjs; this lets the TS tests and `tsc --noEmit` see its shapes.

export type LinkRequest =
  | { kind: 'web'; url: string }
  | { kind: 'file'; path: string; reveal: boolean }

export type LinkFailure = 'invalid' | 'missing' | 'inaccessible' | 'failed' | 'unavailable' | 'app-missing'
export type RevealReason = 'folder' | 'app' | 'blocked' | 'executable' | 'special'

export type LinkResult =
  | { ok: true; action: 'opened' }
  | { ok: true; action: 'revealed'; reason: RevealReason | 'requested' | 'rule' }
  | { ok: false; reason: LinkFailure }

export type FilePlan =
  | { ok: true; action: 'open'; path: string }
  | { ok: true; action: 'reveal'; path: string; reason: RevealReason }
  | { ok: false; reason: Exclude<LinkFailure, 'unavailable' | 'app-missing'> }

export interface LinkShell {
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

interface Fsp {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; mode: number }>
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>
}

/** Settings → Links (part 2), as electron/link-preferences.cjs reads them. */
export type LinkRule = { handler: 'default' | 'quicklook' | 'reveal' } | { handler: 'app'; app: string }
export interface LinkRules {
  web: { handler: 'default' } | { handler: 'app'; app: string }
  markdown: LinkRule
  types: Array<LinkRule & { extension: string }>
}

export interface SpawnedChild {
  once(event: 'error' | 'exit' | 'spawn', listener: (...args: any[]) => void): unknown
  unref?(): void
}
export type SpawnImpl = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; shell: false; detached: true; windowsHide: true },
) => SpawnedChild

export interface OpenOptions {
  rules?: LinkRules | null
  platform?: string | null
  spawnImpl?: SpawnImpl | null
}

export function externalWebUrl(value: unknown): string | null
export function isViewerUrl(value: unknown, viewerUrl: string): boolean
export function openWebLink(
  value: unknown,
  shell: Pick<LinkShell, 'openExternal'>,
  options?: Omit<OpenOptions, 'rules'> & { readRules?: () => Promise<LinkRules | null> | LinkRules | null; fsp?: Fsp },
): boolean
export function normalizeLocalPath(value: unknown, homeDir: unknown): string | null
export function blockedFileName(value: unknown): boolean
export function fileOpenPlan(value: unknown, deps?: { homeDir?: unknown; fsp?: Fsp }): Promise<FilePlan>
export function linkRequest(value: unknown): LinkRequest | null
export function openLinkRequest(raw: unknown, deps: { shell: LinkShell; homeDir: unknown; fsp?: Fsp } & OpenOptions): Promise<LinkResult>
export function isTrustedLinkSender(input: {
  sender: unknown
  senderFrame: { url: string; parent: unknown } | null | undefined
  window: { isDestroyed(): boolean; webContents: { isDestroyed(): boolean } } | null | undefined
  viewerUrl: string
}): boolean
