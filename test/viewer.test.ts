import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cpSync, mkdirSync, writeFileSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, insertItem, listItems, getItem, annotateItem, replyItem, snoozeItem, answerItem, markReplySeen, upsertBoard as writeBoard, listBoards, annotateBoardRow, snoozeBoardRow, markRowHandled, markHandledDelivered, upsertActivity, endActivity, closeProject, closedProjects, upsertSourceLink, archiveBoard, resolveItem, upsertIssueSnapshot, stopItemWatch, stopBoardRowWatch } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { releaseRuntime, registerHost } from './release-runtime.js'
import { facts, snapshot } from './issue-fixtures.js'
import { scratchDir } from './scratch.js'

function freshDb(): Database.Database {
  return openDb(join(scratchDir('view-'), 'inbox.db'))
}

// /api/setup and /api/version read each host's registration from the home
// directory's config files (#197). Every test here points them at an empty
// scratch home, never the real one.
const NO_AGENTS = { agentHome: scratchDir('view-home-') }

function upsertBoard(db: Database.Database, input: Parameters<typeof writeBoard>[1]) {
  const existing = [...listBoards(db), ...listBoards(db, { status: 'archived' })]
    .find((board) => board.project === input.project && board.title === input.title)
  return writeBoard(db, {
    ...input,
    expectedVersion: input.expectedVersion ?? existing?.revision,
    rows: input.rows.map((row) => {
      const current = existing?.rows.find((candidate) => candidate.label === row.label)
      return current && row.revision === undefined
        ? { ...row, revision: current.revision }
        : row
    }),
  })
}

