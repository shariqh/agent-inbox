// test/host-config-secrets.test.ts — a host config that cannot be read is
// named, never quoted (issue #337).
//
// ~/.claude.json, ~/.copilot/mcp-config.json and ~/.claude/settings.json often
// hold other MCP servers' API tokens in `env` blocks. Since Node 20 a
// JSON.parse error quotes the text around the failure, and jq quotes the value
// it fails on, so a reader that passed either message on would print part of a
// secret to a terminal or to the Setup panel. Each reader says instead which
// file and what kind of failure, and of a failed read only its error code.
//
// READERS is every reader of those files, run as a human or Setup runs it,
// over every config in BROKEN, each of which puts a fake token where the
// parser quotes it. A new reader is one more row.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { hooksHome, installRuntime, stageRuntime } from './hooks-runtime.js'
import type { HooksHome, StagedRuntime } from './hooks-runtime.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const CONFIG_CLI = join(REPO, 'scripts', 'runtime-config.mjs')

// The fake token. V8 quotes ten characters on either side of the failure and
// jq the first few of a value, so each broken config below puts the token's
// head where its parser or jq quotes it.
const SECRET = 'sk-TEST-LEAK-1234567890'
const HEAD = SECRET.slice(0, 5)
const NOT_JSON = 'is not valid JSON'
// Versions no other test file stages: runtime ids are derived from content.
const OLD = '1.2.2-r337'
const APP = '1.7.0-r337'

afterEach(removeScratchDirs)

interface Fixture extends HooksHome {
  claude: string
  copilot: string
  /** a runtime in the runtime root: the prune gate reads the host configs only when it has one to check */
  old: StagedRuntime
}

interface Broken {
  name: string
  /** the fixed words a reader uses for it */
  kind: string
  arrange: (file: string) => void
}

const BROKEN: Broken[] = [
  {
    name: 'is not valid JSON',
    kind: NOT_JSON,
    // an unquoted value: V8 quotes `"API_KEY":sk-TEST-LE`
    arrange: (file) => writeFileSync(file, `{"mcpServers":{"other":{"command":"node","env":{"API_KEY":${SECRET}}}}}`),
  },
  {
    // a source checkout's jq check passes it on to runtime-config.mjs
    name: 'holds a NaN, which jq accepts and JSON.parse refuses',
    kind: NOT_JSON,
    // under 21 characters, so V8 quotes all of it
    arrange: (file) => writeFileSync(file, `{"${SECRET.slice(0, 12)}":NaN}`),
  },
  // a failed read's own message names the path alone; its code keeps one format
  ...(process.getuid?.() === 0 ? [] : [{
    name: 'cannot be read',
    kind: 'is unreadable (EACCES)',
    arrange: (file: string) => {
      writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'node', env: { API_KEY: SECRET } } } }))
      chmodSync(file, 0o000)
    },
  }]),
]

function fixture(arrange: (file: string) => void, files: (f: Fixture) => string[] = (f) => [f.claude, f.copilot, f.settings]): Fixture {
  const h = hooksHome()
  const f: Fixture = { ...h, claude: join(h.home, '.claude.json'), copilot: join(h.home, '.copilot', 'mcp-config.json'), old: installRuntime(h, OLD) }
  for (const file of files(f)) {
    mkdirSync(dirname(file), { recursive: true })
    arrange(file)
  }
  return f
}

interface Output {
  /** the exit status, or the viewer's HTTP status */
  status: number | null
  /** stdout and stderr, or the response body */
  text: string
}

function run(f: Fixture, command: string, args: string[], env: NodeJS.ProcessEnv = {}): Output {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...f.env, ...env } })
  if (result.error) throw result.error
  return { status: result.status, text: `${result.stdout}${result.stderr}` }
}

const config = (f: Fixture, ...args: string[]): Output => run(f, process.execPath, [CONFIG_CLI, ...args])

// A host CLI that says agent-inbox is registered in user scope when
// FAKE_REGISTERED is set, and changes nothing.
const HOST_CLI = `#!/bin/sh
case "$1:$2" in
  mcp:get)
    [ -n "\${FAKE_REGISTERED:-}" ] || exit 1
    if [ "$(basename "$0")" = claude ]; then echo 'Scope: User config'; else echo '{"source":"user"}'; fi
    ;;
  *) exit 9 ;;
esac
`

