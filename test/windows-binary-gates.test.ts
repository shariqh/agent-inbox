import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WindowsBinaryGateError,
  assertPeTreeCompatibility,
  assertProcessIdentity,
  listPlainWindowsBinaryFiles,
  readPeArchitecture,
} from '../scripts/windows-binary-gates.mjs'

// Windows requires SeCreateSymbolicLinkPrivilege (or Developer Mode) to
// create a FILE or plain directory symlink, which a windows-2022 CI runner
// may not have -- but a directory JUNCTION needs no such privilege there.
// Tests that only need to prove the whole-tree gate refuses a link-like
// directory entry use an explicit 'junction' type (a no-op hint on POSIX, so
// the same fixture works everywhere); tests that specifically need a FILE
// symlink are skipped on win32 rather than failing CI for a missing
// privilege the gate itself does not require.
const IS_WINDOWS = process.platform === 'win32'

const E_LFANEW_OFFSET = 0x3c
// Mirrors the parser's IMAGE_OPTIONAL_HEADER64 floor: the smallest
// SizeOfOptionalHeader a genuine PE32+ image can declare, before any data
// directories. Fixtures default to exactly this so the "happy path" and the
// "wrong magic" fixtures exercise the parser's true minimum, not an
// arbitrarily larger one.
const OPTIONAL_HEADER_PE32_PLUS_MIN_SIZE = 0x70

// Builds a minimal-but-well-formed DOS/COFF/optional-header prefix: MZ magic,
// an e_lfanew pointing past a full DOS header, the 'PE\0\0' signature, the
// given COFF machine, the given optional-header magic, and a declared
// SizeOfOptionalHeader (default: the real PE32+ minimum) that always fits
// inside the returned buffer. Real PE images carry sections/imports/etc.
// after this; the parser under test only reads this prefix, so fixtures omit
// the rest deliberately.
function peBytes(machine: number, magic: number, lfanew = 0x80, sizeOfOptionalHeader = OPTIONAL_HEADER_PE32_PLUS_MIN_SIZE): Buffer {
  const coffOffset = lfanew + 4
  const optionalHeaderOffset = coffOffset + 20
  const bytes = Buffer.alloc(optionalHeaderOffset + sizeOfOptionalHeader)
  bytes[0] = 0x4d // 'M'
  bytes[1] = 0x5a // 'Z'
  bytes.writeUInt32LE(lfanew, E_LFANEW_OFFSET)
  bytes[lfanew] = 0x50 // 'P'
  bytes[lfanew + 1] = 0x45 // 'E'
  bytes[lfanew + 2] = 0x00
  bytes[lfanew + 3] = 0x00
  bytes.writeUInt16LE(machine, coffOffset) // Machine
  bytes.writeUInt16LE(sizeOfOptionalHeader, coffOffset + 16) // SizeOfOptionalHeader
  bytes.writeUInt16LE(magic, optionalHeaderOffset) // OptionalHeader.Magic
  return bytes
}

function writeFixture(bytes: Buffer, name = 'binary.exe'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'windows-pe-')), name)
  writeFileSync(path, bytes)
  return path
}

function amd64Pe32Plus(name = 'binary.exe'): string {
  return writeFixture(peBytes(0x8664, 0x20b), name)
}

