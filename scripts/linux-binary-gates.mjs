import { lstatSync, readFileSync } from 'node:fs'

const ELF_MACHINE = Object.freeze({
  62: 'x64',
  183: 'arm64',
})

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
  return readFileSync(path)
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

export function readElfArchitecture(path, label = 'ELF binary') {
  const bytes = readPlainFile(path, label)
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

export function assertBinaryCompatibility({
  path,
  label,
  arch,
  maximumGlibcVersion,
  maximumLibstdcxxVersion,
}) {
  const actualArch = readElfArchitecture(path, label)
  if (actualArch !== arch) {
    throw new LinuxBinaryGateError(`${label} architecture mismatch: found ${actualArch}, expected ${arch}`)
  }
  const bytes = readPlainFile(path, label)
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
