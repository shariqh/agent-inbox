import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookLaunchers, hooksHome, installRuntime, installStaged, stageRuntime } from './hooks-runtime.js'
import type { HooksHome, StagedRuntime } from './hooks-runtime.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const require = createRequire(import.meta.url)
const PAYLOAD_CLI = resolve(import.meta.dirname, '..', 'scripts', 'runtime-payload.mjs')
const SETUP_INFO_CLI = resolve(import.meta.dirname, '..', 'scripts', 'write-setup-info.mjs')
type InstallBindingGrant = { setup: boolean; update: boolean }
type InstallBinding = {
  navigationStarted(url: string): void
  navigationCommitted(url: string): Promise<boolean>
  rendererGone(): void
  closed(): void
  settled(): Promise<void>
}
const {
  canRunSetup,
  createInstallBinding,
  createInstallGate,
  installerRepoRoot,
  isTrustedSetupSender,
  readSetupInfo,
  runAgentInstall,
  runtimeKey,
  selectRuntimePayload: selectRuntimePayloadRaw,
} = require('../electron/setup-runner.cjs') as {
  canRunSetup(senderUrl: string, viewerUrl: string, senderId: number, authorizedWebContentsId: number | null): boolean
  createInstallBinding(options: {
    viewerUrl: string
    setupAllowed(): boolean
    updateAllowed(): boolean
    isQuitting(): boolean
    proveOwnership(): Promise<boolean>
    apply(grant: InstallBindingGrant): void
  }): InstallBinding
  createInstallGate(): {
    quitting(): boolean
    running(): boolean
    run<T>(start: (onCancel: (cancel: () => void) => void) => Promise<T>): { promise: Promise<T> } | { refused: 'quitting' | 'running' }
    beginQuit(): Promise<void> | null
  }
  installerRepoRoot(appRoot: string): string | null
  isTrustedSetupSender(senderUrl: string, viewerUrl: string): boolean
  readSetupInfo(appRoot: string): unknown
  runtimeKey(platform: string, arch: string): string
  selectRuntimePayload(opts: {
    appRoot: string
    platform?: string
    arch?: string
    info?: unknown
  }): { ok: boolean; reason?: string; key: string; path?: string; relativePath?: string; digest?: string; packageVersion?: string }
  runAgentInstall(opts: {
    repoRoot: string
    target: string
    runtimePayload?: { key: string; path: string; digest: string; packageVersion: string } | null
    env?: NodeJS.ProcessEnv
    maxOutput?: number
    timeoutMs?: number
    spawnImpl?: (...args: unknown[]) => never
    onCancel?: (cancel: () => void) => void
  }): Promise<{ ok: boolean; exitCode: number | null; output: string; target: string; timedOut: boolean; cancelled: boolean }>
}

function selectRuntimePayload(opts: {
  appRoot: string
  platform?: string
  arch?: string
  info?: unknown
}): { ok: boolean; reason?: string; key: string; path?: string; relativePath?: string; digest?: string; packageVersion?: string } {
  const info = opts.info as Record<string, unknown> | null | undefined
  return selectRuntimePayloadRaw({
    ...opts,
    info: info?.runtimePayloads && !info.version ? { version: '1.2.3', ...info } : info,
  })
}

function fixture(script: string): string {
  const root = scratchDir('setup-runner-')
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  const installer = join(scripts, 'install-agents.sh')
  writeFileSync(installer, script)
  chmodSync(installer, 0o755)
  return root
}

afterEach(removeScratchDirs)

/** Stages a real runtime PAYLOAD DIRECTORY under `appRoot` (issue #74) —
 *  scripts/runtime-payload.mjs's own on-disk shape: a `runtime-manifest.json`
 *  naming this payload's `platform`/`arch`, plus (by default) an installer
 *  script, since `selectRuntimePayload` requires both. The digest baked into
 *  `setup-info.json` is over the manifest FILE's real bytes, exactly as
 *  `scripts/write-setup-info.mjs --release` computes it — never a caller-
 *  supplied string. */
