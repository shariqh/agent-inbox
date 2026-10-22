// Pure-Node PE (Portable Executable) parser and whole-tree binary gate for the
// Windows x64 packaged app, mirroring scripts/linux-binary-gates.mjs's shape:
// plain-file reads (no symlink/junction/reparse-like following), a DOS/COFF/
// optional-header parser strict enough to accept only well-formed AMD64
// PE32+ images, a whole-tree inventory of gated .exe/.dll/.node files, and a
// process-identity comparison helper the parent verifier can reuse for the
// Electron executable, the Electron-ABI addon, runtime node.exe, and the
// Node-ABI addon. There is no glibc-style version floor for Windows, so this
// module is intentionally smaller than its Linux counterpart.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// Named only for diagnostics: the packaged app is x64-only today (win32-x64 is
// the sole runtime target in electron/runtime-targets.cjs), so every non-AMD64
// machine is rejected regardless of whether it is a recognized name.
const COFF_MACHINE = Object.freeze({
  0x8664: 'x64',
  0xaa64: 'arm64',
  0x14c: 'x86',
})

const GATED_SUFFIXES = Object.freeze(['.exe', '.dll', '.node'])

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0

export class WindowsBinaryGateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WindowsBinaryGateError'
  }
}

function readPlainFile(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (err) {
    throw new WindowsBinaryGateError(`${label} is missing at ${path}: ${err.message}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WindowsBinaryGateError(`${label} must be a plain regular file: ${path}`)
  }
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!fstatSync(fd).isFile()) {
      throw new WindowsBinaryGateError(`${label} must remain a plain regular file: ${path}`)
    }
    return readFileSync(fd)
  } catch (err) {
    if (err instanceof WindowsBinaryGateError) throw err
    throw new WindowsBinaryGateError(`${label} could not be read without following links at ${path}: ${err.message}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Parses just enough of the DOS/COFF/optional headers to prove a well-formed
// AMD64 PE32+ image: the MZ magic, a bounds-checked e_lfanew, the "PE\0\0"
// signature, an exact 0x8664 COFF machine, and an exact 0x20b (PE32+)
// optional-header magic. Every failure mode gets its own diagnostic so a
// malformed/truncated header, a wrong machine, and a 32-bit PE32 image are
// all distinguishable in test output and in a real verification failure.
function peArchitecture(bytes, path, label) {
  const DOS_HEADER_SIZE = 0x40
  const E_LFANEW_OFFSET = 0x3c
  const COFF_HEADER_SIZE = 20
  const SIZE_OF_OPTIONAL_HEADER_OFFSET = 16
  // IMAGE_OPTIONAL_HEADER64's fixed-size standard + Windows-specific fields
  // (Magic through NumberOfRvaAndSizes), before the data-directory array: the
  // smallest a well-formed PE32+ optional header can declare. A declared size
  // below this cannot hold ImageBase/Subsystem/etc. that a real loader (and
  // this gate's consumers) expect to exist, even if the file has enough bytes
  // to satisfy only the 2-byte magic field.
  const OPTIONAL_HEADER_PE32_PLUS_MIN_SIZE = 112

  if (bytes.length < DOS_HEADER_SIZE) {
    throw new WindowsBinaryGateError(`${label} is too small to contain a DOS header: ${path}`)
  }
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new WindowsBinaryGateError(`${label} is missing the MZ signature: ${path}`)
  }

  const peOffset = bytes.readUInt32LE(E_LFANEW_OFFSET)
  const coffOffset = peOffset + 4
  if (peOffset < DOS_HEADER_SIZE || coffOffset + COFF_HEADER_SIZE > bytes.length) {
    throw new WindowsBinaryGateError(`${label} has an invalid or truncated e_lfanew pointer: ${path}`)
  }
  if (bytes[peOffset] !== 0x50 || bytes[peOffset + 1] !== 0x45 || bytes[peOffset + 2] !== 0x00 || bytes[peOffset + 3] !== 0x00) {
    throw new WindowsBinaryGateError(`${label} is missing the PE\\0\\0 signature: ${path}`)
  }

  const machine = bytes.readUInt16LE(coffOffset)
  if (machine !== 0x8664) {
    const found = COFF_MACHINE[machine] ?? `0x${machine.toString(16)}`
    throw new WindowsBinaryGateError(`${label} has unsupported COFF machine ${found}, expected x64 (AMD64): ${path}`)
  }

  const sizeOfOptionalHeader = bytes.readUInt16LE(coffOffset + SIZE_OF_OPTIONAL_HEADER_OFFSET)
  const optionalHeaderOffset = coffOffset + COFF_HEADER_SIZE
  // The declared size must both meet the PE32+ floor AND actually fit inside
  // the file: a header that declares e.g. 224 bytes but is truncated right
  // after the magic field must not be accepted just because the magic itself
  // was readable.
  if (
    sizeOfOptionalHeader < OPTIONAL_HEADER_PE32_PLUS_MIN_SIZE ||
    optionalHeaderOffset + sizeOfOptionalHeader > bytes.length
  ) {
    throw new WindowsBinaryGateError(`${label} has a missing or truncated optional header: ${path}`)
  }
  const magic = bytes.readUInt16LE(optionalHeaderOffset)
  if (magic === 0x10b) {
    throw new WindowsBinaryGateError(`${label} is a PE32 (32-bit) image, expected PE32+ (64-bit): ${path}`)
  }
  if (magic !== 0x20b) {
    throw new WindowsBinaryGateError(`${label} has unsupported optional header magic 0x${magic.toString(16)}, expected PE32+ 0x20b: ${path}`)
  }
  return 'x64'
}

export function readPeArchitecture(path, label = 'PE image') {
  return peArchitecture(readPlainFile(path, label), path, label)
}

function hasGatedSuffix(name) {
  const lower = name.toLowerCase()
  return GATED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

// Whole-tree inventory of every plain .exe/.dll/.node file (matched
// case-insensitively so 'APP.EXE'/'Helper.Dll' are never silently dropped).
// A symlink, junction, or other reparse-like directory entry is never
// followed: it is refused outright (throws) rather than silently skipped,
// traversed, or gated -- unlike listPlainElfFiles in
// scripts/linux-binary-gates.mjs, which skips a symlink rather than
// refusing it, since a hidden binary must never go unreported here.
export function listPlainWindowsBinaryFiles(root) {
  const rootPath = resolve(root)
  let rootStat
  try {
    rootStat = lstatSync(rootPath)
  } catch (err) {
    throw new WindowsBinaryGateError(`packaged app folder is missing at ${rootPath}: ${err.message}`)
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WindowsBinaryGateError(`packaged app folder must be a plain directory: ${rootPath}`)
  }

  const files = []
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      // A symlink/junction/reparse-like entry is refused outright, never
      // silently skipped: skipping would let a malicious or accidental link
      // hide a gated binary from this inventory entirely, defeating the
      // whole-tree gate it exists to satisfy. Dirent.isSymbolicLink() already
      // distinguishes a link from its target without a second stat call; a
      // junction/reparse point modeled as a symlink on POSIX test hosts is
      // refused the same way.
      if (entry.isSymbolicLink()) {
        throw new WindowsBinaryGateError(`packaged app must not contain a symlink, junction, or reparse-like entry: ${path}`)
      }
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        throw new WindowsBinaryGateError(`packaged app must not contain a symlink, junction, or reparse-like entry: ${path}`)
      }
      if (stat.isDirectory()) {
        visit(path)
        continue
      }
      if (!stat.isFile() || !hasGatedSuffix(entry.name)) continue
      const relativePath = relative(rootPath, path)
      if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
        throw new WindowsBinaryGateError(`packaged binary escaped the app folder: ${path}`)
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

const SUPPORTED_ARCHES = Object.freeze(['x64'])

export function assertPeTreeCompatibility({ root, arch }) {
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new WindowsBinaryGateError(`unsupported Windows architecture requested: ${String(arch)}`)
  }
  return listPlainWindowsBinaryFiles(root).map(({ path, relativePath }) => {
    const actualArch = readPeArchitecture(path, `packaged binary ${relativePath}`)
    if (actualArch !== arch) {
      throw new WindowsBinaryGateError(
        `packaged binary ${relativePath} architecture mismatch: found ${actualArch}, expected ${arch}`,
      )
    }
    // readPeArchitecture only ever returns 'x64' or throws, and it only ever
    // returns after magic === 0x20b (PE32+) has already been confirmed, so
    // 'PE32+' is not a guess here — it is the one format this parser accepts.
    return { path: relativePath, arch: actualArch, format: 'PE32+' }
  })
}

export function assertProcessIdentity({ actual, expected, label }) {
  for (const [field, wanted] of Object.entries(expected)) {
    const found = actual?.[field]
    if (found !== wanted) {
      const display = field === 'modulesAbi' ? 'modules ABI' : field
      throw new WindowsBinaryGateError(`${label} ${display} mismatch: found ${String(found)}, expected ${wanted}`)
    }
  }
  return actual
}
