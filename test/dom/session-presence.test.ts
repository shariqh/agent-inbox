// @vitest-environment jsdom
// Session presence on the Agents home (#454, once the Live drawer): project
// identity, reported work against mere connection, and the empty state.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { upsertActivity, recordActivityCall } from '../../src/store.js'
import { projectColor } from '../../public/colors.js'
import { advanceClock, bootApp, freshDb, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const card = (session: string) => document.querySelector<HTMLElement>(`#dashboard [data-session-card="session:${session}"]`)
const indicator = (part: string) => document.querySelector(`#sessionsIndicator .${part}`)?.textContent

describe('session presence and project identity', () => {
  it('uses project colors while distinguishing reported work from connection presence', async () => {
    const d = open()
    upsertActivity(d, { session: 'active', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'Reviewing session state' })
    recordActivityCall(d, 'active')
    upsertActivity(d, { session: 'idle', project: 'beta', stream: 'main', agent: 'claude', doing: 'Preparing the release' })
    recordActivityCall(d, 'idle')
    upsertActivity(d, { session: 'idle', project: 'beta', stream: 'main', agent: 'claude', doing: 'open', idle: true, children: [] })

    await bootApp(d)

    expect(card('active')?.querySelector('.sc-state')?.textContent).toBe('Working')
    expect(card('idle')?.querySelector('.sc-state')?.textContent).toBe('Idle')
    expect(card('idle')?.querySelector('.sc-doing')?.textContent).toBe('was: Preparing the release')
    const group = (session: string) => card(session)?.closest<HTMLElement>('.ah-group')
    expect(group('active')?.style.getPropertyValue('--ah-group')).toBe(projectColor('alpha', 'dark').dot)
    expect(group('idle')?.style.getPropertyValue('--ah-group')).toBe(projectColor('beta', 'dark').dot)
    expect(indicator('si-v')).toBe('1 working')
    expect(indicator('si-s')).toBe('2 connected')
    expect(document.getElementById('sessionsIndicator')?.dataset.tone).not.toBe('idle')
  })

  it('separates a session that has made a call from a connection that never has', async () => {
    const d = open()
    upsertActivity(d, { session: 'called', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'open', idle: true })
    recordActivityCall(d, 'called')
    upsertActivity(d, { session: 'uncalled', project: 'beta', stream: 'main', agent: 'claude', doing: 'open', idle: true })
    advanceClock(2 * 60_000)

    await bootApp(d)

    for (const session of ['called', 'uncalled']) {
      expect(card(session)?.querySelector('.sc-state')?.textContent, session).toBe('Idle')
      expect(card(session)?.querySelector('.sc-doing')?.textContent, session).toBe('No task reported yet')
    }
    expect(indicator('si-v')).toBe('2 connected')
    expect(indicator('si-s')).toBe('no task reported')
    expect(document.querySelector('.agents-home .ah-groups')?.textContent).not.toMatch(/\bWorking\b|no agents running/)
  })

  it('says there are no sessions only when none are present', async () => {
    await bootApp(open())
    expect(document.querySelector<HTMLElement>('.agents-home .ah-empty')?.hidden).toBe(false)
    expect(indicator('si-v')).toBe('No sessions')
    expect(document.getElementById('sessionsIndicator')?.dataset.tone).toBe('idle')
  })
})
