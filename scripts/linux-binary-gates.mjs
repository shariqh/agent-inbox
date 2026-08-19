import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const ELF_MACHINE = Object.freeze({
  62: 'x64',
  183: 'arm64',
})
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0

export class LinuxBinaryGateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxBinaryGateError'
  }
}

function readPlainFile(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (err) {
    throw new LinuxBinaryGateError(`${label} is missing at ${path}: ${err.message}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LinuxBinaryGateError(`${label} must be a plain regular file: ${path}`)
  }
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!fstatSync(fd).isFile()) {
      throw new LinuxBinaryGateError(`${label} must remain a plain regular file: ${path}`)
    }
    return readFileSync(fd)
  } catch (err) {
    if (err instanceof LinuxBinaryGateError) throw err
    throw new LinuxBinaryGateError(`${label} could not be read without following links at ${path}: ${err.message}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function hasElfMagic(path, label) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!fstatSync(fd).isFile()) {
      throw new LinuxBinaryGateError(`${label} must remain a plain regular file: ${path}`)
    }
    const header = Buffer.alloc(4)
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return false
    return header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46
  } catch (err) {
    if (err instanceof LinuxBinaryGateError) throw err
    throw new LinuxBinaryGateError(`${label} could not be inspected without following links at ${path}: ${err.message}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function versionParts(version) {
  return String(version).split('.').map((part) => Number(part))
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function maximumVersion(buffer, pattern) {
  const versions = [...buffer.toString('latin1').matchAll(pattern)].map((match) => match[1])
  return versions.sort(compareVersions).at(-1) ?? null
}

function elfArchitecture(bytes, path, label) {
  if (
    bytes.length < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46
  ) {
    throw new LinuxBinaryGateError(`${label} is not an ELF binary: ${path}`)
  }
  if (bytes[4] !== 2) throw new LinuxBinaryGateError(`${label} is not a 64-bit ELF binary: ${path}`)
  const littleEndian = bytes[5] === 1
  const bigEndian = bytes[5] === 2
  if (!littleEndian && !bigEndian) {
    throw new LinuxBinaryGateError(`${label} has an unsupported ELF byte order: ${path}`)
  }
  const machine = littleEndian ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18)
  const arch = ELF_MACHINE[machine]
  if (!arch) throw new LinuxBinaryGateError(`${label} has unsupported ELF machine ${machine}: ${path}`)
  return arch
}

export function readElfArchitecture(path, label = 'ELF binary') {
  return elfArchitecture(readPlainFile(path, label), path, label)
}

export function assertBinaryCompatibility({
  path,
  label,
  arch,
  maximumGlibcVersion,
  maximumLibstdcxxVersion,
}) {
  const bytes = readPlainFile(path, label)
  const actualArch = elfArchitecture(bytes, path, label)
  if (actualArch !== arch) {
    throw new LinuxBinaryGateError(`${label} architecture mismatch: found ${actualArch}, expected ${arch}`)
  }
  const maximumRequiredGlibc = maximumVersion(bytes, /GLIBC_(\d+\.\d+(?:\.\d+)?)/g)
  const maximumRequiredLibstdcxx = maximumVersion(bytes, /GLIBCXX_(\d+\.\d+(?:\.\d+)?)/g)
  if (maximumRequiredGlibc && compareVersions(maximumRequiredGlibc, maximumGlibcVersion) > 0) {
    throw new LinuxBinaryGateError(
      `${label} requires GLIBC_${maximumRequiredGlibc}, above the pinned ${maximumGlibcVersion} floor`,
    )
  }
  if (maximumRequiredLibstdcxx && compareVersions(maximumRequiredLibstdcxx, maximumLibstdcxxVersion) > 0) {
    throw new LinuxBinaryGateError(
      `${label} requires GLIBCXX_${maximumRequiredLibstdcxx}, above the pinned ${maximumLibstdcxxVersion} floor`,
    )
  }
  return {
    arch: actualArch,
    maximumRequiredGlibc,
    maximumRequiredLibstdcxx,
  }
}

export function listPlainElfFiles(root) {
  const rootPath = resolve(root)
  let rootStat
  try {
    rootStat = lstatSync(rootPath)
  } catch (err) {
    throw new LinuxBinaryGateError(`packaged app folder is missing at ${rootPath}: ${err.message}`)
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new LinuxBinaryGateError(`packaged app folder must be a plain directory: ${rootPath}`)
  }

  const files = []
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        visit(path)
        continue
      }
      if (!stat.isFile() || !hasElfMagic(path, `packaged file ${entry.name}`)) continue
      const relativePath = relative(rootPath, path)
      if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
        throw new LinuxBinaryGateError(`packaged ELF escaped the app folder: ${path}`)
      }
      files.push({
        path,
        relativePath: relativePath.split(sep).join('/'),
      })
    }
  }
  visit(rootPath)
  return files.sort((left, right) => compareText(left.relativePath, right.relativePath))
}

export function assertElfTreeCompatibility({
  root,
  arch,
  maximumGlibcVersion,
  maximumLibstdcxxVersion,
}) {
  return listPlainElfFiles(root).map(({ path, relativePath }) => ({
    path: relativePath,
    ...assertBinaryCompatibility({
      path,
      label: `packaged ELF ${relativePath}`,
      arch,
      maximumGlibcVersion,
      maximumLibstdcxxVersion,
    }),
  }))
}

export function assertProcessIdentity({ actual, expected, label }) {
  for (const [field, wanted] of Object.entries(expected)) {
    const found = actual?.[field]
    if (found !== wanted) {
      const display = field === 'modulesAbi' ? 'modules ABI' : field
      throw new LinuxBinaryGateError(`${label} ${display} mismatch: found ${String(found)}, expected ${wanted}`)
    }
  }
  return actual
}
