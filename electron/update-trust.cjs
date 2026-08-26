'use strict'

const { readFileSync } = require('node:fs')
const { parseRegistry } = require('./update-manifest.cjs')

const UPDATE_TRUST_DISABLED_MESSAGE =
  '[agent-inbox] update checks disabled: bundled trust registry is unavailable or invalid'

function loadUpdateRegistry({ registryPath, logger = console }) {
  try {
    return parseRegistry(readFileSync(registryPath))
  } catch {
    logger.error(UPDATE_TRUST_DISABLED_MESSAGE)
    return null
  }
}

module.exports = {
  UPDATE_TRUST_DISABLED_MESSAGE,
  loadUpdateRegistry,
}