describe('viewer api', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('stamps a stable boot id header so stale tabs can self-reload', async () => {
    const app = createViewer(db)
    const a = await app.request('/api/items')
    const b = await app.request('/api/boards')
    expect(a.headers.get('x-inbox-boot')).toBeTruthy()
    expect(a.headers.get('x-inbox-boot')).toBe(b.headers.get('x-inbox-boot')) // stable within one server
    expect(createViewer(db) === app).toBe(false)
  })

  it('GET /api/setup returns agent-registration commands and the reporting snippet', async () => {
    const app = createViewer(db, NO_AGENTS)
    const res = await app.request('/api/setup')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.claudeCommand).toContain('claude mcp add --scope user agent-inbox')
    expect(body.claudeCommand).toContain('dist/mcp-server.js')
    expect(body.copilotConfig).toContain('mcp-server.js')
    expect(body.agentInstallCommand).toContain('npm run install:agents -- --apply')
    expect(body.claudeInstallCommand).toContain('--target claude')
    expect(body.copilotInstallCommand).toContain('--target copilot')
    expect(body.snippet).toContain('flag')          // the reporting snippet text
    expect(body.snippet).toContain('board_upsert')
    // the Setup pane serves docs/reporting-snippet.md verbatim, so the shipped
    // emit contract and the pane cannot drift apart on the dual-channel rule (#29).
    // Pin the tool token only, never the prose around it.
    expect(body.snippet).toContain('answer(')
    expect(body.dbPath).toContain('.agent-inbox')
  })

  it('exposes an Electron ownership capability only when explicitly configured', async () => {
    expect((await createViewer(db).request('/api/owner')).status).toBe(404)
    const res = await createViewer(db, { ownerToken: 'private-ready-token' }).request('/api/owner')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ token: 'private-ready-token' })
  })

  it('GET /api/setup carries a hand-mergeable backstop-hooks block (#10 / #21)', async () => {
    const body = await (await createViewer(db, NO_AGENTS).request('/api/setup')).json()
    expect(typeof body.hooksSettings).toBe('string')
    const parsed = JSON.parse(body.hooksSettings)
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'],
    )
    // exec form: no shell tokenisation, so a repo path with a quote or a $ is safe
    expect(parsed.hooks.Notification[0].hooks[0].args[0]).toMatch(/dist\/hook-cli\.js$/)
    expect(parsed.hooks.Notification[0].hooks[0].command.startsWith('/')).toBe(true)
    // no matcher: the CLI's Notification matcher matches notification_type, and
    // AGENT_INBOX_HOOK_NOTIFY_TYPES is the single gate (docs/hooks.md)
    expect(parsed.hooks.Notification[0].matcher).toBeUndefined()
    expect(parsed.hooks.SessionStart[0].matcher).toBe('startup|resume')
    // Stop carries BOTH halves of #21: the synchronous bounce and the watcher
    expect(parsed.hooks.Stop[0].hooks).toHaveLength(2)
    expect(parsed.hooks.Stop[0].hooks.map((h: { args: string[] }) => h.args[1])).toEqual(['stop', 'watch'])
    expect(parsed.hooks.Stop[0].hooks[1].asyncRewake).toBe(true)
    // the panel cannot run selftest, so it must say so rather than imply safety
    expect(body.hooksNote).toContain('install:hooks')
  })

  it('GET /api/activity returns live sessions with children', async () => {
    upsertActivity(db, { session: 's1', project: 'p', stream: 'main', agent: 'claude-code', doing: 'reviewing', children: [{ name: 'kid', doing: 'grep' }] })
    const res = await createViewer(db).request('/api/activity')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].doing).toBe('reviewing')
    expect(body[0].children[0].name).toBe('kid')
  })

  // issue #197 — one additive per-row field. The response stays a bare array of
  // rows: electron/main.cjs and the Live strip both read it as one.
  it('GET /api/activity rows carry the server build each session registered with, null for a legacy row', async () => {
    upsertActivity(db, { session: 'new', project: 'p', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false, server_version: '1.2.8', server_source: 'runtime' })
    upsertActivity(db, { session: 'old', project: 'p', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false })
    const body = await (await createViewer(db).request('/api/activity')).json() as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    const bySession = new Map(body.map((a) => [a.session, a]))
    expect(bySession.get('new')).toMatchObject({ server_version: '1.2.8', server_source: 'runtime' })
    expect(bySession.get('old')).toMatchObject({ server_version: null, server_source: null })
    expect(Object.keys(bySession.get('new')!).sort()).toEqual([
      'agent', 'children', 'detail', 'doing', 'idle', 'last_call_at', 'last_doing',
      'project', 'server_source', 'server_version', 'session', 'started_at', 'stream', 'updated_at',
    ])
  })

  describe('GET /api/version — what a restarted session would load (#197)', () => {
    const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    const setupInfo = (info: unknown): string => {
      const path = join(scratchDir('view-version-'), 'setup-info.json')
      writeFileSync(path, JSON.stringify(info))
      return path
    }
    const read = async (app: ReturnType<typeof createViewer>): Promise<unknown> => (await app.request('/api/version')).json()
    const UNREGISTERED = { claude: { kind: 'none' }, copilot: { kind: 'none' } }

    it('a checkout, or a bundle packaged from one, answers with its own package version; the runtime question does not apply', async () => {
      const missing = join(scratchDir('view-version-'), 'setup-info.json')
      const res = await createViewer(db, { ...NO_AGENTS, setupInfoPath: missing }).request('/api/version')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ current: PKG.version, mode: 'dev', runtimeInstalled: null, updatable: false, hosts: UNREGISTERED })
      const devBundle = createViewer(db, { ...NO_AGENTS, setupInfoPath: setupInfo({ repoRoot: '/checkout', nodeBin: '/node' }) })
      expect(await read(devBundle)).toEqual({ current: PKG.version, mode: 'dev', runtimeInstalled: null, updatable: false, hosts: UNREGISTERED })
    })

    it('a release answers with its baked version and whether that exact runtime is installed for this host', async () => {
      const release = releaseRuntime('2.0.0')
      const app = createViewer(db, release.viewer)
      // not installed, and Setup can install it: its source payload verifies
      expect(await read(app)).toEqual({ current: '2.0.0', mode: 'release', runtimeInstalled: false, updatable: true, hosts: UNREGISTERED })
      // a Setup install is noticed on the very next read, memo or not
      release.install()
      expect(await read(app)).toEqual({ current: '2.0.0', mode: 'release', runtimeInstalled: true, updatable: true, hosts: UNREGISTERED })
    })

    // Live may point at Setup's update only when Setup would actually offer it,
    // and Setup offers it only while the app's own runtime verifies — installed
    // or not (review of #205).
    it('says Setup cannot update agents when the app\'s runtime no longer verifies, even with one installed', async () => {
      const release = releaseRuntime('2.0.0')
      release.install()
      writeFileSync(join(release.payloadDir, 'dist', 'mcp-server.js'), '// tampered after install\n')
      expect(await read(createViewer(db, release.viewer)))
        .toEqual({ current: '2.0.0', mode: 'release', runtimeInstalled: true, updatable: false, hosts: UNREGISTERED })
    })

    it('answers null for the runtime when Setup could not install it here, so no advice is offered', async () => {
      const noHostPayload = releaseRuntime('2.0.0', { hostPayload: false })
      expect(await read(createViewer(db, noHostPayload.viewer)))
        .toEqual({ current: '2.0.0', mode: 'release', runtimeInstalled: null, updatable: false, hosts: UNREGISTERED })
      const unverifiable = releaseRuntime('2.0.0')
      writeFileSync(join(unverifiable.payloadDir, 'dist', 'mcp-server.js'), '// tampered source\n')
      expect(await read(createViewer(db, unverifiable.viewer)))
        .toEqual({ current: '2.0.0', mode: 'release', runtimeInstalled: null, updatable: false, hosts: UNREGISTERED })
    })

    it('a release with no baked version answers null rather than guessing', async () => {
      const app = createViewer(db, { ...NO_AGENTS, setupInfoPath: setupInfo({ schema: 2, runtimePayloads: {} }) })
      expect(await read(app)).toEqual({ current: null, mode: 'release', runtimeInstalled: null, updatable: false, hosts: UNREGISTERED })
    })

    // Part 2: a restart loads whatever THAT host is registered to run, so Live
    // gets each host's registration — its kind and, for Setup's runtime, its
    // version. Nothing else: no path, no runtime id, no config content.
    it('says which build each host is registered to run, and nothing more', async () => {
      const release = releaseRuntime('2.0.0')
      const old = release.installVersion('1.2.8')
      release.register('claude', old)
      release.register('copilot', release.install())
      const app = createViewer(db, release.viewer)

      const body = await read(app)
      expect(body).toEqual({
        current: '2.0.0',
        mode: 'release',
        runtimeInstalled: true,
        updatable: true,
        hosts: { claude: { kind: 'runtime', version: '1.2.8' }, copilot: { kind: 'runtime', version: '2.0.0' } },
      })
      expect(JSON.stringify(body)).not.toContain(release.home)

      // a checkout and an unrecognized command are reported by kind alone
      const checkout = scratchDir('view-checkout-')
      mkdirSync(join(checkout, 'dist'))
      writeFileSync(join(checkout, 'package.json'), '{"name":"agent-inbox"}')
      writeFileSync(join(checkout, 'dist', 'mcp-server.js'), '')
      registerHost(release.home, 'claude', process.execPath, join(checkout, 'dist', 'mcp-server.js'))
      registerHost(release.home, 'copilot', process.execPath, join(checkout, 'package.json'))
      const later = await read(app) as { hosts: unknown }
      expect(later.hosts).toEqual({ claude: { kind: 'checkout' }, copilot: { kind: 'other' } })
      expect(JSON.stringify(later)).not.toContain(checkout)
    })

    it('/api/setup carries each host\'s registration for the Setup panel, and how to move hooks once the runtime is installed', async () => {
      const release = releaseRuntime('2.0.0')
      const old = release.installVersion('1.2.8')
      const oldId = old.slice(release.runtimeRoot.length + 1)
      release.register('claude', old)
      release.registerHooks(old)
      const app = createViewer(db, release.viewer)
      const agents = async () => (await (await app.request('/api/setup')).json()).agents

      expect(await agents()).toEqual({
        current: '2.0.0',
        updatable: true,
        claude: { kind: 'runtime', version: '1.2.8', runtimeId: oldId },
        copilot: { kind: 'none' },
        hooks: { kind: 'runtime', version: '1.2.8', runtimeId: oldId },
        hooksCommand: '',
      })

      const installed = release.install()
      expect((await agents()).hooksCommand)
        .toBe(`bash '${join(installed, 'scripts', 'install-hooks.sh')}' --apply`)

      // a release whose payload Setup cannot install offers no update
      const noPayload = releaseRuntime('2.0.0', { hostPayload: false })
      noPayload.register('claude', noPayload.installVersion('1.2.8'))
      const fixed = (await (await createViewer(db, noPayload.viewer).request('/api/setup')).json()).agents
      expect(fixed).toMatchObject({ current: '2.0.0', updatable: false, claude: { kind: 'runtime', version: '1.2.8' } })

      // a checkout viewer reports registrations, but Setup does not manage versions there
      const dev = (await (await createViewer(db, { ...NO_AGENTS, setupInfoPath: join(release.home, 'none.json') }).request('/api/setup')).json()).agents
      expect(dev).toEqual({
        current: null, updatable: false,
        claude: { kind: 'none' }, copilot: { kind: 'none' }, hooks: { kind: 'none' }, hooksCommand: '',
      })
    })

    it('never returns another MCP server\'s config from either route', async () => {
      const release = releaseRuntime('2.0.0')
      const old = release.installVersion('1.2.8')
      writeFileSync(join(release.home, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: 'someone@example.com' },
        mcpServers: {
          vault: { command: '/opt/vault/bin/mcp', args: ['--token', 'ghp_SECRET'], env: { VAULT_TOKEN: 'sk-SECRET' } },
          'agent-inbox': { command: join(old, 'bin', 'node'), args: [join(old, 'dist', 'mcp-server.js')], env: { MINE: 'sk-SECRET-OWN' } },
        },
      }))
      const app = createViewer(db, release.viewer)
      for (const route of ['/api/version', '/api/setup']) {
        const text = await (await app.request(route)).text()
        for (const secret of ['/opt/vault', 'ghp_SECRET', 'sk-SECRET', 'someone@example.com']) {
          expect(text, `${route}: ${secret}`).not.toContain(secret)
        }
      }
    })

    // /api/setup and /api/version share ONE verified runtime lookup. Verifying
    // hashes a whole runtime on the viewer thread (Electron main in the packaged
    // app), so it runs again only when something it looked at has changed.
    const RUNTIME_VERIFY = createRequire(import.meta.url)('../electron/runtime-verify.cjs') as {
      verifyRuntimePayload(opts: { root: string }): { manifest: { runtimeId: string } }
    }
    const counting = () => {
      const roots: string[] = []
      const calls: Array<{ root: string; requiredFiles?: string[] }> = []
      const runtimeVerifier = (opts: { root: string; requiredFiles?: string[] }) => {
        roots.push(opts.root)
        calls.push(opts)
        return RUNTIME_VERIFY.verifyRuntimePayload(opts)
      }
      // a registered runtime is checked for ownership only (#197 part 2): no
      // required files, unlike the release lookups for this app's own runtime
      const ownership = (dir: string): number =>
        calls.filter((c) => c.root === realpathSync(dir) && c.requiredFiles?.length === 0).length
      return { roots, runtimeVerifier, ownership }
    }

    it('verifies a registered older runtime once, reuses the release lookup for the current one, and re-reads a changed host', async () => {
      const release = releaseRuntime('2.0.0')
      const old = release.installVersion('1.2.8')
      const current = release.install()
      release.register('claude', old)
      release.register('copilot', current)
      const verifier = counting()
      const app = createViewer(db, { ...release.viewer, runtimeVerifier: verifier.runtimeVerifier })

      expect(await read(app)).toMatchObject({ hosts: { claude: { version: '1.2.8' }, copilot: { version: '2.0.0' } } })
      expect((await (await app.request('/api/setup')).json()).agents.claude).toMatchObject({ version: '1.2.8' })
      expect(await read(app)).toMatchObject({ hosts: { claude: { version: '1.2.8' } } })
      expect(verifier.ownership(old)).toBe(1)
      // the shared release lookup already verified the current runtime, more strictly
      expect(verifier.ownership(current)).toBe(0)

      // Claude Code rewrites ~/.claude.json all the time: re-reading it must not
      // hash the runtime it still points at again
      const claudeJson = join(release.home, '.claude.json')
      const config = JSON.parse(readFileSync(claudeJson, 'utf8')) as Record<string, unknown>
      writeFileSync(claudeJson, JSON.stringify({ ...config, numStartups: 42 }))
      expect(await read(app)).toMatchObject({ hosts: { claude: { kind: 'runtime', version: '1.2.8' } } })
      expect(verifier.ownership(old)).toBe(1)

      // an update moves Claude to the current runtime: its config changed, so
      // the next read says so without hashing anything again
      release.register('claude', current)
      expect(await read(app)).toMatchObject({ hosts: { claude: { kind: 'runtime', version: '2.0.0' } } })
      expect(verifier.ownership(current)).toBe(0)
      expect(verifier.ownership(old)).toBe(1)

      // a pruned runtime leaves a registration nothing can verify
      release.register('claude', old)
      rmSync(old, { recursive: true })
      expect(await read(app)).toMatchObject({ hosts: { claude: { kind: 'unknown' } } })
    })

    it('notices a change made through a symlinked host config, at its target', async () => {
      const release = releaseRuntime('2.0.0')
      const old = release.installVersion('1.2.8')
      const current = release.install()
      const dotfiles = join(release.home, 'dotfiles')
      mkdirSync(dotfiles)
      release.register('claude', old)
      renameSync(join(release.home, '.claude.json'), join(dotfiles, 'claude.json'))
      symlinkSync(join(dotfiles, 'claude.json'), join(release.home, '.claude.json'))
      const app = createViewer(db, release.viewer)
      expect(await read(app)).toMatchObject({ hosts: { claude: { kind: 'runtime', version: '1.2.8' } } })

      // edit only the target, as a dotfiles checkout or `claude mcp add` through the link does
      const config = JSON.parse(readFileSync(join(dotfiles, 'claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
      config.mcpServers['agent-inbox'] = { command: join(current, 'bin', 'node'), args: [join(current, 'dist', 'mcp-server.js')] }
      writeFileSync(join(dotfiles, 'claude.json'), JSON.stringify(config))
      expect(await read(app)).toMatchObject({ hosts: { claude: { kind: 'runtime', version: '2.0.0' } } })
    })

    it('verifies once for /api/setup and /api/version together, and repeated reads do not re-hash', async () => {
      const release = releaseRuntime('2.0.0')
      release.install()
      const verifier = counting()
      const app = createViewer(db, { ...release.viewer, runtimeVerifier: verifier.runtimeVerifier })
      expect((await (await app.request('/api/setup')).json()).runtimeAvailable).toBe(true)
      const verified = verifier.roots.length
      expect(verified).toBeGreaterThan(0)
      expect(await read(app)).toMatchObject({ runtimeInstalled: true })
      expect((await (await app.request('/api/setup')).json()).runtimeAvailable).toBe(true)
      expect(await read(app)).toMatchObject({ runtimeInstalled: true })
      expect(verifier.roots).toHaveLength(verified)
    })

    it('re-verifies after an install, a manifest change, an atomic replace or a removal', async () => {
      const release = releaseRuntime('2.0.0')
      const verifier = counting()
      const app = createViewer(db, { ...release.viewer, runtimeVerifier: verifier.runtimeVerifier })
      const reverified = async (expected: boolean | null): Promise<void> => {
        const before = verifier.roots.length
        expect(await read(app)).toMatchObject({ runtimeInstalled: expected })
        expect(verifier.roots.length).toBeGreaterThan(before)
      }
      await reverified(false) // nothing installed yet; Setup can install it
      const installed = release.install()
      await reverified(true) // a Setup install
      const manifest = join(installed, 'runtime-manifest.json')
      const original = readFileSync(manifest)
      writeFileSync(manifest, Buffer.concat([original, Buffer.from('\n')]))
      await reverified(false) // its manifest changed in place
      writeFileSync(manifest, original)
      // pin every time the key reads to a whole millisecond, so the replace below
      // can put each one back exactly
      const PINNED = new Date('2026-10-17T10:00:00.000Z')
      const pin = (...paths: string[]): void => { for (const path of paths) utimesSync(path, PINNED, PINNED) }
      pin(release.runtimeRoot, installed, manifest)
      await reverified(true)
      // an atomic replace: a staged tree renamed over the same name, with every
      // size and mtime the key reads unchanged — only identity and ctime differ
      const staged = join(release.runtimeRoot, '.staged')
      cpSync(installed, staged, { recursive: true })
      writeFileSync(join(staged, 'dist', 'mcp-server.js'), '// tampered\n')
      rmSync(installed, { recursive: true })
      renameSync(staged, installed)
      pin(release.runtimeRoot, installed, manifest)
      await reverified(false)
      rmSync(installed, { recursive: true })
      await reverified(false) // removed
      // the app's own payload is part of the key too
      writeFileSync(join(release.payloadDir, 'runtime-manifest.json'), '{}')
      await reverified(null)
    })

    it('still re-verifies an edit deep inside an installed runtime after a long backstop', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const release = releaseRuntime('2.0.0')
        const installed = release.install()
        const app = createViewer(db, release.viewer)
        expect(await read(app)).toMatchObject({ runtimeInstalled: true })
        // an in-place edit below the runtime directory changes nothing the key reads
        writeFileSync(join(installed, 'dist', 'mcp-server.js'), '// tampered after install\n')
        vi.setSystemTime(Date.now() + 5 * 60_000)
        expect(await read(app)).toMatchObject({ runtimeInstalled: true })
        vi.setSystemTime(Date.now() + 6 * 60_000)
        expect(await read(app)).toMatchObject({ runtimeInstalled: false })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('GET /api/items returns grouped items', async () => {
    insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'q' })
    const app = createViewer(db)
    const res = await app.request('/api/items')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.needsYou[0].items[0].title).toBe('q')
  })

  describe('GET /api/activity/history — truthful claim-interval history', () => {
    const START = Date.parse('2026-08-01T09:00:00.000Z')

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(START)
    })
    afterEach(() => { vi.useRealTimers() })

    it('returns an empty list when nothing has ever claimed work', async () => {
      const res = await createViewer(db).request('/api/activity/history')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
    })

    it('returns closed and open spans with the shape the dashboard needs', async () => {
      upsertActivity(db, { session: 's1', project: 'p', stream: 'main', agent: 'claude-code', doing: 'reviewing #74' })
      vi.setSystemTime(START + 5 * 60_000)
      endActivity(db, 's1')
      upsertActivity(db, { session: 's2', project: 'p', stream: 'main', agent: 'claude-code', doing: 'shipping' })

      const res = await createViewer(db).request('/api/activity/history')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveLength(2)
      const closed = body.find((s: { session: string }) => s.session === 's1')
      const open = body.find((s: { session: string }) => s.session === 's2')
      expect(closed.doing).toBe('reviewing #74')
      expect(closed.ended_at).toBe(new Date(START + 5 * 60_000).toISOString())
      expect(closed.effective_ended_at).toBe(closed.ended_at)
      expect(open.ended_at).toBeNull()
      expect(open.effective_ended_at).toBeNull()
    })

    it('filters by project', async () => {
      upsertActivity(db, { session: 's1', project: 'proj-a', stream: '', agent: 'a', doing: 'task a' })
      upsertActivity(db, { session: 's2', project: 'proj-b', stream: '', agent: 'a', doing: 'task b' })
      const res = await createViewer(db).request('/api/activity/history?project=proj-a')
      const body = await res.json()
      expect(body.map((s: { session: string }) => s.session)).toEqual(['s1'])
    })

    it('filters by since_ms, excluding spans that ended before the window and keeping ongoing ones', async () => {
      upsertActivity(db, { session: 'old', project: 'p', stream: '', agent: 'a', doing: 'old task' })
      vi.setSystemTime(START + 5 * 60_000)
      endActivity(db, 'old')
      vi.setSystemTime(START + 20 * 60_000)
      upsertActivity(db, { session: 'ongoing', project: 'p', stream: '', agent: 'a', doing: 'still going' })

      const res = await createViewer(db).request(`/api/activity/history?since_ms=${START + 15 * 60_000}`)
      const body = await res.json()
      expect(body.map((s: { session: string }) => s.session)).toEqual(['ongoing'])
    })

    it('rejects a non-numeric since_ms with 400 rather than silently ignoring it', async () => {
      const res = await createViewer(db).request('/api/activity/history?since_ms=not-a-number')
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.ok).toBe(false)
    })

    it('rejects a finite number outside the JavaScript date range', async () => {
      const res = await createViewer(db).request('/api/activity/history?since_ms=1e20')
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.ok).toBe(false)
    })

    it('is independent of /api/activity — a span survives a session ending even though live presence drops it', async () => {
      upsertActivity(db, { session: 's1', project: 'p', stream: '', agent: 'a', doing: 'reviewing' })
      endActivity(db, 's1')
      const live = await (await createViewer(db).request('/api/activity')).json()
      expect(live).toEqual([]) // ended session drops out of live presence
      const history = await (await createViewer(db).request('/api/activity/history')).json()
      expect(history).toHaveLength(1) // but the span survives
    })
  })

  it('POST resolve, dismiss, annotate preserve feedback and refuse closed annotation edits', async () => {
    const a = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'a' })
    const b = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'b' })
    const app = createViewer(db)
    const annRes = await app.request(`/api/items/${a}/annotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'noted' }),
    })
    expect(annRes.status).toBe(200)
    expect(await annRes.json()).toEqual({ ok: true })
    expect((await app.request(`/api/items/${a}/resolve`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/items/${b}/dismiss`, { method: 'POST' })).status).toBe(200)
    const late = await app.request(`/api/items/${a}/annotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'late rewrite' }),
    })
    expect(await late.json()).toEqual({ ok: false })
    const rows = listItems(db)
    expect(rows.find((r) => r.id === a)!.status).toBe('resolved')
    expect(rows.find((r) => r.id === a)!.annotation).toBe('noted')
    expect(rows.find((r) => r.id === b)!.status).toBe('dismissed')
  })

  it('POST reply writes the answer + context and resets pickup; options surface in GET', async () => {
    const id = insertItem(db, {
      project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'which auth?',
      options: [{ label: 'clerk', recommended: true }, { label: 'auth0', detail: 'more setup' }],
    })
    const app = createViewer(db)
    const got = await (await app.request('/api/items')).json()
    expect(got.needsYou[0].items[0].options).toHaveLength(2)
    markReplySeen(db, id, null) // pretend a stale pickup exists; a new reply must reset it
    const res = await app.request(`/api/items/${id}/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'clerk', context: 'start with the TMCC thread' }),
    })
    expect(res.status).toBe(200)
    const item = listItems(db)[0]!
    expect(item.reply).toBe('clerk')
    expect(item.reply_context).toBe('start with the TMCC thread')
    expect(item.reply_seen_at).toBeNull()
    expect(item.status).toBe('open') // replying is not resolving — the agent still has to act
  })

  it('rejects a late lower reply intent from the same viewer window', async () => {
    const id = insertItem(db, {
      project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'ordered reply',
    })
    const app = createViewer(db)
    const post = (text: string, sequence: number, actionId: string) => app.request(`/api/items/${id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        intent_client_id: 'viewer-window-a',
        intent_sequence: sequence,
        intent_action_id: actionId,
      }),
    })

    expect(await (await post('intent B', 2, 'action-b')).json()).toEqual({ ok: true })
    expect(await (await post('late intent A', 1, 'action-a')).json()).toEqual({ ok: false })
    expect(listItems(db).find((item) => item.id === id)?.reply).toBe('intent B')

    const incomplete = await app.request(`/api/items/${id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'invalid',
        intent_client_id: 'viewer-window-a',
        intent_sequence: 3,
      }),
    })
    expect(incomplete.status).toBe(400)

    const malformed = await app.request(`/api/items/${id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'invalid',
        intent_client_id: 42,
        intent_sequence: 3,
        intent_action_id: 'action-invalid',
      }),
    })
    expect(malformed.status).toBe(400)

    const clonedId = insertItem(db, {
      project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'cloned tabs',
    })
    const clonedPost = (text: string, actionId: string) => app.request(`/api/items/${clonedId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        intent_client_id: 'cloned-session-storage',
        intent_sequence: 1,
        intent_action_id: actionId,
      }),
    })
    expect(await (await clonedPost('first tab', 'action-tab-a')).json()).toEqual({ ok: true })
    expect(await (await clonedPost('second tab', 'action-tab-b')).json()).toEqual({ ok: true })
    expect(await (await clonedPost('replayed first tab', 'action-tab-a')).json()).toEqual({ ok: true })
    expect(listItems(db).find((item) => item.id === clonedId)?.reply).toBe('second tab')
  })

  // #29: the channel is stamped inside the store, so the viewer needs no code of its
  // own — SELECT * already carries reply_source out through GET /api/items, which is
  // where the card's "via chat" provenance chip reads it from.
  it('the answer channel is stamped by the store and surfaces unchanged through GET /api/items', async () => {
    const viaInbox = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'which auth?' })
    const viaChat = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'which db?' })
    const app = createViewer(db)
    const res = await app.request(`/api/items/${viaInbox}/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'clerk' }),
    })
    expect(res.status).toBe(200)
    expect(answerItem(db, viaChat, 'sqlite').ok).toBe(true)

    const body = await (await app.request('/api/items')).json()
    const rendered: Record<string, string | null> = {}
    for (const group of body.needsYou) for (const it of group.items) rendered[it.title] = it.reply_source
    expect(rendered['which auth?']).toBe('inbox')
    expect(rendered['which db?']).toBe('agent')
  })

  it('GET /api/items exposes the asking session so the viewer can judge liveness', async () => {
    insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'q', session: 'sess-1' })
    insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'n' })
    const body = await (await createViewer(db).request('/api/items')).json()
    expect(body.needsYou[0].items[0].session).toBe('sess-1')
    expect(body.notes[0].items[0].session).toBeNull()
  })
})

// issue #40 — "which build is this" must be answerable in one glance, and a
// packaged bundle must say when the checkout it was built from has moved on.
// These run END TO END: a real setup-info.json over a real temp git repo, through
// the real /api/setup handler, with the real git subprocess doing the comparing.
describe('GET /api/setup carries the build stamp (issue #40)', () => {
  function tmpRepo(): string {
    const dir = scratchDir('setup-repo-')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
    return dir
  }
  function commitIn(dir: string): string {
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'x'], { cwd: dir })
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  }
  function bakedFile(body: unknown): string {
    const p = join(scratchDir('setup-info-'), 'setup-info.json')
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
    return p
  }
  const setup = async (path?: string): Promise<Record<string, never> & { build: { drift: string; commit: string | null; head: string | null; builtAt: string | null; repoRoot: string | null }; note: string; claudeCommand: string }> => {
    const res = await createViewer(freshDb(), path ? { ...NO_AGENTS, setupInfoPath: path } : NO_AGENTS).request('/api/setup')
    expect(res.status).toBe(200)
    return await res.json()
  }

  it('a checkout reports its own live HEAD and never claims staleness against itself', async () => {
    const body = await setup(join(tmpdir(), 'no-such-setup-info-40.json'))

    expect(body.build.drift).toBe('dev')
    expect(body.build.commit).toBeNull()
    // this repo IS a checkout, so the viewer process can read its HEAD
    expect(body.build.head).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
  })

  it('a packaged bundle reports the commit and time it was built from', async () => {
    const dir = tmpRepo()
    const sha = commitIn(dir)
    const path = bakedFile({ repoRoot: dir, nodeBin: '/opt/node', commit: sha, builtAt: '2026-07-25T12:00:00.000Z' })

    const body = await setup(path)

    expect(body.build).toMatchObject({ drift: 'current', commit: sha, head: sha, builtAt: '2026-07-25T12:00:00.000Z', repoRoot: dir })
    // …and it still serves the registration paths it always did
    expect(body.claudeCommand).toContain('/opt/node')
    expect(body.note).toContain(dir)
  })

  it('says "stale" once the checkout has moved on past the baked commit', async () => {
    const dir = tmpRepo()
    const sha = commitIn(dir)
    const moved = commitIn(dir)

    const body = await setup(bakedFile({ repoRoot: dir, nodeBin: '/opt/node', commit: sha, builtAt: '2026-07-25T12:00:00.000Z' }))

    expect(body.build.drift).toBe('stale')
    expect(body.build.head).toBe(moved)
  })

  it('a corrupt setup-info.json fails open: 200, dev paths, exactly as before #40', async () => {
    // BEFORE #40 this threw straight out of the handler (JSON.parse on an
    // unguarded readFileSync) and took the whole Setup panel with it.
    const body = await setup(bakedFile('{ this is not json'))

    expect(body.note).toBe('')
    expect(body.claudeCommand).toContain('dist/mcp-server.js')
    expect(body.build.drift).toBe('dev')
  })

  it('a bundle packaged before #40 keeps working and simply has nothing to say', async () => {
    const body = await setup(bakedFile({ repoRoot: '/gone/repo', nodeBin: '/opt/node' }))

    expect(body.build).toMatchObject({ drift: 'unknown', commit: null, builtAt: null, head: null })
    expect(body.claudeCommand).toContain('/opt/node')
  })
})

// issue #30 — read-only by design: the 3s frontend poll hits this freely and it
// never triggers a gh fetch. Only the poller in src/viewer-server.ts writes here.
describe('source links api (issue #30)', () => {
  it('GET /api/links returns the cached PR state per (repo, branch)', async () => {
    const db = freshDb()
    upsertSourceLink(db, {
      repo: 'shariqh/agent-inbox', branch: '30-x', pr_number: 41,
      pr_url: 'https://github.com/shariqh/agent-inbox/pull/41', pr_title: 'source + PR links',
      pr_state: 'OPEN', pr_draft: true, review_decision: 'APPROVED', checks: 'passing',
      issue_number: 30, issue_url: 'https://github.com/shariqh/agent-inbox/issues/30',
      tldr: 'links the inbox to its PR',
    })
    const res = await createViewer(db).request('/api/links')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].repo).toBe('shariqh/agent-inbox')
    expect(body[0].branch).toBe('30-x')
    expect(body[0].pr_number).toBe(41)
    expect(body[0].pr_state).toBe('OPEN')
    expect(body[0].checks).toBe('passing')
    expect(body[0].tldr).toBe('links the inbox to its PR')
    // a boolean over the wire, never SQLite's 0/1 — the frontend branches on it
    expect(body[0].pr_draft).toBe(true)
  })

  it('is empty and 200 on a fresh db, so the frontend renders exactly as it does today', async () => {
    const res = await createViewer(freshDb()).request('/api/links')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

// Issue #103 (PR1a): the sub-issue graph. Empty until the viewer's poller
// (PR1b) caches snapshots; these tests cache them directly through the store.
describe('issue graph api (issue #103)', () => {
  const REPO = 'shariqh/agent-inbox'
  const SCOPE = { project: 'agent-inbox', stream: '120-ahp-input', agent: 'test' }

  it('is the complete empty graph on a fresh db, so nothing renders differently', async () => {
    const res = await createViewer(freshDb()).request('/api/issues')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      version: 1, nodes: [], edges: [], roots: [], aliases: {},
      truncated: { roots: 0, ancestors: 0, children: 0, edges: 0 },
    })
  })

  it('serves what open items and plans link: closed projects and archived plans displayed, not refreshed', async () => {
    const db = freshDb()
    const startedAt = new Date().toISOString()
    const cache = (key: string, opts: Parameters<typeof snapshot>[1] = {}) => {
      const hash = key.indexOf('#')
      upsertIssueSnapshot(db, { repo: key.slice(0, hash), number: Number(key.slice(hash + 1)), snapshot: snapshot(key, opts), startedAt })
    }
    insertItem(db, { ...SCOPE, kind: 'question', title: 'Which parent?', repo: REPO, issue_ref: 120 })
    upsertBoard(db, { ...SCOPE, stream: '119-adapter', title: 'Old plan', rows: [], repo: REPO, issueRef: 119 })
    const old = listBoards(db).find((board) => board.title === 'Old plan')!
    archiveBoard(db, old.id, old.revision)
    insertItem(db, { ...SCOPE, project: 'retired', kind: 'note', title: 'Peek', repo: 'a/x', issue_ref: 5 })
    closeProject(db, 'retired')
    resolveItem(db, insertItem(db, { ...SCOPE, kind: 'note', title: 'History', repo: REPO, issue_ref: 121 }))
    // a PR row cached before closing references were recorded: display-only (§4.2)
    insertItem(db, { ...SCOPE, stream: '122-legacy', kind: 'note', title: 'Legacy', repo: REPO, issue_ref: 122 })
    upsertSourceLink(db, { repo: REPO, branch: '122-legacy', pr_number: 9, pr_state: 'OPEN', issue_number: 122 })
    cache(`${REPO}#120`, { ancestors: [facts(`${REPO}#117`, { children_total: 10, children_completed: 0 })] })
    for (const key of [`${REPO}#119`, 'a/x#5', `${REPO}#121`, `${REPO}#122`]) cache(key)

    const body = await (await createViewer(db).request('/api/issues')).json()
    expect(body.roots.map((root: { key: string; refresh: boolean }) => [root.key, root.refresh])).toEqual([
      ['a/x#5', false], [`${REPO}#119`, false], [`${REPO}#120`, true],
    ])
    expect(body.nodes.map((node: { key: string }) => node.key)).toEqual(['a/x#5', `${REPO}#117`, `${REPO}#119`, `${REPO}#120`])
    expect(body.edges).toEqual([{ kind: 'contains', from: `${REPO}#117`, to: `${REPO}#120`, position: 0, observed_at: startedAt }])
    expect(body.aliases).toEqual({})
  })
})

