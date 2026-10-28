'use strict'

// The three rehearsal runs (#344; update manifest v2 design §8.5), against 1.x-last's own
// updater modules, which rehearsal.cjs loads from the installed app. Every run builds the
// controller the way electron/main.cjs's initializeUpdateController() does and injects only
// the scratch registry, a fetch that answers the four manifest URLs with scratch-signed
// pairs and passes everything else to the real fetch, the running version, `translated`,
// the macOS version and scratch userData folders.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')

// What main.cjs passes; test/rehearsal/main-pins.cjs checks 1.x-last's main.cjs for both.
const EXPECTED_BUNDLE_ID = 'io.github.shariqh.agent-inbox'
const TEAM_ID = 'VVR2DKR923'
const CODE_REQUIREMENT = `anchor apple generic and identifier "${EXPECTED_BUNDLE_ID}" and certificate leaf[subject.OU] = "${TEAM_ID}"`
const RELEASE_DOWNLOADS = 'https://github.com/shariqh/agent-inbox/releases/download'
// The relaunched app's viewer, on the port every packaged app uses.
const VIEWER_VERSION_URL = 'http://127.0.0.1:4319/api/version'
const STAGE_RE = /^\.agent-inbox-update-[A-Za-z0-9]{6}$/
// The helper gives up after about 120 s; its result is written before the app reopens.
const HELPER_RESULT_WAIT_MS = 150_000
const RELAUNCH_WAIT_MS = 90_000

// The copy Settings shows under "Agent Inbox X is available." for a release this Mac can't
// install (design §6.3), written out here rather than read from the code under test.
const BLOCKED_COPY = Object.freeze({
  'apple-silicon': (running) => `It needs a Mac with Apple silicon. This Mac has an Intel processor, so Agent Inbox stays on ${running}, which keeps working.`,
  rosetta: () => 'It runs only natively on Apple silicon, and Agent Inbox is running under Rosetta. Quit Agent Inbox, turn off “Open using Rosetta” in its Get Info window in Finder, then reopen it to install.',
})
// What 1.x-last's reader throws for each bad update-manifest.json.
const V1_FAILURES = Object.freeze({
  missing: 'update endpoint did not return a successful response',
  mixed: 'manifest bytes do not match the digest recorded in the signature envelope',
})

function show(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

function createReport(write) {
  const totals = { pass: 0, fail: 0 }
  const runs = []
  return Object.freeze({
    heading(text) {
      write('')
      write(text)
    },
    beginRun(name) {
      runs.push({ name, pass: 0, fail: 0 })
    },
    check(name, ok, detail) {
      const key = ok ? 'pass' : 'fail'
      totals[key] += 1
      if (runs.length > 0) runs[runs.length - 1][key] += 1
      write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
      if (!ok && detail !== undefined) write(`        ${detail}`)
      return Boolean(ok)
    },
    same(name, actual, expected) {
      return this.check(name, isDeepStrictEqual(actual, expected), `got ${show(actual)}, expected ${show(expected)}`)
    },
    note(text) {
      write(`        ${text}`)
    },
    totals,
    runs,
  })
}

// What releases/latest/download answers for the four manifest URLs, as a fetch: the scratch
// pairs, a missing pair (404), or a manifest and a signature from different releases. Every
// other request goes to the real network, except the scratch release's own files: they
// don't exist, and the reader must never ask for one.
function createLatest({ urls, scratchRelease, fetchImpl }) {
  const files = new Map()
  const requests = []
  let refused = 0
  function serve({ v2 = null, v1 = null } = {}) {
    files.set(urls.manifestV2, v2?.bytes ?? null)
    files.set(urls.signatureV2, v2?.signature ?? null)
    files.set(urls.manifest, v1?.bytes ?? null)
    files.set(urls.signature, v1?.signature ?? null)
  }
  serve()
  return Object.freeze({
    serve,
    // The requests since the last call, oldest first.
    take() {
      return requests.splice(0)
    },
    // How many requests asked for the scratch release's files, ever.
    refused() {
      return refused
    },
    async fetch(input, init) {
      const url = String(input?.url ?? input)
      if (files.has(url)) {
        const body = files.get(url)
        requests.push({ url, answer: body === null ? 'missing' : 'scratch' })
        if (body === null) return new Response(null, { status: 404 })
        return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } })
      }
      if (url.startsWith(scratchRelease)) {
        refused += 1
        requests.push({ url, answer: 'refused' })
        throw new TypeError('the rehearsal never fetches the scratch release, which does not exist')
      }
      requests.push({ url, answer: 'network' })
      return fetchImpl(input, init)
    },
  })
}

