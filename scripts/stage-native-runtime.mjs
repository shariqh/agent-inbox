#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  archiveExtractCommand,
  archiveListCommand,
  assertPlainFile,
  assertSystemTool,
  nativeRuntimeAdapterFor,
  validateArchiveEntries,
} from './native-runtime-adapter.mjs'
import { loadLinuxReleaseInputs } from './linux-release-inputs.mjs'
import { downloadArchive, loadReleaseInputs, verifyArchiveDigest } from './release-inputs.mjs'
import { loadWindowsReleaseInputs } from './windows-release-inputs.mjs'
import { targetFor } from './runtime-targets.mjs'
import { stageRuntime } from './stage-runtime.mjs'
import { resolveSourceProvenance } from './source-provenance.mjs'

export { validateArchiveEntries } from './native-runtime-adapter.mjs'

export class NativeRuntimeStageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NativeRuntimeStageError'
  }
}

export function assertNativeRuntimeKey(key, platform = process.platform, arch = process.arch) {
  const expected = `${platform}-${arch}`
  if (key !== expected) {
    throw new NativeRuntimeStageError(`runtime ${key} must be staged natively on ${key}; this process is ${expected}`)
  }
}

function adapterFor(key) {
  try {
    return nativeRuntimeAdapterFor(key)
  } catch (err) {
    throw new NativeRuntimeStageError(err.message)
  }
}

function knownTarget(key) {
  try {
    return targetFor(key)
  } catch (err) {
    throw new NativeRuntimeStageError(err.message)
  }
}

function releaseInputsFor(target, inputsPath) {
  if (target.platform === 'darwin') return loadReleaseInputs(inputsPath)
  if (target.platform === 'linux') return loadLinuxReleaseInputs(inputsPath)
  if (target.platform === 'win32') return loadWindowsReleaseInputs(inputsPath)
  throw new NativeRuntimeStageError(`no release input profile for runtime target: ${target.key}`)
}

function runArchiveCommand(command, options) {
  try {
    assertSystemTool(command.executable, 'native archive tool')
  } catch (err) {
    throw new NativeRuntimeStageError(err.message)
  }
  return execFileSync(command.executable, command.args, options)
}

