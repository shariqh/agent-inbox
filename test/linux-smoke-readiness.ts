import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'

export function testLinuxSmokeReadiness(scriptPath: string) {
  const script = readFileSync(scriptPath, 'utf8')
  const startup = script.match(/^for _ in \{1\.\.90\}; do\n[\s\S]*?^assert_chromium_sandbox$/m)?.[0]
  if (!startup) throw new Error(`Missing startup gate in ${scriptPath}`)

  function run({
    sandboxReadyAfter = 1,
    viewerReadyAfter = 1,
    exitAfter = 100,
  } = {}) {
    const result = spawnSync('/bin/bash', ['-s'], {
      encoding: 'utf8',
      timeout: 5_000,
      input: `set -euo pipefail
APP_PID=12345
PORT=4319
sandbox_probes=0
alive_probes=0
sleeps=0
trap 'printf "%s %s %s\\n" "$sandbox_probes" "$sleeps" "$alive_probes"' EXIT
kill() {
  [[ "$1" == -0 && "$2" == "$APP_PID" ]] || return 2
  alive_probes=$((alive_probes + 1))
  (( alive_probes <= ${exitAfter} ))
}
curl() {
  (( alive_probes >= ${viewerReadyAfter} )) || return 7
  printf 'x-agent-inbox-local-boundary: loopback-v1\\r\\n'
}
sleep() {
  [[ "$1" == 1 ]] || return 2
  sleeps=$((sleeps + 1))
}
assert_chromium_sandbox() {
  sandbox_probes=$((sandbox_probes + 1))
  if (( sandbox_probes >= ${sandboxReadyAfter} )); then return 0; fi
  echo "fixture: no sandbox proof" >&2
  return 1
}
${startup}
`,
    })
    if (result.error) throw result.error
    const [sandboxProbes, sleeps, aliveProbes] = result.stdout.trim().split(' ').map(Number)
    return { status: result.status, stderr: result.stderr, sandboxProbes, sleeps, aliveProbes }
  }

  describe(`${basename(scriptPath)} startup readiness`, () => {
    it('keeps the immediate-ready path fast', () => {
      const result = run()
      expect(result.status, result.stderr).toBe(0)
      expect(result.sleeps).toBe(0)
    })

    it('waits for the sandbox when the viewer responds before the renderer starts', () => {
      const result = run({ sandboxReadyAfter: 3 })
      expect(result.status, result.stderr).toBe(0)
      expect(result.sleeps).toBe(2)
      expect(result.aliveProbes).toBe(3)
      expect(result.sandboxProbes).toBeGreaterThanOrEqual(3)
    })

    it('still fails after the bounded wait when no sandbox proof arrives', () => {
      const result = run({ sandboxReadyAfter: 1_000 })
      expect(result.status).toBe(1)
      expect(result.sleeps).toBe(90)
      expect(result.aliveProbes).toBe(90)
      expect(result.sandboxProbes).toBe(91)
      expect(result.stderr).toContain('no sandbox proof')
    })

    it('detects an app that exits while renderer startup is pending', () => {
      const result = run({ sandboxReadyAfter: 3, exitAfter: 1 })
      expect(result.status).toBe(1)
      expect(result.aliveProbes).toBe(2)
      expect(result.sleeps).toBe(1)
      expect(result.stderr).toContain('application exited')
    })

    it('does not accept a sandbox proof without the viewer boundary marker', () => {
      const result = run({ viewerReadyAfter: 1_000 })
      expect(result.status).not.toBe(0)
      expect(result.sleeps).toBe(90)
      expect(result.sandboxProbes).toBe(0)
    })
  })
}
