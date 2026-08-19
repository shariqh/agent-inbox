import type { LinuxThinReport } from './verify-linux-thin-app.mjs'

export class LinuxThinAppBuildError extends Error {}
export function buildLinuxThinApp(options: {
  arch: string
  runtime: string
  output: string
  repoRoot: string
  inputsPath?: string
  force?: boolean
}): Promise<{ app: string; report: LinuxThinReport }>
