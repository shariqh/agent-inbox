'use strict'

// Source pins on electron/main.cjs's updater wiring, shared by test/electron-updates.test.ts
// (on this checkout's main.cjs) and the rehearsal harness (on 1.x-last's bundled main.cjs,
// #344). The harness calls the bundled updater modules itself and bypasses main.cjs, so
// these pins are its proof that the app wires them the way the harness does: `translated`
// and `hostArch`, the Review release refusal for `apple-silicon`, the `rosetta`
// notification, the macOS installer's options, the rollback-mark recorder and the download
// folder.

// Every slice is cut the way the tests always cut it: from the first marker to the end
// marker, which `between` searches from the start of the text and `after` from the first
// marker on. A missing marker gives no slice, so every pin in it fails.
function between(text, start, end) {
  if (text === null) return null
  const from = text.indexOf(start)
  const to = text.indexOf(end)
  return from === -1 || to < from ? null : text.slice(from, to)
}

function after(text, start, end) {
  if (text === null) return null
  const from = text.indexOf(start)
  const to = from === -1 ? -1 : text.indexOf(end, from)
  return to === -1 ? null : text.slice(from, to)
}

const SLICES = Object.freeze({
  'main.cjs': (main) => main,
  initializeUpdateController: (main) => between(main, 'function initializeUpdateController()', 'async function startOwnServer()'),
  'the update-open-release handler': (main) => after(main, "ipcMain.handle('agent-inbox:update-open-release'", '\n})\n'),
  'the update notifier': (main) => between(SLICES.initializeUpdateController(main), 'notifier: (', 'emit: sendUpdateState'),
  // The macOS installer's options alone: appImageInstallers() and the checker pass some of
  // the same lines.
  updateInstallers: (main) => after(main, 'function updateInstallers()', '\n}\n'),
  spawnedViewerPid: (main) => after(main, 'function spawnedViewerPid()', '\n}'),
})

const contains = (slice, text) => Object.freeze({ slice, contains: text })
const matches = (slice, pattern) => Object.freeze({ slice, matches: pattern })
const before = (slice, first, second) => Object.freeze({ slice, before: Object.freeze([first, second]) })

const INITIALIZER = 'initializeUpdateController'
const MAC_INSTALLER = 'updateInstallers'

const MAIN_PINS = Object.freeze({
  // #343: the wiring behind the harness's `translated`, `hostArch`, Review release and
  // notification checks.
  rosetta: Object.freeze([
    matches(INITIALIZER, /checkForUpdate\(\{[^}]*\n\s+arch: process\.arch,\n\s+translated: app\.runningUnderARM64Translation === true,\n/),
    matches(INITIALIZER, /createMacInstaller\(\{[^}]*\n\s+hostArch: process\.arch,\n/),
    contains('main.cjs', "const { MANUAL_RELEASES_URL, createUpdateController, reviewReleaseOffered } = require('./update-controller.cjs')"),
    contains('the update-open-release handler', 'if (!reviewReleaseOffered(state)) return false'),
    before('the update-open-release handler', 'reviewReleaseOffered(state)', 'shell.openExternal('),
    contains('the update notifier', 'notifier: ({ version, downloadable, installable, rosetta }) => {'),
    contains('the update notifier', 'body: rosetta\n'),
    contains('the update notifier', '`Version ${version} is available. Reopen Agent Inbox without Rosetta to install it.`'),
  ]),
  // The macOS installer main registers, which run 1 builds the same way on a scratch app.
  macInstaller: Object.freeze([
    contains('main.cjs', "const { bundlePathFromExecPath, createMacInstaller } = require('./update-install-macos.cjs')"),
    contains(INITIALIZER, 'installers: updateInstallers(),'),
    contains(MAC_INSTALLER, "if (process.platform !== 'darwin' || !viewerOwned) return {}"),
    contains(MAC_INSTALLER, 'bundlePath: bundlePathFromExecPath(process.execPath),'),
    contains(MAC_INSTALLER, "expectedBundleId: 'io.github.shariqh.agent-inbox',"),
    contains(MAC_INSTALLER, "teamId: 'VVR2DKR923',"),
    contains(MAC_INSTALLER, 'systemVersion: process.getSystemVersion(),'),
    contains(MAC_INSTALLER, 'pid: process.pid,'),
    contains(MAC_INSTALLER, 'viewerPid: spawnedViewerPid,'),
    contains(MAC_INSTALLER, 'uid: process.getuid(),'),
    contains(MAC_INSTALLER, 'isPackaged: app.isPackaged,'),
    contains(MAC_INSTALLER, "workDirectory: path.join(app.getPath('userData'), 'update-install'),"),
    contains(INITIALIZER, '`Version ${version} is available. Download and install it from Settings → Updates.`'),
    contains('main.cjs', "const { createInstallAttemptStore } = require('./update-install.cjs')"),
    contains(INITIALIZER, "attemptStore: createInstallAttemptStore({ directory: path.join(app.getPath('userData'), 'update-install') }),"),
    contains(INITIALIZER, 'notifyInstallFailure: ({ message }) => {'),
    contains(INITIALIZER, "title: 'Agent Inbox update was not installed',"),
    contains('spawnedViewerPid', 'spawnedViewer.exitCode === null'),
    contains('spawnedViewerPid', 'spawnedViewer.signalCode === null'),
  ]),
  // Each manifest's rollback mark (#148, #343), recorded through the trust-state file.
  recorder: Object.freeze([
    contains('main.cjs', "const { createUpdatePreferences, createUpdateTrustState } = require('./update-preferences.cjs')"),
    contains(INITIALIZER, 'trustState: createUpdateTrustState({ app }),'),
    contains(INITIALIZER, 'checker: ({ currentVersion, automaticChecks, recordVerifiedVersion }) => checkForUpdate({'),
    matches(INITIALIZER, /checkForUpdate\(\{[^}]*\n\s+recordVerifiedVersion,\n/),
  ]),
  // The signed artifact reaches the downloader, which writes only under userData.
  downloads: Object.freeze([
    contains('main.cjs', 'includeArtifact: true'),
    contains('main.cjs', "directory: path.join(app.getPath('userData'), 'update-downloads')"),
  ]),
})

function describePin(pin) {
  if (pin.contains !== undefined) return `contain ${JSON.stringify(pin.contains)}`
  if (pin.matches !== undefined) return `match ${pin.matches}`
  return `have ${JSON.stringify(pin.before[0])} before ${JSON.stringify(pin.before[1])}`
}

function holds(text, pin) {
  if (pin.contains !== undefined) return text.includes(pin.contains)
  if (pin.matches !== undefined) return pin.matches.test(text)
  const first = text.indexOf(pin.before[0])
  const second = text.indexOf(pin.before[1])
  return first !== -1 && second !== -1 && first < second
}

/** The pins `main` fails, one line each naming the slice and what it lacks; [] when all hold. */
function pinFailures(main, pins) {
  if (typeof main !== 'string') throw new TypeError('main must be the text of main.cjs')
  const failures = []
  for (const pin of pins) {
    const cut = SLICES[pin.slice]
    if (cut === undefined) throw new TypeError(`unknown slice ${pin.slice}`)
    const text = cut(main)
    if (text === null) failures.push(`${pin.slice} is missing from main.cjs`)
    else if (!holds(text, pin)) failures.push(`${pin.slice} does not ${describePin(pin)}`)
  }
  return failures
}

module.exports = {
  MAIN_PINS,
  pinFailures,
}
