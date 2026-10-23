// Ship only the US and British English Electron locales (#292).
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
// US and British English stay: en.lproj and en_GB.lproj (and Base.lproj,
// should Electron ever ship one) on macOS, locales/en-US.pak and en-GB.pak on
// Linux and Windows. Chromium's locale is also the default for the dates the
// app formats, so British and Commonwealth users keep theirs, and every other
// language gets US English.
//
// - macOS picks the app's language from the app's own .lproj folders, and
//   Chromium follows that choice (l10n_util::OverrideLocaleWithCocoaLocale).
// - Linux and Windows try the user's languages, map Commonwealth English to
//   en-GB, and fall back to en-US when no pak matches (l10n_util.cc).
//
// The prune refuses, before removing anything, an app missing either English
// locale, and the gate refuses an app that lacks one or ships any other. Node
// core only. Links are never followed, and the app's own code
// (Contents/Resources/app) is never touched.
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export class PruneElectronLocalesError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PruneElectronLocalesError'
  }
}

const PLATFORMS = ['darwin', 'linux', 'win32']
const MAC_KEPT = new Set(['en.lproj', 'en_GB.lproj', 'Base.lproj'])
const PAK_KEPT = new Set(['en-US.pak', 'en-GB.pak'])
const MAC_APP_CODE = ['Contents', 'Resources', 'app']
const FRAMEWORK_RESOURCES = ['Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources']
const US = 'the US English locale Chromium falls back to'
const GB = 'the British English locale Commonwealth users get'
// What each English locale needs, in the order a missing one is reported:
// on macOS a folder that declares it in the app and the framework's pak.
const REQUIRED = {
  darwin: [
    { path: ['Contents', 'Resources', 'en.lproj'], folder: true, why: US },
    { path: ['Contents', 'Resources', 'en_GB.lproj'], folder: true, why: GB },
    { path: [...FRAMEWORK_RESOURCES, 'en.lproj', 'locale.pak'], why: US },
    { path: [...FRAMEWORK_RESOURCES, 'en_GB.lproj', 'locale.pak'], why: GB },
  ],
  paks: [
    { path: ['locales', 'en-US.pak'], why: US },
    { path: ['locales', 'en-GB.pak'], why: GB },
  ],
}

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

// Every locale the bundle ships besides US and British English, wherever it sits.
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
  return readdirSync(locales).filter((name) => !PAK_KEPT.has(name)).map((name) => join(locales, name))
}

// What would go, without removing anything.
function planPrune(app, platform) {
  const remove = platform === 'darwin' ? planMac(app) : planPaks(app)
  return remove.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function englishProblem(app, platform) {
  for (const { path, folder, why } of REQUIRED[platform === 'darwin' ? 'darwin' : 'paks']) {
    const stat = lstatOrNull(join(app, ...path))
    const present = folder ? stat?.isDirectory() : stat?.isFile() && stat.size > 0
    if (!present) return `has no ${path.join('/')}, ${why}`
  }
  return null
}

/**
 * Remove every Electron locale but US and British English from a packaged app
 * (a macOS bundle, or a Linux or Windows folder) in place. Returns how many
 * locale folders or paks went and their size in bytes.
 */
export function pruneElectronLocales(app, platform) {
  checkPlatform(platform)
  const problem = englishProblem(app, platform)
  if (problem) {
    throw new PruneElectronLocalesError(
      `packaged ${platform} app ${problem}; review what #292 prunes before shipping it`,
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
 * Refuse a shipped app that carries any Electron locale besides US and
 * British English, or lacks either of them.
 */
export function assertEnglishOnlyElectronLocales(app, platform, label) {
  checkPlatform(platform)
  const problem = englishProblem(app, platform)
  if (problem) throw new PruneElectronLocalesError(`${label} ${problem} (#292)`)
  const remove = planPrune(app, platform)
  if (remove.length === 0) return
  const shown = remove.slice(0, 20).map((path) => posixPath(app, path))
  throw new PruneElectronLocalesError(
    `${label} ships ${remove.length} Electron locales besides US and British English (#292): ${shown.join(', ')}`
      + (remove.length > shown.length ? `, and ${remove.length - shown.length} more` : ''),
  )
}
