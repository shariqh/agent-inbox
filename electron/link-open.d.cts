// Type declarations for electron/link-open.cjs (issue #300). The runtime lives
// in the .cjs; this lets the TS tests and `tsc --noEmit` see its shapes.

// 'outside' (issue #324): a repo-relative path whose symlinks lead out of its repository folder
export type LinkFailure = 'invalid' | 'missing' | 'outside' | 'inaccessible' | 'failed' | 'unavailable' | 'unowned' | 'app-missing' | 'app-refused'
export type RevealReason = 'folder' | 'app' | 'blocked' | 'executable' | 'special' | 'type' | 'rule'

export type LinkResult =
  | { ok: true; action: 'opened' }
  | { ok: true; action: 'revealed'; reason: RevealReason | 'requested' }
  | { ok: false; reason: LinkFailure }

/** Settings → Links (part 2), as electron/link-preferences.cjs reads them. */
export type LinkRule = { handler: 'default' | 'quicklook' | 'reveal' } | { handler: 'app'; app: string }
export interface LinkRules {
  web: { handler: 'default' } | { handler: 'app'; app: string }
  markdown: LinkRule
  types: Array<LinkRule & { extension: string }>
}

export type FilePlan =
  | { ok: true; action: 'open'; path: string; rule?: Extract<LinkRule, { handler: 'quicklook' | 'app' }> }
  | { ok: true; action: 'reveal'; path: string; reason: RevealReason }
  | { ok: false; reason: Exclude<LinkFailure, 'unavailable' | 'unowned' | 'app-missing' | 'app-refused'> }

export interface LinkShell {
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

interface Fsp {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; mode: number }>
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>
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

/** An absolute, normalized path naming an .app bundle by its shape alone, or null. */
export function appBundlePath(value: unknown): string | null
/** Whether an app's name is one that runs what it opens (Terminal, Script Editor, Python Launcher, …). */
export function isRunnerApp(app: string): boolean
/** The pick-time and launch-time check: the real path of a bundle with an Info.plist that runs nothing. */
export function launchableApp(value: unknown, fsp?: Pick<Fsp, 'realpath' | 'stat'>): Promise<{ app: string } | { error: 'not-an-app' | 'runs-code' }>
/** Whether the system's default app may open this type (the allow-list). */
export function openableFileName(value: unknown): boolean

export interface SpawnedChild {
  once(event: 'error' | 'exit' | 'spawn', listener: (...args: any[]) => void): unknown
  unref?(): void
}
export type SpawnImpl = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; shell: false; detached: true; windowsHide: true },
) => SpawnedChild

export interface FileDeps {
  homeDir?: unknown
  /** issue #324: the repository folder a repo-relative path is joined to; null or omitted for an absolute or ~/ path */
  root?: unknown
  fsp?: Fsp
  platform?: string
  execFileImpl?: ExecFile
}

export interface OpenOptions {
  rules?: LinkRules | null
  platform?: string
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
/** Issue #324: a plain repo-relative path joined to its absolute folder, both normalized, or null. */
export function joinRepoPath(value: unknown, root: unknown): { root: string; path: string } | null
export function blockedFileName(value: unknown): boolean
export function fileOpenPlan(value: unknown, deps?: FileDeps & { rules?: LinkRules | null }): Promise<FilePlan>
/** `filesPermitted`: main's word that the window shows the viewer this app owns; local files need it. */
export function openLinkRequest(raw: unknown, deps: FileDeps & OpenOptions & { shell: LinkShell; filesPermitted?: boolean }): Promise<LinkResult>
export function isTrustedLinkSender(input: {
  sender: unknown
  senderFrame: { url: string; parent: unknown } | null | undefined
  window: { isDestroyed(): boolean; webContents: { isDestroyed(): boolean } } | null | undefined
  viewerUrl: string
}): boolean
