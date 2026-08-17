// VIEWER PROCESS ONLY — issue #40's build stamp and staleness verdict.
//
// The bug: a packaged .app kept serving whatever `dist` + `public` it was built
// from, forever, with nothing anywhere saying which build that was. An evening of
// testing ran against a bundle four features behind and the window looked normal.
//
// Two halves. `scripts/write-setup-info.mjs` BAKES the commit and the build time
// into setup-info.json at package time (its own git read, in its own process —
// that side must work with no dist/ and no node_modules). This module is the
// READ side: it parses that file and, in the viewer process, asks the checkout
// the bundle was built from what its HEAD is now.
//
// Three rules this file exists to keep:
//   · FAIL OPEN, absolutely. No git, no repoRoot, a moved checkout, a detached
//     HEAD, a corrupt setup-info.json, git hanging — every one resolves to a
//     stamp the viewer renders as it did before #40. A packaging nicety must
//     never be able to break the viewer, so nothing here throws and nothing here
//     rejects.
//   · SUBPROCESS HYGIENE (CLAUDE.md's stdio invariant). `execFile` pipes both
//     streams by construction — it can never inherit one — and every call is
//     bounded by a timeout. src/mcp.ts and src/mcp-server.ts must never import
//     this module: that process speaks MCP over stdout. test/stamp.test.ts pins
//     both halves, the capture one with a real child process.
//   · A STALE BUILD IS NOT ATTENTION (tenets 1 and 2). Nothing here reaches
//     public/attention.js, the tab badge, the dock badge or countsByProject. It
//     is one quiet line in the Setup panel and nothing else.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'

const execFileAsync = promisify(execFile)

/** How long one checkout probe stays good. The Setup panel is fetched once per
 *  page load, so this is a floor on git spawns, not a poll: nothing wakes up to
 *  refresh it, and a request inside the window costs zero processes. */
export const STAMP_TTL_MS = 60_000
/** A git that hangs must lose, not the viewer. */
export const GIT_TIMEOUT_MS = 2_000
const GIT_MAX_BUFFER = 256 * 1024

/** git ran and said something (code 0) or said no (code 1/128); null = it never ran. */
export interface GitResult { code: number; stdout: string }
export type GitRun = (cwd: string, args: string[]) => Promise<GitResult | null>

/** One architecture-keyed runtime payload record (issue #74). `path` is
 *  relative to the app's Resources root; `digest` is `sha256:<64 hex>`. */
export interface RuntimePayload {
  path: string
  digest: string
}

/**
 * What `setup-info.json` carries. Every field optional on purpose: bundles
 * packaged before #40 have only the first two, and a hand-edited file can have
 * anything at all.
 *
 * `schema: 2` marks a RELEASE build (issue #74): it carries `version` and
 * `runtimePayloads` instead of `repoRoot`/`nodeBin` — a signed release must
 * never bake a path back to the machine that built it. A dev/legacy bundle has
 * no `schema` at all and keeps the original repoRoot/nodeBin shape untouched.
 */
export interface BakedInfo {
  repoRoot?: string
  nodeBin?: string
  commit?: string
  builtAt?: string
  schema?: number
  version?: string
  runtimePayloads?: Record<string, RuntimePayload>
}

/**
 * `dev`       — running from a checkout; there is no baked commit to compare.
 * `unknown`   — packaged, but nothing to compare (no commit) or the checkout
 *               could not be read (moved, no git, timed out).
 * `current`   — the checkout still sits on the commit this bundle was built from.
 * `stale`     — the checkout has moved ON past it: repackage.
 * `behind`    — the CHECKOUT is behind this bundle (an older branch is checked
 *               out). The app is ahead; there is nothing to repackage. Bare-SHA
 *               inequality cannot tell this from `stale`, and calling it stale
 *               would be a lie that costs a five-minute rebuild.
 * `diverged`  — they differ and neither is an ancestor of the other, or the
 *               baked commit is not in this checkout at all.
 * `release`   — a signed release build (issue #74, `schema: 2`). There is no
 *               builder checkout to compare against — the release IS the
 *               artifact — so this makes no checkout/repackage claim at all;
 *               it only reports what was baked (version/commit/builtAt).
 */
export type Drift = 'dev' | 'unknown' | 'current' | 'stale' | 'behind' | 'diverged' | 'release'

export interface BuildStamp {
  /** the commit this bundle was built from — null in a checkout */
  commit: string | null
  builtAt: string | null
  /** the checkout's HEAD right now, read live — always null for a release build */
  head: string | null
  repoRoot: string | null
  drift: Drift
  /** the released version (issue #74) — null for dev/legacy bundles */
  version: string | null
}

export type StampCache = Map<string, { at: number; value: BuildStamp }>

export interface StampOpts {
  git?: GitRun
  now?: () => number
  cache?: StampCache
}

// One process per app, so a module-level cache is the whole cache.
const defaultCache: StampCache = new Map()

/**
 * Run git, capturing both streams, bounded by a timeout.
 *
 * `bin`/`timeoutMs` are parameters so the timeout itself is testable without
 * touching PATH (test/stamp.test.ts runs `/bin/sleep 30` through it).
 */
export async function execGit(
  cwd: string,
  args: string[],
  bin = 'git',
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitResult | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
    })
    return { code: 0, stdout: stdout.trim() }
  } catch (err: unknown) {
    // A NUMERIC code means git ran and answered no (1 = not an ancestor,
    // 128 = no such object). Anything else — ENOENT, a kill after the timeout —
    // means it never answered at all, which is not a verdict.
    const code = (err as { code?: unknown } | null)?.code
    return typeof code === 'number' ? { code, stdout: '' } : null
  }
}

