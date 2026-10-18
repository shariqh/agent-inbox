export const DEVELOPMENT_PRODUCT_NAME: 'Agent Inbox'
export const ELECTRON_MAIN: 'electron/main.cjs'
export class PackageAppStageError extends Error {
  readonly problems: string[]
}
export function stageDevelopmentApp(repoRoot: string, stageRoot: string): void
export function verifyStagedLockGraph(options: { lockPath: string; appRoot: string }): {
  packages: number
  omittedDev: number
  optionalAbsent: string[]
}