function stagePayloadDir(
  appRoot: string,
  relDir: string,
  opts: {
    platform: string
    arch: string
    withInstaller?: boolean
    installerScript?: string
    product?: string
    packageVersion?: string
    nodeVersion?: string
    nodeModulesAbi?: string
    omitEntrypoint?: string
    omitFile?: string
  } = { platform: 'darwin', arch: 'arm64' },
): { path: string; digest: string } {
  const { platform, arch, withInstaller = true, installerScript = '#!/bin/bash\necho noop\n' } = opts
  const dir = join(appRoot, relDir)
  mkdirSync(dir, { recursive: true })
  if (withInstaller) {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    if (opts.omitFile !== 'scripts/install-agents.sh') writeFileSync(join(dir, 'scripts', 'install-agents.sh'), installerScript)
    if (opts.omitFile !== 'scripts/runtime-payload.mjs') writeFileSync(join(dir, 'scripts', 'runtime-payload.mjs'), '// verifier helper\n')
    if (opts.omitFile !== 'scripts/runtime-config.mjs') writeFileSync(join(dir, 'scripts', 'runtime-config.mjs'), '// config helper\n')
    if (opts.omitFile !== 'scripts/setup-filesystem.cjs') writeFileSync(join(dir, 'scripts', 'setup-filesystem.cjs'), '// filesystem adapter\n')
    if (opts.omitFile !== 'scripts/setup-lock.sh') writeFileSync(join(dir, 'scripts', 'setup-lock.sh'), '# shared setup lock\n')
    if (opts.omitFile !== 'scripts/run-isolated.mjs') writeFileSync(join(dir, 'scripts', 'run-isolated.mjs'), '// rollback step isolation\n')
    mkdirSync(join(dir, 'dist'), { recursive: true })
    if (opts.omitFile !== 'dist/mcp-server.js') writeFileSync(join(dir, 'dist', 'mcp-server.js'), '// mcp\n')
    if (opts.omitFile !== 'dist/hook-cli.js') writeFileSync(join(dir, 'dist', 'hook-cli.js'), '// hook\n')
    if (opts.omitFile !== 'dist/watch-cli.js') writeFileSync(join(dir, 'dist', 'watch-cli.js'), '// watch\n')
    mkdirSync(join(dir, 'node_modules', 'better-sqlite3', 'build', 'Release'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'native-addon\n')
  } else {
    writeFileSync(join(dir, 'payload.txt'), 'no installer\n')
  }
  const args = [
    PAYLOAD_CLI,
    'manifest',
    '--root', dir,
    '--product', opts.product ?? 'agent-inbox-runtime',
    '--package-version', opts.packageVersion ?? '1.2.3',
    '--source-commit', 'deadbeef',
    '--platform', platform,
    '--arch', arch,
    '--node-version', opts.nodeVersion ?? process.version,
    '--node-modules-abi', opts.nodeModulesAbi ?? process.versions.modules,
  ]
  const entrypoints = withInstaller
    ? ['dist/mcp-server.js', 'dist/hook-cli.js', 'dist/watch-cli.js'].filter((entry) => entry !== opts.omitEntrypoint)
    : ['payload.txt']
  for (const entrypoint of entrypoints) args.push('--entrypoint', entrypoint)
  execFileSync(process.execPath, args)
  const manifestJson = readFileSync(join(dir, 'runtime-manifest.json'), 'utf8')
  const digest = createHash('sha256').update(manifestJson).digest('hex')
  return { path: relDir, digest: `sha256:${digest}` }
}

describe('Electron one-click setup runner', () => {
  it('accepts only the exact local viewer origin', () => {
    expect(isTrustedSetupSender('http://127.0.0.1:4319/', 'http://127.0.0.1:4319/')).toBe(true)
    expect(isTrustedSetupSender('http://127.0.0.1:4319/setup', 'http://127.0.0.1:4319/')).toBe(true)
    expect(isTrustedSetupSender('http://127.0.0.1:4319.evil.example/', 'http://127.0.0.1:4319/')).toBe(false)
    expect(isTrustedSetupSender('https://127.0.0.1:4319/', 'http://127.0.0.1:4319/')).toBe(false)
    expect(isTrustedSetupSender('http://localhost:4319/', 'http://127.0.0.1:4319/')).toBe(false)
    expect(isTrustedSetupSender('not a url', 'http://127.0.0.1:4319/')).toBe(false)
    expect(canRunSetup('http://127.0.0.1:4319/', 'http://127.0.0.1:4319/', 7, 7)).toBe(true)
    expect(canRunSetup('http://127.0.0.1:4319/', 'http://127.0.0.1:4319/', 7, 8)).toBe(false)
  })

  it('resolves the packaged checkout from setup-info and refuses a missing installer', () => {
    const packaged = scratchDir('setup-packaged-')
    const checkout = fixture('exit 0\n')
    writeFileSync(join(packaged, 'setup-info.json'), JSON.stringify({ repoRoot: checkout }))

    expect(installerRepoRoot(packaged)).toBe(checkout)
    expect(installerRepoRoot(scratchDir('setup-missing-'))).toBe(null)
  })

  it('spawns only the fixed installer with validated target arguments', async () => {
    const argsFile = join(scratchDir('setup-args-'), 'args')
    const root = fixture(`#!/bin/bash
printf '%s\\n' "$@" > "$ARGS_FILE"
printf 'installed %s\\n' "$3"
`)

    const result = await runAgentInstall({
      repoRoot: root,
      target: 'copilot',
      env: { ...process.env, ARGS_FILE: argsFile },
    })

    expect(result).toMatchObject({ ok: true, exitCode: 0, target: 'copilot', timedOut: false })
    expect(readFileSync(argsFile, 'utf8')).toBe('--apply\n--target\ncopilot\n')
    expect(result.output).toContain('installed copilot')
  })

  it('rejects arbitrary targets without spawning anything', async () => {
    const root = fixture('touch "$SHOULD_NOT_EXIST"\n')
    const marker = join(root, 'spawned')

    const result = await runAgentInstall({
      repoRoot: root,
      target: '../anything',
      env: { ...process.env, SHOULD_NOT_EXIST: marker },
    })

    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/invalid setup target/i)
  })

  it('bounds subprocess output while preserving the final result', async () => {
    const root = fixture(`#!/bin/bash
yes x | head -c 4096
printf '\\nfinished\\n'
`)

    const result = await runAgentInstall({ repoRoot: root, target: 'all', maxOutput: 512 })

    expect(result.ok).toBe(true)
    expect(result.output.length).toBeLessThan(600)
    expect(result.output).toContain('output truncated')
    expect(result.output).toContain('finished')
  })

  it('cancels the process group and waits for its signal cleanup', async () => {
    const root = fixture(`#!/bin/bash
trap 'printf "rolled back\\n"; exit 130' TERM INT
printf 'started\\n'
while :; do sleep 1; done
`)
    let cancel = () => {}
    const promise = runAgentInstall({
      repoRoot: root,
      target: 'claude',
      onCancel(fn) { cancel = fn },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    cancel()
    const result = await promise

    expect(result).toMatchObject({ ok: false, cancelled: true, timedOut: false })
    expect(result.output).toContain('Agent Inbox is closing')
    expect(result.output).toContain('rolled back')
  })

  it('wires the bridge through an isolated preload rather than an HTTP command route', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const preload = readFileSync(join(import.meta.dirname, '..', 'electron', 'setup-preload.cjs'), 'utf8')
    const runner = readFileSync(join(import.meta.dirname, '..', 'electron', 'setup-runner.cjs'), 'utf8')

    expect(main).toContain("ipcMain.handle('agent-inbox:install'")
    expect(main).toContain('canRunSetup(senderUrl, URL_BASE, event.sender.id, setupInstallWebContentsId)')
    expect(main).toContain('await waitForOwnership()')
    expect(main).toContain("const VIEWER_HOST = '127.0.0.1'")
    expect(main).toContain('const URL_BASE = `http://${VIEWER_HOST}:${PORT}/`')
    expect(main).toContain("const BOUNDARY_HEADER = 'x-agent-inbox-local-boundary'")
    expect(main).toContain('classifyReuse(probeAny, probe, sleep, REUSE_CONFIRM_DELAY_MS)')
    expect(main).toContain("reuseState === 'incompatible'")
    expect(main).not.toContain('setupInstallEnabled = true\n        if (!win.isDestroyed())')
    expect(main).toContain("app.on('before-quit'")
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain("preload: path.join(__dirname, 'setup-preload.cjs')")
    expect(main).toContain("accelerator: 'CommandOrControl+,'")
    expect(main).toContain("win.webContents.send('agent-inbox:toggle-settings')")
    expect(main).toContain('const setupWindowWebContentsId = win.webContents.id')
    expect(main).toContain('setupInstallWebContentsId = setup ? setupWindowWebContentsId : null')
    expect(preload).toContain("contextBridge.exposeInMainWorld('agentInboxSetup'")
    expect(preload).toContain('onToggleSettings')
    expect(preload).not.toContain('child_process')
    expect(runner).toContain("require('./setup-core.cjs')")
    expect(runner).toContain("require('./setup-process.cjs')")
    expect(runner).toContain('runTrustedSetup({')
    expect(runner).not.toContain('function runInstallerProcess(')
    expect(main).toContain('key: runtimeSelection.key')
  })

  it('adds no execution surface to read agent status or update agents (#197 part 2)', () => {
    const read = (...parts: string[]) => readFileSync(join(import.meta.dirname, '..', ...parts), 'utf8')
    const main = read('electron', 'main.cjs')
    const preload = read('electron', 'setup-preload.cjs')
    const hosts = read('src', 'agent-hosts.ts')
    const viewer = read('src', 'viewer.ts')

    // the renderer's Setup bridge is still exactly available() and install(target):
    // one fixed target string, never argv, a path or a status command
    const bridge = preload.slice(preload.indexOf("exposeInMainWorld('agentInboxSetup'"), preload.indexOf("exposeInMainWorld('agentInboxTheme'"))
    expect([...bridge.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))
      .toEqual(['agent-inbox:install-available', 'agent-inbox:install'])
    expect(bridge).toContain("ipcRenderer.invoke('agent-inbox:install', target)")
    expect([...main.matchAll(/ipcMain\.handle\('(agent-inbox:install[^']*)'/g)].map((m) => m[1]))
      .toEqual(['agent-inbox:install-available', 'agent-inbox:install'])

    // status is READ in the viewer, from files: no process, no network, no lock
    expect([...hosts.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])).toEqual(['node:fs', 'node:path'])
    // and no HTTP route writes or runs setup
    expect(viewer).not.toMatch(/app\.(post|put|patch|delete)\('\/api\/(setup|version|agents)/)
  })

  it('keeps child verification after lock acquisition and before managed runtime or host mutation', () => {
    const installer = readFileSync(join(import.meta.dirname, '..', 'scripts', 'install-agents.sh'), 'utf8')
    const lock = installer.indexOf('acquire_setup_lock install-agents || exit 1')
    const innerVerify = installer.indexOf('"$SOURCE_NODE" "$PAYLOAD_HELPER" verify')
    const runtimeInstall = installer.indexOf('"$SOURCE_NODE" "$PAYLOAD_HELPER" install')
    const hostRegistration = installer.indexOf('registration_state="$(user_registration_state')

    expect(lock).toBeGreaterThan(-1)
    expect(innerVerify).toBeGreaterThan(lock)
    expect(runtimeInstall).toBeGreaterThan(innerVerify)
    expect(hostRegistration).toBeGreaterThan(runtimeInstall)
  })
})

// issue #74 — architecture-keyed release runtime selection. `selectRuntimePayload`
// is the ONLY place a packaged app decides which of the two shipped runtime
// tarballs applies to the machine it is running on, and it must do so with zero
// fallback: a host it does not recognise gets nothing, ever.
// #205 review (BLOCKER): quitting during one host's install must not start
// another. Electron cancels the running install on quit, the renderer then
// asked for the NEXT host's install, main accepted it mid-shutdown, and the
// exit killed it halfway — after it had removed Copilot CLI's registration and
// before it added the new one. The gate is main's one record of the running
// install and of the quit: once any quit begins, nothing starts.
describe('createInstallGate (#205)', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
  }

  it('runs one install at a time and refuses a second while it runs', async () => {
    const gate = createInstallGate()
    const first = deferred<string>()
    const second = vi.fn(async () => 'second')
    const started = gate.run(() => first.promise)
    expect('promise' in started).toBe(true)
    expect(gate.run(second)).toEqual({ refused: 'running' })
    expect(second).not.toHaveBeenCalled()
    first.resolve('done')
    expect(await (started as { promise: Promise<string> }).promise).toBe('done')
    // free again once it settled
    const third = gate.run(async () => 'third')
    expect(await (third as { promise: Promise<string> }).promise).toBe('third')
  })

  it('a quit cancels the running install, waits for it, and refuses every install after it', async () => {
    const gate = createInstallGate()
    const install = deferred<{ ok: boolean; cancelled: boolean }>()
    const cancel = vi.fn(() => install.resolve({ ok: false, cancelled: true }))
    gate.run((onCancel) => {
      onCancel(cancel)
      return install.promise
    })

    const waiting = gate.beginQuit()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(gate.quitting()).toBe(true)
    expect(waiting).not.toBeNull()
    await expect(waiting).resolves.toBeUndefined()

    // the renderer's next host, asked for after the first was cancelled: never started
    const next = vi.fn(async () => ({ ok: true }))
    expect(gate.run(next)).toEqual({ refused: 'quitting' })
    expect(next).not.toHaveBeenCalled()
    // the re-quit finds nothing running and nothing it may start
    expect(gate.beginQuit()).toBeNull()
    expect(gate.run(next)).toEqual({ refused: 'quitting' })
    expect(next).not.toHaveBeenCalled()
  })

  it('cancels again and still waits when a quit fires again before the install has stopped', async () => {
    const gate = createInstallGate()
    const install = deferred<string>()
    const cancel = vi.fn()
    gate.run((onCancel) => {
      onCancel(cancel)
      return install.promise
    })
    const first = gate.beginQuit()
    const again = gate.beginQuit()
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(again).not.toBeNull()
    let settled = false
    void again!.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    install.resolve('stopped')
    await Promise.all([first, again])
    expect(settled).toBe(true)
    expect(gate.beginQuit()).toBeNull()
  })

  it('says whether an install is running, from start until it settles either way', async () => {
    const gate = createInstallGate()
    expect(gate.running()).toBe(false)
    const first = deferred<string>()
    const started = gate.run(() => first.promise) as { promise: Promise<string> }
    expect(gate.running()).toBe(true)
    expect(gate.run(async () => 'second')).toEqual({ refused: 'running' })
    expect(gate.running()).toBe(true)
    first.resolve('done')
    await started.promise
    expect(gate.running()).toBe(false)

    const failing = gate.run(async () => { throw new Error('spawn failed') }) as { promise: Promise<unknown> }
    expect(gate.running()).toBe(true)
    await expect(failing.promise).rejects.toThrow('spawn failed')
    expect(gate.running()).toBe(false)

    const last = deferred<string>()
    gate.run((onCancel) => {
      onCancel(() => last.resolve('cancelled'))
      return last.promise
    })
    const waiting = gate.beginQuit()
    expect(gate.running()).toBe(true)
    await waiting
    expect(gate.running()).toBe(false)
    expect(gate.run(async () => 'late')).toEqual({ refused: 'quitting' })
    expect(gate.running()).toBe(false)
  })

  it('a quit with nothing running refuses later installs, and a failed install never wedges the gate or the quit', async () => {
    const idle = createInstallGate()
    expect(idle.beginQuit()).toBeNull()
    expect(idle.run(async () => 'late')).toEqual({ refused: 'quitting' })

    const gate = createInstallGate()
    const rejected = gate.run(async () => { throw new Error('spawn failed') }) as { promise: Promise<unknown> }
    await expect(rejected.promise).rejects.toThrow('spawn failed')
    const thrown = gate.run(() => { throw new Error('sync throw') }) as { promise: Promise<unknown> }
    await expect(thrown.promise).rejects.toThrow('sync throw')
    const failing = deferred<never>()
    const running = gate.run(() => failing.promise) as { promise: Promise<unknown> }
    running.promise.catch(() => {})
    const waiting = gate.beginQuit()
    failing.resolve(Promise.reject(new Error('installer crashed')) as never)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('main refuses Setup once a quit begins, revokes the window, and every quit path goes through one function', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const handler = main.slice(main.indexOf("ipcMain.handle('agent-inbox:install',"), main.indexOf("ipcMain.handle('agent-inbox:set-theme-preference'"))
    const available = main.slice(main.indexOf("ipcMain.handle('agent-inbox:install-available'"), main.indexOf("ipcMain.handle('agent-inbox:install',"))
    const beginAppQuit = main.slice(main.indexOf('function beginAppQuit()'), main.indexOf('\n}\n', main.indexOf('function beginAppQuit()')))
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf('\n})\n', main.indexOf("app.on('before-quit'")))

    expect(main).toContain('const installGate = createInstallGate()')
    // the install handler refuses before anything else, and only the gate starts an install
    expect(handler.indexOf('if (installGate.quitting())')).toBeGreaterThan(-1)
    expect(handler.indexOf('if (installGate.quitting())')).toBeLessThan(handler.indexOf('canRunSetup('))
    expect(handler).toContain('installGate.run(')
    expect(handler).not.toContain('setupInstallRunning')
    expect(available).toContain('!installGate.quitting()')
    // one function every quit path calls first: refuse, revoke, cancel
    expect(beginAppQuit).toContain('setupInstallWebContentsId = null')
    expect(beginAppQuit).toContain('installGate.beginQuit()')
    // before-quit calls it EVERY time it fires, and waits for whatever still runs
    expect(beforeQuit).toContain('const running = beginAppQuit()')
    expect(beforeQuit).toContain('event.preventDefault()')
    expect(main).not.toContain('quitAfterSetup')
  })
})

// #216: a reload of the app's own viewer (View → Reload, Force Reload, the
// viewer's restart reload) revoked Setup and update installs for good, so
// Settings kept offering an Install and restart that main refused until the app
// restarted. The binding now comes back, but only under the startup rule: the
// reload committed to the viewer origin and the viewer is proven, again, to be
// the one this app started.
describe('createInstallBinding (#216)', () => {
  const VIEWER = 'http://127.0.0.1:4319/'
  const NONE: InstallBindingGrant = { setup: false, update: false }
  const BOTH: InstallBindingGrant = { setup: true, update: true }
  type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  function harness(allowed: { setup?: boolean; update?: boolean } = {}) {
    const granted: InstallBindingGrant = { ...NONE }
    let quitting = false
    const proofs: Deferred<boolean>[] = []
    const proveOwnership = vi.fn(() => {
      const proof = deferred<boolean>()
      proofs.push(proof)
      return proof.promise
    })
    const binding = createInstallBinding({
      viewerUrl: VIEWER,
      setupAllowed: () => allowed.setup ?? true,
      updateAllowed: () => allowed.update ?? true,
      isQuitting: () => quitting,
      proveOwnership,
      apply(grant) { Object.assign(granted, grant) },
    })
    return {
      binding,
      granted,
      proveOwnership,
      proof(index = proofs.length - 1) { return proofs[index]! },
      quit() { quitting = true },
    }
  }

  // The app's first load, already bound.
  function loaded(allowed?: { setup?: boolean; update?: boolean }) {
    const h = harness(allowed)
    h.binding.navigationStarted(VIEWER)
    void h.binding.navigationCommitted(VIEWER)
    return h
  }

  it('binds the window at its first navigation to the viewer without a new proof, as before', async () => {
    const h = harness()
    h.binding.navigationStarted(VIEWER)
    expect(h.granted).toEqual(BOTH)
    await expect(h.binding.navigationCommitted(VIEWER)).resolves.toBe(false)
    expect(h.proveOwnership).not.toHaveBeenCalled()
    expect(h.granted).toEqual(BOTH)

    const elsewhere = harness()
    elsewhere.binding.navigationStarted('https://example.com/')
    expect(elsewhere.granted).toEqual(NONE)
  })

  it('revokes at once on a reload and rebinds only once it committed and ownership is proven again', async () => {
    const h = loaded()
    for (let reload = 1; reload <= 2; reload += 1) {
      h.binding.navigationStarted(VIEWER)
      expect(h.granted).toEqual(NONE)
      // Proven after the commit, never at the start: the proof must cover the page just served.
      expect(h.proveOwnership).toHaveBeenCalledTimes(reload - 1)
      const rebound = h.binding.navigationCommitted(VIEWER)
      expect(h.proveOwnership).toHaveBeenCalledTimes(reload)
      expect(h.granted).toEqual(NONE)
      h.proof().resolve(true)
      await expect(rebound).resolves.toBe(true)
      expect(h.granted).toEqual(BOTH)
    }
    // A second commit with no new navigation proves nothing.
    await expect(h.binding.navigationCommitted(VIEWER)).resolves.toBe(false)
    expect(h.proveOwnership).toHaveBeenCalledTimes(2)
  })

  it.each([
    'https://example.com/',
    'http://127.0.0.1:4320/',
    'http://localhost:4319/',
    'https://127.0.0.1:4319/',
    'not a url',
  ])('stays revoked when the reload commits to %s', async (url) => {
    const h = loaded()
    h.binding.navigationStarted(VIEWER)
    await expect(h.binding.navigationCommitted(url)).resolves.toBe(false)
    expect(h.proveOwnership).not.toHaveBeenCalled()
    expect(h.granted).toEqual(NONE)
  })

  it.each(['fails', 'throws', 'answers something other than true'] as const)('stays revoked when the re-proof %s', async (outcome) => {
    const h = loaded()
    h.binding.navigationStarted(VIEWER)
    const rebound = h.binding.navigationCommitted(VIEWER)
    if (outcome === 'fails') h.proof().resolve(false)
    else if (outcome === 'throws') h.proof().reject(new Error('viewer gone'))
    else h.proof().resolve('yes' as unknown as boolean)
    await expect(rebound).resolves.toBe(false)
    expect(h.granted).toEqual(NONE)
  })

  it('never binds, or probes, a viewer this app does not own', async () => {
    const h = loaded({ setup: false, update: false })
    expect(h.granted).toEqual(NONE)
    h.binding.navigationStarted(VIEWER)
    await expect(h.binding.navigationCommitted(VIEWER)).resolves.toBe(false)
    expect(h.proveOwnership).not.toHaveBeenCalled()
    expect(h.granted).toEqual(NONE)
  })

  it.each([
    [{ setup: false, update: true }],
    [{ setup: true, update: false }],
  ])('rebinds only what this app may grant: %j', async (allowed) => {
    const h = loaded(allowed)
    expect(h.granted).toEqual(allowed)
    h.binding.navigationStarted(VIEWER)
    expect(h.granted).toEqual(NONE)
    const rebound = h.binding.navigationCommitted(VIEWER)
    h.proof().resolve(true)
    await expect(rebound).resolves.toBe(true)
    expect(h.granted).toEqual(allowed)
  })

  it('never binds once a quit has begun: before the first load, before the commit, or while the proof runs', async () => {
    const early = harness()
    early.quit()
    early.binding.navigationStarted(VIEWER)
    expect(early.granted).toEqual(NONE)

    const beforeCommit = loaded()
    beforeCommit.binding.navigationStarted(VIEWER)
    beforeCommit.quit()
    await expect(beforeCommit.binding.navigationCommitted(VIEWER)).resolves.toBe(false)
    expect(beforeCommit.proveOwnership).not.toHaveBeenCalled()
    expect(beforeCommit.granted).toEqual(NONE)

    const duringProof = loaded()
    duringProof.binding.navigationStarted(VIEWER)
    const rebound = duringProof.binding.navigationCommitted(VIEWER)
    duringProof.quit()
    duringProof.proof().resolve(true)
    await expect(rebound).resolves.toBe(false)
    expect(duringProof.granted).toEqual(NONE)
  })

  it.each(['another navigation', 'a renderer crash', 'the window closing'] as const)(
    'discards a proof that %s overtook', async (event) => {
      const h = loaded()
      h.binding.navigationStarted(VIEWER)
      const stale = h.binding.navigationCommitted(VIEWER)
      if (event === 'another navigation') h.binding.navigationStarted(VIEWER)
      else if (event === 'a renderer crash') h.binding.rendererGone()
      else h.binding.closed()
      h.proof(0).resolve(true)
      await expect(stale).resolves.toBe(false)
      expect(h.granted).toEqual(NONE)
      if (event !== 'another navigation') return
      // The newer navigation proves itself and binds.
      const fresh = h.binding.navigationCommitted(VIEWER)
      h.proof(1).resolve(true)
      await expect(fresh).resolves.toBe(true)
      expect(h.granted).toEqual(BOTH)
    },
  )

  it('revokes on a renderer crash, and the next load of the owned viewer rebinds under the same proof', async () => {
    const h = loaded()
    h.binding.rendererGone()
    expect(h.granted).toEqual(NONE)
    await expect(h.binding.navigationCommitted(VIEWER)).resolves.toBe(false)
    expect(h.proveOwnership).not.toHaveBeenCalled()

    h.binding.navigationStarted(VIEWER)
    const rebound = h.binding.navigationCommitted(VIEWER)
    h.proof().resolve(true)
    await expect(rebound).resolves.toBe(true)
    expect(h.granted).toEqual(BOTH)
  })

  it('never binds a closed window again', async () => {
    const h = loaded()
    h.binding.closed()
    expect(h.granted).toEqual(NONE)
    h.binding.navigationStarted(VIEWER)
    await expect(h.binding.navigationCommitted(VIEWER)).resolves.toBe(false)
    expect(h.proveOwnership).not.toHaveBeenCalled()
    expect(h.granted).toEqual(NONE)

    const neverLoaded = harness()
    neverLoaded.binding.closed()
    neverLoaded.binding.navigationStarted(VIEWER)
    expect(neverLoaded.granted).toEqual(NONE)
  })

  it('settles once no re-proof is in flight, with that proof\'s grants already applied', async () => {
    const h = loaded()
    await expect(h.binding.settled()).resolves.toBeUndefined()
    for (const outcome of ['passes', 'fails', 'throws'] as const) {
      h.binding.navigationStarted(VIEWER)
      void h.binding.navigationCommitted(VIEWER)
      let settled = false
      void h.binding.settled().then(() => { settled = true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      if (outcome === 'passes') h.proof().resolve(true)
      else if (outcome === 'fails') h.proof().resolve(false)
      else h.proof().reject(new Error('viewer gone'))
      await vi.waitFor(() => expect(settled).toBe(true))
      expect(h.granted).toEqual(outcome === 'passes' ? BOTH : NONE)
    }
  })

  // Main's own wiring text, evaluated against the real helper and a real gate,
  // so a wiring that skips the proof, the owned-viewer rule or the quit gate
  // fails here rather than in a user's window.
  function mainWiring(flags: { setupInstallEnabled: boolean; viewerOwned: boolean }) {
    const main = readFileSync(join(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const start = main.indexOf('  installBinding = createInstallBinding({')
    const end = main.indexOf('\n  })\n', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const gate = createInstallGate()
    const proofs: Deferred<boolean>[] = []
    const reproveOwnership = vi.fn(() => {
      const proof = deferred<boolean>()
      proofs.push(proof)
      return proof.promise
    })
    const refreshInstallPermission = vi.fn()
    const wiring = new Function(
      'createInstallBinding', 'URL_BASE', 'installGate', 'reproveOwnership', 'updateController', 'flags',
      `let setupInstallEnabled = flags.setupInstallEnabled
      let viewerOwned = flags.viewerOwned
      let setupInstallWebContentsId = null
      let updateInstallWebContentsId = null
      let installBinding = null
      const setupWindowWebContentsId = 7
      ${main.slice(start, end + '\n  })'.length)}
      return { installBinding, ids: () => ({ setup: setupInstallWebContentsId, update: updateInstallWebContentsId }) }`,
    )(createInstallBinding, VIEWER, gate, reproveOwnership, { refreshInstallPermission }, flags) as {
      installBinding: InstallBinding
      ids(): { setup: number | null; update: number | null }
    }
    return { ...wiring, gate, reproveOwnership, refreshInstallPermission, proof: () => proofs.at(-1)! }
  }

  it('main rebinds its window to the owned viewer only after the startup proof passes again', async () => {
    const w = mainWiring({ setupInstallEnabled: true, viewerOwned: true })
    w.installBinding.navigationStarted(VIEWER)
    expect(w.ids()).toEqual({ setup: 7, update: 7 })
    expect(w.refreshInstallPermission).toHaveBeenCalledTimes(1)

    w.installBinding.navigationStarted(VIEWER)
    expect(w.ids()).toEqual({ setup: null, update: null })
    // Settings learns at once that this window may no longer install.
    expect(w.refreshInstallPermission).toHaveBeenCalledTimes(2)
    const failed = w.installBinding.navigationCommitted(VIEWER)
    expect(w.reproveOwnership).toHaveBeenCalledOnce()
    w.proof().resolve(false)
    await expect(failed).resolves.toBe(false)
    expect(w.ids()).toEqual({ setup: null, update: null })

    w.installBinding.navigationStarted(VIEWER)
    const rebound = w.installBinding.navigationCommitted(VIEWER)
    w.proof().resolve(true)
    await expect(rebound).resolves.toBe(true)
    expect(w.ids()).toEqual({ setup: 7, update: 7 })
    expect(w.refreshInstallPermission).toHaveBeenLastCalledWith()

    w.installBinding.navigationStarted(VIEWER)
    const quitting = w.installBinding.navigationCommitted(VIEWER)
    expect(w.gate.beginQuit()).toBeNull()
    w.proof().resolve(true)
    await expect(quitting).resolves.toBe(false)
    expect(w.ids()).toEqual({ setup: null, update: null })
  })

  it('main grants Setup only while Setup is enabled, and nothing to a viewer it does not own', async () => {
    const updatesOnly = mainWiring({ setupInstallEnabled: false, viewerOwned: true })
    updatesOnly.installBinding.navigationStarted(VIEWER)
    expect(updatesOnly.ids()).toEqual({ setup: null, update: 7 })
    updatesOnly.installBinding.navigationStarted(VIEWER)
    const rebound = updatesOnly.installBinding.navigationCommitted(VIEWER)
    updatesOnly.proof().resolve(true)
    await rebound
    expect(updatesOnly.ids()).toEqual({ setup: null, update: 7 })

    const reused = mainWiring({ setupInstallEnabled: false, viewerOwned: false })
    reused.installBinding.navigationStarted(VIEWER)
    reused.installBinding.navigationStarted(VIEWER)
    await expect(reused.installBinding.navigationCommitted(VIEWER)).resolves.toBe(false)
    expect(reused.reproveOwnership).not.toHaveBeenCalled()
    expect(reused.ids()).toEqual({ setup: null, update: null })
  })

  it('main re-proves ownership with the startup proof, and a spawned viewer must still be running', async () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const start = main.indexOf('async function reproveOwnership()')
    expect(start).toBeGreaterThan(-1)
    const source = main.slice(start, main.indexOf('\n}\n', start) + 2)
    const reprove = (spawnedViewer: unknown, pid: number | null, proven: boolean) => {
      const waitForOwnership = vi.fn(async () => proven)
      const fn = new Function('spawnedViewer', 'spawnedViewerPid', 'waitForOwnership', `${source}\nreturn reproveOwnership`)(
        spawnedViewer, () => pid, waitForOwnership,
      ) as () => Promise<boolean>
      return { fn, waitForOwnership }
    }

    // The packaged app's in-process viewer: exactly the startup proof.
    for (const proven of [true, false]) {
      const inProcess = reprove(null, null, proven)
      await expect(inProcess.fn()).resolves.toBe(proven)
      expect(inProcess.waitForOwnership).toHaveBeenCalledOnce()
    }
    const running = reprove({}, 4242, true)
    await expect(running.fn()).resolves.toBe(true)
    expect(running.waitForOwnership).toHaveBeenCalledOnce()
    // The served token proves nothing once the child that held the port is gone.
    const exited = reprove({}, null, true)
    await expect(exited.fn()).resolves.toBe(false)
    expect(exited.waitForOwnership).not.toHaveBeenCalled()
  })

  // Setup's one-click install is asked for once per page load (and when Settings
  // opens): a reload whose re-proof is still running must not answer "copy-only".
  it('main answers whether Setup is available only once a re-proof in flight has settled', async () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const marker = "ipcMain.handle('agent-inbox:install-available', "
    const start = main.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const body = main.slice(start + marker.length, main.indexOf('\n})', start) + 2)
    const proof = deferred<void>()
    const installBinding = { settled: vi.fn(() => proof.promise) }
    const world = new Function('installBinding', 'installGate', 'canRunSetup', 'URL_BASE', `
      let setupInstallEnabled = true
      let setupInstallWebContentsId = null
      return { handler: ${body}, bind: (id) => { setupInstallWebContentsId = id } }
    `)(installBinding, createInstallGate(), canRunSetup, VIEWER) as {
      handler(event: unknown): Promise<boolean>
      bind(id: number): void
    }
    const event = { senderFrame: { url: VIEWER }, sender: { id: 7 } }

    const answer = world.handler(event)
    expect(installBinding.settled).toHaveBeenCalledOnce()
    // The re-proof binds the window while the question waits for it.
    world.bind(7)
    proof.resolve()
    await expect(answer).resolves.toBe(true)

    // Nothing in flight: the binding as it is.
    installBinding.settled.mockImplementation(() => Promise.resolve())
    await expect(world.handler({ ...event, sender: { id: 8 } })).resolves.toBe(false)
    // Before the window exists there is no binding to wait for.
    const early = new Function('installBinding', 'installGate', 'canRunSetup', 'URL_BASE', `
      let setupInstallEnabled = true
      let setupInstallWebContentsId = null
      return ${body}
    `)(null, createInstallGate(), canRunSetup, VIEWER) as (event: unknown) => Promise<boolean>
    await expect(early(event)).resolves.toBe(false)
  })

  it('main feeds the binding every main-frame navigation, commit, crash and close of its window before the first load', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const wiring = [
      "win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {\n    if (isMainFrame && !isInPlace) installBinding.navigationStarted(url)\n  })",
      "win.webContents.on('did-navigate', (_event, url) => {\n    installBinding.navigationCommitted(url).catch(() => {})\n  })",
      "win.webContents.on('render-process-gone', () => installBinding.rendererGone())",
      "win.on('closed', () => installBinding.closed())",
    ]
    for (const line of wiring) {
      expect(main, line).toContain(line)
      expect(main.indexOf(line)).toBeLessThan(main.indexOf('await loadViewer(win, URL_BASE)'))
    }
    expect(main.match(/createInstallBinding\(/g)).toHaveLength(1)
    // The binding is the only writer of a window's grants; a quit only ever clears them.
    expect(main.match(/setupInstallWebContentsId = (?!null)/g)).toHaveLength(1)
    expect(main.match(/updateInstallWebContentsId = (?!null)/g)).toHaveLength(1)
    expect(main).not.toContain('firstMainNavigation')
    expect(main).not.toContain('revokeSetup')
  })
})

describe('selectRuntimePayload (issue #74)', () => {
  function releaseRoot(): { root: string; arm: { path: string; digest: string }; x64: { path: string; digest: string } } {
    const root = scratchDir('runtime-select-')
    const arm = stagePayloadDir(root, 'runtime/darwin-arm64', { platform: 'darwin', arch: 'arm64' })
    const x64 = stagePayloadDir(root, 'runtime/darwin-x64', { platform: 'darwin', arch: 'x64' })
    return { root, arm, x64 }
  }

  it('selects the darwin-arm64 payload directory via injected process.platform/process.arch, never uname', () => {
    const { root, arm } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': arm } },
    })
    expect(result.ok).toBe(true)
    expect(result.key).toBe('darwin-arm64')
    expect(result.relativePath).toBe('runtime/darwin-arm64')
    expect(result.path).toBe(realpathSync(join(root, 'runtime', 'darwin-arm64')))
    expect(runtimeKey('darwin', 'arm64')).toBe('darwin-arm64')
  })

  it('selects the darwin-x64 payload directory via injected process.platform/process.arch, never uname', () => {
    const { root, x64 } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'x64',
      info: { runtimePayloads: { 'darwin-x64': x64 } },
    })
    expect(result.ok).toBe(true)
    expect(result.key).toBe('darwin-x64')
    expect(runtimeKey('darwin', 'x64')).toBe('darwin-x64')
  })

  it.each([
    ['wrong product', { product: 'other-runtime' }],
    ['package version mismatch', { packageVersion: '9.9.9' }],
    ['Node 23', { nodeVersion: 'v23.11.0' }],
    ['Node 25', { nodeVersion: 'v25.0.0' }],
    ['malformed ABI', { nodeModulesAbi: 'invalid' }],
    ['wrong ABI', { nodeModulesAbi: '999' }],
    ['missing MCP entrypoint', { omitEntrypoint: 'dist/mcp-server.js' }],
    ['missing hook entrypoint', { omitEntrypoint: 'dist/hook-cli.js' }],
    ['missing watch entrypoint', { omitEntrypoint: 'dist/watch-cli.js' }],
    ['missing installer', { omitFile: 'scripts/install-agents.sh' }],
    ['missing runtime verifier', { omitFile: 'scripts/runtime-payload.mjs' }],
    ['missing config helper', { omitFile: 'scripts/runtime-config.mjs' }],
    ['missing filesystem adapter', { omitFile: 'scripts/setup-filesystem.cjs' }],
    ['missing setup lock helper', { omitFile: 'scripts/setup-lock.sh' }],
    ['missing rollback step helper', { omitFile: 'scripts/run-isolated.mjs' }],
  ])('rejects %s at selection and immediately before spawn', async (_label, override) => {
    const root = scratchDir('runtime-identity-')
    const payload = stagePayloadDir(root, 'runtime/darwin-arm64', {
      platform: 'darwin',
      arch: 'arm64',
      ...override,
    })
    const selected = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': payload } },
    })
    expect(selected.ok).toBe(false)

    let spawned = false
    const payloadRoot = join(root, payload.path)
    const result = await runAgentInstall({
      repoRoot: payloadRoot,
      target: 'all',
      runtimePayload: { key: 'darwin-arm64', path: payloadRoot, digest: payload.digest, packageVersion: '1.2.3' },
      spawnImpl: () => {
        spawned = true
        throw new Error('must not spawn')
      },
    })
    expect(result.ok).toBe(false)
    expect(spawned).toBe(false)
  })

  it('selects Linux exact-host payloads while preserving missing and cross-architecture refusal', () => {
    const { root, arm, x64 } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'x64',
      // Simulate an Apple Silicon host running under Rosetta (arch reports
      // x64) whose release only shipped the arm64 payload — must NOT fall
      // back to it.
      info: { runtimePayloads: { 'darwin-arm64': arm } },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('missing-payload')
    expect(result.key).toBe('darwin-x64')

    const linuxRoot = scratchDir('runtime-select-linux-')
    const linuxPayloads = {
      'linux-x64': stagePayloadDir(linuxRoot, 'runtime/linux-x64', { platform: 'linux', arch: 'x64' }),
      'linux-arm64': stagePayloadDir(linuxRoot, 'runtime/linux-arm64', { platform: 'linux', arch: 'arm64' }),
    }
    for (const [arch, key] of [['x64', 'linux-x64'], ['arm64', 'linux-arm64']] as const) {
      const linux = selectRuntimePayload({
        appRoot: linuxRoot,
        platform: 'linux',
        arch,
        info: { runtimePayloads: linuxPayloads },
      })
      expect(linux.ok).toBe(true)
      expect(linux.key).toBe(key)
    }

    const crossArch = selectRuntimePayload({
      appRoot: linuxRoot,
      platform: 'linux',
      arch: 'arm64',
      info: { runtimePayloads: { 'linux-x64': linuxPayloads['linux-x64'] } },
    })
    expect(crossArch).toMatchObject({ ok: false, reason: 'missing-payload', key: 'linux-arm64' })
  })

  it('rejects Win32 and unknown hosts even when metadata contains matching payload keys', () => {
    const root = scratchDir('runtime-select-unsupported-')
    const win32 = selectRuntimePayload({
      appRoot: root,
      platform: 'win32',
      arch: 'x64',
      info: { runtimePayloads: { 'win32-x64': { path: 'runtime/win32-x64', digest: `sha256:${'0'.repeat(64)}` } } },
    })
    expect(win32).toMatchObject({ ok: false, reason: 'unsupported-platform', key: 'win32-x64' })

    const unknown = selectRuntimePayload({
      appRoot: root,
      platform: 'aix',
      arch: 'ppc64',
      info: { runtimePayloads: { 'aix-ppc64': { path: 'runtime/aix-ppc64', digest: `sha256:${'0'.repeat(64)}` } } },
    })
    expect(unknown).toMatchObject({ ok: false, reason: 'unsupported-platform', key: 'aix-ppc64' })
  })

  it('reports no-release-payloads for a dev/legacy bundle so callers fall back untouched', () => {
    const root = scratchDir('runtime-dev-')
    const result = selectRuntimePayload({ appRoot: root, platform: 'darwin', arch: 'arm64', info: null })
    expect(result).toMatchObject({ ok: false, reason: 'no-release-payloads' })
    const linuxDev = selectRuntimePayload({ appRoot: root, platform: 'linux', arch: 'x64', info: null })
    expect(linuxDev).toMatchObject({ ok: false, reason: 'no-release-payloads', key: 'linux-x64' })
    const legacy = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { repoRoot: '/some/checkout', nodeBin: '/some/checkout/node' },
    })
    expect(legacy).toMatchObject({ ok: false, reason: 'no-release-payloads' })
  })

  it('rejects an absolute payload path', () => {
    const { root } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: '/etc/passwd', digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-path' })
  })

  it('rejects a path-traversal payload path', () => {
    const { root } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: '../outside', digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-path' })
  })

  it('rejects a malformed digest', () => {
    const { root } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: 'not-a-digest' } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-digest' })
  })

  it('rejects a digest that does not match the staged runtime-manifest.json', () => {
    const { root, arm } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: arm.path, digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'digest-mismatch' })
  })

  it.each([
    ['installer bytes', (root: string) => writeFileSync(join(root, 'scripts', 'install-agents.sh'), '#!/bin/bash\necho tampered\n')],
    ['verifier helper bytes', (root: string) => writeFileSync(join(root, 'scripts', 'runtime-payload.mjs'), '// tampered helper\n')],
    ['native addon bytes', (root: string) => writeFileSync(join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'tampered-native\n')],
    ['an extra file', (root: string) => writeFileSync(join(root, 'extra.js'), 'unmanifested\n')],
    ['a mode change', (root: string) => chmodSync(join(root, 'scripts', 'install-agents.sh'), 0o755)],
  ])('rejects %s before Setup can execute it', (_label, tamper) => {
    const { root, arm } = releaseRoot()
    tamper(join(root, arm.path))
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': arm } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'payload-integrity' })
  })

  it('rejects an external identical runtime-manifest.json symlink', () => {
    const { root, arm } = releaseRoot()
    const manifestPath = join(root, arm.path, 'runtime-manifest.json')
    const outside = join(scratchDir('runtime-manifest-outside-'), 'runtime-manifest.json')
    writeFileSync(outside, readFileSync(manifestPath))
    rmSync(manifestPath)
    symlinkSync(outside, manifestPath)
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': arm } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'symlinked-payload' })
  })

  it.skipIf(!['darwin', 'linux'].includes(process.platform))('re-verifies a release payload immediately before spawn and refuses tampering', async () => {
    const root = scratchDir('runtime-reverify-')
    const key = `${process.platform}-${process.arch}`
    const payload = stagePayloadDir(root, `runtime/${key}`, {
      platform: process.platform,
      arch: process.arch,
    })
    const payloadRoot = join(root, payload.path)
    const marker = join(root, 'spawned')
    writeFileSync(join(payloadRoot, 'scripts', 'install-agents.sh'), `#!/bin/bash\ntouch '${marker}'\n`)
    const result = await runAgentInstall({
      repoRoot: payloadRoot,
      target: 'all',
      runtimePayload: { key, path: payloadRoot, digest: payload.digest, packageVersion: '1.2.3' },
    })
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/integrity verification/i)
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects a missing payload directory', () => {
    const { root } = releaseRoot()
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/does-not-exist', digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('rejects a payload path that resolves to a file, not a directory', () => {
    const root = scratchDir('runtime-not-dir-')
    mkdirSync(join(root, 'runtime'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'darwin-arm64'), 'not a directory')
    const digest = createHash('sha256').update('not a directory').digest('hex')
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: `sha256:${digest}` } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-a-directory' })
  })

  it('rejects a payload directory with no runtime-manifest.json', () => {
    const root = scratchDir('runtime-no-manifest-')
    mkdirSync(join(root, 'runtime', 'darwin-arm64'), { recursive: true })
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: 'sha256:' + '0'.repeat(64) } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'missing-manifest' })
  })

  it("rejects a manifest whose platform/arch don't match the map key it was selected under", () => {
    const root = scratchDir('runtime-mismatch-')
    // Staged under the darwin-arm64 key, but its own manifest says x64 — a
    // build-time mix-up that must never be trusted at selection time either.
    const payload = stagePayloadDir(root, 'runtime/darwin-arm64', { platform: 'darwin', arch: 'x64' })
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': payload } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'manifest-mismatch' })
  })

  it('rejects a payload directory with no installer script', () => {
    const root = scratchDir('runtime-no-installer-')
    const payload = stagePayloadDir(root, 'runtime/darwin-arm64', { platform: 'darwin', arch: 'arm64', withInstaller: false })
    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': payload } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'manifest-mismatch' })
  })

  it('rejects a payload directory that is itself a symlink, regardless of where it resolves', () => {
    const root = scratchDir('runtime-symlink-entry-')
    const outside = scratchDir('runtime-symlink-entry-outside-')
    const payload = stagePayloadDir(outside, 'darwin-arm64', { platform: 'darwin', arch: 'arm64' })
    mkdirSync(join(root, 'runtime'), { recursive: true })
    symlinkSync(join(outside, 'darwin-arm64'), join(root, 'runtime', 'darwin-arm64'))

    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: payload.digest } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'symlinked-payload' })
  })

  it('rejects a payload directory that escapes the app root through an ancestor symlink', () => {
    const root = scratchDir('runtime-symlink-app-')
    const outside = scratchDir('runtime-symlink-outside-')
    // The ancestor `runtime` segment is a symlink out of appRoot — the final
    // `darwin-arm64` path component itself is a real (non-symlink) directory,
    // so this is caught by REAL-path containment, not the symlinked-entry check.
    symlinkSync(outside, join(root, 'runtime'))
    const payload = stagePayloadDir(outside, 'darwin-arm64', { platform: 'darwin', arch: 'arm64' })

    const result = selectRuntimePayload({
      appRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: 'runtime/darwin-arm64', digest: payload.digest } } },
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-contained' })
  })

  it('resolves correctly through a symlinked app root whose real path contains a legitimate payload', () => {
    const real = scratchDir('runtime-symlink-real-')
    const { path: relPath, digest } = stagePayloadDir(real, 'runtime/darwin-arm64', { platform: 'darwin', arch: 'arm64' })
    const outerParent = scratchDir('runtime-symlink-outer-')
    const linkedAppRoot = join(outerParent, 'app-root-link')
    symlinkSync(real, linkedAppRoot)

    const result = selectRuntimePayload({
      appRoot: linkedAppRoot,
      platform: 'darwin',
      arch: 'arm64',
      info: { runtimePayloads: { 'darwin-arm64': { path: relPath, digest } } },
    })
    // The legitimate payload still resolves correctly through the symlinked root.
    expect(result.ok).toBe(true)
  })

  it('reads setup-info.json fail-open, tolerating a missing or corrupt file', () => {
    const root = scratchDir('setup-info-read-')
    expect(readSetupInfo(root)).toBe(null)
    writeFileSync(join(root, 'setup-info.json'), 'not json{{{')
    expect(readSetupInfo(root)).toBe(null)
    writeFileSync(join(root, 'setup-info.json'), JSON.stringify({ schema: 2, version: '1.0.0' }))
    expect(readSetupInfo(root)).toMatchObject({ schema: 2, version: '1.0.0' })
  })
})

