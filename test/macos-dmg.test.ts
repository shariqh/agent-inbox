// The macOS release DMG (#289): both builders share scripts/macos-dmg.mjs, which
// makes an lzma-compressed ULMO image, and every shipped in-app updater (1.3.0 and
// later) must still install it with its fixed hdiutil flags. The darwin-only tests
// use the real electron-installer-dmg/appdmg, hdiutil, ditto and plutil; only the
// signature checks are stand-ins, because the fixture app is unsigned.
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import macInstall from '../electron/update-install-macos.cjs'
import type { MacExecFile } from '../electron/update-install-macos.cjs'
import type { VerifiedArtifact } from '../electron/update-download.cjs'
import { createReleaseDmg, requireReleaseDmgFormat } from '../scripts/macos-dmg.mjs'
import { withMountedDmg } from '../scripts/macos-release-gates.mjs'
import { scratchDir } from './scratch.js'

const { createMacInstaller } = macInstall
const root = resolve(import.meta.dirname, '..')
const VERSION = '9.8.7'

function hdiutil(args: string[]) {
  return execFileSync('/usr/bin/hdiutil', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim()
}

function mountEntry(path: string) {
  return execFileSync('/sbin/mount', [], { encoding: 'utf8' })
    .split('\n')
    .find((line) => line.includes(` on ${path} (`)) ?? null
}

// Force-detaches /Volumes/<name>, and /Volumes/<name> N, the name macOS gives a
// second volume of the same name.
function detachVolumes(name: string) {
  const volume = `/Volumes/${name}`
  for (const line of execFileSync('/sbin/mount', [], { encoding: 'utf8' }).split('\n')) {
    const mount = /^\/dev\/\S+ on (.+) \([^()]*\)$/.exec(line)?.[1]
    if (mount === undefined) continue
    if (mount === volume || (mount.startsWith(`${volume} `) && /^\d+$/.test(mount.slice(volume.length + 1)))) {
      spawnSync('/usr/bin/hdiutil', ['detach', '-force', mount], { stdio: 'ignore', timeout: 60_000 })
    }
  }
}

// GitHub's hosted macOS runners fail hdiutil now and then for reasons no test can
// fix: `create failed - Resource busy` (actions/runner-images#7522), or appdmg's
// `detach … No such file or directory` (this repo's run 39352722375). So each image
// build here gets one more try after a pause, from a clean slate: no partial output
// and no volume of its name still mounted. createReleaseDmg() itself never retries.
async function buildImage(output: string, volume: string, build: () => unknown) {
  try {
    await build()
    return
  } catch (error) {
    console.warn(`hdiutil image build failed, retrying once: ${(error as Error).message}`)
  }
  rmSync(output, { force: true })
  detachVolumes(volume)
  await sleep(5_000)
  await build()
}

// Nothing runs the executable. The in-app updater reads its Mach-O header (#343), so it is
// a thin 64-bit header naming arm64, as the shipped app's is since #296.
function arm64Header() {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(0x0100000c, 4)
  return header
}

function writeApp(app: string) {
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'MacOS', 'Agent Inbox'), arm64Header(), { mode: 0o755 })
  writeFileSync(join(app, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleExecutable</key><string>Agent Inbox</string>',
    '<key>CFBundleIdentifier</key><string>io.github.shariqh.agent-inbox</string>',
    `<key>CFBundleShortVersionString</key><string>${VERSION}</string>`,
    '</dict></plist>',
  ].join('\n'))
}