describe('boards api', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('GET /api/boards returns active boards with rows + progress', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'coverage', rows: [
      { label: 'theme', status: 'done', context: 'shipped in dark-mode PR' }, { label: 'stems', status: 'partial' }, { label: 'na-row', status: 'na' },
    ] })
    const res = await createViewer(db).request('/api/boards')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].title).toBe('coverage')
    expect(body[0].rows.map((r: { label: string }) => r.label)).toEqual(['theme', 'stems', 'na-row'])
    expect(body[0].rows[0].context).toBe('shipped in dark-mode PR')
    expect(body[0].progress.countable).toBe(2)
    expect(body[0].progress.fraction).toBeCloseTo(0.75) // (1 + 0.5)/2
  })

  it('POST archive removes the board from the active list', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    const app = createViewer(db)
    const board = listBoards(db, { status: 'archived' })[0]!
    expect((await app.request(`/api/boards/${boardId}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_version: board.revision }),
    })).status).toBe(200)
    expect(listBoards(db)).toHaveLength(0)
  })

  it('POST unarchive returns the board to the active list', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    const app = createViewer(db)
    let board = listBoards(db, { status: 'archived' })[0]!
    expect((await app.request(`/api/boards/${boardId}/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_version: board.revision }),
    })).status).toBe(200)
    board = listBoards(db, { status: 'archived' })[0]!
    expect((await app.request(`/api/boards/${boardId}/unarchive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_version: board.revision }),
    })).status).toBe(200)
    expect(listBoards(db)).toHaveLength(1)
    expect(listBoards(db, { status: 'archived' })).toHaveLength(0)
  })

  it('GET /api/boards/archived returns archived boards with rows + progress', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'old effort', rows: [{ label: 'x', status: 'done' }] })
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'still active', rows: [{ label: 'y', status: 'tracked' }] })
    const app = createViewer(db)
    const board = listBoards(db, { status: 'archived' }).find((candidate) => candidate.id === boardId)!
    await app.request(`/api/boards/${boardId}/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_version: board.revision }),
    })
    const res = await app.request('/api/boards/archived')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].title).toBe('old effort')
    expect(body[0].status).toBe('archived')
    expect(body[0].rows[0].label).toBe('x')
    expect(body[0].progress.done).toBe(1)
    // active list is untouched by the archived endpoint
    const active = await (await app.request('/api/boards')).json()
    expect(active).toHaveLength(1)
    expect(active[0].title).toBe('still active')
  })

  it('POST row annotate sets the human note and survives a re-upsert', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing' }] })
    const board = listBoards(db)[0]!
    const rowId = board.rows[0]!.id
    const app = createViewer(db)
    const res = await app.request(`/api/boards/${board.id}/rows/${rowId}/annotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'do this next',
        expected_revision: board.rows[0]!.revision,
        expected_board_version: board.revision,
      }),
    })
    expect(res.status).toBe(200)
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'partial' }] })
    expect(listBoards(db)[0]!.rows[0]!.annotation).toBe('do this next')
  })

  // issue #36 — the human's other exit from a blocked row. Every assertion here
  // is about the ROUTE: the store's own rules are pinned in test/store.test.ts.
  describe('POST row handled (#36)', () => {
    function seed(): { boardId: string; rowId: string } {
      upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'Paddle', status: 'blocked' }] })
      const board = listBoards(db)[0]!
      return { boardId: board.id, rowId: board.rows[0]!.id }
    }
    const post = (boardId: string, rowId: string, body: Record<string, unknown> = {}) => {
      const board = [...listBoards(db), ...listBoards(db, { status: 'archived' })]
        .find((candidate) => candidate.id === boardId)
      const current = board?.rows.find((row) => row.id === rowId)
      return createViewer(db).request(`/api/boards/${boardId}/rows/${rowId}/handled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body,
          expected_revision: current?.revision ?? 1,
          expected_board_version: board?.revision ?? 1,
        }),
      })
    }

    it('marks the row and reports ok', async () => {
      const { boardId, rowId } = seed()
      const res = await post(boardId, rowId, { handled: true })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('omitting handled marks rather than un-marks — the affirmative action is the default', async () => {
      const { boardId, rowId } = seed()
      expect(await (await post(boardId, rowId)).json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).not.toBeNull()
    })

    it('handled:false takes the mark back off', async () => {
      const { boardId, rowId } = seed()
      await post(boardId, rowId, { handled: true })
      expect(await (await post(boardId, rowId, { handled: false })).json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).toBeNull()
    })

    it('refuses to un-mark once an agent has been handed it — 200 with ok:false, mark intact', async () => {
      const { boardId, rowId } = seed()
      await post(boardId, rowId, { handled: true })
      markHandledDelivered(db, rowId, listBoards(db)[0]!.rows[0]!.handled_at, 'claude-code')
      const res = await post(boardId, rowId, { handled: false })
      expect(res.status, 'a refusal is not an error — the caller has to read the body').toBe(200)
      expect(await res.json()).toEqual({ ok: false })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).not.toBeNull()
    })

    it('reports ok:false for a row id that does not exist', async () => {
      const { boardId } = seed()
      expect(await (await post(boardId, 'no-such-row', { handled: true })).json()).toEqual({ ok: false })
    })

    it('the mark survives an agent re-upsert that leaves the row blocked', async () => {
      const { boardId, rowId } = seed()
      await post(boardId, rowId, { handled: true })
      upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'Paddle', status: 'blocked', note: 'still waiting' }] })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).not.toBeNull()
    })

    it('GET /api/boards carries the mark and its delivery state to the viewer', async () => {
      const { boardId, rowId } = seed()
      await post(boardId, rowId, { handled: true })
      const before = (await (await createViewer(db).request('/api/boards')).json())[0].rows[0]
      expect(before.handled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(before.handled_seen_at).toBeNull()
      markHandledDelivered(db, rowId, listBoards(db)[0]!.rows[0]!.handled_at, 'claude-code')
      const after = (await (await createViewer(db).request('/api/boards')).json())[0].rows[0]
      expect(after.handled_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(after.handled_seen_by).toBe('claude-code')
    })
  })

  it('GET /api/boards exposes annotation_unseen and does not mark the board read', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing' }] })
    annotateBoardRow(db, listBoards(db)[0]!.rows[0]!.id, 'new note')
    const app = createViewer(db)
    const first = await (await app.request('/api/boards')).json()
    expect(first[0].rows[0].annotation_unseen).toBe(true)
    const second = await (await app.request('/api/boards')).json() // human watching ≠ agent reading
    expect(second[0].rows[0].annotation_unseen).toBe(true)
  })
})