describe('Windows PE parser', () => {
  it('returns x64 only for a well-formed AMD64 PE32+ image', () => {
    expect(readPeArchitecture(amd64Pe32Plus())).toBe('x64')
  })

  it('rejects an ARM64 machine with a specific diagnostic naming both architectures', () => {
    // ARM64 images are naturally PE32+ (magic 0x20b) too, so this isolates
    // the machine check from the optional-header magic check.
    const arm64 = writeFixture(peBytes(0xaa64, 0x20b))
    expect(() => readPeArchitecture(arm64, 'Electron executable'))
      .toThrow(/Electron executable.*arm64.*x64/)
    expect(() => readPeArchitecture(arm64)).toThrow(WindowsBinaryGateError)
  })

  it('rejects an x86 machine with a specific diagnostic naming both architectures', () => {
    // x86 images are naturally PE32 (magic 0x10b), but the machine check runs
    // first, so the diagnostic is about the machine, not the magic.
    const x86 = writeFixture(peBytes(0x14c, 0x10b))
    expect(() => readPeArchitecture(x86, 'Electron-ABI addon'))
      .toThrow(/Electron-ABI addon.*x86.*x64/)
  })

  it('rejects an unrecognized COFF machine with the raw hex value', () => {
    const unknown = writeFixture(peBytes(0x01c4, 0x20b)) // ARMNT, not modeled
    expect(() => readPeArchitecture(unknown)).toThrow(/unsupported COFF machine 0x1c4/)
  })

  it('rejects a PE32 (32-bit) optional header even with a correct AMD64 machine', () => {
    const pe32 = writeFixture(peBytes(0x8664, 0x10b))
    expect(() => readPeArchitecture(pe32, 'runtime node.exe'))
      .toThrow(/runtime node\.exe is a PE32 \(32-bit\) image, expected PE32\+/)
  })

  it('rejects an unsupported optional-header magic', () => {
    const badMagic = writeFixture(peBytes(0x8664, 0x0107)) // ROM image magic
    expect(() => readPeArchitecture(badMagic)).toThrow(/unsupported optional header magic 0x107/)
  })

  it('rejects a file too small to contain a DOS header', () => {
    const tiny = writeFixture(Buffer.from([0x4d, 0x5a]))
    expect(() => readPeArchitecture(tiny)).toThrow(/too small to contain a DOS header/)
  })

  it('rejects a file missing the MZ signature', () => {
    const bytes = peBytes(0x8664, 0x20b)
    bytes[0] = 0x00
    const path = writeFixture(bytes)
    expect(() => readPeArchitecture(path)).toThrow(/missing the MZ signature/)
  })

  it('rejects an e_lfanew pointer that is too small (before the DOS header ends)', () => {
    const bytes = peBytes(0x8664, 0x20b)
    bytes.writeUInt32LE(4, E_LFANEW_OFFSET)
    const path = writeFixture(bytes)
    expect(() => readPeArchitecture(path)).toThrow(/invalid or truncated e_lfanew pointer/)
  })

  it('rejects an e_lfanew pointer that runs past end of file', () => {
    const bytes = peBytes(0x8664, 0x20b)
    bytes.writeUInt32LE(0x10000, E_LFANEW_OFFSET)
    const path = writeFixture(bytes)
    expect(() => readPeArchitecture(path)).toThrow(/invalid or truncated e_lfanew pointer/)
  })

  it('rejects a truncated COFF header even when e_lfanew itself is in range', () => {
    const lfanew = 0x80
    const bytes = peBytes(0x8664, 0x20b, lfanew)
    // Cut the file off partway through the 20-byte COFF header.
    const path = writeFixture(bytes.subarray(0, lfanew + 4 + 10))
    expect(() => readPeArchitecture(path)).toThrow(/invalid or truncated e_lfanew pointer/)
  })

  it('rejects a malformed PE signature', () => {
    const bytes = peBytes(0x8664, 0x20b)
    bytes[0x80] = 0x58 // 'X' instead of 'P'
    const path = writeFixture(bytes)
    expect(() => readPeArchitecture(path)).toThrow(/missing the PE\\0\\0 signature/)
  })

  it('rejects a truncated optional header with no room for the magic field', () => {
    const lfanew = 0x80
    const bytes = peBytes(0x8664, 0x20b, lfanew)
    const coffOffset = lfanew + 4
    const optionalHeaderOffset = coffOffset + 20
    const path = writeFixture(bytes.subarray(0, optionalHeaderOffset))
    expect(() => readPeArchitecture(path)).toThrow(/missing or truncated optional header/)
  })

  it('rejects a declared SizeOfOptionalHeader that does not fit in the file, even though the magic field alone is readable', () => {
    const lfanew = 0x80
    const bytes = peBytes(0x8664, 0x20b, lfanew, OPTIONAL_HEADER_PE32_PLUS_MIN_SIZE)
    const coffOffset = lfanew + 4
    const optionalHeaderOffset = coffOffset + 20
    // Cut the file to just past the 2-byte magic field: a naive check that
    // only requires the magic to be readable would accept this, even though
    // the header declares 0x70 bytes and the file has nowhere near that many.
    const path = writeFixture(bytes.subarray(0, optionalHeaderOffset + 4))
    expect(() => readPeArchitecture(path)).toThrow(/missing or truncated optional header/)
  })

  it('rejects a SizeOfOptionalHeader below the PE32+ minimum even when it and the magic fit entirely in the file', () => {
    const lfanew = 0x80
    // 32 bytes fits the buffer exactly (peBytes sizes the buffer to match),
    // so only the defensible-minimum floor -- not a truncation/fit check --
    // can be responsible for rejecting this fixture.
    const bytes = peBytes(0x8664, 0x20b, lfanew, 32)
    const path = writeFixture(bytes)
    expect(() => readPeArchitecture(path)).toThrow(/missing or truncated optional header/)
  })

  // File symlinks (as opposed to directory junctions) require elevated
  // privilege to create on Windows, which a windows-2022 CI runner may lack;
  // skip there rather than fail CI for a privilege this gate doesn't need.
  it.skipIf(IS_WINDOWS)('never follows a symlink to read PE bytes', () => {
    const target = amd64Pe32Plus()
    const link = join(mkdtempSync(join(tmpdir(), 'windows-pe-link-')), 'binary.exe')
    symlinkSync(target, link)
    expect(() => readPeArchitecture(link)).toThrow(/must be a plain regular file/)
  })
})