function installAgents(f: Fixture, script: string, args: string[], env: NodeJS.ProcessEnv = {}): Output {
  const fakebin = join(f.home, 'fakebin')
  const tmp = join(f.home, 'tmp')
  mkdirSync(fakebin, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  for (const name of ['claude', 'copilot']) {
    writeFileSync(join(fakebin, name), HOST_CLI)
    chmodSync(join(fakebin, name), 0o755)
  }
  const stub = join(f.home, 'stub-entry.js')
  writeFileSync(stub, 'process.exit(0)\n')
  return run(f, '/bin/bash', [script, ...args], {
    PATH: `${fakebin}:${f.env['PATH']}`,
    TMPDIR: tmp,
    AGENT_INBOX_NODE: process.execPath,
    AGENT_INBOX_MCP_ENTRY: stub,
    AGENT_INBOX_SELFTEST_ENTRY: stub,
    ...env,
  })
}

// A source checkout's install-hooks.sh: jq merges, runtime-config.mjs sorts the entries.
function checkoutHooks(f: Fixture, args: string[] = []): Output {
  const entry = join(f.home, 'stub-hook-cli.js')
  writeFileSync(entry, 'process.exit(0)\n')
  return run(f, '/bin/bash', [join(REPO, 'scripts', 'install-hooks.sh'), ...args], {
    AGENT_INBOX_HOOK_ENTRY: entry,
    AGENT_INBOX_NODE: process.execPath,
    // and jq, wherever this machine keeps it
    PATH: `${f.env['PATH']}:${process.env['PATH']}`,
  })
}

interface Reader {
  name: string
  run: (f: Fixture) => Output | Promise<Output>
  /** what it says about the broken config, which proves it read it */
  says: (f: Fixture, kind: string) => string
  /** its exit status (the viewer's HTTP status), the same as before #337 */
  status: number
}

const READERS: Reader[] = [
  {
    name: 'runtime-config.mjs registration (the installers\' ownership gate)',
    run: (f) => config(f, 'registration', '--file', f.claude, '--runtime-root', f.runtimeRoot),
    says: (f, kind) => `"reason":"${f.claude} ${kind}"`,
    status: 0,
  },
  {
    name: 'runtime-config.mjs references (the installer\'s prune gate)',
    run: (f) => config(f, 'references', '--runtime-root', f.runtimeRoot, '--runtime-id', f.old.runtimeId, '--home', f.home),
    says: (_f, kind) => `"reason":"${kind}"`,
    status: 0,
  },
  {
    name: 'runtime-config.mjs unused (prune-runtimes.sh\'s gate)',
    run: (f) => config(f, 'unused', '--runtime-root', f.runtimeRoot, '--home', f.home),
    says: (f, kind) => `${f.claude} ${kind}`,
    status: 0,
  },
  {
    name: 'runtime-config.mjs hooks',
    run: (f) => config(f, 'hooks', '--settings', f.settings, '--node', join(f.old.dir, 'bin', 'node'),
      '--entry', join(f.old.dir, 'dist', 'hook-cli.js'), '--runtime-root', f.runtimeRoot),
    says: (f, kind) => `runtime-config: ${f.settings} ${kind} — refusing to touch it\n`,
    status: 1,
  },
  {
    name: 'runtime-config.mjs foreign-hooks',
    run: (f) => config(f, 'foreign-hooks', '--settings', f.settings, '--entry', join(f.home, 'dist', 'hook-cli.js'),
      '--runtime-root', f.runtimeRoot),
    says: (f, kind) => `runtime-config: ${f.settings} ${kind} — refusing to touch it\n`,
    status: 1,
  },
  {
    name: 'runtime-config.mjs merge-json',
    run: (f) => config(f, 'merge-json', '--file', f.claude, '--patch', '{}'),
    says: (f, kind) => `runtime-config: ${f.claude} ${kind} — refusing to touch it\n`,
    status: 1,
  },
  {
    name: 'install-agents.sh (dry run)',
    run: (f) => installAgents(f, join(REPO, 'scripts', 'install-agents.sh'), []),
    says: () => 'dry run: nothing was written or registered',
    status: 0,
  },
  {
    name: 'install-agents.sh --apply, with nothing registered',
    run: (f) => installAgents(f, join(REPO, 'scripts', 'install-agents.sh'), ['--apply']),
    says: () => 'could not determine whether claude has a user-scoped agent-inbox registration',
    status: 1,
  },
  {
    name: 'install-agents.sh --apply --force, over a registration',
    run: (f) => installAgents(f, join(REPO, 'scripts', 'install-agents.sh'), ['--apply', '--force'], { FAKE_REGISTERED: '1' }),
    says: (f) => `install-agents: ${f.claude} does not contain a readable agent-inbox registration`,
    status: 1,
  },
  {
    name: 'install-agents.sh --apply --target claude, as Setup runs it from a runtime payload',
    run: (f) => {
      const payload = stageRuntime(join(scratchDir('secrets-payload-'), 'payload'), APP, { docs: true })
      return installAgents(f, join(payload.dir, 'scripts', 'install-agents.sh'),
        ['--apply', '--target', 'claude', '--runtime-source', payload.dir, '--runtime-digest', payload.digest],
        { FAKE_REGISTERED: '1' })
    },
    says: () => 'refusing to replace or remove the claude registration because it is unknown',
    status: 1,
  },
  {
    name: 'install-hooks.sh from a runtime (dry run)',
    run: (f) => run(f, '/bin/bash', [join(f.old.dir, 'scripts', 'install-hooks.sh')]),
    says: (f, kind) => `${f.settings} ${kind} — refusing to touch it`,
    status: 1,
  },
  {
    name: 'install-hooks.sh --apply --move-only, as Setup moves Claude\'s hooks',
    run: (f) => run(f, '/bin/bash', [join(f.old.dir, 'scripts', 'install-hooks.sh'), '--apply', '--move-only']),
    says: (f, kind) => `${f.settings} ${kind} — refusing to touch it`,
    status: 1,
  },
  {
    name: 'install-hooks.sh from a source checkout (dry run)',
    run: (f) => checkoutHooks(f),
    // jq or runtime-config.mjs refuses what will not parse; cat, what it cannot read
    says: (f, kind) => (kind === NOT_JSON ? `${f.settings} ${NOT_JSON} — refusing to touch it` : `could not read ${f.settings} — refusing to touch it`),
    status: 1,
  },
  {
    name: 'prune-runtimes.sh (dry run)',
    run: (f) => run(f, '/bin/bash', [join(installRuntime(f, APP).dir, 'scripts', 'prune-runtimes.sh')]),
    says: (f, kind) => `prune-runtimes: ${f.claude} ${kind}`,
    status: 1,
  },
  {
    name: 'GET /api/setup, which the Setup panel shows',
    run: async (f) => {
      const viewer = createViewer(openDb(join(scratchDir('secrets-db-'), 'inbox.db')), {
        setupInfoPath: join(f.home, 'no-setup-info.json'),
        agentHome: f.home,
        runtimeRoot: f.runtimeRoot,
      })
      const response = await viewer.request('/api/setup')
      return { status: response.status, text: await response.text() }
    },
    says: (_f, kind) => `"reason":"${kind}"`,
    status: 200,
  },
]

describe.each(BROKEN)('a host config that $name (#337)', (broken) => {
  it.each(READERS)('$name names it, never quotes it', async (reader) => {
    const f = fixture(broken.arrange)

    const out = await reader.run(f)

    expect(out.text).toContain(reader.says(f, broken.kind))
    expect(out.status, out.text).toBe(reader.status)
    expect(out.text).not.toContain(HEAD)
  })
})

// Valid JSON whose hooks are not the shape Claude Code writes. A source
// checkout merges settings.json with jq, and jq quotes the value it fails on:
// the first three fail its strip step that way, the last two its count and
// merge steps without a value. None of jq's own words reach the output.
describe('install-hooks.sh from a source checkout, over hooks of another shape (#337)', () => {
  const SHAPES: Array<[string, unknown, string[]]> = [
    ['an event that is not a list', { hooks: { Stop: SECRET } }, []],
    ['a group whose hooks are not a list', { hooks: { Stop: [{ hooks: SECRET }] } }, []],
    ['a hook command that is not a string, with --migrate', { hooks: { Stop: [{ hooks: [{ command: [SECRET], args: [] }] }] } }, ['--migrate']],
    ['a group that is not an object', { hooks: { Stop: [SECRET] } }, []],
    ['hooks that are not an object', { hooks: SECRET }, []],
  ]

  it.each(SHAPES)('names the file, never quotes it: %s', (_label, settings, flags) => {
    const f = fixture((file) => writeFileSync(file, JSON.stringify(settings)), (f) => [f.settings])

    const out = checkoutHooks(f, flags)

    expect(out.text).toContain(`install-hooks: could not merge the agent-inbox hooks into ${f.settings} — nothing was written`)
    expect(out.status).toBe(1)
    expect(out.text).not.toContain('jq: error')
    expect(out.text).not.toContain(HEAD)
  })
})
