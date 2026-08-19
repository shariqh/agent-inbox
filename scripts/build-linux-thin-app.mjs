#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { packager } from '@electron/packager'
import { rebuild } from '@electron/rebuild'
import {
  APP_NAME,
  copyRequiredTree,
  npmCliForCurrentNode,
  pruneNativeAddonBuildArtifacts,
  publishAtomically,
} from './build-thin-app.mjs'
import {
  loadLinuxReleaseInputs,
  resolveLinuxCompilerEnvironment,
  validateInstalledLinuxReleaseTools,
} from './linux-release-inputs.mjs'
import { copyTreePreservingMode, verifyPayload } from './runtime-payload.mjs'
import { assertRuntimeSourceCommit } from './runtime-provenance.mjs'
import { resolveSourceProvenance } from './source-provenance.mjs'
import { verifyLinuxThinApp } from './verify-linux-thin-app.mjs'

export class LinuxThinAppBuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxThinAppBuildError'
  }
}

export async function buildLinuxThinApp({
  arch,
  runtime,
  output,
  repoRoot,
  inputsPath,
  force = false,
}) {
  if (!['arm64', 'x64'].includes(arch)) {
    throw new LinuxThinAppBuildError(`unsupported Linux architecture: ${arch}`)
  }
  if (process.platform !== 'linux' || process.arch !== arch) {
    throw new LinuxThinAppBuildError(
      `thin ${arch} app must be built natively on linux/${arch}; this process is ${process.platform}/${process.arch}`,
    )
  }
  const inputs = loadLinuxReleaseInputs(inputsPath)
  validateInstalledLinuxReleaseTools(inputs, repoRoot)
  const compilerEnvironment = resolveLinuxCompilerEnvironment(inputs, arch)
  const key = `linux-${arch}`
  const distribution = inputs.node.distributions[key]
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const provenance = resolveSourceProvenance(repoRoot)
  if (pkg.version !== lock.version) {
    throw new LinuxThinAppBuildError('package.json and package-lock.json versions differ')
  }
  const runtimeManifest = verifyPayload({
    root: runtime,
    expect: {
      product: 'agent-inbox-runtime',
      packageVersion: pkg.version,
      platform: distribution.platform,
      arch: distribution.arch,
      nodeVersion: inputs.node.version,
      nodeModulesAbi: inputs.node.modulesAbi,
      sourceCommit: provenance.sourceCommit,
    },
  })
  assertRuntimeSourceCommit(runtimeManifest, provenance.sourceCommit, key)

  execFileSync(process.execPath, [npmCliForCurrentNode(), 'run', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })

  const outputParent = dirname(resolve(output))
  mkdirSync(outputParent, { recursive: true })
  const work = mkdtempSync(join(outputParent, '.linux-thin-app-'))
  try {
    const stageRoot = join(work, 'stage')
    mkdirSync(stageRoot, { recursive: true })
    copyRequiredTree(repoRoot, stageRoot)
    copyTreePreservingMode(runtime, join(stageRoot, 'runtime', key))

    execFileSync(process.execPath, [npmCliForCurrentNode(), 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: stageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    })
    const previousCompilerEnvironment = {
      CC: process.env.CC,
      CXX: process.env.CXX,
    }
    Object.assign(process.env, compilerEnvironment)
    try {
      await rebuild({
        buildPath: stageRoot,
        electronVersion: inputs.electron.version,
        arch,
        force: true,
        onlyModules: ['better-sqlite3'],
      })
    } finally {
      for (const name of ['CC', 'CXX']) {
        const previous = previousCompilerEnvironment[name]
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }
    }
    pruneNativeAddonBuildArtifacts(stageRoot)
    execFileSync(process.execPath, [
      join(repoRoot, 'scripts', 'write-setup-info.mjs'),
      '--release', join(stageRoot, 'setup-info.json'),
      '--version', pkg.version,
      '--source-root', repoRoot,
      '--payload-root', stageRoot,
      '--runtime-key', key,
      '--payload', `${key}=runtime/${key}`,
    ], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })

    const packagerOut = join(work, 'packager')
    const paths = await packager({
      dir: stageRoot,
      name: APP_NAME,
      productName: APP_NAME,
      executableName: APP_NAME,
      platform: 'linux',
      arch,
      out: packagerOut,
      overwrite: true,
      asar: false,
      junk: false,
      prune: false,
      appVersion: pkg.version,
    })
    if (paths.length !== 1) {
      throw new LinuxThinAppBuildError(`packager returned ${paths.length} output paths`)
    }
    const packaged = paths[0]
    if (!packaged) throw new LinuxThinAppBuildError('packager returned no Linux app folder')
    const verification = verifyLinuxThinApp({
      app: packaged,
      arch,
      inputsPath,
      sourceCommit: provenance.sourceCommit,
    })

    const destination = resolve(output)
    publishAtomically(packaged, destination, force)
    const report = {
      ...verification,
      ...provenance,
      appTreeDigest: verifyLinuxThinApp({
        app: destination,
        arch,
        inputsPath,
        sourceCommit: provenance.sourceCommit,
      }).appTreeDigest,
    }
    writeFileSync(`${destination}.thin-report.json`, `${JSON.stringify(report, null, 2)}\n`)
    return { app: destination, report }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      arch: { type: 'string' },
      runtime: { type: 'string' },
      output: { type: 'string' },
      'repo-root': { type: 'string', default: resolve(import.meta.dirname, '..') },
      inputs: { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  for (const field of ['arch', 'runtime', 'output']) {
    if (!values[field]) throw new LinuxThinAppBuildError(`--${field} is required`)
  }
  const result = await buildLinuxThinApp({
    arch: values.arch,
    runtime: resolve(values.runtime),
    output: resolve(values.output),
    repoRoot: resolve(values['repo-root']),
    inputsPath: values.inputs && resolve(values.inputs),
    force: Boolean(values.force),
  })
  process.stdout.write(`${JSON.stringify({ ok: true, app: result.app, arch: values.arch })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-linux-thin-app: ${err.message}\n`)
    process.exitCode = 1
  })
}
