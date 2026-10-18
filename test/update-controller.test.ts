import { describe, expect, it, vi } from 'vitest'

import updateController from '../electron/update-controller.cjs'
import type {
  UpdateArtifact,
  UpdateCheckResult,
  UpdateControllerState,
  UpdateNotification,
  UpdatePreferences,
  UpdateRendererState,
  VerifiedArtifact,
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
    const emitted: UpdateControllerState[] = []
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

function artifactFor(version = '2.0.0', kind: 'dmg' | 'appimage' | 'deb' = 'dmg'): UpdateArtifact {
  const tag = `v${version}`
  const shape = {
    dmg: {
      platform: 'darwin' as const,
      architecture: 'universal' as const,
      packageType: 'dmg' as const,
      installStrategy: 'macos-dmg' as const,
      filename: `Agent-Inbox-${tag}-universal.dmg`,
      minimumSystemVersion: '13.5',
    },
    appimage: {
      platform: 'linux' as const,
      architecture: 'x64' as const,
      packageType: 'appimage' as const,
      installStrategy: 'appimage-self-replace' as const,
      filename: `Agent-Inbox-v${version}-linux-x86_64.AppImage`,
    },
    deb: {
      platform: 'linux' as const,
      architecture: 'x64' as const,
      packageType: 'deb' as const,
      installStrategy: 'deb-notify' as const,
      filename: `agent-inbox_${version}_amd64.deb`,
    },
  }[kind]
  return {
    version,
    tag,
    ...shape,
    url: `https://github.com/shariqh/agent-inbox/releases/download/${tag}/${shape.filename}`,
    byteLength: 1000,
    sha256: 'c'.repeat(64),
  }
}

function availableWith(
  artifact: UpdateArtifact | undefined,
  version = artifact?.version ?? '2.0.0',
  checkedAt = '2026-02-01T00:00:00.000Z',
): UpdateCheckResult {
  const target = artifact
    ? { packageType: artifact.packageType, installStrategy: artifact.installStrategy }
    : { packageType: 'dmg' as const, installStrategy: 'macos-dmg' as const }
  return {
    status: 'available',
    currentVersion: '1.0.0',
    automaticChecks: false,
    checkedAt,
    message: 'A verified update is available.',
    available: {
      version,
      tag: `v${version}`,
      releaseUrl: `https://github.com/shariqh/agent-inbox/releases/tag/v${version}`,
      target,
    },
    ...(artifact ? { artifact } : {}),
  }
}

function fakeDownloader() {
  type Pending = {
    artifact: UpdateArtifact
    onProgress?: (received: number, total: number) => void
    resolve: (value: VerifiedArtifact) => void
    reject: (error: unknown) => void
  }
  const pending: Pending[] = []
  const downloader = {
    normalize: vi.fn((artifact: UpdateArtifact) => (
      artifact.installStrategy === 'deb-notify' ? null : Object.freeze({ ...artifact })
    )),
    download: vi.fn((artifact: UpdateArtifact, options?: { onProgress?: (received: number, total: number) => void }) =>
      new Promise<VerifiedArtifact>((resolve, reject) => {
        pending.push({ artifact, onProgress: options?.onProgress, resolve, reject })
      })),
    cancel: vi.fn(async () => {
      pending.shift()?.reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
    }),
    verify: vi.fn(),
    prune: vi.fn(async () => {}),
  }
  return {
    downloader,
    progress(received: number) {
      const current = pending[0]!
      current.onProgress?.(received, current.artifact.byteLength)
    },
    succeed() {
      const current = pending.shift()!
      current.resolve(Object.freeze({
        path: '/private/agent-inbox/update-downloads/v2/Agent-Inbox.dmg',
        version: current.artifact.version,
        tag: current.artifact.tag,
        filename: current.artifact.filename,
        sha256: current.artifact.sha256,
        byteLength: current.artifact.byteLength,
        packageType: current.artifact.packageType,
        installStrategy: current.artifact.installStrategy,
      }) as VerifiedArtifact)
    },
    fail(code: string) {
      pending.shift()!.reject(Object.assign(new Error(`${code}: /Users/private/secret-path`), { code }))
    },
  }
}

describe('user-initiated verified downloads', () => {
  function setup(checker: (input: { automaticChecks: boolean }) => Promise<UpdateCheckResult>, overrides: {
    preferences?: ReturnType<typeof prefs>
    notifier?: (notification: UpdateNotification) => unknown
    withDownloader?: boolean
  } = {}) {
    const fake = fakeDownloader()
    const emitted: UpdateControllerState[] = []
    const checkerMock = vi.fn(checker)
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences: overrides.preferences ?? prefs(),
      checker: checkerMock,
      notifier: overrides.notifier ?? vi.fn(),
      clock: () => new Date('2026-02-01T00:00:00Z'),
      emit: (value) => emitted.push(value),
      ...(overrides.withDownloader === false ? {} : { downloader: fake.downloader }),
    })
    return { controller, emitted, fake, checker: checkerMock }
  }

  it.each(['dmg', 'appimage'] as const)('offers a %s download without starting it or publishing its location', async (kind) => {
    const { controller, fake } = setup(async () => availableWith(artifactFor('2.0.0', kind)))

    const checked = await controller.checkNow()
    expect(checked).toMatchObject({ status: 'available', available: { version: '2.0.0', downloadable: true } })
    expect(fake.downloader.download).not.toHaveBeenCalled()
    expect(JSON.stringify(checked)).not.toContain('/download/')
    expect(JSON.stringify(checked)).not.toContain('c'.repeat(64))
    expect(fake.downloader.prune).toHaveBeenCalledWith({
      keep: expect.objectContaining({ version: '2.0.0', installStrategy: artifactFor('2.0.0', kind).installStrategy }),
      currentVersion: '1.0.0',
    })
  })

  it.each([
    ['a deb install', () => availableWith(artifactFor('2.0.0', 'deb')), true],
    ['a build without a downloader', () => availableWith(artifactFor()), false],
    ['a checker that pins no artifact', () => availableWith(undefined), true],
  ] as const)('keeps %s notify-only', async (_label, result, withDownloader) => {
    const { controller, fake } = setup(async () => result(), { withDownloader })

    const checked = await controller.checkNow()
    expect(checked).toMatchObject({ status: 'available', available: { downloadable: false } })
    await expect(controller.downloadNow()).resolves.toBe(checked)
    expect(fake.downloader.download).not.toHaveBeenCalled()
  })

  it('refuses an artifact that does not belong to the verified release', async () => {
    const { controller } = setup(async () => availableWith(artifactFor('3.0.0'), '2.0.0'))

    const checked = await controller.checkNow()
    expect(checked.status).toBe('unverified')
    expect(checked.available).toBeUndefined()
  })

  it('moves available → downloading → verified with bounded progress and exposes the installer seam', async () => {
    const { controller, emitted, fake } = setup(async () => availableWith(artifactFor()))
    await controller.checkNow()
    expect(controller.getVerifiedArtifact()).toBeNull()

    const finished = controller.downloadNow()
    expect(controller.getState()).toMatchObject({
      status: 'downloading',
      available: { version: '2.0.0', downloadable: true },
      download: { receivedBytes: 0, totalBytes: 1000 },
    })
    for (let received = 1; received <= 1000; received += 1) fake.progress(received)
    expect(controller.getState().download).toEqual({ receivedBytes: 1000, totalBytes: 1000 })
    fake.succeed()

    await expect(finished).resolves.toMatchObject({
      status: 'verified',
      available: { version: '2.0.0', downloadable: true },
      download: { receivedBytes: 1000, totalBytes: 1000 },
    })
    const progressEmits = emitted.filter((value) => value.status === 'downloading')
    expect(progressEmits.length).toBeGreaterThan(2)
    expect(progressEmits.length).toBeLessThanOrEqual(101)
    expect(emitted.map((value) => value.status)).toEqual(['checking', 'available', ...progressEmits.map(() => 'downloading'), 'verified'])
    expect(controller.getVerifiedArtifact()).toMatchObject({
      path: '/private/agent-inbox/update-downloads/v2/Agent-Inbox.dmg',
      version: '2.0.0',
      sha256: 'c'.repeat(64),
      byteLength: 1000,
      installStrategy: 'macos-dmg',
    })
    expect(JSON.stringify(emitted)).not.toContain('/private/')

    await controller.downloadNow()
    expect(fake.downloader.download).toHaveBeenCalledTimes(1)
  })

  it('reports a failed download without internals and retries only when asked', async () => {
    const { controller, fake } = setup(async () => availableWith(artifactFor()))
    await controller.checkNow()

    const first = controller.downloadNow()
    fake.progress(400)
    fake.fail('hash-mismatch')
    const failed = await first
    expect(failed).toMatchObject({
      status: 'download-failed',
      available: { version: '2.0.0', downloadable: true },
      download: { receivedBytes: 400, totalBytes: 1000 },
    })
    expect(JSON.stringify(failed)).not.toContain('secret')
    expect(controller.getVerifiedArtifact()).toBeNull()
    expect(fake.downloader.download).toHaveBeenCalledTimes(1)

    const retry = controller.downloadNow()
    expect(controller.getState().status).toBe('downloading')
    fake.succeed()
    await expect(retry).resolves.toMatchObject({ status: 'verified' })
  })

  it('returns to available when the user cancels', async () => {
    const { controller, fake } = setup(async () => availableWith(artifactFor()))
    await controller.checkNow()

    const pending = controller.downloadNow()
    await controller.cancelDownload()
    await expect(pending).resolves.toMatchObject({ status: 'available', available: { downloadable: true } })
    expect(fake.downloader.cancel).toHaveBeenCalledOnce()
    expect(controller.getState().download).toBeUndefined()
  })

  it('does not run checks while a download is in progress', async () => {
    const { controller, checker } = setup(async () => availableWith(artifactFor()))
    await controller.checkNow()
    void controller.downloadNow()

    await controller.checkNow()
    await controller.runScheduledCheck()
    expect(checker).toHaveBeenCalledOnce()
    expect(controller.getState().status).toBe('downloading')
  })

  it('does not start a download while a check is still starting', async () => {
    const { controller, fake, emitted } = setup(async () => availableWith(artifactFor('2.1.0')))
    await controller.checkNow()

    const rechecking = controller.checkNow()
    expect(controller.getState().status).toBe('available')
    await expect(controller.downloadNow()).resolves.toMatchObject({ status: 'available' })
    await rechecking
    expect(fake.downloader.download).not.toHaveBeenCalled()
    expect(emitted.map((value) => value.status)).not.toContain('downloading')
  })

  it('keeps a verified download across a quiet re-check of the same release or a failed check', async () => {
    let checkedAt = '2026-02-01T00:00:00.000Z'
    let offline = false
    const { controller, emitted, fake } = setup(async () => {
      if (offline) throw new Error('offline')
      return availableWith(artifactFor(), '2.0.0', checkedAt)
    })
    await controller.checkNow()
    const done = controller.downloadNow()
    fake.succeed()
    await done
    emitted.length = 0

    checkedAt = '2026-02-02T00:00:00.000Z'
    const rechecked = await controller.checkNow()
    expect(rechecked).toMatchObject({ status: 'verified', checkedAt })
    offline = true
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'verified', checkedAt })
    expect(emitted.map((value) => value.status)).not.toContain('checking')
    expect(controller.getVerifiedArtifact()).not.toBeNull()
  })

  it.each([
    ['a newer release', () => availableWith(artifactFor('2.1.0')), 'available', '2.1.0'],
    ['no newer release', (): UpdateCheckResult => ({ ...state('current', false), currentVersion: '1.0.0' }), 'current', null],
  ] as const)('discards a verified download superseded by %s', async (_label, next, status, keepVersion) => {
    let result: () => UpdateCheckResult = () => availableWith(artifactFor())
    const { controller, fake } = setup(async () => result())
    await controller.checkNow()
    const done = controller.downloadNow()
    fake.succeed()
    await done
    fake.downloader.prune.mockClear()

    result = next
    const checked = await controller.checkNow()
    expect(checked.status).toBe(status)
    expect(controller.getVerifiedArtifact()).toBeNull()
    expect(fake.downloader.prune).toHaveBeenCalledWith({
      keep: keepVersion === null ? null : expect.objectContaining({ version: keepVersion }),
      currentVersion: '1.0.0',
    })
    if (status === 'available') expect(checked.available).toMatchObject({ version: '2.1.0', downloadable: true })
  })

  it('cancels an in-flight download when disposed', async () => {
    const { controller, fake } = setup(async () => availableWith(artifactFor()))
    await controller.checkNow()
    void controller.downloadNow()

    controller.dispose()
    expect(fake.downloader.cancel).toHaveBeenCalledOnce()
  })

  it('cleans up stale downloads once, when the renderer first becomes ready', async () => {
    const { controller, fake } = setup(async () => availableWith(artifactFor()))

    await controller.rendererReady()
    await controller.rendererReady()
    expect(fake.downloader.prune).toHaveBeenCalledOnce()
    expect(fake.downloader.prune).toHaveBeenCalledWith({ currentVersion: '1.0.0' })
  })

  it.each([
    ['dmg', true],
    ['deb', false],
  ] as const)('tells the notifier whether a %s release downloads in the app', async (kind, downloadable) => {
    const notifier = vi.fn()
    const { controller } = setup(async () => availableWith(artifactFor('2.0.0', kind)), {
      notifier,
      preferences: prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null }),
    })

    await controller.runScheduledCheck()
    expect(notifier).toHaveBeenCalledWith({
      version: '2.0.0',
      tag: 'v2.0.0',
      releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v2.0.0',
      downloadable,
    })
  })
})
