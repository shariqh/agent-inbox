import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process'

export class ElectronSqliteCheckError extends Error {}
export function runElectronSqliteCheck(options: {
  executable: string
  storePath: string
  expected: Partial<Record<'platform' | 'arch' | 'electron' | 'modulesAbi', string>>
  label?: string
  timeoutMs?: number
  log?: (line: string) => void
  spawn?: (file: string, args: string[], options: SpawnSyncOptions) => SpawnSyncReturns<string>
}): {
  electron: string
  node: string
  modulesAbi: string
  platform: string
  arch: string
  seconds: number
}
