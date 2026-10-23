'use strict'

// Electron-main-only macOS installer (#196, part 2). prepare() copies the
// verified DMG out of the handle the downloader just re-hashed (hashing again
// while copying), mounts that private copy read-only, stages the app with ditto
// beside the running bundle on the same volume, and verifies the STAGED copy:
// bundle identifier and version, a code-signing requirement built only from
// constants, and Gatekeeper. Node-written files carry no quarantine, so this
// explicit spctl assessment is the only Gatekeeper evaluation the update gets.
// commit() hands the swap to a constant shell helper that waits for this
// process to exit, renames the running app aside, renames the staged app into
// place (rolling back on failure) and relaunches it. Every binary is an
// absolute path run with an argv array; nothing here builds a shell string.

const childProcess = require('node:child_process')
const { constants } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { UpdateInstallError, copyVerifiedSource } = require('./update-install.cjs')

const MAC_INSTALL_BINARIES = Object.freeze({
  hdiutil: '/usr/bin/hdiutil',
  codesign: '/usr/bin/codesign',
  spctl: '/usr/sbin/spctl',
  ditto: '/usr/bin/ditto',
  plutil: '/usr/bin/plutil',
  open: '/usr/bin/open',
  sh: '/bin/sh',
})
const EXPECTED_BUNDLE_ID = 'io.github.shariqh.agent-inbox'
const TEAM_ID = 'VVR2DKR923'
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const TEAM_ID_RE = /^[A-Z0-9]{10}$/
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MACOS_VERSION_RE = /^\d+(\.\d+){0,2}$/
const TRANSLOCATION = '/AppTranslocation/'
const APP_NAME = 'Agent Inbox.app'
const EXECUTABLE_NAME = 'Agent Inbox'
const BACKUP_NAME = 'Agent Inbox.app.previous'
const STAGE_PREFIX = '.agent-inbox-update-'
const STAGE_RE = /^\.agent-inbox-update-[A-Za-z0-9]{6}$/
const WORK_PREFIX = 'install-'
const WORK_RE = /^install-[A-Za-z0-9]{6}$/
const DMG_NAME = 'update.dmg'
const MOUNT_NAME = 'mnt'
const HELPER_NAME = 'helper.sh'
const HELPER_RESULT_NAME = 'helper.result'
const COMMAND_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' })
const HELPER_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
const TIMEOUTS = Object.freeze({
  attach: 5 * 60_000,
  detach: 60_000,
  ditto: 10 * 60_000,
  plutil: 30_000,
  codesign: 10 * 60_000,
  spctl: 5 * 60_000,
})
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const STALE_AFTER_MS = 60 * 60_000
const MAX_CLEANUP_REMOVALS = 8
const MAX_ENTRIES_CHECKED = 8
// The DMG builds update manifest v2 lists (#343), and the cpu_type_t each process.arch
// needs in the staged executable: CPU_TYPE_ARM64 and CPU_TYPE_X86_64.
const ARCHITECTURES = new Set(['universal', 'arm64'])
const CPU_TYPES = Object.freeze({ arm64: 0x0100000c, x64: 0x01000007 })
const HEADER_BYTES = 4096
const MAX_FAT_ARCHES = 8
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const MH_MAGIC_64 = 0xfeedfacf

const MOVE_MESSAGE = 'Move Agent Inbox to your Applications folder to install updates from the app.'
const FEASIBILITY_MESSAGES = Object.freeze({
  unsupported: 'Installing updates from the app needs the packaged macOS app.',
  'system-version': 'This update needs a newer version of macOS.',
  location: MOVE_MESSAGE,
  translocated: MOVE_MESSAGE,
  'read-only': MOVE_MESSAGE,
  owner: 'This copy of Agent Inbox belongs to another user account, so it cannot update itself. Use Review release instead.',
  permission: 'Agent Inbox cannot replace itself in its current folder. Use Review release instead.',
  // Under Rosetta this is an Apple silicon Mac, so the copy names neither processor.
  architecture: 'This update runs only natively on a Mac with Apple silicon.',
  error: 'Agent Inbox cannot install updates from the app here. Use Review release instead.',
})

