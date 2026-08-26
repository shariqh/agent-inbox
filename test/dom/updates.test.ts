// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

type UpdateState = {
  status: 'idle' | 'checking' | 'current' | 'available' | 'unverified' | 'unsupported'
  currentVersion: string
  automaticChecks: boolean
  checkedAt: string | null
  available?: {
    version: string
    tag: string
    releaseUrl: string
    target: { packageType: string; installStrategy: string }
  }
}

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  delete (window as unknown as Record<string, unknown>).agentInboxUpdates
})

function state(status: UpdateState['status'], overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    status,
    currentVersion: '1.1.1',
    automaticChecks: false,
    checkedAt: null,
    ...overrides,
  }
}

function installBridge(initial: UpdateState) {
  let listener: ((next: UpdateState) => void) | null = null
  let opener: (() => void) | null = null
  const check = vi.fn(async () => {})
  const setAutomatic = vi.fn(async () => {})
  const openRelease = vi.fn(async () => {})
  Object.defineProperty(window, 'agentInboxUpdates', {
    configurable: true,
    value: {
      available: true,
      getState: vi.fn(async () => initial),
      check,
      setAutomatic,
      openRelease,
      onState(callback: (next: UpdateState) => void) {
        listener = callback
        return () => { listener = null }
      },
      onOpenUpdates(callback: () => void) {
        opener = callback
        return () => { opener = null }
      },
    },
  })
  return {
    check,
    setAutomatic,
    openRelease,
    emit(next: UpdateState) { listener?.(next) },
    open() { opener?.() },
  }
}

async function boot(initial = state('idle')) {
  const bridge = installBridge(initial)
  db = freshDb()
  await bootApp(db, {
    viewer: {
      setupInfoPath: '/nonexistent/setup-info.json',
      stamp: async () => null as never,
    },
  })
  await settle()
  return bridge
}

describe('desktop update settings', () => {
  it('is absent in browser/dev viewers', async () => {
    db = freshDb()
    await bootApp(db, {
      viewer: {
        setupInfoPath: '/nonexistent/setup-info.json',
        stamp: async () => null as never,
      },
    })
    await settle()
    expect(document.getElementById('updates-settings')).toBeNull()
  })

  it('appears immediately after Appearance in Electron', async () => {
    await boot()
    const headings = [...document.querySelectorAll('#setup .setup-block h3')].map((node) => node.textContent)
    expect(headings.slice(0, 2)).toEqual(['Appearance', 'Updates'])
  })

  it.each([
    ['idle', 'Ready to check', false, false],
    ['checking', 'Checking GitHub', true, false],
    ['current', 'up to date', false, false],
    ['available', '1.2.0 is available', false, true],
    ['unverified', 'Couldn’t check right now', false, false],
    ['unsupported', 'not available for this app build', false, false],
  ] as const)('renders the %s state without replacing focused controls', async (status, copy, disabled, review) => {
    const bridge = await boot()
    const check = document.querySelector('.updates-check') as HTMLButtonElement
    check.focus()
    bridge.emit(state(status, {
      available: status === 'available'
        ? {
            version: '1.2.0',
            tag: 'v1.2.0',
            releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v1.2.0',
            target: { packageType: 'dmg', installStrategy: 'macos-dmg' },
          }
        : undefined,
    }))

    expect(document.querySelector('.updates-state')?.textContent).toContain(copy)
    expect((document.querySelector('.updates-check') as HTMLButtonElement).disabled).toBe(disabled)
    expect(document.querySelector('.updates-review')?.hasAttribute('hidden')).toBe(!review)
    expect(document.activeElement).toBe(check)
  })

  it('checks manually, saves automatic checks, and opens only main-owned release actions', async () => {
    const bridge = await boot(state('unverified'))
    click(document.getElementById('gear'))

    click(document.querySelector('.updates-check'))
    expect(bridge.check).toHaveBeenCalledTimes(1)

    const automatic = document.querySelector('.updates-automatic') as HTMLInputElement
    automatic.checked = true
    automatic.dispatchEvent(new Event('change', { bubbles: true }))
    expect(bridge.setAutomatic).toHaveBeenCalledWith(true)

    click(document.querySelector('.updates-releases'))
    expect(bridge.openRelease).toHaveBeenCalledTimes(1)
  })

  it('opens Settings without toggling it closed, focuses Updates, then checks', async () => {
    const bridge = await boot()
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    bridge.open()
    await settle()
    expect(document.getElementById('setup')?.hidden).toBe(false)
    expect(document.activeElement).toBe(document.getElementById('updates-settings'))
    expect(bridge.check).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })

    bridge.open()
    await settle()
    expect(document.getElementById('setup')?.hidden).toBe(false)
    expect(bridge.check).toHaveBeenCalledTimes(2)
  })

  it('keeps the section mounted when the setup route response cannot be parsed', async () => {
    const bridge = installBridge(state('idle'))
    db = freshDb()
    await bootApp(db, {
      viewer: {
        setupInfoPath: '/nonexistent/setup-info.json',
        stamp: async () => null as never,
      },
      interceptFetch: async (input, _init, next) =>
        String(input) === '/api/setup'
          ? new Response('not json', { status: 500 })
          : await next(),
    })
    await settle()
    expect(bridge).toBeTruthy()
    expect(document.getElementById('updates-settings')).not.toBeNull()
  })
})