// Runs 2 and 3 never install. Their installer gets an empty scratch folder in place of the
// running app, so feasibility answers as it would for an app in a writable folder.
function scratchTarget(runDir) {
  const bundle = path.join(runDir, 'Scratch target', 'Agent Inbox.app')
  fs.mkdirSync(bundle, { recursive: true })
  return bundle
}

// The installer as the controller sees it, unchanged, except that the error behind a failed
// prepare() or commit() is kept: the controller reports only "could not be installed".
function observed(installer, errors) {
  const keep = (step, error) => {
    errors.push(`${step}: ${error?.code ?? 'error'}: ${error?.message ?? error}`)
    throw error
  }
  return Object.freeze({
    strategy: installer.strategy,
    feasibility: (candidate) => installer.feasibility(candidate),
    cleanup: () => installer.cleanup(),
    async prepare(source, options) {
      const prepared = await installer.prepare(source, options).catch((error) => keep('prepare()', error))
      return Object.freeze({
        commit: (commitOptions) => prepared.commit(commitOptions).catch((error) => keep('commit()', error)),
        discard: () => prepared.discard(),
      })
    },
  })
}

// initializeUpdateController() and updateInstallers() in main.cjs, with only the injected
// values replaced; `app` is reduced to app.getPath('userData').
function buildController(ctx, { currentVersion, userData, bundlePath }) {
  const { modules, host, latest, manifests } = ctx
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  const app = Object.freeze({
    getPath(name) {
      if (name !== 'userData') throw new Error(`app.getPath('${name}') is not part of the rehearsal`)
      return userData
    },
  })
  const seen = { checks: [], notifications: [], installErrors: [], restartRequested: false }
  const downloader = modules.download.createUpdateDownloader({
    directory: path.join(userData, 'update-downloads'),
    fetchImpl: latest.fetch,
  })
  const installer = modules.installMacos.createMacInstaller({
    bundlePath,
    expectedBundleId: EXPECTED_BUNDLE_ID,
    teamId: TEAM_ID,
    systemVersion: host.macos,
    pid: process.pid,
    // A packaged app runs its viewer in-process, so there is no viewer child to wait for.
    viewerPid: () => null,
    uid: process.getuid(),
    platform: process.platform,
    hostArch: process.arch,
    isPackaged: true,
    workDirectory: path.join(userData, 'update-install'),
  })
  const preferences = modules.preferences.createUpdatePreferences({ app })
  const trustState = modules.preferences.createUpdateTrustState({ app })
  const controller = modules.controller.createUpdateController({
    currentVersion,
    preferences,
    trustState,
    checker: async ({ currentVersion: running, automaticChecks, recordVerifiedVersion }) => {
      const check = { result: null, error: null }
      seen.checks.push(check)
      try {
        check.result = await modules.fetch.checkForUpdate({
          fetchImpl: latest.fetch,
          registry: manifests.registry,
          currentVersion: running,
          automaticChecks,
          recordVerifiedVersion,
          platform: process.platform,
          arch: process.arch,
          translated: host.translated,
          isPackaged: true,
          appImagePath: process.env.APPIMAGE,
          appDir: process.env.APPDIR,
          execPath: process.execPath,
          includeArtifact: true,
        })
        return check.result
      } catch (error) {
        check.error = error
        throw error
      }
    },
    downloader,
    installers: { 'macos-dmg': observed(installer, seen.installErrors) },
    attemptStore: modules.install.createInstallAttemptStore({ directory: path.join(userData, 'update-install') }),
    // No Setup runs, no quit has begun, and the one window may install (main's grants).
    isSetupRunning: () => false,
    isQuitting: () => false,
    isInstallPermitted: () => true,
    // main.cjs quits here; the harness exits once the run is reported.
    requestRestart: () => {
      seen.restartRequested = true
    },
    // Reports an earlier attempt that failed; every run's userData is new, so there is none.
    notifyInstallFailure: () => {},
    notifier: (notification) => {
      seen.notifications.push(notification)
    },
  })
  return { controller, downloader, installer, preferences, trustState, seen, userData }
}

