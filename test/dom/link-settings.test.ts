// @vitest-environment jsdom
// test/dom/link-settings.test.ts — issue #300 part 2: Settings → Links, and the
// Reveal / Copy path actions a file chip gets in the desktop app.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { bootApp, click, freshDb, row, settle, showInbox, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'agentInboxLinks')
  Reflect.deleteProperty(window, 'agentInboxLinkSettings')
  Reflect.deleteProperty(navigator, 'clipboard')
})

interface Rule { id: string, label: string, kind: 'web' | 'file', handler: string, appName: string | null, removable: boolean, systemDefault: boolean }
interface View { available: boolean, rules: Rule[], error?: string }

const WEB: Rule = { id: 'web', label: 'Web links', kind: 'web', handler: 'default', appName: null, removable: false, systemDefault: true }
const MARKDOWN: Rule = { id: 'markdown', label: 'Markdown (.md, .markdown)', kind: 'file', handler: 'default', appName: null, removable: false, systemDefault: true }

// A main process that keeps rules the way link-preferences.cjs does, as far as
// this section can tell.
function settingsBridge(start: View = { available: true, rules: [WEB, MARKDOWN] }) {
  let view: View = structuredClone(start)
  const answer = (error?: string): View => (error ? { ...view, error } : view)
  const set = (id: string, change: Partial<Rule>) => {
    view = { ...view, rules: view.rules.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)) }
  }
  const api = {
    get: vi.fn(async () => answer()),
    setHandler: vi.fn(async (id: string, handler: string) => { set(id, { handler, appName: null }); return answer() }),
    chooseApp: vi.fn(async (id: string) => { set(id, { handler: 'app', appName: 'QLMarkdown' }); return answer() }),
    addType: vi.fn(async (extension: string) => {
      const ext = extension.replace(/^\./, '').toLowerCase()
      if (ext === 'command') return answer('blocked')
      // as main does, a type off the allow-list starts as Reveal, with no System default
      const systemDefault = ext !== 'py'
      view = {
        ...view,
        rules: [...view.rules, { id: `ext:${ext}`, label: `.${ext}`, kind: 'file', handler: systemDefault ? 'default' : 'reveal', appName: null, removable: true, systemDefault }],
      }
      return answer()
    }),
    removeType: vi.fn(async (id: string) => { view = { ...view, rules: view.rules.filter((rule) => rule.id !== id) }; return answer() }),
  }
  Object.defineProperty(window, 'agentInboxLinkSettings', { configurable: true, value: api })
  return api
}

