#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  parseArArchive,
  parseTarArchive,
  readArMember,
  sha256LargeFile,
  withDebTarFile,
} from './linux-deb-archive.mjs'
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
import { DEFAULT_LINUX_RELEASE_INPUTS, loadLinuxReleaseInputs } from './linux-release-inputs.mjs'
import { treeIdentity } from './tree-identity.mjs'
import { verifyLinuxThinApp } from './verify-linux-thin-app.mjs'

const COMMIT_RE = /^[0-9a-f]{40}$/

export class LinuxDebVerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxDebVerificationError'
  }
}

function assertLinuxHost(arch) {
  if (process.platform !== 'linux' || process.arch !== arch) {
    throw new LinuxDebVerificationError(
      `${arch} DEB must be verified natively on linux/${arch}; this process is ${process.platform}/${process.arch}`,
    )
  }
}

function assertPlainFile(path, label) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LinuxDebVerificationError(`${label} must be a plain regular file: ${path}`)
  }
  return stat
}

function assertMode(path, expected, label) {
  const actual = lstatSync(path).mode & 0o7777
  if (actual !== expected) {
    throw new LinuxDebVerificationError(
      `${label} mode mismatch: expected 0${expected.toString(8)}, found 0${actual.toString(8)}`,
    )
  }
}

function deriveSourceDateEpoch(repoRoot, sourceCommit) {
  const raw = execFileSync('git', ['show', '-s', '--format=%ct', sourceCommit], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim()
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LinuxDebVerificationError(`invalid source commit timestamp: ${raw}`)
  }
  return value
}

function assertArchiveHeaderMetadata(headers, sourceDateEpoch, label) {
  for (const header of headers) {
    if (
      header.uid !== 0 ||
      header.gid !== 0 ||
      header.uname !== 'root' ||
      header.gname !== 'root'
    ) {
      throw new LinuxDebVerificationError(`${label} entry ${header.path} is not owned by root:root`)
    }
    if (header.type === 'L' || header.type === 'K') {
      if (header.path !== '././@LongLink' || header.mode !== 0o644 || header.mtime !== 0) {
        throw new LinuxDebVerificationError(`${label} GNU long-name metadata is noncanonical`)
      }
      continue
    }
    if (header.type === 'x') {
      throw new LinuxDebVerificationError(`${label} contains unexpected PAX metadata`)
    }
    if (header.mtime !== sourceDateEpoch) {
      throw new LinuxDebVerificationError(
        `${label} entry ${header.path} timestamp mismatch: expected ${sourceDateEpoch}, ` +
        `found ${header.mtime}`,
      )
    }
  }
}

function expectedAncestors(paths) {
  const directories = new Set(['.'])
  for (const path of paths) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'))
    }
  }
  return directories
}

function entryMap(entries, label) {
  const map = new Map()
  for (const entry of entries) {
    if (map.has(entry.path)) throw new LinuxDebVerificationError(`${label} has duplicate ${entry.path}`)
    map.set(entry.path, entry)
  }
  return map
}

function verifyChecksumFile(path, artifactFile, expectedSha256) {
  const expected = `${expectedSha256}  ${artifactFile}\n`
  if (readFileSync(path, 'utf8') !== expected) {
    throw new LinuxDebVerificationError('checksum sidecar does not match exact final DEB bytes')
  }
}

