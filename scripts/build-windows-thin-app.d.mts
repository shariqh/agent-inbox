import type { WindowsThinReport } from './verify-windows-thin-app.mjs'

export class WindowsThinAppBuildError extends Error {}
export function buildWindowsThinApp(options: {
  runtime: string
  output: string
  repoRoot: string
  inputsPath?: string
}): Promise<{ app: string; report: WindowsThinReport }>
