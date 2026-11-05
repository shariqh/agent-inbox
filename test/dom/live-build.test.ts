// @vitest-environment jsdom
// test/dom/live-build.test.ts
//
// Issue #197, through the real viewer over a real DB: the session panel says
// which Agent Inbox build each session runs, and its card (#454: once the Live
// drawer and strip) quietly marks a session that runs an OLDER build than the
// current one; the sidebar's Sessions line counts them. The advice follows where THAT session runs from —
// an installed agent runtime or a checkout — what ITS HOST is registered to run
// (part 2: a restart loads the registration, not whatever is installed), and
// what this viewer has verified; it is left out when nothing backs it. That is
// presence, not attention: it never moves the badge, the Needs-you count or
// anything else the human is asked to act on.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { insertItem, recordActivityCall, upsertActivity } from '../../src/store.js'
import { registerHost, releaseRuntime } from '../release-runtime.js'
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

// a session's card, by the project it runs in
const cardOf = (project: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]:not(.sc-ask-only)')]
    .find((el) => el.getAttribute('aria-label')?.includes(` in ${project}`))
// #454 A.3 (V1): a card names no build; its panel's hint does, for an older or newer one
function hint(project: string): string | null {
  const card = cardOf(project)
  if (!card) return null
  const aside = document.querySelector<HTMLElement>('#dashboard .dash-focus')!
  const opened = aside.hidden || aside.dataset.card !== card.dataset.sessionCard
  if (opened) click(card.querySelector('.sc-doing'))
  const text = panelHint()
  if (opened) click(aside.querySelector('.dash-focus-close'))
  return text
}
const chip = (project: string): { textContent: string } | null => {
  const text = hint(project)
  return text ? { textContent: text.split(' (')[0]! } : null
}
// the session panel's meta line, which names the build
function meta(project: string): string {
  click(cardOf(project)?.querySelector('.sc-doing'))
  return document.querySelector('#dashboard .dash-focus .dash-focus-meta')?.textContent ?? ''
}
const panelHint = (): string | null => {
  const el = document.querySelector<HTMLElement>('#dashboard .dash-focus .sp-hint')
  return el && !el.hidden ? el.textContent : null
}
const older = (): string | null => {
  const el = document.querySelector<HTMLElement>('#sessionsIndicator .si-older')
  return el && !el.hidden ? el.textContent : null
}

const RESTART = 'older build (v1.2.6) — restart this session to load v2.0.0'
const UPDATE = 'older build (v1.2.6) — update agents from Setup, then restart this session'
const CHECKOUT = 'older build (v1.2.6) — update and rebuild its checkout, then restart this session'