// ── issue #32: close / reopen a project ──────────────────────────────────────
// The HTTP surface both consumers read: public/app.js (title badge, rail) and
// electron/main.cjs (dock badge). Tenet 3 — one attention set — is why closure
// has to be server state at all: the main process cannot read the renderer's
// localStorage, so a client-side close would make the two badges disagree.
describe('project close/reopen api (issue #32)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const post = (app: ReturnType<typeof createViewer>, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('POST /api/projects/close closes it and GET /api/projects/closed lists it', async () => {
    const app = createViewer(db)
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'q' })
    const res = await post(app, '/api/projects/close', { project: 'dead' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await (await app.request('/api/projects/closed')).json()).toEqual(['dead'])
  })

  it('POST /api/projects/reopen removes it from the closed list', async () => {
    const app = createViewer(db)
    closeProject(db, 'dead')
    const res = await post(app, '/api/projects/reopen', { project: 'dead' })
    expect(res.status).toBe(200)
    expect(await (await app.request('/api/projects/closed')).json()).toEqual([])
  })

  it('GET /api/projects/closed omits a project an agent flagged into after it was closed', async () => {
    const app = createViewer(db)
    closeProject(db, 'dead')
    await new Promise((r) => setTimeout(r, 5))
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'back from the dead' })
    expect(await (await app.request('/api/projects/closed')).json()).toEqual([])
  })

  it('accepts a project name containing a slash — names are agent-authored, hence a body not a path param', async () => {
    const app = createViewer(db)
    const res = await post(app, '/api/projects/close', { project: 'org/repo name' })
    expect(res.status).toBe(200)
    expect(await (await app.request('/api/projects/closed')).json()).toEqual(['org/repo name'])
  })

  it('rejects a blank or missing project name with 400, so app.js surfaces it instead of swallowing it', async () => {
    const app = createViewer(db)
    for (const body of [{ project: '   ' }, { project: '' }, {}, { project: 42 }]) {
      const res = await post(app, '/api/projects/close', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(closedProjects(db)).toEqual([])
    const reopen = await post(app, '/api/projects/reopen', {})
    expect(reopen.status).toBe(400)
  })

  it('rejects an unparseable body with 400 rather than throwing a 500', async () => {
    const app = createViewer(db)
    const res = await app.request('/api/projects/close', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('closing is presentation only — the /api/items and /api/boards payloads are byte-identical', async () => {
    const app = createViewer(db)
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'q' })
    upsertBoard(db, { project: 'dead', stream: '', agent: 'a', title: 'b', rows: [{ label: 'x', status: 'blocked' }] })
    const itemsBefore = await (await app.request('/api/items')).json()
    const boardsBefore = await (await app.request('/api/boards')).json()
    await post(app, '/api/projects/close', { project: 'dead' })
    expect(await (await app.request('/api/items')).json()).toEqual(itemsBefore)
    expect(await (await app.request('/api/boards')).json()).toEqual(boardsBefore)
  })
})

// ── issue #42, constraint B: the viewer is untouched ─────────────────────────
// #42 trims agent-authored `context` out of the MCP READ payloads, because it is
// written for the human and the agent that wrote it pays to read it back. The
// human's surface is the one place that text is FOR: /api/boards and /api/items
// must keep carrying it verbatim, and the viewer must not route through
// src/shape.ts at all. Two pins — the payload, and the wiring that produces it.
describe('the human’s payloads never route through the agent-side shaping (#42)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('GET /api/boards still carries full row context — and no context_chars', async () => {
    const long = 'the backstory the human reads in the collapsed dropdown. '.repeat(10)
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'blocked', note: 'n', context: long }] })
    annotateBoardRow(db, listBoards(db)[0]!.rows[0]!.id, 'human note')
    const body = await (await createViewer(db).request('/api/boards')).json()
    expect(body[0].rows[0].context).toBe(long)
    expect(body[0].rows[0]).not.toHaveProperty('context_chars')
    expect(body[0].rows[0].annotation).toBe('human note')
    // byte-identical to what the store returns: the route is a passthrough
    expect(body).toEqual(JSON.parse(JSON.stringify(listBoards(db))))
  })

  it('GET /api/items still carries the item’s full context', async () => {
    const long = 'background a human returning cold needs. '.repeat(10)
    insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q', context: long })
    const body = await (await createViewer(db).request('/api/items')).json()
    expect(JSON.stringify(body)).toContain(long)
    expect(JSON.stringify(body)).not.toContain('context_chars')
  })

  it('src/viewer.ts does not import the shaping module', () => {
    const src = readFileSync(new URL('../src/viewer.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/from '\.\/shape\.js'/)
    expect(src).not.toContain('context_chars')
  })
})

