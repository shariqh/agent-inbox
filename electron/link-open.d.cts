// Type declarations for electron/link-open.cjs (issue #300). The runtime lives
// in the .cjs; this lets the TS tests and `tsc --noEmit` see its shapes.

export type LinkFailure = 'invalid' | 'missing' | 'inaccessible' | 'failed' | 'unavailable'
export type RevealReason = 'folder' | 'app' | 'blocked' | 'executable' | 'special' | 'type'

export type LinkResult =
  | { ok: true; action: 'opened' }
  | { ok: true; action: 'revealed'; reason: RevealReason }
  | { ok: false; reason: LinkFailure }

export type FilePlan =
  | { ok: true; action: 'open'; path: string }
  | { ok: true; action: 'reveal'; path: string; reason: RevealReason }
  | { ok: false; reason: Exclude<LinkFailure, 'unavailable'> }

export interface LinkShell {
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

interface Fsp {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; mode: number }>
  stat(path: string): Promise<{ size: number }>
  open(path: string, flags: number): Promise<{
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }>
}

// child_process.execFile, as main calls it for /usr/bin/xattr.
export type ExecFile = (
  file: string,
  args: string[],
  options: object,
  callback: (error: Error | null, stdout: string) => void,
) => unknown

export interface FileDeps {
  homeDir?: unknown
  fsp?: Fsp
  platform?: string
  execFileImpl?: ExecFile
}

export function externalWebUrl(value: unknown): string | null
export function isViewerUrl(value: unknown, viewerUrl: string): boolean
export function openWebLink(value: unknown, shell: Pick<LinkShell, 'openExternal'>): boolean
export function normalizeLocalPath(value: unknown, homeDir: unknown): string | null
export function blockedFileName(value: unknown): boolean
export function fileOpenPlan(value: unknown, deps?: FileDeps): Promise<FilePlan>
export function openLinkRequest(raw: unknown, deps: FileDeps & { shell: LinkShell }): Promise<LinkResult>
export function isTrustedLinkSender(input: {
  sender: unknown
  senderFrame: { url: string; parent: unknown } | null | undefined
  window: { isDestroyed(): boolean; webContents: { isDestroyed(): boolean } } | null | undefined
  viewerUrl: string
}): boolean
