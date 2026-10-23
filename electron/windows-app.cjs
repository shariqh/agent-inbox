'use strict'

// What the per-user Windows MSI needs from the app (#87, PR 2b).
//
// Identity. The MSI's Start-menu shortcut, Programs\Agent Inbox.lnk, carries an
// AppUserModelID and a toast activator CLSID, and the MSI owns that CLSID's
// LocalServer32 registration. Windows matches a notification to the shortcut by
// the process's AppUserModelID, and at its first notification Electron rewrites a
// shortcut of that name whose ID differs from the app's own (Electron's default is
// `electron.app.Agent Inbox`), and makes up a CLSID when it finds no shortcut. So
// the app sets both before any window or notification exists. The MSI reads the
// same values from release/windows-inputs.json (bundleId) and
// .github/windows-msi/installer.json; a test keeps them equal, and none of them may
// change once an MSI has shipped. Only a packaged build claims them: a development
// run (`electron .`) is the bare electron.exe, and with the installed app's identity
// its first notification would write a shortcut to electron.exe and point the
// installed app's toast activator registration at it.
//
// Restart Manager. An installer that needs files a running app holds can ask it to
// close through Restart Manager: WM_QUERYENDSESSION, then WM_ENDSESSION with
// ENDSESSION_CLOSEAPP, which Electron reports as the window's session-end event with
// the reason 'close-app'. Electron 43 then ends the process at once unless the app
// has begun its own quit, which would skip the page's beforeunload (staged sends,
// unsent drafts) and will-quit's storage flush. So the app quits through its normal
// path instead, and logs again once it reaches will-quit: a before-quit listener that
// holds the quit (main.cjs's does while Setup or an update install runs) leaves
// Electron's immediate exit in place, so only that second line shows the quit went
// on. A shutdown or log-off keeps Electron's immediate exit. (A silent MSI upgrade on
// the CI runner never asked: see the installer decision record, §9.)

const APP_USER_MODEL_ID = 'io.github.shariqh.agent-inbox'
const TOAST_ACTIVATOR_CLSID = '{08973E92-A6EF-47B2-9E91-A876F4B8F210}'

function setWindowsAppIdentity({ app, platform }) {
  if (platform !== 'win32' || !app.isPackaged) return false
  app.setAppUserModelId(APP_USER_MODEL_ID)
  app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID)
  return true
}

function quitWhenRestartManagerAsks({ window, app, platform, log = console.log }) {
  if (platform !== 'win32') return false
  window.on('session-end', (event) => {
    if (!Array.isArray(event?.reasons) || !event.reasons.includes('close-app')) return
    log('[agent-inbox] Windows asked the app to close (Restart Manager); quitting')
    // Before quit(): with no window left, Electron emits will-quit inside it.
    app.once('will-quit', () => log('[agent-inbox] Windows asked the app to close (Restart Manager); reached will-quit'))
    app.quit()
  })
  return true
}

module.exports = { APP_USER_MODEL_ID, TOAST_ACTIVATOR_CLSID, quitWhenRestartManagerAsks, setWindowsAppIdentity }
