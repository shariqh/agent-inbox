// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { upsertActivity, recordActivityCall } from '../../src/store.js'
import { projectColor } from '../../public/colors.js'
import { advanceClock, bootApp, click, freshDb, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const drawer = (): HTMLElement => document.getElementById('liveDrawer') as HTMLElement
const strip = (): HTMLButtonElement => document.getElementById('liveStrip') as HTMLButtonElement
const pin = (): HTMLButtonElement => document.getElementById('livePin') as HTMLButtonElement
const pointerDown = (el: Element): void => {
  el.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
}

describe('Live session state and project identity', () => {
  it('uses project colors while distinguishing reported work from connection presence', async () => {
    const d = open()
    upsertActivity(d, { session: 'active', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'Reviewing session state' })
    recordActivityCall(d, 'active')
    upsertActivity(d, { session: 'idle', project: 'beta', stream: 'main', agent: 'claude', doing: 'Preparing the release' })
    recordActivityCall(d, 'idle')
    upsertActivity(d, { session: 'idle', project: 'beta', stream: 'main', agent: 'claude', doing: 'open', idle: true, children: [] })

    await bootApp(d)

    const active = drawer().querySelector<HTMLElement>('.live-entry')
    const idle = drawer().querySelector<HTMLElement>('.idle-row')
    const activeDot = active?.querySelector<HTMLElement>('.live-dot')
    const idleDot = idle?.querySelector<HTMLElement>('.live-dot')
    expect(active?.querySelector('.live-state-label')?.textContent).toBe('Reported work')
    expect(idle?.querySelector('.live-state-label')?.textContent).toBe('Connected')
    expect(idle?.querySelector('.live-doing')?.textContent).toBe('Last report: Preparing the release')
    expect(activeDot?.classList.contains('working')).toBe(true)
    expect(idleDot?.classList.contains('idle-session')).toBe(true)
    expect(activeDot?.style.getPropertyValue('--project-dot')).toBe(projectColor('alpha', 'dark').dot)
    expect(idleDot?.style.getPropertyValue('--project-dot')).toBe(projectColor('beta', 'dark').dot)
    expect(document.getElementById('liveStripDot')?.style.getPropertyValue('--project-dot')).toBe(projectColor('alpha', 'dark').dot)
    expect(document.querySelector('#liveStripSessions .live-session .live-dot')?.getAttribute('style')).toContain('--project-dot')
  })

  it('separates a recent Inbox call from a connection that has never made one', async () => {
    const d = open()
    upsertActivity(d, { session: 'called', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'open', idle: true })
    recordActivityCall(d, 'called')
    upsertActivity(d, { session: 'uncalled', project: 'beta', stream: 'main', agent: 'claude', doing: 'open', idle: true })
    advanceClock(2 * 60_000)

    await bootApp(d)

    const connections = [...drawer().querySelectorAll('.idle-row')]
    const called = connections.find((entry) => entry.querySelector('.live-who')?.textContent?.includes('alpha'))
    const uncalled = connections.find((entry) => entry.querySelector('.live-who')?.textContent?.includes('beta'))
    expect(called?.querySelector('.live-age')?.textContent).toBe('Inbox call 2m ago')
    expect(uncalled?.querySelector('.live-age')?.textContent).toBe('connected 2m ago')
    expect(connections.every((entry) => entry.querySelector('.live-doing')?.textContent === 'No task reported yet')).toBe(true)
    expect(drawer().querySelector('.idle-fold > summary')?.textContent).toBe('2 connections · no task reported')
    expect(document.getElementById('liveStripLabel')?.textContent).toBe('2 connected · no task reported')
    expect(drawer().textContent).not.toMatch(/\bIdle\b|\bWorking\b|no agents running/)
  })

  it('says there are no connections only when none are present', async () => {
    await bootApp(open())
    expect(drawer().querySelector('.empty')?.textContent).toBe('No agent connections.')
    expect(document.getElementById('liveStripLabel')?.textContent).toBe('no agent connections')
  })
})

describe('Live drawer dismissal and pinning', () => {
  it('dismisses outside interaction, stays for inside interaction, and lets Escape override a pin', async () => {
    const d = open()
    upsertActivity(d, { session: 'active', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'Reviewing session state' })
    recordActivityCall(d, 'active')
    await bootApp(d)

    click(strip())
    expect(drawer().hidden).toBe(false)
    pointerDown(drawer().querySelector('.live-list')!)
    expect(drawer().hidden).toBe(false)

    pointerDown(document.getElementById('search')!)
    expect(drawer().hidden).toBe(true)
    expect(strip().getAttribute('aria-expanded')).toBe('false')

    click(strip())
    click(pin())
    expect(pin().getAttribute('aria-pressed')).toBe('true')
    expect(drawer().classList.contains('pinned')).toBe(true)
    pointerDown(document.getElementById('search')!)
    expect(drawer().hidden).toBe(false)

    pin().focus()
    pin().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(drawer().hidden).toBe(true)
    expect(pin().getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(strip())
  })
})
