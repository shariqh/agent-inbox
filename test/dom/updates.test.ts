// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard } from '../../src/store.js'
import { badgeCount, bootApp, click, freshDb, rowTitles, settle, tabCount, useDomTest } from './harness.js'

useDomTest()

type UpdateState = {
  status: 'idle' | 'checking' | 'current' | 'available' | 'stale' | 'unverified' | 'unsupported'
    | 'downloading' | 'verified' | 'download-failed' | 'installing' | 'install-failed'
  currentVersion: string
  automaticChecks: boolean
  checkedAt: string | null
  message?: string
  installNotice?: string
  available?: {
    version: string
    tag: string
    releaseUrl: string
    target: { packageType: string; installStrategy: string }
    downloadable?: boolean
    installable?: boolean
    installPermitted?: boolean
    reason?: string
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
  const install = vi.fn(async () => {})
  const restart = vi.fn(async () => true)
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
      install,
      restart,
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
    install,
    restart,
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
    expect(visibleActions()).toEqual(['Check now', 'Open Releases'])
    expect((document.querySelector('.updates-progress') as HTMLProgressElement).hidden).toBe(true)

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

function offered(
  status: UpdateState['status'],
  downloadable: boolean,
  download?: UpdateState['download'],
  extra: {
    installable?: boolean
    installPermitted?: boolean
    reason?: string
    message?: string
    strategy?: 'appimage-self-replace'
  } = {},
): UpdateState {
  return state(status, {
    checkedAt: '2026-02-01T00:00:00.000Z',
    ...(extra.message !== undefined ? { message: extra.message } : {}),
    available: {
      version: '1.3.0',
      tag: 'v1.3.0',
      releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v1.3.0',
      target: extra.strategy === 'appimage-self-replace'
        ? { packageType: 'appimage', installStrategy: 'appimage-self-replace' }
        : downloadable || extra.reason !== undefined
          ? { packageType: 'dmg', installStrategy: 'macos-dmg' }
          : { packageType: 'deb', installStrategy: 'deb-notify' },
      downloadable,
      installable: extra.installable ?? false,
      // Main permits the window it bound, as on every launch that was not reloaded.
      installPermitted: extra.installPermitted ?? extra.installable ?? false,
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
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
      offered('available', false, undefined, { reason: NOT_HERE }),
      offered('verified', true, { receivedBytes: 2 * MB, totalBytes: 2 * MB }, { installable: true }),
      offered('installing', true, undefined, { installable: true }),
      offered('install-failed', true, undefined, { installable: true, message: FAILED }),
      state('idle', { installNotice: NOTICE }),
      { ...offered('verified', true, { receivedBytes: 2 * MB, totalBytes: 2 * MB }, { installable: true }), installNotice: NOTICE },
      // #216: a window main no longer lets install is update state too.
      offered('verified', true, { receivedBytes: 2 * MB, totalBytes: 2 * MB }, { installable: true, installPermitted: false }),
      offered('install-failed', true, undefined, { installable: true, installPermitted: false, message: RESTART }),
      offered('verified', true, { receivedBytes: 2 * MB, totalBytes: 2 * MB }, { installable: true, installPermitted: false, strategy: 'appimage-self-replace' }),
    ]) {
      bridge.emit(next)
      await settle()
      expect(signal()).toEqual(before)
    }
  })
})

const NOT_HERE = 'Move Agent Inbox to your Applications folder to install updates from the app.'
const NOTICE = 'Version 1.3.0 could not be installed, so Agent Inbox is still on 1.1.1. macOS did not allow replacing the app. You can install it manually from the release page.'
const FAILED = 'The update could not be installed. Nothing was changed. Try again or use Review release.'
const RESTART = 'Restart Agent Inbox to install this update.'
const REOPEN = 'Quit and reopen Agent Inbox to install this update.'
const RESTART_REFUSED = 'Agent Inbox didn’t restart. If agent setup is running, try again when it finishes.'

