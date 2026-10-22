'use strict'
// Opening links from the viewer (issue #300), in Electron main.
//
// Agent text is attacker-influenced, so the renderer only ASKS, through the one
// preload method (window.agentInboxLinks.open). This module decides, and it
// re-validates everything: the sender, the request's exact shape, the scheme,
// the path and the file it names. The same web check guards the window's
// setWindowOpenHandler and will-navigate paths.
//
//   Web links: http and https only, parsed with URL; only the normalized href
//   ever reaches shell.openExternal.
//   Files: an absolute path after expanding ~/, normalized, free of NUL and
//   control characters. Symlinks are resolved and the FINAL target is judged:
//     missing                                        → reported as missing
//     a folder or app bundle                         → revealed, never opened
//     a denied type (apps, launchers, installers, disk images, executables,
//       macro documents, certificates), by the name of the link or of its
//       target                                       → revealed, never opened
//     any file with an execute bit, or not a regular file → revealed, never opened
//     a type not on the allow-list of common documents → revealed
//     on macOS, an alias (bookmark data, the Finder alias flag or a resource
//       fork) or a file with its own "Open With"      → revealed, whatever its
//       type, and so is a file whose check cannot finish
//     anything else                                  → shell.openPath(resolved)
//   Opening is an allow-list because a deny-list of what runs code never ends.
//   realpath does not follow a Finder alias, and Launch Services opens an
//   alias's target or a file's own Open With app instead of the default, so
//   those are judged from the file's first bytes and its attributes
//   (/usr/bin/xattr, argv only). The check is point-in-time: someone who can
//   already write to the folder can still swap the file between the check and
//   the open.
//
// Settings → Links (part 2, macOS only) can then choose how a file or a web
// link opens: an app the human picked in main's own native picker
// (`/usr/bin/open -a <app> -- <target>`), Quick Look (`/usr/bin/qlmanage -p`)
// or Reveal. A rule is read only after a folder, a bundle, a denied type and an
// executable have been revealed, and the alias and Open With checks run before
// it opens anything, so a rule never opens what those reveal. With an app or
// Quick Look, a rule may open a type the allow-list leaves out (a code file in
// an editor); "System default" never does. The chosen app is checked again at
// every launch. Launches use argv only: no shell, stdio ignored.
//
// Pure apart from the filesystem reads, the xattr calls and the injected shell
// and spawn, so every rule is testable without Electron (test/link-policy.test.ts).
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const MAX_URL_LENGTH = 8192
const MAX_PATH_LENGTH = 4096
const MAX_APP_PATH = 1024
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const OPEN_COMMAND = '/usr/bin/open'
const QUICK_LOOK_COMMAND = '/usr/bin/qlmanage'
// `open` returns once Launch Services has the request; a slower answer counts
// as started rather than holding the click.
const OPEN_WAIT_MS = 10_000
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const OPENED = Object.freeze({ ok: true, action: 'opened' })
const FAILED = Object.freeze({ ok: false, reason: 'failed' })
// Apps that run what they open. Main never launches one for a link, whatever a
// rule says, and the picker refuses them: a guard against a slip, not a
// boundary, since the human's own choice is what is being checked.
const RUNNER_APPS = new Set([
  'alacritty', 'automator', 'ghostty', 'hyper', 'installer', 'iterm', 'iterm2', 'kitty', 'python launcher',
  'python launcher 3', 'script editor', 'shortcuts', 'terminal', 'warp', 'wezterm',
])
const APP_FAILURE = { 'not-an-app': 'app-missing', 'runs-code': 'app-refused' }
const XATTR_COMMAND = '/usr/bin/xattr'
const XATTR_WAIT_MS = 5_000
const XATTR_MAX_OUTPUT = 64 * 1024
const FINDER_INFO = 'com.apple.FinderInfo'
const OPEN_WITH = 'com.apple.LaunchServices.OpenWith'
// kIsAlias in the Finder flags, the big-endian word at byte 8 of FinderInfo.
const IS_ALIAS = 0x8000
// How a bookmark-format alias file (every alias Finder makes today) starts.
const BOOKMARK_MAGIC = Buffer.from('book\0\0\0\0mark', 'latin1')

