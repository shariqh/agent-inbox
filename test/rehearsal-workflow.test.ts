// test/rehearsal-workflow.test.ts — the hosted-runner rehearsal workflow (#381).
//
// .github/workflows/rehearsal-runners.yml runs the #344 harness's three runs on GitHub's
// macos-15-intel runner, and under Rosetta on macos-15, against the published 1.x-last
// installed from its real DMG. Its boundary is checked here: started by hand only,
// read-only, no secrets, inputs only through env, each DMG checked before it is mounted,
// and --hosted-runner on every harness run so every report says what it is. Its harness
// command and its two result scripts run here as written, so a run that failed, or never
// ran, can never add up to PASS.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeScratchDirs, scratchDir } from './scratch.js'

const ROOT = resolve(import.meta.dirname, '..')
const LINES = readFileSync(join(ROOT, '.github', 'workflows', 'rehearsal-runners.yml'), 'utf8').split('\n')
const ALL_PASSED = { run1: 'HANDED OFF', verify: 'PASS', run2: 'PASS', run3: 'PASS' }

const indentOf = (line: string): number => line.match(/^ */)?.[0].length ?? 0
const isContent = (line: string): boolean => line.trim() !== '' && !line.trim().startsWith('#')

/** The lines under the line at `at`: those indented deeper, up to the next sibling. */
function blockAt(at: number): string[] {
  const indent = indentOf(LINES[at]!)
  const end = LINES.findIndex((line, index) => index > at && isContent(line) && indentOf(line) <= indent)
  return LINES.slice(at + 1, end < 0 ? undefined : end)
}

function lineOf(text: string): number {
  const at = LINES.findIndex((line) => line.trim() === text)
  expect(at, `the workflow has a line "${text}"`).toBeGreaterThanOrEqual(0)
  return at
}

/** A step, from its `- name:` line to the next step. */
function step(name: string): string[] {
  const at = lineOf(`- name: ${name}`)
  return [LINES[at]!, ...blockAt(at)]
}

/** The script of a `run: |` block that starts at `at`, dedented as the runner sees it. */
function scriptAt(at: number): string {
  const body: string[] = []
  let indent = -1
  for (const line of LINES.slice(at + 1)) {
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (indent < 0) indent = indentOf(line)
    if (indentOf(line) < indent) break
    body.push(line.slice(indent))
  }
  return `${body.join('\n').trimEnd()}\n`
}

function script(name: string): string {
  const at = lineOf(`- name: ${name}`)
  const run = LINES.findIndex((line, index) => index > at && line.trim() === 'run: |')
  expect(blockAt(at), `"${name}" has a run: | block`).toContain(LINES[run])
  return scriptAt(run)
}

