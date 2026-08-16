#!/usr/bin/env node
// Stage a portable runtime payload — issue #74, Layer 1.
//
// This assembles the tree that installRuntime() (see runtime-payload.mjs)
// will later copy into a runtime root: a real Node 24 binary for the target
// platform/arch, this project's production node_modules installed (WITH
// lifecycle scripts — better-sqlite3's native binding has to be built) from
// the EXACT repo lockfile, the built dist/, and the install scripts + docs
// the staged runtime needs to register itself with a host agent. Before any
// of that is pinned under a manifest, `bin/node dist/hook-cli.js selftest`
// is run against the staged tree itself, proving the exact staged Node +
// better-sqlite3 combination actually loads — the same gate
// install-hooks.sh already applies to a resolved host Node, applied here to
// what this script is about to ship. Only then is the manifest generated,
// verified, and the tree atomically published.
//
// There is no caller wiring yet (no packaging step invokes this): it is a
// robust, standalone CLI that can be exercised against a real local Node 24
// distribution (e.g. one already installed by fnm) without requiring a real
// cross-arch (x64-on-arm64) build to validate its structure.
//
//   node scripts/stage-runtime.mjs \
//     --node-root ~/.local/share/fnm/node-versions/v24.18.0/installation \
//     --platform darwin --arch arm64 \
//     --output build/runtime/darwin-arm64 \
//     [--repo-root <dir>] [--package-version <v>] [--source-commit <sha>] \
//     [--check-only] [--force]
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest, copyTreePreservingMode, isMainModule, verifyPayload, writeManifestFile } from './runtime-payload.mjs'

const PRODUCT = 'agent-inbox-runtime'
const SUPPORTED_PLATFORM = 'darwin'
const SUPPORTED_ARCHES = ['arm64', 'x64']
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..')

export class StageRuntimeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StageRuntimeError'
  }
}

// ── Node-root validation ───────────────────────────────────────────────
// Runs the DISTRIBUTION's own node binary (never ambient `node`) to ask it,
// authoritatively, what it actually is — a claimed --platform/--arch on the
// command line proves nothing about the bits actually staged from.
export function probeNodeDistribution(nodeRoot) {
  const nodeBin = join(nodeRoot, 'bin', 'node')
  if (!existsSync(nodeBin)) {
    throw new StageRuntimeError(`no node binary at ${nodeBin} — is --node-root a Node distribution root?`)
  }
  try {
    const stdout = execFileSync(
      nodeBin,
      [
        '-e',
        'process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch,'
          + 'version:process.version,modulesAbi:process.versions.modules}))',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
    )
    return { nodeBin, ...JSON.parse(stdout) }
  } catch (err) {
    throw new StageRuntimeError(`failed to run ${nodeBin} to probe the distribution: ${err.message}`)
  }
}

/**
 * Validate that --node-root really is Node 24 for the requested
 * --platform/--arch. Throws StageRuntimeError with a specific reason
 * otherwise; never guesses.
 */
export function validateNodeDistribution({ nodeRoot, platform, arch }) {
  if (platform !== SUPPORTED_PLATFORM) {
    throw new StageRuntimeError(`unsupported --platform: ${platform} (only ${SUPPORTED_PLATFORM} is supported)`)
  }
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new StageRuntimeError(`unsupported --arch: ${arch} (must be one of ${SUPPORTED_ARCHES.join(', ')})`)
  }
  const probe = probeNodeDistribution(nodeRoot)
  const major = Number(String(probe.version).replace(/^v/, '').split('.')[0])
  if (major !== 24) {
    throw new StageRuntimeError(`--node-root is Node ${probe.version}, but the runtime requires Node 24`)
  }
  if (probe.platform !== platform || probe.arch !== arch) {
    throw new StageRuntimeError(
      `--node-root's own binary reports ${probe.platform}/${probe.arch}, not the requested ${platform}/${arch}`,
    )
  }
  return probe
}

/**
 * The distribution's OWN npm CLI script — always invoked as
 * `nodeBin npmCli ...args`, never through PATH or a shebang, so ambient npm
 * is never used to install this runtime's dependencies.
 */
export function resolveNpmCli(nodeRoot) {
  const npmCli = join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCli)) {
    throw new StageRuntimeError(`no npm CLI found at ${npmCli} — --node-root does not look like a full Node distribution`)
  }
  return npmCli
}

