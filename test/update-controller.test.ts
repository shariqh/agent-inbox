import { describe, expect, it, vi } from 'vitest'

import updateController from '../electron/update-controller.cjs'
import type {
  UpdatePreferences,
  UpdateRendererState,
} from '../electron/update-controller.cjs'

const {
  MANUAL_RELEASES_URL,
  createUpdateController,
} = updateController

function prefs(initial: UpdatePreferences = {
  schema: 1,
  automaticChecks: false,
  lastNotifiedVersion: null,
}) {
  let value = { ...initial }
  return {
    read: vi.fn(async () => ({ ...value })),
    setAutomatic: vi.fn(async (automaticChecks: boolean) => {
      value = { ...value, automaticChecks }
      return { ...value }
    }),
    setLastNotifiedVersion: vi.fn(async (lastNotifiedVersion: string) => {
      value = { ...value, lastNotifiedVersion }
      return { ...value }
    }),
    replace(next: UpdatePreferences) {
      value = { ...next }
    },
  }
}

function state(
  status: UpdateRendererState['status'],
  automaticChecks: boolean,
  version = '2.0.0',
): UpdateRendererState {
  return {
    status,
    currentVersion: '1.0.0',
    automaticChecks,
    checkedAt: status === 'idle' ? null : '2026-02-01T00:00:00.000Z',
    message: status === 'available' ? 'A verified update is available.' : 'Agent Inbox is up to date.',
    ...(status === 'available'
      ? {
          available: {
            version,
            tag: `v${version}`,
            releaseUrl: `https://github.com/shariqh/agent-inbox/releases/tag/v${version}`,
            target: { packageType: 'dmg' as const, installStrategy: 'macos-dmg' as const },
          },
        }
      : {}),
  }
}

