import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import prefsModule from '../electron/link-preferences.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { createLinkPreferences, createLinkSettings, parseLinkPreferences } = prefsModule

afterEach(() => removeScratchDirs())

function store() {
  const dir = scratchDir('link-prefs-')
  const filePath = join(dir, 'link-preferences.json')
  return { dir, filePath, preferences: createLinkPreferences({ filePath }) }
}

// An .app bundle as the native picker would hand it back.
function appBundle(root: string, name: string): string {
  const app = join(root, `${name}.app`)
  mkdirSync(join(app, 'Contents'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>')
  return app
}

const DEFAULTS = { web: { handler: 'default' }, markdown: { handler: 'default' }, types: [] }

describe('link-preferences.json is read tolerantly (issue #300)', () => {
  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['no schema', '{"web":{"handler":"app","app":"/Applications/Firefox.app"}}'],
  ])('reads %s as the defaults, and lets the next write replace it', (_name, text) => {
    expect(parseLinkPreferences(text)).toEqual({ prefs: DEFAULTS, record: null, writable: true })
  })

  it('reads a newer schema as the defaults and never overwrites it', async () => {
    const { filePath, preferences } = store()
    writeFileSync(filePath, '{"schema":2,"web":{"handler":"default"}}')
    expect(await preferences.read()).toEqual(DEFAULTS)
    expect((await preferences.update((prefs) => ({ ...prefs, markdown: { handler: 'reveal' } }))).refused).toBe('newer')
    expect(readFileSync(filePath, 'utf8')).toBe('{"schema":2,"web":{"handler":"default"}}')
  })

  it('drops each rule that does not check out and keeps the rest', () => {
    const { prefs } = parseLinkPreferences(JSON.stringify({
      schema: 1,
      web: { handler: 'quicklook' },
      markdown: { handler: 'app', app: '/Applications/QLMarkdown.app' },
      types: [
        { extension: 'log', handler: 'reveal' },
        { extension: '.TXT', handler: 'quicklook' },
        { extension: 'log', handler: 'default' },
        { extension: 'command', handler: 'app', app: '/Applications/Sublime Text.app' },
        { extension: 'pkg', handler: 'quicklook' },
        { extension: 'md', handler: 'reveal' },
        { extension: 'py', handler: 'default' },
        { extension: 'csv', handler: 'app', app: 'relative/Numbers.app' },
        { extension: 'csv', handler: 'app', app: '/Applications/Numbers' },
        { extension: 'x y', handler: 'default' },
        { extension: 'json', handler: 'launch' },
        null,
      ],
    }))
    expect(prefs).toEqual({
      web: { handler: 'default' },
      markdown: { handler: 'app', app: '/Applications/QLMarkdown.app' },
      types: [{ extension: 'log', handler: 'reveal' }, { extension: 'txt', handler: 'quicklook' }, { extension: 'py', handler: 'reveal' }],
    })
  })

  it('writes schema 1 atomically, owner-only, and keeps fields a newer build added', async () => {
    const { dir, filePath, preferences } = store()
    writeFileSync(filePath, JSON.stringify({ schema: 1, futureField: { kept: true }, types: [] }))
    await preferences.update((prefs) => ({ ...prefs, markdown: { handler: 'quicklook' } }))
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schema: 1, futureField: { kept: true }, web: { handler: 'default' }, markdown: { handler: 'quicklook' }, types: [],
    })
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([])
  })
})