// Lowercased, without the dot. The only types main opens with the system's
// default app: documents whose default handler shows them rather than running
// them. A browser runs a page's or an SVG's script only in its own sandbox.
// Code files (py, rb, sh, …) are not here, because their default app may run
// them; anything else is only revealed.
const OPENABLE_EXTENSIONS = new Set([
  'csv', 'diff', 'gif', 'heic', 'htm', 'html', 'jpeg', 'jpg', 'json', 'jsonl', 'log', 'markdown', 'md', 'mov',
  'mp4', 'patch', 'pdf', 'png', 'svg', 'text', 'toml', 'tsv', 'txt', 'webp', 'xml', 'yaml', 'yml',
])

// Lowercased, without the dot. Never opened, whatever app claims them or any
// rule says: they run code, install or mount something, or open something
// else in their place. A second layer under the allow-list.
const BLOCKED_EXTENSIONS = new Set([
  // apps, bundles, plug-ins and launchers
  'action', 'app', 'appex', 'bundle', 'caction', 'command', 'component', 'framework', 'kext', 'mdimporter', 'osax',
  'plugin', 'prefpane', 'qlgenerator', 'saver', 'shortcut', 'systemextension', 'term', 'terminal', 'tool', 'wdgt',
  'widget', 'workflow', 'xpc', 'alfredworkflow',
  // files that open, mount or connect to something else: locations, shortcuts, profiles
  'afploc', 'atloc', 'configprofile', 'desktop', 'fileloc', 'ftploc', 'inetloc', 'lnk', 'mailloc', 'mobileconfig',
  'mobileprovision', 'newsloc', 'ovpn', 'provisionprofile', 'smbloc', 'url', 'vncloc', 'webarchive', 'webloc',
  // installers, packages and disk images
  'apk', 'appimage', 'appx', 'appxbundle', 'asif', 'cdr', 'crx', 'deb', 'dmg', 'dmgpart', 'dvdr', 'flatpak',
  'flatpakref', 'flatpakrepo', 'img', 'ipa', 'iso', 'jnlp', 'mpkg', 'msi', 'msix', 'msixbundle', 'msp', 'pkg', 'rpm',
  'run', 'safariextz', 'smi', 'snap', 'sparsebundle', 'sparseimage', 'toast', 'udif', 'vsix', 'xpi',
  // executables, libraries and compiled or packaged scripts
  'bin', 'com', 'cpl', 'dll', 'dylib', 'elf', 'exe', 'gadget', 'jar', 'msc', 'pif', 'pyc', 'pyo', 'pyz', 'pyzw',
  'scpt', 'scptd', 'scr', 'so', 'sys',
  // Windows script host, ClickOnce, batch and registry files, which run when opened
  'application', 'appref-ms', 'bat', 'cmd', 'hta', 'inf', 'jse', 'reg', 'scf', 'vb', 'vbe', 'vbs', 'ws', 'wsc',
  'wsf', 'wsh',
  // documents that can carry macros
  'doc', 'docm', 'dot', 'dotm', 'pot', 'potm', 'ppa', 'ppam', 'pps', 'ppsm', 'ppt', 'pptm', 'sldm', 'slk', 'xla',
  'xlam', 'xll', 'xlm', 'xls', 'xlsb', 'xlsm', 'xlt', 'xltm',
  // certificates and keychains, which macOS imports when opened
  'cer', 'crt', 'der', 'keychain', 'keychain-db', 'p12', 'p7b', 'p7c', 'pem', 'pfx',
])

// The normalized href of an http(s) URL, or null. Parsed with URL, never by
// string matching, so `JaVaScRiPt:` or a smuggled control character cannot
// pass for a web link.
function externalWebUrl(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_URL_LENGTH) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null
  return url.href
}

// Whether a navigation stays on the viewer itself.
function isViewerUrl(value, viewerUrl) {
  try {
    return new URL(value).origin === new URL(viewerUrl).origin
  } catch {
    return false
  }
}

