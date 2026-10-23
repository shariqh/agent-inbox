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
import type { OpenedVerifiedArtifact } from '../electron/update-download.cjs'
import updateInstall from '../electron/update-install.cjs'
import type {
  InstallCandidate,
  InstallFeasibility,
  PreparedInstall,
  VerifiedInstallSource,
} from '../electron/update-install.cjs'

const {
  MANUAL_RELEASES_URL,
  createUpdateController,
} = updateController
const { UpdateInstallError } = updateInstall

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
          manifest: 'v2' as const,
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
    manifest: 'v2',
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
    openVerified: vi.fn(async (record: VerifiedArtifact): Promise<OpenedVerifiedArtifact> => ({
      record,
      handle: {
        read: vi.fn(async () => ({ bytesRead: 0 })),
        stat: vi.fn(async () => ({ isFile: () => true, size: record.byteLength })),
        write: vi.fn(async () => ({ bytesWritten: 0 })),
        sync: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
      close: vi.fn(async () => {}),
    })),
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
        architecture: current.artifact.architecture,
        packageType: current.artifact.packageType,
        installStrategy: current.artifact.installStrategy,
        ...(current.artifact.minimumSystemVersion !== undefined
          ? { minimumSystemVersion: current.artifact.minimumSystemVersion }
          : {}),
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

  function staleResult(checkedAt: string): UpdateCheckResult {
    return {
      status: 'stale',
      currentVersion: '1.0.0',
      automaticChecks: false,
      checkedAt,
      message: 'Update information is older than a release this app already verified.',
    }
  }

  it('keeps a verified download and its state when a re-check returns stale release information', async () => {
    let result: () => UpdateCheckResult = () => availableWith(artifactFor())
    const { controller, emitted, fake } = setup(async () => result())
    await controller.checkNow()
    const done = controller.downloadNow()
    fake.succeed()
    const verified = await done
    const record = controller.getVerifiedArtifact()
    fake.downloader.prune.mockClear()
    emitted.length = 0

    result = () => staleResult('2026-02-03T00:00:00.000Z')
    const rechecked = await controller.checkNow()
    await Promise.resolve()

    expect(rechecked).toEqual({ ...verified, checkedAt: '2026-02-03T00:00:00.000Z' })
    expect(controller.getVerifiedArtifact()).toBe(record)
    expect(fake.downloader.prune).not.toHaveBeenCalled()
    expect(emitted.map((value) => value.status)).toEqual(['verified'])

    result = () => availableWith(artifactFor(), '2.0.0', '2026-02-04T00:00:00.000Z')
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'verified', checkedAt: '2026-02-04T00:00:00.000Z' })
    expect(controller.getVerifiedArtifact()).toBe(record)
  })

  it('shows stale release information before a download without pruning or forgetting the offer', async () => {
    let result: () => UpdateCheckResult = () => availableWith(artifactFor())
    const { controller, fake } = setup(async () => result())
    await controller.checkNow()
    fake.downloader.prune.mockClear()

    result = () => staleResult('2026-02-03T00:00:00.000Z')
    const stale = await controller.checkNow()
    await Promise.resolve()
    expect(stale).toEqual({
      status: 'stale',
      currentVersion: '1.0.0',
      automaticChecks: false,
      checkedAt: '2026-02-03T00:00:00.000Z',
      message: 'Update information is older than a release this app already verified.',
    })
    expect(fake.downloader.prune).not.toHaveBeenCalled()
    await expect(controller.downloadNow()).resolves.toBe(stale)
    expect(fake.downloader.download).not.toHaveBeenCalled()

    result = () => availableWith(artifactFor())
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'available', available: { downloadable: true } })
    void controller.downloadNow()
    expect(fake.downloader.download).toHaveBeenCalledOnce()
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
      installable: false,
    })
  })
})

