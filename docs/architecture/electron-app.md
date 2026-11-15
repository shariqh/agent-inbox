---
paths:
  - "electron/main.cjs"
  - "electron/setup-runner.cjs"
  - "electron/viewer-navigation.cjs"
  - "electron/terminal-launch.cjs"
  - "electron/chat-resume.cjs"
applyTo: "electron/main.cjs,electron/setup-runner.cjs,electron/viewer-navigation.cjs,electron/terminal-launch.cjs,electron/chat-resume.cjs"
---

# Electron app: window install binding

How Setup, update installs and local file links are granted to the app's own viewer window (#216).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

**A checkout build beside the installed app.** An unpackaged app defaults to port 4392
(`viewerPort()` in `electron/reuse.cjs`, #465); only the packaged app defaults to 4319, and
`AGENT_INBOX_PORT` overrides either. So `npm run electron` (or its old name `npm run electron:side`)
starts and owns its own viewer on the same inbox, and an in-progress feature can be tried without
quitting the installed app. Both apps may notify for the same new items while both run, and they share
one userData folder. Before #465 a checkout defaulted to 4319: an installed app opened while it ran
reused its viewer, so it had no update installers and no grants for the rest of its run, even after
failing over to its own server. A window that opened on a viewer it did not start still gets no
installers: the update controller publishes `available.installWithheld: 'unowned-viewer'` and Settings
says to quit and reopen Agent Inbox (see `updates.md`). Granting installs after failover would move
the binding below, so it needs a design pass first.

**Default window size.** The window opens at 1440 x 900, above the Dashboard's 1280px wide
breakpoint, clamped to the work area of the display the pointer is on (`defaultWindowSize()` in
`electron/window-size.cjs`, fed by `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`),
so it is never larger than that display. The size is not remembered and there is no minimum.

**Terminal of choice (#586).** Settings → Terminal (macOS, the owned viewer only; a browser draws
nothing) picks the terminal that Open in Terminal and Take over / Resume in Terminal open:
Terminal (the default) or iTerm2.

- **One module.** `electron/terminal-launch.cjs` maps (terminal, kind `folder` or `script`, absolute
  path) to `/usr/bin/open -b <bundle id> -- <path>`: argv only, never a shell string, the app named
  by bundle id (`com.apple.Terminal`, `com.googlecode.iterm2`) and never by display name, and no
  path that is relative or holds a control character. There is no AppleScript: the shipped app has
  only the `allow-jit` entitlement, so an `osascript` child would be refused or raise a macOS
  Automation prompt, and fixing that is a packaging change.
- **Where it lives.** A top-level `terminal` field in userData `link-preferences.json` (schema 1,
  same lock and tolerant reader; a link-rule write keeps it and a terminal write keeps the rules).
  The two channels `agent-inbox:terminal-setting` and `agent-inbox:terminal-setting-set` sit behind
  `handleLinkSettings`, so they answer only the owned viewer, and the setting is a fixed list. The
  renderer's value is checked against that list on every set, and main reads and checks the stored
  value on every launch: a missing, unknown or unreadable value means Terminal.
- **Grants unchanged.** Launches still go only through the launch channels (`isGranted`), and
  `launch-available` reports the chosen id (never a path) to the granted window, for the buttons'
  titles. Main's own Take over dialog names the chosen app, reading the choice once so the dialog
  and the open agree.
- **iTerm2 and a script.** iTerm2's own openFile handler asks "OK to run <script>?" (OK/Cancel,
  and it can be silenced in iTerm2), then types the script's path into a login shell, in a new tab
  of its current window (a new window only if iTerm2's advanced setting "Open files in new
  windows" is on; forcing a window needs AppleScript, which the app's entitlements rule out). The
  take-over script is unchanged. The dialog says iTerm2
  may ask.
- **Fallback.** If the chosen app is not installed, `open` exits on its own and the launch falls
  back to Terminal once; the result carries a `notice` ("iTerm2 could not be opened, so Terminal
  was opened instead.") that the page shows as the launch's note, since the launch worked. After
  a **timeout** (the runner's 10 s kill) nothing else opens: iTerm2 may still open late, and a
  second terminal on a take-over script would run two Copilots in one session. That is reported
  as "could not be opened".
- **Buttons.** The labels stay the generic words; the `title` and, for iTerm2, the `aria-label`
  name the app ("Open in Terminal (iTerm2)"), because a tooltip alone is not read on keyboard focus.

**Resume a chat in Terminal (#586 PR 3).** The Chats tab's Resume (`electron/chat-resume.cjs`; the
page, the refusals and the script are in `chats.md`).

- **Who may call it.** Two channels, `agent-inbox:chat-resume-available` (no argument) and
  `agent-inbox:chat-resume` (exactly one), registered right after the launch IPC and only on macOS:
  on any other platform neither channel exists. Each waits for a re-proof in flight
  (`installBinding.settled()`) and then answers only the owned viewer window's top frame on the viewer
  origin (`linkSender(event) && linkFilesPermitted(event)`, the check `launch-available` and Settings →
  Terminal use). Any other window, a browser, or a reused or failed-over viewer gets
  `{ available: false }` or the `unavailable` refusal, and the handler is never made. Nothing is
  accepted once a quit has begun.
- **What it can make happen.** At most one terminal at a time, opened by bundle id
  (`openInTerminal`, kind `script`, the launchers' `runTerminalCommand`) on a fresh 0700 file
  `<hub dir>/chat-resume/<tool>-<id>-<random>.command`. That script `cd`s to the folder the
  index records for a listed chat that is not live and was not opened in the last two minutes,
  and execs `claude --resume <id>` or `copilot --resume=<id>`.
- **What it cannot do.** The page names only a tool and an id from fixed patterns. It cannot name
  a folder, an executable, argv or env. It cannot resume a live chat, run any other command, or
  start, drive or approve for a session. It needs no driven-sessions switch, holds no `launch`
  grant and shows no dialog, because the person runs the tool's own interactive command in their
  own terminal, as with the copied command.

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
  is granted only while `setupInstallEnabled`, driven sessions (#412 step 3, the `launch` grant) only
  while `viewerOwned` with their switch on, on macOS (see `driven-sessions.md`), update installs and (#300) local file links
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
  leaves the window revoked until its next load, with the same honest copy, except one main
  cancels itself: Electron emits `did-start-navigation` before `will-navigate`, so the
  `will-navigate` handler calls `installBinding.navigationPrevented(url)` after
  `preventDefault()`, which re-applies the grants the still-shown page held when that same
  navigation started (never after a newer navigation, a crash, a close or a quit, and never to
  a page whose re-proof was still running). Without it, a dropped file or URL left file links
  copying their path until a reload (see `links.md`). None of it
  enters `public/attention.js`, badges or Needs-you.
