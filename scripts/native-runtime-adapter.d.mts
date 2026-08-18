import type { RuntimeArch, RuntimePlatform, RuntimeTargetKey } from './runtime-targets.mjs'

export interface NativeRuntimeAdapter {
  readonly key: RuntimeTargetKey
  readonly platform: RuntimePlatform
  readonly arch: RuntimeArch
  readonly archiveFormat: 'tar.xz' | 'zip'
  readonly archiveExecutable: string
  readonly archiveListFlags: readonly string[]
  readonly archiveExtractFlags: readonly string[]
  readonly nodeExecRelPath: string
  readonly npmCliRelPath: string
  readonly payloadNodeExecRelPath: string
  readonly payloadNodeMode: number | null
}

export class NativeRuntimeAdapterError extends Error {}

export function nativeRuntimeAdapterFor(
  key: string,
  options?: { systemRoot?: string },
): NativeRuntimeAdapter

export function archiveListCommand(
  adapter: NativeRuntimeAdapter,
  archive: string,
): { executable: string; args: string[] }

export function archiveExtractCommand(
  adapter: NativeRuntimeAdapter,
  archive: string,
  destination: string,
): { executable: string; args: string[] }

export function resolveNodeDistributionPaths(
  nodeRoot: string,
  adapter: NativeRuntimeAdapter,
): {
  nodeExec: string
  npmCli: string
  payloadNodeExecRelPath: string
}

export function assertPlainFile(path: string, label: string): string
export function assertSystemTool(path: string, label: string): string
export function validateArchiveEntries(entries: string[], expectedRoot: string): string[]
