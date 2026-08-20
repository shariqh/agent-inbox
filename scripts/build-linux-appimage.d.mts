import type { LinuxAppImageInputs } from './linux-appimage-inputs.mjs'

export class LinuxAppImageBuildError extends Error {}
export function appImageArtifactName(packageVersion: string, arch?: 'x64' | 'arm64'): string
export function renderAppRun(inputs: LinuxAppImageInputs): string
export function renderDesktopEntry(inputs: LinuxAppImageInputs, packageVersion: string): string
export function stageLinuxAppImageDirectory(options: {
  appDir: string
  thinApp: string
  icon: string
  packageVersion: string
  inputs: LinuxAppImageInputs
  sourceDateEpoch: number
}): string
export function runAppImageTool(options: {
  tool: string
  appDir: string
  output: string
  packageVersion: string
  sourceDateEpoch: number
  home: string
  runtime: string
  compression: string
  upstreamArchitecture: string
}): void
interface LinuxAppImageBuildOptions {
  app: string
  outputDir: string
  repoRoot: string
  inputsPath?: string
  appImageInputsPath?: string
  tool?: string
  toolCache?: string
  runtime?: string
  runtimeCache?: string
  force?: boolean
}
export function buildLinuxAppImage(options: LinuxAppImageBuildOptions & {
  arch?: 'x64' | 'arm64'
}): Promise<{
  appImage: string
  report: Record<string, unknown> & { appImageSha256: string }
}>
export function buildLinuxX64AppImage(options: LinuxAppImageBuildOptions): Promise<{
  appImage: string
  report: Record<string, unknown> & { appImageSha256: string }
}>
export function buildLinuxArm64AppImage(options: LinuxAppImageBuildOptions): Promise<{
  appImage: string
  report: Record<string, unknown> & { appImageSha256: string }
}>
