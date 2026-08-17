#!/usr/bin/env node
// Write setup-info.json — issue #40's dev-checkout stamp, and issue #74's
// architecture-keyed RELEASE runtime metadata. Two independent shapes, one
// script, because both answer the same question — "which build/runtime is
// this, exactly" — for src/stamp.ts and electron/setup-runner.cjs to read.
//
// ── DEV / CHECKOUT MODE (unchanged since issue #40) ─────────────────────────
//
//   node scripts/write-setup-info.mjs <repoRoot> <outFile>
//
// Bakes { repoRoot, nodeBin, commit?, builtAt }: where agents run the MCP
// server from (the bundle cannot host it — its native module is built for
// Electron's ABI) and WHICH BUILD THIS IS. `scripts/package-app.sh` still
// calls this exact two-positional-argument form; nothing about it changes.
//
// ── RELEASE MODE (issue #74) ─────────────────────────────────────────────────
//
//   node scripts/write-setup-info.mjs --release <outFile> \
//     --version <semver> \
//     --payload-root <dir> \
//     --payload darwin-arm64=<relDir> \
//     --payload darwin-x64=<relDir> \
//     [--source-root <path>] [--commit <sha>]
//
// Bakes { schema: 2, version, commit?, builtAt, runtimePayloads } — NEVER
// repoRoot/nodeBin. That is the #74 bug: a signed release DMG built on CI must
// not ship a path back to the builder's checkout. Instead it ships an
// architecture-keyed map of portable runtime payload DIRECTORIES that
// electron/setup-runner.cjs selects from strictly by process.platform/
// process.arch and verifies by digest before ever running anything.
//
// Each `--payload key=relDir` names a DIRECTORY (a portable runtime payload
// built by scripts/runtime-payload.mjs — Node + node_modules + dist + install
// scripts), relative and traversal-free under `--payload-root`. The directory
// must contain a `runtime-manifest.json` (that script's own manifest, an
// integrity contract over every file in the payload); this script does not
// re-walk the whole payload — it reads that manifest, requires its declared
// `platform`/`arch` to match the `--payload` key exactly (a darwin-arm64
// payload staged under the darwin-x64 key is a build-time bug, not something
// to bake and discover later), and digests the manifest FILE itself with
// SHA-256 — never taken on trust from the caller. That one digest is enough:
// the manifest already commits to every payload file's own hash, so a tampered
// or truncated payload changes the manifest's bytes too.
//
// Both mandatory keys (darwin-arm64, darwin-x64) are REQUIRED — a partial map
// is a hard failure, nothing is written, because the runner has no fallback
// for a missing architecture.
//
// `--source-root` is a BUILD INPUT ONLY, exactly like dev mode's `<repoRoot>`:
// it is read (to derive `commit` via git) and never persisted to the output
// file. Baking a builder-machine path into a release is the thing this mode
// exists to stop.
//
// Two rules carried over from dev mode:
//   · If git cannot answer, `commit` is ABSENT — never null, never a guess.
//   · Silent on stdout. This runs inside a packaging script whose output a
//     human reads; it has nothing to say unless it fails (stderr + exit 1).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve, sep } from 'node:path'

const require = createRequire(import.meta.url)
const {
  EXPECTED_NODE_MAJOR,
  EXPECTED_NODE_MODULES_ABI,
  EXPECTED_PRODUCT,
  REQUIRED_ENTRYPOINTS,
  REQUIRED_FILES,
  verifyRuntimePayload,
} = require('../electron/runtime-verify.cjs')

const SHA_RE = /^[0-9a-f]{7,64}$/i
const DIGEST_RE = /^[0-9a-f]{64}$/i
const RUNTIME_KEYS = ['darwin-arm64', 'darwin-x64']
const MANIFEST_FILE = 'runtime-manifest.json'

/** Split a fixed `darwin-arm64`/`darwin-x64` runtime key into platform/arch. */
function platformArchOf(key) {
  const i = key.indexOf('-')
  return { platform: key.slice(0, i), arch: key.slice(i + 1) }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

// stdio: stdout CAPTURED, stderr and stdin discarded — the same shape as
// src/infer.ts's git(). Nothing git prints may reach the packager's output.
function head(cwd) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim()
    return SHA_RE.test(sha) ? sha : null
  } catch {
    return null // no git, not a checkout, an empty repo, a timeout
  }
}

/** A contained relative path: never absolute, never a `..` traversal segment. */
function isContainedRelativePath(p) {
  if (typeof p !== 'string' || !p) return false
  if (isAbsolute(p)) return false
  const segments = p.split(/[\\/]+/)
  return segments.every((s) => s !== '' && s !== '.' && s !== '..')
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function buildTimestamp() {
  const epoch = process.env.SOURCE_DATE_EPOCH
  if (epoch === undefined || epoch === '') return new Date().toISOString()
  if (!/^\d+$/.test(epoch)) fail('SOURCE_DATE_EPOCH must be a non-negative integer')
  const date = new Date(Number(epoch) * 1000)
  if (!Number.isFinite(date.getTime())) fail('SOURCE_DATE_EPOCH is outside the supported date range')
  return date.toISOString()
}

function writeDev(repoRoot, outFile) {
  const info = { repoRoot, nodeBin: process.execPath, builtAt: buildTimestamp() }
  const commit = head(repoRoot)
  if (commit) info.commit = commit
  writeFileSync(outFile, `${JSON.stringify(info, null, 2)}\n`)
}

function parseReleaseArgs(argv) {
  const opts = { payloads: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--version':
        opts.version = argv[++i]
        break
      case '--payload-root':
        opts.payloadRoot = argv[++i]
        break
      case '--source-root':
        opts.sourceRoot = argv[++i]
        break
      case '--commit':
        opts.commit = argv[++i]
        break
      case '--payload': {
        const raw = argv[++i]
        const eq = typeof raw === 'string' ? raw.indexOf('=') : -1
        if (eq < 1) fail(`--payload must be <key>=<relative-path>, got ${JSON.stringify(raw)}`)
        opts.payloads[raw.slice(0, eq)] = raw.slice(eq + 1)
        break
      }
      default:
        fail(`Unknown --release argument: ${a}`)
    }
  }
  return opts
}

