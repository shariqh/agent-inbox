import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  canRunSetup,
  installerRepoRoot,
  isTrustedSetupSender,
  runAgentInstall,
} = require('../electron/setup-runner.cjs') as {
  canRunSetup(senderUrl: string, viewerUrl: string, senderId: number, authorizedWebContentsId: number | null): boolean
  installerRepoRoot(appRoot: string): string | null
  isTrustedSetupSender(senderUrl: string, viewerUrl: string): boolean
  runAgentInstall(opts: {
    repoRoot: string
    target: string
    env?: NodeJS.ProcessEnv
    maxOutput?: number
    timeoutMs?: number
    onCancel?: (cancel: () => void) => void
  }): Promise<{ ok: boolean; exitCode: number | null; output: string; target: string; timedOut: boolean; cancelled: boolean }>
}

function fixture(script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'setup-runner-'))
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  const installer = join(scripts, 'install-agents.sh')
  writeFileSync(installer, script)
  chmodSync(installer, 0o755)
  return root
}

describe('Electron one-click setup runner', () => {
  it('accepts only the exact local viewer origin', () => {
    expect(isTrustedSetupSender('http://localhost:4319/', 'http://localhost:4319/')).toBe(true)
    expect(isTrustedSetupSender('http://localhost:4319/setup', 'http://localhost:4319/')).toBe(true)
    expect(isTrustedSetupSender('http://localhost:4319.evil.example/', 'http://localhost:4319/')).toBe(false)
    expect(isTrustedSetupSender('https://localhost:4319/', 'http://localhost:4319/')).toBe(false)
    expect(isTrustedSetupSender('not a url', 'http://localhost:4319/')).toBe(false)
    expect(canRunSetup('http://localhost:4319/', 'http://localhost:4319/', 7, 7)).toBe(true)
    expect(canRunSetup('http://localhost:4319/', 'http://localhost:4319/', 7, 8)).toBe(false)
  })

  it('resolves the packaged checkout from setup-info and refuses a missing installer', () => {
    const packaged = mkdtempSync(join(tmpdir(), 'setup-packaged-'))
    const checkout = fixture('exit 0\n')
    writeFileSync(join(packaged, 'setup-info.json'), JSON.stringify({ repoRoot: checkout }))

    expect(installerRepoRoot(packaged)).toBe(checkout)
    expect(installerRepoRoot(mkdtempSync(join(tmpdir(), 'setup-missing-')))).toBe(null)
  })

  it('spawns only the fixed installer with validated target arguments', async () => {
    const argsFile = join(tmpdir(), `setup-args-${process.pid}-${Date.now()}`)
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

    expect(main).toContain("ipcMain.handle('agent-inbox:install'")
    expect(main).toContain('canRunSetup(senderUrl, URL_BASE, event.sender.id, setupInstallWebContentsId)')
    expect(main).toContain('await waitForOwnership()')
    expect(main).not.toContain('setupInstallEnabled = true\n        if (!win.isDestroyed())')
    expect(main).toContain("app.on('before-quit'")
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain("preload: path.join(__dirname, 'setup-preload.cjs')")
    expect(main).toContain("accelerator: 'CommandOrControl+,'")
    expect(main).toContain("win.webContents.send('agent-inbox:toggle-settings')")
    expect(preload).toContain("contextBridge.exposeInMainWorld('agentInboxSetup'")
    expect(preload).toContain('onToggleSettings')
    expect(preload).not.toContain('child_process')
  })
})
