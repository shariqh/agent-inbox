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
//     an executable, script, installer or launcher,
//       by the name of the link or of its target     → revealed, never opened
//     any file with an execute bit, or not a regular file → revealed, never opened
//     anything else                                  → shell.openPath(resolved)
//   The check is point-in-time: someone who can already write to the folder
//   can still swap the file between the check and the open.
//
// Pure apart from the filesystem reads and the injected shell, so every rule
// is testable without Electron (test/link-open.test.ts).
const fs = require('node:fs')
const path = require('node:path')

const MAX_URL_LENGTH = 8192
const MAX_PATH_LENGTH = 4096
const CONTROL_RE = /[\u0000-\u001f\u007f]/

// Lowercased, without the dot. Never opened, whatever app claims them: they
// run code, install something, or open something else in their place.
const BLOCKED_EXTENSIONS = new Set([
  // apps, bundles, plug-ins and launchers
  'action', 'app', 'appex', 'bundle', 'caction', 'command', 'component', 'framework', 'kext', 'mdimporter', 'osax',
  'plugin', 'prefpane', 'qlgenerator', 'saver', 'shortcut', 'systemextension', 'term', 'terminal', 'tool', 'wdgt',
  'widget', 'workflow', 'xpc', 'alfredworkflow',
  // files that open something else: locations, shortcuts, profiles
  'afploc', 'atloc', 'configprofile', 'desktop', 'fileloc', 'ftploc', 'inetloc', 'lnk', 'mailloc', 'mobileconfig',
  'mobileprovision', 'newsloc', 'provisionprofile', 'url', 'vncloc', 'webarchive', 'webloc',
  // installers, packages and disk images
  'apk', 'appimage', 'appx', 'appxbundle', 'crx', 'deb', 'dmg', 'flatpak', 'flatpakref', 'flatpakrepo', 'img', 'ipa',
  'iso', 'jnlp', 'mpkg', 'msi', 'msix', 'msixbundle', 'msp', 'pkg', 'rpm', 'run', 'safariextz', 'snap',
  'sparsebundle', 'sparseimage', 'vsix', 'xpi',
  // executables and libraries
  'bin', 'com', 'cpl', 'dll', 'dylib', 'elf', 'exe', 'gadget', 'jar', 'msc', 'pif', 'scr', 'so', 'sys',
  // scripts
  'applescript', 'application', 'appref-ms', 'bash', 'bat', 'cmd', 'csh', 'fish', 'hta', 'inf', 'jse', 'ksh', 'lua',
  'php', 'pl', 'ps1', 'psd1', 'psm1', 'py', 'pyc', 'pyo', 'pyw', 'pyz', 'pyzw', 'rb', 'reg', 'scf', 'scpt', 'scptd',
  'sh', 'tcl', 'tcsh', 'vb', 'vbe', 'vbs', 'ws', 'wsc', 'wsf', 'wsh', 'zsh',
  // documents that carry macros
  'docm', 'dotm', 'potm', 'ppam', 'ppsm', 'pptm', 'sldm', 'xlam', 'xll', 'xlsm', 'xltm',
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

function blockedFileName(value) {
  const ext = path.extname(String(value)).slice(1).toLowerCase()
  return ext !== '' && BLOCKED_EXTENSIONS.has(ext)
}

function failureReason(err) {
  const code = err && err.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  if (code === 'EACCES' || code === 'EPERM') return 'inaccessible'
  if (code === 'ELOOP' || code === 'ENAMETOOLONG') return 'invalid'
  return 'failed'
}

// What main may do with a path: open it, only reveal it (and why), or nothing.
async function fileOpenPlan(value, { homeDir, fsp = fs.promises } = {}) {
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
  // realpath leaves no link behind; one here means the path changed under us
  if (stats.isSymbolicLink()) return { ok: false, reason: 'invalid' }
  if (stats.isDirectory()) return { ok: true, action: 'reveal', path: resolved, reason: /\.app$/i.test(resolved) ? 'app' : 'folder' }
  if (!stats.isFile()) return { ok: true, action: 'reveal', path: resolved, reason: 'special' }
  if (blockedFileName(normalized) || blockedFileName(resolved)) return { ok: true, action: 'reveal', path: resolved, reason: 'blocked' }
  if ((stats.mode & 0o111) !== 0) return { ok: true, action: 'reveal', path: resolved, reason: 'executable' }
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
  if (value.kind === 'file' && keysOf(value) === 'kind,path,reveal' && typeof value.path === 'string' && typeof value.reveal === 'boolean') {
    return { kind: 'file', path: value.path, reveal: value.reveal }
  }
  return null
}

// Never rejects: the renderer gets { ok, action?, reason? } and says what
// happened.
async function openLinkRequest(raw, { shell, homeDir, fsp } = {}) {
  const request = linkRequest(raw)
  if (!request) return { ok: false, reason: 'invalid' }
  try {
    if (request.kind === 'web') {
      const href = externalWebUrl(request.url)
      if (!href) return { ok: false, reason: 'invalid' }
      await shell.openExternal(href)
      return { ok: true, action: 'opened' }
    }
    const plan = await fileOpenPlan(request.path, { homeDir, fsp })
    if (!plan.ok) return { ok: false, reason: plan.reason }
    if (request.reveal || plan.action === 'reveal') {
      shell.showItemInFolder(plan.path)
      return { ok: true, action: 'revealed', reason: request.reveal ? 'requested' : plan.reason }
    }
    const error = await shell.openPath(plan.path)
    return error ? { ok: false, reason: 'failed' } : { ok: true, action: 'opened' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

// The update channel's sender check, the strictest one main has that does not
// depend on install ownership: the exact webContents of the app's one viewer
// window, still alive, whose sending frame is on the viewer's origin. A link
// request must also come from that window's top frame. Opening a link never
// runs code (main only reveals what could), so it does not need the install
// path's ownership proof, and links keep working in a reused viewer.
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
  linkRequest,
  normalizeLocalPath,
  openLinkRequest,
  openWebLink,
}