function lastCheck(app) {
  return app.seen.checks[app.seen.checks.length - 1] ?? { result: null, error: null }
}

async function check(ctx, app, served) {
  ctx.latest.serve(served)
  ctx.latest.take()
  const state = await app.controller.checkNow()
  return { state, ...lastCheck(app), requests: ctx.latest.take() }
}

function manifestUrls(ctx, which) {
  const { urls } = ctx
  return which === 'v1' ? [urls.manifest, urls.signature] : [urls.manifestV2, urls.signatureV2]
}

function servedFiles(ctx, requests, which) {
  const files = new Set(manifestUrls(ctx, which))
  return requests.filter((request) => files.has(request.url))
}

function sameRecord(left, right) {
  return left !== null && right !== null && isDeepStrictEqual({ ...left }, { ...right })
}

async function stillVerifies(app, record) {
  try {
    return sameRecord(await app.downloader.verify(record), record)
  } catch {
    return false
  }
}

function megabytes(bytes) {
  return (bytes / 1e6).toFixed(1)
}

// --- Run 2 ---------------------------------------------------------------------------------

/** Run 2: the app is 1.x-last itself, so update-manifest.json offers nothing newer. */
async function runOnLast(ctx) {
  const { report, host, manifests, last, next, modules } = ctx
  const app = buildController(ctx, {
    currentVersion: last,
    userData: path.join(ctx.runDir, 'userData'),
    bundlePath: scratchTarget(ctx.runDir),
  })
  try {
    await app.controller.rendererReady()
    const good = { v2: manifests.v2, v1: manifests.v1 }
    const { state, result, error, requests } = await check(ctx, app, good)
    if (error) report.note(`the check threw: ${error.message}`)
    if (host.arm64) {
      await nativeOnLast(ctx, app, { state, result, requests })
      return
    }
    const blocked = host.translated ? 'rosetta' : 'apple-silicon'
    report.same(
      `the check verifies both manifests and offers ${next} from v2, blocked "${blocked}"`,
      { status: result?.status, manifest: result?.manifest, version: result?.available?.version, blocked: result?.available?.blocked },
      { status: 'available', manifest: 'v2', version: next, blocked },
    )
    report.same('with no artifact: there is nothing to download', result ? Object.hasOwn(result, 'artifact') : 'no check result', false)
    report.same(
      `Settings → Updates shows ${next} as available, blocked "${blocked}"`,
      { status: state.status, version: state.available?.version, blocked: state.available?.blocked },
      { status: 'available', version: next, blocked },
    )
    report.same('with the fixed copy', state.available?.reason, BLOCKED_COPY[blocked](last))
    report.same(
      'and neither Download nor Install',
      { downloadable: state.available?.downloadable, installable: state.available?.installable, verified: app.controller.getVerifiedArtifact() },
      { downloadable: false, installable: false, verified: null },
    )
    report.same(
      blocked === 'apple-silicon'
        ? 'Review release is hidden, and main refuses to open the release page'
        : 'Review release stays: this Mac can run the release natively',
      modules.controller.reviewReleaseOffered(state),
      blocked === 'rosetta',
    )
    report.same(
      'the only requests are update-manifest-v2.json, then update-manifest.json: no arm64 DMG',
      requests,
      [...manifestUrls(ctx, 'v2'), ...manifestUrls(ctx, 'v1')].map((url) => ({ url, answer: 'scratch' })),
    )
    report.same(
      'each manifest\'s version went into its own rollback mark',
      await app.trustState.read(),
      { highestVerifiedVersion: last, highestVerifiedVersionV2: next },
    )
    const refused = await app.installer.feasibility({ version: next, architecture: 'arm64', minimumSystemVersion: ctx.lastDmg.minimumSystemVersion })
    report.same('the installer refuses the arm64 DMG for this process', { ok: refused.ok, reason: refused.reason }, { ok: false, reason: 'architecture' })
    const prepared = await app.installer
      .prepare({ record: { installStrategy: 'macos-dmg', packageType: 'dmg', version: next, architecture: 'arm64' } })
      .then(() => 'prepared', (failure) => failure?.code ?? String(failure))
    report.same(
      'and prepare() refuses it before touching anything',
      { refusal: prepared, workDirectory: fs.existsSync(path.join(app.userData, 'update-install')) },
      { refusal: 'not-feasible', workDirectory: false },
    )

    // Scheduled checks, as the daily timer runs them, decide the notification.
    await app.preferences.setAutomatic(true)
    ctx.latest.take()
    await app.controller.runScheduledCheck()
    await app.controller.runScheduledCheck()
    const scheduled = ctx.latest.take()
    const notifications = app.seen.notifications.map(({ version, downloadable, installable, rosetta }) => ({ version, downloadable, installable, rosetta }))
    if (blocked === 'apple-silicon') {
      report.same('two scheduled checks send no notification: an Intel Mac can do nothing about it', notifications, [])
    } else {
      report.same(
        'two scheduled checks send one notification for the version, with the Rosetta copy',
        notifications,
        [{ version: next, downloadable: false, installable: false, rosetta: true }],
      )
    }
    report.same(
      'and still request nothing but the manifests',
      scheduled.filter((request) => request.answer !== 'scratch'),
      [],
    )
  } finally {
    app.controller.dispose()
  }
}