export function verifyDataEntries({ entries, headers, inputs, sourceDateEpoch }) {
  assertArchiveHeaderMetadata(headers, sourceDateEpoch, 'data tar')
  const map = entryMap(entries, 'data tar')
  const fixedFiles = [
    inputs.layout.binary,
    inputs.layout.desktopFile,
    inputs.layout.icon,
    inputs.layout.copyright,
    inputs.layout.electronLicense,
    inputs.layout.chromiumLicenses,
  ]
  const ancestors = expectedAncestors([...fixedFiles, inputs.layout.applicationDirectory])
  const requiredDirectories = new Set([...ancestors, inputs.layout.applicationDirectory])
  const sandboxPath = `${inputs.layout.applicationDirectory}/chrome-sandbox`
  for (const entry of entries) {
    const insideApplication =
      entry.path === inputs.layout.applicationDirectory ||
      entry.path.startsWith(`${inputs.layout.applicationDirectory}/`)
    if (!insideApplication && !fixedFiles.includes(entry.path) && !ancestors.has(entry.path)) {
      throw new LinuxDebVerificationError(`data tar contains unexpected path: ${entry.path}`)
    }
    if (entry.uid !== 0 || entry.gid !== 0 || entry.uname !== 'root' || entry.gname !== 'root') {
      throw new LinuxDebVerificationError(`data tar entry ${entry.path} is not root:root`)
    }
    if (entry.mtime !== sourceDateEpoch) {
      throw new LinuxDebVerificationError(`data tar entry ${entry.path} has the wrong timestamp`)
    }
    if (entry.type === '5' && entry.mode !== 0o755) {
      throw new LinuxDebVerificationError(`data directory ${entry.path} must have mode 0755`)
    }
    if (entry.type === '2' && entry.mode !== 0o777) {
      throw new LinuxDebVerificationError(`data symlink ${entry.path} must have mode 0777`)
    }
    const privileged = entry.mode & 0o7000
    if (entry.path === sandboxPath) {
      if (entry.type !== '0' || entry.mode !== 0o4755) {
        throw new LinuxDebVerificationError('chrome-sandbox must be the sole root-owned 04755 file')
      }
    } else if (privileged !== 0) {
      throw new LinuxDebVerificationError(`unexpected privileged DEB entry: ${entry.path}`)
    }
    if (entry.type === '0' && entry.path !== sandboxPath && ![0o644, 0o755].includes(entry.mode)) {
      throw new LinuxDebVerificationError(
        `data file has non-distributable mode: ${entry.path} ` +
        `(expected 0644 or 0755, found 0${entry.mode.toString(8)})`,
      )
    }
  }
  for (const path of fixedFiles) {
    const entry = map.get(path)
    if (!entry || entry.type !== '0') {
      throw new LinuxDebVerificationError(`data tar is missing required plain file: ${path}`)
    }
  }
  for (const path of requiredDirectories) {
    const entry = map.get(path)
    if (!entry || entry.type !== '5' || entry.mode !== 0o755) {
      throw new LinuxDebVerificationError(`data tar directory must be plain mode 0755: ${path}`)
    }
  }
  const sandbox = map.get(sandboxPath)
  if (!sandbox || sandbox.type !== '0' || sandbox.mode !== 0o4755) {
    throw new LinuxDebVerificationError('data tar is missing the root-owned mode 04755 chrome-sandbox')
  }
  if (map.get(inputs.layout.binary)?.mode !== 0o755) {
    throw new LinuxDebVerificationError('DEB launcher mode must be 0755')
  }
  for (const path of fixedFiles.slice(1)) {
    if (map.get(path)?.mode !== 0o644) {
      throw new LinuxDebVerificationError(`DEB metadata mode must be 0644: ${path}`)
    }
  }
  return map
}

