import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = resolve(import.meta.dirname, '..')
const LEASE = join(REPO, 'scripts', 'setup-lock.sh')
const AGENT_INSTALLER = join(REPO, 'scripts', 'install-agents.sh')
const HOOK_INSTALLER = join(REPO, 'scripts', 'install-hooks.sh')
const CALLER = 'setup-lock-test'
const BUSY = `${CALLER}: another setup is already running`

interface ShellResult {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error?: Error
}

const livePids = new Set<number>()
const liveGroups = new Set<number>()

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

function commandPath(name: string): string | null {
  const result = spawnSync('/bin/bash', ['-c', `command -v ${name}`], {
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function shell(
  body: string,
  options: {
    home?: string
    lock?: string
    env?: NodeJS.ProcessEnv
    timeout?: number
  } = {},
): ShellResult {
  const home = options.home ?? temp('setup-lock-home-')
  const lock = options.lock ?? join(home, '.agent-inbox', 'install-agents.lock')
  const result = spawnSync(
    '/bin/bash',
    ['-c', `set -u\n${body}`, 'setup-lock-shell', LEASE],
    {
      encoding: 'utf8',
      timeout: options.timeout ?? 3_000,
      env: {
        ...process.env,
        HOME: home,
        AGENT_INBOX_INSTALL_LOCK_DIR: lock,
        ...options.env,
      },
    },
  )
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  }
}

function acquireBody(extra = ''): string {
  return `source "$1"\n${extra}\nacquire_setup_lock ${CALLER}`
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
}

async function waitForGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000
  while (true) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for pid ${pid} to exit`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
  livePids.delete(pid)
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
  liveGroups.delete(pid)
}

function makeFlockAdapter(dir: string, log: string): string {
  const realFlock = commandPath('flock')
  const path = join(dir, 'flock')
  if (realFlock) {
    executable(path, `printf 'flock\\n' >> "$TOOL_LOG"\nexec ${quote(realFlock)} "$@"`)
  } else if (existsSync('/usr/bin/lockf')) {
    executable(path, [
      'printf \'flock\\n\' >> "$TOOL_LOG"',
      '[ "$1" = -E ] && [ "$2" = 75 ] && [ "$3" = -n ] || exit 64',
      'exec /usr/bin/lockf -s -t 0 "$4"',
    ].join('\n'))
  } else {
    throw new Error('setup lock tests require flock or /usr/bin/lockf')
  }
  return path
}

function startHolder(
  body: string,
  lock: string,
  env: NodeJS.ProcessEnv = {},
  detached = false,
): ChildProcess {
  const child = spawn(
    '/bin/bash',
    ['-c', `set -u\nsource "$1"\n${body}`, 'setup-lock-holder', LEASE],
    {
      detached,
      env: {
        ...process.env,
        HOME: dirname(dirname(lock)),
        AGENT_INBOX_INSTALL_LOCK_DIR: lock,
        ...env,
      },
      stdio: 'ignore',
    },
  )
  if (child.pid === undefined) throw new Error('holder did not receive a pid')
  if (detached) liveGroups.add(child.pid)
  else livePids.add(child.pid)
  return child
}

afterEach(() => {
  for (const pid of liveGroups) killGroup(pid)
  for (const pid of livePids) killPid(pid)
})

describe('shared Setup lock lease', () => {
  it('selects the native lock domain and never invokes a non-selected shadow tool', () => {
    const home = temp('setup-lock-native-')
    const fakebin = join(home, 'fakebin')
    const log = join(home, 'tools.log')
    mkdirSync(fakebin)
    executable(join(fakebin, 'lockf'), 'printf \'lockf-shadow\\n\' >> "$TOOL_LOG"\nexit 99')

    const nativeFlock = commandPath('flock')
    const builtInLockf = process.platform === 'darwin' && existsSync('/usr/bin/lockf')
    if (builtInLockf) {
      executable(join(fakebin, 'flock'), 'printf \'flock-shadow\\n\' >> "$TOOL_LOG"\nexit 99')
    } else {
      if (!nativeFlock) throw new Error('native Setup lock test requires flock')
      executable(
        join(fakebin, 'flock'),
        `printf 'flock\\n' >> "$TOOL_LOG"\nexec ${quote(nativeFlock)} "$@"`,
      )
    }

    const result = shell(
      `${acquireBody()}\nprintf '%s\\n' "$_AGENT_INBOX_SETUP_LOCK_TOOL"`,
      {
        home,
        env: {
          PATH: `${fakebin}:/usr/bin:/bin`,
          TOOL_LOG: log,
        },
      },
    )

    expect(result.status, result.stderr).toBe(0)
    if (builtInLockf) {
      expect(result.stdout.trim()).toBe('/usr/bin/lockf')
      expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('')
    } else {
      expect(result.stdout.trim()).toBe(join(fakebin, 'flock'))
      expect(readFileSync(log, 'utf8')).toBe('flock\n')
    }
  })

  it('uses flock on Linux-shaped hosts even when lockf is visible', () => {
    const home = temp('setup-lock-linux-select-')
    const fakebin = join(home, 'fakebin')
    const log = join(home, 'tools.log')
    mkdirSync(fakebin)
    executable(join(fakebin, 'lockf'), 'printf \'lockf-shadow\\n\' >> "$TOOL_LOG"\nexit 99')
    makeFlockAdapter(fakebin, log)

    const result = shell(
      `${acquireBody('OSTYPE=linux-gnu')}\nprintf '%s\\n' "$_AGENT_INBOX_SETUP_LOCK_TOOL"`,
      {
        home,
        env: {
          PATH: `${fakebin}:/usr/bin:/bin`,
          TOOL_LOG: log,
        },
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(join(fakebin, 'flock'))
    expect(readFileSync(log, 'utf8')).toBe('flock\n')
  })

  it('distinguishes a lock utility failure from contention', () => {
    const home = temp('setup-lock-tool-failure-')
    const fakebin = join(home, 'fakebin')
    mkdirSync(fakebin)
    executable(join(fakebin, 'flock'), 'exit 64')

    const result = shell(acquireBody('OSTYPE=linux-gnu'), {
      home,
      env: { PATH: `${fakebin}:/usr/bin:/bin` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe(`${CALLER}: setup lock utility failed (exit 64)`)
    expect(result.stderr).not.toContain('another setup')
  })

  it('maps only a real held lease to the exact contention diagnostic', async () => {
    const home = temp('setup-lock-contention-')
    const lock = join(home, 'lease.lock')
    const marker = join(home, 'held')
    const holder = startHolder(
      `acquire_setup_lock ${CALLER} || exit 1\n: > ${quote(marker)}\nexec /bin/sleep 30`,
      lock,
    )
    await waitForFile(marker)

    const contender = shell(acquireBody(), { home, lock })

    expect(contender.status).toBe(1)
    expect(contender.stderr.trim()).toBe(BUSY)
    killPid(holder.pid!)
    await waitForExit(holder)
    const after = shell(acquireBody(), { home, lock })
    expect(after.status, after.stderr).toBe(0)
  })

  it.each([
    ['directory', (path: string) => mkdirSync(path)],
    ['regular symlink', (path: string) => {
      const target = `${path}.target`
      writeFileSync(target, '')
      symlinkSync(target, path)
    }],
    ['dangling symlink', (path: string) => symlinkSync(`${path}.missing`, path)],
    ['device', (_path: string) => {}],
  ])('rejects an existing %s before opening fd 9', (_label, prepare) => {
    const home = temp('setup-lock-invalid-')
    const path = _label === 'device' ? '/dev/null' : join(home, 'lease.lock')
    prepare(path)

    const result = shell(acquireBody(), { home, lock: path })

    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe(`${CALLER}: install lock path must be a regular file: ${path}`)
  })

  it('rejects a FIFO without blocking in exec 9>>', () => {
    const home = temp('setup-lock-fifo-')
    const fifo = join(home, 'lease.fifo')
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
    expect(made.status, made.stderr).toBe(0)

    const result = shell(acquireBody(), { home, lock: fifo, timeout: 750 })

    expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT')
    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe(`${CALLER}: install lock path must be a regular file: ${fifo}`)
  })

  it('rejects a Unix socket before opening fd 9', async () => {
    const home = temp('setup-lock-socket-')
    const socket = join(home, 'lease.sock')
    const server = createServer()
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socket, () => resolveListen())
    })
    try {
      const result = shell(acquireBody(), { home, lock: socket })
      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(`${CALLER}: install lock path must be a regular file: ${socket}`)
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })

  it('keeps continuous exclusion when one shell acquires repeatedly', async () => {
    const home = temp('setup-lock-idempotent-')
    const lock = join(home, 'lease.lock')
    const fakebin = join(home, 'fakebin')
    const log = join(home, 'tools.log')
    const marker = join(home, 'held')
    mkdirSync(fakebin)
    makeFlockAdapter(fakebin, log)
    const env = {
      PATH: `${fakebin}:/usr/bin:/bin`,
      TOOL_LOG: log,
    }
    const holder = startHolder(
      [
        'OSTYPE=linux-gnu',
        `acquire_setup_lock ${CALLER} || exit 1`,
        `acquire_setup_lock ${CALLER} || exit 1`,
        `acquire_setup_lock ${CALLER} || exit 1`,
        `: > ${quote(marker)}`,
        'exec /bin/sleep 30',
      ].join('\n'),
      lock,
      env,
    )
    await waitForFile(marker)

    expect(readFileSync(log, 'utf8')).toBe('flock\n')
    const contender = shell(acquireBody('OSTYPE=linux-gnu'), { home, lock, env })
    expect(contender.status).toBe(1)
    expect(contender.stderr.trim()).toBe(BUSY)

    killPid(holder.pid!)
    await waitForExit(holder)
    const after = shell(acquireBody('OSTYPE=linux-gnu'), { home, lock, env })
    expect(after.status, after.stderr).toBe(0)
  })

  it('keeps the lease while a foreground child mutator survives its parent', async () => {
    const home = temp('setup-lock-child-')
    const lock = join(home, 'lease.lock')
    const parentMarker = join(home, 'parent.pid')
    const childMarker = join(home, 'child.pid')
    const holder = startHolder(
      [
        `acquire_setup_lock ${CALLER} || exit 1`,
        `printf '%s\\n' "$$" > ${quote(parentMarker)}`,
        `/bin/bash -c ${quote(`printf '%s\\n' "$$" > ${quote(childMarker)}; exec /bin/sleep 30`)}`,
        'child_status=$?',
        'exit "$child_status"',
      ].join('\n'),
      lock,
    )
    await waitForFile(parentMarker)
    await waitForFile(childMarker)
    const childPid = Number(readFileSync(childMarker, 'utf8').trim())
    livePids.add(childPid)

    killPid(holder.pid!)
    await waitForExit(holder)
    const whileChildRuns = shell(acquireBody(), { home, lock })
    expect(whileChildRuns.status).toBe(1)
    expect(whileChildRuns.stderr.trim()).toBe(BUSY)

    killPid(childPid)
    await waitForGone(childPid)
    const afterChild = shell(acquireBody(), { home, lock })
    expect(afterChild.status, afterChild.stderr).toBe(0)
  })

  it('releases immediately after whole-process-group SIGKILL with no surviving descendant', async () => {
    const home = temp('setup-lock-group-')
    const lock = join(home, 'lease.lock')
    const parentMarker = join(home, 'parent.pid')
    const childMarker = join(home, 'child.pid')
    const holder = startHolder(
      [
        `acquire_setup_lock ${CALLER} || exit 1`,
        `printf '%s\\n' "$$" > ${quote(parentMarker)}`,
        `/bin/bash -c ${quote(`printf '%s\\n' "$$" > ${quote(childMarker)}; exec /bin/sleep 30`)}`,
        'child_status=$?',
        'exit "$child_status"',
      ].join('\n'),
      lock,
      {},
      true,
    )
    await waitForFile(parentMarker)
    await waitForFile(childMarker)
    const childPid = Number(readFileSync(childMarker, 'utf8').trim())

    killGroup(holder.pid!)
    await waitForExit(holder)
    await waitForGone(childPid)

    const afterCrash = shell(acquireBody(), { home, lock })
    expect(afterCrash.status, afterCrash.stderr).toBe(0)
  })
})

describe('installer helper loading', () => {
  const cases = [
    ['missing', null, null],
    ['unreadable', '# shared helper\n', 0o000],
    ['source failure', 'return 9\n', 0o644],
    ['function-less', ':\n', 0o644],
  ] as const

  it.each([
    ['install-agents', AGENT_INSTALLER, ['--apply', '--target', 'copilot']],
    ['install-hooks', HOOK_INSTALLER, ['--apply', '--uninstall']],
  ] as const)('%s fails closed when its adjacent helper cannot load', (_name, installer, args) => {
    for (const [label, contents, mode] of cases) {
      const root = temp(`setup-lock-source-${label.replace(' ', '-')}-`)
      const scripts = join(root, 'scripts')
      const home = join(root, 'home')
      const fakebin = join(root, 'fakebin')
      mkdirSync(scripts)
      mkdirSync(home)
      mkdirSync(fakebin)
      const copied = join(scripts, installer.slice(installer.lastIndexOf('/') + 1))
      copyFileSync(installer, copied)
      chmodSync(copied, 0o755)
      executable(join(fakebin, 'jq'), 'exit 0')
      if (contents !== null && mode !== null) {
        const helper = join(scripts, 'setup-lock.sh')
        writeFileSync(helper, contents)
        chmodSync(helper, mode)
      }
      const lock = join(home, '.agent-inbox', 'install-agents.lock')

      const result = spawnSync('/bin/bash', [copied, ...args], {
        encoding: 'utf8',
        timeout: 3_000,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakebin}:/usr/bin:/bin`,
          AGENT_INBOX_INSTALL_LOCK_DIR: lock,
        },
      })

      expect(result.status, `${_name}/${label}: ${result.stderr}`).toBe(1)
      expect(result.stderr, `${_name}/${label}`).toContain('failed to load shared setup lock helper')
      expect(existsSync(lock), `${_name}/${label} created the lock file`).toBe(false)
    }
  })
})
