---
paths:
  - "electron/main.cjs"
  - "electron/setup-runner.cjs"
  - "electron/viewer-navigation.cjs"
applyTo: "electron/main.cjs,electron/setup-runner.cjs,electron/viewer-navigation.cjs"
---

# Electron app: window install binding

How Setup, update installs and local file links are granted to the app's own viewer window (#216).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Install grants survive a reload of the owned viewer** *(#216)* — Setup and update
  installs are granted to the one window, not to the app, and before #216 any later
  main-frame navigation revoked them for good: after View → Reload, Force Reload or a
  renderer crash, Settings kept showing an **Install and restart** that main always refused
  ("Restart Agent Inbox to install this update.") until the app restarted. Seen in the first
  real 1.3.0 → 1.3.1 run. `createInstallBinding()` (`electron/setup-runner.cjs`, beside
  #205's gate) now owns the grants. (1) The first main-frame navigation binds at once, as
  before: startup's `waitForOwnership()` proved ownership moments earlier. (2) Every later
  one (a reload, the viewer's own restart reload, failover's reload) revokes both at once,
  and they come back only when that navigation commits (`did-navigate`) to the viewer
  origin AND `reproveOwnership()` passes: the startup proof again, plus, for a dev viewer
  child this app spawned, that the child still runs. `/api/owner` hands `OWNER_TOKEN` to
  any local client, so the token alone proves nothing hours later; what does is a listener
  that has held the port since startup (a packaged app's in-process viewer cannot lose it
  while the app runs). That is also why the proof starts after the commit, never at the
  navigation's start: then the listener that answers is the one that served the page.
  (3) A newer navigation, a renderer crash or the window closing discards a proof still
  running; a crash revokes and the window's next load may re-bind under the same proof; a
  closed window never binds again; nothing binds once a quit has begun (#205). (4) Setup
  is granted only while `setupInstallEnabled`, update installs and (#300) local file links
  only while `viewerOwned`; with none of them (a reused or failed-over viewer) nothing is
  probed. The UI is honest as well:
  the controller publishes `available.installPermitted` from main's
  `updateInstallPermitted()` (the binding the install IPC checks, and no quit), the preload
  requires a boolean that implies `installable`, and the binding's `apply` calls
  `refreshInstallPermission()`, which republishes only on a change. An installable
  verified (or install-failed) offer that is not permitted hides Install and restart and
  says "Restart Agent Inbox to install this update." with a **Restart Agent Inbox** button
  on macOS, or "Quit and reopen Agent Inbox to install this update." with no button on an
  AppImage, which Electron must never relaunch (part 3). (5) `agent-inbox:update-restart`
  accepts exactly the state that shows that button and nothing else: trusted sender,
  `darwin`, no quit begun, Setup NOT running (`installGate.running()`: the quit's
  `beginAppQuit()` would cancel it mid-registration, #205's hazard, and the update path
  refuses that too), `viewerOwned`, no update installing, an installable `verified` or
  `install-failed` offer, and `!updateInstallPermitted()`. Without all of them it returns
  false, so no other state or page (a reused viewer has no installers) can quit the app or
  relaunch it in a loop; after a relaunch the new window is bound and permitted, so the
  button is gone. When it is refused, Settings says "Agent Inbox didn't restart. If agent
  setup is running, try again when it finishes." rather than leave a dead button. It then
  calls `beginAppQuit()`, `app.relaunch()` and `app.quit()`; the next start reuses the
  verified download after re-hashing it. (6) `refuseInstall()` stays the backstop for a
  click that races a revoke; its `install-failed` is marked as main's refusal of the window,
  and once that window may install again `refreshInstallPermission()` publishes the
  `verified` download again instead of a stale "restart" beside a working Try again. An
  install's own failure keeps its reason. (7) Setup's renderer asks `available()` once per
  page and again when Settings opens: `agent-inbox:install-available` first awaits
  `installBinding.settled()` (a re-proof in flight, which resolves once its grants are
  applied), and Settings re-asks on open, adding the one-click install and Update agents
  when main now allows them (a window only loses Setup to a new page or a quit, so this
  never takes away a menu that may be running). A main-frame navigation that never commits
  leaves the window revoked until its next load, with the same honest copy. None of it
  enters `public/attention.js`, badges or Needs-you.
