#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { appImageArtifactName, renderAppRun, renderDesktopEntry } from './build-linux-appimage.mjs'
import {
  DEFAULT_LINUX_ARM64_APPIMAGE_INPUTS,
  DEFAULT_LINUX_APPIMAGE_INPUTS,
  loadLinuxAppImageInputs,
  resolveLinuxAppImageTarget,
  sha256File,
} from './linux-appimage-inputs.mjs'
import { assertBinaryCompatibility } from './linux-binary-gates.mjs'
import {
  DEFAULT_LINUX_RELEASE_INPUTS,
  loadLinuxReleaseInputs,
} from './linux-release-inputs.mjs'
import { treeIdentity } from './tree-identity.mjs'
import { verifyLinuxThinApp } from './verify-linux-thin-app.mjs'

const COMMIT_RE = /^[0-9a-f]{40}$/
const UNSQUASHFS = '/usr/bin/unsquashfs'
const UNSQUASHFS_VERSION = 'unsquashfs version 4.5 (2021/07/22)'

export class LinuxAppImageVerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxAppImageVerificationError'
  }
}

function assertLinuxHost(arch) {
  if (process.platform !== 'linux' || process.arch !== arch) {
    throw new LinuxAppImageVerificationError(
      `${arch} AppImage must be verified natively on linux/${arch}; this process is ${process.platform}/${process.arch}`,
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

function assertPlainFile(path, label) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LinuxAppImageVerificationError(`${label} must be a plain regular file: ${path}`)
  }
  return stat
}

function assertMode(path, expected, label) {
  const mode = lstatSync(path).mode & 0o7777
  if (mode !== expected) {
    throw new LinuxAppImageVerificationError(
      `${label} mode must be ${expected.toString(8)}, found ${mode.toString(8)}`,
    )
  }
  return mode
}

function countExtractedDirectories(directory) {
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LinuxAppImageVerificationError(`AppDir directory must be plain: ${directory}`)
  }
  let count = 1
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    const child = lstatSync(path)
    if (child.isDirectory()) {
      count += countExtractedDirectories(path)
    }
  }
  return count
}

function assertExactRootEntries(appDir) {
  const expected = ['.DirIcon', 'AppRun', 'agent-inbox.desktop', 'agent-inbox.png', 'usr']
  const actual = readdirSync(appDir).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new LinuxAppImageVerificationError(
      `AppImage root entries must be exactly ${expected.join(', ')}; found ${actual.join(', ')}`,
    )
  }
}