describe('the macOS release DMG builders', () => {
  it('build both the provisional and the final DMG through createReleaseDmg', () => {
    for (const name of ['assemble-macos-release.mjs', 'macos-release-gates.mjs']) {
      const source = readFileSync(join(root, 'scripts', name), 'utf8')
      expect(source).toContain('createReleaseDmg({')
      expect(source).not.toContain('createDMG')
      expect(source).not.toMatch(/format: '/)
    }
  })
})

describe.skipIf(process.platform !== 'darwin')('a release DMG built on macOS', () => {
  let temp: string
  let dmg: string
  const mounts: string[] = []

  beforeAll(async () => {
    // `mount` lists canonical paths, and $TMPDIR sits under the /var -> /private/var link.
    temp = realpathSync(scratchDir('release-dmg-'))
    const app = join(temp, 'build', 'Agent Inbox.app')
    writeApp(app)
    dmg = join(temp, `Agent-Inbox-v${VERSION}-arm64.dmg`)
    const title = `Agent Inbox DMG test ${process.pid}`
    await buildImage(dmg, title, () => createReleaseDmg({
      app,
      title,
      icon: join(root, 'electron', 'icon.icns'),
      output: dmg,
    }))
  }, 300_000)

  afterAll(() => {
    // A failed assertion must never leave a volume mounted inside the scratch tree.
    for (const mount of mounts) {
      if (mountEntry(mount)) execFileSync('/usr/bin/hdiutil', ['detach', '-force', mount], { stdio: 'ignore' })
    }
  })

  it('is an lzma-compressed ULMO image', () => {
    expect(hdiutil(['imageinfo', '-format', dmg])).toBe('ULMO')
    expect(requireReleaseDmgFormat(dmg)).toBe('ULMO')
  })

  it('refuses an image of any other format', async () => {
    const source = join(temp, 'zlib-source')
    writeApp(join(source, 'Agent Inbox.app'))
    const zlib = join(temp, 'zlib.dmg')
    const volume = `Agent Inbox zlib test ${process.pid}`
    await buildImage(zlib, volume, () => hdiutil(['create', '-srcfolder', source, '-volname', volume, '-format', 'UDZO', zlib]))
    expect(() => requireReleaseDmgFormat(zlib)).toThrow(/is UDZO, not ULMO/)
  }, 300_000)

  it('installs through the in-app updater: attached read-only with its checksums verified, then detached', async () => {
    const applications = join(temp, 'Applications')
    const bundlePath = join(applications, 'Agent Inbox.app')
    mkdirSync(bundlePath, { recursive: true })
    const attaches: Array<{ args: string[]; stdout: string; mounted: string | null; write: string }> = []
    const execFileImpl: MacExecFile = (file, args, options, callback) => execFile(file, [...args], options, (error, stdout, stderr) => {
      if (file === '/usr/bin/hdiutil' && args[0] === 'attach' && !error) {
        const mount = args[args.indexOf('-mountpoint') + 1]!
        mounts.push(mount)
        let write = 'written'
        try {
          writeFileSync(join(mount, 'probe'), 'x')
        } catch (writeError) {
          write = String((writeError as NodeJS.ErrnoException).code)
        }
        attaches.push({ args: [...args], stdout: String(stdout), mounted: mountEntry(mount), write })
      }
      callback(error, String(stdout), String(stderr))
    })
    const installer = createMacInstaller({
      bundlePath,
      systemVersion: '14.5.0',
      pid: process.pid,
      uid: process.getuid!(),
      platform: 'darwin',
      isPackaged: true,
      workDirectory: join(temp, 'update-install'),
      execFileImpl,
      binaries: { codesign: '/usr/bin/true', spctl: '/usr/bin/true' },
      // The Mac that installs an Apple silicon DMG, whatever runs the test.
      hostArch: 'arm64',
    })
    const bytes = readFileSync(dmg)
    const record: VerifiedArtifact = {
      path: dmg,
      version: VERSION,
      tag: `v${VERSION}`,
      filename: `Agent-Inbox-v${VERSION}-arm64.dmg`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      architecture: 'arm64',
      packageType: 'dmg',
      installStrategy: 'macos-dmg',
      minimumSystemVersion: '13.5',
    }
    const handle = await fsp.open(dmg, 'r')
    try {
      const prepared = await installer.prepare({ record, handle })
      expect(attaches).toHaveLength(1)
      const [attach] = attaches
      expect(attach!.args.slice(0, 5)).toEqual(['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint'])
      expect(attach!.stdout).toMatch(/^verified\s+CRC32 \$[0-9A-F]{8}$/m)
      expect(attach!.mounted).toMatch(/\bread-only\b/)
      expect(attach!.write).toBe('EROFS')
      const stages = readdirSync(applications).filter((name) => name.startsWith('.agent-inbox-update-'))
      expect(stages).toHaveLength(1)
      expect(existsSync(join(applications, stages[0]!, 'Agent Inbox.app', 'Contents', 'Info.plist'))).toBe(true)
      expect(mountEntry(mounts.at(-1)!)).toBeNull()
      await prepared.discard()
      expect(readdirSync(applications)).toEqual(['Agent Inbox.app'])
    } finally {
      await handle.close()
    }
  }, 300_000)

  it('passes the release gate attach: read-only, the app beside an /Applications link, then detached', async () => {
    const mount = join(temp, 'gate-mount')
    mkdirSync(mount)
    mounts.push(mount)
    const seen = await withMountedDmg({
      dmg,
      mount,
      runCommand: (path, args, options) => execFileSync(path, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options?.timeout ?? 120_000,
      }),
      verify: () => ({
        mounted: mountEntry(mount),
        visible: readdirSync(mount).filter((name) => !name.startsWith('.')).sort(),
      }),
    })
    expect(seen.mounted).toMatch(/\bread-only\b/)
    expect(seen.visible).toEqual(['Agent Inbox.app', 'Applications'])
    expect(mountEntry(mount)).toBeNull()
  }, 300_000)
})