describe('installing a verified update', () => {
  const NOT_HERE = 'Move Agent Inbox to your Applications folder to install updates from the app.'

  function installerFake() {
    const calls: string[] = []
    const prepared = {
      commit: vi.fn(async () => { calls.push('commit') }),
      discard: vi.fn(async () => { calls.push('discard') }),
    }
    const installer = {
      strategy: 'macos-dmg' as const,
      feasibility: vi.fn(async (_candidate: InstallCandidate): Promise<InstallFeasibility> => ({ ok: true })),
      prepare: vi.fn(async (_source: VerifiedInstallSource, _options?: { signal?: AbortSignal }): Promise<PreparedInstall> => {
        calls.push('prepare')
        return prepared
      }),
      cleanup: vi.fn(async () => { calls.push('cleanup') }),
    }
    return { installer, prepared, calls }
  }

  function trustStore(mark: () => string | null, markV2: () => string | null = () => null) {
    return {
      read: vi.fn(async () => ({ highestVerifiedVersion: mark(), highestVerifiedVersionV2: markV2() })),
      recordVerifiedVersion: vi.fn(async (version: string) => ({ highestVerifiedVersion: version, highestVerifiedVersionV2: markV2() })),
    }
  }

  async function setup(options: {
    currentVersion?: string
    kind?: 'dmg' | 'appimage'
    mark?: () => string | null
    setupRunning?: () => boolean
    permitted?: () => boolean
    verify?: boolean
  } = {}) {
    const currentVersion = options.currentVersion ?? '1.0.0'
    const fake = fakeDownloader()
    const install = installerFake()
    const handleClose = vi.fn(async () => { install.calls.push('close') })
    const openedHandle = {
      read: vi.fn(async () => ({ bytesRead: 7 })),
      stat: vi.fn(async () => ({ isFile: () => true, size: 1000 })),
      write: vi.fn(async () => ({ bytesWritten: 0 })),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    fake.downloader.openVerified.mockImplementation(async (record: VerifiedArtifact) => {
      install.calls.push('openVerified')
      return { record, handle: openedHandle, close: handleClose }
    })
    const requestRestart = vi.fn(() => { install.calls.push('restart') })
    const isSetupRunning = vi.fn(options.setupRunning ?? (() => false))
    const trust = trustStore(options.mark ?? (() => null))
    let hold = false
    let releaseCheck: ((value: UpdateCheckResult) => void) | null = null
    let checkedAt = '2026-02-01T00:00:00.000Z'
    let result = (): UpdateCheckResult => ({ ...availableWith(artifactFor('2.0.0', options.kind ?? 'dmg'), '2.0.0', checkedAt), currentVersion })
    const checker = vi.fn(async (): Promise<UpdateCheckResult> => {
      if (!hold) return result()
      return new Promise<UpdateCheckResult>((resolve) => { releaseCheck = resolve })
    })
    const emitted: UpdateControllerState[] = []
    const notifier = vi.fn()
    const controller = createUpdateController({
      currentVersion,
      preferences: prefs(),
      trustState: trust,
      checker,
      notifier,
      downloader: fake.downloader,
      installers: { 'macos-dmg': install.installer },
      isSetupRunning,
      ...(options.permitted !== undefined ? { isInstallPermitted: options.permitted } : {}),
      requestRestart,
      clock: () => new Date('2026-02-01T00:00:00Z'),
      emit: (value) => emitted.push(value),
    })
    if (options.verify !== false) {
      await controller.checkNow()
      const done = controller.downloadNow()
      fake.succeed()
      await done
    }
    return {
      controller,
      fake,
      ...install,
      openedHandle,
      handleClose,
      requestRestart,
      isSetupRunning,
      trust,
      checker,
      notifier,
      emitted,
      hold(value: boolean) { hold = value },
      releaseCheck(value?: UpdateCheckResult) { releaseCheck?.(value ?? result()) },
      setResult(next: () => UpdateCheckResult) { result = next },
      setCheckedAt(value: string) { checkedAt = value },
    }
  }

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
      resolve = resolveDeferred
      reject = rejectDeferred
    })
    return { promise, resolve, reject }
  }

  it('offers an installable download only when the installer can install here', async () => {
    const { controller, installer } = await setup({ verify: false })

    const checked = await controller.checkNow()
    expect(checked).toMatchObject({
      status: 'available',
      message: 'A verified update is available.',
      available: { version: '2.0.0', downloadable: true, installable: true },
    })
    expect(checked.available).not.toHaveProperty('reason')
    expect(installer.feasibility).toHaveBeenCalledWith({ version: '2.0.0', architecture: 'universal', minimumSystemVersion: '13.5' })
  })

  it('keeps an offer notify-only with the installer reason when it cannot install here', async () => {
    const { controller, installer, fake, notifier } = await setup({ verify: false })
    installer.feasibility.mockResolvedValue({ ok: false, reason: 'translocated', message: NOT_HERE })

    const checked = await controller.checkNow()
    expect(checked).toMatchObject({
      status: 'available',
      message: NOT_HERE,
      available: { downloadable: false, installable: false, reason: NOT_HERE },
    })
    await expect(controller.downloadNow()).resolves.toBe(checked)
    expect(fake.downloader.download).not.toHaveBeenCalled()
    expect(fake.downloader.prune).toHaveBeenLastCalledWith({ keep: null, currentVersion: '1.0.0' })
    expect(notifier).not.toHaveBeenCalled()
  })

  it.each([
    ['a path', 'Move /Applications/Agent Inbox.app somewhere else.'],
    ['several lines', 'First line.\nSecond line.'],
    ['an overlong message', 'x'.repeat(241)],
    ['an empty message', ''],
  ])('replaces a feasibility message with %s by generic copy', async (_label, message) => {
    const { controller, installer } = await setup({ verify: false })
    installer.feasibility.mockResolvedValue({ ok: false, reason: 'x', message })

    const checked = await controller.checkNow()
    expect(checked.available?.reason).toBe('Agent Inbox cannot install updates from the app here. Use Review release instead.')
    expect(checked.message).toBe(checked.available?.reason)
  })

  it('treats a feasibility check that throws as notify-only', async () => {
    const { controller, installer } = await setup({ verify: false })
    installer.feasibility.mockRejectedValue(new Error('/private/var/secret'))

    const checked = await controller.checkNow()
    expect(checked.available).toMatchObject({ downloadable: false, installable: false })
    expect(JSON.stringify(checked)).not.toContain('secret')
  })

  it('re-evaluates feasibility on every check, including while a download is verified', async () => {
    const { controller, installer, fake } = await setup({ verify: false })
    installer.feasibility.mockResolvedValueOnce({ ok: false, reason: 'translocated', message: NOT_HERE })
    await expect(controller.checkNow()).resolves.toMatchObject({ available: { downloadable: false } })
    await expect(controller.checkNow()).resolves.toMatchObject({ available: { downloadable: true, installable: true } })

    const done = controller.downloadNow()
    fake.succeed()
    await expect(done).resolves.toMatchObject({ status: 'verified', available: { installable: true } })
    installer.feasibility.mockResolvedValueOnce({ ok: false, reason: 'translocated', message: NOT_HERE })
    await expect(controller.checkNow()).resolves.toMatchObject({
      status: 'available',
      available: { downloadable: false, installable: false, reason: NOT_HERE },
    })
    expect(controller.getVerifiedArtifact()).toBeNull()
  })

  it('tells the notifier when an offer installs from the app', async () => {
    const notifier = vi.fn()
    const install = installerFake()
    const fake = fakeDownloader()
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences: prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null }),
      checker: async () => availableWith(artifactFor()),
      notifier,
      downloader: fake.downloader,
      installers: { 'macos-dmg': install.installer },
      requestRestart: vi.fn(),
    })

    await controller.runScheduledCheck()
    expect(notifier).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0.0', downloadable: true, installable: true }))
  })

  it('installs in order — reopen, stage, close, commit, restart — and stays installing', async () => {
    const { controller, calls, installer, prepared, openedHandle, emitted, requestRestart, fake } = await setup()
    const record = controller.getVerifiedArtifact()!
    emitted.length = 0

    const pending = controller.installNow()
    expect(controller.isInstalling()).toBe(true)
    const result = await pending

    expect(calls).toEqual(['openVerified', 'prepare', 'close', 'commit', 'restart'])
    expect(fake.downloader.openVerified).toHaveBeenCalledWith(record)
    const [source, prepareOptions] = installer.prepare.mock.calls[0]!
    expect(source.record).toEqual(record)
    expect(Object.keys(source.handle).sort()).toEqual(['read', 'stat'])
    await source.handle.read(new Uint8Array(4), 0, 4, 0)
    expect(openedHandle.read).toHaveBeenCalledWith(expect.any(Uint8Array), 0, 4, 0)
    expect(prepareOptions?.signal).toBeInstanceOf(AbortSignal)
    expect(installer.feasibility).toHaveBeenLastCalledWith({ version: '2.0.0', architecture: 'universal', minimumSystemVersion: '13.5' })
    expect(result).toMatchObject({
      status: 'installing',
      message: 'Installing version 2.0.0. Agent Inbox will restart when it is ready.',
      available: { version: '2.0.0', downloadable: true, installable: true },
    })
    expect(result).not.toHaveProperty('download')
    expect(emitted.map((value) => value.status)).toEqual(['installing'])
    expect(JSON.stringify(emitted)).not.toContain('/private/')
    expect(prepared.discard).not.toHaveBeenCalled()
    expect(requestRestart).toHaveBeenCalledOnce()
    expect(controller.getVerifiedArtifact()).toBeNull()
    expect(controller.isInstalling()).toBe(true)
  })

  it('does nothing unless a verified, installable download is on screen', async () => {
    const { controller, fake, installer } = await setup({ verify: false })
    await expect(controller.installNow()).resolves.toMatchObject({ status: 'idle' })
    await controller.checkNow()
    await expect(controller.installNow()).resolves.toMatchObject({ status: 'available' })
    const downloading = controller.downloadNow()
    await expect(controller.installNow()).resolves.toMatchObject({ status: 'downloading' })
    fake.succeed()
    await downloading
    expect(fake.downloader.openVerified).not.toHaveBeenCalled()
    expect(installer.prepare).not.toHaveBeenCalled()
  })

  it('refuses a version that is not newer than the running app', async () => {
    const { controller, fake, requestRestart } = await setup({ currentVersion: '2.0.0' })

    await expect(controller.installNow()).resolves.toMatchObject({
      status: 'install-failed',
      message: 'This update is not newer than the installed version.',
    })
    expect(fake.downloader.openVerified).not.toHaveBeenCalled()
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('re-reads the high-water mark at install time and refuses a download another process has superseded', async () => {
    let mark: string | null = null
    const { controller, fake, trust, installer } = await setup({ mark: () => mark })
    mark = '2.1.0'

    await expect(controller.installNow()).resolves.toMatchObject({
      status: 'install-failed',
      message: 'A newer release was verified since this download. Check for updates again.',
      available: { version: '2.0.0', installable: true },
    })
    expect(trust.read).toHaveBeenCalled()
    expect(fake.downloader.openVerified).not.toHaveBeenCalled()
    expect(installer.prepare).not.toHaveBeenCalled()
    expect(controller.getVerifiedArtifact()).not.toBeNull()

    mark = '2.0.0'
    await expect(controller.installNow()).resolves.toMatchObject({ status: 'installing' })
  })

  it('refuses while agent setup is running and installs once it has finished', async () => {
    let running = true
    const { controller, fake } = await setup({ setupRunning: () => running })

    await expect(controller.installNow()).resolves.toMatchObject({
      status: 'install-failed',
      message: 'Agent setup is running. Try again when it finishes.',
    })
    expect(fake.downloader.openVerified).not.toHaveBeenCalled()
    running = false
    await expect(controller.installNow()).resolves.toMatchObject({ status: 'installing' })
  })

  it('refuses while a check is in flight and keeps the download through that check', async () => {
    const harness = await setup()
    const { controller, fake } = harness
    harness.hold(true)
    const checking = controller.checkNow()

    await expect(controller.installNow()).resolves.toMatchObject({
      status: 'install-failed',
      message: 'Agent Inbox is checking for updates. Try again in a moment.',
    })
    expect(fake.downloader.openVerified).not.toHaveBeenCalled()
    harness.hold(false)
    harness.setCheckedAt('2026-02-02T00:00:00.000Z')
    harness.releaseCheck()
    await expect(checking).resolves.toMatchObject({ status: 'install-failed', checkedAt: '2026-02-02T00:00:00.000Z' })
    expect(controller.getVerifiedArtifact()).not.toBeNull()

    await expect(controller.installNow()).resolves.toMatchObject({ status: 'installing' })
  })

  it('refuses when the installer can no longer install here, keeping the download', async () => {
    const { controller, installer } = await setup()
    installer.feasibility.mockResolvedValueOnce({ ok: false, reason: 'read-only', message: NOT_HERE })

    await expect(controller.installNow()).resolves.toMatchObject({ status: 'install-failed', message: NOT_HERE })
    expect(installer.prepare).not.toHaveBeenCalled()
    expect(controller.getVerifiedArtifact()).not.toBeNull()
  })

  it.each([
    ['the downloader cannot re-verify the file', 'open'],
    ['the installer finds the bytes it consumed do not match', 'prepare'],
  ] as const)('drops the download and offers it again when %s', async (_label, where) => {
    const { controller, fake, installer, handleClose, prepared } = await setup()
    if (where === 'open') {
      fake.downloader.openVerified.mockRejectedValueOnce(Object.assign(new Error('not-verified /private/x'), { code: 'not-verified' }))
    } else {
      installer.prepare.mockRejectedValueOnce(new UpdateInstallError('not-verified'))
    }
    fake.downloader.prune.mockClear()

    const failed = await controller.installNow()
    expect(failed).toMatchObject({
      status: 'download-failed',
      message: 'The downloaded update changed on disk, so it was removed. Download it again.',
      available: { version: '2.0.0', downloadable: true, installable: true },
      download: { receivedBytes: 0, totalBytes: 1000 },
    })
    expect(controller.getVerifiedArtifact()).toBeNull()
    expect(fake.downloader.prune).toHaveBeenCalledWith({ keep: null, currentVersion: '1.0.0' })
    expect(prepared.commit).not.toHaveBeenCalled()
    if (where === 'prepare') expect(handleClose).toHaveBeenCalledOnce()
    expect(JSON.stringify(failed)).not.toContain('/private/')

    const again = controller.downloadNow()
    expect(controller.getState().status).toBe('downloading')
    fake.succeed()
    await expect(again).resolves.toMatchObject({ status: 'verified' })
  })

  it.each([
    ['staging fails', 'prepare', new UpdateInstallError('staging')],
    ['the staged build fails verification', 'prepare', new UpdateInstallError('verification-failed')],
    ['the hand-off fails', 'commit', new Error('spawn /bin/sh EACCES /private/secret')],
  ] as const)('reports a generic failure when %s, discards what was staged, and keeps the download for Try again', async (_label, where, error) => {
    const { controller, installer, prepared, handleClose, requestRestart, fake } = await setup()
    if (where === 'prepare') installer.prepare.mockRejectedValueOnce(error)
    else prepared.commit.mockRejectedValueOnce(error)
    fake.downloader.prune.mockClear()

    const failed = await controller.installNow()
    expect(failed).toMatchObject({
      status: 'install-failed',
      message: 'The update could not be installed. Nothing was changed. Try again or use Review release.',
      available: { version: '2.0.0', downloadable: true, installable: true },
    })
    expect(JSON.stringify(failed)).not.toContain('secret')
    expect(handleClose).toHaveBeenCalledOnce()
    expect(prepared.discard).toHaveBeenCalledTimes(where === 'commit' ? 1 : 0)
    expect(requestRestart).not.toHaveBeenCalled()
    expect(controller.getVerifiedArtifact()).not.toBeNull()
    expect(controller.isInstalling()).toBe(false)
    expect(fake.downloader.prune).not.toHaveBeenCalled()

    await expect(controller.installNow()).resolves.toMatchObject({ status: 'installing' })
    expect(requestRestart).toHaveBeenCalledOnce()
  })

  it('skips checks, downloads, cancellation, cleanup and prune while installing and after commit', async () => {
    const { controller, checker, fake, installer, prepared } = await setup()
    const staged = deferred<PreparedInstall>()
    installer.prepare.mockImplementationOnce(() => staged.promise)
    const checks = checker.mock.calls.length
    fake.downloader.prune.mockClear()

    const installing = controller.installNow()
    await vi.waitFor(() => expect(installer.prepare).toHaveBeenCalledOnce())
    expect(controller.getState().status).toBe('installing')

    const assertBlocked = async () => {
      await expect(controller.checkNow()).resolves.toMatchObject({ status: 'installing' })
      await expect(controller.runScheduledCheck()).resolves.toMatchObject({ status: 'installing' })
      await expect(controller.downloadNow()).resolves.toMatchObject({ status: 'installing' })
      await expect(controller.cancelDownload()).resolves.toMatchObject({ status: 'installing' })
      await expect(controller.installNow()).resolves.toMatchObject({ status: 'installing' })
      expect(controller.refuseInstall('Restart Agent Inbox to install this update.')).toMatchObject({ status: 'installing' })
      expect(checker).toHaveBeenCalledTimes(checks)
      expect(fake.downloader.download).toHaveBeenCalledOnce()
      expect(fake.downloader.cancel).not.toHaveBeenCalled()
      expect(installer.prepare).toHaveBeenCalledOnce()
    }
    await assertBlocked()
    await controller.rendererReady()
    expect(fake.downloader.prune).not.toHaveBeenCalled()
    expect(installer.cleanup).not.toHaveBeenCalled()

    staged.resolve(prepared)
    await installing
    expect(prepared.commit).toHaveBeenCalledOnce()
    await assertBlocked()
    controller.dispose()
    expect(prepared.discard).not.toHaveBeenCalled()
    expect(fake.downloader.prune).not.toHaveBeenCalled()
    expect(controller.getState().status).toBe('installing')
  })

  it.each(['dispose', 'cancelInstall'] as const)('%s aborts an install that has not committed and discards what it staged', async (how) => {
    const { controller, installer, prepared, handleClose, requestRestart } = await setup()
    const staged = deferred<PreparedInstall>()
    let signal: AbortSignal | undefined
    installer.prepare.mockImplementationOnce((_source, options) => {
      signal = options?.signal
      return staged.promise
    })

    const installing = controller.installNow()
    await vi.waitFor(() => expect(signal).toBeDefined())
    const cancelled = how === 'dispose' ? (controller.dispose(), Promise.resolve()) : controller.cancelInstall()
    expect(signal!.aborted).toBe(true)
    staged.resolve(prepared)
    await cancelled
    await installing

    expect(prepared.commit).not.toHaveBeenCalled()
    expect(prepared.discard).toHaveBeenCalledOnce()
    expect(handleClose).toHaveBeenCalledOnce()
    expect(requestRestart).not.toHaveBeenCalled()
    expect(controller.isInstalling()).toBe(false)
    expect(controller.getState()).toMatchObject({
      status: 'install-failed',
      message: 'The update install was cancelled. Nothing was changed.',
    })
  })

  it('cancelInstall leaves a commit that already started alone', async () => {
    const { controller, prepared, requestRestart } = await setup()
    const committing = deferred<void>()
    prepared.commit.mockImplementationOnce(() => committing.promise)

    const installing = controller.installNow()
    await vi.waitFor(() => expect(prepared.commit).toHaveBeenCalledOnce())
    const cancelled = controller.cancelInstall()
    committing.resolve()
    await cancelled
    await installing
    expect(prepared.discard).not.toHaveBeenCalled()
    expect(requestRestart).toHaveBeenCalledOnce()
    expect(controller.getState().status).toBe('installing')
  })

  it('publishes a clear refusal on request without dropping the download', async () => {
    const { controller, installer } = await setup()

    expect(controller.refuseInstall('Restart Agent Inbox to install this update.')).toMatchObject({
      status: 'install-failed',
      message: 'Restart Agent Inbox to install this update.',
    })
    expect(installer.prepare).not.toHaveBeenCalled()
    expect(controller.getVerifiedArtifact()).not.toBeNull()
  })

  // #216: main installs only from the window it bound to the viewer this app
  // owns. Settings must say when this window may not, instead of offering an
  // Install and restart that main would refuse.
  it('publishes whether this window may install, and republishes only when that changes', async () => {
    let permitted = true
    const { controller, emitted } = await setup({ permitted: () => permitted })
    const verified = controller.getState()
    expect(verified).toMatchObject({ status: 'verified', available: { installable: true, installPermitted: true } })
    emitted.length = 0

    permitted = false
    const revoked = controller.refreshInstallPermission()
    expect(revoked).toEqual({ ...verified, available: { ...verified.available, installPermitted: false } })
    expect(emitted).toEqual([revoked])
    expect(controller.refreshInstallPermission()).toBe(revoked)
    expect(emitted).toHaveLength(1)
    // The verified download stays for a window that may install it.
    expect(controller.getVerifiedArtifact()).not.toBeNull()

    // Every later state follows the window's grant, not the one the offer was made under.
    expect(controller.refuseInstall('Restart Agent Inbox to install this update.')).toMatchObject({
      status: 'install-failed',
      available: { installable: true, installPermitted: false },
    })
    permitted = true
    const restored = controller.refreshInstallPermission()
    expect(restored).toMatchObject({
      status: 'verified',
      available: { installable: true, installPermitted: true },
    })
    expect(emitted).toHaveLength(3)
    // Restored once: nothing changed since, so nothing is published.
    expect(controller.refreshInstallPermission()).toBe(restored)
    expect(emitted).toHaveLength(3)
  })

  it('offers the verified download again once the window main refused may install', async () => {
    let permitted = false
    const harness = await setup({ permitted: () => permitted })
    const { controller, emitted } = harness
    expect(controller.refuseInstall('Restart Agent Inbox to install this update.')).toMatchObject({
      status: 'install-failed',
      message: 'Restart Agent Inbox to install this update.',
      available: { installable: true, installPermitted: false },
    })
    // A quiet re-check of the same release keeps the refusal on screen.
    harness.setCheckedAt('2026-02-02T00:00:00.000Z')
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'install-failed', checkedAt: '2026-02-02T00:00:00.000Z' })

    permitted = true
    const restored = controller.refreshInstallPermission()
    // Not a stale request to restart beside a Try again that now works.
    expect(restored).toEqual({
      status: 'verified',
      currentVersion: '1.0.0',
      automaticChecks: false,
      checkedAt: '2026-02-02T00:00:00.000Z',
      message: 'The update was downloaded and verified.',
      available: expect.objectContaining({ version: '2.0.0', installable: true, installPermitted: true }),
      download: { receivedBytes: 1000, totalBytes: 1000 },
    })
    expect(emitted.at(-1)).toBe(restored)
    await expect(controller.installNow()).resolves.toMatchObject({ status: 'installing' })
  })

  it('keeps an install’s own reason for failing when the window is bound again', async () => {
    const SETUP = 'Agent setup is running. Try again when it finishes.'
    let permitted = false
    const { controller } = await setup({ permitted: () => permitted, setupRunning: () => true })
    controller.refuseInstall('Restart Agent Inbox to install this update.')
    // Bound again and installing before any refresh: the controller's own refusal replaces main's.
    permitted = true
    await expect(controller.installNow()).resolves.toMatchObject({ status: 'install-failed', message: SETUP })
    expect(controller.refreshInstallPermission()).toMatchObject({ status: 'install-failed', message: SETUP })

    permitted = false
    controller.refreshInstallPermission()
    permitted = true
    expect(controller.refreshInstallPermission()).toMatchObject({
      status: 'install-failed',
      message: SETUP,
      available: { installPermitted: true },
    })
  })

  it('never permits an offer it cannot install, and a window check that throws permits nothing', async () => {
    const notHere = await setup({ verify: false, permitted: () => true })
    notHere.installer.feasibility.mockResolvedValueOnce({ ok: false, reason: 'translocated', message: NOT_HERE })
    await expect(notHere.controller.checkNow()).resolves.toMatchObject({
      available: { downloadable: false, installable: false, installPermitted: false },
    })
    const withoutInstaller = await setup({ kind: 'appimage', permitted: () => true })
    expect(withoutInstaller.controller.getState()).toMatchObject({
      status: 'verified',
      available: { installable: false, installPermitted: false },
    })

    const throwing = await setup({ permitted: () => { throw new Error('window destroyed') } })
    expect(throwing.controller.getState()).toMatchObject({ available: { installable: true, installPermitted: false } })
    // Without a window check at all, an installable offer is permitted.
    const ungated = await setup()
    expect(ungated.controller.getState()).toMatchObject({ available: { installable: true, installPermitted: true } })
  })

  it('republishes nothing without an offer or once disposed, and rejects a window check that is not a function', async () => {
    let permitted = true
    const idle = await setup({ verify: false, permitted: () => permitted })
    permitted = false
    expect(idle.controller.refreshInstallPermission()).toBe(idle.controller.getState())
    expect(idle.emitted).toEqual([])

    permitted = true
    const disposed = await setup({ permitted: () => permitted })
    disposed.emitted.length = 0
    disposed.controller.dispose()
    permitted = false
    expect(disposed.controller.refreshInstallPermission()).toMatchObject({ available: { installPermitted: true } })
    expect(disposed.emitted).toEqual([])

    expect(() => createUpdateController({
      currentVersion: '1.0.0',
      preferences: prefs(),
      checker: vi.fn(),
      notifier: vi.fn(),
      isInstallPermitted: true as never,
    })).toThrow(TypeError)
  })

  it('runs each installer cleanup once at startup alongside the download prune', async () => {
    const { controller, installer, fake } = await setup({ verify: false })
    installer.cleanup.mockRejectedValueOnce(new Error('cleanup failed'))

    await controller.rendererReady()
    await controller.rendererReady()
    await Promise.resolve()
    expect(installer.cleanup).toHaveBeenCalledOnce()
    expect(fake.downloader.prune).toHaveBeenCalledOnce()
  })

  it('leaves a strategy without an installer exactly as a download-only update', async () => {
    const { controller, installer, fake } = await setup({ kind: 'appimage' })

    expect(controller.getState()).toMatchObject({
      status: 'verified',
      message: 'The update was downloaded and verified.',
      available: { downloadable: true, installable: false },
    })
    expect(installer.feasibility).not.toHaveBeenCalled()
    const before = controller.getState()
    await expect(controller.installNow()).resolves.toBe(before)
    expect(controller.refuseInstall('x')).toBe(before)
    expect(fake.downloader.openVerified).not.toHaveBeenCalled()
  })

  it('validates installer registration', () => {
    const base = {
      currentVersion: '1.0.0',
      preferences: prefs(),
      checker: vi.fn(),
      notifier: vi.fn(),
      downloader: fakeDownloader().downloader,
      requestRestart: vi.fn(),
    }
    const { installer } = installerFake()
    expect(() => createUpdateController({ ...base, installers: { 'appimage-self-replace': installer } })).toThrow(TypeError)
    expect(() => createUpdateController({ ...base, installers: { 'macos-dmg': { ...installer, prepare: undefined as never } } })).toThrow(TypeError)
    expect(() => createUpdateController({ ...base, requestRestart: undefined, installers: { 'macos-dmg': installer } })).toThrow(TypeError)
    const { openVerified: _openVerified, ...withoutOpen } = fakeDownloader().downloader
    expect(() => createUpdateController({ ...base, downloader: withoutOpen, installers: { 'macos-dmg': installer } })).toThrow(TypeError)
    expect(() => createUpdateController({ ...base, installers: { 'deb-notify': installer } as never })).toThrow(TypeError)
  })
})