function assertAppImageMarker(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!fstatSync(fd).isFile()) {
      throw new LinuxAppImageVerificationError('AppImage artifact must remain a plain regular file')
    }
    const header = Buffer.alloc(11)
    if (
      readSync(fd, header, 0, header.length, 0) !== header.length ||
      header[8] !== 0x41 ||
      header[9] !== 0x49 ||
      header[10] !== 0x02
    ) {
      throw new LinuxAppImageVerificationError('artifact is not an AppImage type-2 image')
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readPrefix(path, size) {
  const buffer = Buffer.alloc(size)
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (readSync(fd, buffer, 0, size, 0) !== size) {
      throw new LinuxAppImageVerificationError('AppImage is shorter than the pinned type-2 runtime')
    }
    return buffer
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function octalMode(symbolic) {
  const permissions = symbolic.slice(1)
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
  let mode = 0
  for (let index = 0; index < permissions.length; index += 1) {
    const value = permissions[index]
    if (value !== '-' && !['S', 'T'].includes(value)) mode |= bits[index]
  }
  if (['s', 'S'].includes(permissions[2])) mode |= 0o4000
  if (['s', 'S'].includes(permissions[5])) mode |= 0o2000
  if (['t', 'T'].includes(permissions[8])) mode |= 0o1000
  return mode
}

export function verifySquashfsModes(listing, { expectedModes, privilegedPath }) {
  const paths = new Set()
  const modes = new Map()
  let directoryCount = 0
  let foundRoot = false
  for (const line of String(listing).split('\n')) {
    if (!line) continue
    const match = line.match(
      /^([bcdlps-][rwxSsTt-]{9}) \d+\/\d+\s+\d+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} (.+)$/,
    )
    if (!match) {
      throw new LinuxAppImageVerificationError(`invalid SquashFS metadata line: ${line}`)
    }
    const [, symbolic, path] = match
    if (paths.has(path)) {
      throw new LinuxAppImageVerificationError(`duplicate SquashFS path: ${path}`)
    }
    paths.add(path)
    const mode = octalMode(symbolic)
    modes.set(path, mode)
    if (symbolic.startsWith('d') && mode !== 0o755) {
      throw new LinuxAppImageVerificationError(
        `SquashFS directory ${path} mode must be 0755, found 0${mode.toString(8)}`,
      )
    }
    if (symbolic.startsWith('d')) {
      if (path === 'squashfs-root') foundRoot = true
      directoryCount += 1
    }
    if ((mode & 0o7000) !== 0 && path !== privilegedPath) {
      throw new LinuxAppImageVerificationError(
        `SquashFS path ${path} has unexpected privileged mode 0${mode.toString(8)}`,
      )
    }
  }
  if (!foundRoot || directoryCount === 0) {
    throw new LinuxAppImageVerificationError('SquashFS metadata is missing its root directory')
  }
  for (const [path, expected] of expectedModes) {
    const actual = modes.get(path)
    if (actual === undefined) {
      throw new LinuxAppImageVerificationError(`SquashFS metadata is missing required path ${path}`)
    }
    if (actual !== expected) {
      throw new LinuxAppImageVerificationError(
        `SquashFS path ${path} mode must be 0${expected.toString(8)}, found 0${actual.toString(8)}`,
      )
    }
  }
  return { directoryCount }
}

export function assertPinnedUnsquashfsVersion(result) {
  if (result.error) {
    throw new LinuxAppImageVerificationError(
      `could not run pinned unsquashfs: ${result.error.message}`,
    )
  }
  if (result.status !== 1) {
    throw new LinuxAppImageVerificationError(
      `unsquashfs -version exit status ${String(result.status)} is invalid`,
    )
  }
  if (result.stderr !== '') {
    throw new LinuxAppImageVerificationError('unsquashfs -version emitted unexpected stderr')
  }
  const version = result.stdout.split('\n')[0]
  if (version !== UNSQUASHFS_VERSION) {
    throw new LinuxAppImageVerificationError(
      `unsquashfs version must be exactly 4.5 (2021/07/22), found ${version}`,
    )
  }
}

function squashfsDirectoryCount(appImage, runtimeSize, inputs) {
  const toolStat = assertPlainFile(UNSQUASHFS, 'unsquashfs')
  if ((toolStat.mode & 0o111) === 0) {
    throw new LinuxAppImageVerificationError(`unsquashfs must be executable: ${UNSQUASHFS}`)
  }
  const version = spawnSync(UNSQUASHFS, ['-version'], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })
  assertPinnedUnsquashfsVersion(version)
  const listing = execFileSync(UNSQUASHFS, [
    '-lln',
    '-UTC',
    '-o',
    String(runtimeSize),
    appImage,
  ], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const applicationRoot = `squashfs-root/${inputs.layout.applicationPath}`
  return verifySquashfsModes(listing, {
    expectedModes: new Map([
      [`squashfs-root/${inputs.layout.appRun}`, 0o755],
      [`squashfs-root/${inputs.layout.desktopFile}`, 0o644],
      [`squashfs-root/${inputs.layout.iconFile}`, 0o644],
      [`${applicationRoot}/chrome-sandbox`, 0o4755],
    ]),
    privilegedPath: `${applicationRoot}/chrome-sandbox`,
  }).directoryCount
}

function safeElfNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LinuxAppImageVerificationError(`${label} exceeds the safe integer range`)
  }
  return Number(value)
}

function assertElfSpan(offset, size, total, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > total ||
    size > total - offset
  ) {
    throw new LinuxAppImageVerificationError(`${label} is out of bounds`)
  }
}

