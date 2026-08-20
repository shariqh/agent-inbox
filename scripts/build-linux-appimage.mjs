#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { publishAtomically } from './build-thin-app.mjs'
import {
  acquirePinnedAppImageRuntime,
  acquirePinnedAppImageTool,
  DEFAULT_LINUX_ARM64_APPIMAGE_INPUTS,
  DEFAULT_LINUX_APPIMAGE_INPUTS,
  loadLinuxAppImageInputs,
  resolveLinuxAppImageTarget,
  sha256File,
  verifyPinnedAppImageRuntime,
  verifyPinnedAppImageTool,
} from './linux-appimage-inputs.mjs'
import { loadLinuxReleaseInputs } from './linux-release-inputs.mjs'
import {
  assertChromeSandboxInput,
  copyPlainTreeWithDeterministicModes,
  normalizeTreeTimes,
  renderLinuxDesktopEntry,
} from './linux-package-common.mjs'
import { resolveSourceProvenance } from './source-provenance.mjs'
import { verifyLinuxThinApp } from './verify-linux-thin-app.mjs'
import { verifyLinuxAppImage } from './verify-linux-appimage.mjs'

const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+$/

export class LinuxAppImageBuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxAppImageBuildError'
  }
}

function assertLinuxHost(arch) {
  if (process.platform !== 'linux' || process.arch !== arch) {
    throw new LinuxAppImageBuildError(
      `${arch} AppImage must be built natively on linux/${arch}; this process is ${process.platform}/${process.arch}`,
    )
  }
}

function profileForArch(arch) {
  return resolveLinuxAppImageTarget(`linux-${arch}`)
}

function defaultInputsForArch(arch) {
  return arch === 'arm64'
    ? DEFAULT_LINUX_ARM64_APPIMAGE_INPUTS
    : DEFAULT_LINUX_APPIMAGE_INPUTS
}

export function appImageArtifactName(packageVersion, arch = 'x64') {
  if (!PACKAGE_VERSION_RE.test(packageVersion)) {
    throw new LinuxAppImageBuildError(`invalid package version for AppImage: ${String(packageVersion)}`)
  }
  const profile = profileForArch(arch)
  return `Agent-Inbox-v${packageVersion}-linux-${profile.artifactNameArchitecture}.AppImage`
}

export function renderAppRun(inputs) {
  return [
    '#!/bin/sh',
    'set -eu',
    'APPDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"',
    `exec "$APPDIR/${inputs.layout.applicationPath}/Agent Inbox" --disable-setuid-sandbox "$@"`,
    '',
  ].join('\n')
}

export function renderDesktopEntry(inputs, packageVersion) {
  appImageArtifactName(packageVersion, resolveLinuxAppImageTarget(inputs.target).processArch)
  return renderLinuxDesktopEntry(
    inputs.desktop,
    [['X-AppImage-Version', packageVersion]],
  )
}

export function stageLinuxAppImageDirectory({
  appDir,
  thinApp,
  icon,
  packageVersion,
  inputs,
  sourceDateEpoch,
}) {
  const source = resolve(thinApp)
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new LinuxAppImageBuildError(`thin application must be a plain directory: ${source}`)
  }
  assertChromeSandboxInput(source)
  const iconPath = resolve(icon)
  const iconStat = lstatSync(iconPath)
  if (iconStat.isSymbolicLink() || !iconStat.isFile()) {
    throw new LinuxAppImageBuildError(`AppImage icon must be a plain file: ${iconPath}`)
  }
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
    throw new LinuxAppImageBuildError('SOURCE_DATE_EPOCH must be a positive integer')
  }

  const destination = resolve(appDir)
  if (existsSync(destination)) {
    throw new LinuxAppImageBuildError(`AppDir already exists: ${destination}`)
  }
  mkdirSync(destination, { recursive: true })
  chmodSync(destination, 0o755)
  const applicationParts = inputs.layout.applicationPath.split('/')
  const applicationRoot = join(destination, ...applicationParts)
  mkdirSync(dirname(applicationRoot), { recursive: true })
  let generatedDirectory = destination
  for (const part of applicationParts.slice(0, -1)) {
    generatedDirectory = join(generatedDirectory, part)
    chmodSync(generatedDirectory, 0o755)
  }
  copyPlainTreeWithDeterministicModes(source, applicationRoot)
  chmodSync(join(applicationRoot, 'chrome-sandbox'), 0o4755)

  const appRun = join(destination, inputs.layout.appRun)
  writeFileSync(appRun, renderAppRun(inputs), { mode: 0o755 })
  chmodSync(appRun, 0o755)
  const desktop = join(destination, inputs.layout.desktopFile)
  writeFileSync(desktop, renderDesktopEntry(inputs, packageVersion), { mode: 0o644 })
  chmodSync(desktop, 0o644)
  const packagedIcon = join(destination, inputs.layout.iconFile)
  copyFileSync(iconPath, packagedIcon)
  chmodSync(packagedIcon, 0o644)
  symlinkSync(inputs.layout.iconFile, join(destination, '.DirIcon'))
  normalizeTreeTimes(destination, sourceDateEpoch)
  return destination
}