function writeRelease(outFile, argv) {
  const opts = parseReleaseArgs(argv)

  if (typeof opts.version !== 'string' || !opts.version.trim()) {
    fail('--release requires --version <version>')
  }

  const given = Object.keys(opts.payloads)
  const missing = RUNTIME_KEYS.filter((k) => !given.includes(k))
  if (missing.length) {
    fail(`--release requires a --payload for every mandatory runtime key; missing: ${missing.join(', ')}`)
  }
  const unknown = given.filter((k) => !RUNTIME_KEYS.includes(k))
  if (unknown.length) {
    fail(`--release does not recognise these runtime keys: ${unknown.join(', ')}`)
  }

  if (typeof opts.payloadRoot !== 'string' || !opts.payloadRoot) {
    fail('--release requires --payload-root <dir> (where the staged runtime payload files actually live)')
  }
  if (!isAbsolute(opts.payloadRoot) || !existsSync(opts.payloadRoot) || !statSync(opts.payloadRoot).isDirectory()) {
    fail(`--payload-root must be an existing absolute directory, got ${opts.payloadRoot}`)
  }
  const realRoot = realpathSync(opts.payloadRoot)

  const runtimePayloads = {}
  for (const key of RUNTIME_KEYS) {
    const relPath = opts.payloads[key]
    if (!isContainedRelativePath(relPath)) {
      fail(`--payload ${key}: path must be a relative, traversal-free path, got ${JSON.stringify(relPath)}`)
    }
    const resolved = resolve(opts.payloadRoot, relPath)
    if (resolved !== resolve(opts.payloadRoot) && !resolved.startsWith(resolve(opts.payloadRoot) + sep)) {
      fail(`--payload ${key}: path escapes --payload-root: ${relPath}`)
    }
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      fail(`--payload ${key}: no runtime payload directory staged at ${resolved}`)
    }
    if (lstatSync(resolved).isSymbolicLink()) {
      fail(`--payload ${key}: staged payload directory must not itself be a symlink: ${resolved}`)
    }
    const realResolved = realpathSync(resolved)
    if (realResolved !== realRoot && !realResolved.startsWith(realRoot + sep)) {
      fail(`--payload ${key}: staged payload escapes --payload-root via a symlink: ${resolved}`)
    }
    if (!statSync(realResolved).isDirectory()) {
      fail(`--payload ${key}: staged payload must be a directory: ${resolved}`)
    }

    // Reuse the trusted Setup verifier at bake time so metadata is emitted only
    // for a complete Agent Inbox Node 24 payload with the exact release version.
    const manifestPath = join(realResolved, MANIFEST_FILE)
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) {
      fail(`--payload ${key}: no ${MANIFEST_FILE} staged at ${manifestPath}`)
    }
    const { platform: expectedPlatform, arch: expectedArch } = platformArchOf(key)
    try {
      verifyRuntimePayload({
        root: realResolved,
        expectedPlatform,
        expectedArch,
        expectedProduct: EXPECTED_PRODUCT,
        expectedPackageVersion: opts.version,
        expectedNodeMajor: EXPECTED_NODE_MAJOR,
        expectedNodeModulesAbi: EXPECTED_NODE_MODULES_ABI,
        requiredEntrypoints: REQUIRED_ENTRYPOINTS,
        requiredFiles: REQUIRED_FILES,
      }).manifest
    } catch (err) {
      fail(`--payload ${key}: runtime identity/integrity verification failed: ${err.message}`)
    }

    const digest = sha256File(manifestPath)
    if (!DIGEST_RE.test(digest)) {
      // unreachable in practice (createHash always yields 64 hex chars) — kept
      // as the same validated-SHA-256 guarantee the runner re-checks at
      // selection time, never trusting a digest that merely "looks" right.
      fail(`--payload ${key}: computed digest is not a valid SHA-256 hex digest`)
    }
    runtimePayloads[key] = { path: relPath, digest: `sha256:${digest}` }
  }

  let commit = null
  if (opts.commit !== undefined) {
    if (!SHA_RE.test(opts.commit)) fail(`--commit is not a plausible sha: ${opts.commit}`)
    commit = opts.commit
  } else if (opts.sourceRoot) {
    commit = head(opts.sourceRoot) // a build input only — never persisted below
  }

  const info = {
    schema: 2,
    version: opts.version,
    builtAt: buildTimestamp(),
    runtimePayloads,
  }
  if (commit) info.commit = commit

  writeFileSync(outFile, `${JSON.stringify(info, null, 2)}\n`)
}

const argv = process.argv.slice(2)
if (argv[0] === '--release') {
  const outFile = argv[1]
  if (!outFile) {
    fail(
      'usage: write-setup-info.mjs --release <outFile> --version <v> --payload-root <dir> ' +
      '--payload darwin-arm64=<relDir> --payload darwin-x64=<relDir> [--source-root <path>] [--commit <sha>]',
    )
  }
  writeRelease(outFile, argv.slice(2))
} else {
  const [repoRoot, outFile] = argv
  if (!repoRoot || !outFile) fail('usage: write-setup-info.mjs <repoRoot> <outFile>')
  writeDev(repoRoot, outFile)
}