/**
 * A minimal, production-only ESM package.json: name/version/deps/bin carried
 * over so it stays exactly in sync with the repo's own lockfile, with every
 * dev-only field (scripts, devDependencies, ...) stripped — except
 * `allowScripts`, which IS carried over: staging deliberately runs `npm ci`
 * WITH lifecycle scripts enabled (better-sqlite3's postinstall build step
 * has to run, or its native binding is never produced — see stageInto()),
 * and the repo's own `allowScripts` allow-list is the one piece of config
 * that says exactly which packages are trusted to do that. Carrying it into
 * the staged package.json keeps that trust boundary visible in the shipped
 * artifact rather than silently dropping it.
 */
export function buildRuntimePackageJson(repoPkg) {
  const pkg = {
    name: repoPkg.name,
    productName: PRODUCT,
    version: repoPkg.version,
    private: true,
    type: 'module',
    engines: { node: '>=24' },
    main: 'dist/mcp-server.js',
    bin: repoPkg.bin,
    dependencies: repoPkg.dependencies,
  }
  if (repoPkg.allowScripts) pkg.allowScripts = repoPkg.allowScripts
  return pkg
}

function bestEffortSourceCommit(repoRoot) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim()
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined
  } catch {
    return undefined // no git, not a checkout, an empty repo, a timeout — never guess
  }
}

function copyFilePreserving(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  chmodSync(dest, statSync(src).mode & 0o777)
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Copy node_modules from a real `npm ci` output into the staged payload,
 * dropping `.bin` directories (symlink farms this payload never needs — its
 * own dist/ scripts are invoked directly by the staged bin/node) and
 * dereferencing any other symlink encountered into a plain regular file, so
 * the resulting tree upholds the payload's "no symlinks, ever" invariant.
 * A directory symlink (other than .bin) is skipped rather than followed,
 * since nothing this runtime needs is reachable only through one.
 */
function copyNodeModulesDereferenced(srcRoot, destRoot) {
  const stack = ['']
  while (stack.length > 0) {
    const relDir = stack.pop()
    const absDir = relDir ? join(srcRoot, relDir) : srcRoot
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === '.bin') continue
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      const absSrc = join(absDir, entry.name)
      const lst = lstatSync(absSrc)
      if (lst.isSymbolicLink()) {
        const followed = statSync(absSrc)
        if (!followed.isDirectory()) copyFilePreserving(absSrc, join(destRoot, relPath))
      } else if (entry.isDirectory()) {
        stack.push(relPath)
      } else if (entry.isFile()) {
        copyFilePreserving(absSrc, join(destRoot, relPath))
      }
    }
  }
}

// @electron/packager always strips these paths, even from nested runtime
// payloads. Remove them before manifesting so the signed app cannot contain a
// manifest for bytes the packager silently omitted.
function removePackagerIgnoredArtifacts(root) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '.bin' || entry.name === 'node_gyp_bins') {
          rmSync(path, { recursive: true, force: true })
        } else {
          stack.push(path)
        }
        continue
      }
      if (
        entry.name === 'package-lock.json' ||
        entry.name === 'yarn.lock' ||
        entry.name === 'pnpm-lock.yaml' ||
        /\.o(bj)?$/.test(entry.name)
      ) {
        rmSync(path, { force: true })
      }
    }
  }
}

const REQUIRED_SCRIPTS = ['install-agents.sh', 'install-hooks.sh', 'runtime-payload.mjs', 'runtime-config.mjs']
const REQUIRED_DOCS = [
  'reporting-snippet.md',
  'hooks.md',
  join('instructions', 'claude-code.md'),
  join('instructions', 'copilot-cli.md'),
]

/**
 * Prove the exact staged Node + better-sqlite3 combination actually loads,
 * BEFORE this tree is ever allowed to become a manifest or a published
 * runtime. Mirrors install-hooks.sh's own `"$NODE" "$ENTRY" selftest` gate —
 * docs/hooks.md documents `selftest` as the one subcommand "allowed to exit
 * non-zero on failure", which is exactly the signal this needs — but runs it
 * against the STAGED tree's own bin/node + dist/hook-cli.js, not the source
 * repo's, since it is the staged copy (and its staged node_modules) that
 * ships. Runs against a scratch, disposable database path (never the real
 * ~/.agent-inbox/inbox.db) so staging a runtime can never touch host state.
 * On failure this throws — the caller must not build/write a manifest or
 * publish anything for a tree that failed this check.
 */
