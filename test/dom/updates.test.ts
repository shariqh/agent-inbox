// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard } from '../../src/store.js'
import { badgeCount, bootApp, click, freshDb, rowTitles, settle, tabCount, useDomTest } from './harness.js'

useDomTest()

type UpdateState = {
  status: 'idle' | 'checking' | 'current' | 'available' | 'stale' | 'unverified' | 'unsupported'
    | 'downloading' | 'verified' | 'download-failed'
  currentVersion: string
  automaticChecks: boolean
  checkedAt: string | null
  available?: {
    version: string
    tag: string
    releaseUrl: string
    target: { packageType: string; installStrategy: string }
    downloadable?: boolean
  }
  download?: { receivedBytes: number; totalBytes: number }
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
  const download = vi.fn(async () => {})
  const cancelDownload = vi.fn(async () => {})
  Object.defineProperty(window, 'agentInboxUpdates', {
    configurable: true,
    value: {
      available: true,
      getState: vi.fn(async () => initial),
      check,
      setAutomatic,
      openRelease,
      download,
      cancelDownload,
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
    download,
    cancelDownload,
    emit(next: UpdateState) { listener?.(next) },
    open() { opener?.() },
  }
}

async function boot(initial = state('idle'), seed?: (database: Database.Database) => void) {
  const bridge = installBridge(initial)
  db = freshDb()
  seed?.(db)
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

  it('explains stale release information calmly and keeps only the manual Releases action', async () => {
    const bridge = await boot()
    const status = () => document.querySelector('.updates-state')
    bridge.emit(state('stale', { automaticChecks: true, checkedAt: '2026-02-01T00:00:00.000Z' }))

    expect(status()?.textContent).toBe('Release information was out of date. Agent Inbox will check again automatically.')
    expect(status()?.getAttribute('data-state')).toBe('stale')
    expect(document.querySelector('.updates-review')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('.updates-releases')?.hasAttribute('hidden')).toBe(false)

    bridge.emit(state('stale', { automaticChecks: false, checkedAt: '2026-02-01T00:00:00.000Z' }))
    expect(status()?.textContent).toBe('Release information was out of date. Check again later.')
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

function offered(status: UpdateState['status'], downloadable: boolean, download?: UpdateState['download']): UpdateState {
  return state(status, {
    checkedAt: '2026-02-01T00:00:00.000Z',
    available: {
      version: '1.3.0',
      tag: 'v1.3.0',
      releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v1.3.0',
      target: downloadable
        ? { packageType: 'dmg', installStrategy: 'macos-dmg' }
        : { packageType: 'deb', installStrategy: 'deb-notify' },
      downloadable,
    },
    ...(download ? { download } : {}),
  })
}

function visibleActions() {
  return [...document.querySelectorAll<HTMLButtonElement>('#updates-settings .updates-actions button')]
    .filter((button) => !button.hidden)
    .map((button) => button.textContent)
}

describe('verified update downloads', () => {
  const MB = 1024 * 1024

  it('offers Download update only for downloadable releases and starts it only on click', async () => {
    const bridge = await boot()
    bridge.emit(offered('available', true))
    expect(visibleActions()).toEqual(['Check now', 'Download update', 'Review release'])
    expect(bridge.download).not.toHaveBeenCalled()

    click(document.querySelector('.updates-download'))
    expect(bridge.download).toHaveBeenCalledOnce()

    bridge.emit(offered('available', false))
    expect(visibleActions()).toEqual(['Check now', 'Review release'])
    expect(document.querySelector('.updates-review')?.classList.contains('updates-secondary')).toBe(false)
  })

  it('shows download progress with a cancel action and no live byte counter', async () => {
    const bridge = await boot()
    bridge.emit(offered('downloading', true, { receivedBytes: 45 * MB, totalBytes: 338 * MB }))

    const progress = document.querySelector('.updates-progress') as HTMLProgressElement
    expect(progress.hidden).toBe(false)
    expect(progress.max).toBe(338 * MB)
    expect(progress.value).toBe(45 * MB)
    expect(document.querySelector('.updates-state')?.textContent).toBe('Downloading Agent Inbox 1.3.0…')
    expect(document.querySelector('.updates-detail')?.textContent).toBe('45.0 MB of 338 MB')
    expect(document.querySelector('.updates-detail')?.closest('[aria-live]')).toBeNull()
    expect(visibleActions()).toEqual(['Check now', 'Cancel download', 'Review release'])
    expect((document.querySelector('.updates-check') as HTMLButtonElement).disabled).toBe(true)

    click(document.querySelector('.updates-cancel'))
    expect(bridge.cancelDownload).toHaveBeenCalledOnce()
  })

  it('says a verified download is ready without offering an install that does not exist yet', async () => {
    const bridge = await boot()
    bridge.emit(offered('verified', true, { receivedBytes: 338 * MB, totalBytes: 338 * MB }))

    expect(document.querySelector('.updates-state')?.textContent).toBe('Agent Inbox 1.3.0 is downloaded and verified.')
    expect(document.querySelector('.updates-detail')?.textContent).toContain('SHA-256 match the signed release')
    expect(document.querySelector('.updates-detail')?.textContent).toContain('later update')
    expect((document.querySelector('.updates-progress') as HTMLProgressElement).hidden).toBe(true)
    expect(visibleActions()).toEqual(['Check now', 'Review release'])
    expect(visibleActions().some((label) => /install/i.test(label ?? ''))).toBe(false)
    expect(document.querySelector('.updates-review')?.classList.contains('updates-secondary')).toBe(false)
  })

  it('offers a retry after a failed download', async () => {
    const bridge = await boot()
    bridge.emit(offered('download-failed', true, { receivedBytes: 10 * MB, totalBytes: 338 * MB }))

    expect(document.querySelector('.updates-state')?.textContent).toBe('Agent Inbox 1.3.0 couldn’t be downloaded and verified.')
    expect(visibleActions()).toEqual(['Check now', 'Try again', 'Review release'])
    click(document.querySelector('.updates-download'))
    expect(bridge.download).toHaveBeenCalledOnce()
  })

  it('keeps keyboard focus inside Updates when the pressed action hides itself', async () => {
    const bridge = await boot()
    bridge.emit(offered('available', true))
    const download = document.querySelector('.updates-download') as HTMLButtonElement
    download.focus()

    bridge.emit(offered('downloading', true, { receivedBytes: 0, totalBytes: 338 * MB }))
    expect(document.activeElement).toBe(document.querySelector('.updates-cancel'))
  })

  it('never moves the attention badge, Needs-you count or rows', async () => {
    const seed = (database: Database.Database) => {
      insertItem(database, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'blocked on you' })
      upsertBoard(database, {
        project: 'alpha', stream: 'main', agent: 'claude', title: 'rollout',
        rows: [{ label: 'step', status: 'blocked', note: 'needs you' }],
      })
    }
    const signal = () => ({
      badge: badgeCount(),
      title: document.title,
      needsYou: tabCount('needsYou'),
      rows: rowTitles(),
    })
    const bridge = await boot(state('idle'), seed)
    const before = signal()
    expect(before.badge).toBe(2)

    for (const next of [
      offered('available', true),
      offered('downloading', true, { receivedBytes: MB, totalBytes: 2 * MB }),
      offered('verified', true, { receivedBytes: 2 * MB, totalBytes: 2 * MB }),
      offered('download-failed', true, { receivedBytes: MB, totalBytes: 2 * MB }),
    ]) {
      bridge.emit(next)
      await settle()
      expect(signal()).toEqual(before)
    }
  })
})