// On an arm64 process the arm64 DMG is offered straight from v2 (design §4.4): a control.
async function nativeOnLast(ctx, app, { state, result, requests }) {
  const { report, next, modules } = ctx
  report.same(
    `the check offers ${next}'s arm64 DMG straight from v2`,
    { status: result?.status, manifest: result?.manifest, version: result?.available?.version, blocked: result?.available?.blocked, filename: result?.artifact?.filename },
    { status: 'available', manifest: 'v2', version: next, blocked: undefined, filename: `Agent-Inbox-v${next}-arm64.dmg` },
  )
  report.same(
    'Settings → Updates can download and install it',
    { status: state.status, downloadable: state.available?.downloadable, installable: state.available?.installable, blocked: state.available?.blocked },
    { status: 'available', downloadable: true, installable: true, blocked: undefined },
  )
  report.same('Review release stays', modules.controller.reviewReleaseOffered(state), true)
  report.same(
    'update-manifest.json is never requested',
    requests,
    manifestUrls(ctx, 'v2').map((url) => ({ url, answer: 'scratch' })),
  )
  report.same('only the v2 mark is raised', await app.trustState.read(), { highestVerifiedVersion: null, highestVerifiedVersionV2: next })
  await app.preferences.setAutomatic(true)
  await app.controller.runScheduledCheck()
  await app.controller.runScheduledCheck()
  report.same(
    'two scheduled checks send one ordinary notification',
    app.seen.notifications.map(({ version, installable, rosetta }) => ({ version, installable, rosetta })),
    [{ version: next, installable: true, rosetta: undefined }],
  )
}

// --- Run 3 ---------------------------------------------------------------------------------

