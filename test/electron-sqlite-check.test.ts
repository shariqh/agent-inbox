import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ElectronSqliteCheckError,
  runElectronSqliteCheck,
} from '../scripts/electron-sqlite-check.mjs'
import { scratchDir } from './scratch.js'

const root = resolve(process.cwd())
const checkScript = join(root, 'scripts', 'runtime-sqlite-check.mjs')
const identity = { platform: 'linux', arch: 'x64', electron: '43.8.0', node: 'v24.22.0', modulesAbi: '148' }
const expected = { platform: 'linux', arch: 'x64', electron: '43.8.0', modulesAbi: '148' }
const scratchEnvKeys = [
  'AGENT_INBOX_DB',
  'HOME',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
]

type Outcome = Partial<SpawnSyncReturns<string>>
type Call = { file: string; args: string[]; options: SpawnSyncOptions }

function fakeSpawn(check: Outcome, probe: Outcome = { stdout: `${JSON.stringify(identity)}\n` }) {
  const calls: Call[] = []
  const spawn = (file: string, args: string[], options: SpawnSyncOptions): SpawnSyncReturns<string> => {
    calls.push({ file, args, options })
    return {
      pid: 4242,
      output: [],
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
      ...(args[0] === '-p' ? probe : check),
    }
  }
  return { spawn, calls }
}

function appFixture(): { executable: string; storePath: string } {
  const app = scratchDir('electron-sqlite-app-')
  const storePath = join(app, 'store.js')
  writeFileSync(storePath, 'export {}\n')
  return { executable: join(app, 'Agent Inbox'), storePath }
}

