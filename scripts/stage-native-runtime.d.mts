export class NativeRuntimeStageError extends Error {}
export function assertNativeRuntimeKey(key: string, platform?: string, arch?: string): void
export function validateArchiveEntries(entries: string[], expectedRoot: string): string[]
export function stageNativeRuntime(options: {
  key: string
  output: string
  repoRoot: string
  inputsPath?: string
  archivePath?: string
  cacheDir?: string
  force?: boolean
}): Promise<{
  runtimeId: string
  output: string
  manifest: {
    nodeVersion: string
    nodeModulesAbi: string
    [key: string]: unknown
  }
}>
