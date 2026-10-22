'use strict'
// Settings → Links (issue #300 part 2): the Inbox's own defaults for opening
// links, per type, which override the system's on macOS.
//
// Main alone writes them, to userData `link-preferences.json`, and the only way
// an app path gets in is main's own native picker: nothing the renderer sends
// can name one, and the settings view it gets back names an app, never its
// path. Schema 1, written by temp file and rename under the same cross-process
// lock as the update preferences, and read tolerantly: a corrupt file reads as
// the defaults, a rule that does not check out is dropped, and a file a newer
// build wrote with a newer schema reads as the defaults and is never
// overwritten.
//
// A rule decides only how an openable file opens. electron/link-open.cjs
// applies the safety policy first, so a folder, an app, a script or anything
// with an execute bit is still only revealed, whatever a rule says.
const fs = require('node:fs/promises')
const path = require('node:path')
const { blockedFileName } = require('./link-open.cjs')
const { createLockedFile, resolveFilePath } = require('./update-preferences.cjs')

const FILENAME = 'link-preferences.json'
const SCHEMA = 1
const MAX_TYPES = 20
const MAX_APP_PATH = 1024
const EXTENSION_RE = /^[a-z0-9][a-z0-9+_-]{0,15}$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const MARKDOWN = new Set(['md', 'markdown'])
const WEB_HANDLERS = new Set(['default', 'app'])
const FILE_HANDLERS = new Set(['default', 'quicklook', 'reveal', 'app'])
// What the renderer may set directly; 'app' comes only from chooseApp().
const SETTABLE = { web: new Set(['default']), file: new Set(['default', 'quicklook', 'reveal']) }
// Apps that run what they open. Choosing one would turn every opened document
// into a program, so the picker refuses them (a guard against a slip, not a
// boundary: the human's own choice is what is being checked).
const RUNNERS = new Set([
  'alacritty', 'automator', 'ghostty', 'hyper', 'installer', 'iterm', 'iterm2', 'kitty', 'python launcher',
  'python launcher 3', 'script editor', 'shortcuts', 'terminal', 'warp', 'wezterm',
])

function defaults() {
  return { web: { handler: 'default' }, markdown: { handler: 'default' }, types: [] }
}

function appPath(value) {
  if (typeof value !== 'string' || value.length > MAX_APP_PATH || CONTROL_RE.test(value)) return null
  if (!path.isAbsolute(value) || !/\.app$/i.test(value)) return null
  return path.normalize(value)
}

const appName = (app) => path.basename(app).replace(/\.app$/i, '')

function readRule(value, handlers) {
  if (!value || typeof value !== 'object' || !handlers.has(value.handler)) return null
  if (value.handler !== 'app') return { handler: value.handler }
  const app = appPath(value.app)
  return app ? { handler: 'app', app } : null
}

function normalizeExtension(value) {
  if (typeof value !== 'string') return null
  const extension = value.trim().replace(/^\./, '').toLowerCase()
  return EXTENSION_RE.test(extension) ? extension : null
}

const blockedExtension = (extension) => blockedFileName(`file.${extension}`)

// { prefs, record, writable }: `record` is the file's own object, so a write
// keeps any field a newer build added.
function parseLinkPreferences(bytes) {
  const empty = { prefs: defaults(), record: null, writable: true }
  let value
  try {
    value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes))
  } catch {
    return empty
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.schema) || value.schema < 1) {
    return empty
  }
  if (value.schema !== SCHEMA) return { prefs: defaults(), record: null, writable: false }
  const prefs = defaults()
  prefs.web = readRule(value.web, WEB_HANDLERS) ?? prefs.web
  prefs.markdown = readRule(value.markdown, FILE_HANDLERS) ?? prefs.markdown
  const seen = new Set(MARKDOWN)
  for (const type of Array.isArray(value.types) ? value.types : []) {
    const extension = normalizeExtension(type && type.extension)
    const rule = readRule(type, FILE_HANDLERS)
    if (!extension || !rule || seen.has(extension) || blockedExtension(extension) || prefs.types.length >= MAX_TYPES) continue
    seen.add(extension)
    prefs.types.push({ extension, ...rule })
  }
  return { prefs, record: value, writable: true }
}

function createLinkPreferences(options = {}) {
  const file = createLockedFile(resolveFilePath(options, FILENAME), options.fsImpl ?? fs)

  async function readLive() {
    const bytes = await file.readBytes()
    return bytes === null ? { prefs: defaults(), record: null, writable: true } : parseLinkPreferences(bytes)
  }

  return Object.freeze({
    async read() {
      await file.settled()
      return (await readLive()).prefs
    },
    // `change` gets a copy of the current preferences and returns the next ones,
    // or { refused } to write nothing.
    update(change) {
      return file.mutate(async () => {
        const current = await readLive()
        if (!current.writable) return { prefs: current.prefs, refused: 'newer' }
        const next = change(structuredClone(current.prefs))
        if (!next || next.refused) return { prefs: current.prefs, refused: (next && next.refused) || 'invalid' }
        await file.atomicWrite({ ...(current.record ?? {}), schema: SCHEMA, web: next.web, markdown: next.markdown, types: next.types })
        return { prefs: next }
      })
    },
  })
}