function archiveEntries(adapter, archive) {
  const listing = runArchiveCommand(archiveListCommand(adapter, archive), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  return listing.split(/\r?\n/).filter(Boolean)
}

/**
 * The official Windows ZIP carries neither Node's C/C++ headers nor node.lib, yet
 * stage-runtime.mjs builds better-sqlite3 against npm_config_nodedir = the extracted
 * distribution, never headers node-gyp would fetch (#135). So give that root the same
 * release's pinned headers (include/node) and import library at Release/node.lib, where
 * node-gyp looks under --nodedir for the Release build better-sqlite3 runs. Both are
 * SHA-256 verified, and the headers tarball is listed and checked like the Node archive
 * before anything is extracted. Only the extracted copy changes; nothing from include/ or
 * Release/ is staged into the runtime payload.
 */
export async function provisionWindowsNodeHeaders({
  headers,
  key,
  adapter,
  nodeRoot,
  workDir,
  cacheRoot,
  download = downloadArchive,
}) {
  const library = headers?.importLibraries?.[key]
  if (!library) throw new NativeRuntimeStageError(`no pinned Node import library for ${key}`)
  for (const name of ['include', 'Release']) {
    if (existsSync(join(nodeRoot, name))) {
      throw new NativeRuntimeStageError(`Node distribution already contains ${name}/; refusing to mix in headers`)
    }
  }

  const headersArchive = join(cacheRoot, headers.archive)
  await download({ url: headers.url, destination: headersArchive, expectedSha256: headers.sha256 })
  validateArchiveEntries(archiveEntries(adapter, headersArchive), headers.root)
  const headersParent = join(workDir, 'node-headers')
  mkdirSync(headersParent)
  runArchiveCommand(archiveExtractCommand(adapter, headersArchive, headersParent), {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  const roots = readdirSync(headersParent)
  if (roots.length !== 1 || roots[0] !== headers.root) {
    throw new NativeRuntimeStageError(`Node headers archive root mismatch: expected only ${headers.root}`)
  }
  const include = join(headersParent, headers.root, 'include')
  try {
    for (const name of ['common.gypi', 'config.gypi', 'node_version.h']) {
      assertPlainFile(join(include, 'node', name), `Node headers include/node/${name}`)
    }
  } catch (err) {
    throw new NativeRuntimeStageError(err.message)
  }

  const libraryFile = join(cacheRoot, `${headers.root}-${key}-node.lib`)
  await download({ url: library.url, destination: libraryFile, expectedSha256: library.sha256 })
  renameSync(include, join(nodeRoot, 'include'))
  mkdirSync(join(nodeRoot, 'Release'))
  const stagedLibrary = join(nodeRoot, 'Release', 'node.lib')
  copyFileSync(libraryFile, stagedLibrary)
  return {
    headers: {
      archive: headers.archive,
      root: headers.root,
      url: headers.url,
      sha256: verifyArchiveDigest(headersArchive, headers.sha256),
    },
    importLibrary: {
      url: library.url,
      sha256: verifyArchiveDigest(stagedLibrary, library.sha256),
    },
  }
}

export async function stageNativeRuntime({
  key,
  output,
  repoRoot,
  inputsPath,
  archivePath,
  cacheDir,
  force = false,
}) {
  const target = knownTarget(key)
  assertNativeRuntimeKey(key)
  const inputs = releaseInputsFor(target, inputsPath)
  const adapter = adapterFor(key)
  const distribution = inputs.node.distributions[key]
  if (!distribution) throw new NativeRuntimeStageError(`unknown runtime key: ${key}`)
  const provenance = resolveSourceProvenance(repoRoot)

  const cacheRoot = resolve(cacheDir ?? join(repoRoot, 'build', 'downloads'))
  const archive = resolve(archivePath ?? join(cacheRoot, distribution.archive))
  if (archivePath) {
    verifyArchiveDigest(archive, distribution.sha256)
  } else {
    await downloadArchive({
      url: distribution.url,
      destination: archive,
      expectedSha256: distribution.sha256,
    })
  }
  validateArchiveEntries(archiveEntries(adapter, archive), distribution.root)

  const extractParent = mkdtempSync(join(tmpdir(), 'agent-inbox-node-'))
  try {
    runArchiveCommand(archiveExtractCommand(adapter, archive, extractParent), {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    const roots = readdirSync(extractParent)
    if (roots.length !== 1 || roots[0] !== distribution.root) {
      throw new NativeRuntimeStageError(`archive root mismatch: expected only ${distribution.root}`)
    }
    const nodeRoot = join(extractParent, distribution.root)
    const nodeHeaders = target.platform === 'win32'
      ? await provisionWindowsNodeHeaders({
        headers: inputs.nodeHeaders,
        key,
        adapter,
        nodeRoot,
        workDir: extractParent,
        cacheRoot,
      })
      : null
    const result = stageRuntime({
      nodeRoot,
      platform: distribution.platform,
      arch: distribution.arch,
      output,
      repoRoot,
      sourceCommit: provenance.sourceCommit,
      force,
    })
    if (result.manifest.nodeVersion !== inputs.node.version ||
        result.manifest.nodeModulesAbi !== inputs.node.modulesAbi) {
      throw new NativeRuntimeStageError(
        `staged Node identity mismatch: expected ${inputs.node.version}/ABI ${inputs.node.modulesAbi}`,
      )
    }
    return {
      ...result,
      archiveIdentity: {
        archive: distribution.archive,
        root: distribution.root,
        url: distribution.url,
        sha256: verifyArchiveDigest(archive, distribution.sha256),
      },
      ...(nodeHeaders ? { nodeHeadersIdentity: nodeHeaders } : {}),
    }
  } finally {
    rmSync(extractParent, { recursive: true, force: true })
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      key: { type: 'string' },
      output: { type: 'string' },
      'repo-root': { type: 'string', default: resolve(import.meta.dirname, '..') },
      inputs: { type: 'string' },
      archive: { type: 'string' },
      'cache-dir': { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  if (!values.key || !values.output) {
    throw new NativeRuntimeStageError('usage: stage-native-runtime.mjs --key <runtime-key> --output <dir>')
  }
  const result = await stageNativeRuntime({
    key: values.key,
    output: resolve(values.output),
    repoRoot: resolve(values['repo-root']),
    inputsPath: values.inputs && resolve(values.inputs),
    archivePath: values.archive && resolve(values.archive),
    cacheDir: values['cache-dir'] && resolve(values['cache-dir']),
    force: Boolean(values.force),
  })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    key: values.key,
    output: result.output,
    runtimeId: result.runtimeId,
    archive: basename(result.archiveIdentity.archive),
    archiveRoot: result.archiveIdentity.root,
    archiveUrl: result.archiveIdentity.url,
    archiveSha256: result.archiveIdentity.sha256,
    ...(result.nodeHeadersIdentity
      ? {
        nodeHeadersArchive: result.nodeHeadersIdentity.headers.archive,
        nodeHeadersUrl: result.nodeHeadersIdentity.headers.url,
        nodeHeadersSha256: result.nodeHeadersIdentity.headers.sha256,
        nodeImportLibraryUrl: result.nodeHeadersIdentity.importLibrary.url,
        nodeImportLibrarySha256: result.nodeHeadersIdentity.importLibrary.sha256,
      }
      : {}),
  })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`stage-native-runtime: ${err.message}\n`)
    process.exitCode = 1
  })
}
