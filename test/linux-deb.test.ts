import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLinuxDeb,
  stageLinuxDebRoot,
} from '../scripts/build-linux-deb.mjs'
import {
  assertPinnedDpkgDeb,
  debArtifactName,
  renderDebControl,
  renderDebDesktopEntry,
  renderDebLauncher,
} from '../scripts/linux-deb-contract.mjs'
import {
  LinuxDebArchiveError,
  parseArArchive,
  parseTarArchive,
  readArMember,
} from '../scripts/linux-deb-archive.mjs'
import {
  loadLinuxDebInputs,
  resolveLinuxDebTarget,
} from '../scripts/linux-deb-inputs.mjs'
import {
  verifyDataEntries,
} from '../scripts/verify-linux-deb.mjs'
import {
  assertChromeSandboxInput,
  copyPlainTreeWithDeterministicModes,
  normalizeTreeTimes,
  renderLinuxDesktopEntry,
} from '../scripts/linux-package-common.mjs'

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, '0')}\0`, 'ascii')
}

function tarHeader({
  name,
  type = '0',
  mode = 0o644,
  size = 0,
  mtime = 1_700_000_000,
  link = '',
}: {
  name: string
  type?: string
  mode?: number
  size?: number
  mtime?: number
  link?: string
}): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  octal(mode, 8).copy(header, 100)
  octal(0, 8).copy(header, 108)
  octal(0, 8).copy(header, 116)
  octal(size, 12).copy(header, 124)
  octal(mtime, 12).copy(header, 136)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write(link, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write('root', 265, 32, 'ascii')
  header.write('root', 297, 32, 'ascii')
  let checksum = 0
  for (const byte of header) checksum += byte
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148)
  return header
}

function tarEntry(options: Parameters<typeof tarHeader>[0], content = Buffer.alloc(0)): Buffer {
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([tarHeader({ ...options, size: content.length }), content, padding])
}

function writeTar(entries: Buffer[]): string {
  const root = mkdtempSync(join(tmpdir(), 'linux-deb-tar-'))
  const path = join(root, 'archive.tar')
  writeFileSync(path, Buffer.concat([...entries, Buffer.alloc(1024)]))
  return path
}

function arHeader(name: string, size: number, timestamp = 1_700_000_000): Buffer {
  const value = [
    name.padEnd(16),
    String(timestamp).padEnd(12),
    '0'.padEnd(6),
    '0'.padEnd(6),
    '100644'.padEnd(8),
    String(size).padEnd(10),
    '`\n',
  ].join('')
  return Buffer.from(value, 'ascii')
}

function arMember(name: string, content: Buffer, padding = '\n'): Buffer {
  return Buffer.concat([
    arHeader(name, content.length),
    content,
    ...(content.length % 2 === 1 ? [Buffer.from(padding)] : []),
  ])
}

