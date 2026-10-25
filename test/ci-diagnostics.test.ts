import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PoolOptions } from 'vitest/node'
import { CI_DIAGNOSTICS_ENV, ciDiagnostics } from './ci-diagnostics.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const root = resolve(process.cwd())
const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
const UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2'

function step(name: string): string {
  const marker = `      - name: ${name}\n`
  const start = workflow.indexOf(marker)
  if (start < 0) return ''
  const rest = workflow.slice(start + marker.length)
  const next = rest.search(/^ {6}- /m)
  return marker + (next < 0 ? rest : rest.slice(0, next))
}

afterEach(() => {
  removeScratchDirs()
  vi.restoreAllMocks()
})

describe('CI crash diagnostics (#359)', () => {
  it('is off unless the CI-only variable names a directory', () => {
    expect(ciDiagnostics({})).toBeUndefined()
    expect(ciDiagnostics({ [CI_DIAGNOSTICS_ENV]: '' })).toBeUndefined()
    expect(config).toContain('const diagnostics = ciDiagnostics(process.env)')
    expect(config).toContain('...(diagnostics ?? {}),')
  })

  it('gives only the fork workers fatal-error report flags, never NODE_OPTIONS', () => {
    const dir = scratchDir('ci-diagnostics-')
    const d = ciDiagnostics({ [CI_DIAGNOSTICS_ENV]: dir })
    expect(d?.execArgv).toEqual([
      '--report-on-fatalerror',
      // the artifact is public: no runner environment, no network handles
      '--report-exclude-env',
      '--report-exclude-network',
      `--report-directory=${join(dir, 'node-reports')}`,
    ])
    expect(existsSync(join(dir, 'node-reports'))).toBe(true)
    // a built-in name would bypass createPoolWorker
    expect(d?.pool.name).not.toMatch(/^(forks|threads|vmForks|vmThreads|typescript|browser)$/)
    expect(workflow).not.toContain('NODE_OPTIONS')
    expect(workflow).not.toContain('--report-on-fatalerror')
  })

  it('names the exit code, signal and files when a worker exits unexpectedly', () => {
    const dir = scratchDir('ci-diagnostics-')
    const d = ciDiagnostics({ [CI_DIAGNOSTICS_ENV]: dir })
    const logger = { outputStream: process.stdout, errorStream: process.stderr }
    const worker = d!.pool.createPoolWorker({
      distPath: root,
      project: { vitest: { logger } },
      execArgv: [],
      env: {},
    } as unknown as PoolOptions)
    const fork = new EventEmitter() as EventEmitter & { pid: number, send: (m: unknown) => void }
    fork.pid = 4242
    fork.send = () => {}
    ;(worker as unknown as { _fork: unknown })._fork = fork
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })

    // a message shape Vitest might change must never break a worker's start
    worker.send({ __vitest_worker_request__: true, type: 'run' } as never)
    worker.send({
      __vitest_worker_request__: true,
      type: 'run',
      context: { files: [{ filepath: '/repo/test/dom/a.test.ts' }] },
    } as never)
    const onExit = vi.fn()
    worker.on('exit', onExit)
    fork.emit('exit', null, 'SIGKILL')

    expect(onExit).toHaveBeenCalledOnce()
    expect(written.join('')).toMatch(
      /^\[ci-diagnostics\] Vitest fork worker pid 4242 exited unexpectedly: code=null signal=SIGKILL free=\d+ MB of \d+ MB files=\/repo\/test\/dom\/a\.test\.ts\n$/,
    )
    expect(readFileSync(join(dir, 'worker-exits.log'), 'utf8')).toBe(written.join(''))

    // Vitest removes its listener before a requested stop: that exit stays silent
    worker.off('exit', onExit)
    expect(fork.listenerCount('exit')).toBe(0)
  })

  // Vitest's pool API is experimental: if an update stops calling worker.on('exit')
  // or renames _fork, this real run is what notices.
  it('prints the line from a real Vitest run whose worker is killed', () => {
    const dir = scratchDir('ci-diagnostics-')
    const env: NodeJS.ProcessEnv = { ...process.env, [CI_DIAGNOSTICS_ENV]: dir }
    for (const name of Object.keys(env)) if (name.startsWith('VITEST')) delete env[name]
    delete env.NODE_OPTIONS
    const run = spawnSync(process.execPath, [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--root',
      join(root, 'test', 'fixtures', 'ci-diagnostics-crash'),
    ], { cwd: root, env, encoding: 'utf8', timeout: 60_000 })
    const output = `${run.stdout}${run.stderr}`
    expect(run.error).toBeUndefined()
    expect(run.status, output).not.toBe(0)
    expect(output).toMatch(
      /\[ci-diagnostics\] Vitest fork worker pid \d+ exited unexpectedly: code=null signal=SIGKILL free=\d+ MB of \d+ MB files=\S*kills-its-worker\.fixture\.ts\n/,
    )
    expect(readFileSync(join(dir, 'worker-exits.log'), 'utf8')).toMatch(/ pid \d+ .* signal=SIGKILL /)
  }, 60_000)

  it('keeps the required check names and wraps only the full suite', () => {
    expect(workflow).toContain('    name: Node 24 / ${{ matrix.os }}\n')
    expect(workflow).toContain('        os: [ubuntu-latest, macos-14]\n')
    expect(workflow).not.toMatch(/^ {6}- run: npm test$/m)
    const run = step('Run the test suite with crash diagnostics')
    expect(run).toContain('        id: suite\n')
    expect(run).toContain(
      '          AGENT_INBOX_CI_DIAGNOSTICS_DIR: ${{ github.workspace }}/ci-diagnostics\n',
    )
    expect(run).toContain('/usr/bin/time -l npm test')
    expect(run).toContain('/usr/bin/time -v npm test')
    expect(run).not.toMatch(/^\s+if:|continue-on-error|\|\| true/m)
    expect(workflow.match(new RegExp(CI_DIAGNOSTICS_ENV, 'g'))).toHaveLength(1)
    expect(workflow.indexOf(step('Mark the start of the test suite')))
      .toBeLessThan(workflow.indexOf(run))
  })

  it('collects and uploads diagnostics only when the job fails', () => {
    // only when the suite itself failed: a failed typecheck pays no macOS wait
    const onSuiteFailure = "        if: failure() && steps.suite.outcome == 'failure'\n"
    const collect = step('Collect crash diagnostics')
    expect(collect).toContain(onSuiteFailure)
    expect(collect).toContain('-newer "$out/.started"')
    // a bounded poll for one report per SIGABRT/SIGSEGV/SIGBUS worker, never a fixed sleep
    expect(collect).toContain("grep -cE 'signal=(SIGABRT|SIGSEGV|SIGBUS) ' \"$exits\"")
    expect(collect).toContain('for i in $(seq 30); do')
    expect(collect).not.toMatch(/sleep (?!1$)\d+/m)
    expect(collect).toContain('echo "sudo dmesg unavailable: $kernel"')
    expect(collect).toContain("-name 'node*.ips' -o -name 'node*.crash'")
    expect(collect).toContain('sudo -n dmesg')
    const upload = step('Upload crash diagnostics')
    expect(upload).toContain(onSuiteFailure)
    expect(workflow).not.toMatch(/^\s+if: failure\(\)$/m)
    expect(upload).toContain(`uses: ${UPLOAD}`)
    expect(upload).toContain('          path: ci-diagnostics/\n')
    expect(upload).toContain('          if-no-files-found: ignore\n')
    // the only third-party actions are the ones the repository already pins
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1])
    expect(new Set(uses)).toEqual(new Set([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
      'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
    ]))
  })
})
