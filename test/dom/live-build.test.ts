// @vitest-environment jsdom
// test/dom/live-build.test.ts
//
// Issue #197, through the real viewer over a real DB: Live says which Agent
// Inbox build each session runs, and quietly marks a session that runs an OLDER
// build than the current one. The advice follows where THAT session runs from —
// an installed agent runtime or a checkout — and what this viewer has verified,
// and it is left out when nothing backs it. That is presence, not attention: it
// never moves the badge, the Needs-you count or anything else the human is asked
// to act on.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, recordActivityCall, upsertActivity } from '../../src/store.js'
import { releaseRuntime } from '../release-runtime.js'
import {
  advanceClock, badgeCount, bootApp, click, freshDb, pollTick, rows, settle, showInbox, tabCount, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  delete (window as unknown as Record<string, unknown>).agentInboxSetup
})

function open(): Database.Database {
  db = freshDb()
  return db
}

type Seed = { session: string; project: string; agent: string; version?: string; source?: 'runtime' | 'checkout' | null; working?: boolean }
function seed(d: Database.Database, s: Seed): void {
  const source = s.source === undefined ? 'runtime' : s.source
  upsertActivity(d, {
    session: s.session, project: s.project, stream: 'main', agent: s.agent,
    doing: 'open', idle: true, claim: false,
    ...(s.version === undefined ? {} : { server_version: s.version }),
    ...(source === null ? {} : { server_source: source }),
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
const hint = (project: string): string | null => text(drawerEntry(project), '.live-build-hint')

const RESTART = 'older build (v1.2.6) — restart this session to load v2.0.0'
const SETUP = 'older build (v1.2.6) — install the v2.0.0 agent runtime from Setup, then restart this session'
const CHECKOUT = 'older build (v1.2.6) — update and rebuild its checkout, then restart this session'

describe('Live shows the build each session runs (#197)', () => {
  it('labels every known build in the drawer and marks only older sessions in the strip', async () => {
    const d = open()
    seed(d, { session: 'current', project: 'alpha', agent: 'copilot', version: '2.0.0', working: true })
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    seed(d, { session: 'stale-idle', project: 'gamma', agent: 'copilot', version: '1.9.0' })
    seed(d, { session: 'legacy', project: 'delta', agent: 'claude-code' })
    seed(d, { session: 'garbage', project: 'epsilon', agent: 'copilot', version: '<img src=x onerror=alert(1)>' })
    const release = releaseRuntime('2.0.0')
    release.install()

    await bootApp(d, { viewer: release.viewer })
    await pollTick()

    // the drawer: every session, working or merely connected, with its full label
    expect(text(drawerEntry('alpha'), '.live-build')).toBe('v2.0.0')
    expect(hint('alpha')).toBeNull()
    expect(text(drawerEntry('beta'), '.live-build')).toBe('v1.2.6')
    expect(hint('beta')).toBe(RESTART)
    expect(drawerEntry('gamma')?.classList.contains('idle-row')).toBe(true)
    expect(text(drawerEntry('gamma'), '.live-build')).toBe('v1.9.0')
    expect(hint('gamma')).toBe('older build (v1.9.0) — restart this session to load v2.0.0')
    // no version, or one that is not a version: nothing, never a guess
    for (const project of ['delta', 'epsilon']) {
      expect(drawerEntry(project), project).toBeTruthy()
      expect(drawerEntry(project)?.querySelector('.live-build, .live-build-hint'), project).toBeNull()
    }
    expect(drawer().querySelector('img')).toBeNull()
    // the collapsed fold says an older build is inside it
    expect(drawer().querySelector('.idle-fold > summary')?.textContent)
      .toBe('3 connections · no task reported · 1 on an older build')

    // the strip stays compact: nothing extra on the current build, one marker on an older one
    expect(stripChip('alpha')?.textContent).toBe('alpha/copilot')
    expect(stripChip('alpha')?.title).toBe('')
    expect(stripChip('beta')?.textContent).toBe('beta/claude-codeolder build')
    expect(text(stripChip('beta'), '.live-build-marker')).toBe('older build')
    expect(stripChip('beta')?.title).toBe(RESTART)
  })

  it('points at Setup while the runtime is not installed, and says restart once the drawer is reopened after an install', async () => {
    const d = open()
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    const release = releaseRuntime('2.0.0')

    await bootApp(d, { viewer: release.viewer })
    await pollTick()
    expect(hint('beta')).toBe(SETUP)
    expect(stripChip('beta')?.title).toBe(SETUP)

    release.install()
    click(document.getElementById('liveStrip'))
    await settle()
    await pollTick()
    expect(hint('beta')).toBe(RESTART)
  })

  it('re-reads the runtime state when a Setup install finishes, so a closed or pinned drawer stops pointing at Setup', async () => {
    const d = open()
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    const release = releaseRuntime('2.0.0')
    Object.defineProperty(window, 'agentInboxSetup', {
      configurable: true,
      value: {
        available: async () => true,
        install: async (target: string) => {
          release.install()
          return { ok: true, exitCode: 0, target, timedOut: false, output: 'installed' }
        },
      },
    })

    await bootApp(d, { viewer: release.viewer })
    await pollTick()
    expect(hint('beta')).toBe(SETUP)

    click(document.querySelector('.setup-run-btn'))
    await settle()
    await pollTick()
    expect(drawer().hidden).toBe(true) // never reopened
    expect(hint('beta')).toBe(RESTART)
    expect(stripChip('beta')?.title).toBe(RESTART)
  })

  it('follows each session\'s own install source: a runtime, a checkout, or unknown', async () => {
    const d = open()
    seed(d, { session: 'runtime', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    seed(d, { session: 'checkout', project: 'gamma', agent: 'copilot', version: '1.2.6', source: 'checkout', working: true })
    seed(d, { session: 'legacy', project: 'delta', agent: 'copilot', version: '1.2.6', source: null, working: true })
    const release = releaseRuntime('2.0.0')
    release.install()

    await bootApp(d, { viewer: release.viewer })
    await pollTick()

    expect(hint('beta')).toBe(RESTART)
    expect(hint('gamma')).toBe(CHECKOUT)
    expect(hint('delta')).toBe('older build (v1.2.6)')
    // every older build is still marked in the strip, with its own advice
    expect(stripChip('gamma')?.title).toBe(CHECKOUT)
    expect(text(stripChip('delta'), '.live-build-marker')).toBe('older build')
  })

  it('offers no remedy when Setup could not install the runtime here', async () => {
    const d = open()
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })

    await bootApp(d, { viewer: releaseRuntime('2.0.0', { hostPayload: false }).viewer })
    await pollTick()

    expect(hint('beta')).toBe('older build (v1.2.6)')
    expect(text(stripChip('beta'), '.live-build-marker')).toBe('older build')
  })

  it('a checkout viewer advises its checkout sessions, and nothing for runtime sessions it cannot update', async () => {
    const d = open()
    seed(d, { session: 'checkout', project: 'beta', agent: 'claude-code', version: '0.0.1', source: 'checkout', working: true })
    seed(d, { session: 'runtime', project: 'gamma', agent: 'copilot', version: '0.0.1', working: true })

    await bootApp(d)
    await pollTick()

    expect(hint('beta')).toBe('older build (v0.0.1) — update and rebuild its checkout, then restart this session')
    expect(hint('gamma')).toBe('older build (v0.0.1)')
  })

  it('never guesses the current build: without one, the drawer keeps its labels and nothing is marked older', async () => {
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
    expect(document.querySelector('.live-build-hint, .live-build-marker')).toBeNull()
    expect(drawer().querySelector('.idle-fold > summary')?.textContent).toBe('1 connection · no task reported')
    expect(stripChip('beta')?.textContent).toBe('beta/claude-code')
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

    await bootApp(d, { viewer: releaseRuntime('2.0.0').viewer })
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
