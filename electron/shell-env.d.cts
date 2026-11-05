// Type declarations for electron/shell-env.cjs (issue #412 step 3).
export type CaptureResult = { ok: true; env: Record<string, string> } | { ok: false; reason: 'shell' | 'timeout' | 'failed' }
export function captureShellEnv(options: {
  shell: string | undefined
  cwd: string
  baseEnv: Record<string, string>
  spawnImpl: (...args: never[]) => unknown
  timeoutMs?: number
  random?: (size: number) => Buffer
}): Promise<CaptureResult>
export function parseCapturedEnv(output: string, start: string, end: string): Record<string, string> | null