const section = () => document.getElementById('link-settings')
const select = (id: string) => section()?.querySelector<HTMLSelectElement>(`select[data-rule="${id}"]`) ?? null
const choose = (el: HTMLSelectElement | null, value: string) => {
  if (!el) throw new Error('choose(): no select')
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
const options = (el: HTMLSelectElement | null) => [...(el?.options ?? [])].map((o) => [o.value, o.textContent])

describe('Settings → Links (issue #300 part 2)', () => {
  it('lists web links and Markdown with their choices, and saves a choice through main', async () => {
    const api = settingsBridge()
    db = freshDb()
    await bootApp(db)

    expect(section()?.querySelector('h3')?.textContent).toBe('Links')
    expect(options(select('web'))).toEqual([['default', 'Default browser'], ['choose', 'Choose app…']])
    expect(options(select('markdown'))).toEqual([
      ['default', 'System default'], ['quicklook', 'Quick Look'], ['reveal', 'Reveal in Finder'], ['choose', 'Choose app…'],
    ])
    expect(section()?.querySelector(`label[for="${select('markdown')?.id}"]`)?.textContent).toBe('Markdown (.md, .markdown)')

    choose(select('markdown'), 'quicklook')
    await settle()
    expect(api.setHandler).toHaveBeenCalledWith('markdown', 'quicklook')
    expect(select('markdown')?.value).toBe('quicklook')
    expect(document.activeElement).toBe(select('markdown'))
  })

  it('asks main to choose an app, names it, and never sends a path', async () => {
    const api = settingsBridge()
    db = freshDb()
    await bootApp(db)

    choose(select('markdown'), 'choose')
    await settle()
    expect(api.chooseApp).toHaveBeenCalledWith('markdown')
    expect(select('markdown')?.value).toBe('app')
    expect(options(select('markdown')).slice(-2)).toEqual([['app', 'QLMarkdown'], ['choose', 'Choose another app…']])
    for (const call of [...api.setHandler.mock.calls, ...api.chooseApp.mock.calls, ...api.addType.mock.calls]) {
      expect(JSON.stringify(call)).not.toMatch(/\//)
    }
  })

  it('adds and removes a file type, and says why one cannot be added', async () => {
    const api = settingsBridge()
    db = freshDb()
    await bootApp(db)
    const input = () => document.getElementById('link-add-type-input') as HTMLInputElement
    const submit = () => section()?.querySelector('form.link-add-type')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    input().value = '.LOG'
    submit()
    await settle()
    expect(api.addType).toHaveBeenCalledWith('.LOG')
    expect(select('ext:log')).not.toBeNull()
    expect(options(select('ext:log')).map(([value]) => value)).toEqual(['default', 'quicklook', 'reveal', 'choose'])
    expect(input().value).toBe('')

    input().value = '.py'
    submit()
    await settle()
    expect(options(select('ext:py'))).toEqual([['quicklook', 'Quick Look'], ['reveal', 'Reveal in Finder'], ['choose', 'Choose app…']])
    expect(select('ext:py')?.value).toBe('reveal')

    input().value = '.command'
    submit()
    await settle()
    expect(section()?.querySelector('.link-settings-message')?.textContent).toBe('Agent Inbox never opens that type of file, so it can’t have a rule.')
    expect(input().value).toBe('.command')

    click(section()?.querySelector('button[aria-label="Remove .log"]'))
    await settle()
    expect(api.removeType).toHaveBeenCalledWith('ext:log')
    expect(select('ext:log')).toBeNull()
  })

  it('says per-type apps are macOS-only where main offers none, and points a browser at the app', async () => {
    settingsBridge({ available: false, rules: [] })
    db = freshDb()
    await bootApp(db)
    expect(section()?.querySelector('.setup-hint')?.textContent).toBe('Links open with your system’s default apps. Choosing an app for each type of file is available on macOS.')
    expect(section()?.querySelector('select, form')).toBeNull()
  })

  it('in a browser, only says where the setting lives', async () => {
    db = freshDb()
    await bootApp(db)
    expect(section()?.querySelector('.setup-hint')?.textContent).toBe('In the Agent Inbox app on macOS, you can choose which app opens web links and each type of file.')
    expect(section()?.querySelector('select, form')).toBeNull()
  })
})

describe('file chip actions (issue #300 part 2)', () => {
  async function card() {
    db = freshDb()
    const id = insertItem(db, { project: 'alpha', agent: 'claude', stream: 'main', kind: 'question', title: 'Read it', detail: 'See /Users/s/docs/spec.md' })
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    return row(id)!.querySelector<HTMLElement>('.nrow-card .card-links')!
  }

  it('in the desktop app, reveals a file through main and copies its path', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
    const open = vi.fn(async () => ({ ok: true, action: 'revealed', reason: 'requested' }))
    Object.defineProperty(window, 'agentInboxLinks', { configurable: true, value: { open } })
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const strip = await card()
      const group = strip.querySelector<HTMLElement>('.link-file')!
      expect(group.getAttribute('role')).toBe('group')
      expect([...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim()))
        .toEqual(['File spec.md', 'Reveal in Finder: spec.md', 'Copy path: spec.md'])

      click(group.querySelector('[data-link-action="reveal"]'))
      await settle()
      expect(open).toHaveBeenCalledWith({ kind: 'file', path: '/Users/s/docs/spec.md', reveal: true })
      expect(document.getElementById('linkOpenStatus')?.textContent).toBe('Shown in Finder.')

      click(group.querySelector('[data-link-action="copy"]'))
      await settle()
      expect(writeText).toHaveBeenCalledWith('/Users/s/docs/spec.md')
      expect(document.getElementById('linkOpenStatus')?.textContent).toBe('Copied the path.')
      expect(open).toHaveBeenCalledTimes(1)
    } finally {
      Reflect.deleteProperty(navigator, 'platform')
    }
  })

  it('says when the app chosen for a type has gone, or is one main refuses to launch', async () => {
    const open = vi.fn(async () => ({ ok: false, reason: 'app-missing' }))
    Object.defineProperty(window, 'agentInboxLinks', { configurable: true, value: { open } })
    const strip = await card()
    click(strip.querySelector('button[data-link-kind="file"]'))
    await settle()
    expect(document.getElementById('linkOpenStatus')?.textContent).toBe('The app chosen in Settings → Links is gone. Choose another there.')
    open.mockResolvedValueOnce({ ok: false, reason: 'app-refused' })
    click(strip.querySelector('button[data-link-kind="file"]'))
    await settle()
    expect(document.getElementById('linkOpenStatus')?.textContent).toBe('Agent Inbox won’t open links with the app chosen in Settings → Links. Choose another there.')
  })

  it('in a browser, keeps the plain chip, whose click already copies the path', async () => {
    const strip = await card()
    expect(strip.querySelector('.link-file, [data-link-action]')).toBeNull()
    expect(strip.querySelector('button[data-link-kind="file"]')).not.toBeNull()
  })
})