describe('update controller', () => {
  it('exposes a compile-time manual recovery URL and a closed safe initial state', () => {
    const preferences = prefs()
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences,
      checker: vi.fn(),
      notifier: vi.fn(),
    })
    expect(MANUAL_RELEASES_URL).toBe('https://github.com/shariqh/agent-inbox/releases')
    expect(controller.getState()).toEqual({
      status: 'idle',
      currentVersion: '1.0.0',
      automaticChecks: false,
      checkedAt: null,
      message: 'Updates have not been checked.',
    })
  })

  it('schedules only after renderer readiness, then re-arms at 24h with bounded jitter', async () => {
    vi.useFakeTimers()
    try {
      const preferences = prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null })
      const checker = vi.fn(async ({ automaticChecks }) => state('current', automaticChecks))
      const controller = createUpdateController({
        currentVersion: '1.0.0',
        preferences,
        checker,
        notifier: vi.fn(),
        clock: () => new Date('2026-02-01T00:00:00Z'),
        setTimeoutImpl: setTimeout,
        clearTimeoutImpl: clearTimeout,
        random: () => 1,
        initialDelayMs: 100,
        jitterRatio: 0.1,
      })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(checker).not.toHaveBeenCalled()
      await controller.rendererReady()
      await vi.advanceTimersByTimeAsync(99)
      expect(checker).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(checker).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 * 1.1 - 1)
      expect(checker).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(checker).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-reads scheduled preferences, stops when disabled, and performs no catch-up', async () => {
    vi.useFakeTimers()
    try {
      const preferences = prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null })
      const checker = vi.fn(async ({ automaticChecks }) => state('current', automaticChecks))
      const controller = createUpdateController({
        currentVersion: '1.0.0',
        preferences,
        checker,
        notifier: vi.fn(),
        setTimeoutImpl: setTimeout,
        clearTimeoutImpl: clearTimeout,
        random: () => 0.5,
        initialDelayMs: 0,
      })
      await controller.rendererReady()
      await vi.advanceTimersByTimeAsync(0)
      expect(checker).toHaveBeenCalledTimes(1)

      preferences.replace({ schema: 1, automaticChecks: false, lastNotifiedVersion: null })
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
      expect(preferences.read).toHaveBeenCalledTimes(6)
      expect(checker).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60_000)
      expect(checker).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('deduplicates manual and scheduled checks in flight', async () => {
    let resolveCheck!: (value: UpdateRendererState) => void
    const pending = new Promise<UpdateRendererState>((resolve) => { resolveCheck = resolve })
    const preferences = prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null })
    const checker = vi.fn(() => pending)
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences,
      checker,
      notifier: vi.fn(),
    })

    const manual = controller.checkNow()
    const scheduled = controller.runScheduledCheck()
    await Promise.resolve()
    expect(checker).toHaveBeenCalledTimes(1)
    resolveCheck(state('current', true))
    await expect(manual).resolves.toMatchObject({ status: 'current' })
    await expect(scheduled).resolves.toMatchObject({ status: 'current' })
  })

  it('does not turn a disabled manual check into an automatic notification when deduplicated', async () => {
    let resolveCheck!: (value: UpdateRendererState) => void
    const pending = new Promise<UpdateRendererState>((resolve) => { resolveCheck = resolve })
    const preferences = prefs()
    const notifier = vi.fn()
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences,
      checker: vi.fn(() => pending),
      notifier,
    })

    const manual = controller.checkNow()
    const scheduled = controller.runScheduledCheck()
    resolveCheck(state('available', false))
    await Promise.all([manual, scheduled])
    expect(notifier).not.toHaveBeenCalled()
    expect(preferences.setLastNotifiedVersion).not.toHaveBeenCalled()
  })

  it('notifies at most once per persisted available version without losing preferences', async () => {
    const preferences = prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null })
    const checker = vi.fn(async ({ automaticChecks }) => state('available', automaticChecks))
    const notifier = vi.fn(async () => {})
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences,
      checker,
      notifier,
    })

    await controller.runScheduledCheck()
    await controller.runScheduledCheck()
    expect(notifier).toHaveBeenCalledTimes(1)
    expect(preferences.setLastNotifiedVersion).toHaveBeenCalledTimes(1)
    await expect(preferences.read()).resolves.toEqual({
      schema: 1,
      automaticChecks: true,
      lastNotifiedVersion: '2.0.0',
    })
  })

  it('maps internal failures to a safe unverified state and never notifies for automatic failures', async () => {
    const preferences = prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null })
    const notifier = vi.fn()
    const emitted: UpdateRendererState[] = []
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences,
      checker: vi.fn(async () => { throw new Error('private proxy host and stack') }),
      notifier,
      emit: (value) => emitted.push(value),
      clock: () => new Date('2026-02-01T00:00:00Z'),
    })

    const result = await controller.runScheduledCheck()
    expect(result).toEqual({
      status: 'unverified',
      currentVersion: '1.0.0',
      automaticChecks: true,
      checkedAt: '2026-02-01T00:00:00.000Z',
      message: 'The update could not be verified. Try again or use the releases page.',
    })
    expect(JSON.stringify(result)).not.toContain('proxy')
    expect(notifier).not.toHaveBeenCalled()
    expect(emitted.at(-1)).toEqual(result)
  })

  it('refuses untrusted release metadata returned by a checker', async () => {
    const preferences = prefs()
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences,
      checker: vi.fn(async () => ({
        ...state('available', false),
        message: 'internal secret',
        available: {
          ...state('available', false).available!,
          releaseUrl: 'https://example.com/renderer-controlled',
        },
      })),
      notifier: vi.fn(),
      clock: () => new Date('2026-02-01T00:00:00Z'),
    })

    const result = await controller.checkNow()
    expect(result.status).toBe('unverified')
    expect(result.available).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('example.com')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('re-arms when automatic checks are enabled and cancels when disabled', async () => {
    vi.useFakeTimers()
    try {
      const preferences = prefs()
      const checker = vi.fn(async ({ automaticChecks }) => state('current', automaticChecks))
      const controller = createUpdateController({
        currentVersion: '1.0.0',
        preferences,
        checker,
        notifier: vi.fn(),
        setTimeoutImpl: setTimeout,
        clearTimeoutImpl: clearTimeout,
        initialDelayMs: 10,
      })
      await controller.rendererReady()
      await controller.setAutomaticChecks(true)
      await vi.advanceTimersByTimeAsync(10)
      expect(checker).toHaveBeenCalledTimes(1)
      await controller.setAutomaticChecks(false)
      await vi.advanceTimersByTimeAsync(48 * 60 * 60_000)
      expect(checker).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restore or re-arm automatic checks disabled while a scheduled check is in flight', async () => {
    vi.useFakeTimers()
    try {
      let resolveCheck!: (value: UpdateRendererState) => void
      const pending = new Promise<UpdateRendererState>((resolve) => { resolveCheck = resolve })
      const preferences = prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null })
      const checker = vi.fn(() => pending)
      const controller = createUpdateController({
        currentVersion: '1.0.0',
        preferences,
        checker,
        notifier: vi.fn(),
        setTimeoutImpl: setTimeout,
        clearTimeoutImpl: clearTimeout,
        initialDelayMs: 0,
      })

      await controller.rendererReady()
      await vi.advanceTimersByTimeAsync(0)
      expect(checker).toHaveBeenCalledTimes(1)
      await controller.setAutomaticChecks(false)
      resolveCheck(state('current', true))
      await vi.advanceTimersByTimeAsync(0)

      expect(controller.getState().automaticChecks).toBe(false)
      await vi.advanceTimersByTimeAsync(48 * 60 * 60_000)
      expect(checker).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still publishes a verified release when notification bookkeeping cannot be saved', async () => {
    const preferences = prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null })
    preferences.setLastNotifiedVersion.mockRejectedValueOnce(new Error('preferences unavailable'))
    const notifier = vi.fn()
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences,
      checker: vi.fn(async ({ automaticChecks }) => state('available', automaticChecks)),
      notifier,
    })

    await expect(controller.runScheduledCheck()).resolves.toMatchObject({
      status: 'available',
      automaticChecks: true,
      available: { version: '2.0.0' },
    })
    expect(notifier).not.toHaveBeenCalled()
  })
})