describe('the Agents home shows the build each session runs (#197, #454)', () => {
  it('labels every known build in the panel and marks only older sessions on their cards', async () => {
    const d = open()
    seed(d, { session: 'current', project: 'alpha', agent: 'copilot', version: '2.0.0', working: true })
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    seed(d, { session: 'stale-idle', project: 'gamma', agent: 'copilot', version: '1.9.0' })
    seed(d, { session: 'legacy', project: 'delta', agent: 'claude-code' })
    seed(d, { session: 'garbage', project: 'epsilon', agent: 'copilot', version: '<img src=x onerror=alert(1)>' })
    const release = releaseRuntime('2.0.0')
    const current = release.install()
    release.register('claude', current)
    release.register('copilot', current)

    await bootApp(d, { viewer: release.viewer })
    await pollTick()

    // the panel: every session, working or merely connected, with its full label
    expect(meta('alpha')).toMatch(/ · v2\.0\.0$/)
    expect(panelHint()).toBeNull()
    expect(meta('beta')).toMatch(/ · v1\.2\.6$/)
    expect(panelHint()).toBe(RESTART)
    expect(meta('gamma')).toMatch(/ · v1\.9\.0$/)
    expect(hint('gamma')).toBe('older build (v1.9.0) — restart this session to load v2.0.0')
    // no version, or one that is not a version: nothing, never a guess
    for (const project of ['delta', 'epsilon']) {
      expect(cardOf(project), project).toBeTruthy()
      expect(chip(project), project).toBeNull()
      expect(meta(project), project).not.toMatch(/v\d|img/)
    }
    expect(document.querySelector('#dashboard img')).toBeNull()
    // the sidebar's Sessions line counts the older builds
    expect(older()).toBe('2 on an older build')

    // the card stays compact: nothing extra on the current build, one marker on an older one
    expect(chip('alpha')).toBeNull()
    expect(chip('beta')?.textContent).toBe('older build')
    expect(hint('beta')).toBe(RESTART)
  })

  it('points at Update agents while the host still runs the old runtime, installed or not, and says restart once it is registered to the new one', async () => {
    const d = open()
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.6'))
    // the sidebar's Sessions line re-reads the build state, as opening the Live drawer did
    const reopen = async (): Promise<void> => {
      click(document.getElementById('sessionsIndicator'))
      await settle()
      await pollTick()
    }

    await bootApp(d, { viewer: release.viewer })
    await pollTick()
    expect(hint('beta')).toBe(UPDATE)

    // the new runtime is installed, but Claude Code is still registered to the
    // old one: a restart alone would load v1.2.6 again (part 1's per-machine gap)
    const current = release.install()
    await reopen()
    expect(hint('beta')).toBe(UPDATE)

    release.register('claude', current)
    await reopen()
    expect(hint('beta')).toBe(RESTART)
  })

  it('re-reads the runtime state when a Setup install finishes, so a card stops pointing at Setup', async () => {
    const d = open()
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.installVersion('1.2.6'))
    Object.defineProperty(window, 'agentInboxSetup', {
      configurable: true,
      value: {
        available: async () => true,
        install: async (target: string) => {
          release.register('claude', release.install())
          return { ok: true, exitCode: 0, target, timedOut: false, output: 'installed' }
        },
      },
    })

    await bootApp(d, { viewer: release.viewer })
    await pollTick()
    expect(hint('beta')).toBe(UPDATE)

    click(document.querySelector('.setup-run-btn'))
    await settle()
    await pollTick()
    expect(hint('beta')).toBe(RESTART)
  })

  it('follows each session\'s own install source: a runtime, a checkout, or unknown', async () => {
    const d = open()
    seed(d, { session: 'runtime', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    seed(d, { session: 'checkout', project: 'gamma', agent: 'copilot', version: '1.2.6', source: 'checkout', working: true })
    seed(d, { session: 'legacy', project: 'delta', agent: 'copilot', version: '1.2.6', source: null, working: true })
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.install())

    await bootApp(d, { viewer: release.viewer })
    await pollTick()

    expect(hint('beta')).toBe(RESTART)
    expect(hint('gamma')).toBe(CHECKOUT)
    expect(hint('delta')).toBe('older build (v1.2.6)')
    // every older build is marked on its card, with its own advice
    expect(chip('delta')?.textContent).toBe('older build')
  })

  it('offers no remedy when Setup could not install the runtime here', async () => {
    const d = open()
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    const release = releaseRuntime('2.0.0', { hostPayload: false })
    release.register('claude', release.installVersion('1.2.6'))

    await bootApp(d, { viewer: release.viewer })
    await pollTick()

    expect(hint('beta')).toBe('older build (v1.2.6)')
    expect(chip('beta')?.textContent).toBe('older build')
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

  it('never guesses the current build: without one, the panel keeps its labels and nothing is marked older', async () => {
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

    expect(meta('beta')).toMatch(/ · v1\.2\.6$/)
    expect(panelHint()).toBeNull()
    expect(meta('gamma')).toMatch(/ · v1\.9\.0$/)
    expect(['alpha', 'beta', 'gamma'].map(chip).filter(Boolean)).toEqual([])
    expect(older()).toBeNull()
  })

  it('narrows the advice to each session\'s own host: Copilot still on the old runtime is told to update, Claude on the new one to restart', async () => {
    const d = open()
    seed(d, { session: 'claude', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    seed(d, { session: 'copilot', project: 'gamma', agent: 'copilot', version: '1.2.6', working: true })
    const release = releaseRuntime('2.0.0')
    release.register('claude', release.install())
    release.register('copilot', release.installVersion('1.2.6'))

    await bootApp(d, { viewer: release.viewer })
    await pollTick()

    expect(hint('beta')).toBe(RESTART)
    expect(hint('gamma')).toBe(UPDATE)
    expect(chip('gamma')?.textContent).toBe('older build')
  })

  it('gives a runtime session no advice when its host is not registered to Setup\'s runtime, or is not a host Setup registers', async () => {
    const d = open()
    seed(d, { session: 'unregistered', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    seed(d, { session: 'checkout-host', project: 'gamma', agent: 'copilot', version: '1.2.6', working: true })
    seed(d, { session: 'other-client', project: 'delta', agent: 'codex', version: '1.2.6', working: true })
    const release = releaseRuntime('2.0.0')
    release.install()
    // Copilot CLI is registered to a source checkout; Claude Code to nothing
    const checkout = join(release.home, 'checkout')
    mkdirSync(join(checkout, 'dist'), { recursive: true })
    writeFileSync(join(checkout, 'package.json'), '{"name":"agent-inbox"}')
    writeFileSync(join(checkout, 'dist', 'mcp-server.js'), '')
    registerHost(release.home, 'copilot', process.execPath, join(checkout, 'dist', 'mcp-server.js'))

    await bootApp(d, { viewer: release.viewer })
    await pollTick()

    for (const project of ['beta', 'gamma', 'delta']) {
      expect(hint(project), project).toBe('older build (v1.2.6)')
      expect(chip(project)?.textContent, project).toBe('older build')
    }
  })

  it('marks a session NEWER than what its host now runs, after agents were matched back to this app', async () => {
    const d = open()
    seed(d, { session: 'ahead', project: 'beta', agent: 'claude-code', version: '2.1.0', working: true })
    seed(d, { session: 'ahead-idle', project: 'gamma', agent: 'claude-code', version: '2.1.0' })
    seed(d, { session: 'unmatched', project: 'delta', agent: 'copilot', version: '2.1.0', working: true })
    const release = releaseRuntime('2.0.0')
    // Claude Code was matched back to this app's v2.0.0; Copilot CLI still runs v2.1.0
    release.register('claude', release.install())
    release.register('copilot', release.installVersion('2.1.0'))

    await bootApp(d, { viewer: release.viewer })
    await pollTick()

    const NEWER = 'newer build (v2.1.0) — restart this session to load v2.0.0'
    expect(hint('beta')).toBe(NEWER)
    expect(hint('gamma')).toBe(NEWER)
    expect(chip('beta')?.textContent).toBe('newer build')
    expect(meta('beta')).toMatch(/ · v2\.1\.0$/)
    expect(panelHint()).toBe(NEWER)
    // only an older build is counted on the Sessions line
    expect(older()).toBeNull()
    // a restart of the unmatched host's session loads v2.1.0 again: nothing to say
    expect(hint('delta')).toBeNull()
  })

  it('points at Setup only when Setup offers the update: not when the app\'s own runtime fails to verify', async () => {
    const d = open()
    seed(d, { session: 'stale', project: 'beta', agent: 'claude-code', version: '1.2.6', working: true })
    const release = releaseRuntime('2.0.0')
    release.install()
    release.register('claude', release.installVersion('1.2.6'))
    // the installed runtime still verifies; the app's copy no longer does, so Setup shows no action
    writeFileSync(join(release.payloadDir, 'dist', 'mcp-server.js'), '// tampered after install\n')

    await bootApp(d, { viewer: release.viewer })
    await pollTick()

    expect(hint('beta')).toBe('older build (v1.2.6)')
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
    expect(['alpha', 'beta', 'gamma'].map(chip).filter(Boolean)).toHaveLength(2)
    expect(document.querySelector('#dashboard [data-session-card] .tone-warn')).toBeNull()
    expect(older()).toBe('2 on an older build')
    await showInbox()

    // exactly the two open questions — the two older builds add nothing
    expect(badgeCount()).toBe(2)
    expect(tabCount('needsYou')).toBe('2')
    expect(rows()).toHaveLength(2)
    // the asking session is still live, so its question is still waiting on you
    expect(rows().find((r) => r.dataset['cardId'] === asked)?.textContent).toContain('Waiting')
  })
})
