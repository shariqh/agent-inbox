// Electron seeds a new profile's Hunspell languages from the app locale, and
// once only US and British English ship (#292) that locale is English on a
// French or German system too. On Linux and Windows the app now points the
// spellchecker at the system's languages at startup; macOS keeps its own
// spellchecker, which the app locale never chose.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import spellcheck from '../electron/spellcheck-languages.cjs'

const { spellcheckLanguagesFor, syncSpellcheckLanguages } = spellcheck

// session.availableSpellCheckerLanguages in Electron 43 (Chromium's
// kSupportedSpellCheckerLanguages, in its order).
const AVAILABLE = [
  'af', 'bg', 'ca', 'cs', 'cy', 'da', 'de', 'de-DE', 'el', 'en', 'en-AU', 'en-CA', 'en-GB',
  'en-GB-oxendict', 'en-US', 'es', 'es-419', 'es-AR', 'es-ES', 'es-MX', 'es-US', 'et', 'fa', 'fo',
  'fr', 'fr-FR', 'gl', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'it', 'it-IT', 'ko', 'lt', 'lv', 'nb',
  'nl', 'pl', 'pt', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sh', 'sk', 'sl', 'sq', 'sr', 'sv', 'ta', 'tg',
  'tr', 'uk', 'vi',
]

// app.getPreferredSystemLanguages() in Electron 43 on Linux, by LANG (and
// LANGUAGE): GLib's variants of each entry, with any encoding dropped.
const LINUX = {
  fr_FR: ['fr-FR', 'fr-FR', 'fr', 'fr'],
  en_GB: ['en-GB', 'en-GB', 'en', 'en'],
  en_NZ: ['en-NZ', 'en-NZ', 'en', 'en'],
  en_IN: ['en-IN', 'en-IN', 'en', 'en'],
  en_NZ_en_GB_en: ['en-NZ', 'en', 'en-GB', 'en', 'en'],
  fr_CA_en_CA: ['fr-CA', 'fr', 'en-CA', 'en'],
}

describe('spellcheckLanguagesFor (#292)', () => {
  it('takes the exact language first, then the base language', () => {
    expect(spellcheckLanguagesFor(['pt-PT'], AVAILABLE)).toEqual(['pt-PT'])
    expect(spellcheckLanguagesFor(['fr-CA'], AVAILABLE)).toEqual(['fr'])
    expect(spellcheckLanguagesFor(['de-CH'], AVAILABLE)).toEqual(['de'])
  })

  // Chromium has no dictionary for en-NZ, en-IN or en-ZA, and its bare en is
  // the en-US one.
  it('prefers a later dictionary of the same language to the bare base', () => {
    expect(spellcheckLanguagesFor(LINUX.en_NZ_en_GB_en, AVAILABLE)).toEqual(['en-GB'])
    // LANGUAGE=en_NZ:en_IN:en_GB: en-IN has no dictionary either
    expect(spellcheckLanguagesFor(['en-NZ', 'en', 'en-IN', 'en', 'en-GB', 'en'], AVAILABLE)).toEqual(['en-GB'])
    expect(spellcheckLanguagesFor(['fr-CA', 'fr-FR', 'en-US'], AVAILABLE)).toEqual(['fr-FR', 'en-US'])
    expect(spellcheckLanguagesFor(['pt-AO', 'pt', 'pt-PT'], AVAILABLE)).toEqual(['pt-PT'])
    expect(spellcheckLanguagesFor(['en-NZ', 'fr-FR', 'en-GB'], AVAILABLE)).toEqual(['en-GB', 'fr-FR'])
    expect(spellcheckLanguagesFor(LINUX.en_NZ, AVAILABLE)).toEqual(['en'])
  })

  it('keeps the system order, one dictionary per language', () => {
    expect(spellcheckLanguagesFor(LINUX.fr_FR, AVAILABLE)).toEqual(['fr-FR'])
    expect(spellcheckLanguagesFor(['de-DE', 'en-GB', 'en-US', 'en'], AVAILABLE)).toEqual(['de-DE', 'en-GB'])
    expect(spellcheckLanguagesFor(['fr-CA', 'en-CA'], AVAILABLE)).toEqual(['fr', 'en-CA'])
  })

  it('matches regardless of case or an underscore', () => {
    expect(spellcheckLanguagesFor(['EN_gb'], AVAILABLE)).toEqual(['en-GB'])
    expect(spellcheckLanguagesFor(['es_mx'], AVAILABLE)).toEqual(['es-MX'])
  })

  it('skips languages Chromium has no dictionary for, without letting them block a later one', () => {
    expect(spellcheckLanguagesFor(['ja-JP', 'zh-Hans-CN', 'fi', 'sv-SE'], AVAILABLE)).toEqual(['sv'])
    expect(spellcheckLanguagesFor(['ja-JP'], AVAILABLE)).toEqual([])
  })

  it('stops at three languages', () => {
    expect(spellcheckLanguagesFor(['fr-FR', 'de-DE', 'es-ES', 'it-IT'], AVAILABLE)).toEqual(['fr-FR', 'de-DE', 'es-ES'])
  })

  it('ignores what is not a language', () => {
    expect(spellcheckLanguagesFor([null, '', ' ', 42, '-', 'fr'], AVAILABLE)).toEqual(['fr'])
    expect(spellcheckLanguagesFor(undefined, AVAILABLE)).toEqual([])
    expect(spellcheckLanguagesFor(['fr'], undefined)).toEqual([])
    expect(spellcheckLanguagesFor(['fr'], [null, 'fr'])).toEqual(['fr'])
  })
})

