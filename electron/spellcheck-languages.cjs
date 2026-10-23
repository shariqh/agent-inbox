'use strict'

// The spellchecker's languages on Linux and Windows (#292).
//
// Electron seeds a new profile's Hunspell languages from the app locale: its
// browser context takes GetCorrespondingSpellCheckLanguage of ICU's default
// locale, which Chromium sets to the app locale at startup. Only US and
// British English ship now (#292), so a French or German system would get an
// English dictionary, and the reply boxes check spelling by default. At
// startup the app points the spellchecker at the system's languages when the
// profile has none in the system's first language. A profile that has is left
// alone: Chromium gives New Zealand, Indian and other Commonwealth English
// users the en-GB locale and so seeds en-GB, while it has no dictionary for
// their own variants and its bare en is the en-US one.
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

const normalize = (language) => (typeof language === 'string' ? language.trim().replaceAll('_', '-').toLowerCase() : '')
const baseOf = (tag) => tag.split('-')[0]

/**
 * Chromium's spellchecker codes for the system's languages, in their order:
 * for each, the available code it matches exactly (ignoring case and `_`
 * against `-`), else that of a later entry of the same language (en_NZ:en_GB
 * lists en-GB after en-NZ), else that of its base language. One per base
 * language, so `fr-FR` and `fr` load one French dictionary, and at most three.
 */
function spellcheckLanguagesFor(preferred, available) {
  const codes = new Map()
  for (const code of Array.isArray(available) ? available : []) {
    if (typeof code === 'string') codes.set(code.toLowerCase(), code)
  }
  const tags = (Array.isArray(preferred) ? preferred : []).map(normalize)
  const chosen = []
  const bases = new Set()
  for (const [index, tag] of tags.entries()) {
    if (chosen.length === MAX_LANGUAGES) break
    const base = baseOf(tag)
    if (!base || bases.has(base)) continue
    const later = tags.slice(index + 1).find((other) => other !== base && baseOf(other) === base && codes.has(other))
    const code = codes.get(tag) ?? codes.get(later) ?? codes.get(base)
    if (code === undefined) continue
    chosen.push(code)
    bases.add(base)
  }
  return chosen
}

function firstBase(preferred) {
  for (const language of Array.isArray(preferred) ? preferred : []) {
    const base = baseOf(normalize(language))
    if (base) return base
  }
  return ''
}

function sameLanguages(current, languages) {
  return current.length === languages.length && current.every((code, index) => code === languages[index])
}

/**
 * On Linux and Windows, when none of the session's spellchecker languages is
 * in the system's first language, set them to the system's languages, if
 * that differs and is not none. Returns what it set, or null.
 */
function syncSpellcheckLanguages({ platform, app, session }) {
  if (!PLATFORMS.has(platform)) return null
  const preferred = app.getPreferredSystemLanguages()
  const first = firstBase(preferred)
  const current = session.getSpellCheckerLanguages()
  if (current.some((code) => baseOf(normalize(code)) === first)) return null
  const languages = spellcheckLanguagesFor(preferred, session.availableSpellCheckerLanguages)
  if (languages.length === 0 || sameLanguages(current, languages)) return null
  session.setSpellCheckerLanguages(languages)
  return languages
}

module.exports = { spellcheckLanguagesFor, syncSpellcheckLanguages }
