// The UI is English-only, but every package used to carry Chromium's UI
// strings in 55 languages, about 48 MB (#292, from the #281 audit's Q4): 220
// .lproj folders in Electron Framework and 55 empty ones in the app's own
// Resources on macOS, 55 locales/*.pak files on Linux and Windows. The
// thin-app builders keep only US and British English before anything checks,
// hashes or signs the app (British so British and Commonwealth users keep
// their date formats), and the gates refuse an app that ships any other
// locale or lacks either English one.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PruneElectronLocalesError,
  assertEnglishOnlyElectronLocales,
  pruneElectronLocales,
} from '../scripts/prune-electron-locales.mjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(removeScratchDirs)

// null makes an empty directory
function writeTree(root: string, files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      mkdirSync(join(root, path), { recursive: true })
      continue
    }
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

function listEntries(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const rel = relative(root, path).split(sep).join('/')
      if (entry.isDirectory()) {
        if (readdirSync(path).length === 0) out.push(`${rel}/`)
        visit(path)
      } else {
        out.push(entry.isSymbolicLink() ? `${rel} -> ${readlinkSync(path)}` : rel)
      }
    }
  }
  visit(root)
  return out.sort()
}

const FRAMEWORK = 'Contents/Frameworks/Electron Framework.framework'
const FRAMEWORK_RESOURCES = `${FRAMEWORK}/Versions/A/Resources`

// The layout @electron/packager leaves, trimmed: each language in the
// framework comes with three grammatical-gender variants.
const MAC_APP: Record<string, string | null> = {
  'Contents/Info.plist': '<plist/>\n',
  'Contents/MacOS/Agent Inbox': 'Mach-O\n',
  'Contents/Resources/icon.icns': 'icon\n',
  'Contents/Resources/LICENSES.chromium.html': 'notices\n',
  'Contents/Resources/en.lproj': null,
  'Contents/Resources/en_GB.lproj': null,
  'Contents/Resources/fr.lproj': null,
  'Contents/Resources/zh_TW.lproj': null,
  'Contents/Resources/app/package.json': '{}\n',
  // the app's own code is never touched, whatever it holds
  'Contents/Resources/app/node_modules/some-package/fr.lproj/strings.json': '{}\n',
  'Contents/Resources/app/runtime/darwin-arm64/bin/node': 'Mach-O\n',
  [`${FRAMEWORK}/Versions/A/Electron Framework`]: 'Mach-O\n',
  [`${FRAMEWORK_RESOURCES}/Info.plist`]: '<plist/>\n',
  [`${FRAMEWORK_RESOURCES}/MainMenu.nib`]: 'nib\n',
  [`${FRAMEWORK_RESOURCES}/resources.pak`]: 'resources\n',
  [`${FRAMEWORK_RESOURCES}/icudtl.dat`]: 'icu\n',
  [`${FRAMEWORK_RESOURCES}/en.lproj/locale.pak`]: 'English\n',
  [`${FRAMEWORK_RESOURCES}/en_FEMININE.lproj/locale.pak`]: 'English, feminine\n',
  [`${FRAMEWORK_RESOURCES}/en_GB.lproj/locale.pak`]: 'British English\n',
  [`${FRAMEWORK_RESOURCES}/en_GB_NEUTER.lproj/locale.pak`]: 'British English, neuter\n',
  [`${FRAMEWORK_RESOURCES}/fr.lproj/locale.pak`]: 'French\n',
  [`${FRAMEWORK_RESOURCES}/fr_MASCULINE.lproj/locale.pak`]: 'French, masculine\n',
  [`${FRAMEWORK_RESOURCES}/zh_TW.lproj/locale.pak`]: 'Traditional Chinese\n',
  // A localized helper: no Electron ships one today, and it would go too.
  'Contents/Frameworks/Agent Inbox Helper.app/Contents/Resources/de.lproj/InfoPlist.strings': 'German\n',
  'Contents/Frameworks/Agent Inbox Helper.app/Contents/MacOS/Agent Inbox Helper': 'Mach-O\n',
}

