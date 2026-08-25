import { Hono } from 'hono'
import { readFileSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type Database from 'better-sqlite3'
import {
  listItems, resolveItem, dismissItem, annotateItem, replyItem, snoozeItem,
  listBoards, archiveBoard, unarchiveBoard, annotateBoardRow, snoozeBoardRow,
  markRowHandled, clearRowHandled, listActivity, listActivitySpans, listSourceLinks, defaultDbPath,
  closeProject, reopenProject, closedProjects,
} from './store.js'
import type { ResponseKind } from './store.js'
import { groupItems } from './group.js'
import { hooksSettingsBlock } from './hook.js'
import { buildStamp, readBakedInfo } from './stamp.js'
import type { BakedInfo, BuildStamp } from './stamp.js'

const require = createRequire(import.meta.url)
const {
  EXPECTED_NODE_MAJOR,
  EXPECTED_NODE_MODULES_ABI,
  EXPECTED_PRODUCT,
  REQUIRED_ENTRYPOINTS,
  REQUIRED_FILES,
  verifyRuntimePayload,
} = require('../electron/runtime-verify.cjs') as {
  EXPECTED_NODE_MAJOR: number
  EXPECTED_NODE_MODULES_ABI: string
  EXPECTED_PRODUCT: string
  REQUIRED_ENTRYPOINTS: string[]
  REQUIRED_FILES: string[]
  verifyRuntimePayload(opts: {
    root: string
    expectedManifestDigest?: string
    expectedPlatform?: string
    expectedArch?: string
    expectedPackageVersion?: string
    expectedProduct?: string
    expectedNodeMajor?: number
    expectedNodeModulesAbi?: string
    requiredEntrypoints?: string[]
    requiredFiles?: string[]
  }): { manifest: { runtimeId: string } }
}

/** Seams, both test-only today — the production path passes neither. */
export interface ViewerOpts {
  /** where the packaged app's setup-info.json lives (a checkout has none) */
  setupInfoPath?: string
  /** the #40 build-stamp probe, injected so a test never shells out to git */
  stamp?: (baked: BakedInfo | null, cwd: string) => Promise<BuildStamp>
  /** Electron-only readiness capability; absent for browser/dev viewers. */
  ownerToken?: string
  /** issue #74: `${process.platform}-${process.arch}` override, so a test can
   *  pin a host key without touching the real process. */
  runtimeHostKey?: string
  /** issue #74: root directory a portable runtime gets installed under
   *  (`~/.agent-inbox/runtime` in production); overridable so a test never
   *  touches the real home directory. */
  runtimeRoot?: string
  /** issue #74: the app bundle root a release payload's contained relative
   *  path is resolved against (the directory setup-info.json itself lives
   *  in); overridable so a test never depends on cwd. Production derives it
   *  from `dirname(setupInfoPath)`. */
  appRoot?: string
}

/** Split a fixed `darwin-arm64`/`darwin-x64` runtime key into platform/arch —
 *  the same convention scripts/write-setup-info.mjs and electron/setup-
 *  runner.cjs use to validate a runtime-manifest.json against its map key. */
function platformArchOf(key: string): { platform: string; arch: string } {
  const i = key.indexOf('-')
  return { platform: key.slice(0, i), arch: key.slice(i + 1) }
}

/** A contained relative path: never absolute, never a `..` traversal segment —
 *  the exact same rule write-setup-info.mjs and setup-runner.cjs enforce. */
function isContainedRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false
  if (isAbsolute(p)) return false
  const segments = p.split(/[\\/]+/)
  return segments.every((s) => s !== '' && s !== '.' && s !== '..')
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i
/**
 * Resolves and verifies the release's SOURCE runtime payload directory for
 * this exact host (issue #74). Containment is established here, then the same
 * trusted, Electron-independent verifier used immediately before spawn checks
 * every manifested file/hash/mode, rejects symlinks and extras, and re-derives
 * the payload digest/runtime ID before this API exposes a command.
 *
 * A payload verifying here means it is safe to REFERENCE in the one-click
 * install command (running that command is what installs it) — it does NOT
 * mean the runtime is already installed; that is `installedRuntime()` below.
 */
function resolveReleaseRuntimeSource(
  appRoot: string,
  hostKey: string,
  payload: { path: string; digest: string } | null | undefined,
  packageVersion: string,
): { dir: string; installer: string } | null {
  if (!payload) return null
  if (!isContainedRelativePath(payload.path)) return null
  if (!DIGEST_RE.test(payload.digest)) return null
  if (!isAbsolute(appRoot) || !existsSync(appRoot)) return null
  const realRoot = realpathSync(appRoot)
  const resolved = resolve(appRoot, payload.path)
  if (resolved !== resolve(appRoot) && !resolved.startsWith(resolve(appRoot) + sep)) return null
  if (!existsSync(resolved) || lstatSync(resolved).isSymbolicLink()) return null
  const realResolved = realpathSync(resolved)
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + sep)) return null
  if (!lstatSync(realResolved).isDirectory()) return null

  const { platform, arch } = platformArchOf(hostKey)
  try {
    verifyRuntimePayload({
      root: realResolved,
      expectedManifestDigest: payload.digest,
      expectedPlatform: platform,
      expectedArch: arch,
      expectedProduct: EXPECTED_PRODUCT,
      expectedPackageVersion: packageVersion,
      expectedNodeMajor: EXPECTED_NODE_MAJOR,
      expectedNodeModulesAbi: EXPECTED_NODE_MODULES_ABI,
      requiredEntrypoints: REQUIRED_ENTRYPOINTS,
      requiredFiles: REQUIRED_FILES,
    })
  } catch {
    return null
  }

  const installer = resolve(realResolved, 'scripts', 'install-agents.sh')
  if (!existsSync(installer)) return null
  return { dir: realResolved, installer }
}

