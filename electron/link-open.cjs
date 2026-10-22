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
//   Files: only for the viewer this app started and proved it owns (main's
//   `filesPermitted`); from a reused viewer a file request is refused unread.
//   Then an absolute path after expanding ~/, normalized, free of NUL and
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
// Pure apart from the filesystem reads, the xattr calls and the injected shell,
// so every rule is testable without Electron (test/link-policy.test.ts).
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const MAX_URL_LENGTH = 8192
const MAX_PATH_LENGTH = 4096
const CONTROL_RE = /[\u0000-\u001f\u007f]/
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

// The one way main opens a web URL, for the preload method and the window's
// own open and navigate paths alike. Returns whether it asked the OS to.
function openWebLink(value, shell) {
  const href = externalWebUrl(value)
  if (!href) return false
  Promise.resolve()
    .then(() => shell.openExternal(href))
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

// What main may do with a path: open it, only reveal it (and why), or nothing.
async function fileOpenPlan(value, { homeDir, fsp = fs.promises, platform = process.platform, execFileImpl = execFile } = {}) {
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
  if (!openableFileName(resolved)) return reveal('type')
  if (await opensElsewhere(resolved, { fsp, platform, execFileImpl })) return reveal('blocked')
  return { ok: true, action: 'open', path: resolved }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const keysOf = (value) => Object.keys(value).sort().join(',')

// The exact request shapes the preload method sends, and nothing else.
function linkRequest(value) {
  if (!isPlainObject(value)) return null
  if (value.kind === 'web' && keysOf(value) === 'kind,url' && typeof value.url === 'string') {
    return { kind: 'web', url: value.url }
  }
  if (value.kind === 'file' && keysOf(value) === 'kind,path' && typeof value.path === 'string') {
    return { kind: 'file', path: value.path }
  }
  return null
}

// Never rejects: the renderer gets { ok, action?, reason? } and says what
// happened. `filesPermitted` is main's word that the window shows the viewer
// this app started and proved it owns; without it no local path is even looked
// at ('unowned'), while web links still open.
async function openLinkRequest(raw, { shell, homeDir, fsp, platform, execFileImpl, filesPermitted = false } = {}) {
  const request = linkRequest(raw)
  if (!request) return { ok: false, reason: 'invalid' }
  if (request.kind === 'file' && filesPermitted !== true) return { ok: false, reason: 'unowned' }
  try {
    if (request.kind === 'web') {
      const href = externalWebUrl(request.url)
      if (!href) return { ok: false, reason: 'invalid' }
      await shell.openExternal(href)
      return { ok: true, action: 'opened' }
    }
    const plan = await fileOpenPlan(request.path, { homeDir, fsp, platform, execFileImpl })
    if (!plan.ok) return { ok: false, reason: plan.reason }
    if (plan.action === 'reveal') {
      shell.showItemInFolder(plan.path)
      return { ok: true, action: 'revealed', reason: plan.reason }
    }
    const error = await shell.openPath(plan.path)
    return error ? { ok: false, reason: 'failed' } : { ok: true, action: 'opened' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

// The update channel's sender check: the exact webContents of the app's one
// viewer window, still alive, whose sending frame is on the viewer's origin. A
// link request must also come from that window's top frame. This is all a web
// link needs, so web links keep working in a reused viewer; a local file also
// needs the window to show the viewer this app owns (`filesPermitted`, from the
// same binding as Setup and update installs).
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
  blockedFileName,
  externalWebUrl,
  fileOpenPlan,
  isTrustedLinkSender,
  isViewerUrl,
  normalizeLocalPath,
  openLinkRequest,
  openWebLink,
}