// Starts `command` with `args`, never through a shell, output ignored, and
// detached so a long-lived viewer (Quick Look) outlives nothing of ours.
// Resolves whether it started (and, with waitForExit, whether it exited 0).
function launch(spawnImpl, command, args, { waitForExit }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(command, args, { stdio: 'ignore', shell: false, detached: true, windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    let timer = null
    const finish = (ok) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    child.once('error', () => finish(false))
    if (waitForExit) {
      timer = setTimeout(() => finish(true), OPEN_WAIT_MS)
      child.once('exit', (code) => finish(code === 0))
    } else {
      child.once('spawn', () => finish(true))
    }
    if (typeof child.unref === 'function') child.unref()
  })
}

// An absolute, normalized path that names an .app bundle, by its shape alone.
function appBundlePath(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_APP_PATH || CONTROL_RE.test(value)) return null
  if (!path.isAbsolute(value) || !/\.app$/i.test(value)) return null
  return path.normalize(value)
}

const isRunnerApp = (app) => RUNNER_APPS.has(path.basename(app).replace(/\.app$/i, '').toLowerCase())

// The one check for an app a rule may launch, when the picker returns it and
// again at every launch, since the file holding the rule can be edited by
// hand and the bundle can move or change: after symlinks, its real path must
// still be an .app bundle with a Contents/Info.plist, and neither the name it
// was chosen under nor the one it resolves to may run what it opens. The real
// path is what gets launched.
async function launchableApp(value, fsp = fs.promises) {
  const app = appBundlePath(value)
  if (!app) return { error: 'not-an-app' }
  let real
  try {
    real = await fsp.realpath(app)
    const [bundle, plist] = await Promise.all([fsp.stat(real), fsp.stat(path.join(real, 'Contents', 'Info.plist'))])
    if (!/\.app$/i.test(real) || !bundle.isDirectory() || !plist.isFile()) return { error: 'not-an-app' }
  } catch {
    return { error: 'not-an-app' }
  }
  return isRunnerApp(app) || isRunnerApp(real) ? { error: 'runs-code' } : { app: real }
}

// `open -a <app> -- <target>` once the app passes launchableApp.
async function openWithApp(spawnImpl, app, target, fsp) {
  const checked = await launchableApp(app, fsp)
  if (checked.error) return { ok: false, reason: APP_FAILURE[checked.error] }
  return (await launch(spawnImpl, OPEN_COMMAND, ['-a', checked.app, '--', target], { waitForExit: true })) ? OPENED : FAILED
}

const customOpening = ({ platform, spawnImpl }) => platform === 'darwin' && typeof spawnImpl === 'function'

// The rule Settings → Links holds for a file, by its extension, or null.
function fileRule(rules, filePath) {
  if (!rules || typeof rules !== 'object') return null
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!ext) return null
  if (MARKDOWN_EXTENSIONS.has(ext)) return rules.markdown ?? null
  return (Array.isArray(rules.types) ? rules.types : []).find((type) => type && type.extension === ext) ?? null
}

async function openWebHref(href, { shell, rules, platform, spawnImpl, fsp = fs.promises }) {
  const web = customOpening({ platform, spawnImpl }) && rules ? rules.web : null
  if (web && web.handler === 'app') return openWithApp(spawnImpl, web.app, href, fsp)
  await shell.openExternal(href)
  return OPENED
}

// The one way main opens a web URL, for the preload method and the window's
// own open and navigate paths alike. Returns whether it asked the OS to.
// `options` (part 2) carries the Settings → Links rules, read lazily. Nothing
// on this path can say why a chosen browser did not open (it has gone, it is
// refused, or it failed to start), so the default browser opens it instead:
// the href is already checked.
function openWebLink(value, shell, options = {}) {
  const href = externalWebUrl(value)
  if (!href) return false
  Promise.resolve()
    .then(() => (typeof options.readRules === 'function' ? options.readRules() : null))
    .catch(() => null)
    .then((rules) => openWebHref(href, { ...options, shell, rules }))
    .then((result) => (result.ok ? null : shell.openExternal(href)))
    .catch(() => {})
  return true
}

