import type { LinuxAppImageInputs } from './linux-appimage-inputs.mjs'

export class LinuxAppImageBuildError extends Error {}
export function appImageArtifactName(packageVersion: string): string
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
export function buildLinuxX64AppImage(options: {
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
}): Promise<{
  appImage: string
  report: Record<string, unknown> & { appImageSha256: string }
}>