describe('runAgentInstall runtime payload argv (issue #74)', () => {
  it.skipIf(process.platform !== 'linux' || process.arch !== 'x64')(
    'flows a baked linux-x64 release through exact selection, re-verification, trusted core, and fixed argv',
    async () => {
      const argsFile = join(scratchDir('setup-linux-release-args-'), 'args')
      const root = scratchDir('setup-linux-release-')
      const payload = stagePayloadDir(root, 'runtime/linux-x64', {
        platform: 'linux',
        arch: 'x64',
        installerScript: `#!/bin/bash
printf '%s\\n' "$@" > "$ARGS_FILE"
`,
      })
      execFileSync(process.execPath, [
        SETUP_INFO_CLI,
        '--release', join(root, 'setup-info.json'),
        '--version', '1.2.3',
        '--runtime-key', 'linux-x64',
        '--payload-root', root,
        '--payload', 'linux-x64=runtime/linux-x64',
      ])

      const selected = selectRuntimePayloadRaw({ appRoot: root })
      expect(selected).toMatchObject({
        ok: true,
        key: 'linux-x64',
        relativePath: 'runtime/linux-x64',
        packageVersion: '1.2.3',
      })
      if (!selected.ok || !selected.path || !selected.digest || !selected.packageVersion) {
        throw new Error('expected a selected linux-x64 payload')
      }

      const result = await runAgentInstall({
        repoRoot: selected.path,
        target: 'all',
        runtimePayload: {
          key: selected.key,
          path: selected.path,
          digest: selected.digest,
          packageVersion: selected.packageVersion,
        },
        env: { ...process.env, ARGS_FILE: argsFile },
      })

      expect(result).toMatchObject({ ok: true, exitCode: 0, cancelled: false, timedOut: false })
      expect(readFileSync(argsFile, 'utf8')).toBe(
        `--apply\n--target\nall\n--runtime-source\n${selected.path}\n--runtime-digest\n${payload.digest}\n`,
      )
    },
  )

  it.skipIf(!['darwin', 'linux'].includes(process.platform))(
    'refuses a valid payload for the other POSIX architecture even when both payloads verify',
    async () => {
      const root = scratchDir('setup-runtime-cross-arch-')
      const hostKey = `${process.platform}-${process.arch}`
      const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64'
      const otherKey = `${process.platform}-${otherArch}`
      stagePayloadDir(root, `runtime/${hostKey}`, {
        platform: process.platform,
        arch: process.arch,
      })
      const other = stagePayloadDir(root, `runtime/${otherKey}`, {
        platform: process.platform,
        arch: otherArch,
      })
      let spawned = false

      const actual = await runAgentInstall({
        repoRoot: join(root, other.path),
        target: 'all',
        runtimePayload: {
          key: otherKey,
          path: join(root, other.path),
          digest: other.digest,
          packageVersion: '1.2.3',
        },
        spawnImpl: () => {
          spawned = true
          throw new Error('must not spawn')
        },
      })

      expect(spawned).toBe(false)
      expect(actual.ok).toBe(false)
      expect(actual.output).toMatch(/integrity verification/i)
    },
  )

  it.skipIf(!['darwin', 'linux'].includes(process.platform))('passes explicit --runtime-source/--runtime-digest for a release install, and dev installs stay unchanged', async () => {
    const argsFile = join(scratchDir('setup-runtime-args-'), 'args')
    const root = scratchDir('setup-runtime-payload-')
    const key = `${process.platform}-${process.arch}`
    const payload = stagePayloadDir(root, `runtime/${key}`, {
      platform: process.platform,
      arch: process.arch,
      installerScript: `#!/bin/bash
printf '%s\\n' "$@" > "$ARGS_FILE"
printf 'installed %s\\n' "$3"
`,
    })
    const payloadRoot = join(root, payload.path)

    const result = await runAgentInstall({
      repoRoot: payloadRoot,
      target: 'all',
      runtimePayload: { key, path: payloadRoot, digest: payload.digest, packageVersion: '1.2.3' },
      env: { ...process.env, ARGS_FILE: argsFile },
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(argsFile, 'utf8')).toBe(
      `--apply\n--target\nall\n--runtime-source\n${payloadRoot}\n--runtime-digest\n${payload.digest}\n`,
    )
  })

  it('rejects a malformed runtimePayload without spawning the installer', async () => {
    const root = fixture('echo should-not-run\n')
    const result = await runAgentInstall({
      repoRoot: root,
      target: 'all',
      runtimePayload: { key: 'darwin-arm64', path: '', digest: 'sha256:' + '0'.repeat(64), packageVersion: '1.2.3' },
    })
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/invalid release runtime payload/i)
  })

  it('keeps the exact dev/legacy argv when no runtimePayload is passed', async () => {
    const argsFile = join(scratchDir('setup-dev-args-'), 'args')
    const root = fixture(`#!/bin/bash
printf '%s\\n' "$@" > "$ARGS_FILE"
`)
    await runAgentInstall({
      repoRoot: root,
      target: 'claude',
      env: { ...process.env, ARGS_FILE: argsFile },
    })
    expect(readFileSync(argsFile, 'utf8')).toBe('--apply\n--target\nclaude\n')
  })
})

