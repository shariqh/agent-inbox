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

describe('spellcheckLanguagesFor (#292)', () => {
  it('takes the exact language first, then the base language', () => {
    expect(spellcheckLanguagesFor(['pt-PT'], AVAILABLE)).toEqual(['pt-PT'])
    expect(spellcheckLanguagesFor(['fr-CA'], AVAILABLE)).toEqual(['fr'])
    expect(spellcheckLanguagesFor(['de-CH'], AVAILABLE)).toEqual(['de'])
  })

  it('keeps the system order, one dictionary per language', () => {
    // what Electron reports on Linux for LANG=fr_FR.UTF-8
    expect(spellcheckLanguagesFor(['fr-FR', 'fr-FR', 'fr', 'fr'], AVAILABLE)).toEqual(['fr-FR'])
    expect(spellcheckLanguagesFor(['de-DE', 'en-GB', 'en-US', 'en'], AVAILABLE)).toEqual(['de-DE', 'en-GB'])
    expect(spellcheckLanguagesFor(['fr-CA', 'fr-FR', 'en-US'], AVAILABLE)).toEqual(['fr', 'en-US'])
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
    const { app, session, set } = fakes(['fr-FR', 'fr-FR', 'fr', 'fr'], ['en-US'])

    expect(syncSpellcheckLanguages({ platform, app, session })).toEqual(['fr-FR'])
    expect(set).toEqual([['fr-FR']])
  })

  it('leaves the languages alone when they already follow the system', () => {
    for (const [preferred, current] of [
      [['en-GB', 'en-GB', 'en', 'en'], ['en-GB']],
      [['en-US', 'en'], ['en-US']],
      [['fr-CA', 'en-US'], ['fr', 'en-US']],
    ]) {
      const { app, session, set } = fakes(preferred!, current!)
      expect(syncSpellcheckLanguages({ platform: 'linux', app, session })).toBeNull()
      expect(set).toEqual([])
    }
  })

  it('follows the system order', () => {
    const { app, session, set } = fakes(['fr-FR', 'en-US'], ['en-US', 'fr-FR'])

    expect(syncSpellcheckLanguages({ platform: 'win32', app, session })).toEqual(['fr-FR', 'en-US'])
    expect(set).toEqual([['fr-FR', 'en-US']])
  })

  it('adds a language the system gained', () => {
    const { app, session, set } = fakes(['fr-FR', 'en-US'], ['fr-FR'])

    expect(syncSpellcheckLanguages({ platform: 'linux', app, session })).toEqual(['fr-FR', 'en-US'])
    expect(set).toEqual([['fr-FR', 'en-US']])
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
