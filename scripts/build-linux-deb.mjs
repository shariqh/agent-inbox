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
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { publishAtomically } from './build-thin-app.mjs'
import {
  assertPinnedDpkgDeb,
  debArtifactName,
  installedSizeKiB,
  renderDebControl,
  renderDebDesktopEntry,
  renderDebLauncher,
} from './linux-deb-contract.mjs'
import {
  DEFAULT_LINUX_DEB_INPUTS,
  loadLinuxDebInputs,
  resolveLinuxDebTarget,
  sha256File,
} from './linux-deb-inputs.mjs'
import { loadLinuxReleaseInputs } from './linux-release-inputs.mjs'
import {
  assertChromeSandboxInput,
  copyPlainTreeWithDeterministicModes,
  normalizeDirectoryModes,
  normalizeTreeTimes,
} from './linux-package-common.mjs'
import { sha256LargeFile } from './linux-deb-archive.mjs'
import { resolveSourceProvenance } from './source-provenance.mjs'
import { verifyLinuxThinApp } from './verify-linux-thin-app.mjs'
import { verifyLinuxDeb } from './verify-linux-deb.mjs'

export class LinuxDebBuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxDebBuildError'
  }
}

function assertLinuxHost(arch) {
  if (process.platform !== 'linux' || process.arch !== arch) {
    throw new LinuxDebBuildError(
      `${arch} DEB must be built natively on linux/${arch}; this process is ${process.platform}/${process.arch}`,
    )
  }
}

export function resolveSourceDateEpoch(repoRoot, sourceCommit, env = process.env) {
  const raw = execFileSync('git', ['show', '-s', '--format=%ct', sourceCommit], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim()
  const sourceDateEpoch = Number(raw)
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
    throw new LinuxDebBuildError(`invalid source commit timestamp: ${raw}`)
  }
  if (env.SOURCE_DATE_EPOCH !== undefined && env.SOURCE_DATE_EPOCH !== raw) {
    throw new LinuxDebBuildError(
      `SOURCE_DATE_EPOCH mismatch: expected source commit timestamp ${raw}, got ${env.SOURCE_DATE_EPOCH}`,
    )
  }
  return sourceDateEpoch
}

function assertSourceInput(path, expectedSha256, label) {
  const actual = sha256File(path)
  if (actual !== expectedSha256) {
    throw new LinuxDebBuildError(
      `${label} SHA-256 mismatch: expected ${expectedSha256}, found ${actual}`,
    )
  }
}

function writePackageFile(root, relativePath, content, mode) {
  const path = join(root, ...relativePath.split('/'))
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  writeFileSync(path, content, { mode })
  chmodSync(path, mode)
  return path
}

function copyPackageFile(root, relativePath, source, mode) {
  const path = join(root, ...relativePath.split('/'))
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  copyFileSync(source, path)
  chmodSync(path, mode)
  return path
}