function fakes(preferred: string[], current: string[]) {
  const set: string[][] = []
  const app = { getPreferredSystemLanguages: () => preferred }
  const session = {
    availableSpellCheckerLanguages: AVAILABLE,
    getSpellCheckerLanguages: () => current,
    setSpellCheckerLanguages: (languages: string[]) => {
      set.push(languages)
    },
  }
  return { app, session, set }
}

describe('syncSpellcheckLanguages (#292)', () => {
  it.each(['linux', 'win32'])('points a new %s profile seeded with English at the system language', (platform) => {
    const { app, session, set } = fakes(LINUX.fr_FR, ['en-US'])

    expect(syncSpellcheckLanguages({ platform, app, session })).toEqual(['fr-FR'])
    expect(set).toEqual([['fr-FR']])
  })

  // Chromium gives New Zealand, Indian and other Commonwealth English users
  // the en-GB locale, so Electron seeds en-GB; matching their own languages
  // would turn that into en, the US dictionary.
  it('leaves a profile alone that already checks the first system language', () => {
    for (const [preferred, current] of [
      [LINUX.en_NZ, ['en-GB']],
      [LINUX.en_IN, ['en-GB']],
      [LINUX.en_NZ_en_GB_en, ['en-GB']],
      [LINUX.en_GB, ['en-GB']],
      [['en-US', 'en'], ['en-US']],
      [LINUX.fr_FR, ['fr']],
      [['fr-CA', 'en-CA'], ['fr']],
      [['fr-FR', 'en-US'], ['en-US', 'fr-FR']],
    ]) {
      const { app, session, set } = fakes(preferred!, current!)
      expect(syncSpellcheckLanguages({ platform: 'linux', app, session }), preferred!.join()).toBeNull()
      expect(set).toEqual([])
    }
  })

  it('follows a system that changed language', () => {
    for (const [preferred, current, languages] of [
      [LINUX.fr_FR, ['en-GB'], ['fr-FR']],
      [LINUX.en_NZ_en_GB_en, ['fr-FR'], ['en-GB']],
      [['fr-CA', 'en-CA'], ['en-US'], ['fr', 'en-CA']],
      // Chromium gives this one the en-GB locale, from en_CA
      [LINUX.fr_CA_en_CA, ['en-GB'], ['fr', 'en-CA']],
    ]) {
      const { app, session, set } = fakes(preferred!, current!)
      expect(syncSpellcheckLanguages({ platform: 'win32', app, session }), preferred!.join()).toEqual(languages)
      expect(set).toEqual([languages])
    }
  })

  it('judges by the first entry that is a language', () => {
    const kept = fakes([null, ' ', 'en-IN', 'fr-FR'] as never, ['en-GB'])
    expect(syncSpellcheckLanguages({ platform: 'linux', app: kept.app, session: kept.session })).toBeNull()
    expect(kept.set).toEqual([])

    const switched = fakes([null, ' ', 'fr-FR', 'en-US'] as never, ['en-US'])
    expect(syncSpellcheckLanguages({ platform: 'linux', app: switched.app, session: switched.session })).toEqual(['fr-FR', 'en-US'])
  })

  // With no dictionary for the first system language there is nothing to
  // keep, so the profile follows the others, but only a list that differs is
  // written.
  it('writes only a list that differs when the first system language has no dictionary', () => {
    for (const [preferred, current, writes] of [
      [['ja-JP', 'en-US'], ['en-US'], []],
      [['ja-JP', 'en-US', 'fr-FR'], ['en-US', 'fr-FR'], []],
      [['ja-JP', 'en-US', 'fr-FR'], ['en-US'], [['en-US', 'fr-FR']]],
      [['ja-JP', 'en-US', 'fr-FR'], ['fr-FR', 'en-US'], [['en-US', 'fr-FR']]],
      [['ja-JP', 'en-US', 'fr-FR'], ['en-US', 'fr-FR', 'de'], [['en-US', 'fr-FR']]],
    ] as Array<[string[], string[], string[][]]>) {
      const { app, session, set } = fakes(preferred, current)
      syncSpellcheckLanguages({ platform: 'linux', app, session })
      expect(set, current.join()).toEqual(writes)
    }
  })

  it('never clears the languages when no system language has a dictionary', () => {
    const { app, session, set } = fakes(['ja-JP', 'ja'], ['en-US'])

    expect(syncSpellcheckLanguages({ platform: 'linux', app, session })).toBeNull()
    expect(set).toEqual([])
  })

  it('leaves macOS to its own spellchecker', () => {
    const untouched = new Proxy({}, {
      get(_target, name) {
        throw new Error(`read ${String(name)} on macOS`)
      },
    }) as never

    expect(syncSpellcheckLanguages({ platform: 'darwin', app: untouched, session: untouched })).toBeNull()
  })
})

describe('Electron main wiring (#292)', () => {
  const main = readFileSync(join(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')

  it('sets the spellchecker languages before the first window, without stopping startup on a failure', () => {
    expect(main).toContain("const { syncSpellcheckLanguages } = require('./spellcheck-languages.cjs')")
    const ready = main.slice(main.indexOf('app.whenReady().then(async () => {'))
    const sync = ready.indexOf('syncSpellcheckLanguages({ platform: process.platform, app, session: session.defaultSession })')
    expect(sync).toBeGreaterThan(0)
    expect(sync).toBeLessThan(ready.indexOf('const win = createWindow()'))
    expect(ready.slice(0, sync)).toMatch(/try \{\s*$/)
    expect(ready.slice(sync)).toMatch(
      /^syncSpellcheckLanguages\(\{[^}]*\}\)\s*\} catch \(err\) \{\s*console\.error\(`\[agent-inbox\] could not set the spellchecker's languages: \$\{err\.message\}`\)\s*\}/,
    )
  })
})