// Constant text: every path arrives as an argument and is expanded only inside
// double quotes. The helper waits until the app AND the viewer process it
// started (`-` when the viewer runs in-process or was reused) have both exited,
// so the relaunched app never finds the old viewer still answering on its port.
// Before every exit it writes its exit code, and nothing else, to <result>
// (temp file + rename), using the shared INSTALL_HELPER_EXIT convention:
// 64 bad arguments, 75 they never exited (no changes), 65 refused before any
// change, 70 the app could not be moved aside, 71 the new app could not be moved
// into place (previous app restored), 0 installed.
const HELPER_SCRIPT = `#!/bin/sh
# Agent Inbox update helper (#196).
# Usage: sh helper.sh <app-pid> <viewer-pid|-> <target.app> <staged.app> <backup> <open> <result>
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077

[ "$#" -eq 7 ] || exit 64
pid=$1
viewer=$2
target=$3
staged=$4
backup=$5
opener=$6
result=$7

# A path argument is absolute, has no dot segments and no trailing slash (which
# would make the symlink checks below test the link's target instead).
valid_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    */|*/../*|*/..|*/./*|*/.) return 1 ;;
  esac
  return 0
}

# The report location is checked first: nothing is written anywhere else.
valid_path "$result" || exit 64

finish() {
  report "$1"
  exit "$1"
}

report() {
  if printf '%s\\n' "$1" > "$result.tmp.$$" 2>/dev/null; then
    mv -f "$result.tmp.$$" "$result" 2>/dev/null || rm -f "$result.tmp.$$"
  fi
}

case "$pid" in
  ''|0*|*[!0-9]*) finish 64 ;;
esac
case "$viewer" in
  -) ;;
  ''|0*|*[!0-9]*) finish 64 ;;
esac
for value in "$target" "$staged" "$backup" "$opener"; do
  valid_path "$value" || finish 64
done

ticks=\${AGENT_INBOX_UPDATE_HELPER_TICKS:-600}
case "$ticks" in
  ''|*[!0-9]*) ticks=600 ;;
esac

relaunch() {
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    "$opener" "$target" >/dev/null 2>&1 || :
  fi
}

running() {
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  if [ "$viewer" != "-" ] && kill -0 "$viewer" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Wait for Agent Inbox and its viewer to exit, about 0.2 seconds per tick.
waited=0
while running; do
  if [ "$waited" -ge "$ticks" ]; then
    finish 75
  fi
  waited=$((waited + 1))
  sleep 0.2
done

# Each outcome is reported before the app reopens, because the reopened app
# reads the attempt as it starts.
if [ ! -d "$target" ] || [ -L "$target" ] || [ ! -d "$staged" ] || [ -L "$staged" ] || [ -e "$backup" ] || [ -L "$backup" ]; then
  report 65
  relaunch
  exit 65
fi

if ! mv "$target" "$backup"; then
  report 70
  relaunch
  exit 70
fi

if ! mv "$staged" "$target"; then
  mv "$backup" "$target" || :
  report 71
  relaunch
  exit 71
fi

report 0
"$opener" "$target" >/dev/null 2>&1 || :
exit 0
`

// <X>.app/Contents/MacOS/<executable> -> <X>.app
function bundlePathFromExecPath(execPath) {
  if (typeof execPath !== 'string' || !path.isAbsolute(execPath)) return null
  const macos = path.dirname(execPath)
  const contents = path.dirname(macos)
  const bundle = path.dirname(contents)
  if (path.basename(macos) !== 'MacOS' || path.basename(contents) !== 'Contents') return null
  if (!bundle.endsWith('.app') || path.basename(bundle) === '.app') return null
  return bundle
}

function validBundlePath(value) {
  return typeof value === 'string'
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && value.endsWith('.app')
    && path.basename(value) !== '.app'
}

// The helper's own rule: absolute, no dot segments, no trailing slash.
function validHelperPath(value) {
  return typeof value === 'string'
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && !value.endsWith('/')
}

function versionNumbers(value) {
  if (typeof value !== 'string' || !MACOS_VERSION_RE.test(value)) return null
  const parts = value.split('.').map(Number)
  while (parts.length < 3) parts.push(0)
  return parts
}

function systemAtLeast(system, minimum) {
  const have = versionNumbers(system)
  const need = versionNumbers(minimum)
  if (have === null || need === null) return false
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index]
  }
  return true
}