function normalizeLocalPath(value, homeDir) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATH_LENGTH || CONTROL_RE.test(value)) return null
  let expanded = value
  if (value.startsWith('~/')) {
    if (typeof homeDir !== 'string' || !path.isAbsolute(homeDir)) return null
    expanded = path.join(homeDir, value.slice(2))
  }
  if (!path.isAbsolute(expanded)) return null
  return path.normalize(expanded)
}

const extensionOf = (value) => path.extname(String(value)).slice(1).toLowerCase()

function blockedFileName(value) {
  const ext = extensionOf(value)
  return ext !== '' && BLOCKED_EXTENSIONS.has(ext)
}

const openableFileName = (value) => OPENABLE_EXTENSIONS.has(extensionOf(value))

// /usr/bin/xattr's output, or null when it did not finish cleanly.
function xattr(execFileImpl, args) {
  return new Promise((resolve) => {
    try {
      execFileImpl(XATTR_COMMAND, args, {
        encoding: 'utf8', timeout: XATTR_WAIT_MS, maxBuffer: XATTR_MAX_OUTPUT, windowsHide: true,
      }, (error, stdout) => resolve(error ? null : String(stdout)))
    } catch {
      resolve(null)
    }
  })
}

async function startsWithBookmark(file, fsp) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const head = Buffer.alloc(16)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return bytesRead >= BOOKMARK_MAGIC.length && head.subarray(0, BOOKMARK_MAGIC.length).equals(BOOKMARK_MAGIC)
  } finally {
    await handle.close()
  }
}

async function hasResourceFork(file, fsp) {
  try {
    return (await fsp.stat(path.join(file, '..namedfork', 'rsrc'))).size > 0
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false
    throw err
  }
}

// The Finder alias flag from `xattr -px com.apple.FinderInfo`, or null.
function finderAliasFlag(hex) {
  const compact = String(hex).replace(/\s+/g, '')
  if (!/^(?:[0-9a-f]{2})+$/i.test(compact)) return null
  const bytes = Buffer.from(compact, 'hex')
  return bytes.length < 10 ? null : (bytes.readUInt16BE(8) & IS_ALIAS) !== 0
}

// Whether Launch Services might open something other than this file with its
// default app: an alias (bookmark data, the Finder alias flag, or a resource
// fork, where old aliases kept their record) or a file with its own Open With.
// Fails closed: a check that cannot finish counts as yes. macOS only.
async function opensElsewhere(file, { fsp, platform, execFileImpl }) {
  if (platform !== 'darwin') return false
  try {
    if (await startsWithBookmark(file, fsp)) return true
    if (await hasResourceFork(file, fsp)) return true
  } catch {
    return true
  }
  const listing = await xattr(execFileImpl, [file])
  if (listing === null) return true
  const names = listing.split('\n')
  if (names.some((name) => name.startsWith(OPEN_WITH))) return true
  if (!names.includes(FINDER_INFO)) return false
  const finderInfo = await xattr(execFileImpl, ['-px', FINDER_INFO, file])
  return finderInfo === null || finderAliasFlag(finderInfo) !== false
}

function failureReason(err) {
  const code = err && err.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  if (code === 'EACCES' || code === 'EPERM') return 'inaccessible'
  if (code === 'ELOOP' || code === 'ENAMETOOLONG') return 'invalid'
  return 'failed'
}

