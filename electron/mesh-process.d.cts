// Type declarations for electron/mesh-process.cjs (agent setup in the app, step 2a: the bridge).
export type MeshReason =
  | 'unavailable' | 'invalid' | 'handle' | 'busy' | 'setup' | 'updating' | 'quitting'
  | 'unsupported' | 'environment' | 'not-installed' | 'unsafe' | 'unrecognized' | 'stale'
  | 'outdated' | 'output' | 'timeout' | 'failed' | 'cancelled'
export type MeshFailure = { ok: false; reason: MeshReason }
export type MeshPlan = { ok: boolean; applied: boolean; steps: string[]; refused?: string; notes?: string[] }
export type MeshServerKind = 'http' | 'claude-code'
export type MeshServers = {
  ok: boolean
  servers: Array<{ name: string; kind: MeshServerKind; baseUrl: string; key: 'file' | 'command' | 'env' | 'none'; agents: string[] }>
  inline: string[]
  refused?: string
}
export type MeshCheckFailure = 'unreachable' | 'unauthorized' | 'not-a-model-server' | 'timeout' | 'key' | 'no-program' | 'signed-out'
export type MeshCheck = { ok: boolean; reachable: boolean; failure?: MeshCheckFailure; models: string[]; skipped: number; refused?: string; kind?: MeshServerKind }
export type MeshReach = 'loopback' | 'tailnet' | 'public'
/** add's card summary: every string but `endpoint` and `pin` is card text, unverified */
export type MeshCard = {
  id?: string
  name?: string
  description?: string
  version?: string
  publisher?: string
  reach: MeshReach
  endpoint: string
  signed: boolean
  keysNew?: boolean
  skills: Array<{ id: string; name?: string; description?: string }>
  pin: string
}
export type MeshAdd = MeshPlan & { card?: MeshCard }
export type MeshAnswer = MeshPlan | MeshAdd | MeshServers | MeshCheck | MeshFailure
export type MeshKind = 'plan' | 'servers' | 'check' | 'add'
export type MeshAvailability = { available: true } | { available: false; reason: MeshReason }
export type MeshChosen = { ok: true; handle: string; name: string } | MeshFailure

export const OPERATIONS: Readonly<Record<string, { kind: MeshKind; required: string[]; optional?: string[] }>>
export const REASONS: ReadonlySet<string>
export const KEY_KINDS: ReadonlySet<string>
export const SERVER_KINDS: ReadonlySet<string>
export const CHECK_FAILURES: ReadonlySet<string>
export const REACHES: ReadonlySet<string>

export function meshDirOf(env: Record<string, string | undefined>, home: string): { dir: string } | { reason: 'environment' }
export function meshEnv(env: Record<string, string | undefined>): Record<string, string>
export function readShim(options: { dir: string; uid: number; fsImpl?: unknown }):
  { ok: true; node: string; script: string } | MeshFailure
export function meshArgv(operation: unknown, values: unknown, pathOf: (handle: string, purpose: 'key' | 'token') => string | null):
  { argv: string[]; kind: MeshKind } | { reason: 'invalid' | 'handle' }
export function meshAnswer(kind: MeshKind, stdout: string, code: number | null): MeshAnswer
export function runMeshctl(options: {
  node: string
  script: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  spawnImpl: (...args: never[]) => unknown
  killImpl?: (pid: number, signal: NodeJS.Signals) => void
  timeoutMs?: number
  forceKillMs?: number
  onCancel?: (cancel: () => void) => void
}): Promise<{ code: number | null; stdout: string } | { reason: 'failed' | 'output' | 'timeout' | 'quitting' }>
export function createFileHandles(options?: { now?: () => number; randomHex?: () => string }): {
  add(file: string, purpose: 'key' | 'token'): string
  lookup(handle: unknown, purpose: 'key' | 'token'): string | null
  clear(): void
  size(): number
}
export type MeshBridge = {
  available(): MeshAvailability
  run(operation: unknown, values: unknown): Promise<MeshAnswer>
  chooseFile(purpose: unknown): Promise<MeshChosen>
  revoke(): void
  beginQuit(): Promise<void> | null
}
export function createMeshBridge(options: {
  platform?: string
  env?: () => Record<string, string | undefined>
  home: () => string
  uid?: () => number | undefined
  fsImpl?: unknown
  spawnImpl: (...args: never[]) => unknown
  killImpl?: (pid: number, signal: NodeJS.Signals) => void
  timeoutMs?: number
  forceKillMs?: number
  gate: {
    quitting(): boolean
    running(): boolean
    run<T>(start: (onCancel: (cancel: () => void) => void) => Promise<T>): { promise: Promise<T> } | { refused: 'quitting' | 'running' }
    beginQuit(): Promise<void> | null
  }
  choose: (purpose: 'key' | 'token') => Promise<string | null>
  isQuitting: () => boolean
  isSetupRunning: () => boolean
  isUpdateInstalling: () => boolean
  now?: () => number
  randomHex?: () => string
}): MeshBridge
export function registerMeshIpc(options: {
  ipcMain: { handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void }
  bridge: MeshBridge
  settled: () => Promise<unknown>
  isGranted: (event: never) => boolean
}): void
