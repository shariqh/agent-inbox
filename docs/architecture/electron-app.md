---
paths:
  - "electron/main.cjs"
  - "electron/setup-runner.cjs"
  - "electron/viewer-navigation.cjs"
  - "electron/terminal-launch.cjs"
  - "electron/chat-resume.cjs"
  - "electron/mesh-process.cjs"
applyTo: "electron/main.cjs,electron/setup-runner.cjs,electron/viewer-navigation.cjs,electron/terminal-launch.cjs,electron/chat-resume.cjs,electron/mesh-process.cjs"
---

# Electron app: window install binding

How Setup, update installs, local file links and the mesh bridge are granted to the app's own viewer window (#216).

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

**Resume a chat in Terminal (#586 PR 3).** The chats' Resume (Find's Chats chip) (`electron/chat-resume.cjs`; the
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
- **Beside driven sessions (#586 phase 2).** With the switch on (main's `launchEnabled`, read on each
  resume), it also reads a Copilot chat through the viewer's `GET /api/chats/copilot/:id` and refuses
  one a launch of this app holds, and, before that read, one Continue here… is starting now
  (`isContinuing`, the launch controller's read-only accessor; no controller made means none is).
  With the switch off it reads nothing new and asks nothing.

**Continue a chat here (#586 phase 2).** `agent-inbox:launch-continue-chat` is one more launch
channel: exactly one argument, behind the `launch` grant like every other launch action, and
`agentInboxLaunch.continueChat` in the preload sends a fresh object of `tool`, `id`, `mode`, `prompt`
and `startId`. Main reads the chat, its folder, title and project through the viewer and confirms in
its own dialog; the page names no folder, argv or env. `homeDir` (`app.getPath('home')`) is what main
matches the shell's `COPILOT_HOME` against. The flow and its refusals are in `driven-sessions.md`
("Continue a chat … part 2").

**The mesh bridge (agent setup in the app, step 2a).** `agentInboxMesh` lets the local page ask main
to run one of a fixed list of `meshctl` operations, so the app can set up model servers and local
agents with the same command a person would type, as a dry run first. Nothing on the page uses it
yet. The rule: the page never supplies a command, a path or a secret, and `meshctl` stays the only
writer of the mesh folder, with all of its own checks.

- **What runs.** The program the person's own shim names, `<mesh dir>/bin/meshctl` (the mesh dir by
  `meshctl`'s rule: an absolute `AGENT_INBOX_MESH_DIR`, else the folder of `AGENT_INBOX_DB`, else
  `~/.agent-inbox`; a relative `AGENT_INBOX_DB` is refused as `environment`). Main never executes the
  shim's shell text. It reads the shim again for every run, without following a link: a regular file
  of this user's with no group or other write bit, at most 4 KiB, whose first four lines are exactly
  the installer's (`#!/bin/sh`, the marker with `kind=runtime|checkout`, `node='…'`, `meshctl='…'`,
  each path absolute and single-quoted with no quote, backslash, `$`, backtick or control
  character), and both paths regular files. Then it spawns that node with `[meshctl.js, …argv]`:
  `shell: false`, its own process group, `cwd` the person's home, stdin closed, an environment of
  only `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and an
  absolute `AGENT_INBOX_MESH_DIR` or `AGENT_INBOX_DB`. A run is stopped after 30 seconds (SIGTERM,
  then SIGKILL 10 seconds later, as Setup) or once stdout passes 256 KiB; stderr is drained and
  never kept. The terminal and the app run the same program, so a setup made in the app and one
  typed by hand cannot differ.
- **The fixed operations** (`OPERATIONS` in `electron/mesh-process.cjs`), each exactly one argv; a
  writing one takes `apply` (false is the dry run, true adds `--apply`): `servers` (`server list
  --json`), `check-server { name }`, `add-server { name, baseUrl, key }`, `adopt-server { name, from }`
  (`server add <name> --from <agent> --move`), `set-server { name, baseUrl?, key? }`,
  `remove-server { name }`, `enable-model-agent { agent, server, model }` (`unslop` or
  `unslop-code`), `enable-request-post { endpoint, token }` and `disable { agent }` (never
  `--purge`). Main checks every value before anything runs: exactly the operation's keys, a server
  name `^[a-z0-9][a-z0-9-]{0,39}$`, a model `^[A-Za-z0-9._:/-]{1,64}$`, an `http:` or `https:` URL
  with no credentials, space or control character and at most 2048 characters, `apply` a boolean,
  and no value starting with `-`. `meshctl` applies its own stricter rules after.
- **Answers.** The `--json` output is parsed and rebuilt field by field: a plan or apply is
  `{ ok, applied, steps, refused?, notes? }`, `servers` is `{ ok, servers: [{ name, baseUrl, key,
  agents }], inline, refused? }` with `key` one of `file|command|env|none`, and `check-server` is
  `{ ok, reachable, failure?, models, skipped, refused? }`. Strings are cut (a line at 4096
  characters, an address at 2048, a model at 64, a name at 40) and lists capped (32 steps, notes and
  servers, 50 models); unknown fields are dropped. Model names and step lines are plain text for the
  page to set as text. Anything else is `{ ok: false, reason }`, `reason` one word of a closed list
  (`REASONS`): `unavailable`, `invalid`, `handle`, `busy`, `setup`, `updating`, `quitting`,
  `unsupported`, `environment`, `not-installed`, `unsafe`, `unrecognized`, `stale`, `outdated`
  (exit 2 and no JSON: an older install without the command), `output`, `timeout`, `failed`,
  `cancelled`. The preload rebuilds every answer again against the same shapes.
- **Files by handle.** A key or token file is chosen in main's own picker on the window
  (`chooseFile('key' | 'token')`, one file, one picker at a time). Main keeps the absolute path under
  a random 16-byte hex handle and answers `{ ok, handle, name }`, `name` being the base name cut to 80
  characters. Handles live in memory, at most 16 (a 17th forgets the oldest), for 15 minutes, for
  their purpose only, and are all forgotten when the window loses its grant or a quit begins; a file
  chosen while that happened is discarded. An operation names a handle and main looks the path up;
  an unknown or expired one is refused as `handle`.
- **Who may call it.** Three channels, `agent-inbox:mesh-available`, `agent-inbox:mesh-run` (two
  arguments) and `agent-inbox:mesh-choose-file` (one), registered at the top level by
  `registerMeshIpc`, each with an exact arity, waiting for a re-proof in flight
  (`installBinding.settled()`), then answering only `linkSender(event)` on the window holding
  `meshWebContentsId`. The binding's `apply` sets that id from the file grant (the owned viewer), so
  a navigation, a reload, a crash or closing drops it, and `beginAppQuit()` clears it. `available()`
  is `{ available: true }` only while that holds, no quit has begun, no update installs and the shim
  passes; otherwise it carries the reason word.
- **One at a time.** The bridge has its own `createInstallGate()`: one run in flight (a second is
  `busy`), none while Setup runs (`installGate.running()`), an update installs or a quit has begun.
  `beginAppQuit()` stops a run in flight, and `before-quit` waits for it as for Setup. Setup and
  update installs are unchanged: they do not wait for a mesh run, which a quit stops.
- **Where it is absent.** The view showing another Mac's Inbox loads only `remote-preload.cjs`, which
  has no `agentInboxMesh`, and the three channels answer it exactly as a stranger
  (`test/main-ipc.test.ts`). Nothing is logged: no argument, path, address or output.

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

**Sharing with your other Macs (#617 PR 2d).** One self-contained block in `main.cjs` makes the hub's
remote-entry controller, on macOS and only for the viewer this app started and owns, starts it after
the window loads, and stops it on `before-quit` (waiting at most 5 seconds for its state store). Its
ten channels use the same gate as Settings → Links, and Open Agent Inbox at login is never touched by
a checkout build. Details: `remote-inbox.md`, "The hub's Settings panel".