describe('Windows whole-tree binary gate', () => {
  it('gates every plain .exe/.dll/.node file, sorted, contained, case-insensitively by suffix', () => {
    const root = mkdtempSync(join(tmpdir(), 'windows-tree-'))
    writeFileSync(join(root, 'README.txt'), 'not a binary')
    mkdirSync(join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release'), { recursive: true })
    writeFileSync(
      join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.NODE'),
      peBytes(0x8664, 0x20b),
    )
    mkdirSync(join(root, 'resources', 'runtime', 'win32-x64', 'bin'), { recursive: true })
    writeFileSync(join(root, 'resources', 'runtime', 'win32-x64', 'bin', 'node.exe'), peBytes(0x8664, 0x20b))
    writeFileSync(join(root, 'agent-inbox.EXE'), peBytes(0x8664, 0x20b))
    writeFileSync(join(root, 'ffmpeg.Dll'), peBytes(0x8664, 0x20b))

    const inventory = listPlainWindowsBinaryFiles(root)
    expect(inventory.map((entry) => entry.relativePath)).toEqual([
      'agent-inbox.EXE',
      'ffmpeg.Dll',
      'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.NODE',
      'resources/runtime/win32-x64/bin/node.exe',
    ])
    // Path containment: every reported path is relative to (and stays inside) the root.
    for (const entry of inventory) {
      expect(entry.relativePath.startsWith('..')).toBe(false)
      expect(entry.relativePath.startsWith('/')).toBe(false)
    }

    expect(assertPeTreeCompatibility({ root, arch: 'x64' })).toEqual([
      { path: 'agent-inbox.EXE', arch: 'x64', format: 'PE32+' },
      { path: 'ffmpeg.Dll', arch: 'x64', format: 'PE32+' },
      { path: 'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.NODE', arch: 'x64', format: 'PE32+' },
      { path: 'resources/runtime/win32-x64/bin/node.exe', arch: 'x64', format: 'PE32+' },
    ])
  })

  // File symlinks require elevated privilege on Windows (see IS_WINDOWS
  // above); the directory-junction test right below proves the same
  // whole-tree refusal on a windows-2022 CI runner without needing it.
  it.skipIf(IS_WINDOWS)('refuses a link-like file entry instead of silently omitting it from the inventory', () => {
    // A link-like entry (modeled here as a symlink, the only cross-platform
    // stand-in for a Windows junction/reparse point) must never be followed
    // OR silently dropped: a symlink pointing at a valid gated suffix could
    // otherwise hide an unvetted binary from this inventory entirely.
    const root = mkdtempSync(join(tmpdir(), 'windows-tree-link-'))
    writeFileSync(join(root, 'good.exe'), peBytes(0x8664, 0x20b))
    const outsideExe = amd64Pe32Plus('outside.exe')
    symlinkSync(outsideExe, join(root, 'linked.exe'))

    expect(() => listPlainWindowsBinaryFiles(root))
      .toThrow(/must not contain a symlink, junction, or reparse-like entry/)
    expect(() => assertPeTreeCompatibility({ root, arch: 'x64' }))
      .toThrow(/must not contain a symlink, junction, or reparse-like entry/)
  })

  it('refuses a link-like directory entry (a real junction on win32, a symlink elsewhere) instead of traversing into it', () => {
    const root = mkdtempSync(join(tmpdir(), 'windows-tree-junction-'))
    writeFileSync(join(root, 'good.exe'), peBytes(0x8664, 0x20b))
    const realDir = mkdtempSync(join(tmpdir(), 'windows-tree-junction-target-'))
    writeFileSync(join(realDir, 'hidden.dll'), peBytes(0x8664, 0x20b))
    // 'junction' creates a real, unprivileged directory junction on Windows
    // and is a harmless type hint (ignored) everywhere else, so this proves
    // whole-tree junction refusal on windows-2022 CI without developer-mode
    // symlink privilege.
    symlinkSync(realDir, join(root, 'linked-dir'), 'junction')

    expect(() => listPlainWindowsBinaryFiles(root))
      .toThrow(/must not contain a symlink, junction, or reparse-like entry/)
  })

  it('fails the whole-tree gate with the offending relative path when one binary is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'windows-tree-bad-'))
    writeFileSync(join(root, 'good.exe'), peBytes(0x8664, 0x20b))
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'bad.dll'), peBytes(0xaa64, 0x20b))
    expect(() => assertPeTreeCompatibility({ root, arch: 'x64' }))
      .toThrow(/nested\/bad\.dll.*arm64.*x64/)
  })

  it('rejects a compatibility request for an unsupported Windows architecture', () => {
    const root = mkdtempSync(join(tmpdir(), 'windows-tree-unsupported-'))
    writeFileSync(join(root, 'good.exe'), peBytes(0x8664, 0x20b))
    // @ts-expect-error exercising the runtime guard with an arch this package never ships
    expect(() => assertPeTreeCompatibility({ root, arch: 'arm64' }))
      .toThrow(/unsupported Windows architecture requested: arm64/)
  })

  it('rejects a packaged app root that is itself a symlink', () => {
    const real = mkdtempSync(join(tmpdir(), 'windows-tree-real-'))
    const link = join(mkdtempSync(join(tmpdir(), 'windows-tree-link-')), 'app')
    // 'junction' avoids the Windows symlink-creation privilege: the root is
    // a directory here, not a file, so a junction proves the same refusal.
    symlinkSync(real, link, 'junction')
    expect(() => listPlainWindowsBinaryFiles(link)).toThrow(/must be a plain directory/)
  })

  it('reports a missing packaged app folder', () => {
    const missing = join(tmpdir(), 'windows-tree-missing', String(process.pid))
    expect(() => listPlainWindowsBinaryFiles(missing)).toThrow(WindowsBinaryGateError)
  })
})

describe('Windows process identity', () => {
  it('requires exact platform, architecture, version, and modules ABI', () => {
    expect(assertProcessIdentity({
      actual: {
        platform: 'win32',
        arch: 'x64',
        version: 'v24.19.0',
        modulesAbi: '137',
      },
      expected: {
        platform: 'win32',
        arch: 'x64',
        version: 'v24.19.0',
        modulesAbi: '137',
      },
      label: 'runtime node.exe',
    })).toMatchObject({ arch: 'x64', modulesAbi: '137' })

    expect(() => assertProcessIdentity({
      actual: {
        platform: 'win32',
        arch: 'x64',
        version: '43.1.1',
        modulesAbi: '146',
      },
      expected: {
        platform: 'win32',
        arch: 'x64',
        version: '43.1.1',
        modulesAbi: '148',
      },
      label: 'packaged Electron',
    })).toThrow(/packaged Electron modules ABI mismatch/)

    expect(() => readPeArchitecture(join(tmpdir(), 'missing-pe')))
      .toThrow(WindowsBinaryGateError)
  })
})