describe('Linux DEB archive gates', () => {
  it('parses the exact ar member metadata and payload identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'linux-deb-ar-'))
    const path = join(root, 'fixture.deb')
    writeFileSync(path, Buffer.concat([
      Buffer.from('!<arch>\n'),
      arMember('debian-binary', Buffer.from('2.0\n')),
      arMember('control.tar.xz', Buffer.from('control')),
      arMember('data.tar.xz', Buffer.from('data')),
    ]))

    const members = parseArArchive(path)
    expect(members.map(({ name, uid, gid, mode, timestamp }) => ({
      name,
      uid,
      gid,
      mode,
      timestamp,
    }))).toEqual([
      { name: 'debian-binary', uid: 0, gid: 0, mode: 0o100644, timestamp: 1_700_000_000 },
      { name: 'control.tar.xz', uid: 0, gid: 0, mode: 0o100644, timestamp: 1_700_000_000 },
      { name: 'data.tar.xz', uid: 0, gid: 0, mode: 0o100644, timestamp: 1_700_000_000 },
    ])
    expect(readArMember(path, members[0]!)).toEqual(Buffer.from('2.0\n'))

    const bad = join(root, 'bad-padding.deb')
    writeFileSync(bad, Buffer.concat([
      Buffer.from('!<arch>\n'),
      arMember('odd', Buffer.from('x'), ' '),
    ]))
    expect(() => parseArArchive(bad)).toThrow(/padding/)
  })

  it('parses strict tar metadata, file hashes, symlinks, and captured content', () => {
    const content = Buffer.from('hello\n')
    const tar = writeTar([
      tarEntry({ name: './', type: '5', mode: 0o755 }),
      tarEntry({ name: './usr/', type: '5', mode: 0o755 }),
      tarEntry({ name: './usr/file', mode: 0o4755 }, content),
      tarEntry({ name: './usr/link', type: '2', mode: 0o777, link: 'file' }),
    ])
    const parsed = parseTarArchive(tar, { capturePaths: ['usr/file'] })
    expect(parsed.entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      mtime: entry.mtime,
      link: entry.link,
    }))).toEqual([
      { path: '.', type: '5', mode: 0o755, uid: 0, gid: 0, mtime: 1_700_000_000, link: '' },
      { path: 'usr', type: '5', mode: 0o755, uid: 0, gid: 0, mtime: 1_700_000_000, link: '' },
      { path: 'usr/file', type: '0', mode: 0o4755, uid: 0, gid: 0, mtime: 1_700_000_000, link: '' },
      { path: 'usr/link', type: '2', mode: 0o777, uid: 0, gid: 0, mtime: 1_700_000_000, link: 'file' },
    ])
    expect(parsed.entries[2]?.content).toEqual(content)
    expect(parsed.entries[2]?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects duplicate, escaping, corrupt, and privileged archive ambiguity', () => {
    const duplicate = writeTar([
      tarEntry({ name: './same' }, Buffer.from('a')),
      tarEntry({ name: './same' }, Buffer.from('b')),
    ])
    expect(() => parseTarArchive(duplicate)).toThrow(/duplicate tar path/)

    const escapingLink = writeTar([
      tarEntry({ name: './link', type: '2', mode: 0o777, link: '../../outside' }),
    ])
    expect(() => parseTarArchive(escapingLink)).toThrow(/unsafe target/)

    const hardlink = writeTar([
      tarEntry({ name: './hard', type: '1', link: 'target' }),
    ])
    expect(() => parseTarArchive(hardlink)).toThrow(/unsupported type/)

    const corrupt = readFileSync(writeTar([tarEntry({ name: './file' }, Buffer.from('x'))]))
    corrupt[0] = (corrupt[0] ?? 0) ^ 1
    const root = mkdtempSync(join(tmpdir(), 'linux-deb-corrupt-'))
    const corruptPath = join(root, 'corrupt.tar')
    writeFileSync(corruptPath, corrupt)
    expect(() => parseTarArchive(corruptPath)).toThrow(LinuxDebArchiveError)
  })
})

describe('shared Linux package staging', () => {
  it('copies contained trees under deterministic modes and rejects privilege or escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'linux-package-tree-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    mkdirSync(join(source, 'nested'), { recursive: true, mode: 0o700 })
    writeFileSync(join(source, 'nested', 'payload'), 'payload', { mode: 0o600 })
    symlinkSync('nested/payload', join(source, 'link'))
    copyPlainTreeWithDeterministicModes(source, destination)
    expect(lstatSync(destination).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(destination, 'nested')).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(destination, 'nested', 'payload')).mode & 0o777).toBe(0o600)
    expect(readlinkSync(join(destination, 'link'))).toBe('nested/payload')

    chmodSync(join(source, 'nested', 'payload'), 0o4755)
    expect(() => copyPlainTreeWithDeterministicModes(source, join(root, 'bad')))
      .toThrow(/privileged mode bits/)

    const outside = join(root, 'outside')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(source, 'escape'))
    expect(() => copyPlainTreeWithDeterministicModes(source, join(root, 'escape-copy')))
      .toThrow(/escapes its root/)
  })

  it('normalizes timestamps and keeps the shared desktop contract exact', () => {
    const root = mkdtempSync(join(tmpdir(), 'linux-package-time-'))
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'file'), 'payload')
    normalizeTreeTimes(root, 1_700_000_000)
    expect(Math.floor(lstatSync(root).mtimeMs / 1000)).toBe(1_700_000_000)
    expect(Math.floor(lstatSync(join(root, 'dir', 'file')).mtimeMs / 1000)).toBe(1_700_000_000)

    expect(renderLinuxDesktopEntry({
      type: 'Application',
      name: 'Agent Inbox',
      comment: 'Local inbox',
      exec: 'agent-inbox',
      icon: 'agent-inbox',
      categories: ['Utility', 'Development'],
      terminal: false,
    })).toBe([
      '[Desktop Entry]',
      'Type=Application',
      'Name=Agent Inbox',
      'Comment=Local inbox',
      'Exec=agent-inbox',
      'Icon=agent-inbox',
      'Categories=Utility;Development;',
      'Terminal=false',
      '',
    ].join('\n'))
  })

  it('requires a plain 0755 Chromium sandbox input', () => {
    const root = mkdtempSync(join(tmpdir(), 'linux-package-sandbox-'))
    writeFileSync(join(root, 'chrome-sandbox'), 'sandbox', { mode: 0o755 })
    expect(() => assertChromeSandboxInput(root)).not.toThrow()
    chmodSync(join(root, 'chrome-sandbox'), 0o4755)
    expect(() => assertChromeSandboxInput(root)).toThrow(/0755/)
  })
})

