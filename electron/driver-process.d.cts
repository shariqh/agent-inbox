// Type declarations for electron/driver-process.cjs (issue #412 step 3).
export type DriverStart = { ok: true; launch: string; pid: number } | { ok: false; error: string }
export function driverArgv(options: { entry: string; launchId: string; hubPath: string }): string[]
export function startDriver(options: {
  platform?: string
  node: string
  entry: string
  launchId: string
  hubPath: string
  spec: Record<string, unknown>
  logPath: string
  env: Record<string, string>
  spawnImpl: (...args: never[]) => unknown
  fsImpl?: unknown
  timeoutMs?: number
}): Promise<DriverStart>
/** #432: `driver-cli.js worktree inspect|remove`'s one JSON answer */
export function runWorktreeCommand(options: {
  platform?: string
  node: string
  entry: string
  verb: 'inspect' | 'remove'
  launchId: string
  hubPath: string
  discard?: string
  env: Record<string, string>
  spawnImpl: (...args: never[]) => unknown
  timeoutMs?: number
}): Promise<{ ok: boolean; error?: string; [key: string]: unknown }>