// The CPU types a Mach-O header names: a fat header (32- or 64-bit entries, 1 to 8 of them,
// all inside `bytes`) or a thin 64-bit little-endian one; null for anything else. A Java
// class file shares the fat magic and fails on its count.
function machCpuTypes(bytes) {
  if (bytes.length < 8) return null
  const magic = bytes.readUInt32BE(0)
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const count = bytes.readUInt32BE(4)
    const entry = magic === FAT_MAGIC ? 20 : 32
    if (count < 1 || count > MAX_FAT_ARCHES || 8 + count * entry > bytes.length) return null
    return Array.from({ length: count }, (_, index) => bytes.readUInt32BE(8 + index * entry))
  }
  if (bytes.readUInt32LE(0) === MH_MAGIC_64) return [bytes.readUInt32LE(4)]
  return null
}

function refuse(reason, message = FEASIBILITY_MESSAGES[reason] ?? FEASIBILITY_MESSAGES.error) {
  return Object.freeze({ ok: false, reason, message })
}

function createMacInstaller(options = {}) {
  if (typeof options.workDirectory !== 'string' || !path.isAbsolute(options.workDirectory)) {
    throw new TypeError('workDirectory must be an absolute path')
  }
  const root = path.resolve(options.workDirectory)
  const expectedBundleId = options.expectedBundleId ?? EXPECTED_BUNDLE_ID
  const teamId = options.teamId ?? TEAM_ID
  if (typeof expectedBundleId !== 'string' || !BUNDLE_ID_RE.test(expectedBundleId)) throw new TypeError('expectedBundleId is invalid')
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) throw new TypeError('teamId is invalid')
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) throw new TypeError('pid must be a positive integer')
  if (!Number.isSafeInteger(options.uid) || options.uid < 0) throw new TypeError('uid must be a non-negative integer')
  if (options.viewerPid !== undefined && typeof options.viewerPid !== 'function') {
    throw new TypeError('viewerPid must be a function')
  }
  if (options.hostArch !== undefined && typeof options.hostArch !== 'string') throw new TypeError('hostArch must be a string')
  const binaries = Object.freeze({ ...MAC_INSTALL_BINARIES, ...(options.binaries ?? {}) })
  for (const [name, value] of Object.entries(binaries)) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`)
  }
  const pid = options.pid
  const uid = options.uid
  // Read at commit time: the viewer this app started and stops when it quits.
  const viewerPid = options.viewerPid ?? (() => null)
  const bundlePath = typeof options.bundlePath === 'string' ? options.bundlePath : null
  const platform = options.platform ?? process.platform
  const isPackaged = options.isPackaged === true
  const systemVersion = typeof options.systemVersion === 'string' ? options.systemVersion : ''
  // This process's architecture: x64 under Rosetta, so an arm64-only build never fits it.
  const hostArch = options.hostArch ?? process.arch
  const cpuType = Object.hasOwn(CPU_TYPES, hostArch) ? CPU_TYPES[hostArch] : null
  const execFileImpl = options.execFileImpl ?? childProcess.execFile
  const spawnImpl = options.spawnImpl ?? childProcess.spawn
  const fsImpl = options.fsImpl ?? fs
  const nowMs = options.nowMs ?? Date.now
  // Built only from the validated constants above.
  const requirement = `anchor apple generic and identifier "${expectedBundleId}" and certificate leaf[subject.OU] = "${teamId}"`

  function run(name, args, timeout, signal) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = execFileImpl(binaries[name], args, {
          encoding: 'utf8',
          env: { ...COMMAND_ENV },
          timeout,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          ...(signal ? { signal } : {}),
        }, (error, stdout) => {
          if (error) reject(error)
          else resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''))
        })
      } catch (error) {
        reject(error)
        return
      }
      // Nothing reads stdin: EOF makes a license prompt fail instead of waiting.
      try {
        child?.stdin?.end()
      } catch {
        // The child may already have exited.
      }
    })
  }

  function cancelled() {
    return new UpdateInstallError('staging', 'update install was cancelled')
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw cancelled()
  }

  // Runs one step and maps any unexpected error to `code`, never to its text.
  async function step(code, signal, operation) {
    try {
      return await operation()
    } catch (error) {
      if (signal?.aborted) throw cancelled()
      if (error instanceof UpdateInstallError) throw error
      throw new UpdateInstallError(code)
    }
  }

  async function detach(mount) {
    try {
      await run('hdiutil', ['detach', mount], TIMEOUTS.detach)
      return
    } catch {
      // Busy volumes usually detach with -force.
    }
    try {
      await run('hdiutil', ['detach', '-force', mount], TIMEOUTS.detach)
    } catch {
      // Left for removeWork() and startup cleanup to retry.
    }
  }

  async function isMountPoint(directory, parent) {
    try {
      const [inner, outer] = await Promise.all([fsImpl.lstat(directory), fsImpl.lstat(parent)])
      return inner.dev !== outer.dev
    } catch {
      return false
    }
  }

  async function removeWork(directory) {
    if (directory === null) return
    const mount = path.join(directory, MOUNT_NAME)
    if (await isMountPoint(mount, directory)) {
      await detach(mount)
      // Never recurse into a volume that is still mounted.
      if (await isMountPoint(mount, directory)) return
    }
    await fsImpl.rm(directory, { recursive: true, force: true })
  }

  async function removeStage(directory) {
    if (directory === null) return
    let stat
    try {
      stat = await fsImpl.lstat(directory)
    } catch {
      return
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await fsImpl.rm(directory, { recursive: true, force: true })
  }

  async function ensureWorkRoot() {
    await fsImpl.mkdir(root, { recursive: true, mode: 0o700 })
    const stat = await fsImpl.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) throw new UpdateInstallError('staging')
    if ((stat.mode & 0o777) !== 0o700) await fsImpl.chmod(root, 0o700)
  }

  async function identityOf(target) {
    const stat = await fsImpl.lstat(target, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a real directory')
    return { dev: stat.dev, ino: stat.ino }
  }

  async function findMountedApp(mount) {
    const names = await step('staging', null, () => fsImpl.readdir(mount))
    const apps = names.filter((name) => name.toLowerCase().endsWith('.app'))
    if (apps.length !== 1 || apps[0] !== APP_NAME) throw new UpdateInstallError('verification-failed')
    const candidate = path.join(mount, APP_NAME)
    const stat = await step('verification-failed', null, () => fsImpl.lstat(candidate))
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UpdateInstallError('verification-failed')
    return candidate
  }

  async function verifyStaged(staged, version, signal) {
    const plist = path.join(staged, 'Contents', 'Info.plist')
    await step('verification-failed', signal, async () => {
      const stat = await fsImpl.lstat(plist)
      if (!stat.isFile()) throw new Error('Info.plist is not a regular file')
      const info = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', plist], TIMEOUTS.plutil, signal))
      if (
        info?.CFBundleIdentifier !== expectedBundleId
        || info?.CFBundleShortVersionString !== version
        || info?.CFBundleExecutable !== EXECUTABLE_NAME
      ) {
        throw new Error('staged bundle identity does not match the release')
      }
    })
    throwIfAborted(signal)
    await verifySlice(staged, signal)
    throwIfAborted(signal)
    await step('verification-failed', signal, () => run(
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', `-R=${requirement}`, staged],
      TIMEOUTS.codesign,
      signal,
    ))
    throwIfAborted(signal)
    await step('verification-failed', signal, () => run(
      'spctl',
      ['--assess', '--type', 'execute', '--verbose=2', staged],
      TIMEOUTS.spctl,
      signal,
    ))
  }

  // The bytes that will run, not the manifest's label (#343): the executable the staged
  // bundle launches must carry a slice for this process. No external tool: /usr/bin/lipo is
  // the shared Xcode stub, which without the Command Line Tools only offers to install them.
  async function verifySlice(staged, signal) {
    await step('verification-failed', signal, async () => {
      const executable = path.join(staged, 'Contents', 'MacOS', EXECUTABLE_NAME)
      const handle = await fsImpl.open(executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let header
      try {
        if (!(await handle.stat()).isFile()) throw new Error('the staged executable is not a regular file')
        const buffer = Buffer.alloc(HEADER_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
        header = buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
      if (cpuType === null || !machCpuTypes(header)?.includes(cpuType)) {
        throw new Error('the staged app has no slice for this process')
      }
    })
  }

  // `-` tells the helper there is no separate viewer process to wait for.
  function viewerArgument() {
    const value = viewerPid()
    if (value === null || value === undefined) return '-'
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('viewer pid is invalid')
    return String(value)
  }

  function spawnHelper(script, staged, backup, resultPath) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawnImpl(binaries.sh, [script, String(pid), viewerArgument(), bundlePath, staged, backup, binaries.open, resultPath], {
          detached: true,
          stdio: 'ignore',
          env: { ...HELPER_ENV },
          cwd: '/',
        })
      } catch (error) {
        reject(error)
        return
      }
      child.once('error', reject)
      child.once('spawn', () => resolve())
      child.unref()
    })
  }

  function preparedInstall({ work, stage, staged, targetIdentity, stagedIdentity }) {
    const backup = path.join(stage, BACKUP_NAME)
    let phase = 'prepared'
    let discarding = null

    async function sameIdentity(target, expected) {
      const actual = await identityOf(target)
      if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('identity changed')
    }

    async function absent(target) {
      try {
        await fsImpl.lstat(target)
      } catch (error) {
        if (error?.code === 'ENOENT') return
        throw error
      }
      throw new Error('path already exists')
    }

    return Object.freeze({
      // `resultPath` is where the helper reports its exit code; the controller
      // passes the attempt store's path so the next app start can read it.
      async commit(commitOptions = {}) {
        if (phase !== 'prepared') throw new UpdateInstallError('commit-failed')
        phase = 'committing'
        try {
          const resultPath = commitOptions?.resultPath ?? path.join(work, HELPER_RESULT_NAME)
          if (!validHelperPath(resultPath)) throw new Error('result path is invalid')
          await sameIdentity(bundlePath, targetIdentity)
          await sameIdentity(staged, stagedIdentity)
          await absent(backup)
          const script = path.join(work, HELPER_NAME)
          await fsImpl.writeFile(script, HELPER_SCRIPT, { mode: 0o600, flag: 'wx' })
          await spawnHelper(script, staged, backup, resultPath)
          phase = 'committed'
        } catch {
          phase = 'failed'
          throw new UpdateInstallError('commit-failed')
        }
      },
      // The previous app is kept in the stage directory after a swap, so a
      // committed install is never discarded; startup cleanup removes it later.
      discard() {
        if (phase === 'committing' || phase === 'committed') return Promise.resolve()
        if (discarding === null) {
          phase = 'discarded'
          discarding = (async () => {
            await removeStage(stage).catch(() => {})
            await removeWork(work).catch(() => {})
          })()
        }
        return discarding
      },
    })
  }

  async function feasibility(candidate) {
    try {
      if (platform !== 'darwin' || !isPackaged) return refuse('unsupported')
      const architecture = candidate?.architecture
      if (cpuType === null || !ARCHITECTURES.has(architecture)) return refuse('error')
      if (architecture === 'arm64' && hostArch !== 'arm64') return refuse('architecture')
      const minimum = candidate?.minimumSystemVersion
      if (minimum !== undefined) {
        if (typeof minimum !== 'string' || !MACOS_VERSION_RE.test(minimum)) return refuse('system-version')
        if (!systemAtLeast(systemVersion, minimum)) {
          return refuse('system-version', `This update needs macOS ${minimum} or later.`)
        }
      }
      if (!validBundlePath(bundlePath)) return refuse('location')
      if (bundlePath.includes(TRANSLOCATION)) return refuse('translocated')
      let real
      try {
        real = await fsImpl.realpath(bundlePath)
      } catch {
        return refuse('location')
      }
      if (typeof real !== 'string' || real.includes(TRANSLOCATION)) return refuse('translocated')
      let stat
      try {
        stat = await fsImpl.lstat(bundlePath)
      } catch {
        return refuse('location')
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return refuse('location')
      if (stat.uid !== uid) return refuse('owner')
      // Moving the bundle to another folder rewrites its "..", so the bundle
      // itself must be writable as well as the folder that holds it.
      for (const target of [path.dirname(bundlePath), bundlePath]) {
        try {
          await fsImpl.access(target, constants.W_OK)
        } catch (error) {
          return refuse(error?.code === 'EROFS' ? 'read-only' : 'permission')
        }
      }
      return Object.freeze({ ok: true })
    } catch {
      return refuse('error')
    }
  }

  async function prepare(source, prepareOptions = {}) {
    const signal = prepareOptions?.signal
    const record = source?.record
    if (
      !record
      || record.installStrategy !== 'macos-dmg'
      || record.packageType !== 'dmg'
      || typeof record.version !== 'string'
      || !VERSION_RE.test(record.version)
      || !ARCHITECTURES.has(record.architecture)
    ) {
      throw new UpdateInstallError('not-verified')
    }
    // Before anything is touched: an arm64-only build never runs in this process.
    if (cpuType === null || (record.architecture === 'arm64' && hostArch !== 'arm64')) {
      throw new UpdateInstallError('not-feasible')
    }
    if (!validBundlePath(bundlePath)) throw new UpdateInstallError('not-feasible')
    let work = null
    let stage = null
    try {
      await step('staging', signal, ensureWorkRoot)
      throwIfAborted(signal)
      work = await step('staging', signal, () => fsImpl.mkdtemp(path.join(root, WORK_PREFIX)))
      const dmg = path.join(work, DMG_NAME)
      await copyVerifiedSource(source, dmg, { fsImpl, signal })
      throwIfAborted(signal)
      const mount = path.join(work, MOUNT_NAME)
      await step('staging', signal, () => fsImpl.mkdir(mount, { mode: 0o700 }))
      let staged
      try {
        await step('staging', signal, () => run(
          'hdiutil',
          ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg],
          TIMEOUTS.attach,
          signal,
        ))
        const mountedApp = await findMountedApp(mount)
        throwIfAborted(signal)
        stage = await step('staging', signal, () => fsImpl.mkdtemp(path.join(path.dirname(bundlePath), STAGE_PREFIX)))
        // The helper's renames are atomic only within one volume.
        await step('staging', signal, async () => {
          const [stageStat, bundleStat] = await Promise.all([fsImpl.stat(stage), fsImpl.stat(bundlePath)])
          if (stageStat.dev !== bundleStat.dev) throw new Error('stage is on another volume')
        })
        staged = path.join(stage, APP_NAME)
        await step('staging', signal, () => run('ditto', [mountedApp, staged], TIMEOUTS.ditto, signal))
      } finally {
        await detach(mount)
      }
      if (!(await isMountPoint(mount, work))) await fsImpl.rmdir(mount).catch(() => {})
      await fsImpl.unlink(dmg).catch(() => {})
      throwIfAborted(signal)
      // hdiutil reads lazily, so only the staged copy is evidence of what will run.
      await verifyStaged(staged, record.version, signal)
      throwIfAborted(signal)
      const targetIdentity = await step('staging', signal, () => identityOf(bundlePath))
      const stagedIdentity = await step('staging', signal, () => identityOf(staged))
      return preparedInstall({ work, stage, staged, targetIdentity, stagedIdentity })
    } catch (error) {
      await removeStage(stage).catch(() => {})
      await removeWork(work).catch(() => {})
      if (error instanceof UpdateInstallError) throw error
      throw new UpdateInstallError('staging')
    }
  }

  async function isStale(entry, stat) {
    let newest = Number(stat.mtimeMs)
    const names = await fsImpl.readdir(entry)
    for (const name of names.slice(0, MAX_ENTRIES_CHECKED)) {
      try {
        newest = Math.max(newest, Number((await fsImpl.lstat(path.join(entry, name))).mtimeMs))
      } catch {
        // Removed concurrently.
      }
    }
    return nowMs() - newest > STALE_AFTER_MS
  }

  async function cleanup() {
    try {
      const sweeps = [[root, WORK_RE, removeWork]]
      if (validBundlePath(bundlePath)) sweeps.push([path.dirname(bundlePath), STAGE_RE, removeStage])
      let removals = 0
      for (const [directory, pattern, remove] of sweeps) {
        let names
        try {
          names = await fsImpl.readdir(directory)
        } catch {
          continue
        }
        for (const name of names) {
          if (removals >= MAX_CLEANUP_REMOVALS) return
          if (!pattern.test(name)) continue
          const entry = path.join(directory, name)
          try {
            const stat = await fsImpl.lstat(entry)
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) continue
            if (!(await isStale(entry, stat))) continue
            removals += 1
            await remove(entry)
          } catch {
            // Best effort: the next launch retries.
          }
        }
      }
    } catch {
      // Cleanup never fails startup.
    }
  }

  return Object.freeze({
    strategy: 'macos-dmg',
    feasibility,
    prepare,
    cleanup,
  })
}

module.exports = {
  HELPER_SCRIPT,
  MAC_INSTALL_BINARIES,
  bundlePathFromExecPath,
  createMacInstaller,
}