function macApp(extra: Record<string, string | null> = {}): string {
  const app = join(scratchDir('locales-mac-'), 'Agent Inbox.app')
  writeTree(app, { ...MAC_APP, ...extra })
  symlinkSync('A', join(app, FRAMEWORK, 'Versions', 'Current'), 'dir')
  for (const name of ['Electron Framework', 'Resources']) {
    symlinkSync(`Versions/Current/${name}`, join(app, FRAMEWORK, name))
  }
  return app
}

const FOLDER_APP: Record<string, string | null> = {
  'Agent Inbox': 'ELF\n',
  'Agent Inbox.exe': 'PE\n',
  'resources.pak': 'resources\n',
  'chrome_100_percent.pak': 'images\n',
  'icudtl.dat': 'icu\n',
  'locales/en-US.pak': 'English\n',
  'locales/en-GB.pak': 'British English\n',
  // no Chromium release ships this pseudo-locale; any English but the two goes
  'locales/en-XA.pak': 'Pseudo-English\n',
  'locales/fr.pak': 'French\n',
  'locales/zh-TW.pak': 'Traditional Chinese\n',
  'resources/app/package.json': '{}\n',
  'resources/app/locales/fr.pak': 'the app\'s own file\n',
}

function folderApp(extra: Record<string, string | null> = {}): string {
  return writeTree(join(scratchDir('locales-folder-'), 'Agent Inbox'), { ...FOLDER_APP, ...extra })
}

const bytes = (...texts: string[]) => texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0)