function elfSection(bytes, wantedName) {
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1
  ) {
    throw new LinuxAppImageVerificationError('pinned AppImage runtime must be 64-bit little-endian ELF')
  }
  const sectionTableOffset = safeElfNumber(bytes.readBigUInt64LE(0x28), 'ELF section table offset')
  const sectionEntrySize = bytes.readUInt16LE(0x3a)
  const sectionCount = bytes.readUInt16LE(0x3c)
  const namesIndex = bytes.readUInt16LE(0x3e)
  if (
    sectionEntrySize < 64 ||
    sectionCount === 0 ||
    namesIndex === 0 ||
    namesIndex >= sectionCount
  ) {
    throw new LinuxAppImageVerificationError('AppImage runtime has an invalid ELF section table')
  }
  assertElfSpan(
    sectionTableOffset,
    sectionEntrySize * sectionCount,
    bytes.length,
    'AppImage runtime ELF section table',
  )
  const header = (index) => sectionTableOffset + sectionEntrySize * index
  const namesHeader = header(namesIndex)
  if (bytes.readUInt32LE(namesHeader + 4) !== 3) {
    throw new LinuxAppImageVerificationError('AppImage runtime ELF names section is not a string table')
  }
  const namesOffset = safeElfNumber(bytes.readBigUInt64LE(namesHeader + 0x18), 'ELF names offset')
  const namesSize = safeElfNumber(bytes.readBigUInt64LE(namesHeader + 0x20), 'ELF names size')
  assertElfSpan(namesOffset, namesSize, bytes.length, 'AppImage runtime ELF names table')
  let found
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionHeader = header(index)
    const nameOffset = bytes.readUInt32LE(sectionHeader)
    if (nameOffset >= namesSize) {
      throw new LinuxAppImageVerificationError('AppImage runtime ELF section name is out of bounds')
    }
    const nameEnd = bytes.indexOf(0, namesOffset + nameOffset)
    if (nameEnd < 0 || nameEnd >= namesOffset + namesSize) {
      throw new LinuxAppImageVerificationError('AppImage runtime ELF section name is invalid')
    }
    const name = bytes.toString('utf8', namesOffset + nameOffset, nameEnd)
    if (name !== wantedName) continue
    const offset = safeElfNumber(bytes.readBigUInt64LE(sectionHeader + 0x18), `${name} offset`)
    const size = safeElfNumber(bytes.readBigUInt64LE(sectionHeader + 0x20), `${name} size`)
    assertElfSpan(offset, size, bytes.length, `${name} section`)
    if (found) {
      throw new LinuxAppImageVerificationError(`AppImage runtime has duplicate ${wantedName} sections`)
    }
    found = { offset, size }
  }
  if (found) return found
  throw new LinuxAppImageVerificationError(`AppImage runtime is missing ${wantedName}`)
}

export function verifyNormalizedRuntimePrefix(path, runtime) {
  const prefix = readPrefix(path, runtime.size)
  const rawSha256 = createHash('sha256').update(prefix).digest('hex')
  const digestSection = elfSection(prefix, '.digest_md5')
  if (digestSection.size !== 16) {
    throw new LinuxAppImageVerificationError(
      `.digest_md5 size must be 16 bytes, found ${digestSection.size}`,
    )
  }
  const embeddedDigestMd5 = prefix
    .subarray(digestSection.offset, digestSection.offset + digestSection.size)
    .toString('hex')
  if (/^0+$/.test(embeddedDigestMd5)) {
    throw new LinuxAppImageVerificationError('AppImage runtime has no embedded MD5 digest')
  }
  prefix.fill(0, digestSection.offset, digestSection.offset + digestSection.size)
  const normalizedSha256 = createHash('sha256').update(prefix).digest('hex')
  if (normalizedSha256 !== runtime.sha256) {
    throw new LinuxAppImageVerificationError(
      `normalized AppImage runtime SHA-256 mismatch: expected ${runtime.sha256}, found ${normalizedSha256}`,
    )
  }
  return {
    rawSha256,
    normalizedSha256,
    embeddedDigestMd5,
    digestSection,
  }
}

