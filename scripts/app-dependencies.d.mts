export function installAppDependencies(options: {
  stageRoot: string
  npmCli: string
  electronVersion: string
  arch: string
  env?: NodeJS.ProcessEnv
}): Promise<void>