describe('Settings → Links operations (issue #300)', () => {
  function settings(chooseApp: () => Promise<string[] | null> = async () => null, platform = 'darwin') {
    const { filePath, preferences } = store()
    return { filePath, settings: createLinkSettings({ preferences, platform, chooseApp }) }
  }

  it('lists web links, Markdown and added types, naming an app but never its path', async () => {
    const root = scratchDir('link-apps-')
    const qlmarkdown = appBundle(root, 'QLMarkdown')
    const { settings: s } = settings(async () => [qlmarkdown])
    expect(await s.view()).toEqual({
      available: true,
      rules: [
        { id: 'web', label: 'Web links', kind: 'web', handler: 'default', appName: null, removable: false, systemDefault: true },
        { id: 'markdown', label: 'Markdown (.md, .markdown)', kind: 'file', handler: 'default', appName: null, removable: false, systemDefault: true },
      ],
    })
    await s.addType('.LOG')
    await s.setHandler('ext:log', 'quicklook')
    const view = await s.chooseApp('markdown')
    expect(view.rules.map((rule: { id: string, handler: string, appName: string | null }) => [rule.id, rule.handler, rule.appName])).toEqual([
      ['web', 'default', null],
      ['markdown', 'app', 'QLMarkdown'],
      ['ext:log', 'quicklook', null],
    ])
    expect(JSON.stringify(view)).not.toContain(root)
  })

  it('takes an app only from the native picker, and only a real .app bundle', async () => {
    const root = scratchDir('link-apps-')
    const real = appBundle(root, 'Viewer')
    mkdirSync(join(root, 'Hollow.app'))
    mkdirSync(join(root, 'Odd.app', 'Contents', 'Info.plist'), { recursive: true })
    writeFileSync(join(root, 'Fake.app'), 'not a bundle')
    for (const [picked, error] of [
      [null, undefined],
      [[join(root, 'Hollow.app')], 'not-an-app'],
      [[join(root, 'Odd.app')], 'not-an-app'],
      [[join(root, 'Fake.app')], 'not-an-app'],
      [[join(root, 'Missing.app')], 'not-an-app'],
      [[real, real], 'not-an-app'],
    ] as Array<[string[] | null, string | undefined]>) {
      const { settings: s, filePath } = settings(async () => picked)
      const view = await s.chooseApp('markdown')
      expect(view.error).toBe(error)
      expect(view.rules[1]?.handler).toBe('default')
      expect(existsSync(filePath)).toBe(false)
    }
    const { settings: s, filePath } = settings(async () => [real])
    expect((await s.chooseApp('web')).rules[0]).toMatchObject({ handler: 'app', appName: 'Viewer' })
    expect(JSON.parse(readFileSync(filePath, 'utf8')).web).toEqual({ handler: 'app', app: realpathSync(real) })
  })

  it('refuses an app that runs what it opens, by its own name or the name it resolves to', async () => {
    const root = scratchDir('link-apps-')
    for (const name of ['Terminal', 'iTerm', 'Script Editor', 'Python Launcher 3']) {
      const { settings: s } = settings(async () => [appBundle(root, name)])
      expect((await s.chooseApp('markdown')).error, name).toBe('runs-code')
    }
    symlinkSync(appBundle(join(root, 'hidden'), 'Python Launcher'), join(root, 'Viewer.app'))
    const { settings: s } = settings(async () => [join(root, 'Viewer.app')])
    expect((await s.chooseApp('markdown')).error).toBe('runs-code')
  })

  it('drops a hand-edited rule that names an app that runs what it opens', () => {
    const { prefs } = parseLinkPreferences(JSON.stringify({
      schema: 1,
      web: { handler: 'app', app: '/Applications/iTerm.app' },
      markdown: { handler: 'app', app: '/System/Applications/Utilities/Terminal.app' },
      types: [{ extension: 'txt', handler: 'app', app: '/Applications/Python 3.13/Python Launcher.app' }],
    }))
    expect(prefs).toEqual(DEFAULTS)
  })

  it('never opens the picker for a rule that does not exist', async () => {
    let asked = 0
    const { settings: s } = settings(async () => { asked++; return null })
    expect((await s.chooseApp('ext:nope')).error).toBe('invalid')
    expect((await s.chooseApp('/Applications/Calculator.app')).error).toBe('invalid')
    expect(asked).toBe(0)
  })

  it('refuses a renderer that tries to name an app, a handler or a rule it may not', async () => {
    const { settings: s, filePath } = settings()
    for (const [id, handler] of [
      ['markdown', 'app'],
      ['markdown', '/Applications/Calculator.app'],
      ['web', 'quicklook'],
      ['web', 'reveal'],
      ['ext:log', 'reveal'],
      [{ id: 'markdown' }, 'reveal'],
    ] as Array<[unknown, unknown]>) {
      expect((await s.setHandler(id, handler)).error, `${String(id)} ${String(handler)}`).toBe('invalid')
    }
    expect(existsSync(filePath)).toBe(false)
  })

  it.each([
    ['.command', 'blocked'],
    ['pkg', 'blocked'],
    ['cdr', 'blocked'],
    ['xlsb', 'blocked'],
    ['afploc', 'blocked'],
    ['app', 'blocked'],
    ['md', 'covered'],
    ['Markdown', 'covered'],
    ['', 'invalid'],
    ['a b', 'invalid'],
    ['../x', 'invalid'],
    [42, 'invalid'],
  ])('refuses to add %j as a file type (%s)', async (extension, error) => {
    const { settings: s } = settings()
    expect((await s.addType(extension)).error).toBe(error)
  })

  it('offers System default only for a type the system default may open; code opens only with an app or Quick Look', async () => {
    const root = scratchDir('link-apps-')
    const sublime = appBundle(root, 'Sublime Text')
    const { settings: s, filePath } = settings(async () => [sublime])
    await s.addType('pdf')
    let view = await s.addType('.py')
    expect(view.rules.slice(2).map((rule: { id: string, handler: string, systemDefault: boolean }) => [rule.id, rule.handler, rule.systemDefault]))
      .toEqual([['ext:pdf', 'default', true], ['ext:py', 'reveal', false]])
    expect(JSON.parse(readFileSync(filePath, 'utf8')).types).toEqual([{ extension: 'pdf', handler: 'default' }, { extension: 'py', handler: 'reveal' }])
    expect((await s.setHandler('ext:py', 'default')).error).toBe('invalid')
    expect((await s.setHandler('ext:py', 'quicklook')).rules[3]).toMatchObject({ handler: 'quicklook' })
    view = await s.chooseApp('ext:py')
    expect(view.rules[3]).toMatchObject({ id: 'ext:py', handler: 'app', appName: 'Sublime Text', systemDefault: false })
    expect((await s.setHandler('ext:pdf', 'default')).error).toBeUndefined()
    expect(JSON.parse(readFileSync(filePath, 'utf8')).types).toEqual([
      { extension: 'pdf', handler: 'default' },
      { extension: 'py', handler: 'app', app: realpathSync(sublime) },
    ])
  })

  it('adds a type once, up to twenty, and removes it', async () => {
    const { settings: s } = settings()
    await s.addType('log')
    expect((await s.addType('.log')).error).toBe('exists')
    for (let i = 1; i < 20; i++) await s.addType(`t${i}`)
    expect((await s.addType('extra')).error).toBe('full')
    const view = await s.removeType('ext:log')
    expect(view.rules.some((rule: { id: string }) => rule.id === 'ext:log')).toBe(false)
    expect((await s.removeType('markdown')).error).toBe('invalid')
  })

  it('offers nothing to change off macOS, where links keep the system defaults', async () => {
    const root = scratchDir('link-apps-')
    const { settings: s, filePath } = settings(async () => [appBundle(root, 'Viewer')], 'linux')
    expect(await s.view()).toEqual({ available: false, rules: [] })
    expect((await s.chooseApp('markdown')).available).toBe(false)
    expect((await s.addType('log')).available).toBe(false)
    expect(existsSync(filePath)).toBe(false)
  })

  it('stays usable when the file cannot be written', async () => {
    const dir = scratchDir('link-prefs-ro-')
    chmodSync(dir, 0o500)
    try {
      const s = createLinkSettings({ preferences: createLinkPreferences({ filePath: join(dir, 'sub', 'link-preferences.json') }), platform: 'darwin', chooseApp: async () => null })
      expect((await s.setHandler('markdown', 'reveal')).error).toBe('failed')
      expect((await s.view()).rules[1]?.handler).toBe('default')
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})