// #206: Setup moves Claude's hooks through one more fixed target. Its installer
// bakes its OWN directory's bin/node and dist/hook-cli.js into Claude's
// settings, so it must run from the installed copy of this release's runtime
// (~/.agent-inbox/runtime/<runtimeId>), never from the app bundle's payload:
// hooks pointing into the bundle would break with the next app update. The
// copy is found by the runtime id the trusted core verified, and re-verified
// against the same signed manifest digest immediately before spawn.
describe.skipIf(!['darwin', 'linux'].includes(process.platform))('runAgentInstall: the Claude hooks target (#206)', () => {
  const key = `${process.platform}-${process.arch}`

  /** A release bundle carrying this host's payload of `version`, and its runtimePayload as main passes it. */
  function release(version = '1.1.0'): { source: StagedRuntime; payload: { key: string; path: string; digest: string; packageVersion: string } } {
    const appRoot = scratchDir('setup-hooks-bundle-')
    const source = stageRuntime(join(appRoot, 'runtime', key), version)
    return { source, payload: { key, path: source.dir, digest: source.digest, packageVersion: version } }
  }

  /** Claude's hooks installed by an older Setup runtime, through its own real installer. */
  function olderHooks(h: HooksHome): StagedRuntime {
    const older = installRuntime(h, '1.0.0')
    const seeded = spawnSync('/bin/bash', [join(older.dir, 'scripts', 'install-hooks.sh'), '--apply'], { encoding: 'utf8', env: h.env })
    expect(seeded.status, seeded.stderr).toBe(0)
    return older
  }

  function recordingSpawn() {
    const calls: unknown[][] = []
    const spawnImpl = (...args: unknown[]): never => {
      calls.push(args)
      throw new Error('recorded, not spawned')
    }
    return { calls, spawnImpl }
  }

  it('moves the hooks onto the installed copy of the verified runtime, never the app bundle\'s', async () => {
    const h = hooksHome()
    const older = olderHooks(h)
    const { source, payload } = release()
    const installed = installStaged(h, source)

    const result = await runAgentInstall({ repoRoot: source.dir, target: 'hooks', runtimePayload: payload, env: h.env })

    expect(result, result.output).toMatchObject({ ok: true, exitCode: 0, target: 'hooks', timedOut: false, cancelled: false })
    const hooks = hookLaunchers(h)
    expect(hooks.length).toBeGreaterThan(0)
    for (const hook of hooks) {
      expect(hook).toEqual({ command: join(installed.dir, 'bin', 'node'), entry: join(installed.dir, 'dist', 'hook-cli.js') })
    }
    expect(JSON.stringify(hooks)).not.toContain(source.dir)
    expect(JSON.stringify(hooks)).not.toContain(older.dir)
  })

  it('spawns exactly /bin/bash <installed runtime>/scripts/install-hooks.sh --apply --move-only: no --force, no runtime arguments', async () => {
    const h = hooksHome()
    const { source, payload } = release()
    const installed = installStaged(h, source)
    const { calls, spawnImpl } = recordingSpawn()

    await runAgentInstall({ repoRoot: source.dir, target: 'hooks', runtimePayload: payload, env: h.env, spawnImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('/bin/bash')
    expect(calls[0]![1]).toEqual([join(installed.dir, 'scripts', 'install-hooks.sh'), '--apply', '--move-only'])
    expect(calls[0]![2]).toMatchObject({ cwd: installed.dir, detached: true })
  })

  it('finds the installed copy where the installers put it: AGENT_INBOX_RUNTIME_ROOT when set', async () => {
    const h = hooksHome()
    const elsewhere = join(h.home, 'custom-runtimes')
    const { source, payload } = release()
    const installed = installStaged({ ...h, runtimeRoot: elsewhere }, source)
    const { calls, spawnImpl } = recordingSpawn()

    await runAgentInstall({
      repoRoot: source.dir, target: 'hooks', runtimePayload: payload, env: { ...h.env, AGENT_INBOX_RUNTIME_ROOT: elsewhere }, spawnImpl,
    })

    expect(calls[0]![1]).toEqual([join(installed.dir, 'scripts', 'install-hooks.sh'), '--apply', '--move-only'])
  })

  it.each([
    ['this release\'s runtime is not installed yet', (_h: HooksHome, _source: StagedRuntime) => {},
      /not moved: this app's v1\.1\.0 runtime is not installed yet/],
    ['a file of the installed copy changed', (h: HooksHome, source: StagedRuntime) => {
      writeFileSync(join(installStaged(h, source).dir, 'scripts', 'install-hooks.sh'), '#!/bin/bash\necho swapped\n')
    }, /not moved: the installed v1\.1\.0 runtime failed integrity verification/],
    ['the installed copy carries an extra file', (h: HooksHome, source: StagedRuntime) => {
      writeFileSync(join(installStaged(h, source).dir, 'scripts', 'extra.sh'), 'echo extra\n')
    }, /failed integrity verification/],
    // same runtime id and file hashes, other bytes: only the signed digest tells
    ['the installed manifest is not byte-identical to the signed one', (h: HooksHome, source: StagedRuntime) => {
      const manifest = join(installStaged(h, source).dir, 'runtime-manifest.json')
      writeFileSync(manifest, `${JSON.stringify(JSON.parse(readFileSync(manifest, 'utf8')), null, 4)}\n`)
    }, /failed integrity verification/],
    ['the installed copy is a symlink to a matching runtime', (h: HooksHome, source: StagedRuntime) => {
      const real = installStaged({ ...h, runtimeRoot: join(h.home, 'elsewhere') }, source)
      mkdirSync(h.runtimeRoot, { recursive: true })
      symlinkSync(real.dir, join(h.runtimeRoot, source.runtimeId))
    }, /failed integrity verification/],
    ['AGENT_INBOX_RUNTIME_ROOT is relative', (h: HooksHome, source: StagedRuntime) => {
      installStaged(h, source)
      h.env.AGENT_INBOX_RUNTIME_ROOT = 'relative/runtime'
    }, /not moved: AGENT_INBOX_RUNTIME_ROOT must be an absolute path/],
  ] as const)('refuses without spawning when %s, and leaves the hooks where they are', async (_label, arrange, error) => {
    const h = hooksHome()
    olderHooks(h)
    const settingsBefore = readFileSync(h.settings, 'utf8')
    const { source, payload } = release()
    arrange(h, source)
    const { calls, spawnImpl } = recordingSpawn()

    const result = await runAgentInstall({ repoRoot: source.dir, target: 'hooks', runtimePayload: payload, env: h.env, spawnImpl })

    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ ok: false, exitCode: null, target: 'hooks', cancelled: false, timedOut: false })
    expect(result.output).toMatch(error)
    expect(readFileSync(h.settings, 'utf8')).toBe(settingsBefore)
  })

  it('refuses where the app bundle\'s own payload does not verify, before looking for the installed copy', async () => {
    const h = hooksHome()
    const { source, payload } = release()
    installStaged(h, source)
    writeFileSync(join(source.dir, 'dist', 'hook-cli.js'), '// tampered in the bundle\n')
    const { calls, spawnImpl } = recordingSpawn()

    const result = await runAgentInstall({ repoRoot: source.dir, target: 'hooks', runtimePayload: payload, env: h.env, spawnImpl })

    expect(calls).toHaveLength(0)
    expect(result.output).toMatch(/release runtime payload failed integrity verification/i)
  })

  it('refuses the hooks target outright in a dev checkout, which has no verified release runtime', async () => {
    const root = fixture('#!/bin/bash\ntouch "$SHOULD_NOT_EXIST"\n')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'scripts', 'install-hooks.sh'), '#!/bin/bash\ntouch "$SHOULD_NOT_EXIST"\n')
    const { calls, spawnImpl } = recordingSpawn()

    const result = await runAgentInstall({ repoRoot: root, target: 'hooks', runtimePayload: null, spawnImpl })

    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ ok: false, exitCode: null, target: 'hooks' })
    expect(result.output).toMatch(/only from a release build's verified runtime/i)
  })
})