// The rule a settings id names, as [get, set] over a copy of the preferences.
function ruleSlot(prefs, id) {
  if (id === 'web') return { kind: 'web', get: () => prefs.web, set: (rule) => { prefs.web = rule } }
  if (id === 'markdown') return { kind: 'file', get: () => prefs.markdown, set: (rule) => { prefs.markdown = rule } }
  const extension = typeof id === 'string' && id.startsWith('ext:') ? normalizeExtension(id.slice(4)) : null
  const index = extension && id === `ext:${extension}` ? prefs.types.findIndex((type) => type.extension === extension) : -1
  if (index < 0) return null
  return {
    kind: 'file',
    get: () => prefs.types[index],
    set: (rule) => { prefs.types[index] = { extension, ...rule } },
  }
}

function settingsView(prefs) {
  const row = (id, label, kind, rule, removable) => ({
    id, label, kind, handler: rule.handler, appName: rule.handler === 'app' ? appName(rule.app) : null, removable,
  })
  return {
    available: true,
    rules: [
      row('web', 'Web links', 'web', prefs.web, false),
      row('markdown', 'Markdown (.md, .markdown)', 'file', prefs.markdown, false),
      ...prefs.types.map((type) => row(`ext:${type.extension}`, `.${type.extension}`, 'file', type, true)),
    ],
  }
}

// The single .app bundle the picker returned, or why not.
async function chosenApp(paths, fsp = fs) {
  if (!Array.isArray(paths) || paths.length !== 1) return { error: 'not-an-app' }
  const app = appPath(paths[0])
  if (!app) return { error: 'not-an-app' }
  try {
    const [bundle, plist] = await Promise.all([fsp.stat(app), fsp.stat(path.join(app, 'Contents', 'Info.plist'))])
    if (!bundle.isDirectory() || !plist.isFile()) return { error: 'not-an-app' }
  } catch {
    return { error: 'not-an-app' }
  }
  return RUNNERS.has(appName(app).toLowerCase()) ? { error: 'runs-code' } : { app }
}

// What the Settings → Links IPC calls. Every method answers with the settings
// view, plus `error` when it changed nothing. Per-type apps are macOS-only:
// elsewhere there is nothing to change and links keep the system defaults.
function createLinkSettings({ preferences, platform, chooseApp, fsp = fs }) {
  const unavailable = () => ({ available: false, rules: [] })
  const view = async (error) => {
    let prefs
    try {
      prefs = await preferences.read()
    } catch {
      prefs = defaults()
    }
    return error ? { ...settingsView(prefs), error } : settingsView(prefs)
  }
  const change = async (mutate) => {
    if (platform !== 'darwin') return unavailable()
    let result
    try {
      result = await preferences.update(mutate)
    } catch {
      return view('failed')
    }
    return view(result.refused)
  }
  return Object.freeze({
    view: () => (platform === 'darwin' ? view() : unavailable()),
    setHandler: (id, handler) => change((prefs) => {
      const slot = ruleSlot(prefs, id)
      if (!slot || !SETTABLE[slot.kind].has(handler)) return { refused: 'invalid' }
      slot.set({ handler })
      return prefs
    }),
    async chooseApp(id) {
      if (platform !== 'darwin') return unavailable()
      let prefs
      try {
        prefs = await preferences.read()
      } catch {
        return view('failed')
      }
      if (!ruleSlot(prefs, id)) return view('invalid')
      let paths
      try {
        paths = await chooseApp()
      } catch {
        return view('failed')
      }
      if (paths === null || paths === undefined) return view()
      const chosen = await chosenApp(paths, fsp)
      if (chosen.error) return view(chosen.error)
      return change((next) => {
        const slot = ruleSlot(next, id)
        if (!slot) return { refused: 'invalid' }
        slot.set({ handler: 'app', app: chosen.app })
        return next
      })
    },
    addType: (raw) => change((prefs) => {
      const extension = normalizeExtension(raw)
      if (!extension) return { refused: 'invalid' }
      if (MARKDOWN.has(extension)) return { refused: 'covered' }
      if (blockedExtension(extension)) return { refused: 'blocked' }
      if (prefs.types.some((type) => type.extension === extension)) return { refused: 'exists' }
      if (prefs.types.length >= MAX_TYPES) return { refused: 'full' }
      prefs.types.push({ extension, handler: 'default' })
      return prefs
    }),
    removeType: (id) => change((prefs) => {
      const slot = id === 'web' || id === 'markdown' ? null : ruleSlot(prefs, id)
      if (!slot) return { refused: 'invalid' }
      prefs.types = prefs.types.filter((type) => type !== slot.get())
      return prefs
    }),
  })
}

module.exports = {
  chosenApp,
  createLinkPreferences,
  createLinkSettings,
  parseLinkPreferences,
}
