#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { publishAtomically } from './build-thin-app.mjs'
import {
  acquirePinnedAppImageRuntime,
  acquirePinnedAppImageTool,
  DEFAULT_LINUX_APPIMAGE_INPUTS,
  loadLinuxAppImageInputs,
  sha256File,
  verifyPinnedAppImageRuntime,
  verifyPinnedAppImageTool,
} from './linux-appimage-inputs.mjs'
import { loadLinuxReleaseInputs } from './linux-release-inputs.mjs'
import { resolveSourceProvenance } from './source-provenance.mjs'
import { verifyLinuxThinApp } from './verify-linux-thin-app.mjs'
import { verifyLinuxX64AppImage } from './verify-linux-appimage.mjs'

const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+$/

export class LinuxAppImageBuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxAppImageBuildError'
  }
}

function assertLinuxX64Host() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new LinuxAppImageBuildError(
      `x64 AppImage must be built natively on linux/x64; this process is ${process.platform}/${process.arch}`,
    )
  }
}

export function appImageArtifactName(packageVersion) {
  if (!PACKAGE_VERSION_RE.test(packageVersion)) {
    throw new LinuxAppImageBuildError(`invalid package version for AppImage: ${String(packageVersion)}`)
  }
  return `Agent-Inbox-v${packageVersion}-linux-x86_64.AppImage`
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
  appImageArtifactName(packageVersion)
  return [
    '[Desktop Entry]',
    `Type=${inputs.desktop.type}`,
    `Name=${inputs.desktop.name}`,
    `Comment=${inputs.desktop.comment}`,
    `Exec=${inputs.desktop.exec}`,
    `Icon=${inputs.desktop.icon}`,
    `Categories=${inputs.desktop.categories.join(';')};`,
    `Terminal=${String(inputs.desktop.terminal)}`,
    `X-AppImage-Version=${packageVersion}`,
    '',
  ].join('\n')
}

function normalizeTreeTimes(path, seconds) {
  const stat = lstatSync(path)
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) normalizeTreeTimes(join(path, name), seconds)
    utimesSync(path, seconds, seconds)
  } else if (stat.isSymbolicLink()) {
    lutimesSync(path, seconds, seconds)
  } else if (stat.isFile()) {
    utimesSync(path, seconds, seconds)
  } else {
    throw new LinuxAppImageBuildError(`AppDir contains unsupported filesystem entry: ${path}`)
  }
}

function copyPlainTreePreservingMode(source, destination, sourceRoot = realpathSync(source)) {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(source)
    const resolvedTarget = realpathSync(source)
    const fromRoot = relative(sourceRoot, resolvedTarget)
    if (
      isAbsolute(target) ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new LinuxAppImageBuildError(`thin application symlink escapes its root: ${source}`)
    }
    symlinkSync(target, destination)
    return
  }
  if (stat.isDirectory()) {
    if ((stat.mode & 0o7000) !== 0) {
      throw new LinuxAppImageBuildError(`thin application directory has privileged mode bits: ${source}`)
    }
    mkdirSync(destination, { mode: stat.mode & 0o777 })
    for (const name of readdirSync(source).sort()) {
      copyPlainTreePreservingMode(join(source, name), join(destination, name), sourceRoot)
    }
    chmodSync(destination, stat.mode & 0o777)
    return
  }
  if (!stat.isFile()) {
    throw new LinuxAppImageBuildError(`thin application contains an unsupported entry: ${source}`)
  }
  if ((stat.mode & 0o7000) !== 0) {
    throw new LinuxAppImageBuildError(`thin application file has privileged mode bits: ${source}`)
  }
  copyFileSync(source, destination)
  chmodSync(destination, stat.mode & 0o777)
}

function assertChromeSandboxInput(app) {
  const sandbox = join(app, 'chrome-sandbox')
  const stat = lstatSync(sandbox)
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== 0o755) {
    throw new LinuxAppImageBuildError(
      'source thin application chrome-sandbox must be a plain executable with mode 0755',
    )
  }
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
  const applicationRoot = join(destination, ...inputs.layout.applicationPath.split('/'))
  mkdirSync(dirname(applicationRoot), { recursive: true })
  copyPlainTreePreservingMode(source, applicationRoot)
  chmodSync(join(applicationRoot, 'chrome-sandbox'), 0o4755)

  const appRun = join(destination, inputs.layout.appRun)
  writeFileSync(appRun, renderAppRun(inputs), { mode: 0o755 })
  chmodSync(appRun, 0o755)
  const desktop = join(destination, inputs.layout.desktopFile)
  writeFileSync(desktop, renderDesktopEntry(inputs, packageVersion), { mode: 0o644 })
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

function runAppImageTool({
  tool,
  appDir,
  output,
  packageVersion,
  sourceDateEpoch,
  home,
  runtime,
  compression,
}) {
  const env = {
    APPIMAGE_EXTRACT_AND_RUN: '1',
    ARCH: 'x86_64',
    HOME: home,
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    TMPDIR: join(home, 'tmp'),
    TZ: 'UTC',
    VERSION: packageVersion,
  }
  mkdirSync(env.TMPDIR)
  execFileSync(tool, [
    '--no-appstream',
    '--runtime-file',
    runtime,
    '--comp',
    compression,
    appDir,
    output,
  ], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
}

export async function buildLinuxX64AppImage({
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
  assertLinuxX64Host()
  const root = resolve(repoRoot)
  const appImageInputsFile = resolve(appImageInputsPath ?? DEFAULT_LINUX_APPIMAGE_INPUTS)
  const appImageInputs = loadLinuxAppImageInputs(appImageInputsFile)
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
  const artifactFile = appImageArtifactName(pkg.version)
  const provenance = resolveSourceProvenance(root)
  const sourceDateEpoch = resolveSourceDateEpoch(root)
  const thinVerification = verifyLinuxThinApp({
    app: resolve(app),
    arch: 'x64',
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
        destination: toolCache ?? join(root, 'build', 'tools', `appimagetool-${appImageInputs.tool.version}-x86_64.AppImage`),
        expected: appImageInputs.tool,
      })
  const runtimePath = runtime
    ? verifyPinnedAppImageRuntime(runtime, appImageInputs.runtime)
    : await acquirePinnedAppImageRuntime({
        destination: runtimeCache ?? join(root, 'build', 'tools', `type2-runtime-${appImageInputs.runtime.version}-x86_64`),
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
    })
    chmodSync(stagedImage, 0o755)
    const verification = verifyLinuxX64AppImage({
      appImage: stagedImage,
      packageVersion: pkg.version,
      sourceCommit: provenance.sourceCommit,
      inputsPath: linuxInputsFile,
      appImageInputsPath,
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

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: 'string' },
      'output-dir': { type: 'string' },
      'repo-root': { type: 'string', default: resolve(import.meta.dirname, '..') },
      inputs: { type: 'string' },
      'appimage-inputs': { type: 'string', default: resolve(import.meta.dirname, '..', 'release', 'linux-appimage-x64.json') },
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
  const result = await buildLinuxX64AppImage({
    app: resolve(values.app),
    outputDir: resolve(values['output-dir']),
    repoRoot: resolve(values['repo-root']),
    inputsPath: values.inputs && resolve(values.inputs),
    appImageInputsPath: resolve(values['appimage-inputs']),
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
