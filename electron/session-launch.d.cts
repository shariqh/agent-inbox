// Type declarations for electron/session-launch.cjs (issue #412 step 3).
export interface SessionLaunchSettings {
  read(): Promise<{ enabled: boolean }>
  setEnabled(enabled: boolean): Promise<{ enabled: boolean; refused?: 'newer' }>
  /** #432: the worktree folder chosen in Settings, or null for the default */
  readWorktreeRoot(): Promise<string | null>
  setWorktreeRoot(root: string | null): Promise<{ root: string | null; refused?: 'newer' }>
  /** #432 §5: the cap on sessions at once, or null for the default */
  readMaxDrivers(): Promise<number | null>
  setMaxDrivers(cap: number): Promise<{ maxDrivers: number | null; refused?: 'newer' }>
}
export function createSessionLaunchSettings(options: { filePath?: string; app?: { getPath(name: string): string }; fsImpl?: unknown }): SessionLaunchSettings
export function parseSessionLaunch(bytes: string | Buffer): { enabled: boolean; record: Record<string, unknown> | null; writable: boolean }