// ── issue #163: an invalid write body is refused BEFORE any store call ──────
// postJSON() in public/app.js keys on the HTTP status: a 4xx means "the write
// never happened", while a 200 { ok:false } is the store refusing a VALID
// request. So invalid input must be a 400 that leaves the stored state exactly
// as it was — never a 500 (a parse or trim() throw), and never a 200 that
// silently overwrote something. An explicit '' stays a legitimate clear.
describe('write routes refuse invalid bodies before touching the store (#163)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const post = (path: string, body: string) => createViewer(db).request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })

  async function expectInvalid(res: Response) {
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: expect.any(String) })
  }

  // Each case receives the route's other fields, valid, so the field under
  // test is the ONLY thing wrong with the request.
  type BodyCase = [label: string, body: (valid: Record<string, unknown>) => string]
  const INVALID_TEXT: BodyCase[] = [
    ['malformed JSON', () => '{"text": "unterminated'],
    ['a JSON null body', () => 'null'],
    ['a missing text', (valid) => JSON.stringify(valid)],
    ['a null text', (valid) => JSON.stringify({ ...valid, text: null })],
    ['a numeric text', (valid) => JSON.stringify({ ...valid, text: 123 })],
    ['an object text', (valid) => JSON.stringify({ ...valid, text: { value: 'nested' } })],
  ]
  const FUTURE = '2099-01-01T00:00:00.000Z'
  // `until` is the whole instruction: a date snoozes, null wakes. Anything else
  // used to reach the store — coerced to null, or a string stored verbatim that
  // the viewer cannot parse — and silently WOKE the item or row with a 200.
  const INVALID_UNTIL: BodyCase[] = [
    ['malformed JSON', () => '{"until": '],
    ['a JSON null body', () => 'null'],
    ['a missing until', (valid) => JSON.stringify(valid)],
    ['a numeric until', (valid) => JSON.stringify({ ...valid, until: Date.parse(FUTURE) })],
    ['an object until', (valid) => JSON.stringify({ ...valid, until: { at: FUTURE } })],
    ['a boolean until', (valid) => JSON.stringify({ ...valid, until: false })],
    ['an empty until', (valid) => JSON.stringify({ ...valid, until: '' })],
    ['an unparseable until', (valid) => JSON.stringify({ ...valid, until: 'not-a-date' })],
    ['a relative-word until', (valid) => JSON.stringify({ ...valid, until: 'tomorrow' })],
    // parseable, but its +YYYYYY form would sort below every 4-digit-year stamp
    ['a beyond-year-9999 until', (valid) => JSON.stringify({ ...valid, until: '+010000-01-01T00:00:00.000Z' })],
  ]
  // The store compares snoozed_until as TEXT, so a valid date is stored as UTC ISO.
  const OFFSET_DATE = '2099-01-01T00:00:00+02:00'
  const OFFSET_DATE_UTC = '2098-12-31T22:00:00.000Z'

  const question = () => insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q' })

  function blockedRow(): string {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'blocked' }] })
    return listBoards(db)[0]!.rows[0]!.id
  }

  // the row's CURRENT pins — every seeding write bumps them
  function rowTarget() {
    const board = listBoards(db)[0]!
    const row = board.rows[0]!
    return {
      path: `/api/boards/${board.id}/rows/${row.id}`,
      pins: { expected_revision: row.revision, expected_board_version: board.revision },
    }
  }

  describe('POST /api/items/:id/annotate', () => {
    it.each(INVALID_TEXT)('refuses %s and keeps the stored note', async (_label, body) => {
      const id = question()
      annotateItem(db, id, 'keep this note')
      const before = getItem(db, id)
      await expectInvalid(await post(`/api/items/${id}/annotate`, body({})))
      expect(getItem(db, id)).toEqual(before)
    })

    it('still clears the note on an explicit empty string', async () => {
      const id = question()
      annotateItem(db, id, 'old note')
      const res = await post(`/api/items/${id}/annotate`, JSON.stringify({ text: '' }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(getItem(db, id)!.annotation).toBe('')
    })
  })

  describe('POST /api/items/:id/reply', () => {
    const INVALID_REPLY: BodyCase[] = [
      ...INVALID_TEXT,
      ['a numeric context', () => JSON.stringify({ text: 'Correction', context: 5 })],
      ['an object context', () => JSON.stringify({ text: 'Correction', context: { value: 'nested' } })],
      ['a null context', () => JSON.stringify({ text: 'Correction', context: null })],
    ]

    it.each(INVALID_REPLY)('refuses %s and keeps the stored answer', async (_label, body) => {
      const id = question()
      replyItem(db, id, 'keep this answer', 'and its context')
      const before = getItem(db, id)
      await expectInvalid(await post(`/api/items/${id}/reply`, body({ context: 'new context' })))
      expect(getItem(db, id)).toEqual(before)
    })

    it('still clears an unread answer on an explicit empty string — and still refuses a read one with 200', async () => {
      const unread = question()
      replyItem(db, unread, 'take it back')
      let res = await post(`/api/items/${unread}/reply`, JSON.stringify({ text: '' }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(getItem(db, unread)!.reply).toBeNull()

      const read = question()
      replyItem(db, read, 'already read')
      markReplySeen(db, read, getItem(db, read)!.replied_at)
      res = await post(`/api/items/${read}/reply`, JSON.stringify({ text: '' }))
      expect(res.status, 'a refusal of a valid request is not an error').toBe(200)
      expect(await res.json()).toEqual({ ok: false })
      expect(getItem(db, read)!.reply).toBe('already read')
    })
  })

  describe('POST /api/boards/:id/rows/:rowId/annotate', () => {
    it.each(INVALID_TEXT)('refuses %s and keeps the stored note', async (_label, body) => {
      annotateBoardRow(db, blockedRow(), 'keep this note')
      const { path, pins } = rowTarget()
      const before = listBoards(db)
      await expectInvalid(await post(`${path}/annotate`, body({ kind: 'answer', ...pins })))
      expect(listBoards(db)).toEqual(before)
    })

    it('still clears the note on an explicit empty string', async () => {
      annotateBoardRow(db, blockedRow(), 'old note')
      const { path, pins } = rowTarget()
      const res = await post(`${path}/annotate`, JSON.stringify({ text: '', ...pins }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.annotation).toBe('')
    })
  })

  describe('POST /api/items/:id/snooze', () => {
    it.each(INVALID_UNTIL)('refuses %s and keeps the snooze', async (_label, body) => {
      const id = question()
      snoozeItem(db, id, FUTURE)
      const before = getItem(db, id)
      await expectInvalid(await post(`/api/items/${id}/snooze`, body({})))
      expect(getItem(db, id)).toEqual(before)
    })

    it('still wakes on an explicit null', async () => {
      const id = question()
      snoozeItem(db, id, FUTURE)
      const res = await post(`/api/items/${id}/snooze`, JSON.stringify({ until: null }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(getItem(db, id)!.snoozed_until).toBeNull()
    })

    it('stores a valid non-UTC date as UTC ISO', async () => {
      const id = question()
      const res = await post(`/api/items/${id}/snooze`, JSON.stringify({ until: OFFSET_DATE }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(getItem(db, id)!.snoozed_until).toBe(OFFSET_DATE_UTC)
    })
  })

  describe('POST /api/boards/:id/rows/:rowId/snooze', () => {
    it.each(INVALID_UNTIL)('refuses %s and keeps the snooze', async (_label, body) => {
      snoozeBoardRow(db, blockedRow(), FUTURE)
      const { path, pins } = rowTarget()
      const before = listBoards(db)
      await expectInvalid(await post(`${path}/snooze`, body(pins)))
      expect(listBoards(db)).toEqual(before)
    })

    it('still wakes on an explicit null', async () => {
      snoozeBoardRow(db, blockedRow(), FUTURE)
      const { path, pins } = rowTarget()
      const res = await post(`${path}/snooze`, JSON.stringify({ until: null, ...pins }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.snoozed_until).toBeNull()
    })

    it('stores a valid non-UTC date as UTC ISO', async () => {
      blockedRow()
      const { path, pins } = rowTarget()
      const res = await post(`${path}/snooze`, JSON.stringify({ until: OFFSET_DATE, ...pins }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.snoozed_until).toBe(OFFSET_DATE_UTC)
    })

    // #177 classifies the store's refusal of a VALID body; an invalid body is a
    // 400 before that store call, even on a row that could not be snoozed anyway.
    it('validates before classifying a refusal: same answered row and current pins', async () => {
      annotateBoardRow(db, blockedRow(), 'answered')
      const { path, pins } = rowTarget()
      const before = listBoards(db)
      await expectInvalid(await post(`${path}/snooze`, JSON.stringify({ until: 'tomorrow', ...pins })))
      expect(listBoards(db)).toEqual(before)
      const valid = await post(`${path}/snooze`, JSON.stringify({ until: FUTURE, ...pins }))
      expect(valid.status).toBe(200)
      expect(await valid.json()).toEqual({ ok: false, reason: 'not_snoozable' })
      expect(listBoards(db)).toEqual(before)
    })
  })

  // Issue #217 — `until` is again the whole instruction: a date asks the watcher
  // to wait quietly until then, and an explicit null stops it for good. A
  // dropped field must never be read as that final, unrevisable stop.
  describe('POST /api/items/:id/stop-waiting', () => {
    it.each(INVALID_UNTIL)('refuses %s and keeps the stored stop', async (_label, body) => {
      const id = question()
      stopItemWatch(db, id, FUTURE)
      const before = getItem(db, id)
      await expectInvalid(await post(`/api/items/${id}/stop-waiting`, body({})))
      expect(getItem(db, id)).toEqual(before)
    })

    it('stops for good on an explicit null and stores a date as UTC ISO', async () => {
      const deferred = question()
      let res = await post(`/api/items/${deferred}/stop-waiting`, JSON.stringify({ until: OFFSET_DATE }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(getItem(db, deferred)).toMatchObject({ watch_stopped_at: expect.any(String), watch_stopped_until: OFFSET_DATE_UTC })

      res = await post(`/api/items/${deferred}/stop-waiting`, JSON.stringify({ until: null }))
      expect(await res.json()).toEqual({ ok: true })
      expect(getItem(db, deferred)!.watch_stopped_until).toBeNull()
    })

    it('reports a store refusal of a valid request as a 200', async () => {
      const id = question()
      replyItem(db, id, 'already answered')
      const res = await post(`/api/items/${id}/stop-waiting`, JSON.stringify({ until: null }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: false })
      expect(getItem(db, id)!.watch_stopped_at).toBeNull()
    })
  })

  describe('POST /api/boards/:id/rows/:rowId/stop-waiting', () => {
    it.each(INVALID_UNTIL)('refuses %s and keeps the stored stop', async (_label, body) => {
      const rowId = blockedRow()
      const { path, pins } = rowTarget()
      stopBoardRowWatch(db, rowId, FUTURE, pins.expected_revision, pins.expected_board_version)
      const before = listBoards(db)
      await expectInvalid(await post(`${path}/stop-waiting`, body(pins)))
      expect(listBoards(db)).toEqual(before)
    })

    it.each([
      ['no pins', {}],
      ['a string revision', { expected_revision: '1', expected_board_version: 1 }],
      ['a fractional board version', { expected_revision: 1, expected_board_version: 1.5 }],
    ])('refuses %s before any store call', async (_label, pins) => {
      blockedRow()
      const { path } = rowTarget()
      const before = listBoards(db)
      await expectInvalid(await post(`${path}/stop-waiting`, JSON.stringify({ until: null, ...pins })))
      expect(listBoards(db)).toEqual(before)
    })

    it('stops the current action without bumping either revision', async () => {
      blockedRow()
      const { path, pins } = rowTarget()
      const res = await post(`${path}/stop-waiting`, JSON.stringify({ until: OFFSET_DATE, ...pins }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.watch_stopped_until).toBe(OFFSET_DATE_UTC)
      expect(rowTarget().pins).toEqual(pins)
    })

    it('classifies a refusal: stale pins are a version mismatch, an answered row is not stoppable', async () => {
      blockedRow()
      const { path, pins } = rowTarget()
      let res = await post(`${path}/stop-waiting`, JSON.stringify({ until: null, ...pins, expected_revision: pins.expected_revision - 1 }))
      expect(await res.json()).toEqual({ ok: false, reason: 'version_mismatch' })
      res = await post(`${path}/stop-waiting`, JSON.stringify({ until: null, ...pins, expected_board_version: pins.expected_board_version - 1 }))
      expect(await res.json()).toEqual({ ok: false, reason: 'version_mismatch' })

      annotateBoardRow(db, listBoards(db)[0]!.rows[0]!.id, 'answered')
      const current = rowTarget()
      res = await post(`${current.path}/stop-waiting`, JSON.stringify({ until: null, ...current.pins }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: false, reason: 'not_stoppable' })
      expect(listBoards(db)[0]!.rows[0]!.watch_stopped_at).toBeNull()
    })
  })

  // An absent `handled` still MARKS (the documented affirmative default); a
  // present non-boolean is no instruction at all — "false" must not re-mark.
  describe('POST /api/boards/:id/rows/:rowId/handled', () => {
    const INVALID_HANDLED: BodyCase[] = [
      ['a string handled', (valid) => JSON.stringify({ ...valid, handled: 'false' })],
      ['a numeric handled', (valid) => JSON.stringify({ ...valid, handled: 0 })],
      ['a null handled', (valid) => JSON.stringify({ ...valid, handled: null })],
    ]

    it.each(INVALID_HANDLED)('refuses %s and keeps the mark', async (_label, body) => {
      markRowHandled(db, blockedRow())
      const { path, pins } = rowTarget()
      const before = listBoards(db)
      await expectInvalid(await post(`${path}/handled`, body(pins)))
      expect(listBoards(db)).toEqual(before)
    })
  })
})
