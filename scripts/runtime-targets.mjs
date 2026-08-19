import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const targets = require('../electron/runtime-targets.cjs')

export const {
  MACOS_RUNTIME_KEYS,
  POSIX_SETUP_RUNTIME_KEYS,
  RUNTIME_TARGETS,
  nodeDistributionIdentity,
  targetFor,
} = targets
