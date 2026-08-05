import { Hono } from 'hono'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import {
  listItems, resolveItem, dismissItem, annotateItem, replyItem, snoozeItem,
  listBoards, archiveBoard, unarchiveBoard, annotateBoardRow, snoozeBoardRow,
  markRowHandled, clearRowHandled, listActivity, listSourceLinks, defaultDbPath,
  closeProject, reopenProject, closedProjects,
} from './store.js'
import type { ResponseKind } from './store.js'
import { groupItems } from './group.js'
import { hooksSettingsBlock } from './hook.js'
import { buildStamp, readBakedInfo } from './stamp.js'
import type { BakedInfo, BuildStamp } from './stamp.js'

/** Seams, both test-only today — the production path passes neither. */
export interface ViewerOpts {
  /** where the packaged app's setup-info.json lives (a checkout has none) */
  setupInfoPath?: string
  /** the #40 build-stamp probe, injected so a test never shells out to git */
  stamp?: (baked: BakedInfo | null, cwd: string) => Promise<BuildStamp>
  /** Electron-only readiness capability; absent for browser/dev viewers. */
  ownerToken?: string
}

// Registration info for hooking new agents up to the MCP server. In a repo
// checkout the paths come from the running process; the packaged app instead
// ships a setup-info.json captured at package time (its own bundle cannot host
// the MCP server — the native module there is built for Electron, not Node).
function shellQuote(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`
}

function setupInfo(baked: BakedInfo | null): {
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
} {
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
    return c.json({ ...setupInfo(baked), build })
  })

  if (opts.ownerToken) {
    app.get('/api/owner', (c) => c.json({ token: opts.ownerToken }))
  }

  app.get('/api/activity', (c) => c.json(listActivity(db)))

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
    const { text, context, kind } = await c.req.json<{ text: string; context?: string; kind?: string }>()
    const parsedKind = kind === undefined ? 'answer' : responseKind(kind)
    if (parsedKind === null) return c.json({ ok: false, error: 'invalid response kind' }, 400)
    // false = refused: an already-picked-up reply cannot be silently blanked out (src/store.ts)
    const ok = replyItem(db, c.req.param('id'), text, context, parsedKind)
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
