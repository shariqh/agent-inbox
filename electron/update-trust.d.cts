import type { UpdateRegistry } from './update-manifest.cjs'

export const UPDATE_TRUST_DISABLED_MESSAGE: string

export function loadUpdateRegistry(options: {
  registryPath: string
  logger?: { error(message: string): void }
}): UpdateRegistry | null