describe('pruneElectronLocales (#292)', () => {
  it('keeps en.lproj and en_GB.lproj across a macOS bundle, wherever a locale sits outside the app\'s own code', () => {
    const app = macApp({ 'Contents/Resources/Base.lproj/MainMenu.nib': 'nib\n' })

    const result = pruneElectronLocales(app, 'darwin')

    expect(listEntries(app)).toEqual([
      'Contents/Frameworks/Agent Inbox Helper.app/Contents/MacOS/Agent Inbox Helper',
      'Contents/Frameworks/Agent Inbox Helper.app/Contents/Resources/',
      `${FRAMEWORK}/Electron Framework -> Versions/Current/Electron Framework`,
      `${FRAMEWORK}/Resources -> Versions/Current/Resources`,
      `${FRAMEWORK}/Versions/A/Electron Framework`,
      `${FRAMEWORK_RESOURCES}/Info.plist`,
      `${FRAMEWORK_RESOURCES}/MainMenu.nib`,
      `${FRAMEWORK_RESOURCES}/en.lproj/locale.pak`,
      `${FRAMEWORK_RESOURCES}/en_GB.lproj/locale.pak`,
      `${FRAMEWORK_RESOURCES}/icudtl.dat`,
      `${FRAMEWORK_RESOURCES}/resources.pak`,
      `${FRAMEWORK}/Versions/Current -> A`,
      'Contents/Info.plist',
      'Contents/MacOS/Agent Inbox',
      'Contents/Resources/Base.lproj/MainMenu.nib',
      'Contents/Resources/LICENSES.chromium.html',
      'Contents/Resources/app/node_modules/some-package/fr.lproj/strings.json',
      'Contents/Resources/app/package.json',
      'Contents/Resources/app/runtime/darwin-arm64/bin/node',
      'Contents/Resources/en.lproj/',
      'Contents/Resources/en_GB.lproj/',
      'Contents/Resources/icon.icns',
    ])
    // two empty app folders, five framework locales (the gender variants
    // included) and the helper's
    expect(result).toEqual({
      removedLocales: 8,
      removedBytes: bytes(
        'English, feminine\n', 'British English, neuter\n', 'French\n', 'French, masculine\n',
        'Traditional Chinese\n', 'German\n',
      ),
    })
    expect(pruneElectronLocales(app, 'darwin')).toEqual({ removedLocales: 0, removedBytes: 0 })
  })

  it.each(['linux', 'win32'] as const)('keeps only locales/en-US.pak and en-GB.pak in a %s folder', (platform) => {
    const app = folderApp()

    const result = pruneElectronLocales(app, platform)

    expect(listEntries(app)).toEqual([
      'Agent Inbox',
      'Agent Inbox.exe',
      'chrome_100_percent.pak',
      'icudtl.dat',
      'locales/en-GB.pak',
      'locales/en-US.pak',
      'resources.pak',
      'resources/app/locales/fr.pak',
      'resources/app/package.json',
    ])
    expect(result).toEqual({
      removedLocales: 3,
      removedBytes: bytes('Pseudo-English\n', 'French\n', 'Traditional Chinese\n'),
    })
    expect(pruneElectronLocales(app, platform)).toEqual({ removedLocales: 0, removedBytes: 0 })
  })

  it('refuses, before removing anything, an app without US or British English', () => {
    const US = 'the US English locale Chromium falls back to'
    const GB = 'the British English locale Commonwealth users get'
    const cases: Array<[string, () => string, 'darwin' | 'linux' | 'win32', string]> = [
      ['no app en.lproj', () => {
        const app = macApp()
        rmSync(join(app, 'Contents/Resources/en.lproj'), { recursive: true })
        return app
      }, 'darwin', `has no Contents/Resources/en.lproj, ${US}`],
      ['no app en_GB.lproj', () => {
        const app = macApp()
        rmSync(join(app, 'Contents/Resources/en_GB.lproj'), { recursive: true })
        return app
      }, 'darwin', `has no Contents/Resources/en_GB.lproj, ${GB}`],
      ['an app en_GB.lproj that is a file', () => {
        const app = macApp()
        rmSync(join(app, 'Contents/Resources/en_GB.lproj'), { recursive: true })
        writeFileSync(join(app, 'Contents/Resources/en_GB.lproj'), '')
        return app
      }, 'darwin', `has no Contents/Resources/en_GB.lproj, ${GB}`],
      ['no framework en.lproj', () => {
        const app = macApp()
        rmSync(join(app, FRAMEWORK_RESOURCES, 'en.lproj'), { recursive: true })
        return app
      }, 'darwin', `has no ${FRAMEWORK_RESOURCES}/en.lproj/locale.pak, ${US}`],
      ['no framework en_GB.lproj', () => {
        const app = macApp()
        rmSync(join(app, FRAMEWORK_RESOURCES, 'en_GB.lproj'), { recursive: true })
        return app
      }, 'darwin', `has no ${FRAMEWORK_RESOURCES}/en_GB.lproj/locale.pak, ${GB}`],
      ['an empty British pak', () => macApp({ [`${FRAMEWORK_RESOURCES}/en_GB.lproj/locale.pak`]: '' }), 'darwin',
        `has no ${FRAMEWORK_RESOURCES}/en_GB.lproj/locale.pak, ${GB}`],
      ['no en-US.pak', () => {
        const app = folderApp()
        rmSync(join(app, 'locales/en-US.pak'))
        return app
      }, 'linux', `has no locales/en-US.pak, ${US}`],
      ['no en-GB.pak', () => {
        const app = folderApp()
        rmSync(join(app, 'locales/en-GB.pak'))
        return app
      }, 'win32', `has no locales/en-GB.pak, ${GB}`],
      ['an empty en-US.pak', () => folderApp({ 'locales/en-US.pak': '' }), 'linux', `has no locales/en-US.pak, ${US}`],
      ['an en-GB.pak folder', () => {
        const app = folderApp()
        rmSync(join(app, 'locales/en-GB.pak'))
        writeTree(app, { 'locales/en-GB.pak/locale.pak': 'British English\n' })
        return app
      }, 'win32', `has no locales/en-GB.pak, ${GB}`],
    ]
    for (const [name, make, platform, message] of cases) {
      const app = make()
      const before = listEntries(app)
      expect(() => pruneElectronLocales(app, platform), name).toThrow(PruneElectronLocalesError)
      expect(() => pruneElectronLocales(app, platform), name).toThrow(`packaged ${platform} app ${message}; review`)
      expect(listEntries(app), name).toEqual(before)
    }
  })

  it('removes a linked locale without following it, and never descends through a link', () => {
    const outside = writeTree(scratchDir('locales-outside-'), {
      'fr.lproj/locale.pak': 'French\n',
      'linked/de.lproj/locale.pak': 'German\n',
    })
    const app = macApp()
    symlinkSync(join(outside, 'fr.lproj'), join(app, 'Contents/Resources/nl.lproj'), 'dir')
    symlinkSync(join(outside, 'linked'), join(app, 'Contents/Resources/linked'), 'dir')

    pruneElectronLocales(app, 'darwin')

    expect(lstatSync(join(app, 'Contents/Resources/linked')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(app, 'Contents/Resources/nl.lproj'))).toBe(false)
    expect(readFileSync(join(outside, 'fr.lproj/locale.pak'), 'utf8')).toBe('French\n')
    expect(readFileSync(join(outside, 'linked/de.lproj/locale.pak'), 'utf8')).toBe('German\n')
  })

  it('refuses an unknown platform', () => {
    expect(() => pruneElectronLocales(folderApp(), 'freebsd' as 'linux')).toThrow('unsupported Electron platform: freebsd')
  })
})