export function extractAppImage(appImage) {
  const work = mkdtempSync(join(tmpdir(), 'verify-appimage-'))
  try {
    execFileSync('/bin/sh', [
      '-c',
      'umask 000; exec "$1" --appimage-extract',
      'appimage-extract',
      appImage,
    ], {
      cwd: work,
      env: {
        ...process.env,
        HOME: join(work, 'home'),
        LC_ALL: 'C',
        TZ: 'UTC',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const extracted = join(work, 'squashfs-root')
    if (!existsSync(extracted) || !lstatSync(extracted).isDirectory()) {
      throw new LinuxAppImageVerificationError('AppImage extraction did not produce squashfs-root')
    }
    return {
      appDir: extracted,
      cleanup: () => rmSync(work, { recursive: true, force: true }),
    }
  } catch (err) {
    rmSync(work, { recursive: true, force: true })
    throw err
  }
}

function verifyChecksumFile(path, artifactFile, expectedSha256) {
  const expected = `${expectedSha256}  ${artifactFile}\n`
  const actual = readFileSync(path, 'utf8')
  if (actual !== expected) {
    throw new LinuxAppImageVerificationError(`checksum sidecar does not match exact final AppImage bytes`)
  }
}

export function verifyLinuxAppImage({
  arch = 'x64',
  appImage,
  packageVersion,
  sourceCommit,
  inputsPath,
  appImageInputsPath,
  checksum,
}) {
  assertLinuxHost(arch)
  const profile = profileForArch(arch)
  if (!COMMIT_RE.test(sourceCommit)) {
    throw new LinuxAppImageVerificationError('sourceCommit must be a full lowercase Git SHA')
  }
  const artifact = resolve(appImage)
  const artifactFile = appImageArtifactName(packageVersion, arch)
  if (basename(artifact) !== artifactFile) {
    throw new LinuxAppImageVerificationError(
      `AppImage filename mismatch: expected ${artifactFile}, found ${basename(artifact)}`,
    )
  }
  const stat = assertPlainFile(artifact, 'AppImage artifact')
  assertMode(artifact, 0o755, 'AppImage artifact')
  try {
    accessSync(artifact, constants.X_OK)
  } catch (err) {
    throw new LinuxAppImageVerificationError(`AppImage artifact is not executable: ${err.message}`)
  }
  assertAppImageMarker(artifact)

  const appImageInputsFile = resolve(appImageInputsPath ?? defaultInputsForArch(arch))
  const linuxInputsFile = resolve(inputsPath ?? DEFAULT_LINUX_RELEASE_INPUTS)
  const appImageInputs = loadLinuxAppImageInputs(appImageInputsFile)
  if (appImageInputs.target !== profile.target) {
    throw new LinuxAppImageVerificationError(
      `AppImage input target mismatch: expected ${profile.target}, found ${appImageInputs.target}`,
    )
  }
  const linuxInputsSha256 = sha256File(linuxInputsFile)
  if (linuxInputsSha256 !== appImageInputs.linuxInputs.sha256) {
    throw new LinuxAppImageVerificationError(
      `Linux release inputs SHA-256 mismatch: expected ${appImageInputs.linuxInputs.sha256}, found ${linuxInputsSha256}`,
    )
  }
  const linuxInputs = loadLinuxReleaseInputs(linuxInputsFile)
  const runtimePrefix = verifyNormalizedRuntimePrefix(artifact, appImageInputs.runtime)
  const outerCompatibility = assertBinaryCompatibility({
    path: artifact,
    label: 'AppImage runtime',
    arch,
    maximumGlibcVersion: linuxInputs.minimumGlibcVersion,
    maximumLibstdcxxVersion: linuxInputs.maximumGlibcxxVersion,
    byteLength: appImageInputs.runtime.size,
  })
  const appImageSha256 = sha256File(artifact)
  if (checksum) verifyChecksumFile(resolve(checksum), artifactFile, appImageSha256)
  const appDirDirectoryCount = squashfsDirectoryCount(
    artifact,
    appImageInputs.runtime.size,
    appImageInputs,
  )

  const extracted = extractAppImage(artifact)
  try {
    assertExactRootEntries(extracted.appDir)
    const extractedDirectoryCount = countExtractedDirectories(extracted.appDir)
    if (extractedDirectoryCount !== appDirDirectoryCount) {
      throw new LinuxAppImageVerificationError(
        `extracted directory count mismatch: expected ${appDirDirectoryCount}, found ${extractedDirectoryCount}`,
      )
    }
    const dirIcon = join(extracted.appDir, '.DirIcon')
    if (!lstatSync(dirIcon).isSymbolicLink() || readlinkSync(dirIcon) !== appImageInputs.layout.iconFile) {
      throw new LinuxAppImageVerificationError('.DirIcon must link exactly to agent-inbox.png')
    }
    const appRun = join(extracted.appDir, appImageInputs.layout.appRun)
    assertPlainFile(appRun, 'AppRun')
    if (readFileSync(appRun, 'utf8') !== renderAppRun(appImageInputs)) {
      throw new LinuxAppImageVerificationError('AppRun content does not match the pinned launcher')
    }
    const desktop = join(extracted.appDir, appImageInputs.layout.desktopFile)
    assertPlainFile(desktop, 'desktop metadata')
    if (readFileSync(desktop, 'utf8') !== renderDesktopEntry(appImageInputs, packageVersion)) {
      throw new LinuxAppImageVerificationError('desktop metadata does not match the pinned package contract')
    }
    const icon = join(extracted.appDir, appImageInputs.layout.iconFile)
    assertPlainFile(icon, 'AppImage icon')
    if (sha256File(icon) !== appImageInputs.icon.sha256) {
      throw new LinuxAppImageVerificationError('packaged AppImage icon SHA-256 mismatch')
    }

    const innerApp = join(
      extracted.appDir,
      ...appImageInputs.layout.applicationPath.split('/'),
    )
    const sandbox = join(innerApp, 'chrome-sandbox')
    assertPlainFile(sandbox, 'chrome-sandbox')
    const thinVerification = verifyLinuxThinApp({
      app: innerApp,
      arch,
      inputsPath: linuxInputsFile,
      sourceCommit,
    })
    return {
      schema: 1,
      product: linuxInputs.product,
      packageVersion,
      artifactFile,
      artifactArchitecture: appImageInputs.artifactArchitecture,
      linuxInputsSha256,
      appImageType: 2,
      appImageSize: stat.size,
      appImageSha256,
      runtimePrefixSha256: runtimePrefix.rawSha256,
      normalizedRuntimeSha256: runtimePrefix.normalizedSha256,
      embeddedDigestMd5: runtimePrefix.embeddedDigestMd5,
      runtimeDigestSection: runtimePrefix.digestSection,
      executableMode: stat.mode & 0o777,
      appDirDirectoryMode: 0o755,
      appDirDirectoryCount,
      appRunMode: 0o755,
      desktopMode: 0o644,
      iconMode: 0o644,
      chromeSandboxMode: 0o4755,
      outerCompatibility,
      appDirTreeDigest: treeIdentity(extracted.appDir),
      desktopFile: appImageInputs.layout.desktopFile,
      iconFile: appImageInputs.layout.iconFile,
      setupRuntimeKeys: thinVerification.setupRuntimeKeys,
      innerAppTreeDigest: thinVerification.appTreeDigest,
      compatibility: thinVerification.compatibility,
      electronVersion: thinVerification.electronVersion,
      electronModulesAbi: thinVerification.electronModulesAbi,
      nodeVersion: thinVerification.nodeVersion,
      nodeModulesAbi: thinVerification.nodeModulesAbi,
      nativeAddonSelftests: thinVerification.nativeAddonSelftests,
      exactHostSetupSelection: thinVerification.exactHostSetupSelection,
    }
  } finally {
    extracted.cleanup()
  }
}

export function verifyLinuxX64AppImage(options) {
  return verifyLinuxAppImage({ ...options, arch: 'x64' })
}

export function verifyLinuxArm64AppImage(options) {
  return verifyLinuxAppImage({ ...options, arch: 'arm64' })
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      appimage: { type: 'string' },
      arch: { type: 'string', default: 'x64' },
      version: { type: 'string' },
      'source-commit': { type: 'string' },
      inputs: { type: 'string' },
      'appimage-inputs': { type: 'string' },
      checksum: { type: 'string' },
    },
  })
  if (!values.appimage || !values.version || !values['source-commit']) {
    throw new LinuxAppImageVerificationError(
      'usage: verify-linux-appimage.mjs --appimage <path> --version <version> --source-commit <sha>',
    )
  }
  const report = verifyLinuxAppImage({
    arch: values.arch,
    appImage: resolve(values.appimage),
    packageVersion: values.version,
    sourceCommit: values['source-commit'],
    inputsPath: values.inputs && resolve(values.inputs),
    appImageInputsPath: values['appimage-inputs'] && resolve(values['appimage-inputs']),
    checksum: values.checksum && resolve(values.checksum),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`verify-linux-appimage: ${err.message}\n`)
    process.exitCode = 1
  }
}