/** Run 3: a missing, mixed or stale update-manifest.json never costs a verified download. */
async function runBadV1(ctx) {
  const { report, host, manifests, from, last, next } = ctx
  const target = scratchTarget(ctx.runDir)
  const good = { v2: manifests.v2, v1: manifests.v1 }
  const bad = [
    ['a missing v1 pair', 'missing', { v2: manifests.v2, v1: null }],
    ['a v1 manifest and a signature from different releases', 'mixed', { v2: manifests.v2, v1: { bytes: manifests.v1.bytes, signature: manifests.laterV1Signature } }],
  ]
  const above = ctx.markAbove
  const a = buildController(ctx, { currentVersion: from, userData: path.join(ctx.runDir, 'userData-a'), bundlePath: target })
  try {
    await a.controller.rendererReady()
    if (host.arm64) {
      await nativeBadV1(ctx, a, { good, bad, above })
      return
    }
    for (const [label, cause, served] of bad) {
      const { state, error } = await check(ctx, a, served)
      report.same(`${label}: the check ends "unverified"`, state.status, 'unverified')
      report.same('  because the v1 read failed', error?.message, V1_FAILURES[cause])
    }

    let { state, result, requests } = await check(ctx, a, good)
    const dmg = ctx.lastDmg
    report.same(
      `the good pair offers ${last} from update-manifest.json`,
      { status: state.status, version: state.available?.version, manifest: result?.manifest },
      { status: 'available', version: last, manifest: 'v1' },
    )
    report.same(
      `its artifact is the real, notarized ${dmg.filename}`,
      result?.artifact && { filename: result.artifact.filename, url: result.artifact.url, byteLength: result.artifact.byteLength, sha256: result.artifact.sha256, architecture: result.artifact.architecture },
      { filename: dmg.filename, url: dmg.url, byteLength: dmg.byteLength, sha256: dmg.sha256, architecture: 'universal' },
    )
    report.same(
      'which this Mac can download and install',
      { downloadable: state.available?.downloadable, installable: state.available?.installable },
      { downloadable: true, installable: true },
    )
    report.same('after both manifests and nothing else', requests.map((request) => request.url), [...manifestUrls(ctx, 'v2'), ...manifestUrls(ctx, 'v1')])

    const started = Date.now()
    state = await a.controller.downloadNow()
    const record = a.controller.getVerifiedArtifact()
    const downloads = ctx.latest.take()
    report.same(
      `the real DMG downloads and verifies (${megabytes(dmg.byteLength)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s)`,
      { status: state.status, version: record?.version, sha256: record?.sha256 },
      { status: 'verified', version: last, sha256: dmg.sha256 },
    )
    report.same('from its canonical release URL', downloads[0]?.url, dmg.url)
    if (record === null) return

    for (const [label, cause, served] of bad) {
      const { state: after, error } = await check(ctx, a, served)
      report.same(
        `${label}: the check fails quietly and keeps the verified download`,
        { status: after.status, kept: sameRecord(a.controller.getVerifiedArtifact(), record) },
        { status: 'verified', kept: true },
      )
      report.same('  because the v1 read failed', error?.message, V1_FAILURES[cause])
      report.check('  and the file still verifies', await stillVerifies(a, record))
    }

    await a.trustState.recordVerifiedVersion(above, 'v1')
    ;({ state, result } = await check(ctx, a, good))
    report.same(
      `a v1 mark of ${above}: the check returns "stale" and keeps the verified download`,
      { result: result?.status, status: state.status, kept: sameRecord(a.controller.getVerifiedArtifact(), record) },
      { result: 'stale', status: 'verified', kept: true },
    )
    report.check('  and the file still verifies', await stillVerifies(a, record))
  } finally {
    a.controller.dispose()
  }

  const b = buildController(ctx, { currentVersion: from, userData: path.join(ctx.runDir, 'userData-b'), bundlePath: target })
  try {
    await b.trustState.recordVerifiedVersion(above, 'v1')
    await b.controller.rendererReady()
    const { state, result } = await check(ctx, b, good)
    report.same(
      `with no download, a v1 mark of ${above}: the check ends "stale", offering nothing`,
      { result: result?.status, status: state.status, available: state.available },
      { result: 'stale', status: 'stale', available: undefined },
    )
  } finally {
    b.controller.dispose()
  }
  report.same(`no request ever asked for v${next}'s files`, ctx.latest.refused(), 0)
}

