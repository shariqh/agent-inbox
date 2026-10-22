import type { NativeRuntimeAdapter } from './native-runtime-adapter.mjs'

export class NativeRuntimeStageError extends Error {}
export function assertNativeRuntimeKey(key: string, platform?: string, arch?: string): void
export function validateArchiveEntries(entries: string[], expectedRoot: string): string[]
export type NodeHeadersIdentity = {
  headers: {
    archive: string
    root: string
    url: string
    sha256: string
  }
  importLibrary: {
    url: string
    sha256: string
  }
}
export function provisionWindowsNodeHeaders(options: {
  headers: {
    archive: string
    root: string
    url: string
    sha256: string
    importLibraries: Record<string, { url: string; sha256: string }>
  }
  key: string
  adapter: Pick<NativeRuntimeAdapter, 'archiveExecutable' | 'archiveListFlags' | 'archiveExtractFlags'>
  nodeRoot: string
  workDir: string
  cacheRoot: string
  download?: (options: { url: string; destination: string; expectedSha256: string }) => Promise<string>
}): Promise<NodeHeadersIdentity>
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
  archiveIdentity: {
    archive: string
    root: string
    url: string
    sha256: string
  }
  nodeHeadersIdentity?: NodeHeadersIdentity
}>