describe('installing a verified update', () => {
  const MB = 1024 * 1024
  const verified = () => offered('verified', true, { receivedBytes: 338 * MB, totalBytes: 338 * MB }, { installable: true })

  it('offers Install and restart for a verified download this installation can install', async () => {
    const bridge = await boot()
    bridge.emit(verified())

    expect(document.querySelector('.updates-state')?.textContent).toBe('Agent Inbox 1.3.0 is downloaded and verified.')
    expect(document.querySelector('.updates-detail')?.textContent).toBe(
      'Its size and SHA-256 match the signed release. Agent Inbox will install it and restart.',
    )
    expect(visibleActions()).toEqual(['Check now', 'Install and restart', 'Review release'])
    expect(document.querySelector('.updates-review')?.classList.contains('updates-secondary')).toBe(true)
    expect(bridge.install).not.toHaveBeenCalled()

    click(document.querySelector('.updates-install'))
    expect(bridge.install).toHaveBeenCalledOnce()
    expect(bridge.download).not.toHaveBeenCalled()
  })

  it('shows the install in progress without any conflicting action', async () => {
    const bridge = await boot()
    bridge.emit(offered('installing', true, undefined, { installable: true }))

    expect(document.querySelector('.updates-state')?.textContent).toBe(
      'Installing version 1.3.0. Agent Inbox will restart when it’s ready.',
    )
    expect(visibleActions()).toEqual(['Check now'])
    expect((document.querySelector('.updates-check') as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector('.updates-progress') as HTMLProgressElement).hidden).toBe(true)
    expect((document.querySelector('.updates-detail') as HTMLElement).hidden).toBe(true)
  })

  it('explains a failed install and offers Try again and Review release', async () => {
    const bridge = await boot()
    bridge.emit(offered('install-failed', true, undefined, { installable: true, message: FAILED }))

    expect(document.querySelector('.updates-state')?.textContent).toBe('Agent Inbox 1.3.0 couldn’t be installed.')
    expect(document.querySelector('.updates-detail')?.textContent).toBe(FAILED)
    expect(visibleActions()).toEqual(['Check now', 'Try again', 'Review release'])
    click(document.querySelector('.updates-install'))
    expect(bridge.install).toHaveBeenCalledOnce()
    expect(bridge.download).not.toHaveBeenCalled()
    click(document.querySelector('.updates-review'))
    expect(bridge.openRelease).toHaveBeenCalledOnce()
  })

  it('says why an offer cannot install here and leaves only Review release', async () => {
    const bridge = await boot()
    bridge.emit(offered('available', false, undefined, { reason: NOT_HERE }))

    expect(document.querySelector('.updates-state')?.textContent).toBe('Agent Inbox 1.3.0 is available.')
    expect(document.querySelector('.updates-detail')?.textContent).toBe(NOT_HERE)
    expect(visibleActions()).toEqual(['Check now', 'Review release'])
  })

  it('keeps keyboard focus inside Updates when Install hides itself, but only while the window has focus', async () => {
    const bridge = await boot()
    bridge.emit(verified())
    const install = document.querySelector('.updates-install') as HTMLButtonElement
    install.focus()
    bridge.emit(offered('installing', true, undefined, { installable: true }))
    expect(document.activeElement).toBe(document.getElementById('updates-settings'))

    bridge.emit(verified())
    const again = document.querySelector('.updates-install') as HTMLButtonElement
    again.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    bridge.emit(offered('installing', true, undefined, { installable: true }))
    expect(document.activeElement).not.toBe(document.getElementById('updates-settings'))
  })
})

describe('after an install that did not take effect', () => {
  const MB = 1024 * 1024
  const notice = () => document.querySelector('.updates-notice') as HTMLElement

  it('says so on startup and offers the release page', async () => {
    const bridge = await boot(state('idle', { installNotice: NOTICE }))

    expect(notice().hidden).toBe(false)
    expect(notice().textContent).toBe(NOTICE)
    expect(visibleActions()).toEqual(['Check now', 'Open Releases'])
    click(document.querySelector('.updates-releases'))
    expect(bridge.openRelease).toHaveBeenCalledOnce()
  })

  it('keeps the explanation on the next offer of that version and still allows Try again', async () => {
    const bridge = await boot()
    bridge.emit({ ...offered('verified', true, { receivedBytes: 2 * MB, totalBytes: 2 * MB }, { installable: true }), installNotice: NOTICE })

    expect(notice().textContent).toBe(NOTICE)
    expect(visibleActions()).toEqual(['Check now', 'Install and restart', 'Review release'])

    bridge.emit(offered('verified', true, { receivedBytes: 2 * MB, totalBytes: 2 * MB }, { installable: true }))
    expect(notice().hidden).toBe(true)
    expect(notice().textContent).toBe('')
  })

  it('shows why a verified download had to be fetched again', async () => {
    const bridge = await boot()
    const changed = 'The downloaded update changed on disk, so it was removed. Download it again.'
    bridge.emit(offered('download-failed', true, { receivedBytes: 0, totalBytes: 338 * MB }, { installable: true, message: changed }))

    expect(document.querySelector('.updates-detail')?.textContent).toBe(changed)
    expect(visibleActions()).toEqual(['Check now', 'Try again', 'Review release'])

    bridge.emit(offered('download-failed', true, { receivedBytes: 10 * MB, totalBytes: 338 * MB }))
    expect(document.querySelector('.updates-detail')?.textContent).toBe('Nothing unverified was kept. Try again, or review the release on GitHub.')
  })
})