describe('Linux DEB package contract', () => {
  it('renders canonical names, control metadata, launcher, and desktop entry', () => {
    const inputs = loadLinuxDebInputs()
    const x64 = resolveLinuxDebTarget('linux-x64')
    expect(debArtifactName('1.0.1')).toBe('agent-inbox_1.0.1_amd64.deb')
    expect(debArtifactName('1.0.1', 'arm64')).toBe('agent-inbox_1.0.1_arm64.deb')
    expect(() => debArtifactName('v1.0.1')).toThrow(/package version/)
    expect(() => debArtifactName('../1.0.1')).toThrow(/package version/)
    expect(renderDebLauncher(inputs)).toBe([
      '#!/bin/sh',
      'set -eu',
      'exec "/usr/lib/agent-inbox/Agent Inbox" "$@"',
      '',
    ].join('\n'))
    expect(renderDebLauncher(inputs)).not.toMatch(/--no-sandbox|--disable-setuid-sandbox/)
    expect(renderDebDesktopEntry(inputs)).toContain(
      'Categories=Utility;Development;\nTerminal=false\n',
    )
    expect(renderDebControl(inputs, x64, '1.0.1', 123)).toBe([
      'Package: agent-inbox',
      'Version: 1.0.1',
      'Section: utils',
      'Priority: optional',
      'Architecture: amd64',
      'Maintainer: Shariq Hirani <shariqh@users.noreply.github.com>',
      'Installed-Size: 123',
      `Depends: ${inputs.dependencies.join(', ')}`,
      'Homepage: https://github.com/shariqh/agent-inbox',
      'Description: Local, cross-project attention inbox for coding agents',
      ` ${inputs.package.longDescription}`,
      '',
    ].join('\n'))
    expect(() => renderDebControl(inputs, x64, '1.0.1', 0)).toThrow(/Installed-Size/)
  })

  it('requires the exact native dpkg-deb identity', () => {
    const inputs = loadLinuxDebInputs()
    const profile = resolveLinuxDebTarget('linux-x64')
    const exact = () =>
      "Debian 'dpkg-deb' package archive backend version 1.21.1 (amd64).\n"
    expect(assertPinnedDpkgDeb(profile, inputs, exact)).toContain('version 1.21.1')
    expect(() => assertPinnedDpkgDeb(
      profile,
      inputs,
      () => "Debian 'dpkg-deb' package archive backend version 1.22.0 (amd64).\n",
    )).toThrow(/version mismatch/)
    expect(() => assertPinnedDpkgDeb(
      profile,
      inputs,
      () => "Debian 'dpkg-deb' package archive backend version 1.21.1 (arm64).\n",
    )).toThrow(/amd64/)
  })

  it('stages the exact package layout under hostile ambient umask', () => {
    const root = mkdtempSync(join(tmpdir(), 'linux-deb-stage-'))
    const app = join(root, 'thin')
    const packageRoot = join(root, 'package')
    const icon = join(root, 'icon.png')
    mkdirSync(join(app, 'resources'), { recursive: true })
    writeFileSync(join(app, 'Agent Inbox'), 'electron', { mode: 0o755 })
    writeFileSync(join(app, 'chrome-sandbox'), 'sandbox', { mode: 0o755 })
    writeFileSync(join(app, 'LICENSE'), 'electron license\n')
    writeFileSync(join(app, 'LICENSES.chromium.html'), '<p>notices</p>\n')
    writeFileSync(join(app, 'resources', 'payload'), 'payload', { mode: 0o600 })
    writeFileSync(icon, 'icon')
    const inputs = structuredClone(loadLinuxDebInputs())
    inputs.icon.path = icon
    const previousUmask = process.umask(0o077)
    try {
      const staged = stageLinuxDebRoot({
        packageRoot,
        thinApp: app,
        icon,
        repoRoot: resolve('.'),
        packageVersion: '1.0.1',
        inputs,
        profile: resolveLinuxDebTarget('linux-x64'),
        sourceDateEpoch: 1_700_000_000,
      })
      expect(staged.installedSize).toBeGreaterThan(0)
    } finally {
      process.umask(previousUmask)
    }

    const required = [
      'DEBIAN/control',
      'usr/bin/agent-inbox',
      'usr/lib/agent-inbox/Agent Inbox',
      'usr/lib/agent-inbox/chrome-sandbox',
      'usr/share/applications/agent-inbox.desktop',
      'usr/share/icons/hicolor/1024x1024/apps/agent-inbox.png',
      'usr/share/doc/agent-inbox/copyright',
      'usr/share/doc/agent-inbox/LICENSE.electron',
      'usr/share/doc/agent-inbox/LICENSES.chromium.html',
    ]
    for (const path of required) expect(lstatSync(join(packageRoot, path))).toBeDefined()
    expect(lstatSync(packageRoot).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(packageRoot, 'DEBIAN')).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(packageRoot, 'usr/share/icons/hicolor/1024x1024/apps')).mode & 0o777)
      .toBe(0o755)
    expect(lstatSync(join(packageRoot, 'DEBIAN/control')).mode & 0o777).toBe(0o644)
    expect(lstatSync(join(packageRoot, 'usr/bin/agent-inbox')).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(packageRoot, 'usr/lib/agent-inbox/chrome-sandbox')).mode & 0o7777)
      .toBe(0o4755)
    expect(Math.floor(lstatSync(packageRoot).mtimeMs / 1000)).toBe(1_700_000_000)
  })

  it('rejects non-native DEB builds before reading artifact inputs', async () => {
    const wrongArch = process.arch === 'x64' ? 'arm64' : 'x64'
    const unreachable = join(tmpdir(), 'must-not-be-read-deb', String(process.pid))
    await expect(buildLinuxDeb({
      arch: wrongArch,
      app: join(unreachable, 'app'),
      outputDir: join(unreachable, 'output'),
      repoRoot: join(unreachable, 'repo'),
    })).rejects.toThrow(new RegExp(`natively on linux/${wrongArch}`))
  })

  it('requires the observed sandbox and distributable modes across the complete data tree', () => {
    const inputs = loadLinuxDebInputs()
    const epoch = 1_700_000_000
    const directories = [
      '.',
      'usr',
      'usr/bin',
      'usr/lib',
      'usr/lib/agent-inbox',
      'usr/share',
      'usr/share/applications',
      'usr/share/icons',
      'usr/share/icons/hicolor',
      'usr/share/icons/hicolor/1024x1024',
      'usr/share/icons/hicolor/1024x1024/apps',
      'usr/share/doc',
      'usr/share/doc/agent-inbox',
    ]
    const files = [
      inputs.layout.binary,
      inputs.layout.desktopFile,
      inputs.layout.icon,
      inputs.layout.copyright,
      inputs.layout.electronLicense,
      inputs.layout.chromiumLicenses,
    ]
    const metadata = {
      uid: 0,
      gid: 0,
      uname: 'root',
      gname: 'root',
      mtime: epoch,
      size: 1,
      link: '',
    }
    const entries = [
      ...directories.map((path) => ({
        ...metadata,
        path,
        type: '5',
        mode: 0o755,
        size: 0,
      })),
      ...files.map((path) => ({
        ...metadata,
        path,
        type: '0',
        mode: path === inputs.layout.binary ? 0o755 : 0o644,
      })),
      {
        ...metadata,
        path: `${inputs.layout.applicationDirectory}/payload`,
        type: '0',
        mode: 0o644,
      },
      {
        ...metadata,
        path: `${inputs.layout.applicationDirectory}/chrome-sandbox`,
        type: '0',
        mode: 0o4755,
      },
    ]
    expect(() => verifyDataEntries({
      entries,
      headers: [],
      inputs,
      sourceDateEpoch: epoch,
    })).not.toThrow()

    expect(() => verifyDataEntries({
      entries: entries.filter((entry) => !entry.path.endsWith('/chrome-sandbox')),
      headers: [],
      inputs,
      sourceDateEpoch: epoch,
    })).toThrow(/missing.*chrome-sandbox/)

    expect(() => verifyDataEntries({
      entries: entries.map((entry) =>
        entry.path.endsWith('/payload') ? { ...entry, mode: 0o600 } : entry),
      headers: [],
      inputs,
      sourceDateEpoch: epoch,
    })).toThrow(/non-distributable mode/)

    expect(() => verifyDataEntries({
      entries: entries.map((entry) =>
        entry.path === 'usr/bin' ? { ...entry, type: '2', mode: 0o777, link: 'lib' } : entry),
      headers: [],
      inputs,
      sourceDateEpoch: epoch,
    })).toThrow(/directory must be plain mode 0755/)
  })
})
