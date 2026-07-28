// @vitest-environment jsdom
// test/dom/build-stamp.test.ts
//
// Issue #40, the half a human can see: the Setup panel says which build is
// running, and says so when the packaged bundle has fallen behind its checkout.
// Driven through the REAL frontend against the REAL /api/setup handler; only the
// git probe is injected (a real child process does not resolve under fake timers).
//
// The load-bearing test in this file is the LAST one. A stale build is not the
// human being blocked, so it may not move the dock badge, the tab counts or the
// Needs-you list by a single character — tenets 1 and 2, and the likeliest way
// this feature could do damage.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard } from '../../src/store.js'
import type { BuildStamp } from '../../src/stamp.js'
import { badgeCount, bootApp, freshDb, rowTitles, settle, tabCount, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const HEAD = '99887766554433221100ffeeddccbbaa99887766'

const stamp = (over: Partial<BuildStamp>): BuildStamp => ({
  commit: SHA, builtAt: '2026-07-25T12:34:56.000Z', head: HEAD, repoRoot: '/repo', drift: 'stale', ...over,
})

/** Boot with a pinned build stamp — no git, no timing race. */
const withBuild = (build: BuildStamp | null, throws = false) => ({
  viewer: {
    setupInfoPath: '/nonexistent/setup-info.json',
    stamp: async (): Promise<BuildStamp> => {
      if (throws) throw new Error('probe exploded')
      return build as BuildStamp
    },
  },
})

const setupText = (): string => document.querySelector('#setup .setup-body')?.textContent ?? ''
const setupBlocks = (): number => document.querySelectorAll('#setup .setup-block').length

describe('the Setup panel answers "which build is this"', () => {
  it('a stale packaged bundle names both commits and the command that fixes it', async () => {
    const d = open()
    await bootApp(d, withBuild(stamp({ drift: 'stale' })))
    await settle()

    const text = setupText()
    expect(text).toContain('a1b2c3d')          // what this app was built from
    expect(text).toContain('9988776')          // what the checkout is on now
    expect(text).toContain('/repo')
    expect(text).toContain('⚠')
    // the command is a <pre>, so it copies cleanly out of the panel
    const pres = [...document.querySelectorAll('#setup .setup-body pre')].map((p) => p.textContent)
    expect(pres).toContain('npm run package:app')
  })

  it('a current bundle says so and asks for nothing', async () => {
    const d = open()
    await bootApp(d, withBuild(stamp({ drift: 'current', head: SHA })))
    await settle()

    expect(setupText()).toContain('current build')
    expect(setupText()).not.toContain('package:app')
  })

  it('the dev path shows its live HEAD instead of claiming staleness against itself', async () => {
    const d = open()
    await bootApp(d, withBuild(stamp({ drift: 'dev', commit: null, builtAt: null, head: HEAD })))
    await settle()

    expect(setupText()).toContain('9988776')
    expect(setupText().toLowerCase()).toContain('checkout')
    expect(setupText()).not.toContain('package:app')
    expect(setupText()).not.toContain('⚠')
  })

  it('renders exactly as before #40 when there is no stamp to show', async () => {
    const d = open()
    await bootApp(d, withBuild(null))
    await settle()

    expect(setupBlocks(), 'the registration blocks must still be there').toBeGreaterThanOrEqual(3)
    expect(setupText()).not.toContain('package:app')
    expect(setupText()).not.toContain('⚠ This app')
  })

  it('survives a probe that throws — the panel is the fallback, not the casualty', async () => {
    const d = open()
    await bootApp(d, withBuild(null, true))
    await settle()

    expect(setupBlocks(), 'a broken build probe emptied the whole Setup panel').toBeGreaterThanOrEqual(3)
    expect(setupText()).toContain('claude mcp add')
  })
})

describe('a path read off disk is still text that reaches the DOM', () => {
  it('a hostile repoRoot never becomes a live node', async () => {
    const d = open()
    const XSS = '<img src=x onerror="window.__pwned=1">'
    await bootApp(d, withBuild(stamp({ drift: 'stale', repoRoot: XSS })))
    await settle()

    expect(document.querySelectorAll('#setup img, #setup script').length, 'setup-info.json became live DOM').toBe(0)
    expect(setupText(), 'escaping is not silent deletion').toContain(XSS)
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined()
  })
})

// ── tenet 2 ─────────────────────────────────────────────────────────────────

describe('a stale build is NOT attention', () => {
  const seed = (d: Database.Database): void => {
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'blocked on you' })
    upsertBoard(d, {
      project: 'alpha', stream: 'main', agent: 'claude', title: 'rollout',
      rows: [{ label: 'step', status: 'blocked', note: 'needs you' }],
    })
  }

  // ONE fixture, ONE expected attention signal, asserted under both verdicts.
  // (Two boots cannot share a test: vi.resetModules() runs per test, so the
  // second import of app.js would be the first one's cached module.)
  const SIGNAL = { badge: 2, title: '(2) Agent Inbox', needsYou: '2', boards: '1', rows: ['step', 'blocked on you'] }
  const signal = () => ({
    badge: badgeCount(), title: document.title,
    needsYou: tabCount('needsYou'), boards: tabCount('boards'), rows: rowTitles(),
  })

  it('with a CURRENT build, the fixture asks for the human twice', async () => {
    const d = open()
    seed(d)
    await bootApp(d, withBuild(stamp({ drift: 'current', head: SHA })))
    await settle()

    expect(signal()).toEqual(SIGNAL)
  })

  it('and a STALE build moves not one character of it', async () => {
    const d = open()
    seed(d)
    await bootApp(d, withBuild(stamp({ drift: 'stale' })))
    await settle()

    expect(setupText(), 'the fixture did not actually go stale').toContain('⚠')
    expect(signal(), 'a stale build escalated into the attention set').toEqual(SIGNAL)
  })
})