// #216: after a reload or crash main could not re-prove, the window may no
// longer install. Settings must not keep offering an Install and restart that
// main would refuse until the app restarts.
describe('when this window may not install', () => {
  const MB = 1024 * 1024
  const bytes = { receivedBytes: 338 * MB, totalBytes: 338 * MB }
  const detail = () => document.querySelector('.updates-detail') as HTMLElement

  it('asks for a restart on macOS instead of offering Install and restart', async () => {
    const bridge = await boot()
    bridge.emit(offered('verified', true, bytes, { installable: true, installPermitted: false }))

    expect(document.querySelector('.updates-state')?.textContent).toBe('Agent Inbox 1.3.0 is downloaded and verified.')
    expect(detail().hidden).toBe(false)
    expect(detail().textContent).toBe(RESTART)
    expect(visibleActions()).toEqual(['Check now', 'Restart Agent Inbox', 'Review release'])
    expect(document.querySelector('.updates-review')?.classList.contains('updates-secondary')).toBe(true)

    click(document.querySelector('.updates-restart'))
    expect(bridge.restart).toHaveBeenCalledOnce()
    expect(bridge.install).not.toHaveBeenCalled()
  })

  it('says so when main does not restart, rather than leave a button that did nothing', async () => {
    const bridge = await boot()
    bridge.restart.mockResolvedValueOnce(false)
    bridge.emit(offered('verified', true, bytes, { installable: true, installPermitted: false }))

    click(document.querySelector('.updates-restart'))
    await settle()
    expect(detail().hidden).toBe(false)
    expect(detail().textContent).toBe(RESTART_REFUSED)

    // The next state from main paints as usual.
    bridge.emit(offered('verified', true, bytes, { installable: true, installPermitted: false }))
    expect(detail().textContent).toBe(RESTART)
  })

  it('asks to quit and reopen an AppImage, which cannot restart itself from here', async () => {
    const bridge = await boot()
    bridge.emit(offered('verified', true, bytes, { installable: true, installPermitted: false, strategy: 'appimage-self-replace' }))

    expect(detail().textContent).toBe(REOPEN)
    expect(visibleActions()).toEqual(['Check now', 'Review release'])
    expect(bridge.restart).not.toHaveBeenCalled()
  })

  it.each([
    ['macOS', undefined, RESTART, ['Check now', 'Restart Agent Inbox', 'Review release']],
    ['an AppImage', 'appimage-self-replace', REOPEN, ['Check now', 'Review release']],
  ] as const)('turns main’s refusal on %s into the same request, never a Try again', async (_host, strategy, copy, actions) => {
    const bridge = await boot()
    bridge.emit(offered('install-failed', true, undefined, {
      installable: true,
      installPermitted: false,
      message: 'Restart Agent Inbox to install this update.',
      ...(strategy ? { strategy } : {}),
    }))

    expect(document.querySelector('.updates-state')?.textContent).toBe('Agent Inbox 1.3.0 couldn’t be installed.')
    expect(detail().textContent).toBe(copy)
    expect(visibleActions()).toEqual([...actions])
  })

  it('offers Install and restart again once main binds the window again, and moves focus with the action', async () => {
    const bridge = await boot()
    bridge.emit(offered('verified', true, bytes, { installable: true }))
    const install = document.querySelector('.updates-install') as HTMLButtonElement
    install.focus()

    bridge.emit(offered('verified', true, bytes, { installable: true, installPermitted: false }))
    expect(document.activeElement).toBe(document.querySelector('.updates-restart'))

    bridge.emit(offered('verified', true, bytes, { installable: true }))
    expect(visibleActions()).toEqual(['Check now', 'Install and restart', 'Review release'])
    expect(detail().textContent).toBe('Its size and SHA-256 match the signed release. Agent Inbox will install it and restart.')
    expect(document.querySelector('.updates-restart')?.hasAttribute('hidden')).toBe(true)
  })

  it('never asks for a restart while an install runs, or for an offer that does not install here', async () => {
    const bridge = await boot()
    bridge.emit(offered('installing', true, undefined, { installable: true, installPermitted: false }))
    expect(visibleActions()).toEqual(['Check now'])

    bridge.emit(offered('verified', true, bytes))
    expect(visibleActions()).toEqual(['Check now', 'Review release'])
    expect(detail().textContent).toContain('later update')

    bridge.emit(offered('available', true, undefined, { installable: true, installPermitted: false }))
    expect(visibleActions()).toEqual(['Check now', 'Download update', 'Review release'])
    expect(detail().hidden).toBe(true)
  })
})
