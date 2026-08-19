import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const targets = require('../electron/runtime-targets.cjs')

export const {
  LINUX_RUNTIME_KEYS,
  MACOS_RUNTIME_KEYS,
  POSIX_SETUP_RUNTIME_KEYS,
  RUNTIME_TARGETS,
  nodeDistributionIdentity,
  targetFor,
} = targets
