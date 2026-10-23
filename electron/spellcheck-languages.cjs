'use strict'

// The spellchecker's languages on Linux and Windows (#292).
//
// Electron seeds a new profile's Hunspell languages from the app locale: its
// browser context takes GetCorrespondingSpellCheckLanguage of ICU's default
// locale, which Chromium sets to the app locale at startup. Only US and
// British English ship now (#292), so a French or German system would get an
// English dictionary, and the reply boxes check spelling by default. At
// startup the app points the spellchecker at the system's languages instead.
//
// macOS is left alone. Its spellchecker is the system's own (NSSpellChecker,
// set in System Settings): Chromium overwrites this preference there with
// that checker's language, and Electron's setSpellCheckerLanguages does
// nothing on macOS.

const PLATFORMS = new Set(['linux', 'win32'])
// Chromium sets no limit, but each language is a separate dictionary to
// download and load, and the first few of a user's languages are the ones
// they write in.
const MAX_LANGUAGES = 3

/**
 * Chromium's spellchecker codes for the system's languages, in their order:
 * for each, the available code it matches exactly (ignoring case and `_`
 * against `-`), else the one for its base language. One per base language,
 * so `fr-FR` and `fr` load one French dictionary, and at most three.
 */
function spellcheckLanguagesFor(preferred, available) {
  const codes = new Map()
  for (const code of Array.isArray(available) ? available : []) {
    if (typeof code === 'string') codes.set(code.toLowerCase(), code)
  }
  const chosen = []
  const bases = new Set()
  for (const language of Array.isArray(preferred) ? preferred : []) {
    if (chosen.length === MAX_LANGUAGES) break
    if (typeof language !== 'string') continue
    const tag = language.trim().replaceAll('_', '-').toLowerCase()
    const base = tag.split('-')[0]
    if (!base || bases.has(base)) continue
    const code = codes.get(tag) ?? codes.get(base)
    if (code === undefined) continue
    chosen.push(code)
    bases.add(base)
  }
  return chosen
}

function sameLanguages(current, languages) {
  return Array.isArray(current)
    && current.length === languages.length
    && current.every((code, index) => code === languages[index])
}

/**
 * On Linux and Windows, set the session's spellchecker languages to the
 * system's when they differ, and never to none. Returns what it set, or null.
 */
function syncSpellcheckLanguages({ platform, app, session }) {
  if (!PLATFORMS.has(platform)) return null
  const languages = spellcheckLanguagesFor(app.getPreferredSystemLanguages(), session.availableSpellCheckerLanguages)
  if (languages.length === 0 || sameLanguages(session.getSpellCheckerLanguages(), languages)) return null
  session.setSpellCheckerLanguages(languages)
  return languages
}

module.exports = { spellcheckLanguagesFor, syncSpellcheckLanguages }