// On an arm64 process v2's arm64 DMG is offered directly, so update-manifest.json is never
// read and no bad v1 matters: a control.
async function nativeBadV1(ctx, app, { good, bad, above }) {
  const { report, next } = ctx
  for (const [label, , served] of bad) {
    const { state, result, requests } = await check(ctx, app, served)
    report.same(
      `${label}: still offered ${next} from v2, without reading update-manifest.json`,
      { status: state.status, version: state.available?.version, manifest: result?.manifest, v1Requests: servedFiles(ctx, requests, 'v1').length },
      { status: 'available', version: next, manifest: 'v2', v1Requests: 0 },
    )
  }
  await app.trustState.recordVerifiedVersion(above, 'v1')
  const { state, result } = await check(ctx, app, good)
  report.same(
    `a v1 mark of ${above}: still offered ${next} from v2, never "stale"`,
    { status: state.status, version: state.available?.version, manifest: result?.manifest },
    { status: 'available', version: next, manifest: 'v2' },
  )
}

// --- Run 1 ---------------------------------------------------------------------------------

/**
 * Run 1, first step: an app older than 1.x-last is offered 1.x-last through
 * update-manifest.json, downloads and verifies the real DMG, and installs it over a scratch
 * copy of an older app. The helper swaps the copy once this process exits, then opens it.
 */
async function runInstall(ctx, { olderApp, olderVersion }) {
  const { report, manifests, last } = ctx
  const userData = path.join(ctx.runDir, 'userData')
  const app = buildController(ctx, { currentVersion: olderVersion, userData, bundlePath: olderApp })
  await app.controller.rendererReady()
  let { state, result } = await check(ctx, app, { v2: manifests.v2, v1: manifests.v1 })
  const dmg = ctx.lastDmg
  const offered = report.same(
    `${olderVersion} is offered ${last}'s ${dmg.filename} from update-manifest.json`,
    { status: state.status, version: state.available?.version, manifest: result?.manifest, filename: result?.artifact?.filename, sha256: result?.artifact?.sha256 },
    { status: 'available', version: last, manifest: 'v1', filename: dmg.filename, sha256: dmg.sha256 },
  )
  const installable = report.same(
    'the installer can install it here',
    { downloadable: state.available?.downloadable, installable: state.available?.installable, reason: state.available?.reason },
    { downloadable: true, installable: true, reason: undefined },
  )
  if (!offered || !installable) return null

  const started = Date.now()
  state = await app.controller.downloadNow()
  const record = app.controller.getVerifiedArtifact()
  const verified = report.same(
    `the real DMG downloads and verifies (${megabytes(dmg.byteLength)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s)`,
    { status: state.status, sha256: record?.sha256 },
    { status: 'verified', sha256: dmg.sha256 },
  )
  if (!verified) return null

  report.note('installing: prepare() mounts the DMG, stages the app beside the scratch copy and runs')
  report.note('codesign, Gatekeeper and the slice check; commit() starts the helper')
  state = await app.controller.installNow()
  const handedOff = report.same(
    'prepare() passed and the helper took the swap',
    { status: state.status, restartRequested: app.seen.restartRequested, installing: app.controller.isInstalling() },
    { status: 'installing', restartRequested: true, installing: true },
  )
  if (!handedOff) {
    report.note(`Settings would say: ${state.message}`)
    for (const error of app.seen.installErrors) report.note(error)
    return null
  }
  return {
    olderApp,
    from: olderVersion,
    to: last,
    attemptDirectory: path.join(userData, 'update-install'),
    pid: process.pid,
    at: new Date().toISOString(),
  }
}