describe('assertEnglishOnlyElectronLocales (#292)', () => {
  it('names the locales a macOS bundle still ships, then passes once it is pruned', () => {
    const app = macApp()
    expect(() => assertEnglishOnlyElectronLocales(app, 'darwin', 'packaged darwin-arm64 app')).toThrow(
      'packaged darwin-arm64 app ships 8 Electron locales besides US and British English (#292): '
        + 'Contents/Frameworks/Agent Inbox Helper.app/Contents/Resources/de.lproj, '
        + `${FRAMEWORK_RESOURCES}/en_FEMININE.lproj, ${FRAMEWORK_RESOURCES}/en_GB_NEUTER.lproj, `
        + `${FRAMEWORK_RESOURCES}/fr.lproj, ${FRAMEWORK_RESOURCES}/fr_MASCULINE.lproj, `
        + `${FRAMEWORK_RESOURCES}/zh_TW.lproj, Contents/Resources/fr.lproj, Contents/Resources/zh_TW.lproj`,
    )
    pruneElectronLocales(app, 'darwin')
    expect(() => assertEnglishOnlyElectronLocales(app, 'darwin', 'packaged darwin-arm64 app')).not.toThrow()
  })

  it('counts what it does not name', () => {
    const extra = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`locales/x${String(index).padStart(2, '0')}.pak`, 'x\n']))
    const app = folderApp(extra)
    expect(() => assertEnglishOnlyElectronLocales(app, 'linux', 'packaged Linux app')).toThrow(
      /^packaged Linux app ships 33 Electron locales besides US and British English \(#292\): locales\/en-XA\.pak, locales\/fr\.pak, locales\/x00\.pak, .*, and 13 more$/,
    )
  })

  // A folder is walked before a sibling whose name it prefixes, which path
  // order puts first ('-' sorts before '/').
  it('names them in path order, whatever order the walk finds them in', () => {
    const app = macApp({ 'Contents/Resources/x/de.lproj': null, 'Contents/Resources/x-de.lproj': null })
    expect(() => assertEnglishOnlyElectronLocales(app, 'darwin', 'app')).toThrow(
      'Contents/Resources/fr.lproj, Contents/Resources/x-de.lproj, Contents/Resources/x/de.lproj, '
        + 'Contents/Resources/zh_TW.lproj',
    )
  })

  it.each(['linux', 'win32'] as const)('passes a pruned %s folder and refuses one that lost either English pak', (platform) => {
    for (const [pak, why] of [
      ['en-US.pak', 'the US English locale Chromium falls back to'],
      ['en-GB.pak', 'the British English locale Commonwealth users get'],
    ]) {
      const app = folderApp()
      pruneElectronLocales(app, platform)
      expect(() => assertEnglishOnlyElectronLocales(app, platform, 'packaged app')).not.toThrow()
      rmSync(join(app, 'locales', pak!))
      expect(() => assertEnglishOnlyElectronLocales(app, platform, 'packaged app')).toThrow(
        `packaged app has no locales/${pak}, ${why} (#292)`,
      )
    }
  })

  it('refuses a pruned bundle that no longer tells macOS it speaks US or British English', () => {
    for (const [folder, why] of [
      ['en.lproj', 'the US English locale Chromium falls back to'],
      ['en_GB.lproj', 'the British English locale Commonwealth users get'],
    ]) {
      const app = macApp()
      pruneElectronLocales(app, 'darwin')
      rmSync(join(app, 'Contents/Resources', folder!), { recursive: true })
      expect(() => assertEnglishOnlyElectronLocales(app, 'darwin', 'universal app')).toThrow(
        `universal app has no Contents/Resources/${folder}, ${why} (#292)`,
      )
    }
  })
})
