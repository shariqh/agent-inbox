import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function copyAgentInboxLicense(repoRoot, destination) {
  const source = join(repoRoot, 'LICENSE')
  if (!existsSync(source)) throw new Error(`repository is missing Agent Inbox license: ${source}`)
  copyFileSync(source, destination)
  return destination
}
