// test/hooks-runtime.ts — real Agent Inbox runtimes in a scratch HOME, for
// Setup's Claude hooks target (#206) and its runtime prune (#294).
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
//
// Each runtime carries the REAL scripts/install-hooks.sh, prune-runtimes.sh,
// setup-lock.sh, runtime-config.mjs and runtime-payload.mjs, a bin/node that
// execs the Node running the tests, and a dist/hook-cli.js stub whose selftest passes. It is
// manifested for THIS host exactly as scripts/runtime-payload.mjs manifests a
// release payload, so electron/runtime-verify.cjs verifies it as one. The
// scratch HOME holds ~/.agent-inbox/runtime, the setup lock and
// ~/.claude/settings.json: nothing here reads or writes the real home. The
// HOMEs and staging folders are scratch directories (./scratch.ts), so a file
// using these helpers calls removeScratchDirs() from its afterEach.
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const PAYLOAD_CLI = join(REPO, 'scripts', 'runtime-payload.mjs')
const SCRIPTS = [
  'install-agents.sh',
  'install-hooks.sh',
  'prune-runtimes.sh',
  'runtime-payload.mjs',
  'runtime-config.mjs',
  'runtime-pins.mjs',
  'setup-filesystem.cjs',
  'setup-lock.sh',
  'run-isolated.mjs',
]
// What install-agents.sh renders into the instruction files, for a runtime it runs from.
const INSTRUCTION_DOCS = ['reporting-snippet.md', 'instructions/claude-code.md', 'instructions/copilot-cli.md']

export interface HooksHome {
  home: string
  runtimeRoot: string
  settings: string
  /** the scratch HOME, a minimal PATH with the setup lock tool, and no AGENT_INBOX_* override from the test runner */
  env: NodeJS.ProcessEnv
}

export interface StagedRuntime {
  dir: string
  runtimeId: string
  digest: string
  version: string
}

export function hooksHome(): HooksHome {
  const home = scratchDir('hooks-home-')
  // The shared setup lock needs lockf or flock. Before macOS 15 there is no
  // /usr/bin/lockf, and CI installs flock with Homebrew, so the one this
  // runner has is linked onto the scratch PATH.
  const lock = spawnSync('/bin/sh', ['-c', 'command -v lockf || command -v flock'], { encoding: 'utf8' }).stdout.trim()
  if (!lock) throw new Error('hooks runtime tests require lockf or flock')
  const bin = join(home, 'bin')
  mkdirSync(bin)
  symlinkSync(lock, join(bin, basename(lock)))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` }
  for (const name of Object.keys(env)) if (name.startsWith('AGENT_INBOX_')) delete env[name]
  return {
    home,
    runtimeRoot: join(home, '.agent-inbox', 'runtime'),
    settings: join(home, '.claude', 'settings.json'),
    env,
  }
}

/** Write a runtime of `version` for this host at `dir` and manifest it; `docs` lets install-agents.sh run from it too. */
export function stageRuntime(dir: string, version: string, { docs = false } = {}): StagedRuntime {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`)
  chmodSync(join(dir, 'bin', 'node'), 0o755)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'hook-cli.js'), "if (process.argv[2] === 'selftest') process.stdout.write('ok\\n')\n")
  writeFileSync(join(dir, 'dist', 'mcp-server.js'), 'process.exit(0)\n')
  writeFileSync(join(dir, 'dist', 'watch-cli.js'), 'process.exit(0)\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  for (const script of SCRIPTS) copyFileSync(join(REPO, 'scripts', script), join(dir, 'scripts', script))
  if (docs) {
    for (const doc of INSTRUCTION_DOCS) {
      mkdirSync(dirname(join(dir, 'docs', doc)), { recursive: true })
      copyFileSync(join(REPO, 'docs', doc), join(dir, 'docs', doc))
    }
  }
  const manifest = JSON.parse(execFileSync(process.execPath, [
    PAYLOAD_CLI, 'manifest',
    '--root', dir,
    '--product', 'agent-inbox-runtime',
    '--package-version', version,
    '--source-commit', 'deadbeef',
    '--platform', process.platform,
    '--arch', process.arch,
    '--node-version', process.version,
    '--node-modules-abi', process.versions.modules,
    '--entrypoint', 'dist/mcp-server.js',
    '--entrypoint', 'dist/hook-cli.js',
    '--entrypoint', 'dist/watch-cli.js',
  ], { encoding: 'utf8' })) as { runtimeId: string }
  const digest = createHash('sha256').update(readFileSync(join(dir, 'runtime-manifest.json'))).digest('hex')
  return { dir, runtimeId: manifest.runtimeId, digest: `sha256:${digest}`, version }
}

/** Install `staged` under the scratch runtime root exactly as the installer lays it out: a byte-identical copy at <root>/<runtimeId>. */
export function installStaged(h: HooksHome, staged: StagedRuntime): StagedRuntime {
  const dir = join(h.runtimeRoot, staged.runtimeId)
  mkdirSync(dirname(dir), { recursive: true })
  cpSync(staged.dir, dir, { recursive: true })
  return { ...staged, dir }
}

/** Stage a runtime of `version` in a scratch folder and install it. */
export function installRuntime(h: HooksHome, version: string): StagedRuntime {
  return installStaged(h, stageRuntime(join(scratchDir('hooks-staged-'), 'payload'), version))
}

/** Every agent-inbox hook launcher in the scratch settings file, as {command, entry}. */
export function hookLaunchers(h: HooksHome): Array<{ command: string; entry: string }> {
  const settings = JSON.parse(readFileSync(h.settings, 'utf8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; args?: string[] }> }>>
  }
  return Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((group) => group.hooks ?? []))
    .filter((hook) => Array.isArray(hook.args) && typeof hook.args[0] === 'string' && hook.args[0].endsWith('/dist/hook-cli.js'))
    .map((hook) => ({ command: hook.command ?? '', entry: hook.args![0]! }))
}