/**
 * Whether a portable runtime matching THIS release's exact source payload for
 * THIS host is already installed under `runtimeRoot` (issue #74). Scans
 * `runtimeRoot`'s direct children (never symlinked — an installer contract,
 * not agent-authored text) for a `runtime-manifest.json` whose declared
 * `runtimeId` equals the child directory's OWN name, whose `platform`/`arch`/
 * `packageVersion` match this host's release, and whose manifest file is
 * byte-identical (SHA-256) to the SOURCE manifest digest baked into
 * setup-info.json — a valid identity check because the installer that copies
 * a verified payload into `runtimeRoot/<runtimeId>` copies the whole payload
 * tree, so the installed manifest is byte-for-byte the source manifest.
 *
 * The trusted verifier checks the complete installed file list as well; a
 * matching manifest alone can never make manual commands appear.
 */
function installedRuntime(
  runtimeRoot: string,
  version: string,
  hostKey: string,
  expectedDigest: string,
): { nodeBin: string; entry: string; hookEntry: string } | null {
  let entries: string[]
  try {
    entries = readdirSync(runtimeRoot)
  } catch {
    return null
  }
  const { platform, arch } = platformArchOf(hostKey)
  for (const name of entries) {
    const dir = resolve(runtimeRoot, name)
    let dirStat: import('node:fs').Stats
    try {
      dirStat = lstatSync(dir)
    } catch {
      continue
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue
    let verified: { manifest: { runtimeId: string } }
    try {
      verified = verifyRuntimePayload({
        root: dir,
        expectedManifestDigest: expectedDigest,
        expectedPlatform: platform,
        expectedArch: arch,
        expectedPackageVersion: version,
        expectedProduct: EXPECTED_PRODUCT,
        expectedNodeMajor: EXPECTED_NODE_MAJOR,
        expectedNodeModulesAbi: EXPECTED_NODE_MODULES_ABI,
        requiredEntrypoints: REQUIRED_ENTRYPOINTS,
        requiredFiles: REQUIRED_FILES,
      })
    } catch {
      continue
    }
    if (verified.manifest.runtimeId !== name) continue

    const nodeBin = resolve(dir, 'bin', 'node')
    const entry = resolve(dir, 'dist', 'mcp-server.js')
    const hookEntry = resolve(dir, 'dist', 'hook-cli.js')
    if (!existsSync(nodeBin) || !existsSync(entry)) continue
    return { nodeBin, entry, hookEntry }
  }
  return null
}

interface SetupInfoResult {
  /** 'release' for a signed release build (setup-info schema 2, issue #74);
   *  'dev' for a source checkout or a pre-#74 packaged bundle. */
  mode: 'dev' | 'release'
  /** the released version, or null outside release mode */
  version: string | null
  /** `${process.platform}-${process.arch}`, or null outside release mode */
  runtimeKey: string | null
  /** whether an installed runtime matching this host's exact payload validated */
  runtimeAvailable: boolean
  agentInstallCommand: string
  claudeInstallCommand: string
  copilotInstallCommand: string
  claudeCommand: string
  copilotConfig: string
  snippet: string
  dbPath: string
  note: string
  hooksSettings: string
  hooksNote: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`
}

function devSetupInfo(baked: BakedInfo | null): SetupInfoResult {
  let nodeBin = process.execPath
  let root = process.cwd()
  let note = ''
  // In a checkout the Node serving this request has demonstrably loaded
  // better-sqlite3 (it is holding the db open); in the packaged app the baked
  // path is whatever ran the packaging script and is NOT proven.
  let nodeProven = true
  // Both fields or neither: a half-written file would otherwise put `undefined`
  // into the very command the human is told to paste.
  if (baked?.repoRoot && baked.nodeBin) {
    root = baked.repoRoot
    nodeBin = baked.nodeBin
    nodeProven = false
    note = `Paths were captured when this app was packaged and assume the agent-inbox repo still lives at ${root} (agents run the MCP server from the repo, not from this app).`
  }
  const entry = resolve(root, 'dist', 'mcp-server.js')
  const snippetPath = resolve(process.cwd(), 'docs', 'reporting-snippet.md')
  const install = `cd ${shellQuote(root)} && npm run install:agents -- --apply`
  return {
    mode: 'dev',
    version: null,
    runtimeKey: null,
    runtimeAvailable: false,
    agentInstallCommand: install,
    claudeInstallCommand: `${install} --target claude`,
    copilotInstallCommand: `${install} --target copilot`,
    claudeCommand: `claude mcp add --scope user agent-inbox -- ${nodeBin} ${entry}`,
    copilotConfig: JSON.stringify(
      { mcpServers: { 'agent-inbox': { command: nodeBin, args: [entry] } } },
      null,
      2,
    ),
    snippet: existsSync(snippetPath) ? readFileSync(snippetPath, 'utf8') : '',
    dbPath: defaultDbPath(),
    note,
    hooksSettings: JSON.stringify(hooksSettingsBlock(nodeBin, resolve(root, 'dist', 'hook-cli.js')), null, 2),
    // This panel cannot run `selftest`, so it cannot prove the baked Node can
    // load better-sqlite3 — and a hook spawned under the wrong Node dies
    // silently, forever. Say so instead of implying safety.
    hooksNote:
      (nodeProven
        ? 'Optional. Merge into ~/.claude/settings.json, then restart Claude Code. '
        : '⚠ The Node path below was captured when this app was packaged and has NOT been verified against better-sqlite3. ') +
      'Prefer `npm run install:hooks` from the repo — it proves the Node binary with a selftest before writing anything, backs the file up, and is a dry run by default. See docs/hooks.md.',
  }
}

// A release build (issue #74) never bakes repoRoot/nodeBin at all — there is
// no checkout to `cd` into, so the shell one-liners that assume one are
// simply absent (empty string), never a fabricated command pointing at a
// path that does not exist. The one-click install commands become truthful
// as soon as this host's SOURCE runtime payload verifies (contained,
// non-symlink, digest+platform/arch-matched, installer present) — running
// that very command is what installs the runtime, so it does not need to be
// installed first. Direct MCP/hook registration commands are different: they
// name an ALREADY-INSTALLED runtime's exact paths, so they stay withheld
// until `installedRuntime()` validates a matching install — never a
// "success-shaped" command aimed at a runtime that is not there.
function releaseSetupInfo(baked: BakedInfo, hostKey: string, runtimeRoot: string, appRoot: string): SetupInfoResult {
  const version = baked.version ?? null
  const payload = baked.runtimePayloads?.[hostKey] ?? null
  const snippetPath = resolve(process.cwd(), 'docs', 'reporting-snippet.md')
  const snippet = existsSync(snippetPath) ? readFileSync(snippetPath, 'utf8') : ''
  const dbPath = defaultDbPath()

  const result: SetupInfoResult = {
    mode: 'release',
    version,
    runtimeKey: hostKey,
    runtimeAvailable: false,
    agentInstallCommand: '',
    claudeInstallCommand: '',
    copilotInstallCommand: '',
    claudeCommand: '',
    copilotConfig: '',
    snippet,
    dbPath,
    note: version
      ? `The portable MCP runtime for Agent Inbox v${version} (${hostKey}) has not been installed yet. Run setup from this panel to install it.`
      : 'This release build has no runtime metadata for this host — one-click and manual agent setup are unavailable.',
    hooksSettings: '',
    hooksNote: '',
  }
  if (!version || !payload) return result
  if (!DIGEST_RE.test(payload.digest)) return result

  // The embedded installer script lives INSIDE the verified source payload
  // directory — never a builder's own checkout path.
  const source = resolveReleaseRuntimeSource(appRoot, hostKey, payload, version)
  if (source) {
    const install = `bash ${shellQuote(source.installer)} --apply --runtime-source ${shellQuote(source.dir)} --runtime-digest ${shellQuote(payload.digest)}`
    result.agentInstallCommand = install
    result.claudeInstallCommand = `${install} --target claude`
    result.copilotInstallCommand = `${install} --target copilot`
    result.note = `Run setup below to install the portable MCP runtime for Agent Inbox v${version} (${hostKey}).`
  }

  const runtime = installedRuntime(runtimeRoot, version, hostKey, payload.digest)
  if (!runtime) return result

  return {
    ...result,
    runtimeAvailable: true,
    note: '',
    claudeCommand: `claude mcp add --scope user agent-inbox -- ${runtime.nodeBin} ${runtime.entry}`,
    copilotConfig: JSON.stringify(
      { mcpServers: { 'agent-inbox': { command: runtime.nodeBin, args: [runtime.entry] } } },
      null,
      2,
    ),
    hooksSettings: JSON.stringify(hooksSettingsBlock(runtime.nodeBin, runtime.hookEntry), null, 2),
    hooksNote: 'Optional. Merge into ~/.claude/settings.json, then restart Claude Code.',
  }
}

function setupInfo(baked: BakedInfo | null, hostKey: string, runtimeRoot: string, appRoot: string): SetupInfoResult {
  if (baked?.schema === 2) return releaseSetupInfo(baked, hostKey, runtimeRoot, appRoot)
  return devSetupInfo(baked)
}

// A close/reopen body carries one agent-authored project name. An unparseable
// body arrives here as null (the caller's .catch) and is refused like any other
// missing name — a 400, never a 500.
function validProject(body: unknown): string | null {
  const project = (body as { project?: unknown } | null)?.project
  return typeof project === 'string' && project.trim() ? project : null
}

function responseKind(value: unknown): ResponseKind | null {
  return value === 'answer' || value === 'clarify' || value === 'decline' ? value : null
}

export function createViewer(db: Database.Database, opts: ViewerOpts = {}): Hono {
  const app = new Hono()
  const bakedPath = opts.setupInfoPath ?? resolve(process.cwd(), 'setup-info.json')
  const stamp = opts.stamp ?? buildStamp
  const runtimeHostKey = opts.runtimeHostKey ?? `${process.platform}-${process.arch}`
  const runtimeRoot = opts.runtimeRoot ?? resolve(homedir(), '.agent-inbox', 'runtime')
  // A release payload's contained relative path is resolved against the app
  // bundle root — the same directory setup-info.json itself lives in.
  const appRoot = opts.appRoot ?? dirname(bakedPath)

  // boot id lets a long-lived tab detect a server restart (= likely deploy)
  // and reload itself instead of polling forever with stale frontend code
  const boot = new Date().toISOString()
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('x-inbox-boot', boot)
  })

  app.get('/api/items', (c) => c.json(groupItems(listItems(db))))

  // The build stamp (#40) rides along here rather than on its own route: the
  // Setup panel is the one surface that asks "which build is this", and it is
  // fetched ONCE per page load, never on the 3s poll. The git probe behind it is
  // memoized for STAMP_TTL_MS, so a reload storm costs no extra processes.
  app.get('/api/setup', async (c) => {
    const baked = readBakedInfo(bakedPath)
    // The stamp is a nicety; the registration commands are the reason this panel
    // exists. A probe that throws must cost the human the ONE line, never the
    // whole panel — which is what a 500 here would do (renderSetup's catch
    // leaves the section empty).
    let build: BuildStamp | null = null
    try {
      build = await stamp(baked, process.cwd())
    } catch {
      build = null
    }
    return c.json({ ...setupInfo(baked, runtimeHostKey, runtimeRoot, appRoot), build })
  })

  if (opts.ownerToken) {
    app.get('/api/owner', (c) => c.json({ token: opts.ownerToken }))
  }

  app.get('/api/activity', (c) => c.json(listActivity(db)))

  // Read-only, truthful claim-interval history for the dashboard: independent
  // of `/api/activity` and never imported into any attention/badge path.
  // `since_ms` is optional; when present it must be a finite number of epoch
  // milliseconds — a malformed value is a 400, not a silently-ignored filter.
  app.get('/api/activity/history', (c) => {
    const project = c.req.query('project')
    const sinceParam = c.req.query('since_ms')
    let sinceMs: number | undefined
    if (sinceParam !== undefined) {
      const parsed = Number(sinceParam)
      if (!Number.isFinite(parsed) || !Number.isFinite(new Date(parsed).getTime())) {
        return c.json({ ok: false, error: 'since_ms must be a valid epoch-millisecond date' }, 400)
      }
      sinceMs = parsed
    }
    return c.json(listActivitySpans(db, { project: project || undefined, sinceMs }))
  })

  // issue #30 — the cached PR state, one row per (repo, branch). Deliberately
  // PURE: it never triggers a gh fetch, so the frontend's 3s poll can hit it
  // freely. The only writer is the poller src/viewer-server.ts starts.
  app.get('/api/links', (c) => c.json(listSourceLinks(db)))

  app.post('/api/items/:id/resolve', (c) => {
    resolveItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/dismiss', (c) => {
    dismissItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/annotate', async (c) => {
    const { text } = await c.req.json<{ text: string }>()
    annotateItem(db, c.req.param('id'), text)
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/reply', async (c) => {
    const {
      text,
      context,
      kind,
      intent_client_id: intentClientId,
      intent_sequence: intentSequence,
      intent_action_id: intentActionId,
    } = await c.req.json<{
      text: string
      context?: string
      kind?: string
      intent_client_id?: unknown
      intent_sequence?: unknown
      intent_action_id?: unknown
    }>()
    const parsedKind = kind === undefined ? 'answer' : responseKind(kind)
    if (parsedKind === null) return c.json({ ok: false, error: 'invalid response kind' }, 400)
    const hasIntentClient = intentClientId !== undefined
    const hasIntentSequence = intentSequence !== undefined
    const hasIntentAction = intentActionId !== undefined
    if (new Set([hasIntentClient, hasIntentSequence, hasIntentAction]).size !== 1) {
      return c.json({ ok: false, error: 'reply intent metadata must be complete' }, 400)
    }
    const clientId = typeof intentClientId === 'string' ? intentClientId.trim() : ''
    const actionId = typeof intentActionId === 'string' ? intentActionId.trim() : ''
    if (hasIntentClient && (
      !clientId
      || clientId.length > 128
      || !actionId
      || actionId.length > 128
      || typeof intentSequence !== 'number'
      || !Number.isSafeInteger(intentSequence)
      || intentSequence < 1
    )) {
      return c.json({ ok: false, error: 'invalid reply intent metadata' }, 400)
    }
    // false = refused: an already-picked-up reply cannot be silently blanked out (src/store.ts)
    const ok = replyItem(
      db,
      c.req.param('id'),
      text,
      context,
      parsedKind,
      clientId && actionId && typeof intentSequence === 'number'
        ? { clientId, sequence: intentSequence, actionId }
        : undefined,
    )
    return c.json({ ok })
  })

  app.post('/api/items/:id/snooze', async (c) => {
    const body = await c.req.json<{ until?: string | null }>().catch(() => null)
    const until = body?.until === null || typeof body?.until === 'string' ? body.until : null
    const ok = snoozeItem(db, c.req.param('id'), until)
    return c.json({ ok })
  })

  app.get('/api/boards', (c) => c.json(listBoards(db)))

  app.get('/api/boards/archived', (c) => c.json(listBoards(db, { status: 'archived' })))

  app.post('/api/boards/:id/archive', async (c) => {
    const body = await c.req.json<{ expected_version?: number }>().catch(() => null)
    if (!Number.isInteger(body?.expected_version)) return c.json({ ok: false, error: 'expected_version required' }, 400)
    const ok = archiveBoard(db, c.req.param('id'), body!.expected_version!)
    return c.json(ok ? { ok: true } : { ok: false, reason: 'version_mismatch' })
  })

  app.post('/api/boards/:id/unarchive', async (c) => {
    const body = await c.req.json<{ expected_version?: number }>().catch(() => null)
    if (!Number.isInteger(body?.expected_version)) return c.json({ ok: false, error: 'expected_version required' }, 400)
    const ok = unarchiveBoard(db, c.req.param('id'), body!.expected_version!)
    return c.json(ok ? { ok: true } : { ok: false, reason: 'version_mismatch' })
  })

  app.post('/api/boards/:id/rows/:rowId/annotate', async (c) => {
    const { text, kind, expected_revision, expected_board_version } = await c.req.json<{
      text: string
      kind?: string
      expected_revision?: number
      expected_board_version?: number
    }>()
    const parsedKind = kind === undefined ? 'answer' : responseKind(kind)
    if (parsedKind === null) return c.json({ ok: false, error: 'invalid response kind' }, 400)
    if (!Number.isInteger(expected_revision) || !Number.isInteger(expected_board_version)) {
      return c.json({ ok: false, error: 'expected_revision and expected_board_version required' }, 400)
    }
    const ok = annotateBoardRow(
      db,
      c.req.param('rowId'),
      text,
      parsedKind,
      expected_revision,
      expected_board_version,
    )
    return c.json(ok ? { ok: true } : { ok: false, reason: 'version_mismatch' })
  })

  app.post('/api/boards/:id/rows/:rowId/snooze', async (c) => {
    const body = await c.req.json<{
      until?: string | null
      expected_revision?: number
      expected_board_version?: number
    }>().catch(() => null)
    if (!Number.isInteger(body?.expected_revision) || !Number.isInteger(body?.expected_board_version)) {
      return c.json({ ok: false, error: 'expected_revision and expected_board_version required' }, 400)
    }
    const until = body?.until === null || typeof body?.until === 'string' ? body.until : null
    const ok = snoozeBoardRow(
      db,
      c.req.param('rowId'),
      until,
      body?.expected_revision,
      body?.expected_board_version,
    )
    return c.json(ok ? { ok: true } : { ok: false, reason: 'version_mismatch' })
  })

  // issue #36 — the human's OTHER answer on a blocked row: "I have done my part".
  // The annotate route above is the words; this is the deed, and it is what makes
  // a blocked TASK row clearable at all without the asking agent still being alive.
  //
  // `{ handled: false }` is the undo, and it is the ONE thing here that can be
  // REFUSED: clearRowHandled will not blank a mark an agent has already been
  // handed (un-marking cannot un-tell them). That refusal is a 200 with
  // `{ ok: false }`, never a 4xx — postJSON() in public/app.js keys on the HTTP
  // status to decide "the write never happened", so a refusal dressed as an error
  // would show the human WRITE_FAILED and invite a retry that can never succeed.
  // Exactly the /api/items/:id/reply precedent.
  //
  // Missing/unparseable body ⇒ MARK. The affirmative action is the default because
  // it is the one the human reaches for, and because a body-less POST that quietly
  // UN-marked would be the most destructive possible reading of a dropped payload.
  // `ok:false` also covers an unknown row id: both store writes report whether they
  // matched a row, so the route never claims a success that never touched the
  // database.
  //
  // What the HUMAN sees in that case is NOT a message, despite an earlier version of
  // this comment saying so. A stale click on a row an agent has since deleted is
  // refused here, and then `reloadAndPaint()` destroys the row — and the error slot
  // with it — so the row simply disappears. That is defensible (the row is genuinely
  // gone, and disappearing is the truth) but it is silent, and the client's refusal
  // branch renders the UN-MARK wording for it, which is the wrong sentence. Both are
  // cosmetic only because the frame is unreachable; fix them together if this route
  // ever gains a failure mode that leaves the row on screen.
  app.post('/api/boards/:id/rows/:rowId/handled', async (c) => {
    const body = await c.req.json<{
      handled?: boolean
      expected_revision?: number
      expected_board_version?: number
    }>().catch(() => null)
    if (!Number.isInteger(body?.expected_revision) || !Number.isInteger(body?.expected_board_version)) {
      return c.json({ ok: false, error: 'expected_revision and expected_board_version required' }, 400)
    }
    const rowId = c.req.param('rowId')
    const ok = body?.handled === false
      ? clearRowHandled(db, rowId, body?.expected_revision, body?.expected_board_version)
      : markRowHandled(db, rowId, body?.expected_revision, body?.expected_board_version)
    if (ok) return c.json({ ok: true })
    const currentBoard = [
      ...listBoards(db),
      ...listBoards(db, { status: 'archived' }),
    ].find((board) => board.rows.some((row) => row.id === rowId))
    const current = currentBoard?.rows.find((row) => row.id === rowId)
    return c.json(
      current && (
        current.revision !== body?.expected_revision
        || currentBoard?.revision !== body?.expected_board_version
      )
        ? { ok: false, reason: 'version_mismatch' }
        : { ok: false },
    )
  })

  // ── project closure (issue #32) ───────────────────────────────────────────
  // The EFFECTIVE closed set — closures the derived reopen rule has not already
  // undone. Read by public/app.js (title badge, rail fold) AND by
  // electron/main.cjs (dock badge): tenet 3 says one attention set, and the main
  // process cannot see the renderer's localStorage, so this has to be server
  // state rather than a client-side toggle.
  app.get('/api/projects/closed', (c) => c.json(closedProjects(db)))

  // Project names are agent-authored free text and routinely contain '/' and
  // spaces, which Hono's :param will not match — hence a JSON body, never a path
  // param. The 400 matters: app.js's postJSON() keys on res.ok, so a rejected
  // close surfaces to the human instead of vanishing into an optimistic UI.
  app.post('/api/projects/close', async (c) => {
    const project = validProject(await c.req.json().catch(() => null))
    if (project === null) return c.json({ ok: false, error: 'project required' }, 400)
    closeProject(db, project)
    return c.json({ ok: true })
  })

  app.post('/api/projects/reopen', async (c) => {
    const project = validProject(await c.req.json().catch(() => null))
    if (project === null) return c.json({ ok: false, error: 'project required' }, 400)
    reopenProject(db, project)
    return c.json({ ok: true })
  })

  return app
}