const defaultGitRun: GitRun = (cwd, args) => execGit(cwd, args)

/** A 40-hex sha (or a sha-256 one). Anything else is not handed to git — an
 *  argv element starting with `-` would be read as a flag. */
const SHA = /^[0-9a-f]{7,64}$/i

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** A single `runtimePayloads` entry, or undefined if its shape is not usable.
 *  This is a display/version-comparison reader, not the security boundary —
 *  electron/setup-runner.cjs independently re-validates path containment and
 *  digest format before it ever selects or runs anything. */
function runtimePayload(v: unknown): RuntimePayload | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const path = str(o['path'])
  const digest = str(o['digest'])
  return path && digest ? { path, digest } : undefined
}

function runtimePayloads(v: unknown): Record<string, RuntimePayload> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, RuntimePayload> = {}
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    const payload = runtimePayload(value)
    if (payload) out[key] = payload
  }
  return out
}

/**
 * Parse the baked setup-info.json, or null if there isn't a usable one.
 *
 * Fail-open is the whole point: before #40 a corrupt file threw straight out of
 * the /api/setup handler and took the Setup panel with it. Issue #74's release
 * shape (`schema: 2`, `version`, `runtimePayloads`) is parsed the same
 * fail-open way — a malformed field is simply dropped, never thrown.
 */
export function readBakedInfo(path: string): BakedInfo | null {
  try {
    if (!existsSync(path)) return null
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    const info: BakedInfo = {}
    const repoRoot = str(o['repoRoot'])
    const nodeBin = str(o['nodeBin'])
    const commit = str(o['commit'])
    const builtAt = str(o['builtAt'])
    const version = str(o['version'])
    const payloads = runtimePayloads(o['runtimePayloads'])
    if (repoRoot) info.repoRoot = repoRoot
    if (nodeBin) info.nodeBin = nodeBin
    if (commit) info.commit = commit
    if (builtAt) info.builtAt = builtAt
    if (typeof o['schema'] === 'number') info.schema = o['schema']
    if (version) info.version = version
    if (payloads) info.runtimePayloads = payloads
    return info
  } catch {
    return null
  }
}

async function headOf(root: string, run: GitRun): Promise<string | null> {
  if (!existsSync(root)) return null            // a moved checkout: don't even spawn
  const out = await run(root, ['rev-parse', 'HEAD'])
  if (!out || out.code !== 0) return null
  return SHA.test(out.stdout) ? out.stdout : null
}

// Direction, not just difference. `merge-base --is-ancestor A B` exits 0 when A
// is an ancestor of B, 1 when it is not, 128 when the object is unknown here.
async function compare(root: string, commit: string, head: string, run: GitRun): Promise<Drift> {
  if (commit === head) return 'current'
  const moved = await run(root, ['merge-base', '--is-ancestor', commit, head])
  if (moved?.code === 0) return 'stale'
  const back = await run(root, ['merge-base', '--is-ancestor', head, commit])
  if (back?.code === 0) return 'behind'
  return 'diverged'
}

/**
 * The stamp for this running viewer. `baked` is null in a checkout (`npm run
 * view` / `npm run electron`), where the honest answer is the live HEAD and NO
 * staleness claim at all — a dev build cannot be stale against itself.
 *
 * A release build (`baked.schema === 2`, issue #74) is a third case: there is
 * no builder checkout to probe at all, so this returns immediately with
 * `drift: 'release'` and never spawns git.
 */
export async function buildStamp(baked: BakedInfo | null, cwd: string, opts: StampOpts = {}): Promise<BuildStamp> {
  const run = opts.git ?? defaultGitRun
  const now = opts.now ?? Date.now
  const cache = opts.cache ?? defaultCache

  const commit = baked?.commit && SHA.test(baked.commit) ? baked.commit : null
  const builtAt = baked?.builtAt && Number.isFinite(Date.parse(baked.builtAt)) ? baked.builtAt : null
  const version = baked?.version ?? null

  if (baked?.schema === 2) {
    // A release build IS the artifact — there is no checkout to compare
    // against, so no drift value but 'release' is honest, and none of them
    // (stale/behind/diverged/current) may ever be claimed here.
    return { commit, builtAt, head: null, repoRoot: null, drift: 'release', version }
  }

  const root = baked ? (baked.repoRoot ?? null) : cwd

  const key = `${baked ? 'app' : 'dev'}|${root ?? ''}|${commit ?? ''}`
  const hit = cache.get(key)
  if (hit && now() - hit.at < STAMP_TTL_MS) return hit.value

  const value = await probe({ baked: Boolean(baked), commit, builtAt, root }, run)
  cache.set(key, { at: now(), value })
  return value
}

async function probe(
  input: { baked: boolean; commit: string | null; builtAt: string | null; root: string | null },
  run: GitRun,
): Promise<BuildStamp> {
  const { baked, commit, builtAt, root } = input
  const base = { commit, builtAt, repoRoot: root, version: null }

  // A checkout: report HEAD, claim nothing.
  if (!baked) {
    const head = root ? await headOf(root, run) : null
    return { ...base, head, drift: 'dev' }
  }
  // Packaged, but nothing to compare against (a pre-#40 bundle, a hand-edited
  // file, a repoRoot that is gone). Say what we know and stop — no git spawn.
  if (!commit || !root) return { ...base, head: null, drift: 'unknown' }

  const head = await headOf(root, run)
  if (!head) return { ...base, head: null, drift: 'unknown' }
  return { ...base, head, drift: await compare(root, commit, head, run) }
}
