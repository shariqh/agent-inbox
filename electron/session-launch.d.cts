// Type declarations for electron/session-launch.cjs (issue #412 step 3).
export interface SessionLaunchSettings {
  read(): Promise<{ enabled: boolean }>
  setEnabled(enabled: boolean): Promise<{ enabled: boolean; refused?: 'newer' }>
}
export function createSessionLaunchSettings(options: { filePath?: string; app?: { getPath(name: string): string }; fsImpl?: unknown }): SessionLaunchSettings
export function parseSessionLaunch(bytes: string | Buffer): { enabled: boolean; record: Record<string, unknown> | null; writable: boolean }