// #206: main accepts `hooks` exactly where it accepts the agent targets — a
// window bound to a viewer this app started and proved it owns, not while the
// app quits, another Setup install runs, or an app update installs — and hands
// it to runAgentInstall with the same verified release payload. main's own
// handler is evaluated against a real install gate and canRunSetup.
describe('main\'s install handler and the hooks target (#206)', () => {
  const VIEWER = 'http://127.0.0.1:4319/'
  const RELEASE = {
    ok: true, reason: undefined, key: 'darwin-arm64', path: '/Applications/Agent Inbox.app/Contents/Resources/app/runtime/darwin-arm64',
    digest: `sha256:${'a'.repeat(64)}`, packageVersion: '1.3.2',
  }
  type World = {
    setupInstallEnabled?: boolean
    bound?: number | null
    quitting?: boolean
    setupRunning?: boolean
    updateInstalling?: boolean
    runtimeSelection?: Record<string, unknown>
    checkout?: string
    runAgentInstall?: (opts: Record<string, unknown>) => Promise<unknown>
  }
  type SetupOutcome = { ok: boolean; output: string; target: string; cancelled?: boolean }

  function mainInstall(world: World = {}) {
    const main = readFileSync(join(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const marker = "ipcMain.handle('agent-inbox:install', "
    const start = main.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const body = main.slice(start + marker.length, main.indexOf('\n})', start) + 2)
    const gate = createInstallGate()
    if (world.setupRunning) gate.run(() => new Promise(() => {}))
    if (world.quitting) gate.beginQuit()
    const run = vi.fn(world.runAgentInstall ?? (async (opts: Record<string, unknown>) => ({ ok: true, output: 'ran', target: opts['target'] })))
    const handler = new Function(
      'installGate', 'setupInstallEnabled', 'canRunSetup', 'URL_BASE', 'setupInstallWebContentsId', 'runtimeSelection',
      'installerRepoRoot', 'REPO_ROOT', 'updateController', 'runAgentInstall',
      `return ${body}`,
    )(
      gate,
      world.setupInstallEnabled ?? true,
      canRunSetup,
      VIEWER,
      world.bound === undefined ? 7 : world.bound,
      world.runtimeSelection ?? RELEASE,
      installerRepoRoot,
      world.checkout ?? '/nonexistent-checkout',
      { isInstalling: () => world.updateInstalling === true },
      run,
    ) as (event: unknown, target: unknown) => Promise<SetupOutcome>
    const event = (url = VIEWER, id = 7) => ({ senderFrame: { url }, sender: { id } })
    return { handler, event, run }
  }

  it('hands hooks to runAgentInstall with the verified release payload, from the bound window of the owned viewer', async () => {
    const m = mainInstall()
    await expect(m.handler(m.event(), 'hooks')).resolves.toMatchObject({ ok: true, target: 'hooks' })
    expect(m.run).toHaveBeenCalledOnce()
    expect(m.run.mock.calls[0]![0]).toMatchObject({
      repoRoot: RELEASE.path,
      target: 'hooks',
      runtimePayload: { key: RELEASE.key, path: RELEASE.path, digest: RELEASE.digest, packageVersion: RELEASE.packageVersion },
    })
  })

  it.each([
    // a reused or failed-over viewer is never this app's own: Setup stays off
    ['from a viewer this app does not own', { setupInstallEnabled: false }, {}, /unavailable for this viewer/],
    ['from a window Setup is not bound to', { bound: null }, {}, /unavailable for this viewer/],
    ['from another window', {}, { id: 8 }, /unavailable for this viewer/],
    ['from a page of another origin', {}, { url: 'https://example.com/' }, /unavailable for this viewer/],
    ['once the app has begun to quit', { quitting: true }, {}, /quitting, so setup did not start/],
    ['while another Setup install runs', { setupRunning: true }, {}, /already running/],
    ['while an app update installs', { updateInstalling: true }, {}, /update is being installed/],
  ] as const)('refuses hooks %s, without starting anything', async (_label, world, sender, error) => {
    const m = mainInstall(world)
    const { url, id } = sender as { url?: string; id?: number }
    const outcome = await m.handler(m.event(url, id), 'hooks')
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toMatch(error)
    expect(m.run).not.toHaveBeenCalled()
  })

  it('a dev checkout has no verified runtime, so its hooks target spawns nothing', async () => {
    const root = fixture('#!/bin/bash\nexit 0\n')
    writeFileSync(join(root, 'scripts', 'install-hooks.sh'), '#!/bin/bash\nexit 0\n')
    const spawnImpl = vi.fn()
    const m = mainInstall({
      runtimeSelection: { ok: false, reason: 'no-release-payloads', key: 'darwin-arm64' },
      checkout: root,
      runAgentInstall: (opts) => runAgentInstall({ ...(opts as Parameters<typeof runAgentInstall>[0]), spawnImpl: spawnImpl as never }),
    })
    const outcome = await m.handler(m.event(), 'hooks')
    expect(m.run.mock.calls[0]![0]).toMatchObject({ repoRoot: root, target: 'hooks', runtimePayload: null })
    expect(outcome).toMatchObject({ ok: false, target: 'hooks' })
    expect(outcome.output).toMatch(/only from a release build's verified runtime/)
    expect(spawnImpl).not.toHaveBeenCalled()
  })
})