/** Runs a script the way the runner does (bash -e), in a scratch folder. */
function bash(text: string, env: Record<string, string>, cwd: string) {
  const file = join(cwd, `script-${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(file, text)
  return spawnSync('bash', ['--noprofile', '--norc', '-e', file], {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  })
}

/** A file a script's run appends its step summary to, new for each run. */
const summaryFile = (scratch: string): string => join(scratch, `summary-${Math.random().toString(36).slice(2)}.md`)

afterEach(removeScratchDirs)

describe('the hosted-runner rehearsal workflow (#381)', () => {
  it('is started by hand only, reads the repository, and holds no secret', () => {
    const triggers = blockAt(lineOf('on:')).filter((line) => isContent(line) && indentOf(line) === 2)
    expect(triggers).toEqual(['  workflow_dispatch:'])

    const permissions = LINES.flatMap((line, index) => (/^\s*permissions:/.test(line) ? [index] : []))
    expect(permissions).toEqual([lineOf('permissions:')])
    expect(indentOf(LINES[permissions[0]!]!)).toBe(0)
    expect(blockAt(permissions[0]!).filter(isContent)).toEqual(['  contents: read'])

    expect(LINES.filter((line) => /\bsecrets\b/.test(line) && isContent(line))).toEqual([])
    // The job's own read-only token, for GitHub's API rate limit, and nothing else
    for (const line of LINES.filter((candidate) => candidate.includes('github.token'))) {
      expect(line).toMatch(/^\s+GITHUB_TOKEN: \$\{\{ github\.token \}\}$/)
    }
  })

  it('hands its inputs to scripts only through env', () => {
    const runs = LINES.flatMap((line, index) => (line.trim() === 'run: |' ? [index] : []))
    expect(runs.length).toBeGreaterThan(5)
    for (const at of runs) expect(scriptAt(at), `the run: | block at line ${at + 1}`).not.toContain('${{')
    expect(LINES.filter((line) => /^\s*(?:- )?run: (?!\|$)/.test(line))).toEqual([])
    for (const line of LINES.filter((candidate) => /\binputs\./.test(candidate))) {
      expect(line).toMatch(/^\s+[A-Z][A-Z0-9_]*: \$\{\{ inputs\.(?:last|older) \}\}$/)
    }
  })

  it('runs on the Intel runner natively and on the Apple silicon runner under Rosetta', () => {
    const matrix = blockAt(lineOf('include:')).map((line) => line.trim())
    expect(matrix).toEqual([
      '- host: Intel', 'key: intel', 'runner: macos-15-intel', 'rosetta: false',
      '- host: Rosetta', 'key: rosetta', 'runner: macos-15', 'rosetta: true',
    ])
    expect(script('Write the harness command')).toContain(
      'exec env ELECTRON_RUN_AS_NODE=1 /usr/bin/arch -x86_64 "$electron" "$harness" "$@"',
    )
  })

  it("runs the harness under the installed app's own Electron in Node mode", () => {
    const scratch = scratchDir('agent-inbox-rehearsal-workflow-')
    const app = join(scratch, 'Applications', 'Agent Inbox.app')
    const electron = join(app, 'Contents', 'MacOS', 'Agent Inbox')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(electron, '#!/bin/sh\nprintf "%s\\n" "ELECTRON_RUN_AS_NODE=$ELECTRON_RUN_AS_NODE" "$@"\n')
    chmodSync(electron, 0o755)
    expect(bash(script('Write the harness command'), { RUNNER_TEMP: scratch }, scratch).status).toBe(0)

    const harness = spawnSync(join(scratch, 'harness'), ['--run', '1', '--older-app', '/Users/runner/Old copy/Agent Inbox.app'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', APP: app, ROSETTA: 'false', GITHUB_WORKSPACE: ROOT },
      encoding: 'utf8',
    })
    expect(harness.status).toBe(0)
    expect(harness.stdout.split('\n')).toEqual([
      'ELECTRON_RUN_AS_NODE=1',
      join(ROOT, 'test', 'rehearsal', 'rehearsal.cjs'),
      '--run', '1', '--older-app', '/Users/runner/Old copy/Agent Inbox.app',
      '',
    ])
  })

  it('checks each published DMG against SHA256SUMS.txt and its signed manifest before mounting it', () => {
    const check = lineOf('- name: Download the published DMGs and check them')
    expect(script('Download the published DMGs and check them')).toContain(
      'node test/rehearsal/published-dmg.cjs "$folder" "$version"',
    )
    const attaches = LINES.flatMap((line, index) => (line.includes('hdiutil attach') ? [index] : []))
    expect(attaches).toHaveLength(2)
    for (const at of attaches) {
      expect(at).toBeGreaterThan(check)
      expect(LINES[at]).toContain('hdiutil attach -readonly -nobrowse -noautoopen')
    }
  })

  it('passes --hosted-runner to every harness run, and run 1 --verify follows only its hand-off', () => {
    const calls = LINES.flatMap((line, index) => (line.trim().startsWith('"$RUNNER_TEMP/harness" ') ? [index] : []))
    const commands = calls.map((at) => {
      const line = LINES[at]!.trim()
      return line.endsWith('\\') ? `${line.slice(0, -1).trimEnd()} ${LINES[at + 1]!.trim()}` : line
    })
    expect(commands.map((command) => command.match(/--run \S+(?: --verify)?/)?.[0])).toEqual([
      '--run 2', '--run 3', '--run 1', '--run 1 --verify',
    ])
    for (const command of commands) expect(command).toContain(' --hosted-runner ')
    expect(commands[2]).toContain('--older-app "$HOME/Rehearsal/Older/Agent Inbox.app" --test-account')
    expect(step('Run 1, verify').map((line) => line.trim())).toContain("if: steps.run1.outputs.exit == '3'")
  })

  it('uploads every report and its result, whatever happened', () => {
    expect(step('Results').map((line) => line.trim())).toContain('if: always()')
    const upload = lineOf('- uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2')
    const lines = blockAt(upload).map((line) => line.trim())
    expect(lines).toContain('if: always()')
    for (const path of ['report-*.txt', 'logs/*.txt', 'run-1.json', 'run-1-*/helper-result.json', 'results.json']) {
      expect(lines).toContain(`\${{ runner.temp }}/rehearsal/${path}`)
    }
    const result = blockAt(lineOf('result:')).map((line) => line.trim())
    expect(result).toContain('needs: rehearse')
    expect(result).toContain('if: always()')
  })
})

describe("the hosted-runner workflow's result (#381)", () => {
  type Codes = { RUN1?: string, VERIFY?: string, RUN2?: string, RUN3?: string }

  function results(scratch: string, host: string, codes: Codes) {
    const work = join(scratch, 'results', `rehearsal-${host.toLowerCase()}`)
    const summary = summaryFile(scratch)
    const ran = bash(script('Results'), {
      HOST: host,
      WORK: work,
      RUNNER_TEMP: scratch,
      GITHUB_STEP_SUMMARY: summary,
      RUN1: codes.RUN1 ?? '',
      VERIFY: codes.VERIFY ?? '',
      RUN2: codes.RUN2 ?? '',
      RUN3: codes.RUN3 ?? '',
    }, scratch)
    return {
      status: ran.status,
      result: JSON.parse(readFileSync(join(work, 'results.json'), 'utf8')) as Record<string, string>,
      summary: readFileSync(summary, 'utf8'),
    }
  }

  function combined(scratch: string) {
    const summary = summaryFile(scratch)
    const ran = bash(script('Every run on every host'), {
      LAST: '1.8.0',
      REPORTS: 'https://github.com/shariqh/agent-inbox/actions/runs/1#artifacts',
      GITHUB_STEP_SUMMARY: summary,
    }, scratch)
    return { status: ran.status, summary: readFileSync(summary, 'utf8') }
  }

  it('passes a host only when run 1 handed off, its --verify passed, and runs 2 and 3 passed', () => {
    const scratch = scratchDir('agent-inbox-rehearsal-results-')
    const { status, result, summary } = results(scratch, 'Intel', { RUN1: '3', VERIFY: '0', RUN2: '0', RUN3: '0' })
    expect(status).toBe(0)
    expect(result).toEqual({ host: 'Intel', ...ALL_PASSED })
    expect(summary).toContain('### Intel: hosted-runner evidence, not the human gate')
    expect(summary).toContain('| HANDED OFF | PASS | PASS | PASS |')
  })

  it.each([
    ['run 1 install step that claims a pass', { RUN1: '0', VERIFY: '0', RUN2: '0', RUN3: '0' }, { run1: 'FAIL (exit 0)' }],
    ['--verify that never ran', { RUN1: '3', RUN2: '0', RUN3: '0' }, { verify: 'not run' }],
    ['failed --verify', { RUN1: '3', VERIFY: '1', RUN2: '0', RUN3: '0' }, { verify: 'FAIL (exit 1)' }],
    ['refused run 1', { RUN1: '2', RUN2: '0', RUN3: '0' }, { run1: 'FAIL (exit 2)', verify: 'not run' }],
    ['failed run 2', { RUN1: '3', VERIFY: '0', RUN2: '1', RUN3: '0' }, { run2: 'FAIL (exit 1)' }],
    ['failed run 3', { RUN1: '3', VERIFY: '0', RUN2: '0', RUN3: '1' }, { run3: 'FAIL (exit 1)' }],
    ['job that stopped before any run', {}, { run1: 'not run', verify: 'not run', run2: 'not run', run3: 'not run' }],
  ])('fails a host with a %s', (_, codes, outcome) => {
    const scratch = scratchDir('agent-inbox-rehearsal-results-')
    const { status, result } = results(scratch, 'Rosetta', codes)
    expect(status).not.toBe(0)
    expect(result).toEqual({ host: 'Rosetta', ...ALL_PASSED, ...outcome })
  })

  it('passes only when both hosts passed every run', () => {
    const scratch = scratchDir('agent-inbox-rehearsal-results-')
    results(scratch, 'Intel', { RUN1: '3', VERIFY: '0', RUN2: '0', RUN3: '0' })
    results(scratch, 'Rosetta', { RUN1: '3', VERIFY: '0', RUN2: '0', RUN3: '0' })
    const passed = combined(scratch)
    expect(passed.status).toBe(0)
    expect(passed.summary).toContain('## Rehearsal of 1.x-last v1.8.0 on hosted runners: PASS')
    expect(passed.summary).toContain('| Intel | HANDED OFF | PASS | PASS | PASS |')
    expect(passed.summary).toContain('| Rosetta | HANDED OFF | PASS | PASS | PASS |')

    results(scratch, 'Rosetta', { RUN1: '3', VERIFY: '1', RUN2: '0', RUN3: '0' })
    const failed = combined(scratch)
    expect(failed.status).not.toBe(0)
    expect(failed.summary).toContain('## Rehearsal of 1.x-last v1.8.0 on hosted runners: FAIL')
    expect(failed.summary).not.toContain('PASS\n')
    expect(failed.summary).toContain('| Rosetta | HANDED OFF | FAIL (exit 1) | PASS | PASS |')
  })

  it('fails when a host left no result', () => {
    const scratch = scratchDir('agent-inbox-rehearsal-results-')
    results(scratch, 'Intel', { RUN1: '3', VERIFY: '0', RUN2: '0', RUN3: '0' })
    const missing = combined(scratch)
    expect(missing.status).not.toBe(0)
    expect(missing.summary).toContain('## Rehearsal of 1.x-last v1.8.0 on hosted runners: FAIL')
    expect(missing.summary).toContain('| rosetta | no result | no result | no result | no result |')
  })
})
