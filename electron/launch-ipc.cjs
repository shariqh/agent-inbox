'use strict'
// Issue #412 step 3 — the driven-sessions IPC (design §8). Every channel takes
// an exact number of arguments, waits for any re-proof of the window in flight
// (#216), and answers only the viewer window's own top frame:
//   - the switch (`launch-available`, `launch-set-enabled`) needs the viewer
//     this app started and owns (the `files` grant's window, #300): a browser,
//     a reused or failed-over viewer can neither read nor turn it on;
//   - every launch action needs the `launch` grant: that same owned viewer,
//     with the switch on and no quit begun (createInstallBinding), and so do
//     choosing and resetting the worktree folder and New session's Choose
//     folder… (#432), which main reads only with the switch on.
// What the renderer sends is checked again by the controller; it can never
// send a path, an executable, argv or an env.
const NOT_HERE = 'Agent sessions work only in Agent Inbox’s own window, with Settings → Agent sessions on.'

// `controller` is a function, so the controller is made on first use, never at startup.
function registerLaunchIpc({ ipcMain, controller, settings, settled, isOwned, isGranted, onEnabled }) {
  ipcMain.handle('agent-inbox:launch-available', async (event, ...args) => {
    const off = { owned: false, enabled: false, available: false }
    if (args.length !== 0) return off
    await settled()
    if (!isOwned(event)) return off
    const view = controller().available()
    const granted = isGranted(event)
    const worktreeRoot = view.available && granted ? await controller().worktreeRoot() : null
    const maxSessions = view.available && granted ? await controller().maxSessions() : null
    return {
      owned: true,
      enabled: view.enabled,
      available: view.available && granted,
      ...(view.error ? { error: view.error } : !granted && view.enabled ? { error: NOT_HERE } : {}),
      canEnable: controller().canEnable() === null,
      ...(worktreeRoot ? { worktreeRoot } : {}),
      ...(maxSessions ? { maxSessions } : {}),
    }
  })

  ipcMain.handle('agent-inbox:launch-set-enabled', async (event, ...args) => {
    if (args.length !== 1 || typeof args[0] !== 'boolean') return { ok: false, error: 'invalid' }
    await settled()
    if (!isOwned(event)) return { ok: false, error: NOT_HERE }
    const enabled = args[0]
    if (enabled) {
      const why = controller().canEnable({ withKeys: true })
      if (why) return why
    } else {
      // so Stop and Close stay reachable, it stays on while sessions run
      const running = await controller().running()
      if (running.length) return { ok: false, error: 'Stop the sessions Agent Inbox started before turning this off.' }
    }
    let result
    try {
      result = await settings.setEnabled(enabled)
    } catch {
      return { ok: false, error: 'The setting could not be saved.' }
    }
    if (result.refused) return { ok: false, error: 'A newer Agent Inbox owns this setting.' }
    onEnabled(result.enabled)
    return { ok: true, enabled: result.enabled }
  })

  const noArgument = { chooseFolder: 'choose-folder', chooseWorktreeRoot: 'choose-worktree-root', resetWorktreeRoot: 'reset-worktree-root' }
  for (const [action, channel] of Object.entries(noArgument)) {
    ipcMain.handle(`agent-inbox:launch-${channel}`, async (event, ...args) => {
      if (args.length !== 0) return { ok: false, error: 'invalid' }
      await settled()
      if (!isGranted(event)) return { ok: false, error: NOT_HERE }
      return controller()[action]()
    })
  }

  const oneArgument = {
    start: 'start', stop: 'stop', close: 'close', resume: 'resume', approve: 'approve',
    // #432 §5, §6: a launch id only; main reads the worktree's path from the hub itself
    removeWorktree: 'remove-worktree', openWorktree: 'open-worktree',
    // step 5: Take over in Terminal; a launch id only, main reads the session and folder from the hub
    takeOver: 'take-over',
    // #478: Forget; a launch id only, main reads the row and confirms in its own dialog
    forget: 'forget',
    // #451: { id, add }, checked again by the controller, which confirms it natively
    resumeWithBudget: 'resume-with-budget',
    // #432 §5: the cap on sessions at once, 1 to 8, checked again by the controller
    setMaxSessions: 'set-max-sessions',
  }
  for (const [action, channel] of Object.entries(oneArgument)) {
    ipcMain.handle(`agent-inbox:launch-${channel}`, async (event, ...args) => {
      if (args.length !== 1) return { ok: false, error: 'invalid' }
      await settled()
      if (!isGranted(event)) return { ok: false, error: NOT_HERE }
      return controller()[action](args[0])
    })
  }
}

module.exports = { registerLaunchIpc }