function resolveSourceDateEpoch(repoRoot, env = process.env) {
  const raw = execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim()
  const sourceDateEpoch = Number(raw)
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
    throw new LinuxAppImageBuildError(`invalid source commit timestamp: ${raw}`)
  }
  if (env.SOURCE_DATE_EPOCH !== undefined && env.SOURCE_DATE_EPOCH !== raw) {
    throw new LinuxAppImageBuildError(
      `SOURCE_DATE_EPOCH mismatch: expected source commit timestamp ${raw}, got ${env.SOURCE_DATE_EPOCH}`,
    )
  }
  return sourceDateEpoch
}

function assertSourceInput(path, expectedSha256, label) {
  const actual = sha256File(path)
  if (actual !== expectedSha256) {
    throw new LinuxAppImageBuildError(
      `${label} SHA-256 mismatch: expected ${expectedSha256}, found ${actual}`,
    )
  }
}

export function runAppImageTool({
  tool,
  appDir,
  output,
  packageVersion,
  sourceDateEpoch,
  home,
  runtime,
  compression,
  upstreamArchitecture,
}) {
  const env = {
    APPIMAGE_EXTRACT_AND_RUN: '1',
    ARCH: upstreamArchitecture,
    HOME: home,
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    TMPDIR: join(home, 'tmp'),
    TZ: 'UTC',
    VERSION: packageVersion,
  }
  mkdirSync(env.TMPDIR)
  const args = [
    '--no-appstream',
    '--runtime-file',
    runtime,
    '--comp',
    compression,
    appDir,
    output,
  ]
  execFileSync('/bin/sh', [
    '-c',
    'umask 022; exec "$@"',
    'appimagetool',
    tool,
    ...args,
  ], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
}

export async function buildLinuxAppImage({
  arch = 'x64',
  app,
  outputDir,
  repoRoot,
  inputsPath,
  appImageInputsPath,
  tool,
  toolCache,
  runtime,
  runtimeCache,
  force = false,
}) {
  assertLinuxHost(arch)
  const profile = profileForArch(arch)
  const root = resolve(repoRoot)
  const appImageInputsFile = resolve(appImageInputsPath ?? defaultInputsForArch(arch))
  const appImageInputs = loadLinuxAppImageInputs(appImageInputsFile)
  if (appImageInputs.target !== profile.target) {
    throw new LinuxAppImageBuildError(
      `AppImage input target mismatch: expected ${profile.target}, found ${appImageInputs.target}`,
    )
  }
  const linuxInputsFile = resolve(inputsPath ?? join(root, appImageInputs.linuxInputs.path))
  const icon = resolve(root, appImageInputs.icon.path)
  assertSourceInput(linuxInputsFile, appImageInputs.linuxInputs.sha256, 'Linux release inputs')
  assertSourceInput(icon, appImageInputs.icon.sha256, 'AppImage icon')
  loadLinuxReleaseInputs(linuxInputsFile)

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  if (pkg.version !== lock.version) {
    throw new LinuxAppImageBuildError('package.json and package-lock.json versions differ')
  }
  const artifactFile = appImageArtifactName(pkg.version, arch)
  const provenance = resolveSourceProvenance(root)
  const sourceDateEpoch = resolveSourceDateEpoch(root)
  const thinVerification = verifyLinuxThinApp({
    app: resolve(app),
    arch,
    inputsPath: linuxInputsFile,
    sourceCommit: provenance.sourceCommit,
  })
  if (thinVerification.packageVersion !== pkg.version) {
    throw new LinuxAppImageBuildError(
      `thin application version mismatch: expected ${pkg.version}, found ${thinVerification.packageVersion}`,
    )
  }
  const toolPath = tool
    ? verifyPinnedAppImageTool(tool, appImageInputs.tool)
    : await acquirePinnedAppImageTool({
        destination: toolCache ?? join(root, 'build', 'tools', `appimagetool-${appImageInputs.tool.version}-${profile.upstreamArchitecture}.AppImage`),
        expected: appImageInputs.tool,
      })
  const runtimePath = runtime
    ? verifyPinnedAppImageRuntime(runtime, appImageInputs.runtime)
    : await acquirePinnedAppImageRuntime({
        destination: runtimeCache ?? join(root, 'build', 'tools', `type2-runtime-${appImageInputs.runtime.version}-${profile.upstreamArchitecture}`),
        expected: appImageInputs.runtime,
      })

  const destinationDir = resolve(outputDir)
  mkdirSync(destinationDir, { recursive: true })
  const work = mkdtempSync(join(destinationDir, '.linux-appimage-'))
  try {
    const appDir = join(work, 'AgentInbox.AppDir')
    stageLinuxAppImageDirectory({
      appDir,
      thinApp: app,
      icon,
      packageVersion: pkg.version,
      inputs: appImageInputs,
      sourceDateEpoch,
    })
    const stagedImage = join(work, artifactFile)
    const isolatedHome = join(work, 'home')
    mkdirSync(isolatedHome)
    runAppImageTool({
      tool: toolPath,
      appDir,
      output: stagedImage,
      packageVersion: pkg.version,
      sourceDateEpoch,
      home: isolatedHome,
      runtime: runtimePath,
      compression: appImageInputs.compression,
      upstreamArchitecture: profile.upstreamArchitecture,
    })
    chmodSync(stagedImage, 0o755)
    const verification = verifyLinuxAppImage({
      arch,
      appImage: stagedImage,
      packageVersion: pkg.version,
      sourceCommit: provenance.sourceCommit,
      inputsPath: linuxInputsFile,
      appImageInputsPath: appImageInputsFile,
    })
    if (verification.packageVersion !== thinVerification.packageVersion) {
      throw new LinuxAppImageBuildError(
        `packaged AppImage version changed: expected ${thinVerification.packageVersion}, found ${verification.packageVersion}`,
      )
    }
    if (verification.innerAppTreeDigest !== thinVerification.appTreeDigest) {
      throw new LinuxAppImageBuildError(
        `packaged AppImage application tree changed: expected ${thinVerification.appTreeDigest}, found ${verification.innerAppTreeDigest}`,
      )
    }
    const report = {
      ...verification,
      sourceCommit: provenance.sourceCommit,
      sourceDirty: provenance.sourceDirty,
      sourceDateEpoch,
      linuxInputsSha256: appImageInputs.linuxInputs.sha256,
      appImageInputsSha256: sha256File(appImageInputsFile),
      tool: {
        name: appImageInputs.tool.name,
        version: appImageInputs.tool.version,
        sourceCommit: appImageInputs.tool.sourceCommit,
        url: appImageInputs.tool.url,
        size: appImageInputs.tool.size,
        sha256: appImageInputs.tool.sha256,
      },
      runtime: {
        name: appImageInputs.runtime.name,
        version: appImageInputs.runtime.version,
        sourceCommit: appImageInputs.runtime.sourceCommit,
        url: appImageInputs.runtime.url,
        size: appImageInputs.runtime.size,
        sha256: appImageInputs.runtime.sha256,
      },
    }
    const stagedChecksum = `${stagedImage}.sha256`
    const stagedReport = `${stagedImage}.report.json`
    writeFileSync(stagedChecksum, `${verification.appImageSha256}  ${artifactFile}\n`)
    writeFileSync(stagedReport, `${JSON.stringify(report, null, 2)}\n`)
    chmodSync(stagedChecksum, 0o644)
    chmodSync(stagedReport, 0o644)

    const destination = join(destinationDir, artifactFile)
    publishAtomically(stagedImage, destination, force)
    publishAtomically(stagedChecksum, `${destination}.sha256`, force)
    publishAtomically(stagedReport, `${destination}.report.json`, force)
    const publishedSha256 = sha256File(destination)
    if (publishedSha256 !== verification.appImageSha256) {
      throw new LinuxAppImageBuildError(
        `published AppImage SHA-256 changed: expected ${verification.appImageSha256}, found ${publishedSha256}`,
      )
    }
    return { appImage: destination, report }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export function buildLinuxX64AppImage(options) {
  return buildLinuxAppImage({ ...options, arch: 'x64' })
}

export function buildLinuxArm64AppImage(options) {
  return buildLinuxAppImage({ ...options, arch: 'arm64' })
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: 'string' },
      arch: { type: 'string', default: 'x64' },
      'output-dir': { type: 'string' },
      'repo-root': { type: 'string', default: resolve(import.meta.dirname, '..') },
      inputs: { type: 'string' },
      'appimage-inputs': { type: 'string' },
      tool: { type: 'string' },
      'tool-cache': { type: 'string' },
      runtime: { type: 'string' },
      'runtime-cache': { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  if (!values.app || !values['output-dir']) {
    throw new LinuxAppImageBuildError(
      'usage: build-linux-appimage.mjs --app <linux-x64 folder> --output-dir <directory>',
    )
  }
  const result = await buildLinuxAppImage({
    arch: values.arch,
    app: resolve(values.app),
    outputDir: resolve(values['output-dir']),
    repoRoot: resolve(values['repo-root']),
    inputsPath: values.inputs && resolve(values.inputs),
    appImageInputsPath: values['appimage-inputs'] && resolve(values['appimage-inputs']),
    tool: values.tool && resolve(values.tool),
    toolCache: values['tool-cache'] && resolve(values['tool-cache']),
    runtime: values.runtime && resolve(values.runtime),
    runtimeCache: values['runtime-cache'] && resolve(values['runtime-cache']),
    force: Boolean(values.force),
  })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    appImage: result.appImage,
    sha256: result.report.appImageSha256,
  })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-linux-appimage: ${err.message}\n`)
    process.exitCode = 1
  })
}