export function stageLinuxDebRoot({
  packageRoot,
  thinApp,
  icon,
  repoRoot,
  packageVersion,
  inputs,
  profile,
  sourceDateEpoch,
}) {
  const source = resolve(thinApp)
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new LinuxDebBuildError(`thin application must be a plain directory: ${source}`)
  }
  assertChromeSandboxInput(source)
  const destination = resolve(packageRoot)
  if (existsSync(destination)) throw new LinuxDebBuildError(`package root already exists: ${destination}`)
  mkdirSync(destination, { mode: 0o755 })
  chmodSync(destination, 0o755)

  const application = join(destination, ...inputs.layout.applicationDirectory.split('/'))
  mkdirSync(dirname(application), { recursive: true, mode: 0o755 })
  copyPlainTreeWithDeterministicModes(source, application)
  chmodSync(join(application, 'chrome-sandbox'), 0o4755)

  writePackageFile(destination, inputs.layout.binary, renderDebLauncher(inputs), 0o755)
  writePackageFile(destination, inputs.layout.desktopFile, renderDebDesktopEntry(inputs), 0o644)
  copyPackageFile(destination, inputs.layout.icon, icon, 0o644)
  copyPackageFile(destination, inputs.layout.copyright, join(repoRoot, 'LICENSE'), 0o644)
  copyPackageFile(destination, inputs.layout.electronLicense, join(source, 'LICENSE'), 0o644)
  copyPackageFile(
    destination,
    inputs.layout.chromiumLicenses,
    join(source, 'LICENSES.chromium.html'),
    0o644,
  )

  const installedSize = installedSizeKiB(destination)
  const controlDir = join(destination, 'DEBIAN')
  mkdirSync(controlDir, { mode: 0o755 })
  chmodSync(controlDir, 0o755)
  const control = renderDebControl(inputs, profile, packageVersion, installedSize)
  writePackageFile(destination, 'DEBIAN/control', control, 0o644)
  normalizeDirectoryModes(destination)
  normalizeTreeTimes(destination, sourceDateEpoch)
  return { packageRoot: destination, control, installedSize }
}

export function runDpkgDeb({
  packageRoot,
  output,
  inputs,
  sourceDateEpoch,
  home,
}) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  const env = {
    HOME: home,
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    TMPDIR: join(home, 'tmp'),
    TZ: 'UTC',
  }
  mkdirSync(env.TMPDIR, { mode: 0o700 })
  execFileSync('/bin/sh', [
    '-c',
    'umask 022; exec "$@"',
    'dpkg-deb',
    '/usr/bin/dpkg-deb',
    '--root-owner-group',
    '--uniform-compression',
    `-Z${inputs.dpkgDeb.compression}`,
    `-z${inputs.dpkgDeb.level}`,
    '--build',
    packageRoot,
    output,
  ], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
}

