// Ship only the English Electron locale (#292).
//
// The UI is English-only, but every package carried Chromium's UI strings in
// 55 languages, about 48 MB (the #281 audit's Q4):
//
// - macOS: 220 .lproj folders in Electron Framework.framework's Resources, each
//   holding a locale.pak (every language plus three grammatical-gender
//   variants, which desktop Chromium does not load), and 55 empty .lproj
//   folders in the app's Contents/Resources, which only tell macOS the app
//   speaks those languages.
// - Linux and Windows: 55 locales/*.pak files.
//
// Only English stays: en.lproj (and Base.lproj, should Electron ever ship one)
// on macOS, locales/en-US.pak on Linux and Windows.
//
// - macOS picks the app's language from the app's own .lproj folders, and
//   Chromium follows that choice (l10n_util::OverrideLocaleWithCocoaLocale).
//   With en.lproj alone every user gets en-US: Chromium loads the framework's
//   en.lproj/locale.pak, and AppKit's own strings are English too.
// - Linux and Windows try the user's languages and fall back to en-US when no
//   pak matches (l10n_util.cc, GetApplicationLocaleInternalNonMac).
//
// The prune refuses, before removing anything, an app without the English
// locale Chromium falls back to, and the gate refuses an app that ships that
// locale missing or any other besides it. Node core only. Links are never
// followed, and the app's own code (Contents/Resources/app) is never touched.
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export class PruneElectronLocalesError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PruneElectronLocalesError'
  }
}

const PLATFORMS = ['darwin', 'linux', 'win32']
const MAC_KEPT = new Set(['en.lproj', 'Base.lproj'])
const PAK_KEPT = 'en-US.pak'
const MAC_APP_CODE = ['Contents', 'Resources', 'app']
const MAC_APP_ENGLISH = ['Contents', 'Resources', 'en.lproj']
const MAC_FRAMEWORK_ENGLISH = [
  'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'en.lproj', 'locale.pak',
]

const posixPath = (root, path) => relative(root, path).split(sep).join('/')

function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function treeBytes(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return stat.size
  return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0)
}

function checkPlatform(platform) {
  if (!PLATFORMS.includes(platform)) {
    throw new PruneElectronLocalesError(`unsupported Electron platform: ${platform}`)
  }
}

// Every locale the bundle ships besides English, wherever it sits.
function planMac(app) {
  const remove = []
  const appCode = join(app, ...MAC_APP_CODE)
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name.endsWith('.lproj')) {
        if (!MAC_KEPT.has(entry.name)) remove.push(path)
      } else if (entry.isDirectory() && path !== appCode) {
        visit(path)
      }
    }
  }
  visit(app)
  return remove
}

function planPaks(app) {
  const locales = join(app, 'locales')
  if (!lstatOrNull(locales)?.isDirectory()) return []
  return readdirSync(locales).filter((name) => name !== PAK_KEPT).map((name) => join(locales, name))
}

// What would go, without removing anything.
function planPrune(app, platform) {
  const remove = platform === 'darwin' ? planMac(app) : planPaks(app)
  return remove.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function englishProblem(app, platform) {
  if (platform === 'darwin') {
    if (!lstatOrNull(join(app, ...MAC_APP_ENGLISH))?.isDirectory()) return `has no ${MAC_APP_ENGLISH.join('/')}`
    const pak = lstatOrNull(join(app, ...MAC_FRAMEWORK_ENGLISH))
    return pak?.isFile() && pak.size > 0 ? null : `has no ${MAC_FRAMEWORK_ENGLISH.join('/')}`
  }
  const pak = lstatOrNull(join(app, 'locales', PAK_KEPT))
  return pak?.isFile() && pak.size > 0 ? null : `has no locales/${PAK_KEPT}`
}

/**
 * Remove every Electron locale but English from a packaged app (a macOS
 * bundle, or a Linux or Windows folder) in place. Returns how many locale
 * folders or paks went and their size in bytes.
 */
export function pruneElectronLocales(app, platform) {
  checkPlatform(platform)
  const problem = englishProblem(app, platform)
  if (problem) {
    throw new PruneElectronLocalesError(
      `packaged ${platform} app ${problem}, the locale Chromium falls back to; review what #292 prunes before shipping it`,
    )
  }
  const remove = planPrune(app, platform)
  let removedBytes = 0
  for (const path of remove) {
    removedBytes += treeBytes(path)
    rmSync(path, { recursive: true })
  }
  return { removedLocales: remove.length, removedBytes }
}

/**
 * Refuse a shipped app that carries any Electron locale besides English, or
 * lacks the English one Chromium falls back to.
 */
export function assertEnglishOnlyElectronLocales(app, platform, label) {
  checkPlatform(platform)
  const problem = englishProblem(app, platform)
  if (problem) throw new PruneElectronLocalesError(`${label} ${problem}, the locale Chromium falls back to (#292)`)
  const remove = planPrune(app, platform)
  if (remove.length === 0) return
  const shown = remove.slice(0, 20).map((path) => posixPath(app, path))
  throw new PruneElectronLocalesError(
    `${label} ships ${remove.length} Electron locales besides English (#292): ${shown.join(', ')}`
      + (remove.length > shown.length ? `, and ${remove.length - shown.length} more` : ''),
  )
}
