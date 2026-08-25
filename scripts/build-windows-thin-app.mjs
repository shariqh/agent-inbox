#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { packager } from '@electron/packager'
import { rebuild } from '@electron/rebuild'
import {
  APP_NAME,
  copyRequiredTree,
  pruneNativeAddonBuildArtifacts,
} from './build-thin-app.mjs'
import { copyTreePreservingMode, verifyPayload } from './runtime-payload.mjs'
import { assertRuntimeSourceCommit } from './runtime-provenance.mjs'
import { resolveSourceProvenance } from './source-provenance.mjs'
import { verifyWindowsThinApp } from './verify-windows-thin-app.mjs'
import {
  loadWindowsReleaseInputs,
  validateInstalledWindowsReleaseTools,
} from './windows-release-inputs.mjs'

export class WindowsThinAppBuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WindowsThinAppBuildError'
  }
}

function npmCliForWindowsNode() {
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(candidate)) {
    throw new WindowsThinAppBuildError(`could not find the Windows npm CLI for ${process.execPath}`)
  }
  return candidate
}

function publishNewFolder(source, destination) {
  if (existsSync(destination)) {
    throw new WindowsThinAppBuildError(`output already exists: ${destination}`)
  }
  mkdirSync(dirname(destination), { recursive: true })
  renameSync(source, destination)
}

function assertWindowsIcon(repoRoot) {
  const icon = join(repoRoot, 'electron', 'icon.ico')
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'assets', 'icon-manifest.json'), 'utf8'))
  const stat = lstatSync(icon)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WindowsThinAppBuildError(`Windows icon must be a plain regular file: ${icon}`)
  }
  const digest = createHash('sha256').update(readFileSync(icon)).digest('hex')
  if (manifest.outputs?.ico !== digest) {
    throw new WindowsThinAppBuildError('Windows icon does not match assets/icon-manifest.json')
  }
}

export async function buildWindowsThinApp({
  runtime,
  output,
  repoRoot,
  inputsPath,
}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new WindowsThinAppBuildError(
      `Windows x64 app must be built natively on win32/x64; this process is ${process.platform}/${process.arch}`,
    )
  }
  assertWindowsIcon(repoRoot)
  const inputs = loadWindowsReleaseInputs(inputsPath)
  if (process.version !== inputs.node.version ||
      process.versions.modules !== inputs.node.modulesAbi) {
    throw new WindowsThinAppBuildError(
      `Windows folder build requires ${inputs.node.version}/ABI ${inputs.node.modulesAbi}; ` +
        `this process is ${process.version}/ABI ${process.versions.modules}`,
    )
  }
  validateInstalledWindowsReleaseTools(inputs, repoRoot)
  const key = 'win32-x64'
  const distribution = inputs.node.distributions[key]
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const provenance = resolveSourceProvenance(repoRoot)
  if (pkg.version !== lock.version) {
    throw new WindowsThinAppBuildError('package.json and package-lock.json versions differ')
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

  const npmCli = npmCliForWindowsNode()
  execFileSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })

  const destination = resolve(output)
  const outputParent = dirname(destination)
  mkdirSync(outputParent, { recursive: true })
  const work = mkdtempSync(join(outputParent, '.windows-thin-app-'))
  try {
    const stageRoot = join(work, 'stage')
    mkdirSync(stageRoot, { recursive: true })
    copyRequiredTree(repoRoot, stageRoot)
    copyTreePreservingMode(runtime, join(stageRoot, 'runtime', key))

    execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: stageRoot,
      env: {
        ...process.env,
        npm_config_platform: 'win32',
        npm_config_arch: 'x64',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    })
    await rebuild({
      buildPath: stageRoot,
      electronVersion: inputs.electron.version,
      arch: 'x64',
      force: true,
      onlyModules: ['better-sqlite3'],
    })
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
      platform: 'win32',
      arch: 'x64',
      out: packagerOut,
      overwrite: true,
      asar: false,
      junk: false,
      prune: false,
      icon: join(repoRoot, 'electron', 'icon.ico'),
      appVersion: pkg.version,
      win32metadata: {
        CompanyName: pkg.author,
        FileDescription: pkg.description,
        InternalName: APP_NAME,
        OriginalFilename: `${APP_NAME}.exe`,
        ProductName: APP_NAME,
      },
    })
    if (paths.length !== 1) {
      throw new WindowsThinAppBuildError(`packager returned ${paths.length} output paths`)
    }
    const packaged = paths[0]
    if (!packaged) throw new WindowsThinAppBuildError('packager returned no Windows app folder')
    const initial = verifyWindowsThinApp({
      app: packaged,
      inputsPath,
      sourceCommit: provenance.sourceCommit,
    })

    publishNewFolder(packaged, destination)
    const report = {
      ...initial,
      ...provenance,
      appTreeDigest: verifyWindowsThinApp({
        app: destination,
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
      runtime: { type: 'string' },
      output: { type: 'string' },
      'repo-root': { type: 'string', default: resolve(import.meta.dirname, '..') },
      inputs: { type: 'string' },
    },
  })
  for (const field of ['runtime', 'output']) {
    if (!values[field]) throw new WindowsThinAppBuildError(`--${field} is required`)
  }
  const result = await buildWindowsThinApp({
    runtime: resolve(values.runtime),
    output: resolve(values.output),
    repoRoot: resolve(values['repo-root']),
    inputsPath: values.inputs && resolve(values.inputs),
  })
  process.stdout.write(`${JSON.stringify({ ok: true, app: result.app, arch: 'x64' })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-windows-thin-app: ${err.message}\n`)
    process.exitCode = 1
  })
}
