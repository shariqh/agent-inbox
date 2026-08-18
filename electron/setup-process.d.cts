import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { SetupResult } from './setup-core.cjs'

export interface SetupProcessRuntime {
  sourceRoot: string
  manifestDigest: string
}

export interface SetupProcessOperation {
  repoRoot: string
  target: string
  runtime: SetupProcessRuntime | null
}

export interface SetupProcessRunner {
  readonly id: 'posix-shell-v1'
  start(
    operation: Readonly<SetupProcessOperation>,
    controls?: { onCancel?: (cancel: () => void) => void },
  ): Promise<SetupResult>
}

export function createSetupProcessRunner(options?: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  maxOutput?: number
  timeoutMs?: number
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  killImpl?: (pid: number, signal: NodeJS.Signals) => void
}): SetupProcessRunner