describe('reporting an install that did not take effect', () => {
  const PERMISSION = 'Version 2.0.0 could not be installed, so Agent Inbox is still on 1.0.0. macOS did not allow replacing the app. You can install it manually from the release page.'

  function attemptStoreFake(outcome: unknown = null) {
    const calls: string[] = []
    return {
      calls,
      store: {
        begin: vi.fn(async (_attempt: { from: string; to: string; strategy: string }) => {
          calls.push('begin')
          return { resultPath: '/private/userData/update-install/last-attempt.result' }
        }),
        abandon: vi.fn(async () => { calls.push('abandon') }),
        take: vi.fn(async () => {
          calls.push('take')
          // Resolve only after a macrotask, so a cleanup scheduled meanwhile would run first.
          await new Promise((resolveTake) => setTimeout(resolveTake, 0))
          calls.push('taken')
          return outcome as never
        }),
      },
    }
  }

  function outcome(exitCode: number | null, overrides: Record<string, unknown> = {}) {
    return { from: '1.0.0', to: '2.0.0', at: '2026-02-01T00:00:00.000Z', platform: 'darwin', strategy: 'macos-dmg', exitCode, ...overrides }
  }

  async function harness(options: {
    outcome?: unknown
    versions?: () => UpdateCheckResult
    withInstaller?: boolean
    isQuitting?: () => boolean
  } = {}) {
    const fake = fakeDownloader()
    const attempts = attemptStoreFake(options.outcome ?? null)
    const calls = attempts.calls
    const prepared = {
      commit: vi.fn(async (_options?: { resultPath?: string }) => { calls.push('commit') }),
      discard: vi.fn(async () => { calls.push('discard') }),
    }
    const installer = {
      strategy: 'macos-dmg' as const,
      feasibility: vi.fn(async (): Promise<InstallFeasibility> => ({ ok: true })),
      prepare: vi.fn(async (): Promise<PreparedInstall> => {
        calls.push('prepare')
        return prepared
      }),
      cleanup: vi.fn(async () => { calls.push('cleanup') }),
    }
    const notifyInstallFailure = vi.fn()
    const requestRestart = vi.fn(() => { calls.push('restart') })
    let result = options.versions ?? (() => availableWith(artifactFor('2.0.0')))
    const controller = createUpdateController({
      currentVersion: '1.0.0',
      preferences: prefs(),
      checker: vi.fn(async () => result()),
      notifier: vi.fn(),
      downloader: fake.downloader,
      installers: options.withInstaller === false ? {} : { 'macos-dmg': installer },
      attemptStore: attempts.store,
      notifyInstallFailure,
      requestRestart,
      ...(options.isQuitting ? { isQuitting: options.isQuitting } : {}),
      clock: () => new Date('2026-02-01T00:00:00Z'),
    })
    async function verify() {
      await controller.checkNow()
      const done = controller.downloadNow()
      fake.succeed()
      return done
    }
    return { controller, fake, attempts, calls, prepared, installer, notifyInstallFailure, requestRestart, verify, setResult(next: () => UpdateCheckResult) { result = next } }
  }

  it('records the attempt just before the hand-off and tells the helper where to report', async () => {
    const h = await harness()
    await h.verify()

    await expect(h.controller.installNow()).resolves.toMatchObject({ status: 'installing' })
    expect(h.calls).toEqual(['prepare', 'begin', 'commit', 'restart'])
    expect(h.attempts.store.begin).toHaveBeenCalledWith({ from: '1.0.0', to: '2.0.0', strategy: 'macos-dmg' })
    expect(h.prepared.commit).toHaveBeenCalledWith({ resultPath: '/private/userData/update-install/last-attempt.result' })
    expect(h.attempts.store.abandon).not.toHaveBeenCalled()
  })

  it('forgets the attempt when the hand-off fails', async () => {
    const h = await harness()
    await h.verify()
    h.prepared.commit.mockRejectedValueOnce(new Error('spawn failed'))

    await expect(h.controller.installNow()).resolves.toMatchObject({ status: 'install-failed' })
    expect(h.calls).toEqual(['prepare', 'begin', 'abandon', 'discard'])
    expect(h.requestRestart).not.toHaveBeenCalled()
  })

  it('does not hand off an install it could not record', async () => {
    const h = await harness()
    await h.verify()
    h.attempts.store.begin.mockRejectedValueOnce(new Error('disk full'))

    await expect(h.controller.installNow()).resolves.toMatchObject({
      status: 'install-failed',
      message: 'The update could not be installed. Nothing was changed. Try again or use Review release.',
    })
    expect(h.prepared.commit).not.toHaveBeenCalled()
    expect(h.prepared.discard).toHaveBeenCalledOnce()
    expect(h.controller.getVerifiedArtifact()).not.toBeNull()
  })

  it('reports, once, a previous attempt that left the app on its old version', async () => {
    const h = await harness({ outcome: outcome(70) })

    const ready = await h.controller.rendererReady()
    expect(ready).toMatchObject({ status: 'idle', message: PERMISSION, installNotice: PERMISSION })
    expect(h.notifyInstallFailure).toHaveBeenCalledExactlyOnceWith({ version: '2.0.0', currentVersion: '1.0.0', message: PERMISSION })
    await h.controller.rendererReady()
    expect(h.attempts.store.take).toHaveBeenCalledOnce()
    expect(h.notifyInstallFailure).toHaveBeenCalledOnce()
  })

  it('reads the previous attempt before any startup cleanup', async () => {
    const h = await harness({ outcome: outcome(70) })
    await h.controller.rendererReady()
    await Promise.resolve()
    expect(h.calls.indexOf('taken')).toBeGreaterThan(-1)
    expect(h.calls.indexOf('taken')).toBeLessThan(h.calls.indexOf('cleanup'))
  })

  it.each([
    ['macOS refused to move the app aside', outcome(70), 'macOS did not allow replacing the app. '],
    ['macOS refused to move the new app in', outcome(71), 'macOS did not allow replacing the app. '],
    ['another system refused', outcome(70, { platform: 'linux', strategy: 'appimage-self-replace' }), 'The system did not allow replacing the app. '],
    ['the old app never quit', outcome(75), 'The old app did not quit in time. '],
    ['the folder changed first', outcome(65), 'The app\'s folder changed before the update could replace it. '],
    ['the helper never reported', outcome(null), ''],
    ['the helper rejected its arguments', outcome(64), ''],
  ] as const)('explains the cause when %s', async (_label, attempt, cause) => {
    const h = await harness({ outcome: attempt })
    const ready = await h.controller.rendererReady()
    expect(ready.installNotice).toBe(
      `Version 2.0.0 could not be installed, so Agent Inbox is still on 1.0.0. ${cause}You can install it manually from the release page.`,
    )
  })

  it.each([
    ['the attempted version', outcome(0, { to: '1.0.0', from: '0.9.0' })],
    ['an older version', outcome(70, { to: '0.9.0', from: '0.8.0' })],
  ])('says nothing when the app now runs %s', async (_label, attempt) => {
    const h = await harness({ outcome: attempt })
    const ready = await h.controller.rendererReady()
    expect(ready).not.toHaveProperty('installNotice')
    expect(ready.message).toBe('Updates have not been checked.')
    expect(h.notifyInstallFailure).not.toHaveBeenCalled()
    expect(h.attempts.store.take).toHaveBeenCalledOnce()
  })

  // An AppImage commit replaces the file before its helper runs, so whatever the
  // helper reported, the app started from that path again is the new version.
  it.each([0, 65, 75, null])('says nothing for an AppImage attempt that reported %s once the app runs that version', async (exitCode) => {
    const h = await harness({
      outcome: outcome(exitCode, { from: '0.9.0', to: '1.0.0', platform: 'linux', strategy: 'appimage-self-replace' }),
    })
    const ready = await h.controller.rendererReady()
    expect(ready).not.toHaveProperty('installNotice')
    expect(h.notifyInstallFailure).not.toHaveBeenCalled()
  })

  it('keeps the explanation on the next offer of that version and drops it for another release', async () => {
    const h = await harness({ outcome: outcome(70) })
    await h.controller.rendererReady()

    await expect(h.verify()).resolves.toMatchObject({
      status: 'verified',
      installNotice: PERMISSION,
      available: { version: '2.0.0', installable: true },
    })
    h.setResult(() => availableWith(artifactFor('2.1.0')))
    const newer = await h.controller.checkNow()
    expect(newer).toMatchObject({ status: 'available', available: { version: '2.1.0' } })
    expect(newer).not.toHaveProperty('installNotice')
  })

  it('drops the explanation when no update is offered any more', async () => {
    const h = await harness({ outcome: outcome(70), versions: () => ({ ...state('current', false), currentVersion: '1.0.0' }) })
    await h.controller.rendererReady()
    const current = await h.controller.checkNow()
    expect(current.status).toBe('current')
    expect(current).not.toHaveProperty('installNotice')
  })

  it('lets the user try again and clears the explanation once the install starts', async () => {
    const h = await harness({ outcome: outcome(75) })
    await h.controller.rendererReady()
    await h.verify()

    const installing = await h.controller.installNow()
    expect(installing.status).toBe('installing')
    expect(installing).not.toHaveProperty('installNotice')
  })

  it('survives an attempt store that fails to read', async () => {
    const h = await harness()
    h.attempts.store.take.mockRejectedValueOnce(new Error('EIO'))
    await expect(h.controller.rendererReady()).resolves.toMatchObject({ status: 'idle' })
    expect(h.notifyInstallFailure).not.toHaveBeenCalled()
  })

  it.each(['cancelInstall', 'dispose'] as const)('%s while the attempt is being recorded stops before the hand-off', async (how) => {
    const h = await harness()
    await h.verify()
    let release!: (value: { resultPath: string }) => void
    h.attempts.store.begin.mockImplementationOnce(async () => {
      h.calls.push('begin')
      return new Promise<{ resultPath: string }>((resolveBegin) => { release = resolveBegin })
    })

    const installing = h.controller.installNow()
    await vi.waitFor(() => expect(h.attempts.store.begin).toHaveBeenCalledOnce())
    const cancelled = how === 'dispose' ? (h.controller.dispose(), Promise.resolve()) : h.controller.cancelInstall()
    release({ resultPath: '/private/userData/update-install/last-attempt.result' })
    await cancelled
    await installing

    expect(h.prepared.commit).not.toHaveBeenCalled()
    expect(h.requestRestart).not.toHaveBeenCalled()
    expect(h.calls).toEqual(['prepare', 'begin', 'abandon', 'discard'])
    expect(h.controller.isInstalling()).toBe(false)
    expect(h.controller.getState()).toMatchObject({ status: 'install-failed', message: 'The update install was cancelled. Nothing was changed.' })
  })

  it('starts no new install once the app has begun to quit', async () => {
    let quitting = false
    const h = await harness({ isQuitting: () => quitting })
    const verified = await h.verify()
    quitting = true

    await expect(h.controller.installNow()).resolves.toBe(verified)
    expect(h.installer.prepare).not.toHaveBeenCalled()
    expect(h.fake.downloader.openVerified).not.toHaveBeenCalled()
    expect(h.controller.isInstalling()).toBe(false)
  })

  it('says nothing when the helper reported success, even if this copy is older', async () => {
    const h = await harness({ outcome: outcome(0) })
    const ready = await h.controller.rendererReady()
    expect(ready).not.toHaveProperty('installNotice')
    expect(h.notifyInstallFailure).not.toHaveBeenCalled()
    expect(h.attempts.store.take).toHaveBeenCalledOnce()
  })

  it('leaves the attempt record alone in an instance that cannot install', async () => {
    const h = await harness({ outcome: outcome(70), withInstaller: false })
    const ready = await h.controller.rendererReady()
    expect(h.attempts.store.take).not.toHaveBeenCalled()
    expect(ready).not.toHaveProperty('installNotice')
  })

  it('validates the attempt store', () => {
    expect(() => createUpdateController({
      currentVersion: '1.0.0',
      preferences: prefs(),
      checker: vi.fn(),
      notifier: vi.fn(),
      attemptStore: { begin: vi.fn() } as never,
    })).toThrow(TypeError)
  })
})

