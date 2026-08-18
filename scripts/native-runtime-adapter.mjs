import { lstatSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { targetFor } from './runtime-targets.mjs'

const POSIX_TAR = '/usr/bin/tar'

export class NativeRuntimeAdapterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NativeRuntimeAdapterError'
  }
}

function assertSafeRelativePath(path, field) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new NativeRuntimeAdapterError(`${field} is not a safe relative path: ${String(path)}`)
  }
  return path
}

function windowsArchiveExecutable(systemRoot) {
  if (typeof systemRoot !== 'string' || !systemRoot) {
    throw new NativeRuntimeAdapterError('SystemRoot is required for Windows ZIP staging')
  }
  if (!win32.isAbsolute(systemRoot)) {
    throw new NativeRuntimeAdapterError(`SystemRoot must be an absolute Windows path: ${systemRoot}`)
  }
  return win32.join(systemRoot, 'System32', 'tar.exe')
}

export function nativeRuntimeAdapterFor(key, { systemRoot = process.env.SystemRoot } = {}) {
  let target
  try {
    target = targetFor(key)
  } catch (err) {
    throw new NativeRuntimeAdapterError(err.message)
  }

  assertSafeRelativePath(target.nodeExecRelPath, `${key}.nodeExecRelPath`)
  assertSafeRelativePath(target.npmCliRelPath, `${key}.npmCliRelPath`)

  let archiveExecutable
  let archiveListFlags
  let archiveExtractFlags
  let payloadNodeMode
  if (target.format === 'tar.xz' && (target.platform === 'darwin' || target.platform === 'linux')) {
    archiveExecutable = POSIX_TAR
    archiveListFlags = Object.freeze(['-tJf'])
    archiveExtractFlags = Object.freeze(['-xJf'])
    payloadNodeMode = 0o755
  } else if (target.format === 'zip' && target.platform === 'win32') {
    archiveExecutable = windowsArchiveExecutable(systemRoot)
    archiveListFlags = Object.freeze(['-tf'])
    archiveExtractFlags = Object.freeze(['-xf'])
    payloadNodeMode = null
  } else {
    throw new NativeRuntimeAdapterError(
      `unsupported native staging target ${key}: ${target.platform}/${target.format}`,
    )
  }

  return Object.freeze({
    key: target.key,
    platform: target.platform,
    arch: target.arch,
    archiveFormat: target.format,
    archiveExecutable,
    archiveListFlags,
    archiveExtractFlags,
    nodeExecRelPath: target.nodeExecRelPath,
    npmCliRelPath: target.npmCliRelPath,
    payloadNodeExecRelPath: target.nodeExecRelPath,
    payloadNodeMode,
  })
}

export function archiveListCommand(adapter, archive) {
  return {
    executable: adapter.archiveExecutable,
    args: [...adapter.archiveListFlags, archive],
  }
}

export function archiveExtractCommand(adapter, archive, destination) {
  return {
    executable: adapter.archiveExecutable,
    args: [...adapter.archiveExtractFlags, archive, '-C', destination],
  }
}

export function resolveNodeDistributionPaths(nodeRoot, adapter) {
  const path = adapter.platform === 'win32' ? win32 : posix
  return {
    nodeExec: path.resolve(nodeRoot, ...adapter.nodeExecRelPath.split('/')),
    npmCli: path.resolve(nodeRoot, ...adapter.npmCliRelPath.split('/')),
    payloadNodeExecRelPath: adapter.payloadNodeExecRelPath,
  }
}

export function assertPlainFile(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new NativeRuntimeAdapterError(`${label} is missing: ${path}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new NativeRuntimeAdapterError(`${label} must be a plain regular file: ${path}`)
  }
  return path
}

export function validateArchiveEntries(entries, expectedRoot) {
  assertSafeRelativePath(expectedRoot, 'expected archive root')
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new NativeRuntimeAdapterError('Node archive is empty')
  }

  const normalized = []
  const seen = new Set()
  const prefix = `${expectedRoot}/`
  for (const rawEntry of entries) {
    if (typeof rawEntry !== 'string' || !rawEntry) {
      throw new NativeRuntimeAdapterError('Node archive contains an empty path')
    }
    const entry = rawEntry.replace(/\/+$/, '')
    assertSafeRelativePath(entry, 'Node archive entry')
    if (entry !== expectedRoot && !entry.startsWith(prefix)) {
      throw new NativeRuntimeAdapterError(`Node archive contains a path outside ${expectedRoot}: ${entry}`)
    }
    if (seen.has(entry)) {
      throw new NativeRuntimeAdapterError(`Node archive contains a duplicate path: ${entry}`)
    }
    seen.add(entry)
    normalized.push(entry)
  }
  return normalized
}
