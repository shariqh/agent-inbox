import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appImageArtifactName,
  buildLinuxArm64AppImage,
  buildLinuxX64AppImage,
  renderAppRun,
  renderDesktopEntry,
  stageLinuxAppImageDirectory,
} from '../scripts/build-linux-appimage.mjs'
import { loadLinuxAppImageInputs, sha256File } from '../scripts/linux-appimage-inputs.mjs'
import {
  assertPinnedUnsquashfsVersion,
  extractAppImage,
  verifyLinuxArm64AppImage,
  verifyLinuxX64AppImage,
  verifyNormalizedRuntimePrefix,
  verifySquashfsModes,
} from '../scripts/verify-linux-appimage.mjs'

describe('Linux AppImage packaging', () => {
  it('derives the one canonical artifact name from an exact package version', () => {
    expect(appImageArtifactName('1.0.1')).toBe('Agent-Inbox-v1.0.1-linux-x86_64.AppImage')
    expect(appImageArtifactName('1.0.1', 'arm64')).toBe(
      'Agent-Inbox-v1.0.1-linux-arm64.AppImage',
    )
    expect(() => appImageArtifactName('v1.0.1')).toThrow(/package version/)
    expect(() => appImageArtifactName('../1.0.1')).toThrow(/package version/)
    expect(() => appImageArtifactName('1.0.1', 'ia32' as never)).toThrow(/target/)
  })

  it('stages only the required AppImage metadata, icon, launcher, and thin application tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'appimage-layout-'))
    const invalidThinApp = join(root, 'thin-file')
    const thinApp = join(root, 'thin')
    const appDir = join(root, 'AppDir')
    const icon = join(root, 'icon.png')
    writeFileSync(icon, 'icon bytes')
    writeFileSync(invalidThinApp, 'not a directory')
    expect(() => stageLinuxAppImageDirectory({
      appDir,
      thinApp: invalidThinApp,
      icon,
      packageVersion: '1.0.1',
      inputs: loadLinuxAppImageInputs(),
      sourceDateEpoch: 1_700_000_000,
    })).toThrow(/thin application/)

    mkdirSync(thinApp)
    writeFileSync(join(thinApp, 'Agent Inbox'), 'electron')
    writeFileSync(join(thinApp, 'chrome-sandbox'), 'sandbox')
    writeFileSync(join(thinApp, 'unexpected-helper'), 'unexpected')
    mkdirSync(join(thinApp, 'resources'), { mode: 0o700 })
    writeFileSync(join(thinApp, 'resources', 'payload'), 'payload')
    symlinkSync('Agent Inbox', join(thinApp, 'agent-inbox-link'))
    chmodSync(join(thinApp, 'Agent Inbox'), 0o755)
    chmodSync(join(thinApp, 'chrome-sandbox'), 0o755)
    chmodSync(join(thinApp, 'unexpected-helper'), 0o4755)
    expect(() => stageLinuxAppImageDirectory({
      appDir: join(root, 'BadAppDir'),
      thinApp,
      icon,
      packageVersion: '1.0.1',
      inputs: loadLinuxAppImageInputs(),
      sourceDateEpoch: 1_700_000_000,
    })).toThrow(/privileged mode bits/)
    chmodSync(join(thinApp, 'unexpected-helper'), 0o644)
    const previousUmask = process.umask(0o077)
    try {
      stageLinuxAppImageDirectory({
        appDir,
        thinApp,
        icon,
        packageVersion: '1.0.1',
        inputs: loadLinuxAppImageInputs(),
        sourceDateEpoch: 1_700_000_000,
      })
    } finally {
      process.umask(previousUmask)
    }
    expect(readdirSync(appDir).sort()).toEqual([
      '.DirIcon',
      'AppRun',
      'agent-inbox.desktop',
      'agent-inbox.png',
      'usr',
    ])
    expect(readlinkSync(join(appDir, '.DirIcon'))).toBe('agent-inbox.png')
    expect(statSync(join(appDir, 'AppRun')).mode & 0o777).toBe(0o755)
    expect(statSync(join(appDir, 'agent-inbox.desktop')).mode & 0o777).toBe(0o644)
    expect(statSync(join(appDir, 'agent-inbox.png')).mode & 0o777).toBe(0o644)
    expect(statSync(appDir).mode & 0o777).toBe(0o755)
    expect(statSync(join(appDir, 'usr')).mode & 0o777).toBe(0o755)
    expect(statSync(join(appDir, 'usr/lib')).mode & 0o777).toBe(0o755)
    expect(statSync(join(appDir, 'usr/lib/agent-inbox/resources')).mode & 0o777).toBe(0o755)
    expect(statSync(join(appDir, 'usr/lib/agent-inbox/Agent Inbox')).mode & 0o777).toBe(0o755)
    expect(statSync(join(appDir, 'usr/lib/agent-inbox/chrome-sandbox')).mode & 0o7777).toBe(0o4755)
    expect(readlinkSync(join(appDir, 'usr/lib/agent-inbox/agent-inbox-link'))).toBe('Agent Inbox')
  })

  it('renders deterministic launcher and desktop metadata with no host install behavior', () => {
    const inputs = loadLinuxAppImageInputs()
    expect(renderAppRun(inputs)).toBe([
      '#!/bin/sh',
      'set -eu',
      'APPDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"',
      'exec "$APPDIR/usr/lib/agent-inbox/Agent Inbox" --disable-setuid-sandbox "$@"',
      '',
    ].join('\n'))
    expect(renderAppRun(inputs)).not.toContain('--no-sandbox')
    expect(renderDesktopEntry(inputs, '1.0.1')).toBe([
      '[Desktop Entry]',
      'Type=Application',
      'Name=Agent Inbox',
      'Comment=Local, cross-project attention inbox for coding agents',
      'Exec=agent-inbox',
      'Icon=agent-inbox',
      'Categories=Utility;Development;',
      'Terminal=false',
      'X-AppImage-Version=1.0.1',
      '',
    ].join('\n'))
    expect(renderDesktopEntry(inputs, '1.0.1')).not.toMatch(/install|uninstall/i)
  })

  it('normalizes only appimagetool reserved MD5 bytes in the pinned runtime prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'appimage-runtime-prefix-'))
    const runtime = join(root, 'runtime')
    const bytes = Buffer.alloc(512)
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    bytes.writeBigUInt64LE(64n, 0x28)
    bytes.writeUInt16LE(64, 0x3a)
    bytes.writeUInt16LE(3, 0x3c)
    bytes.writeUInt16LE(1, 0x3e)
    const names = Buffer.from('\0.shstrtab\0.digest_md5\0')
    bytes.writeUInt32LE(1, 128)
    bytes.writeUInt32LE(3, 128 + 4)
    bytes.writeBigUInt64LE(320n, 128 + 0x18)
    bytes.writeBigUInt64LE(BigInt(names.length), 128 + 0x20)
    bytes.writeUInt32LE(11, 192)
    bytes.writeBigUInt64LE(400n, 192 + 0x18)
    bytes.writeBigUInt64LE(16n, 192 + 0x20)
    names.copy(bytes, 320)
    writeFileSync(runtime, bytes)
    const expectedSha256 = sha256File(runtime)

    expect(() => verifyNormalizedRuntimePrefix(runtime, {
      size: bytes.length,
      sha256: expectedSha256,
    })).toThrow(/no embedded MD5 digest/)

    bytes.fill(0xab, 400, 416)
    writeFileSync(runtime, bytes)
    expect(verifyNormalizedRuntimePrefix(runtime, {
      size: bytes.length,
      sha256: expectedSha256,
    })).toMatchObject({
      normalizedSha256: expectedSha256,
      embeddedDigestMd5: 'ab'.repeat(16),
      digestSection: { offset: 400, size: 16 },
    })

    bytes[300] = 1
    writeFileSync(runtime, bytes)
    expect(() => verifyNormalizedRuntimePrefix(runtime, {
      size: bytes.length,
      sha256: expectedSha256,
    })).toThrow(/normalized AppImage runtime SHA-256 mismatch/)

    bytes[300] = 0
    bytes.writeBigUInt64LE(15n, 192 + 0x20)
    writeFileSync(runtime, bytes)
    expect(() => verifyNormalizedRuntimePrefix(runtime, {
      size: bytes.length,
      sha256: expectedSha256,
    })).toThrow(/\.digest_md5 size must be 16 bytes/)

    bytes.writeBigUInt64LE(16n, 192 + 0x20)
    bytes.writeBigUInt64LE(BigInt(names.length - 1), 128 + 0x20)
    writeFileSync(runtime, bytes)
    expect(() => verifyNormalizedRuntimePrefix(runtime, {
      size: bytes.length,
      sha256: expectedSha256,
    })).toThrow(/ELF section name is invalid/)

    bytes.writeBigUInt64LE(BigInt(names.length), 128 + 0x20)
    bytes.writeUInt16LE(4, 0x3c)
    bytes.writeUInt32LE(11, 256)
    bytes.writeBigUInt64LE(416n, 256 + 0x18)
    bytes.writeBigUInt64LE(16n, 256 + 0x20)
    bytes.fill(0xcd, 416, 432)
    writeFileSync(runtime, bytes)
    expect(() => verifyNormalizedRuntimePrefix(runtime, {
      size: bytes.length,
      sha256: expectedSha256,
    })).toThrow(/duplicate \.digest_md5 sections/)

    bytes.writeUInt16LE(3, 0x3c)
    bytes.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 128 + 0x18)
    writeFileSync(runtime, bytes)
    expect(() => verifyNormalizedRuntimePrefix(runtime, {
      size: bytes.length,
      sha256: expectedSha256,
    })).toThrow(/ELF names offset exceeds the safe integer range/)

    expect(() => verifyNormalizedRuntimePrefix(runtime, {
      size: bytes.length + 1,
      sha256: expectedSha256,
    })).toThrow(/shorter than the pinned type-2 runtime/)
  })

  it('strictly verifies contract modes from direct SquashFS metadata', () => {
    const listing = [
      'drwxr-xr-x 0/0                     100 2026-08-19 20:00 squashfs-root',
      'drwxr-xr-x 0/0                      80 2026-08-19 20:00 squashfs-root/usr',
      'drwxr-xr-x 0/0                      60 2026-08-19 20:00 squashfs-root/usr/lib/Agent Inbox',
      '-rwxr-xr-x 0/0                      10 2026-08-19 20:00 squashfs-root/AppRun',
      '-rw-r--r-- 0/0                      10 2026-08-19 20:00 squashfs-root/agent-inbox.desktop',
      '-rw-r--r-- 0/0                      10 2026-08-19 20:00 squashfs-root/agent-inbox.png',
      '-rwsr-xr-x 0/0                      10 2026-08-19 20:00 squashfs-root/usr/lib/Agent Inbox/chrome-sandbox',
    ].join('\n')
    const options = {
      expectedModes: new Map([
        ['squashfs-root/AppRun', 0o755],
        ['squashfs-root/agent-inbox.desktop', 0o644],
        ['squashfs-root/agent-inbox.png', 0o644],
        ['squashfs-root/usr/lib/Agent Inbox/chrome-sandbox', 0o4755],
      ]),
      privilegedPath: 'squashfs-root/usr/lib/Agent Inbox/chrome-sandbox',
    }
    expect(verifySquashfsModes(listing, options)).toMatchObject({ directoryCount: 3 })

    expect(() => verifySquashfsModes(
      listing.replace('drwxr-xr-x 0/0                      80', 'drwx------ 0/0                      80'),
      options,
    )).toThrow(/squashfs-root\/usr.*0755.*0700/)
    expect(() => verifySquashfsModes(`${listing}\n${listing.split('\n')[1]}`, options))
      .toThrow(/duplicate SquashFS path/)
    expect(() => verifySquashfsModes('unparseable metadata', options))
      .toThrow(/invalid SquashFS metadata/)
    expect(() => verifySquashfsModes(
      listing.replace('-rw-r--r-- 0/0                      10', '-rw------- 0/0                      10'),
      options,
    )).toThrow(/agent-inbox\.desktop.*0644.*0600/)
    expect(() => verifySquashfsModes(
      `${listing}\n-rwsr-xr-x 0/0 10 2026-08-19 20:00 squashfs-root/unexpected-suid`,
      options,
    )).toThrow(/unexpected privileged mode/)
  })

  it('accepts the pinned unsquashfs version command exact exit-1 contract only', () => {
    const exact = 'unsquashfs version 4.5 (2021/07/22)\nlicence text\n'
    expect(() => assertPinnedUnsquashfsVersion({
      status: 1,
      stdout: exact,
      stderr: '',
      error: undefined,
    })).not.toThrow()
    expect(() => assertPinnedUnsquashfsVersion({
      status: 0,
      stdout: exact,
      stderr: '',
      error: undefined,
    })).toThrow(/exit status 0/)
    expect(() => assertPinnedUnsquashfsVersion({
      status: 2,
      stdout: exact,
      stderr: '',
      error: undefined,
    })).toThrow(/exit status 2/)
    expect(() => assertPinnedUnsquashfsVersion({
      status: 1,
      stdout: 'unsquashfs version 4.6.1\n',
      stderr: '',
      error: undefined,
    })).toThrow(/version must be exactly/)
    expect(() => assertPinnedUnsquashfsVersion({
      status: 1,
      stdout: exact,
      stderr: 'warning',
      error: undefined,
    })).toThrow(/unexpected stderr/)
  })

  it('extracts under a child-only zero umask and preserves the caller umask', () => {
    const root = mkdtempSync(join(tmpdir(), 'appimage-extraction-'))
    const fakeAppImage = join(root, 'fake.AppImage')
    writeFileSync(fakeAppImage, [
      '#!/bin/sh',
      'set -eu',
      'test "$1" = "--appimage-extract"',
      'mkdir squashfs-root',
      ': > squashfs-root/umask-probe',
      'install -m 0644 /dev/null squashfs-root/agent-inbox.desktop',
      '',
    ].join('\n'))
    chmodSync(fakeAppImage, 0o755)
    const previousUmask = process.umask(0o077)
    try {
      const extracted = extractAppImage(fakeAppImage)
      try {
        expect(statSync(join(extracted.appDir, 'umask-probe')).mode & 0o777).toBe(0o666)
        expect(statSync(join(extracted.appDir, 'agent-inbox.desktop')).mode & 0o777).toBe(0o644)
        expect(process.umask()).toBe(0o077)
      } finally {
        extracted.cleanup()
      }
    } finally {
      process.umask(previousUmask)
    }
  })

  it.runIf(process.platform !== 'linux' || process.arch !== 'x64')(
    'rejects non-native build and verification before reading artifact inputs',
    async () => {
      const unreachable = join(tmpdir(), 'must-not-be-read', String(process.pid))
      await expect(buildLinuxX64AppImage({
        app: join(unreachable, 'app'),
        outputDir: join(unreachable, 'output'),
        repoRoot: join(unreachable, 'repo'),
      })).rejects.toThrow(/linux\/x64/)
      expect(() => verifyLinuxX64AppImage({
        appImage: join(unreachable, 'appimage'),
        packageVersion: '1.0.1',
        sourceCommit: 'a'.repeat(40),
      })).toThrow(/linux\/x64/)
    },
  )

  it.runIf(process.platform !== 'linux' || process.arch !== 'arm64')(
    'rejects non-native arm64 build and verification before reading artifact inputs',
    async () => {
      const unreachable = join(tmpdir(), 'must-not-be-read-arm64', String(process.pid))
      await expect(buildLinuxArm64AppImage({
        app: join(unreachable, 'app'),
        outputDir: join(unreachable, 'output'),
        repoRoot: join(unreachable, 'repo'),
      })).rejects.toThrow(/linux\/arm64/)
      expect(() => verifyLinuxArm64AppImage({
        appImage: join(unreachable, 'appimage'),
        packageVersion: '1.0.1',
        sourceCommit: 'a'.repeat(40),
      })).toThrow(/linux\/arm64/)
    },
  )

  it('keeps the clean launch harness Node-free and distinguishes FUSE from extraction fallback', () => {
    const smoke = readFileSync(resolve('scripts/smoke-linux-appimage.sh'), 'utf8')
    const build = readFileSync(resolve('scripts/build-linux-appimage.mjs'), 'utf8')
    const verify = readFileSync(resolve('scripts/verify-linux-appimage.mjs'), 'utf8')
    expect(smoke).toContain('"$MODE" == "fuse"')
    expect(smoke).toContain('"$MODE" == "extract"')
    expect(smoke).toContain('APPIMAGE_EXTRACT_AND_RUN=1')
    expect(smoke).toContain('"TMPDIR=$SCRATCH/tmp"')
    expect(smoke).toContain('chmod 0700 "$SCRATCH"')
    expect(smoke).toContain('chmod 0700 "$SCRATCH/tmp"')
    expect(smoke).toContain('unshare --user --map-root-user true')
    expect(smoke).toContain("'^NoNewPrivs:[[:space:]]+1$'")
    expect(smoke).toContain("'^Seccomp:[[:space:]]+2$'")
    expect(smoke).toContain('"/proc/$pid/ns/user"')
    expect(smoke).toContain('x-agent-inbox-local-boundary: loopback-v1')
    expect(smoke).not.toContain('viewer running in-process')
    expect(smoke).not.toContain('falling back to spawning node')
    expect(smoke).not.toContain('--no-sandbox')
    expect(smoke).not.toMatch(/(?:^|\s)node(?:\s|$)/m)
    expect(build).toContain("'--runtime-file'")
    expect(build).toContain('cwd: home')
    expect(build).not.toContain('...process.env')
    expect(build).toContain('verification.innerAppTreeDigest !== thinVerification.appTreeDigest')
    expect(build).toContain('chmodSync(stagedChecksum, 0o644)')
    expect(build).toContain('chmodSync(stagedReport, 0o644)')
    expect(verify).toContain('normalizedRuntimeSha256')
    expect(verify).toContain("elfSection(prefix, '.digest_md5')")
    expect(verify).toContain('byteLength: appImageInputs.runtime.size')
    expect(verify).toContain('verifySquashfsModes')
    expect(verify).toContain('countExtractedDirectories(extracted.appDir)')
    expect(verify).toContain('umask 000; exec "$1" --appimage-extract')
    expect(verify).toContain("assertMode(artifact, 0o755, 'AppImage artifact')")
    expect(verify).toContain('chromeSandboxMode')
  })
})
