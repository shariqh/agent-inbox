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
  buildLinuxX64AppImage,
  renderAppRun,
  renderDesktopEntry,
  stageLinuxAppImageDirectory,
} from '../scripts/build-linux-appimage.mjs'
import { loadLinuxAppImageInputs, sha256File } from '../scripts/linux-appimage-inputs.mjs'
import {
  verifyLinuxX64AppImage,
  verifyNormalizedRuntimePrefix,
} from '../scripts/verify-linux-appimage.mjs'

describe('Linux x64 AppImage packaging', () => {
  it('derives the one canonical artifact name from an exact package version', () => {
    expect(appImageArtifactName('1.0.1')).toBe('Agent-Inbox-v1.0.1-linux-x86_64.AppImage')
    expect(() => appImageArtifactName('v1.0.1')).toThrow(/package version/)
    expect(() => appImageArtifactName('../1.0.1')).toThrow(/package version/)
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
    stageLinuxAppImageDirectory({
      appDir,
      thinApp,
      icon,
      packageVersion: '1.0.1',
      inputs: loadLinuxAppImageInputs(),
      sourceDateEpoch: 1_700_000_000,
    })
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
      'exec "$APPDIR/usr/lib/agent-inbox/Agent Inbox" "$@"',
      '',
    ].join('\n'))
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
    bytes.writeBigUInt64LE(320n, 128 + 0x18)
    bytes.writeBigUInt64LE(BigInt(names.length), 128 + 0x20)
    bytes.writeUInt32LE(11, 192)
    bytes.writeBigUInt64LE(400n, 192 + 0x18)
    bytes.writeBigUInt64LE(16n, 192 + 0x20)
    names.copy(bytes, 320)
    writeFileSync(runtime, bytes)
    const expectedSha256 = sha256File(runtime)

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

  it('keeps the clean launch harness Node-free and distinguishes FUSE from extraction fallback', () => {
    const smoke = readFileSync(resolve('scripts/smoke-linux-appimage.sh'), 'utf8')
    const build = readFileSync(resolve('scripts/build-linux-appimage.mjs'), 'utf8')
    const verify = readFileSync(resolve('scripts/verify-linux-appimage.mjs'), 'utf8')
    expect(smoke).toContain('"$MODE" == "fuse"')
    expect(smoke).toContain('"$MODE" == "extract"')
    expect(smoke).toContain('APPIMAGE_EXTRACT_AND_RUN=1')
    expect(smoke).toContain('"TMPDIR=$SCRATCH/tmp"')
    expect(smoke).toContain('chmod 0700 "$SCRATCH/tmp"')
    expect(smoke).toContain('x-agent-inbox-local-boundary: loopback-v1')
    expect(smoke).not.toContain('--no-sandbox')
    expect(smoke).not.toMatch(/(?:^|\s)node(?:\s|$)/m)
    expect(build).toContain("'--runtime-file'")
    expect(build).toContain('cwd: home')
    expect(build).not.toContain('...process.env')
    expect(build).toContain('verification.innerAppTreeDigest !== thinVerification.appTreeDigest')
    expect(verify).toContain('normalizedRuntimeSha256')
    expect(verify).toContain("elfSection(prefix, '.digest_md5')")
    expect(verify).toContain('chromeSandboxMode')
  })
})
