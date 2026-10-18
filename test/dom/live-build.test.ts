// @vitest-environment jsdom
// test/dom/live-build.test.ts
//
// Issue #197, through the real viewer over a real DB: Live says which Agent
// Inbox build each session runs, and quietly marks a session that runs an OLDER
// build than the one a restart would load. That is presence, not attention — it
// must never move the badge, the Needs-you count or anything else the human is
// asked to act on, and it must never guess: no version, no label.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { insertItem, recordActivityCall, upsertActivity } from '../../src/store.js'
import { advanceClock, badgeCount, bootApp, freshDb, pollTick, rows, showInbox, tabCount, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

// A release build's baked version is the build a restarted session loads. A
// fixture pins it, so these tests do not move with every release bump.
function releaseViewer(version: string) {
  const setupInfoPath = join(mkdtempSync(join(tmpdir(), 'inbox-dom-build-')), 'setup-info.json')
  writeFileSync(setupInfoPath, JSON.stringify({ schema: 2, version, runtimePayloads: {} }))
  return { setupInfoPath }
}

type Seed = { session: string; project: string; agent: string; version?: string; working?: boolean }
function seed(d: Database.Database, s: Seed): void {
  upsertActivity(d, {
    session: s.session, project: s.project, stream: 'main', agent: s.agent,
    doing: 'open', idle: true, claim: false,
    ...(s.version === undefined ? {} : { server_version: s.version }),
  })
  if (s.working) {
    upsertActivity(d, { session: s.session, project: s.project, stream: 'main', agent: s.agent, doing: `Working in ${s.project}` })
    recordActivityCall(d, s.session)
  }
  advanceClock()
}

const drawer = (): HTMLElement => document.getElementById('liveDrawer') as HTMLElement
const drawerEntry = (project: string): HTMLElement | undefined =>
  [...drawer().querySelectorAll<HTMLElement>('.live-entry, .idle-row')]
    .find((el) => el.querySelector('.live-who')?.textContent?.includes(project))
const stripChip = (project: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('#liveStripSessions .live-session')]
    .find((el) => el.textContent?.startsWith(`${project}/`))
const text = (el: Element | null | undefined, selector: string): string | null =>
  el?.querySelector(selector)?.textContent ?? null

const HINT = 'older build — restart this session to load v2.0.0'

describe('Live shows the build each session runs (#197)', () => {
  it('labels every known build and marks only the sessions running an older one', async () => {
    const d = open()
    seed(d, { session: 'current', project: 'alpha', agent: 'copilot', version: '2.0.0', working: true })
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    seed(d, { session: 'stale-idle', project: 'gamma', agent: 'copilot', version: '1.9.0' })
    seed(d, { session: 'legacy', project: 'delta', agent: 'claude-code' })
    seed(d, { session: 'garbage', project: 'epsilon', agent: 'copilot', version: '<img src=x onerror=alert(1)>' })

    await bootApp(d, { viewer: releaseViewer('2.0.0') })
    await pollTick()

    // the drawer: every session, working or merely connected
    const current = drawerEntry('alpha')
    expect(text(current, '.live-build')).toBe('v2.0.0')
    expect(current?.querySelector('.live-build-hint')).toBeNull()
    const stale = drawerEntry('beta')
    expect(text(stale, '.live-build')).toBe('v1.2.6')
    expect(text(stale, '.live-build-hint')).toBe(HINT)
    const staleIdle = drawerEntry('gamma')
    expect(staleIdle?.classList.contains('idle-row')).toBe(true)
    expect(text(staleIdle, '.live-build')).toBe('v1.9.0')
    expect(text(staleIdle, '.live-build-hint')).toBe(HINT)
    // no version, or one that is not a version: nothing, never a guess
    for (const project of ['delta', 'epsilon']) {
      const entry = drawerEntry(project)
      expect(entry, project).toBeTruthy()
      expect(entry?.querySelector('.live-build, .live-build-hint'), project).toBeNull()
    }
    expect(drawer().querySelector('img')).toBeNull()
    // the collapsed fold says an older build is inside it
    expect(drawer().querySelector('.idle-fold > summary')?.textContent)
      .toBe('3 connections · no task reported · 1 on an older build')

    // the strip: working sessions only, as before, each with its build
    expect(text(stripChip('alpha'), '.live-build')).toBe('v2.0.0')
    expect(stripChip('alpha')?.title).toBe('')
    expect(text(stripChip('beta'), '.live-build')).toBe('v1.2.6 · older build')
    expect(stripChip('beta')?.title).toBe(HINT)
  })

  it('never guesses the current build: without one, sessions keep their label and get no hint', async () => {
    const d = open()
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    seed(d, { session: 'stale-idle', project: 'gamma', agent: 'copilot', version: '1.9.0' })

    // an older viewer that predates the route answers 404 with HTML
    await bootApp(d, {
      interceptFetch: async (input, _init, next) => (String(input) === '/api/version'
        ? new Response('<!doctype html>Not Found', { status: 404 })
        : next()),
    })
    await pollTick()

    expect(text(drawerEntry('beta'), '.live-build')).toBe('v1.2.6')
    expect(text(drawerEntry('gamma'), '.live-build')).toBe('v1.9.0')
    expect(document.querySelector('.live-build-hint')).toBeNull()
    expect(drawer().querySelector('.idle-fold > summary')?.textContent).toBe('1 connection · no task reported')
    expect(text(stripChip('beta'), '.live-build')).toBe('v1.2.6')
    expect(stripChip('beta')?.title).toBe('')
  })

  it('is presence, not attention: an older build moves no badge or count', async () => {
    const d = open()
    const asked = insertItem(d, { project: 'beta', stream: 'main', agent: 'claude-code', kind: 'question', title: 'Ship the fix?', session: 'stale' })
    advanceClock()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question', title: 'Which branch?' })
    advanceClock()
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    seed(d, { session: 'stale-idle', project: 'gamma', agent: 'copilot', version: '1.9.0' })

    await bootApp(d, { viewer: releaseViewer('2.0.0') })
    await pollTick()
    await showInbox()

    expect(document.querySelectorAll('.live-build-hint')).toHaveLength(2)
    // exactly the two open questions — the two older builds add nothing
    expect(badgeCount()).toBe(2)
    expect(tabCount('needsYou')).toBe('2')
    expect(rows()).toHaveLength(2)
    // the asking session is still live, so its question is still waiting on you
    expect(rows().find((r) => r.dataset['cardId'] === asked)?.textContent).toContain('Waiting')
  })
})
