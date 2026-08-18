const EXPECTED_PRODUCT = 'agent-inbox-runtime'
const EXPECTED_NODE_MAJOR = 24
const EXPECTED_NODE_MODULES_ABI = '137'
const SHA256 = /^[0-9a-f]{64}$/
const MANIFEST_DIGEST = /^sha256:[0-9a-f]{64}$/

function failed(target, output) {
  return {
    ok: false,
    exitCode: null,
    output,
    target,
    timedOut: false,
    cancelled: false,
  }
}

function failedIntegrity(target) {
  return failed(
    target,
    'Release runtime payload failed integrity verification — refusing to run the installer.',
  )
}

function frozenStringArray(value) {
  return Array.isArray(value) &&
    Object.isFrozen(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0) &&
    new Set(value).size === value.length
}

function validAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || !Object.isFrozen(adapter)) return false
  if (typeof adapter.id !== 'string' || !adapter.id) return false
  if (!frozenStringArray(adapter.releaseKeys) || !frozenStringArray(adapter.targets)) return false
  if (typeof adapter.verify !== 'function' || typeof adapter.start !== 'function') return false

  const host = adapter.host
  if (!host || typeof host !== 'object' || !Object.isFrozen(host)) return false
  if (typeof host.platform !== 'string' || !host.platform ||
      typeof host.arch !== 'string' || !host.arch ||
      typeof host.key !== 'string' || host.key !== `${host.platform}-${host.arch}`) {
    return false
  }
  return adapter.releaseKeys.includes(host.key)
}

function validSelection(selection, releaseKeys) {
  return selection &&
    typeof selection === 'object' &&
    typeof selection.key === 'string' &&
    releaseKeys.includes(selection.key) &&
    typeof selection.sourceRoot === 'string' &&
    selection.sourceRoot.length > 0 &&
    typeof selection.manifestDigest === 'string' &&
    MANIFEST_DIGEST.test(selection.manifestDigest) &&
    typeof selection.packageVersion === 'string' &&
    selection.packageVersion.trim().length > 0
}

function validVerifiedIdentity(selection, host, verified) {
  if (!verified || typeof verified !== 'object') return false
  if (verified && typeof verified.then === 'function') return false

  const verifiedKey = `${verified.platform}-${verified.arch}`
  return selection.key === host.key &&
    verifiedKey === host.key &&
    verified.sourceRoot === selection.sourceRoot &&
    verified.manifestDigest === selection.manifestDigest &&
    verified.packageVersion === selection.packageVersion &&
    verified.product === EXPECTED_PRODUCT &&
    typeof verified.runtimeId === 'string' &&
    verified.runtimeId.length > 0 &&
    typeof verified.payloadDigest === 'string' &&
    SHA256.test(verified.payloadDigest) &&
    verified.nodeMajor === EXPECTED_NODE_MAJOR &&
    verified.nodeModulesAbi === EXPECTED_NODE_MODULES_ABI
}

function runTrustedSetup({ request, adapter, onCancel }) {
  const target = String(request?.target)
  if (!validAdapter(adapter) || !validSelection(request?.selection, adapter.releaseKeys) ||
      typeof onCancel !== 'function') {
    return Promise.resolve(failed(
      target,
      'Invalid release runtime payload — refusing to run the installer.',
    ))
  }
  if (!adapter.targets.includes(target)) {
    return Promise.resolve(failed(target, `Invalid setup target: ${target}`))
  }

  let verified
  try {
    verified = adapter.verify(request)
  } catch {
    return Promise.resolve(failedIntegrity(target))
  }
  if (!validVerifiedIdentity(request.selection, adapter.host, verified)) {
    return Promise.resolve(failedIntegrity(target))
  }

  const operation = Object.freeze({
    target,
    sourceRoot: verified.sourceRoot,
    manifestDigest: verified.manifestDigest,
    packageVersion: verified.packageVersion,
    host: Object.freeze({ ...adapter.host }),
  })

  try {
    const result = adapter.start(operation, { onCancel })
    if (!result || typeof result.then !== 'function') {
      return Promise.resolve(failed(target, 'Could not start installer: invalid adapter result'))
    }
    return result
  } catch (err) {
    return Promise.resolve(failed(target, `Could not start installer: ${err.message}`))
  }
}

module.exports = {
  runTrustedSetup,
}
