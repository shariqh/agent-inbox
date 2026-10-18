import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import macInstall from '../electron/update-install-macos.cjs'
import type { MacExecFile, MacInstallerFs, MacSpawn } from '../electron/update-install-macos.cjs'
import type { VerifiedArtifact } from '../electron/update-download.cjs'
import type { VerifiedInstallSource } from '../electron/update-install.cjs'

const { HELPER_SCRIPT, MAC_INSTALL_BINARIES, bundlePathFromExecPath, createMacInstaller } = macInstall
const run = promisify(execFile)

const repoRoot = resolve(import.meta.dirname, '..')
const workDirs: string[] = []
const UID = process.getuid!()
const REQUIREMENT = 'anchor apple generic and identifier "io.github.shariqh.agent-inbox" and certificate leaf[subject.OU] = "VVR2DKR923"'
const ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }
const APP = 'Agent Inbox.app'

afterEach(() => {
  // Tests that make a directory read-only restore it in their own `finally`.
  // Never walk fixtures recursively here: Node's recursive readdir follows
  // directory symlinks, and rmSync does not.
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workDir() {
  const dir = join(repoRoot, `.test-update-install-macos-${process.pid}-${workDirs.length}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  workDirs.push(dir)
  return dir
}

function writeApp(app: string, build: string, plist: Record<string, string>) {
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'MacOS', 'Agent Inbox'), build)
  writeFileSync(join(app, 'Contents', 'Info.plist'), JSON.stringify(plist))
}

const NEW_PLIST = { CFBundleIdentifier: 'io.github.shariqh.agent-inbox', CFBundleShortVersionString: '2.0.0' }

type Scenario = {
  attachFails?: boolean
  detachFailures?: number
  populate?: (mount: string) => void
  afterDitto?: (staged: string) => void
  dittoFails?: boolean
  codesignFails?: boolean
  spctlFails?: boolean
}

type ExecCall = { file: string; args: string[]; options: Record<string, unknown>; stdinEnded: boolean }

// The real DMG links Applications -> /Applications. Fixtures use a dangling
// link inside the test directory instead, so no bug can ever reach real apps.
function applicationsLink(mount: string) {
  symlinkSync(join(dirname(mount), 'decoy-applications'), join(mount, 'Applications'))
}

function defaultDmg(mount: string) {
  writeApp(join(mount, APP), 'new build', NEW_PLIST)
  applicationsLink(mount)
  mkdirSync(join(mount, '.background'))
}

// Plays hdiutil/ditto/plutil/codesign/spctl against real directories: "attach"
// fills the mount point, "detach" empties it, and plutil reads the plist it is given.
function fakeExec(scenario: Scenario = {}) {
  const calls: ExecCall[] = []
  let detachFailures = scenario.detachFailures ?? 0
  const behave = (file: string, args: string[]): string => {
    switch (file) {
      case '/usr/bin/hdiutil':
        if (args[0] === 'attach') {
          if (scenario.attachFails) throw Object.assign(new Error('hdiutil: attach failed /private/secret'), { code: 1 })
          const mount = args[args.indexOf('-mountpoint') + 1]!
          ;(scenario.populate ?? defaultDmg)(mount)
          return `/dev/disk9s1\tApple_HFS\t${mount}\n`
        }
        if (args[0] === 'detach') {
          if (detachFailures > 0) {
            detachFailures -= 1
            throw Object.assign(new Error('hdiutil: couldn’t unmount — Resource busy'), { code: 16 })
          }
          const mount = args.at(-1)!
          for (const name of readdirSync(mount)) rmSync(join(mount, name), { recursive: true, force: true })
          return ''
        }
        break
      case '/usr/bin/ditto':
        if (scenario.dittoFails) throw Object.assign(new Error('ditto: No space left on device'), { code: 1 })
        cpSync(args[0]!, args[1]!, { recursive: true, verbatimSymlinks: true })
        scenario.afterDitto?.(args[1]!)
        return ''
      case '/usr/bin/plutil':
        return readFileSync(args[4]!, 'utf8')
      case '/usr/bin/codesign':
        if (scenario.codesignFails) throw Object.assign(new Error('test-requirement: code failed to satisfy specified code requirement(s)'), { code: 3 })
        return ''
      case '/usr/sbin/spctl':
        if (scenario.spctlFails) throw Object.assign(new Error('rejected'), { code: 3 })
        return 'accepted\nsource=Notarized Developer ID\n'
    }
    throw new Error(`unexpected binary ${file} ${args.join(' ')}`)
  }
  const execFileImpl: MacExecFile = (file, args, options, callback) => {
    const call: ExecCall = { file, args: [...args], options: { ...options }, stdinEnded: false }
    calls.push(call)
    setImmediate(() => {
      let stdout: string
      try {
        stdout = behave(file, [...args])
      } catch (error) {
        callback(error as Error, '', String((error as Error).message))
        return
      }
      callback(null, stdout, '')
    })
    return { stdin: { end: () => { call.stdinEnded = true } } }
  }
  return { calls, execFileImpl }
}

function fakeSpawn(behavior: 'spawn' | 'error' = 'spawn') {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
  const children: Array<EventEmitter & { unref: ReturnType<typeof vi.fn> }> = []
  const spawnImpl: MacSpawn = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } })
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    children.push(child)
    if (behavior === 'error') setImmediate(() => child.emit('error', Object.assign(new Error('spawn /bin/sh EACCES'), { code: 'EACCES' })))
    return child
  }
  return { calls, children, spawnImpl, emitSpawn: (index = 0) => children[index]!.emit('spawn') }
}

async function fixture(options: { bytes?: number } = {}) {
  const work = workDir()
  const applications = join(work, 'Applications')
  const target = join(applications, APP)
  writeApp(target, 'old build', { CFBundleIdentifier: 'io.github.shariqh.agent-inbox', CFBundleShortVersionString: '1.0.0' })
  const workDirectory = join(work, 'userData', 'update-install')
  const body = randomBytes(options.bytes ?? 256 * 1024 + 7)
  const dmgPath = join(work, 'download.dmg')
  writeFileSync(dmgPath, body)
  const record: VerifiedArtifact = {
    path: dmgPath,
    version: '2.0.0',
    tag: 'v2.0.0',
    filename: 'Agent-Inbox-v2.0.0-universal.dmg',
    sha256: createHash('sha256').update(body).digest('hex'),
    byteLength: body.length,
    packageType: 'dmg',
    installStrategy: 'macos-dmg',
    minimumSystemVersion: '13.5',
  }
  const handle = await fsp.open(dmgPath, 'r')
  const before = { ino: statSync(target).ino, build: readFileSync(join(target, 'Contents', 'MacOS', 'Agent Inbox'), 'utf8') }
  return {
    work,
    applications,
    target,
    workDirectory,
    body,
    record,
    source: { record, handle } as VerifiedInstallSource,
    async close() { await handle.close() },
    expectTargetUntouched() {
      expect(statSync(target).ino).toBe(before.ino)
      expect(readFileSync(join(target, 'Contents', 'MacOS', 'Agent Inbox'), 'utf8')).toBe(before.build)
    },
    stages: () => readdirSync(applications).filter((name) => name.startsWith('.agent-inbox-update-')),
    workEntries: () => (existsSync(workDirectory) ? readdirSync(workDirectory) : []),
  }
}

function installerFor(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<Parameters<typeof createMacInstaller>[0]> = {}) {
  const exec = fakeExec()
  const spawner = fakeSpawn()
  const installer = createMacInstaller({
    bundlePath: f.target,
    systemVersion: '14.5.0',
    pid: 4242,
    uid: UID,
    platform: 'darwin',
    isPackaged: true,
    workDirectory: f.workDirectory,
    execFileImpl: exec.execFileImpl,
    spawnImpl: spawner.spawnImpl,
    ...overrides,
  })
  return { installer, exec, spawner }
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return { code: (error as { code?: string }).code, message: String((error as Error).message) }
  }
  throw new Error('expected the operation to fail')
}

describe('macOS install feasibility', () => {
  it('accepts a writable, user-owned app on a new enough macOS', async () => {
    const f = await fixture()
    const { installer } = installerFor(f)
    expect(installer.strategy).toBe('macos-dmg')
    await expect(installer.feasibility({ version: '2.0.0', minimumSystemVersion: '13.5' })).resolves.toEqual({ ok: true })
    await expect(installer.feasibility({ version: '2.0.0' })).resolves.toEqual({ ok: true })
    await f.close()
  })

  it.each([
    ['below', '13.4.1', true],
    ['equal', '13.5', true],
    ['equal with a patch', '13.5.0', true],
    ['above', '13.6', false],
    ['a major above', '26.0', false],
  ])('compares macOS dotted versions numerically (minimum %s)', async (_label, minimum, ok) => {
    const f = await fixture()
    const { installer } = installerFor(f, { systemVersion: '13.5.0' })
    const result = await installer.feasibility({ version: '2.0.0', minimumSystemVersion: minimum })
    expect(result.ok).toBe(ok)
    if (!result.ok) {
      expect(result).toEqual({ ok: false, reason: 'system-version', message: `This update needs macOS ${minimum} or later.` })
    }
    await f.close()
  })

  it('treats an unreadable running macOS version as too old for a minimum', async () => {
    const f = await fixture()
    const { installer } = installerFor(f, { systemVersion: 'unknown' })
    await expect(installer.feasibility({ version: '2.0.0', minimumSystemVersion: '13.5' })).resolves.toMatchObject({ ok: false, reason: 'system-version' })
    await expect(installer.feasibility({ version: '2.0.0', minimumSystemVersion: '13.5; rm -rf' })).resolves.toMatchObject({ ok: false })
    await f.close()
  })

  it.each([
    ['another platform', { platform: 'linux' }, 'unsupported'],
    ['an unpackaged build', { isPackaged: false }, 'unsupported'],
    ['a foreign owner', { uid: UID + 1 }, 'owner'],
    ['no bundle path', { bundlePath: null }, 'location'],
    ['a relative bundle path', { bundlePath: 'Applications/Agent Inbox.app' }, 'location'],
    ['a path that is not an app bundle', { bundlePath: '/usr/local/bin' }, 'location'],
  ] as const)('refuses %s', async (_label, overrides, reason) => {
    const f = await fixture()
    const { installer } = installerFor(f, overrides as never)
    const result = await installer.feasibility({ version: '2.0.0', minimumSystemVersion: '13.5' })
    expect(result).toMatchObject({ ok: false, reason })
    if (!result.ok) expect(result.message).not.toContain('/')
    await f.close()
  })

  it('refuses a translocated app, by path or by realpath', async () => {
    const f = await fixture()
    const translocated = join(f.work, 'AppTranslocation', 'ABC', 'd', APP)
    mkdirSync(translocated, { recursive: true })
    const byPath = installerFor(f, { bundlePath: translocated }).installer
    await expect(byPath.feasibility({ version: '2.0.0' })).resolves.toMatchObject({
      ok: false,
      reason: 'translocated',
      message: 'Move Agent Inbox to your Applications folder to install updates from the app.',
    })

    const linkedParent = join(f.work, 'Linked')
    symlinkSync(dirname(translocated), linkedParent)
    const byRealpath = installerFor(f, { bundlePath: join(linkedParent, APP) }).installer
    await expect(byRealpath.feasibility({ version: '2.0.0' })).resolves.toMatchObject({ ok: false, reason: 'translocated' })
    await f.close()
  })

  it('refuses a symlinked or missing app bundle', async () => {
    const f = await fixture()
    const link = join(f.applications, 'Linked.app')
    symlinkSync(f.target, link)
    await expect(installerFor(f, { bundlePath: link }).installer.feasibility({ version: '2.0.0' })).resolves.toMatchObject({ ok: false, reason: 'location' })
    await expect(installerFor(f, { bundlePath: join(f.applications, 'Missing.app') }).installer.feasibility({ version: '2.0.0' })).resolves.toMatchObject({ ok: false, reason: 'location' })
    await f.close()
  })

  it('refuses a read-only volume', async () => {
    const f = await fixture()
    const readOnly: MacInstallerFs = {
      ...(fsp as unknown as MacInstallerFs),
      access: async () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }) },
    }
    await expect(installerFor(f, { fsImpl: readOnly }).installer.feasibility({ version: '2.0.0' })).resolves.toMatchObject({
      ok: false,
      reason: 'read-only',
      message: 'Move Agent Inbox to your Applications folder to install updates from the app.',
    })
    await f.close()
  })

  it.skipIf(UID === 0)('refuses a folder this user cannot write', async () => {
    const f = await fixture()
    chmodSync(f.applications, 0o555)
    try {
      const result = await installerFor(f).installer.feasibility({ version: '2.0.0' })
      expect(result).toMatchObject({ ok: false, reason: 'permission' })
      if (!result.ok) expect(result.message).not.toContain('/')
    } finally {
      chmodSync(f.applications, 0o755)
    }
    await f.close()
  })

  it('never rejects, even when the filesystem throws unexpectedly', async () => {
    const f = await fixture()
    const broken: MacInstallerFs = {
      ...(fsp as unknown as MacInstallerFs),
      realpath: () => { throw new TypeError('boom /private/secret') },
    }
    const result = await installerFor(f, { fsImpl: broken }).installer.feasibility({ version: '2.0.0' })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret')
    await f.close()
  })
})

describe('preparing a verified DMG', () => {
  it('copies, mounts read-only, stages next to the app and verifies the staged copy', async () => {
    const f = await fixture()
    const { installer, exec } = installerFor(f)

    const prepared = await installer.prepare(f.source)
    await f.close()

    const [stageName, ...extraStages] = f.stages()
    expect(extraStages).toEqual([])
    const stage = join(f.applications, stageName!)
    const staged = join(stage, APP)
    const attach = exec.calls[0]!
    const mount = attach.args[5]!
    const workDir = dirname(mount)
    expect(basename(mount)).toBe('mnt')
    expect(dirname(workDir)).toBe(f.workDirectory)
    expect(basename(workDir)).toMatch(/^install-[A-Za-z0-9]{6}$/)
    expect(stageName).toMatch(/^\.agent-inbox-update-[A-Za-z0-9]{6}$/)
    expect(exec.calls.map(({ file, args }) => [file, ...args])).toEqual([
      ['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, join(workDir, 'update.dmg')],
      ['/usr/bin/ditto', join(mount, APP), staged],
      ['/usr/bin/hdiutil', 'detach', mount],
      ['/usr/bin/plutil', '-convert', 'json', '-o', '-', join(staged, 'Contents', 'Info.plist')],
      ['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', `-R=${REQUIREMENT}`, staged],
      ['/usr/sbin/spctl', '--assess', '--type', 'execute', '--verbose=2', staged],
    ])
    for (const call of exec.calls) {
      expect(call.options.shell).toBeUndefined()
      expect(call.options.env).toEqual(ENV)
      expect(call.options.encoding).toBe('utf8')
      expect(call.options.timeout).toBeGreaterThan(0)
      expect(call.options.maxBuffer).toBeGreaterThan(0)
      expect(call.stdinEnded).toBe(true)
    }
    expect(readFileSync(join(staged, 'Contents', 'MacOS', 'Agent Inbox'), 'utf8')).toBe('new build')
    expect(statSync(stage).mode & 0o777).toBe(0o700)
    expect(statSync(f.workDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(workDir).mode & 0o777).toBe(0o700)
    expect(readdirSync(workDir)).toEqual([])
    f.expectTargetUntouched()

    await prepared.discard()
    await prepared.discard()
    expect(f.stages()).toEqual([])
    expect(f.workEntries()).toEqual([])
    f.expectTargetUntouched()
  })

  type Failure = {
    code: string
    scenario?: Scenario
    source?: (f: Awaited<ReturnType<typeof fixture>>) => VerifiedInstallSource
    attached: boolean
  }
  const swapPlist = (staged: string, plist: Record<string, string>) => writeFileSync(join(staged, 'Contents', 'Info.plist'), JSON.stringify(plist))

  it.each<[string, Failure]>([
    ['bytes that do not match the signed digest', { code: 'not-verified', attached: false, source: (f) => ({ ...f.source, record: { ...f.record, sha256: 'e'.repeat(64) } }) }],
    ['a handle that ends early', { code: 'not-verified', attached: false, source: (f) => ({ record: f.record, handle: { stat: f.source.handle.stat, read: async () => ({ bytesRead: 0 }) } }) }],
    ['an attach failure', { code: 'staging', attached: true, scenario: { attachFails: true } }],
    ['no app in the image', { code: 'verification-failed', attached: true, scenario: { populate: (mount) => applicationsLink(mount) } }],
    ['two apps in the image', { code: 'verification-failed', attached: true, scenario: { populate: (mount) => { defaultDmg(mount); writeApp(join(mount, 'Other.app'), 'other', NEW_PLIST) } } }],
    ['a symlinked app in the image', { code: 'verification-failed', attached: true, scenario: { populate: (mount) => {
      const decoy = join(dirname(mount), 'decoy.app')
      writeApp(decoy, 'decoy build', NEW_PLIST)
      symlinkSync(decoy, join(mount, APP))
    } } }],
    ['a misnamed app in the image', { code: 'verification-failed', attached: true, scenario: { populate: (mount) => writeApp(join(mount, 'Agent Inbox 2.app'), 'new build', NEW_PLIST) } }],
    ['a ditto failure', { code: 'staging', attached: true, scenario: { dittoFails: true } }],
    ['a staged bundle identifier mismatch', { code: 'verification-failed', attached: true, scenario: { afterDitto: (staged) => swapPlist(staged, { ...NEW_PLIST, CFBundleIdentifier: 'com.example.other' }) } }],
    ['a staged version mismatch', { code: 'verification-failed', attached: true, scenario: { afterDitto: (staged) => swapPlist(staged, { ...NEW_PLIST, CFBundleShortVersionString: '1.9.9' }) } }],
    ['a staged plist that is not a file', { code: 'verification-failed', attached: true, scenario: { afterDitto: (staged) => {
      // The decoy holds a valid plist: only the link itself may cause the refusal.
      const decoy = join(dirname(staged), 'decoy-Info.plist')
      writeFileSync(decoy, JSON.stringify(NEW_PLIST))
      rmSync(join(staged, 'Contents', 'Info.plist'))
      symlinkSync(decoy, join(staged, 'Contents', 'Info.plist'))
    } } }],
    ['a code signature or requirement failure', { code: 'verification-failed', attached: true, scenario: { codesignFails: true } }],
    ['a Gatekeeper rejection', { code: 'verification-failed', attached: true, scenario: { spctlFails: true } }],
  ])('fails closed on %s and removes everything it staged', async (_label, failure) => {
    const f = await fixture()
    const exec = fakeExec(failure.scenario)
    const { installer } = installerFor(f, { execFileImpl: exec.execFileImpl })

    const outcome = await codeOf(installer.prepare(failure.source ? failure.source(f) : f.source))
    await f.close()
    expect(outcome.code).toBe(failure.code)
    expect(outcome.message).not.toContain('/')
    expect(f.stages()).toEqual([])
    expect(f.workEntries()).toEqual([])
    const detaches = exec.calls.filter((call) => call.file === '/usr/bin/hdiutil' && call.args[0] === 'detach')
    expect(detaches.length > 0).toBe(failure.attached)
    if (!failure.attached) expect(exec.calls).toEqual([])
    f.expectTargetUntouched()
  })

  it('retries a busy detach with -force', async () => {
    const f = await fixture()
    const exec = fakeExec({ detachFailures: 1 })
    const prepared = await installerFor(f, { execFileImpl: exec.execFileImpl }).installer.prepare(f.source)
    await f.close()
    const detaches = exec.calls.filter((call) => call.args[0] === 'detach').map((call) => call.args)
    const mount = exec.calls[0]!.args[5]!
    expect(detaches).toEqual([['detach', mount], ['detach', '-force', mount]])
    await prepared.discard()
  })

  it('refuses to stage on another volume', async () => {
    const f = await fixture()
    const otherVolume: MacInstallerFs = {
      ...(fsp as unknown as MacInstallerFs),
      async stat(path: string, options?: { bigint?: boolean }) {
        const real = await fsp.stat(path, options as never)
        if (basename(path).startsWith('.agent-inbox-update-')) return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { dev: (real.dev as number) + 1 })
        return real
      },
    } as MacInstallerFs
    const { installer, exec } = installerFor(f, { fsImpl: otherVolume })
    expect(await codeOf(installer.prepare(f.source))).toMatchObject({ code: 'staging' })
    await f.close()
    expect(f.stages()).toEqual([])
    expect(exec.calls.some((call) => call.file === '/usr/bin/codesign')).toBe(false)
    f.expectTargetUntouched()
  })

  it('stops and cleans up when aborted', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const exec = fakeExec({ afterDitto: () => controller.abort() })
    const { installer } = installerFor(f, { execFileImpl: exec.execFileImpl })
    expect(await codeOf(installer.prepare(f.source, { signal: controller.signal }))).toMatchObject({ code: 'staging' })
    await f.close()
    expect(f.stages()).toEqual([])
    expect(f.workEntries()).toEqual([])
    expect(exec.calls.some((call) => call.file === '/usr/bin/codesign')).toBe(false)
  })

  it('refuses a record for another install strategy before touching anything', async () => {
    const f = await fixture()
    const { installer, exec } = installerFor(f)
    const appImage = { ...f.record, installStrategy: 'appimage-self-replace', packageType: 'appimage' } as unknown as VerifiedArtifact
    expect(await codeOf(installer.prepare({ ...f.source, record: appImage }))).toMatchObject({ code: 'not-verified' })
    await f.close()
    expect(exec.calls).toEqual([])
    expect(existsSync(f.workDirectory)).toBe(false)
  })

  it('refuses a symlinked work directory', async () => {
    const f = await fixture()
    const elsewhere = join(f.work, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(dirname(f.workDirectory), { recursive: true })
    symlinkSync(elsewhere, f.workDirectory)
    const { installer, exec } = installerFor(f)
    expect(await codeOf(installer.prepare(f.source))).toMatchObject({ code: 'staging' })
    await f.close()
    expect(readdirSync(elsewhere)).toEqual([])
    expect(exec.calls).toEqual([])
  })

  it('never deletes inside a mount point that would not detach', async () => {
    const f = await fixture()
    const exec = fakeExec({ detachFailures: 99, codesignFails: true })
    let mount = ''
    const stillMounted: MacInstallerFs = {
      ...(fsp as unknown as MacInstallerFs),
      async lstat(path: string, options?: { bigint?: boolean }) {
        const real = await fsp.lstat(path, options as never)
        if (mount !== '' && path === mount) {
          const dev = typeof real.dev === 'bigint' ? real.dev + 1n : real.dev + 1
          return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { dev })
        }
        return real
      },
    } as MacInstallerFs
    const execFileImpl: MacExecFile = (file, args, options, callback) => {
      if (args[0] === 'attach') mount = args[5]!
      return exec.execFileImpl(file, args, options, callback)
    }
    const { installer } = installerFor(f, { execFileImpl, fsImpl: stillMounted })
    expect(await codeOf(installer.prepare(f.source))).toMatchObject({ code: 'verification-failed' })
    await f.close()
    expect(readdirSync(mount)).toContain(APP)
    expect(f.stages()).toEqual([])
  })
})

describe('committing the hand-off', () => {
  async function prepared(overrides: Partial<Parameters<typeof createMacInstaller>[0]> = {}) {
    const f = await fixture()
    const parts = installerFor(f, overrides)
    const result = await parts.installer.prepare(f.source)
    await f.close()
    const stage = join(f.applications, f.stages()[0]!)
    const workDir = join(f.workDirectory, f.workEntries()[0]!)
    return { f, ...parts, prepared: result, stage, staged: join(stage, APP), workDir }
  }

  it('writes the constant helper and spawns it detached with fixed argv and a minimal environment', async () => {
    const p = await prepared()
    let settled = false
    const committing = p.prepared.commit().then(() => { settled = true })
    await vi.waitFor(() => expect(p.spawner.calls).toHaveLength(1))
    await new Promise((resolveTick) => setImmediate(resolveTick))
    expect(settled).toBe(false)
    p.spawner.emitSpawn()
    await committing

    const helper = join(p.workDir, 'helper.sh')
    expect(p.spawner.calls).toEqual([{
      command: '/bin/sh',
      args: [helper, '4242', '-', p.f.target, p.staged, join(p.stage, 'Agent Inbox.app.previous'), '/usr/bin/open'],
      options: { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, cwd: '/' },
    }])
    expect(p.spawner.children[0]!.unref).toHaveBeenCalledOnce()
    expect(readFileSync(helper, 'utf8')).toBe(HELPER_SCRIPT)
    expect(statSync(helper).mode & 0o777).toBe(0o600)
    p.f.expectTargetUntouched()

    await p.prepared.discard()
    expect(existsSync(p.staged)).toBe(true)
    expect(existsSync(helper)).toBe(true)
  })

  it('passes the PID of a viewer the app started, read when it commits', async () => {
    let viewer: number | null = null
    const p = await prepared({ viewerPid: () => viewer })
    viewer = 4343
    const committing = p.prepared.commit()
    await vi.waitFor(() => expect(p.spawner.calls).toHaveLength(1))
    p.spawner.emitSpawn()
    await committing
    expect(p.spawner.calls[0]!.args.slice(1, 3)).toEqual(['4242', '4343'])
  })

  it.each([-1, 0, 1.5, Number.NaN])('refuses to hand off with an invalid viewer PID (%s)', async (value) => {
    const p = await prepared({ viewerPid: () => value })
    expect(await codeOf(p.prepared.commit())).toMatchObject({ code: 'commit-failed' })
    expect(p.spawner.calls).toEqual([])
    p.f.expectTargetUntouched()
    await p.prepared.discard()
  })

  it('rejects when the helper cannot start and leaves the running app alone', async () => {
    const f = await fixture()
    const spawner = fakeSpawn('error')
    const { installer } = installerFor(f, { spawnImpl: spawner.spawnImpl })
    const result = await installer.prepare(f.source)
    await f.close()
    expect(await codeOf(result.commit())).toMatchObject({ code: 'commit-failed' })
    f.expectTargetUntouched()
    await result.discard()
    expect(f.stages()).toEqual([])
    expect(f.workEntries()).toEqual([])
  })

  it.each([
    // Renaming keeps the old inode alive, so the new directory cannot reuse its number.
    ['the staged app was replaced', (p: Awaited<ReturnType<typeof prepared>>) => {
      renameSync(p.staged, `${p.staged}.aside`)
      writeApp(p.staged, 'swapped', NEW_PLIST)
    }],
    ['the running app was replaced', (p: Awaited<ReturnType<typeof prepared>>) => {
      const aside = join(p.f.applications, 'Aside.app')
      renameSync(p.f.target, aside)
      cpSync(aside, p.f.target, { recursive: true })
    }],
    ['something already sits at the backup path', (p: Awaited<ReturnType<typeof prepared>>) => {
      mkdirSync(join(p.stage, 'Agent Inbox.app.previous'))
    }],
  ])('refuses to hand off when %s', async (_label, change) => {
    const p = await prepared()
    change(p)
    expect(await codeOf(p.prepared.commit())).toMatchObject({ code: 'commit-failed' })
    expect(p.spawner.calls).toEqual([])
    await p.prepared.discard()
  })

  it('commits only once', async () => {
    const p = await prepared()
    const first = p.prepared.commit()
    await vi.waitFor(() => expect(p.spawner.calls).toHaveLength(1))
    p.spawner.emitSpawn()
    await first
    expect(await codeOf(p.prepared.commit())).toMatchObject({ code: 'commit-failed' })
    expect(p.spawner.calls).toHaveLength(1)
  })

  it('swaps the app after the app and its viewer exit, keeps the previous app and relaunches (real /bin/sh)', async () => {
    const f = await fixture()
    const bin = join(f.work, 'bin')
    mkdirSync(bin)
    const opener = join(bin, 'open')
    writeFileSync(opener, '#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/open.log"\n', { mode: 0o755 })
    const app = spawn('/bin/sh', ['-c', 'sleep 0.3'], { stdio: 'ignore' })
    const viewer = spawn('/bin/sh', ['-c', 'sleep 0.9'], { stdio: 'ignore' })
    let viewerExited = false
    viewer.once('exit', () => { viewerExited = true })
    const { installer } = installerFor(f, {
      pid: app.pid!,
      viewerPid: () => viewer.pid!,
      spawnImpl: spawn as unknown as MacSpawn,
      binaries: { open: opener },
    })
    const result = await installer.prepare(f.source)
    await f.close()
    const stage = join(f.applications, f.stages()[0]!)

    await result.commit()
    await vi.waitFor(() => expect(existsSync(join(bin, 'open.log'))).toBe(true), { timeout: 10_000, interval: 50 })

    expect(viewerExited).toBe(true)
    expect(readFileSync(join(f.target, 'Contents', 'MacOS', 'Agent Inbox'), 'utf8')).toBe('new build')
    expect(readFileSync(join(stage, 'Agent Inbox.app.previous', 'Contents', 'MacOS', 'Agent Inbox'), 'utf8')).toBe('old build')
    expect(existsSync(join(stage, APP))).toBe(false)
    expect(readFileSync(join(bin, 'open.log'), 'utf8')).toBe(`${f.target}\n`)
  })
})

describe('the swap helper script', () => {
  async function helperFixture() {
    const work = workDir()
    const target = join(work, 'Applications', APP)
    writeApp(target, 'old build', {})
    const stage = join(work, 'Applications', '.agent-inbox-update-abcdef')
    const staged = join(stage, APP)
    writeApp(staged, 'new build', {})
    const backup = join(stage, 'Agent Inbox.app.previous')
    const bin = join(work, 'bin')
    mkdirSync(bin)
    const opener = join(bin, 'open')
    writeFileSync(opener, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$(dirname "$0")/open.log"\n', { mode: 0o755 })
    const script = join(work, 'helper.sh')
    writeFileSync(script, HELPER_SCRIPT, { mode: 0o600 })
    const build = (app: string) => readFileSync(join(app, 'Contents', 'MacOS', 'Agent Inbox'), 'utf8')
    const opened = () => (existsSync(join(bin, 'open.log')) ? readFileSync(join(bin, 'open.log'), 'utf8') : '')
    async function runHelper(args: string[], env: Record<string, string> = {}) {
      try {
        await run('/bin/sh', [script, ...args], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env } })
        return 0
      } catch (error) {
        return (error as { code?: number }).code
      }
    }
    async function exitedPid() {
      const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' })
      await new Promise((resolveExit) => child.once('exit', resolveExit))
      return String(child.pid)
    }
    function sleeper(seconds: number) {
      const child = spawn('/bin/sh', ['-c', `sleep ${seconds}`], { stdio: 'ignore' })
      const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
      return { pid: String(child.pid), exited }
    }
    return { work, target, stage, staged, backup, opener, build, opened, runHelper, exitedPid, sleeper }
  }

  it('swaps the staged app into place and relaunches it', async () => {
    const h = await helperFixture()
    expect(await h.runHelper([await h.exitedPid(), '-', h.target, h.staged, h.backup, h.opener])).toBe(0)
    expect(h.build(h.target)).toBe('new build')
    expect(h.build(h.backup)).toBe('old build')
    expect(existsSync(h.staged)).toBe(false)
    expect(h.opened()).toBe(`${h.target}\n`)
  })

  it.each([
    ['the app exits first', 0.3, 0.9],
    ['the viewer exits first', 0.9, 0.3],
  ])('waits until both the app and its viewer have exited when %s', async (_label, appSeconds, viewerSeconds) => {
    const h = await helperFixture()
    const app = h.sleeper(appSeconds)
    const viewer = h.sleeper(viewerSeconds)
    let swappedEarly = false
    const helper = h.runHelper([app.pid, viewer.pid, h.target, h.staged, h.backup, h.opener])
    const last = appSeconds > viewerSeconds ? app : viewer
    const first = appSeconds > viewerSeconds ? viewer : app
    await first.exited
    // One process is gone and the other still runs: nothing may move yet.
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    swappedEarly = h.build(h.target) !== 'old build' || h.opened() !== ''
    await last.exited
    expect(await helper).toBe(0)
    expect(swappedEarly).toBe(false)
    expect(h.build(h.target)).toBe('new build')
    expect(h.opened()).toBe(`${h.target}\n`)
  })

  it.skipIf(UID === 0)('rolls back and relaunches the previous app when the second rename fails', async () => {
    const h = await helperFixture()
    const backupDir = join(h.work, 'backups')
    mkdirSync(backupDir)
    const backup = join(backupDir, 'Agent Inbox.app.previous')
    chmodSync(h.stage, 0o555)
    try {
      expect(await h.runHelper([await h.exitedPid(), '-', h.target, h.staged, backup, h.opener])).toBe(71)
    } finally {
      chmodSync(h.stage, 0o755)
    }
    expect(h.build(h.target)).toBe('old build')
    expect(existsSync(backup)).toBe(false)
    expect(h.build(h.staged)).toBe('new build')
    expect(h.opened()).toBe(`${h.target}\n`)
  })

  it.skipIf(UID === 0)('relaunches the previous app when the first rename fails', async () => {
    const h = await helperFixture()
    chmodSync(dirname(h.target), 0o555)
    try {
      expect(await h.runHelper([await h.exitedPid(), '-', h.target, h.staged, h.backup, h.opener])).toBe(70)
    } finally {
      chmodSync(dirname(h.target), 0o755)
    }
    expect(h.build(h.target)).toBe('old build')
    expect(h.opened()).toBe(`${h.target}\n`)
  })

  it.each([
    ['the app, with no viewer process', (alive: string) => [alive, '-']],
    ['the app', (alive: string, gone: string) => [alive, gone]],
    ['its viewer', (alive: string, gone: string) => [gone, alive]],
  ])('gives up without changes when %s never exits', async (_label, pids) => {
    const h = await helperFixture()
    const started = Date.now()
    const args = [...pids(String(process.pid), await h.exitedPid()), h.target, h.staged, h.backup, h.opener]
    expect(await h.runHelper(args, { AGENT_INBOX_UPDATE_HELPER_TICKS: '3' })).toBe(75)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(h.build(h.target)).toBe('old build')
    expect(h.build(h.staged)).toBe('new build')
    expect(existsSync(h.backup)).toBe(false)
    expect(h.opened()).toBe('')
  })

  it('refuses a symlinked target without relaunching anything', async () => {
    const h = await helperFixture()
    const real = join(h.work, 'Real.app')
    cpSync(h.target, real, { recursive: true })
    rmSync(h.target, { recursive: true })
    symlinkSync(real, h.target)
    expect(await h.runHelper([await h.exitedPid(), '-', h.target, h.staged, h.backup, h.opener])).toBe(65)
    expect(lstatSync(h.target).isSymbolicLink()).toBe(true)
    expect(h.build(real)).toBe('old build')
    expect(h.build(h.staged)).toBe('new build')
    expect(h.opened()).toBe('')
  })

  it('refuses when the backup path is taken and relaunches the untouched app', async () => {
    const h = await helperFixture()
    mkdirSync(h.backup)
    expect(await h.runHelper([await h.exitedPid(), '-', h.target, h.staged, h.backup, h.opener])).toBe(65)
    expect(h.build(h.target)).toBe('old build')
    expect(readdirSync(h.backup)).toEqual([])
    expect(h.opened()).toBe(`${h.target}\n`)
  })

  type Helper = Awaited<ReturnType<typeof helperFixture>>
  it.each([
    ['a relative target', (h: Helper, pid: string) => [pid, '-', 'Applications/Agent Inbox.app', h.staged, h.backup, h.opener]],
    ['a dot-dot path', (h: Helper, pid: string) => [pid, '-', h.target, `${h.stage}/../x/${APP}`, h.backup, h.opener]],
    ['a non-numeric pid', (h: Helper) => ['12x', '-', h.target, h.staged, h.backup, h.opener]],
    ['pid zero', (h: Helper) => ['0', '-', h.target, h.staged, h.backup, h.opener]],
    ['a non-numeric viewer pid', (h: Helper, pid: string) => [pid, 'x1', h.target, h.staged, h.backup, h.opener]],
    ['viewer pid zero', (h: Helper, pid: string) => [pid, '0', h.target, h.staged, h.backup, h.opener]],
    ['an empty viewer pid', (h: Helper, pid: string) => [pid, '', h.target, h.staged, h.backup, h.opener]],
    ['a missing argument', (h: Helper, pid: string) => [pid, h.target, h.staged, h.backup, h.opener]],
  ])('refuses %s before waiting or touching anything', async (_label, args) => {
    const h = await helperFixture()
    expect(await h.runHelper(args(h, await h.exitedPid()))).toBe(64)
    expect(h.build(h.target)).toBe('old build')
    expect(h.build(h.staged)).toBe('new build')
    expect(h.opened()).toBe('')
  })

  it('is constant text that never interpolates or evaluates its arguments', () => {
    expect(HELPER_SCRIPT).toMatch(/^#!\/bin\/sh\n/)
    expect(HELPER_SCRIPT).toContain('set -u')
    expect(HELPER_SCRIPT).not.toMatch(/\beval\b/)
    expect(HELPER_SCRIPT).not.toMatch(/`/)
    // No command substitution; POSIX arithmetic $((…)) is fine.
    expect(HELPER_SCRIPT).not.toMatch(/\$\((?!\()/)
    // Every expansion of an argument variable is quoted.
    expect(HELPER_SCRIPT).not.toMatch(/[^"]\$(pid|viewer|target|staged|backup|opener)\b/)
    expect(HELPER_SCRIPT).toContain('kill -0 "$pid"')
    expect(HELPER_SCRIPT).toContain('kill -0 "$viewer"')
    expect(HELPER_SCRIPT).toContain('mv "$target" "$backup"')
    expect(HELPER_SCRIPT).toContain('mv "$staged" "$target"')
    expect(HELPER_SCRIPT).toContain('mv "$backup" "$target"')
  })
})

describe('startup cleanup', () => {
  const HOUR = 60 * 60_000

  function aged(path: string, ageMs: number) {
    const when = new Date(Date.now() - ageMs)
    for (const name of readdirSync(path)) utimesSync(join(path, name), when, when)
    utimesSync(path, when, when)
  }

  it('removes only old directories with its exact names, owned by this user, without following links', async () => {
    const f = await fixture()
    await f.close()
    mkdirSync(f.workDirectory, { recursive: true, mode: 0o700 })
    const oldWork = join(f.workDirectory, 'install-AAAAAA')
    mkdirSync(join(oldWork, 'mnt'), { recursive: true })
    writeFileSync(join(oldWork, 'helper.sh'), HELPER_SCRIPT)
    aged(oldWork, 2 * HOUR)
    const freshWork = join(f.workDirectory, 'install-BBBBBB')
    mkdirSync(freshWork)
    const oldStage = join(f.applications, '.agent-inbox-update-CCCCCC')
    writeApp(join(oldStage, 'Agent Inbox.app.previous'), 'old build', {})
    aged(oldStage, 2 * HOUR)
    const freshStage = join(f.applications, '.agent-inbox-update-DDDDDD')
    writeApp(join(freshStage, 'Agent Inbox.app.previous'), 'old build', {})
    const foreignName = join(f.applications, '.agent-inbox-update-old')
    mkdirSync(foreignName)
    aged(foreignName, 2 * HOUR)
    const outside = join(f.work, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep me')
    symlinkSync(outside, join(f.applications, '.agent-inbox-update-EEEEEE'))
    symlinkSync(outside, join(f.workDirectory, 'install-FFFFFF'))

    const { installer } = installerFor(f)
    await installer.cleanup!()

    expect(existsSync(oldWork)).toBe(false)
    expect(existsSync(freshWork)).toBe(true)
    expect(existsSync(oldStage)).toBe(false)
    expect(existsSync(freshStage)).toBe(true)
    expect(existsSync(foreignName)).toBe(true)
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
    expect(lstatSync(join(f.applications, '.agent-inbox-update-EEEEEE')).isSymbolicLink()).toBe(true)
    f.expectTargetUntouched()
  })

  it('leaves directories owned by another user', async () => {
    const f = await fixture()
    await f.close()
    const oldStage = join(f.applications, '.agent-inbox-update-CCCCCC')
    mkdirSync(oldStage)
    aged(oldStage, 2 * HOUR)
    await installerFor(f, { uid: UID + 1 }).installer.cleanup!()
    expect(existsSync(oldStage)).toBe(true)
  })

  it('bounds the removals in one pass', async () => {
    const f = await fixture()
    await f.close()
    for (let index = 0; index < 12; index += 1) {
      const stage = join(f.applications, `.agent-inbox-update-${String(index).padStart(6, '0')}`)
      mkdirSync(stage)
      aged(stage, 2 * HOUR)
    }
    const { installer } = installerFor(f)
    await installer.cleanup!()
    expect(f.stages()).toHaveLength(4)
    await installer.cleanup!()
    expect(f.stages()).toHaveLength(0)
  })

  it('never rejects', async () => {
    const f = await fixture()
    await f.close()
    const broken: MacInstallerFs = {
      ...(fsp as unknown as MacInstallerFs),
      readdir: async () => { throw new Error('EIO') },
    }
    await expect(installerFor(f, { fsImpl: broken }).installer.cleanup!()).resolves.toBeUndefined()
  })
})

describe('locating the running app bundle', () => {
  it.each([
    ['/Applications/Agent Inbox.app/Contents/MacOS/Agent Inbox', '/Applications/Agent Inbox.app'],
    ['/Users/me/Applications/Agent Inbox.app/Contents/MacOS/Agent Inbox', '/Users/me/Applications/Agent Inbox.app'],
    ['/usr/local/bin/electron', null],
    ['/Applications/Agent Inbox.app/Contents/Resources/app/x', null],
    ['Agent Inbox.app/Contents/MacOS/Agent Inbox', null],
    ['/Contents/MacOS/Agent Inbox', null],
  ])('derives %s', (execPath, expected) => {
    expect(bundlePathFromExecPath(execPath)).toBe(expected)
  })

  it('names only absolute system binaries', () => {
    expect(MAC_INSTALL_BINARIES).toEqual({
      hdiutil: '/usr/bin/hdiutil',
      codesign: '/usr/bin/codesign',
      spctl: '/usr/sbin/spctl',
      ditto: '/usr/bin/ditto',
      plutil: '/usr/bin/plutil',
      open: '/usr/bin/open',
      sh: '/bin/sh',
    })
  })
})
