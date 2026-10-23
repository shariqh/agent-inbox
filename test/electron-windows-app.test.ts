// The per-user MSI (#87, PR 2b) gives the app a Start-menu shortcut that carries
// the app's AppUserModelID and toast activator CLSID, and an installer can ask a
// running app to close through Restart Manager. A packaged Windows build claims that
// identity before any window or notification exists, and on Windows the app quits
// through its normal path when Restart Manager asks; macOS and Linux are untouched.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import windowsApp from '../electron/windows-app.cjs'

const { APP_USER_MODEL_ID, TOAST_ACTIVATOR_CLSID, quitWhenRestartManagerAsks, setWindowsAppIdentity } = windowsApp

const root = join(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')

const QUIT = '[agent-inbox] Windows asked the app to close (Restart Manager); quitting'
const WILL_QUIT = '[agent-inbox] Windows asked the app to close (Restart Manager); reached will-quit'

// quitEmitsWillQuit models Electron with no window left, where app.quit() emits
// will-quit before it returns.
function fakeApp({ isPackaged = true, quitEmitsWillQuit = false } = {}) {
  const calls: string[] = []
  const willQuit: (() => void)[] = []
  const app = {
    calls,
    isPackaged,
    setAppUserModelId: (id: string) => { calls.push(`aumid:${id}`) },
    setToastActivatorCLSID: (id: string) => { calls.push(`clsid:${id}`) },
    once: (name: 'will-quit', listener: () => void) => {
      calls.push(`once:${name}`)
      willQuit.push(listener)
      return app
    },
    quit: () => {
      calls.push('quit')
      if (quitEmitsWillQuit) app.emitWillQuit()
    },
    emitWillQuit: () => { for (const listener of willQuit.splice(0)) listener() },
  }
  return app
}

function fakeWindow() {
  const listeners: [string, (event: { reasons?: string[] }) => void][] = []
  return {
    listeners,
    on(name: 'session-end', listener: (event: { reasons?: string[] }) => void) {
      listeners.push([name, listener])
      return this
    },
    emit(event: { reasons?: string[] }) {
      for (const [, listener] of listeners) listener(event)
    },
  }
}

describe('Windows app identity (#87)', () => {
  it('sets the AppUserModelID and toast activator CLSID the MSI shortcut carries, in a packaged Windows build only', () => {
    const app = fakeApp()
    expect(setWindowsAppIdentity({ app, platform: 'win32' })).toBe(true)
    expect(app.calls).toEqual([`aumid:${APP_USER_MODEL_ID}`, `clsid:${TOAST_ACTIVATOR_CLSID}`])
    for (const platform of ['darwin', 'linux']) {
      const other = fakeApp()
      expect(setWindowsAppIdentity({ app: other, platform })).toBe(false)
      expect(other.calls).toEqual([])
    }
  })

  it('leaves a development run on Windows with Electron\'s own identity', () => {
    // `electron .` runs the bare electron.exe: with the installed app's identity, its
    // first notification would write a shortcut to electron.exe and point the
    // installed app's toast activator registration at it.
    const dev = fakeApp({ isPackaged: false })
    expect(setWindowsAppIdentity({ app: dev, platform: 'win32' })).toBe(false)
    expect(dev.calls).toEqual([])
  })

  it('is exactly the identity the MSI installs and the Windows release inputs name', () => {
    expect(APP_USER_MODEL_ID).toBe(JSON.parse(read('release/windows-inputs.json')).bundleId)
    expect(APP_USER_MODEL_ID).toBe('io.github.shariqh.agent-inbox')
    const { identity } = JSON.parse(read('.github/windows-msi/installer.json'))
    expect(TOAST_ACTIVATOR_CLSID).toBe(identity.toastActivatorClsid)
    // Electron accepts this canonical form as is; the MSI writes it into the shortcut.
    expect(TOAST_ACTIVATOR_CLSID).toMatch(/^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/)
  })
})

describe('Restart Manager exit (#87)', () => {
  it('quits through the normal path when Restart Manager asks the app to close, and says when it reaches will-quit', () => {
    const app = fakeApp()
    const window = fakeWindow()
    const logged: string[] = []
    expect(quitWhenRestartManagerAsks({ window, app, platform: 'win32', log: (line) => logged.push(line) })).toBe(true)
    expect(window.listeners.map(([name]) => name)).toEqual(['session-end'])
    window.emit({ reasons: ['close-app'] })
    expect(app.calls).toEqual(['once:will-quit', 'quit'])
    // Electron ends the process at once unless this quit began, so until will-quit the
    // app has only said it was asked.
    expect(logged).toEqual([QUIT])
    app.emitWillQuit()
    expect(logged).toEqual([QUIT, WILL_QUIT])
  })

  it('is listening for will-quit before it quits, as Electron with no window emits it inside app.quit()', () => {
    const app = fakeApp({ quitEmitsWillQuit: true })
    const window = fakeWindow()
    const logged: string[] = []
    quitWhenRestartManagerAsks({ window, app, platform: 'win32', log: (line) => logged.push(line) })
    window.emit({ reasons: ['close-app'] })
    expect(logged).toEqual([QUIT, WILL_QUIT])
  })

  it('leaves a shutdown or log-off to Electron, which ends the process at once', () => {
    const app = fakeApp()
    const window = fakeWindow()
    quitWhenRestartManagerAsks({ window, app, platform: 'win32', log: () => {} })
    for (const reasons of [['shutdown'], ['logoff'], ['critical'], ['critical', 'logoff'], []]) window.emit({ reasons })
    window.emit({})
    expect(app.calls).toEqual([])
    window.emit({ reasons: ['close-app', 'critical'] })
    expect(app.calls).toEqual(['once:will-quit', 'quit'])
  })

  it('registers nothing on macOS or Linux', () => {
    for (const platform of ['darwin', 'linux']) {
      const app = fakeApp()
      const window = fakeWindow()
      expect(quitWhenRestartManagerAsks({ window, app, platform })).toBe(false)
      expect(window.listeners).toEqual([])
    }
  })
})

describe('Electron main wiring (#87)', () => {
  const main = read('electron/main.cjs')

  it('claims the Windows identity at startup, before any window or notification, without stopping startup', () => {
    expect(main).toContain("const { quitWhenRestartManagerAsks, setWindowsAppIdentity } = require('./windows-app.cjs')")
    // A top-level statement runs while main.cjs loads, before app.whenReady() resolves
    // and so before the window or the first notification.
    expect(main).toMatch(
      /\ntry \{\n {2}setWindowsAppIdentity\(\{ app, platform: process\.platform \}\)\n\} catch \(err\) \{\n {2}console\.error\(`\[agent-inbox\] could not set the Windows app identity: \$\{err\.message\}`\)\n\}\n/,
    )
    expect(main.indexOf('setWindowsAppIdentity({ app, platform: process.platform })'))
      .toBeLessThan(main.indexOf('app.whenReady().then('))
    expect(main.match(/setWindowsAppIdentity\(/g)).toHaveLength(1)
  })

  it('quits the window through the normal path when Restart Manager asks', () => {
    const create = main.slice(main.indexOf('function createWindow() {'), main.indexOf('\nnativeTheme.on('))
    const window = create.indexOf('const win = new BrowserWindow({')
    const hook = create.indexOf('quitWhenRestartManagerAsks({ window: win, app, platform: process.platform })')
    expect(window).toBeGreaterThan(0)
    expect(hook).toBeGreaterThan(window)
    expect(create.indexOf('return win')).toBeGreaterThan(hook)
    expect(main.match(/quitWhenRestartManagerAsks\(/g)).toHaveLength(1)
  })
})
