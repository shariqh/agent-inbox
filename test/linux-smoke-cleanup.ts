// Runs a Linux smoke script's real EXIT-trap cleanup against a real process
// group (#348). Deliberately NOT named *.test.ts: the workflow test files call it.
//
// POSIX process groups behave the same on Linux and macOS, so this runs on both;
// it is skipped on Windows, which has no `kill -- -pgid`.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scratchDir } from './scratch.js'

// The group leader stands in for xvfb-run and exits at once on SIGTERM. Its
// child stands in for Electron's helpers: `linger` keeps creating files under
// the scratch home for about a second after SIGTERM, `stubborn` ignores
// SIGTERM and writes until SIGKILL.
const APP = `#!/usr/bin/env bash
mode="$1" scratch="$2" out="$3"
helper() {
  stop=0
  if [[ "$mode" == stubborn ]]; then trap '' TERM; else trap 'stop=1' TERM; fi
  : > "$out/ready"
  while [[ "$stop" == 0 ]]; do
    mkdir -p "$scratch/.config/agent-inbox/Crashpad" 2>/dev/null
    /bin/sleep 0.02
  done
  for i in $(seq 1 50); do
    mkdir -p "$scratch/.config/agent-inbox/Local Storage/$i" 2>/dev/null
    : > "$scratch/.config/agent-inbox/Local Storage/$i/leveldb" 2>/dev/null
    /bin/sleep 0.02
  done
  : > "$out/finished"
}
helper &
trap 'exit 0' TERM
wait
`

export function testLinuxSmokeCleanup(scriptPath: string) {
  const script = readFileSync(scriptPath, 'utf8')
  const block = script.match(/^APP_PID=""\n[\s\S]*?^trap cleanup EXIT$/m)?.[0]
  if (!block) throw new Error(`Missing cleanup block in ${scriptPath}`)

  function run({ mode = 'linger', end = '', fastSleep = false, locked = false, persistent = false } = {}) {
    const base = scratchDir('agent-inbox-smoke-cleanup-')
    const scratch = join(base, 'scratch')
    const out = join(base, 'out')
    mkdirSync(join(scratch, '.config', 'agent-inbox'), { recursive: true })
    mkdirSync(out)
    writeFileSync(join(base, 'app.sh'), APP, { mode: 0o755 })
    if (locked) {
      mkdirSync(join(scratch, 'locked'))
      writeFileSync(join(scratch, 'locked', 'file'), '')
      chmodSync(join(scratch, 'locked'), 0o500)
    }
    const result = spawnSync('/bin/bash', ['-s'], {
      encoding: 'utf8',
      timeout: 30_000,
      input: `set -euo pipefail
SCRATCH=${JSON.stringify(scratch)}
PERSISTENT_HOME=${persistent ? 1 : 0}
${fastSleep ? 'sleep() { /bin/sleep 0.01; }' : ''}
${block}
${locked ? '' : `set -m
${JSON.stringify(join(base, 'app.sh'))} ${mode} "$SCRATCH" ${JSON.stringify(out)} </dev/null >/dev/null 2>&1 &
APP_PID=$!
set +m
echo "$APP_PID" > ${JSON.stringify(join(out, 'pgid'))}
while [[ ! -e ${JSON.stringify(join(out, 'ready'))} ]]; do /bin/sleep 0.02; done`}
${end}
`,
    })
    const pgid = Number(existsSync(join(out, 'pgid')) ? readFileSync(join(out, 'pgid'), 'utf8') : 0)
    if (pgid > 0) {
      // never leak a fixture process when cleanup is broken
      try { process.kill(-pgid, 'SIGKILL') } catch { /* already gone */ }
    }
    if (result.error) throw result.error
    if (locked && existsSync(join(scratch, 'locked'))) chmodSync(join(scratch, 'locked'), 0o700)
    return { ...result, scratch, out }
  }

  const posix = process.platform !== 'win32'
  describe.skipIf(!posix)(`${basename(scriptPath)} cleanup (#348)`, () => {
    it('waits for every process in the app group before removing the scratch home', () => {
      const result = run()
      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(join(result.out, 'finished'))).toBe(true)
      expect(existsSync(result.scratch)).toBe(false)
      spawnSync('/bin/sleep', ['0.3'])
      expect(existsSync(result.scratch)).toBe(false)
    })

    it('keeps the status of a real earlier failure', () => {
      const result = run({ end: 'exit 7' })
      expect(result.status, result.stderr).toBe(7)
      expect(existsSync(result.scratch)).toBe(false)
    })

    it('kills a group that ignores SIGTERM and still exits 0', () => {
      const result = run({ mode: 'stubborn', fastSleep: true })
      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(join(result.out, 'finished'))).toBe(false)
      spawnSync('/bin/sleep', ['0.2'])
      expect(existsSync(result.scratch)).toBe(false)
    })

    it.skipIf(!block.includes('PERSISTENT_HOME'))('stops the app but keeps a persistent --home', () => {
      const result = run({ persistent: true })
      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(join(result.out, 'finished'))).toBe(true)
      expect(existsSync(join(result.scratch, '.config', 'agent-inbox', 'Local Storage', '50', 'leveldb'))).toBe(true)
    })

    const root = typeof process.getuid === 'function' && process.getuid() === 0
    it.skipIf(root)('fails loudly when the scratch home cannot be removed', () => {
      const result = run({ locked: true, fastSleep: true })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/could not remove scratch directory .*scratch/)
    })

    it.skipIf(root)('keeps a real failure status when the scratch home cannot be removed', () => {
      const result = run({ locked: true, fastSleep: true, end: 'exit 7' })
      expect(result.status).toBe(7)
      expect(result.stderr).toMatch(/could not remove scratch directory/)
    })
  })
}