function extractDeb(deb) {
  const work = mkdtempSync(join(tmpdir(), 'verify-linux-deb-'))
  const root = join(work, 'root')
  try {
    execFileSync('/bin/sh', [
      '-c',
      'umask 000; exec "$@"',
      'dpkg-deb-extract',
      '/usr/bin/dpkg-deb',
      '--extract',
      deb,
      root,
    ], {
      env: { LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { root, cleanup: () => rmSync(work, { recursive: true, force: true }) }
  } catch (err) {
    rmSync(work, { recursive: true, force: true })
    throw err
  }
}

function packageFileContent(map, path) {
  const content = map.get(path)?.content
  if (!content) throw new LinuxDebVerificationError(`captured package file is missing: ${path}`)
  return content
}

export function verifyLinuxDeb({
  arch = 'x64',
  deb,
  app,
  packageVersion,
  sourceCommit,
  sourceDateEpoch,
  inputsPath,
  debInputsPath,
  checksum,
}) {
  assertLinuxHost(arch)
  if (!COMMIT_RE.test(sourceCommit)) {
    throw new LinuxDebVerificationError('sourceCommit must be a full lowercase Git SHA')
  }
  const profile = resolveLinuxDebTarget(`linux-${arch}`)
  const debInputsFile = resolve(debInputsPath ?? DEFAULT_LINUX_DEB_INPUTS)
  const linuxInputsFile = resolve(inputsPath ?? DEFAULT_LINUX_RELEASE_INPUTS)
  const inputs = loadLinuxDebInputs(debInputsFile)
  loadLinuxReleaseInputs(linuxInputsFile)
  if (sha256File(linuxInputsFile) !== inputs.linuxInputs.sha256) {
    throw new LinuxDebVerificationError('Linux release inputs SHA-256 mismatch')
  }
  const epoch = sourceDateEpoch ?? deriveSourceDateEpoch(resolve(import.meta.dirname, '..'), sourceCommit)
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new LinuxDebVerificationError('sourceDateEpoch must be a positive integer')
  }
  assertPinnedDpkgDeb(profile, inputs)

  const artifact = resolve(deb)
  const artifactFile = debArtifactName(packageVersion, arch)
  if (basename(artifact) !== artifactFile) {
    throw new LinuxDebVerificationError(
      `DEB filename mismatch: expected ${artifactFile}, found ${basename(artifact)}`,
    )
  }
  const stat = assertPlainFile(artifact, 'DEB artifact')
  assertMode(artifact, 0o644, 'DEB artifact')
  const debSha256 = sha256LargeFile(artifact)
  if (checksum) verifyChecksumFile(resolve(checksum), artifactFile, debSha256)

  const members = parseArArchive(artifact)
  if (
    JSON.stringify(members.map(({ name }) => name)) !==
    JSON.stringify(['debian-binary', 'control.tar.xz', 'data.tar.xz'])
  ) {
    throw new LinuxDebVerificationError('DEB ar members must be exactly debian-binary, control.tar.xz, data.tar.xz')
  }
  for (const member of members) {
    if (
      member.timestamp !== epoch ||
      member.uid !== 0 ||
      member.gid !== 0 ||
      member.mode !== 0o100644
    ) {
      throw new LinuxDebVerificationError(`DEB ar member metadata mismatch: ${member.name}`)
    }
  }
  const binaryMember = members[0]
  const controlMember = members[1]
  const dataMember = members[2]
  if (!binaryMember || !controlMember || !dataMember) {
    throw new LinuxDebVerificationError('DEB ar members are incomplete')
  }
  if (!readArMember(artifact, binaryMember).equals(Buffer.from('2.0\n'))) {
    throw new LinuxDebVerificationError('debian-binary must contain exactly 2.0')
  }

  const capturedDataPaths = [
    inputs.layout.binary,
    inputs.layout.desktopFile,
    inputs.layout.icon,
    inputs.layout.copyright,
    inputs.layout.electronLicense,
    inputs.layout.chromiumLicenses,
  ]
  const data = withDebTarFile({ deb: artifact, member: 'data' }, (tar) =>
    parseTarArchive(tar, { capturePaths: capturedDataPaths }))
  const dataMap = verifyDataEntries({
    entries: data.entries,
    headers: data.headers,
    inputs,
    sourceDateEpoch: epoch,
  })
  const installedSize = Math.max(
    1,
    Math.ceil(data.entries.reduce(
      (total, entry) => total + (entry.type === '0' ? entry.size : 0),
      0,
    ) / 1024),
  )
  const expectedControl = renderDebControl(inputs, profile, packageVersion, installedSize)
  const control = withDebTarFile({ deb: artifact, member: 'control' }, (tar) =>
    parseTarArchive(tar, { capturePaths: ['control'] }))
  assertArchiveHeaderMetadata(control.headers, epoch, 'control tar')
  if (
    JSON.stringify(control.entries.map(({ path, type, mode }) => ({ path, type, mode }))) !==
    JSON.stringify([
      { path: '.', type: '5', mode: 0o755 },
      { path: 'control', type: '0', mode: 0o644 },
    ])
  ) {
    throw new LinuxDebVerificationError('control tar layout must be exactly root plus control')
  }
  const controlMap = entryMap(control.entries, 'control tar')
  if (packageFileContent(controlMap, 'control').toString('utf8') !== expectedControl) {
    throw new LinuxDebVerificationError('DEB control metadata does not match the pinned contract')
  }
  if (packageFileContent(dataMap, inputs.layout.binary).toString('utf8') !== renderDebLauncher(inputs)) {
    throw new LinuxDebVerificationError('DEB launcher does not match the pinned contract')
  }
  if (
    packageFileContent(dataMap, inputs.layout.desktopFile).toString('utf8') !==
    renderDebDesktopEntry(inputs)
  ) {
    throw new LinuxDebVerificationError('DEB desktop metadata does not match the pinned contract')
  }
  if (createHash('sha256').update(packageFileContent(dataMap, inputs.layout.icon)).digest('hex') !== inputs.icon.sha256) {
    throw new LinuxDebVerificationError('packaged DEB icon SHA-256 mismatch')
  }
  const repoRoot = resolve(import.meta.dirname, '..')
  if (!packageFileContent(dataMap, inputs.layout.copyright).equals(readFileSync(join(repoRoot, 'LICENSE')))) {
    throw new LinuxDebVerificationError('packaged Agent Inbox copyright does not match LICENSE')
  }

  const extracted = extractDeb(artifact)
  try {
    const extractedApp = join(extracted.root, ...inputs.layout.applicationDirectory.split('/'))
    const thinVerification = verifyLinuxThinApp({
      app: extractedApp,
      arch,
      inputsPath: linuxInputsFile,
      sourceCommit,
    })
    if (
      !packageFileContent(dataMap, inputs.layout.electronLicense)
        .equals(readFileSync(join(extractedApp, 'LICENSE'))) ||
      !packageFileContent(dataMap, inputs.layout.chromiumLicenses)
        .equals(readFileSync(join(extractedApp, 'LICENSES.chromium.html')))
    ) {
      throw new LinuxDebVerificationError('packaged upstream notices do not match the Electron folder')
    }
    if (installedSizeKiB(extracted.root) !== installedSize) {
      throw new LinuxDebVerificationError('extracted Installed-Size identity changed')
    }
    let sourceAppTreeDigest
    if (app) {
      sourceAppTreeDigest = verifyLinuxThinApp({
        app: resolve(app),
        arch,
        inputsPath: linuxInputsFile,
        sourceCommit,
      }).appTreeDigest
      if (sourceAppTreeDigest !== thinVerification.appTreeDigest) {
        throw new LinuxDebVerificationError(
          `packaged DEB application tree mismatch: expected ${sourceAppTreeDigest}, ` +
          `found ${thinVerification.appTreeDigest}`,
        )
      }
    }
    return {
      schema: 1,
      product: 'Agent Inbox',
      packageVersion,
      artifactFile,
      arch,
      debArchitecture: profile.debArchitecture,
      debSize: stat.size,
      debSha256,
      sourceDateEpoch: epoch,
      arMembers: members.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
      controlTarSha256: controlMember.sha256,
      dataTarSha256: dataMember.sha256,
      controlSha256: controlMap.get('control')?.sha256,
      dataEntryCount: data.entries.length,
      installedSize,
      packageTreeDigest: treeIdentity(extracted.root),
      innerAppTreeDigest: thinVerification.appTreeDigest,
      sourceAppTreeDigest,
      chromeSandboxMode: dataMap.get(
        `${inputs.layout.applicationDirectory}/chrome-sandbox`,
      )?.mode,
      setupRuntimeKeys: thinVerification.setupRuntimeKeys,
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

export function verifyLinuxX64Deb(options) {
  return verifyLinuxDeb({ ...options, arch: 'x64' })
}

export function verifyLinuxArm64Deb(options) {
  return verifyLinuxDeb({ ...options, arch: 'arm64' })
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      deb: { type: 'string' },
      app: { type: 'string' },
      arch: { type: 'string', default: 'x64' },
      version: { type: 'string' },
      'source-commit': { type: 'string' },
      'source-date-epoch': { type: 'string' },
      inputs: { type: 'string' },
      'deb-inputs': { type: 'string' },
      checksum: { type: 'string' },
    },
  })
  if (!values.deb || !values.version || !values['source-commit']) {
    throw new LinuxDebVerificationError(
      'usage: verify-linux-deb.mjs --deb <path> --version <version> --source-commit <sha>',
    )
  }
  const report = verifyLinuxDeb({
    arch: values.arch,
    deb: resolve(values.deb),
    app: values.app && resolve(values.app),
    packageVersion: values.version,
    sourceCommit: values['source-commit'],
    sourceDateEpoch: values['source-date-epoch'] && Number(values['source-date-epoch']),
    inputsPath: values.inputs && resolve(values.inputs),
    debInputsPath: values['deb-inputs'] && resolve(values['deb-inputs']),
    checksum: values.checksum && resolve(values.checksum),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`verify-linux-deb: ${err.message}\n`)
    process.exitCode = 1
  }
}