function runStagedSelftest(stageDir) {
  const stagedNode = join(stageDir, 'bin', 'node')
  const hookCli = join(stageDir, 'dist', 'hook-cli.js')
  if (!existsSync(hookCli)) {
    throw new StageRuntimeError(`staged dist/ is missing hook-cli.js at ${hookCli} — cannot run the selftest gate`)
  }
  const scratchDir = mkdtempSync(join(tmpdir(), 'stage-runtime-selftest-'))
  try {
    execFileSync(stagedNode, [hookCli, 'selftest'], {
      cwd: stageDir,
      env: { ...process.env, AGENT_INBOX_DB: join(scratchDir, 'inbox.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
  } catch (err) {
    throw new StageRuntimeError(
      `staged runtime failed its selftest (bin/node dist/hook-cli.js selftest) — refusing to publish: ${err.message}`,
    )
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

function stageInto(stageDir, {
  repoRoot, repoPkg, nodeRoot, nodeBin, platform, arch, packageVersion, sourceCommit, nodeVersion, nodeModulesAbi,
}) {
  mkdirSync(stageDir, { recursive: true })

  copyFilePreserving(nodeBin, join(stageDir, 'bin', 'node'))
  chmodSync(join(stageDir, 'bin', 'node'), 0o755)

  const nodeLicense = join(nodeRoot, 'LICENSE')
  if (!existsSync(nodeLicense)) {
    throw new StageRuntimeError(`Node distribution is missing its LICENSE at ${nodeLicense}`)
  }
  copyFilePreserving(nodeLicense, join(stageDir, 'LICENSE'))

  writeJsonFile(join(stageDir, 'package.json'), buildRuntimePackageJson(repoPkg))

  const lockFile = join(repoRoot, 'package-lock.json')
  if (!existsSync(lockFile)) {
    throw new StageRuntimeError(`repo is missing package-lock.json at ${lockFile}; cannot install exact production deps`)
  }
  copyFilePreserving(lockFile, join(stageDir, 'package-lock.json'))

  const npmCli = resolveNpmCli(nodeRoot)
  execFileSync(nodeBin, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: stageDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000,
  })

  const srcModules = join(stageDir, 'node_modules')
  if (existsSync(srcModules)) {
    const dereffed = join(stageDir, '.node_modules_deref')
    copyNodeModulesDereferenced(srcModules, dereffed)
    rmSync(srcModules, { recursive: true, force: true })
    renameSync(dereffed, srcModules)
  }

  const distDir = join(repoRoot, 'dist')
  if (!existsSync(distDir)) {
    throw new StageRuntimeError(`repo is missing a built dist/ at ${distDir} — run \`npm run build\` first`)
  }
  copyTreePreservingMode(distDir, join(stageDir, 'dist'))

  runStagedSelftest(stageDir)

  for (const name of REQUIRED_SCRIPTS) {
    const src = join(repoRoot, 'scripts', name)
    if (!existsSync(src)) throw new StageRuntimeError(`missing required script: ${src}`)
    copyFilePreserving(src, join(stageDir, 'scripts', name))
  }
  for (const relDoc of REQUIRED_DOCS) {
    const src = join(repoRoot, 'docs', relDoc)
    if (!existsSync(src)) throw new StageRuntimeError(`missing required doc: ${src}`)
    copyFilePreserving(src, join(stageDir, 'docs', relDoc))
  }

  removePackagerIgnoredArtifacts(stageDir)

  const entrypoints = Object.values(repoPkg.bin ?? {}).map((p) => p.replace(/^\.\//, ''))
  if (entrypoints.length === 0) {
    throw new StageRuntimeError('repo package.json has no "bin" entries to use as runtime entrypoints')
  }
  const manifest = buildManifest({
    root: stageDir,
    product: PRODUCT,
    packageVersion,
    sourceCommit,
    platform,
    arch,
    nodeVersion,
    nodeModulesAbi,
    entrypoints,
  })
  writeManifestFile(stageDir, manifest)
  verifyPayload({ root: stageDir, expect: { platform, arch, packageVersion, nodeVersion, product: PRODUCT } })
  return manifest
}

/**
 * Stage a full runtime payload and atomically publish it to `output`.
 * Returns {runtimeId, output, manifest}. On any failure the in-progress
 * staging directory is removed — nothing partial is ever left where a
 * caller might mistake it for a finished payload. Publishing is a same-
 * parent-directory rename (so it is atomic on one filesystem); replacing an
 * existing --output requires --force and is itself a rename-swap, never an
 * in-place overwrite that could be observed half-done.
 */
export function stageRuntime({
  nodeRoot, platform, arch, output, repoRoot = DEFAULT_REPO_ROOT, packageVersion, sourceCommit, force = false,
}) {
  const probe = validateNodeDistribution({ nodeRoot, platform, arch })
  const repoPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const resolvedVersion = packageVersion ?? repoPkg.version
  const resolvedCommit = sourceCommit ?? bestEffortSourceCommit(repoRoot)

  const outputResolved = resolve(output)
  const outputParent = dirname(outputResolved)
  mkdirSync(outputParent, { recursive: true })
  const stageDir = join(outputParent, `.stage-runtime-${process.pid}-${randomBytes(4).toString('hex')}`)

  let manifest
  try {
    manifest = stageInto(stageDir, {
      repoRoot,
      repoPkg,
      nodeRoot,
      nodeBin: probe.nodeBin,
      platform,
      arch,
      packageVersion: resolvedVersion,
      sourceCommit: resolvedCommit,
      nodeVersion: probe.version,
      nodeModulesAbi: probe.modulesAbi,
    })

    if (existsSync(outputResolved)) {
      if (!force) {
        throw new StageRuntimeError(`--output already exists: ${outputResolved} (pass --force to replace it)`)
      }
      const backup = `${outputResolved}.old-${Date.now()}`
      renameSync(outputResolved, backup)
      try {
        renameSync(stageDir, outputResolved)
      } catch (err) {
        renameSync(backup, outputResolved)
        throw err
      }
      rmSync(backup, { recursive: true, force: true })
    } else {
      renameSync(stageDir, outputResolved)
    }
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true })
    throw err
  }

  return { runtimeId: manifest.runtimeId, output: outputResolved, manifest }
}

// ── CLI ─────────────────────────────────────────────────────────────────
function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'node-root': { type: 'string' },
      platform: { type: 'string' },
      arch: { type: 'string' },
      output: { type: 'string' },
      'repo-root': { type: 'string' },
      'package-version': { type: 'string' },
      'source-commit': { type: 'string' },
      'check-only': { type: 'boolean' },
      force: { type: 'boolean' },
    },
  })
  for (const required of ['node-root', 'platform', 'arch']) {
    if (!values[required]) throw new StageRuntimeError(`--${required} is required`)
  }
  if (!values['check-only'] && !values.output) {
    throw new StageRuntimeError('--output is required (unless --check-only)')
  }
  return values
}

function main(argv) {
  try {
    const values = parseCliArgs(argv)
    const nodeRoot = resolve(values['node-root'])
    const repoRoot = values['repo-root'] ? resolve(values['repo-root']) : DEFAULT_REPO_ROOT

    if (values['check-only']) {
      const probe = validateNodeDistribution({ nodeRoot, platform: values.platform, arch: values.arch })
      process.stdout.write(`${JSON.stringify({ ok: true, ...probe })}\n`)
      return
    }

    const result = stageRuntime({
      nodeRoot,
      platform: values.platform,
      arch: values.arch,
      output: resolve(values.output),
      repoRoot,
      packageVersion: values['package-version'],
      sourceCommit: values['source-commit'],
      force: Boolean(values.force),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
  } catch (err) {
    process.stderr.write(`stage-runtime: ${err.message}\n`)
    process.exitCode = 1
  }
}

// See runtime-payload.mjs's isMainModule() doc comment: a naive
// fileURLToPath(import.meta.url) === resolve(process.argv[1]) breaks
// whenever only one side has been canonicalized through a symlinked
// ancestor directory (e.g. macOS's /var -> /private/var, under which every
// staged runtime and os.tmpdir() live) — this helper compares
// realpathSync()-canonicalized paths on both sides instead.
const isMain = isMainModule(import.meta.url)
if (isMain) {
  main(process.argv.slice(2))
}