export async function buildLinuxDeb({
  arch = 'x64',
  app,
  outputDir,
  repoRoot,
  inputsPath,
  debInputsPath,
  force = false,
}) {
  assertLinuxHost(arch)
  const profile = resolveLinuxDebTarget(`linux-${arch}`)
  const root = resolve(repoRoot)
  const debInputsFile = resolve(debInputsPath ?? DEFAULT_LINUX_DEB_INPUTS)
  const debInputs = loadLinuxDebInputs(debInputsFile)
  const configuredProfile = debInputs.architectures[profile.target]
  if (
    configuredProfile.processArch !== profile.processArch ||
    configuredProfile.debArchitecture !== profile.debArchitecture
  ) {
    throw new LinuxDebBuildError(`DEB input target mismatch for ${profile.target}`)
  }
  const linuxInputsFile = resolve(inputsPath ?? join(root, debInputs.linuxInputs.path))
  const icon = resolve(root, debInputs.icon.path)
  assertSourceInput(linuxInputsFile, debInputs.linuxInputs.sha256, 'Linux release inputs')
  assertSourceInput(icon, debInputs.icon.sha256, 'DEB icon')
  loadLinuxReleaseInputs(linuxInputsFile)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  if (pkg.version !== lock.version) {
    throw new LinuxDebBuildError('package.json and package-lock.json versions differ')
  }
  const provenance = resolveSourceProvenance(root)
  const sourceDateEpoch = resolveSourceDateEpoch(root, provenance.sourceCommit)
  const thinVerification = verifyLinuxThinApp({
    app: resolve(app),
    arch,
    inputsPath: linuxInputsFile,
    sourceCommit: provenance.sourceCommit,
  })
  if (thinVerification.packageVersion !== pkg.version) {
    throw new LinuxDebBuildError(
      `thin application version mismatch: expected ${pkg.version}, found ${thinVerification.packageVersion}`,
    )
  }
  const dpkgDebVersion = assertPinnedDpkgDeb(profile, debInputs)
  const artifactFile = debArtifactName(pkg.version, arch)
  const destinationDir = resolve(outputDir)
  mkdirSync(destinationDir, { recursive: true })
  const work = mkdtempSync(join(destinationDir, '.linux-deb-'))
  try {
    const packageRoot = join(work, 'package')
    const staged = stageLinuxDebRoot({
      packageRoot,
      thinApp: app,
      icon,
      repoRoot: root,
      packageVersion: pkg.version,
      inputs: debInputs,
      profile,
      sourceDateEpoch,
    })
    const stagedDeb = join(work, artifactFile)
    const isolatedHome = join(work, 'home')
    mkdirSync(isolatedHome, { mode: 0o700 })
    runDpkgDeb({
      packageRoot,
      output: stagedDeb,
      inputs: debInputs,
      sourceDateEpoch,
      home: isolatedHome,
    })
    chmodSync(stagedDeb, 0o644)
    const verification = verifyLinuxDeb({
      arch,
      deb: stagedDeb,
      app: resolve(app),
      packageVersion: pkg.version,
      sourceCommit: provenance.sourceCommit,
      sourceDateEpoch,
      inputsPath: linuxInputsFile,
      debInputsPath: debInputsFile,
    })
    if (verification.innerAppTreeDigest !== thinVerification.appTreeDigest) {
      throw new LinuxDebBuildError(
        `packaged DEB application tree changed: expected ${thinVerification.appTreeDigest}, ` +
        `found ${verification.innerAppTreeDigest}`,
      )
    }
    const report = {
      ...verification,
      sourceCommit: provenance.sourceCommit,
      sourceDirty: provenance.sourceDirty,
      sourceDateEpoch,
      linuxInputsSha256: debInputs.linuxInputs.sha256,
      debInputsSha256: sha256File(debInputsFile),
      dpkgDeb: {
        version: debInputs.dpkgDeb.version,
        versionLine: dpkgDebVersion,
        compression: debInputs.dpkgDeb.compression,
        level: debInputs.dpkgDeb.level,
      },
      stagedInstalledSize: staged.installedSize,
    }
    const stagedChecksum = `${stagedDeb}.sha256`
    const stagedReport = `${stagedDeb}.report.json`
    writeFileSync(stagedChecksum, `${verification.debSha256}  ${artifactFile}\n`)
    writeFileSync(stagedReport, `${JSON.stringify(report, null, 2)}\n`)
    chmodSync(stagedChecksum, 0o644)
    chmodSync(stagedReport, 0o644)

    const destination = join(destinationDir, artifactFile)
    publishAtomically(stagedDeb, destination, force)
    publishAtomically(stagedChecksum, `${destination}.sha256`, force)
    publishAtomically(stagedReport, `${destination}.report.json`, force)
    if (sha256LargeFile(destination) !== verification.debSha256) {
      throw new LinuxDebBuildError('published DEB SHA-256 changed')
    }
    return { deb: destination, report }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export function buildLinuxX64Deb(options) {
  return buildLinuxDeb({ ...options, arch: 'x64' })
}

export function buildLinuxArm64Deb(options) {
  return buildLinuxDeb({ ...options, arch: 'arm64' })
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
      'deb-inputs': { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  if (!values.app || !values['output-dir']) {
    throw new LinuxDebBuildError(
      'usage: build-linux-deb.mjs --app <linux app folder> --output-dir <directory>',
    )
  }
  const result = await buildLinuxDeb({
    arch: values.arch,
    app: resolve(values.app),
    outputDir: resolve(values['output-dir']),
    repoRoot: resolve(values['repo-root']),
    inputsPath: values.inputs && resolve(values.inputs),
    debInputsPath: values['deb-inputs'] && resolve(values['deb-inputs']),
    force: Boolean(values.force),
  })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    deb: result.deb,
    sha256: result.report.debSha256,
  })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-linux-deb: ${err.message}\n`)
    process.exitCode = 1
  })
}
