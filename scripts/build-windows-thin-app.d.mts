import type { WindowsThinReport } from './verify-windows-thin-app.mjs'

export class WindowsThinAppBuildError extends Error {}
// Renames the packaged folder into a free output, retrying on win32 only while
// Windows refuses the rename (#333); the options are for tests.
export function publishNewFolder(source: string, destination: string, options?: {
  platform?: NodeJS.Platform
  rename?(from: string, to: string): void
  sleep?(ms: number): void
}): void
export function buildWindowsThinApp(options: {
  runtime: string
  output: string
  repoRoot: string
  inputsPath?: string
}): Promise<{ app: string; report: WindowsThinReport }>
