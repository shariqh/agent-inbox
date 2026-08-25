// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { upsertActivity, recordActivityCall } from '../../src/store.js'
import { projectColor } from '../../public/colors.js'
import { bootApp, click, freshDb, useDomTest } from './harness.js'

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
  it('uses project colors while naming working and idle states explicitly', async () => {
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
    expect(active?.querySelector('.live-state-label')?.textContent).toBe('Working')
    expect(idle?.querySelector('.live-state-label')?.textContent).toBe('Idle')
    expect(idle?.querySelector('.live-doing')?.textContent).toBe('Last activity: Preparing the release')
    expect(activeDot?.classList.contains('working')).toBe(true)
    expect(idleDot?.classList.contains('idle-session')).toBe(true)
    expect(activeDot?.style.getPropertyValue('--project-dot')).toBe(projectColor('alpha', 'dark').dot)
    expect(idleDot?.style.getPropertyValue('--project-dot')).toBe(projectColor('beta', 'dark').dot)
    expect(document.getElementById('liveStripDot')?.style.getPropertyValue('--project-dot')).toBe(projectColor('alpha', 'dark').dot)
    expect(document.querySelector('#liveStripSessions .live-session .live-dot')?.getAttribute('style')).toContain('--project-dot')
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