function runFake(check: Outcome, probe?: Outcome) {
  const fake = fakeSpawn(check, probe)
  const fixture = appFixture()
  const logs: string[] = []
  const run = () => runElectronSqliteCheck({
    ...fixture,
    expected,
    label: 'packaged Electron (linux-x64)',
    log: (line: string) => logs.push(line),
    spawn: fake.spawn,
  })
  return { ...fake, ...fixture, logs, run }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Electron-embedded allocation-driven SQLite check (#135)', () => {
  it('runs the shared check with the packaged Electron in an isolated Node-mode process', () => {
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=4096')
    const fake = runFake({ status: 0 })

    expect(fake.run()).toMatchObject({ electron: '43.8.0', node: 'v24.22.0', modulesAbi: '148' })
    expect(fake.calls.map((call) => call.file)).toEqual([fake.executable, fake.executable])
    expect(fake.calls[0]?.args[0]).toBe('-p')
    expect(fake.calls[1]?.args).toEqual([checkScript, fake.storePath])
    expect(existsSync(checkScript)).toBe(true)

    const options = fake.calls[1]!.options
    const env = options.env as NodeJS.ProcessEnv
    const scratch = options.cwd as string
    expect(Object.keys(env).sort()).toEqual([...scratchEnvKeys, 'ELECTRON_RUN_AS_NODE', 'PATH'].sort())
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    for (const name of scratchEnvKeys) {
      expect(env[name]?.startsWith(`${scratch}/`), `${name}=${env[name]}`).toBe(true)
    }
    expect(env.HOME).not.toBe(homedir())
    expect(options.timeout).toBe(180_000)
    expect(options.killSignal).toBe('SIGKILL')
    expect(fake.calls[0]?.options.env).toEqual(env)
    expect(existsSync(scratch)).toBe(false)

    expect(fake.logs).toHaveLength(1)
    expect(fake.logs[0]).toMatch(/packaged Electron \(linux-x64\) passed/)
    expect(fake.logs[0]).toContain('Electron 43.8.0')
    expect(fake.logs[0]).toContain('Node v24.22.0')
  })

  it('fails closed with the #135 diagnosis when Electron aborts in statement cleanup', () => {
    const nativeStack = Array.from({ length: 80 }, (_, frame) =>
      ` ${frame}: 0x10f74caa8 uv_fs_stat [/Applications/Agent Inbox.app/Contents/Frameworks/Electron Framework]`)
    const assertion = [
      '  #  Agent Inbox[47655]: void node::RemoveEnvironmentCleanupHook(Isolate *, CleanupHook, void *)'
        + ' at ../../third_party/electron_node/src/api/hooks.cc:142',
      '  #  Assertion failed: (env) != nullptr',
      '----- Native stack trace -----',
      ...nativeStack,
      'final native frame',
    ].join('\n')
    for (const aborted of [
      { status: null, signal: 'SIGABRT' as const, stderr: assertion },
      { status: 134, signal: null, stderr: assertion },
    ]) {
      const fake = runFake(aborted)
      let error: unknown
      try {
        fake.run()
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(ElectronSqliteCheckError)
      const message = (error as Error).message
      expect(message).toMatch(/packaged Electron \(linux-x64\) failed the allocation-driven SQLite check/)
      expect(message).toMatch(/SIGABRT/)
      expect(message).toMatch(/134/)
      expect(message).toMatch(/#135/)
      expect(message).toMatch(/43\.6\.0/)
      expect(message).toContain('upstream Node.js 24.22.0 from 43.8.0')
      expect(message).toContain('Assertion failed: (env) != nullptr')
      expect(message).toContain('final native frame')
      expect(message).toMatch(/characters omitted/)
      expect(existsSync(fake.calls[1]!.options.cwd as string)).toBe(false)
      expect(fake.logs).toEqual([])
    }
  })

  it('fails closed on any other exit status, signal, timeout, or spawn error', () => {
    const timedOut = Object.assign(new Error('spawnSync Agent Inbox ETIMEDOUT'), { code: 'ETIMEDOUT' })
    for (const [outcome, pattern] of [
      [{ status: 1, stderr: 'Error: Cannot find module better-sqlite3\n' }, /exited with status 1[\s\S]*Cannot find module/],
      [{ status: null, signal: 'SIGSEGV' as const }, /terminated by SIGSEGV/],
      [{ status: null, signal: 'SIGKILL' as const, error: timedOut }, /timed out after 180 s/],
    ] as const) {
      const fake = runFake(outcome)
      expect(fake.run).toThrow(ElectronSqliteCheckError)
      expect(fake.run).toThrow(pattern)
      expect(fake.run).toThrow(/#135/)
    }
  })

  it('runs the check only after Electron proves its pinned Node-mode identity', () => {
    const missing = Object.assign(new Error('spawnSync Agent Inbox ENOENT'), { code: 'ENOENT' })
    for (const [probe, pattern] of [
      [{ stdout: `${JSON.stringify({ ...identity, electron: '43.5.0' })}\n` }, /electron mismatch: found 43\.5\.0, expected 43\.8\.0/],
      [{ stdout: `${JSON.stringify({ ...identity, electron: undefined })}\n` }, /electron mismatch: found undefined, expected 43\.8\.0/],
      [{ stdout: `${JSON.stringify({ ...identity, modulesAbi: '146' })}\n` }, /modulesAbi mismatch: found 146, expected 148/],
      [{ stdout: '' }, /did not report its Node-mode identity[\s\S]*RunAsNode/],
      [{ status: null, error: missing }, /did not report its Node-mode identity[\s\S]*ENOENT/],
    ] as const) {
      const fake = runFake({ status: 0 }, probe)
      expect(fake.run).toThrow(ElectronSqliteCheckError)
      expect(fake.run).toThrow(pattern)
      expect(fake.calls.every((call) => call.args[0] === '-p')).toBe(true)
    }
  })

  it('requires the packaged store before starting Electron', () => {
    const fake = fakeSpawn({ status: 0 })
    expect(() => runElectronSqliteCheck({
      executable: '/missing/Agent Inbox',
      storePath: join(scratchDir('electron-sqlite-empty-'), 'dist', 'store.js'),
      expected,
      log: () => {},
      spawn: fake.spawn,
    })).toThrow(/missing the packaged store module/)
    expect(fake.calls).toEqual([])
  })

  it('drives a real child process with only the isolated environment', () => {
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=4096')
    const fixture = appFixture()
    const record = join(dirname(fixture.storePath), 'record.json')
    const writeFake = (checkStatus: number) => {
      writeFileSync(fixture.executable, [
        '#!/bin/sh',
        'if [ "$1" = "-p" ]; then',
        `  printf '%s\\n' '${JSON.stringify(identity)}'`,
        '  exit 0',
        'fi',
        `printf '{"cwd":"%s","home":"%s","db":"%s","runAsNode":"%s","nodeOptions":"%s","script":"%s","store":"%s"}' \\`,
        `  "$PWD" "$HOME" "$AGENT_INBOX_DB" "$ELECTRON_RUN_AS_NODE" "\${NODE_OPTIONS-unset}" "$1" "$2" > '${record}'`,
        `echo 'fake Electron check stderr' >&2`,
        `exit ${checkStatus}`,
      ].join('\n'))
      chmodSync(fixture.executable, 0o755)
    }

    writeFake(0)
    const logs: string[] = []
    expect(runElectronSqliteCheck({ ...fixture, expected, log: (line: string) => logs.push(line) }))
      .toMatchObject({ electron: '43.8.0' })
    const seen = JSON.parse(readFileSync(record, 'utf8')) as Record<string, string>
    expect(seen).toMatchObject({
      runAsNode: '1',
      nodeOptions: 'unset',
      script: checkScript,
      store: fixture.storePath,
    })
    expect(seen.home).not.toBe(homedir())
    expect(basename(dirname(seen.home!))).toBe(basename(seen.cwd!))
    expect(basename(dirname(seen.db!))).toBe(basename(seen.cwd!))
    expect(existsSync(dirname(seen.db!))).toBe(false)
    expect(logs).toHaveLength(1)

    writeFake(3)
    expect(() => runElectronSqliteCheck({ ...fixture, expected, log: () => {} }))
      .toThrow(/exited with status 3[\s\S]*fake Electron check stderr/)
  })
})