// Update manifest v2 (#343, design §6.3 and §6.4).
describe('a release this Mac cannot install, and the manifest an offer came from', () => {
  const INTEL = 'It needs a Mac with Apple silicon. This Mac has an Intel processor, so Agent Inbox stays on 1.9.0, which keeps working.'
  const ROSETTA = 'It runs only natively on Apple silicon, and Agent Inbox is running under Rosetta. Quit Agent Inbox, turn off “Open using Rosetta” in its Get Info window in Finder, then reopen it to install.'

  function blockedResult(blocked: 'apple-silicon' | 'rosetta', extra: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
    return {
      status: 'available',
      currentVersion: '1.9.0',
      automaticChecks: true,
      checkedAt: '2027-01-19T00:00:00.000Z',
      message: 'A verified update is available.',
      manifest: 'v2',
      available: {
        version: '2.0.0',
        tag: 'v2.0.0',
        releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v2.0.0',
        target: { packageType: 'dmg', installStrategy: 'macos-dmg' },
        blocked,
      },
      ...extra,
    }
  }

  function installer() {
    return {
      strategy: 'macos-dmg' as const,
      feasibility: vi.fn(async (): Promise<InstallFeasibility> => ({ ok: true })),
      prepare: vi.fn(async (): Promise<PreparedInstall> => ({ commit: vi.fn(async () => {}), discard: vi.fn(async () => {}) })),
    }
  }

  function setup(checker: () => Promise<UpdateCheckResult>, options: { currentVersion?: string; trust?: { read: () => Promise<unknown>; recordVerifiedVersion: (...args: never[]) => Promise<unknown> } } = {}) {
    const fake = fakeDownloader()
    const notifier = vi.fn()
    const preferences = prefs({ schema: 1, automaticChecks: true, lastNotifiedVersion: null })
    const macInstaller = installer()
    const controller = createUpdateController({
      currentVersion: options.currentVersion ?? '1.9.0',
      preferences,
      checker,
      notifier,
      downloader: fake.downloader,
      installers: { 'macos-dmg': macInstaller },
      requestRestart: vi.fn(),
      ...(options.trust ? { trustState: options.trust as never } : {}),
      clock: () => new Date('2027-01-19T00:00:00Z'),
    })
    return { controller, fake, notifier, preferences, macInstaller }
  }

  it.each([
    ['apple-silicon', INTEL],
    ['rosetta', ROSETTA],
  ] as const)('keeps a %s offer notify-only with its fixed copy, whatever installer is registered', async (blocked, copy) => {
    const { controller, fake, macInstaller } = setup(async () => blockedResult(blocked))
    const checked = await controller.checkNow()
    expect(checked).toEqual({
      status: 'available',
      currentVersion: '1.9.0',
      automaticChecks: true,
      checkedAt: '2027-01-19T00:00:00.000Z',
      message: 'A verified update is available.',
      available: {
        version: '2.0.0',
        tag: 'v2.0.0',
        releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v2.0.0',
        target: { packageType: 'dmg', installStrategy: 'macos-dmg' },
        downloadable: false,
        installable: false,
        installPermitted: false,
        reason: copy,
        blocked,
      },
    })
    // The copy passes the controller's own filter for anything shown in Settings.
    expect(copy.length).toBeLessThanOrEqual(240)
    expect(copy).not.toMatch(/[\u0000-\u001f\u007f/\\]/)
    await expect(controller.downloadNow()).resolves.toBe(checked)
    await expect(controller.installNow()).resolves.toBe(checked)
    expect(fake.downloader.normalize).not.toHaveBeenCalled()
    expect(fake.downloader.download).not.toHaveBeenCalled()
    expect(macInstaller.feasibility).not.toHaveBeenCalled()
  })

  it('refuses a blocked offer with an artifact, an unknown reason or another package, and an offer that names no manifest', async () => {
    const universal = artifactFor('2.0.0')
    for (const candidate of [
      blockedResult('apple-silicon', { artifact: universal }),
      blockedResult('intel' as 'apple-silicon'),
      { ...blockedResult('rosetta'), available: { ...blockedResult('rosetta').available!, target: { packageType: 'appimage' as const, installStrategy: 'appimage-self-replace' as const } } },
      { ...availableWith(universal), manifest: undefined },
      { ...availableWith(universal), manifest: 'v3' as 'v2' },
    ]) {
      const { controller } = setup(async () => candidate)
      await expect(controller.checkNow()).resolves.toMatchObject({ status: 'unverified' })
    }
  })

  it('notifies once per version under Rosetta, with its reason, and never on an Intel Mac', async () => {
    const intel = setup(async () => blockedResult('apple-silicon'))
    await intel.controller.runScheduledCheck()
    await intel.controller.runScheduledCheck()
    expect(intel.notifier).not.toHaveBeenCalled()
    expect(intel.preferences.setLastNotifiedVersion).not.toHaveBeenCalled()

    const rosetta = setup(async () => blockedResult('rosetta'))
    await rosetta.controller.runScheduledCheck()
    await rosetta.controller.runScheduledCheck()
    expect(rosetta.notifier).toHaveBeenCalledTimes(1)
    expect(rosetta.notifier).toHaveBeenCalledWith({
      version: '2.0.0',
      tag: 'v2.0.0',
      releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v2.0.0',
      downloadable: false,
      installable: false,
      rosetta: true,
    })

    const ordinary = setup(async () => availableWith(artifactFor('2.0.0')), { currentVersion: '1.0.0' })
    await ordinary.controller.runScheduledCheck()
    expect(ordinary.notifier).toHaveBeenCalledWith(expect.not.objectContaining({ rosetta: expect.anything() }))
  })

  it('offers Review release for every state but a release an Intel Mac cannot run', async () => {
    const { reviewReleaseOffered } = updateController
    for (const [blocked, offered] of [['apple-silicon', false], ['rosetta', true]] as const) {
      const { controller } = setup(async () => blockedResult(blocked))
      expect(reviewReleaseOffered(await controller.checkNow()), blocked).toBe(offered)
    }
    const ordinary = setup(async () => availableWith(artifactFor('2.0.0')), { currentVersion: '1.0.0' })
    expect(reviewReleaseOffered(await ordinary.controller.checkNow())).toBe(true)
    expect(reviewReleaseOffered(null)).toBe(true)
    expect(reviewReleaseOffered(undefined)).toBe(true)
  })

  // An Intel Mac on 1.8.0 holding a verified 1.9.0 download (design §6.2).
  async function holding(next: () => Promise<UpdateCheckResult>) {
    const offer = { ...availableWith(artifactFor('1.9.0'), '1.9.0'), currentVersion: '1.8.0' }
    let check: () => Promise<UpdateCheckResult> = async () => offer
    const held = setup(() => check(), { currentVersion: '1.8.0' })
    await held.controller.checkNow()
    const done = held.controller.downloadNow()
    held.fake.succeed()
    await done
    held.fake.downloader.prune.mockClear()
    check = next
    return held
  }

  it('keeps a verified download when the v1 read throws or reads stale; only a blocked result drops it', async () => {
    for (const next of [
      async (): Promise<UpdateCheckResult> => { throw new Error('manifest bytes do not match the digest') },
      async (): Promise<UpdateCheckResult> => ({ status: 'stale', currentVersion: '1.8.0', automaticChecks: false, checkedAt: '2027-01-19T00:00:00.000Z', message: 'x' }),
    ]) {
      const { controller, fake } = await holding(next)
      await expect(controller.checkNow()).resolves.toMatchObject({ status: 'verified', available: { version: '1.9.0' } })
      expect(controller.getVerifiedArtifact()).toMatchObject({ version: '1.9.0' })
      expect(fake.downloader.prune).not.toHaveBeenCalled()
    }
    const { controller, fake } = await holding(async () => ({ ...blockedResult('apple-silicon'), currentVersion: '1.8.0' }))
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'available', available: { blocked: 'apple-silicon' } })
    expect(controller.getVerifiedArtifact()).toBeNull()
    await vi.waitFor(() => expect(fake.downloader.prune).toHaveBeenCalledWith({ keep: null, currentVersion: '1.8.0' }))
  })

  describe('install-time marks follow the manifest the offer came from (design §5.6)', () => {
    async function installWith(manifest: 'v1' | 'v2', marks: { v1: string | null; v2: string | null }, reconfirm?: 'v1' | 'v2') {
      const trust = {
        read: vi.fn(async () => ({ highestVerifiedVersion: marks.v1, highestVerifiedVersionV2: marks.v2 })),
        recordVerifiedVersion: vi.fn(async () => ({ highestVerifiedVersion: marks.v1, highestVerifiedVersionV2: marks.v2 })),
      }
      let offered: 'v1' | 'v2' = manifest
      const fake = fakeDownloader()
      const macInstaller = installer()
      const controller = createUpdateController({
        currentVersion: '1.8.0',
        preferences: prefs(),
        trustState: trust,
        checker: async () => ({ ...availableWith(artifactFor('1.9.0'), '1.9.0'), currentVersion: '1.8.0', manifest: offered }),
        notifier: vi.fn(),
        downloader: fake.downloader,
        installers: { 'macos-dmg': macInstaller },
        requestRestart: vi.fn(),
      })
      await controller.checkNow()
      const done = controller.downloadNow()
      fake.succeed()
      await done
      if (reconfirm) {
        offered = reconfirm
        await expect(controller.checkNow()).resolves.toMatchObject({ status: 'verified' })
      }
      const result = await controller.installNow()
      return { result, prepared: macInstaller.prepare.mock.calls.length > 0 }
    }

    it('refuses a v2 offer below the higher of the two marks', async () => {
      await expect(installWith('v2', { v1: '2.0.0', v2: null })).resolves.toMatchObject({
        prepared: false,
        result: { status: 'install-failed', message: 'A newer release was verified since this download. Check for updates again.' },
      })
      await expect(installWith('v2', { v1: null, v2: '2.0.0' })).resolves.toMatchObject({ prepared: false })
    })

    it('checks a v1 offer against the v1 mark only', async () => {
      await expect(installWith('v1', { v1: '1.9.0', v2: '2.0.1' })).resolves.toMatchObject({ prepared: true })
      await expect(installWith('v1', { v1: '1.9.1', v2: null })).resolves.toMatchObject({
        prepared: false,
        result: { status: 'install-failed' },
      })
    })

    it('uses the manifest of the latest check that confirmed the download', async () => {
      // Downloaded while v2 offered the universal 1.9.0; once 2.0.0 (arm64 only) is out, v1
      // offers the same file, and v2's 2.0.0 mark no longer applies to it.
      await expect(installWith('v2', { v1: '1.9.0', v2: '2.0.0' }, 'v1')).resolves.toMatchObject({ prepared: true })
      await expect(installWith('v1', { v1: '1.9.0', v2: '2.0.0' }, 'v2')).resolves.toMatchObject({ prepared: false })
    })
  })

  it('records each manifest in its own mark and resolves the one its stale decision uses', async () => {
    const stored = { highestVerifiedVersion: '1.9.0' as string | null, highestVerifiedVersionV2: '2.0.1' as string | null }
    const trust = {
      read: vi.fn(async () => ({ ...stored })),
      recordVerifiedVersion: vi.fn(async (version: string, manifest: 'v1' | 'v2') => {
        const field = manifest === 'v1' ? 'highestVerifiedVersion' : 'highestVerifiedVersionV2'
        const mark = stored[field]
        if (mark === null || version.localeCompare(mark, undefined, { numeric: true }) > 0) stored[field] = version
        return { ...stored }
      }),
    }
    const resolved: Array<string | null> = []
    const controller = createUpdateController({
      currentVersion: '1.8.0',
      preferences: prefs(),
      trustState: trust,
      checker: async ({ recordVerifiedVersion }) => {
        resolved.push(await recordVerifiedVersion('2.0.0', 'v2'))
        resolved.push(await recordVerifiedVersion('1.8.0', 'v1'))
        await expect(recordVerifiedVersion('2.0.0', 'v3' as 'v2')).rejects.toThrow(TypeError)
        return state('current', false)
      },
      notifier: vi.fn(),
    })
    await controller.checkNow()
    // v2 is checked against the higher of both marks; v1 against its own mark alone. Each
    // save writes that manifest's session high, which already holds the stored 1.9.0.
    expect(resolved).toEqual(['2.0.1', '1.9.0'])
    expect(trust.recordVerifiedVersion.mock.calls).toEqual([['2.0.0', 'v2'], ['1.9.0', 'v1']])
  })
})

