#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { downloadArchive, loadReleaseInputs, verifyArchiveDigest } from './release-inputs.mjs'
import { stageRuntime } from './stage-runtime.mjs'
import { resolveSourceProvenance } from './source-provenance.mjs'

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

export function validateArchiveEntries(entries, expectedRoot) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new NativeRuntimeStageError('Node archive is empty')
  }
  const prefix = `${expectedRoot}/`
  for (const entry of entries) {
    if (entry !== expectedRoot && !entry.startsWith(prefix)) {
      throw new NativeRuntimeStageError(`Node archive contains a path outside ${expectedRoot}: ${entry}`)
    }
    if (entry.split('/').some((part) => part === '..')) {
      throw new NativeRuntimeStageError(`Node archive contains a traversal path: ${entry}`)
    }
  }
  return entries
}

function archiveEntries(archive) {
  const listing = execFileSync('/usr/bin/tar', ['-tJf', archive], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  return listing.split('\n').filter(Boolean).map((entry) => entry.replace(/\/$/, ''))
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
  const inputs = loadReleaseInputs(inputsPath)
  const provenance = resolveSourceProvenance(repoRoot)
  const distribution = inputs.node.distributions[key]
  if (!distribution) throw new NativeRuntimeStageError(`unknown runtime key: ${key}`)
  assertNativeRuntimeKey(key)

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
  validateArchiveEntries(archiveEntries(archive), distribution.root)

  const extractParent = mkdtempSync(join(tmpdir(), 'agent-inbox-node-'))
  try {
    execFileSync('/usr/bin/tar', ['-xJf', archive, '-C', extractParent], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    const roots = readdirSync(extractParent)
    if (roots.length !== 1 || roots[0] !== distribution.root) {
      throw new NativeRuntimeStageError(`archive root mismatch: expected only ${distribution.root}`)
    }
    const nodeRoot = join(extractParent, distribution.root)
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
    return result
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
    throw new NativeRuntimeStageError('usage: stage-native-runtime.mjs --key <darwin-arch> --output <dir>')
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
    archive: basename(values.archive ?? loadReleaseInputs(values.inputs).node.distributions[values.key].archive),
  })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`stage-native-runtime: ${err.message}\n`)
    process.exitCode = 1
  })
}