// What main may do with a path: open it (with the Settings → Links rule that
// applies, if any), only reveal it (and why), or nothing. `rules` are the ones
// that apply here, or null.
async function fileOpenPlan(value, { homeDir, fsp = fs.promises, platform = process.platform, execFileImpl = execFile, rules = null } = {}) {
  const normalized = normalizeLocalPath(value, homeDir)
  if (!normalized) return { ok: false, reason: 'invalid' }
  let resolved
  let stats
  try {
    resolved = await fsp.realpath(normalized)
    stats = await fsp.lstat(resolved)
  } catch (err) {
    return { ok: false, reason: failureReason(err) }
  }
  const reveal = (reason) => ({ ok: true, action: 'reveal', path: resolved, reason })
  // realpath leaves no link behind; one here means the path changed under us
  if (stats.isSymbolicLink()) return { ok: false, reason: 'invalid' }
  if (stats.isDirectory()) return reveal(/\.app$/i.test(resolved) ? 'app' : 'folder')
  if (!stats.isFile()) return reveal('special')
  if (blockedFileName(normalized) || blockedFileName(resolved)) return reveal('blocked')
  if ((stats.mode & 0o111) !== 0) return reveal('executable')
  const rule = fileRule(rules, resolved)
  if (rule && rule.handler === 'reveal') return reveal('rule')
  const ruleOpens = rule !== null && (rule.handler === 'app' || rule.handler === 'quicklook')
  if (!ruleOpens && !openableFileName(resolved)) return reveal('type')
  if (await opensElsewhere(resolved, { fsp, platform, execFileImpl })) return reveal('blocked')
  return ruleOpens ? { ok: true, action: 'open', path: resolved, rule } : { ok: true, action: 'open', path: resolved }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const keysOf = (value) => Object.keys(value).sort().join(',')

// The exact request shapes the preload method sends, and nothing else. A file
// is opened, or only revealed when `reveal` (a file chip's Reveal action).
function linkRequest(value) {
  if (!isPlainObject(value)) return null
  if (value.kind === 'web' && keysOf(value) === 'kind,url' && typeof value.url === 'string') {
    return { kind: 'web', url: value.url }
  }
  if (value.kind === 'file' && keysOf(value) === 'kind,path,reveal' && typeof value.path === 'string' && typeof value.reveal === 'boolean') {
    return { kind: 'file', path: value.path, reveal: value.reveal }
  }
  return null
}

// Never rejects: the renderer gets { ok, action?, reason? } and says what
// happened. `rules`, `platform` and `spawnImpl` (part 2) apply Settings →
// Links on macOS, and only to what the safety policy lets open.
async function openLinkRequest(raw, { shell, homeDir, fsp, execFileImpl, rules = null, platform = process.platform, spawnImpl = null } = {}) {
  const request = linkRequest(raw)
  if (!request) return { ok: false, reason: 'invalid' }
  try {
    if (request.kind === 'web') {
      const href = externalWebUrl(request.url)
      if (!href) return { ok: false, reason: 'invalid' }
      return await openWebHref(href, { shell, rules, platform, spawnImpl, fsp })
    }
    const applying = customOpening({ platform, spawnImpl }) && !request.reveal ? rules : null
    const plan = await fileOpenPlan(request.path, { homeDir, fsp, platform, execFileImpl, rules: applying })
    if (!plan.ok) return { ok: false, reason: plan.reason }
    if (request.reveal || plan.action === 'reveal') {
      shell.showItemInFolder(plan.path)
      return { ok: true, action: 'revealed', reason: request.reveal ? 'requested' : plan.reason }
    }
    if (plan.rule && plan.rule.handler === 'quicklook') {
      return (await launch(spawnImpl, QUICK_LOOK_COMMAND, ['-p', plan.path], { waitForExit: false })) ? OPENED : FAILED
    }
    if (plan.rule && plan.rule.handler === 'app') return await openWithApp(spawnImpl, plan.rule.app, plan.path, fsp ?? fs.promises)
    const error = await shell.openPath(plan.path)
    return error ? FAILED : OPENED
  } catch {
    return FAILED
  }
}

// The update channel's sender check, the strictest one main has that does not
// depend on install ownership: the exact webContents of the app's one viewer
// window, still alive, whose sending frame is on the viewer's origin. A link
// request must also come from that window's top frame. Opening a link never
// runs code (main opens only allow-listed documents and reveals the rest), so
// it does not need the install path's ownership proof, and links keep working
// in a reused viewer.
function isTrustedLinkSender({ sender, senderFrame, window, viewerUrl }) {
  try {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false
    if (!sender || sender !== window.webContents) return false
    if (!senderFrame || senderFrame.parent !== null) return false
    return new URL(senderFrame.url).origin === new URL(viewerUrl).origin
  } catch {
    return false
  }
}

module.exports = {
  appBundlePath,
  blockedFileName,
  externalWebUrl,
  fileOpenPlan,
  isTrustedLinkSender,
  isRunnerApp,
  isViewerUrl,
  launchableApp,
  normalizeLocalPath,
  openableFileName,
  openLinkRequest,
  openWebLink,
}