function infoPlist(bundle) {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

function codesignVerifies(bundle) {
  const result = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', `-R=${CODE_REQUIREMENT}`, bundle], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

// Gatekeeper's verdict and its source: "Notarized Developer ID" for a release, and nothing
// else, so an assessment on a Mac with assessments turned off doesn't count as a pass.
function gatekeeper(bundle) {
  const result = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { ok: result.status === 0, source: /^source=(.+)$/m.exec(output)?.[1] ?? null }
}

function runningFrom(bundle) {
  const result = spawnSync('/bin/ps', ['-axww', '-o', 'pid=,comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const executable = path.join(bundle, 'Contents', 'MacOS', 'Agent Inbox')
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s(.+)$/.exec(line)
    if (match && match[2] === executable) return Number(match[1])
  }
  return null
}

async function viewerVersion() {
  try {
    const response = await fetch(VIEWER_VERSION_URL, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return null
    const body = await response.json()
    return body?.mode === 'release' && typeof body.current === 'string' ? body.current : null
  } catch {
    return null
  }
}

async function waitFor(probe, timeoutMs, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

function previousCopies(olderApp) {
  const folder = path.dirname(olderApp)
  let names
  try {
    names = fs.readdirSync(folder)
  } catch {
    return []
  }
  return names
    .filter((name) => STAGE_RE.test(name))
    .map((name) => path.join(folder, name, 'Agent Inbox.app.previous'))
    .filter((previous) => fs.existsSync(previous))
}

/** Run 1, second step: the helper's report, the swapped app and the app it opened. */
async function verifyInstall(ctx, handoff) {
  const { report, modules } = ctx
  const { olderApp, from, to, attemptDirectory } = handoff
  const resultPath = path.join(attemptDirectory, 'last-attempt.result')
  report.note(`waiting up to ${HELPER_RESULT_WAIT_MS / 1000} s for the helper's result`)
  await waitFor(() => fs.existsSync(resultPath), HELPER_RESULT_WAIT_MS)
  const attempt = await modules.install.createInstallAttemptStore({ directory: attemptDirectory }).take()
  report.same(
    'the helper reports the swap done (exit 0)',
    attempt && { from: attempt.from, to: attempt.to, exitCode: attempt.exitCode },
    { from, to, exitCode: 0 },
  )
  const info = infoPlist(olderApp)
  report.same(
    `the app at ${olderApp} is now ${to}`,
    info && { identifier: info.CFBundleIdentifier, version: info.CFBundleShortVersionString },
    { identifier: EXPECTED_BUNDLE_ID, version: to },
  )
  const signature = codesignVerifies(olderApp)
  report.check(`its signature meets the Developer ID requirement for team ${TEAM_ID}`, signature.ok, signature.output)
  const assessed = gatekeeper(olderApp)
  report.same('Gatekeeper accepts it as notarized', assessed, { ok: true, source: 'Notarized Developer ID' })
  const previous = previousCopies(olderApp)
  report.same(
    `the replaced ${from} app is kept beside it`,
    previous.map((copy) => infoPlist(copy)?.CFBundleShortVersionString),
    [from],
  )
  report.note(`waiting up to ${RELAUNCH_WAIT_MS / 1000} s for the swapped app to open`)
  const pid = await waitFor(() => runningFrom(olderApp), RELAUNCH_WAIT_MS)
  report.check('the helper opened the swapped app', pid !== null, `no process runs ${path.join(olderApp, 'Contents', 'MacOS', 'Agent Inbox')}`)
  const reported = await waitFor(viewerVersion, RELAUNCH_WAIT_MS)
  report.same(`it reports ${to} (${VIEWER_VERSION_URL})`, reported, to)
}

module.exports = {
  EXPECTED_BUNDLE_ID,
  RELEASE_DOWNLOADS,
  TEAM_ID,
  CODE_REQUIREMENT,
  VIEWER_VERSION_URL,
  codesignVerifies,
  createLatest,
  createReport,
  infoPlist,
  runBadV1,
  runInstall,
  runOnLast,
  verifyInstall,
}
