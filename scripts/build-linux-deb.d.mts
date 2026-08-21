import type { LinuxDebInputs } from './linux-deb-inputs.mjs'

export class LinuxDebBuildError extends Error {}
export function resolveSourceDateEpoch(
  repoRoot: string,
  sourceCommit: string,
  env?: NodeJS.ProcessEnv,
): number
export function stageLinuxDebRoot(options: {
  packageRoot: string
  thinApp: string
  icon: string
  repoRoot: string
  packageVersion: string
  inputs: LinuxDebInputs
  profile: {
    target: 'linux-x64' | 'linux-arm64'
    processArch: 'x64' | 'arm64'
    debArchitecture: 'amd64' | 'arm64'
  }
  sourceDateEpoch: number
}): { packageRoot: string; control: string; installedSize: number }
export function runDpkgDeb(options: {
  packageRoot: string
  output: string
  inputs: LinuxDebInputs
  sourceDateEpoch: number
  home: string
}): void
interface LinuxDebBuildOptions {
  app: string
  outputDir: string
  repoRoot: string
  inputsPath?: string
  debInputsPath?: string
  force?: boolean
}
export function buildLinuxDeb(options: LinuxDebBuildOptions & {
  arch?: 'x64' | 'arm64'
}): Promise<{ deb: string; report: Record<string, unknown> & { debSha256: string } }>
export function buildLinuxX64Deb(
  options: LinuxDebBuildOptions,
): Promise<{ deb: string; report: Record<string, unknown> & { debSha256: string } }>
export function buildLinuxArm64Deb(
  options: LinuxDebBuildOptions,
): Promise<{ deb: string; report: Record<string, unknown> & { debSha256: string } }>
