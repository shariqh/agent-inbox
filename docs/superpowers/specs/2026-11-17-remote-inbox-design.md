# Design: one Inbox from every device, over Tailscale (#617)

Status: proposed on 2026-11-17, not built. Part of #8. The owner chose the direction: one app and
one server. The hub stays the single source of truth, and the same desktop app on another Mac
connects to it. There is no database sync, and no agent reports to a hub on another machine. Where
the code made one of his calls wrong or harder than it looked, the text says "(my call)" and gives
the reason. §9 lists what the build must still settle.

## §0 Summary

The owner runs every agent session on one always-on Mac, the **hub**, in tmux sessions. Some are
also registered with Claude Code's Remote Control. He works from a laptop and a phone. The hub's
viewer listens only on loopback, so from the laptop he cannot see or answer anything, and
notifications show only on the hub's screen. This design adds four parts:

1. Each session records **where it runs**: machine, tmux session ("desk"), pane and Remote
   Control id. Cards show it.
2. A **remote entry** on the hub, off by default: a second loopback listener that serves only
   requests that Tailscale Serve forwarded from an allowed tailnet login **and** that carry the
   secret of a device the owner paired.
3. A **connect mode** in the desktop app: the laptop's app pairs once, then shows the hub's page in
   its own view, with none of the local app's privileged grants.
4. **Native parts against the hub:** the badge, notifications and their answer buttons use the
   hub, and **Open desk** opens a terminal on the session's tmux session.

Agents do not change. An answer written into the hub's database wakes its session by today's
local paths (the Stop hook, the answer watcher, channel push), however the write arrived.

What the code shows, before the design:

- **The loopback boundary is one module with fixed rules.** `startLocalViewer`
  (`src/viewer-network.ts`) binds `127.0.0.1`, accepts only loopback `Host` and `Origin` values,
  requires a trusted `Origin` on every unsafe method, and sets the CSP, `X-Frame-Options: DENY`
  and `x-agent-inbox-local-boundary: loopback-v1`. `docs/architecture/viewer-network.md` says not
  to add a host-widening environment variable and that "hosted auth is a separate entry".
- **The owner token is served to any client of its app.** With `ownerToken` set, `createViewer`
  (`src/viewer.ts`) registers `GET /api/owner`, which returns it. And "needs no owner token" is not
  "safe to expose": `POST /api/launches/:id/{stop,interrupt,park,hand-off,forget}` (forget deletes
  log folders), `GET /api/launches/:id/prompt`, `/api/launch-folders`, `/api/chats/copilot/:id`
  and `/api/setup` (install paths and commands) check no token, safe only behind loopback.
- **The window's grants are bound to one origin.** Every privileged IPC checks the sender's frame
  against `URL_BASE` (`isTrustedLinkSender`, `electron/link-open.cjs`), grants are re-proved after
  every load (`createInstallBinding`, `electron/setup-runner.cjs`), and the window's preload
  (`electron/setup-preload.cjs`) exposes every bridge to any page loaded in that window.
- **Main reads only the loopback viewer.** `startAttentionWatch(win)` (`electron/main.cjs`) polls
  `${URL_BASE}api/items?scope=attention` and three more routes every 3 seconds.
  `submitNotificationResponse` (`electron/reply-watch.cjs`) builds `${urlBase}${path}` with no
  slash between them, sets `Origin` from the base, and takes a `fetchImpl`, as
  `createConditionalReader` (`electron/conditional-read.cjs`) does.
- **Presence carries host facts, kept on omission.** `buildMcpServer` (`src/mcp.ts`) spreads
  `build` and `host()` into every `upsertActivity` write, and `upsertActivityTxn` (`src/store.ts`)
  keeps each with `COALESCE`. The liveness tick must stay one call (`livenessTick`;
  `test/live-tick.test.ts`, #45).
- **A switch the viewer reads already lives beside the hub, but its reader is too loose to copy.**
  `meshDir` (`src/mesh-config.ts`) puts `mesh.json` beside an `AGENT_INBOX_DB` hub, "so a scratch
  hub never reads the real home's switch". `readMesh` checks type and size after an `lstat`, then
  reads by path, with no owner or mode check. Main's own switches live in userData under
  `createLockedFile` (`electron/update-preferences.cjs`), and a checkout build and the installed
  app share that folder. `inTailnet` (`src/mesh-config.ts`) and `suffixFrom` (`src/meshctl.ts`)
  already keep meshctl's endpoints inside this Mac's tailnet.
- **Main can already open a script in a terminal, and web links already leave safely.**
  `writeChatScript` (`electron/chat-resume.cjs`) writes a 0700 file with `O_EXCL | O_NOFOLLOW`;
  `openInTerminal` (`electron/terminal-launch.cjs`) opens it by bundle id, argv only. The
  window's `setWindowOpenHandler` and `will-navigate` hand http(s) URLs to `openWebLink`.

## §1 What is wrong today

- From the laptop the owner cannot see or answer questions, plan rows or messages, and
  notifications and the dock badge exist only on the hub's screen.
- A card does not say which machine or tmux session holds the agent, so even on the hub, getting
  to the session means hunting through tmux.
- 2.11.0's **Jump to session** in the Chats tab opens the session card. The owner expected it to
  open the terminal.

## §2 Goals, non-goals, anti-goals

Goals: (1) from the laptop, see and answer every session's questions, plan rows and messages,
one-click options included, and the answer wakes the session; (2) know which machine, desk and
session a card belongs to, and open it in one click; (3) get notified on the device in use;
(4) keep working across laptop sleep, network changes and hub restarts; (5) stay inside the
tailnet, and allow more than one hub later; (6) never make the owner think about which machine
an answer goes to.

Non-goals in this slice: phone access and notifications; a merged view over several hubs; agents
on the laptop reporting to the hub.

Anti-goals: database sync; a listener on any address but `127.0.0.1`; any change to
`startLocalViewer`'s rules; the app running `tailscale serve` or changing Tailscale settings; a
remote page holding any privileged grant or able to read the device secret; an owner token
reachable over the tailnet; Tailscale identity as the only credential.

## §3 The design

### 3.1 Where a session runs (PR 1)

**Fields.** Four new nullable `activity` columns, added by `ensureColumn`:

| Column | Source | Accepted when |
|---|---|---|
| `machine` | `AGENT_INBOX_MACHINE`, else `os.hostname()` up to the first `.` | matches `/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/` |
| `desk` | `tmux display-message -p -t <pane> '#{session_name}'` | `TMUX` and `TMUX_PANE` set, and the output matches `/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/` |
| `pane` | `TMUX_PANE` | matches `/^%[0-9]{1,6}$/` |
| `remote_session` | `bridgeSessionId` in the host's `~/.claude/sessions/<host pid>.json` | the file's `pid` is the host's, and the value matches `/^session_[A-Za-z0-9]{1,64}$/` |

A value that fails its pattern is not stored. It is not trimmed or cut. No accepted name starts
with `-`, so none can read as an option where a command uses it (my call).

**Why not the environment for the Remote Control id.** On a hub with eight live Claude Code
sessions, every live file carried `bridgeSessionId`, but only one of seven MCP servers had
`CLAUDE_CODE_BRIDGE_SESSION_ID`: the server starts before the session registers for Remote
Control. So the server reads the host's live file, the one `parseClaudeLiveFile`
(`src/chat-parse.ts`) already reads, by `process.ppid`.

**Reading.** A new `src/session-place.ts`, Node core only, with no network import, so it may enter
the MCP graph. `readPlace(env)` returns `{ machine?, pane? }` once at start.
`readRemoteSession(home, hostPid)` opens `<home>/.claude/sessions/<hostPid>.json` with
`O_NOFOLLOW`, requires a regular file this user owns of at most 16 KiB, and returns the checked
`bridgeSessionId` or null; any error means null. It is read for a Claude Code host only.
`readDesk(pane)` runs `execFile('tmux', ['display-message', '-p', '-t', pane,
'#{session_name}'], { timeout: 1000, maxBuffer: 1024 })` asynchronously and resolves the checked
name or null. A missing `tmux`, a timeout or any error means null.

**Writing.** `machine` and `pane` never change while the server runs. `place()` sits beside
`host()`, is spread into all three `upsertActivity` calls, and those two columns are kept on
omission with `COALESCE`. `desk` and `remote_session` can change or go away, so the upsert never
names them. **(My call:** the owner asked for the re-read on the liveness tick, but the tick must
stay one call (#45).) A second `unref()` timer runs `refreshPlace`: once before the first
registration, again 30 seconds later (Remote Control may register just after the server starts),
then every five minutes. When either value differs from the last one written, it calls
`setActivityPlace(db, session, { desk, remote_session })`. That is one `UPDATE` that writes the
exact values, nulls included, with no `COALESCE`, and touches neither `updated_at` nor
`last_call_at`. A tmux session renamed or closed therefore never leaves a stale name that Open
desk would attach to.

**Serving.** `listActivity` selects the four columns, and `/api/activity` serves each one only when
it is set. `/api/version` gains `machine`, the viewer process's own short host name by the same
rule, so a connecting app knows which machine the hub is (§3.4). An older server's statements do
not name the new columns, so they stay null for its sessions.

**The page.** A new pure module, `public/place.js`: `placeLine(row)` gives "machine · desk",
"machine" or ""; `claudeSessionUrl(row)` gives `https://claude.ai/code/<remote_session>` after
re-checking the pattern, or ""; and `attachCommand(row)` gives `tmux attach -t '=<desk>'`. The
`=` asks tmux for an exact name, so "api" never attaches to "api2", and the quotes stop zsh
reading a word that starts with `=` as a command path (my call). The session card
(`public/agents-home.js`) and the session panel (`public/app.js`, `.dash-focus-meta`) show
`placeLine`, and the panel adds two controls:

- **Open in claude.ai**, when `remote_session` is set. It passes the link rules because it is
  built only from a pattern-checked value, never agent text, through `safeHttpUrl`
  (`public/source.js`). As an ordinary `target="_blank"` link it reaches `openWebLink` through
  `setWindowOpenHandler`, or opens a tab in a plain browser.
- **Copy attach command**, which copies `attachCommand(row)`.

Agent text is still set with `textContent`. This PR is useful on the hub on its own.

### 3.2 The remote entry on the hub (PR 2a and 2b)

**Where the setting lives (my call):** `remote.json` beside `inbox.db` (the folder of
`AGENT_INBOX_DB`, else `~/.agent-inbox`; `AGENT_INBOX_MESH_DIR` does not move it), not in userData. The viewer process must read it, and a dev build's viewer child does not
know the userData path; a checkout build and the installed app share userData, so a switch there
would leak between a scratch run and the real one. A scratch hub gets its own file, as
`mesh.json` does, and no environment variable is added.

```json
{ "schema": 1, "enabled": true, "viewerPort": 4319, "port": 4320,
  "host": "hub.example.ts.net", "logins": ["owner@example.com"],
  "devices": [{ "id": "3f9c0a1b2d4e5f60", "label": "laptop",
                "secretSha256": "<64 hex>", "pairedAt": "2026-11-20T09:00:00.000Z" }] }
```

**Writers.** Main writes `enabled`, `host`, `port`, `viewerPort`, `logins` and device removals.
The viewer process writes one thing: a device it has just paired (below). Both use
`createLockedFile` (the viewer `require`s the `.cjs`, as `src/viewer.ts` already requires
`electron/runtime-verify.cjs`): temp file and rename under the same cross-process lock, unknown
fields kept, a newer schema read as off and never overwritten. The file is written `0600`.

**The reader.** A new `readRemoteSetting(file)` in `src/viewer-remote.ts`, not `readMesh`. It
opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstat`s the open descriptor, requires a regular
file owned by this user with `mode & 0o077` zero and at most 64 KiB, reads from that descriptor,
and parses a JSON object with `schema: 1`. Anything else means off. Then: `host` matches
`/^[a-z0-9-]+(\.[a-z0-9-]+)+$/` after lowercasing and its last label holds a letter (so an address
such as `127.0.0.1` is refused); `logins` holds 1 to 16 strings of 1 to 254
characters with no control characters; `devices` holds at most 16 entries, each with a
16-hex-character `id`, a `label` of 1 to 40 characters and a 64-hex-character `secretSha256` (a bad
entry is dropped, never turning the rest off); `port` is 1024 to 65535 and not `viewerPort`, by
default 4320 for the packaged app and 4393 for a checkout build, mirroring `viewerPort()` (my call).

**Who opens it.** `src/viewer-remote.ts` is viewer-process-only and separate from
`src/viewer-network.ts`, which does not change. `viewer-server.ts` calls
`startRemoteEntry({ app: remoteApp, dir, viewerPort: port })`. A setting cache `stat`s the file on
every request and on a 5-second timer, and re-reads only when the `stat` changed. The listener
opens when `enabled` is true and `viewerPort` is the viewer's own port, so a checkout's viewer on
4392 never binds beside the installed one. When the setting turns off for any reason, the entry
calls `server.close()` and `server.closeAllConnections()`, so no kept-alive connection outlives
it. A bind failure is logged once and shown in the status route.

**What it serves (my call).** `remoteApp` is a **second** `createViewer(db, { mesh })` built
without `ownerToken`, so `/api/owner` does not exist on it (`createViewer` starts no timers). The
gate serves an explicit **allowlist**, `REMOTE_ROUTES`, exported for a test. Its rule, applied the
same way to every route: a route is **allowed** only when the page needs it to show or answer the
Inbox. It is **refused** when it acts on the hub's processes or files, hands out a credential, or
belongs to setup or launching, which only make sense at the hub. `GET /api/chats` (each chat's
folder, Copilot's automatic titles), `GET /api/mesh/agents` (endpoint and fix hints) and
`GET /api/mesh/agents/runs` (a forget command) carry the owner's own hub-side details (a folder
path, command hints) to the owner's paired device, by decision.

| Method | Allowed paths |
|---|---|
| GET (and HEAD) | static files (any path outside `/api/`); `/api/items` (both scopes), `/api/items/history`, `/api/boards` (both scopes), `/api/boards/archived`, `.../summary`, `.../plans`, `/api/activity`, `/api/activity/history`, `/api/version`, `/api/links`, `/api/issues`, `/api/messages`, `/api/projects/closed`, `/api/chats`, `/api/mesh/agents`, `/api/mesh/agents/runs` |
| POST | `/api/items/:id/{resolve,acknowledge,dismiss,annotate,reply,snooze,stop-waiting,later}`; `/api/boards/:id/{archive,unarchive}`; `/api/boards/:id/rows/:rowId/{annotate,snooze,stop-waiting,later,handled}`; `/api/projects/{close,reopen}`; `/api/sessions/:session/messages`; `/api/messages/:id/withdraw`; `/api/mesh/agents/refresh` |

Refused by the rule: `/api/owner`, `/api/setup`, every `/api/launches…`, `/api/launch-asks…`,
`/api/launch-folders`, `/api/chats/copilot/:id`, and any later route until it is classified.
`POST /api/mesh/agents/refresh` is allowed: `public/app.js` posts it whenever an agent tab opens.
Requests' `GET /api/requests` and `POST /api/requests/:id/close` (2026-11-15 design, PR 4) are
added by whichever PR lands second.

**The gate, in order.** Each refusal is `403` with the body `Forbidden`, the same body the
loopback entry sends, and no marker. The reason goes only into a counter.

1. `Host`, lowercased, must be `host` or `host:443`.
2. A request with a `Tailscale-Funnel-Request` header is refused. Serve sets it only on Funnel
   traffic and strips it from clients, so this is a second lock on public traffic.
3. `Tailscale-User-Login` must be present and equal one of `logins`, ignoring case.
4. **Path form.** The request target as received (`c.env.incoming.url` from `@hono/node-server`)
   must contain no `%` and no `\`, no `//`, no `.` or `..` segment, and must be byte-equal to the
   path Hono routes on (`c.req.path`). An `/api/` path may not end in `/`. **(My call:** `%` is
   refused anywhere, not only under `/api/`, because `/%61pi/setup` is not under `/api/` until
   decoded; no file in `public/` has `%` in its name.)
5. An `Origin`, when present, must equal `https://<host>`.
6. On every method, `Sec-Fetch-Site`, when present, must be sent once and be `same-origin` or
   `none`; an unsafe method also needs that `Origin`. **(My call:** `same-site` is dropped. On a
   tailnet, same-site means another node's Serve page, and step 5 already refuses it. Safe methods
   are checked too: once the laptop app adds the device header by URL filter, a no-cors GET from
   another page in that session would carry it.)
7. `POST /api/remote/pair` goes to the pairing handler below. It is the one route that passes
   with the login alone.
8. **Device.** `X-Agent-Inbox-Device` must hold 43 base64url characters. Its SHA-256 is compared
   with every paired device's `secretSha256` by `crypto.timingSafeEqual`, all of them, with no
   early exit. No match is refused.
9. The method (`HEAD` read as `GET`, as Hono routes it) and `c.req.path` must match
   `REMOTE_ROUTES`.

Accepted responses get `Cache-Control: no-store`, the same CSP and `X-Frame-Options: DENY`, and
`x-agent-inbox-remote-boundary: tailnet-v1`. They never get the loopback marker, so a reuse probe
(`classifyReuse`) can never mistake port 4320 for a viewer.

**Pairing.** On the hub, Settings → **Add a device** asks main for a code, and main asks the
loopback-only `POST /api/remote-entry/code`, which needs the owner token in a header.

- The viewer process makes the code: 50 random bits as 10 Crockford base32 characters in two
  groups of five (`7K3QX-9M2PD`), short enough to type from one Mac to the other. It is kept only
  as a SHA-256 in memory, valid 10 minutes, used once, void after 5 wrong tries, and voided by a
  new code or a viewer restart. Its strength is the five tries, not its length: there is nothing
  to attack offline, and five guesses at 50 bits succeed about once in 2 × 10^14.
- The connecting Mac's main posts exactly `{ code, label }` (case, spaces and dashes ignored) to
  `POST /api/remote/pair` with `Origin: https://<host>`. The handler takes at most 10 requests a
  minute, refuses with no code pending, counts a wrong code, and on a match makes a random
  32-byte secret and a 16-hex-character id, writes the device under the lock, voids the code, and
  answers `{ ok: true, device: id, secret: <base64url> }` once, with the marker header.
- The hub stores only the SHA-256: a slow key-derivation function adds nothing for a random
  256-bit value, and matters only for secrets a person chose. Settings lists paired devices with
  **Remove**, which main writes; a removed device's next request fails step 8.

**Status, loopback only.** `viewer-server.ts` adds `GET /api/remote-entry` to the loopback app
before the static route. It returns `{ on, listening, port, host, error, codePending, paired:
[ids paired since start], refused: { host, funnel, login, path, origin, device, route, pair } }`,
counts since the viewer started. It never shows a login, a secret or a header value, and it is not
on the remote allowlist.

**Trust basis, stated plainly.**

- The listener binds `127.0.0.1` only. Serve terminates HTTPS inside the tailnet and forwards to
  `http://127.0.0.1:<port>`. It deletes any `Tailscale-User-Login`, `-Name`, `-Profile-Pic`,
  `-Headers-Info` and `-Funnel-Request` header the client sent, then sets the source node's user
  login, and none for a tagged node or for Funnel.
- Serve takes the login from the source address, so anything whose traffic leaves through one of
  the owner's untagged devices arrives as the owner: a container or VM on the laptop, a LAN device
  behind his subnet router, any machine he is logged into, and a user who accepted a share of the
  hub has a login too. So the login is a first check, and the **device secret** is the credential.
- A local process on the hub can forge every header on the loopback port, but it can already use
  the fully trusted loopback viewer.
- **Residual risk:** a process running as the owner's user on a paired Mac that can drive the app
  or read its Keychain item is the owner, the same trust the local viewer gives a local process.

**Messaging is allowed.** `POST /api/sessions/:session/messages` is on the list. The owner's
sessions may run without permission prompts, so a message is a command to an agent that may act
without asking. That is the owner's accepted risk, the same one Remote Control carries, and the
Settings text says so.

**Serve's shape, checked by main.** The viewer process never runs Tailscale. Main does, in a new
`electron/remote-entry.cjs`: `tailscaleCli()` returns the first fixed path that exists
(`/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`,
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`), run with argv only and a 5-second
timeout. `serveState(host, port)` reads `tailscale serve status --json` and answers `ok` only when
there is exactly one web handler for `host:443`, at path `/`, proxying to
`http://127.0.0.1:<port>`; no other path on `host:443` (it would share the Inbox's origin and pass
the `Origin` check); no TCP or TLS-terminated forward to `<port>` (it would hand client-sent
headers straight to the gate); and no Funnel on `host:443`. Main checks before it writes `enabled: true`, at app start, on **Test**, and every 60 seconds while
the entry is on. A read that fails is tried once more after 5 seconds. Any other answer: main
writes `enabled: false` (the viewer then closes the listener), shows a native notification ("Agent
Inbox stopped sharing with your other devices: Tailscale Serve is not set up as expected") and
puts the reason in the status line. Whenever the switch is off and a Serve configuration for that
port exists, the panel shows the command that removes it, `tailscale serve --bg <port> off`, because
a `--bg` configuration outlives the switch.

**Changes made behind the app's back.** An agent on the hub can edit `remote.json`. It already
controls the hub, so the risk is that the exposure is silent. Main keeps the SHA-256 of the
`enabled`, `host`, `port`, `logins` and `devices` values it last wrote, and stats the file every 5
seconds. A device the viewer reports in `paired` after a code main asked for is expected, and
still gets a native notification ("<label> was paired with this Inbox"). Any other difference
gets a native notification ("Agent Inbox's sharing settings were changed outside the app") and a
flag on the Settings panel until the owner presses **Review** and confirms or reverts.

**The hub's Settings** ("Let my other devices use this Inbox", macOS, owned viewer only) use a
bridge, `agentInboxRemoteEntry` in `setup-preload.cjs`, gated like `handleLinkSettings`
(`linkSender(event) && linkFilesPermitted(event)` after `installBinding.settled()`); a reused
viewer gets `{ available: false }` and is told to quit and reopen. `tailnetSelf()` reads `tailscale status --json` for this node's
`Self.DNSName` (trailing dot dropped) and `User[String(Self.UserID)].LoginName`; a tagged hub has
no user login, so the list starts empty and the switch stays off until a login is added.
`selfTest()` fetches `https://<host>/api/version` from main with no device secret. It passes when
the answer is a 403 and `/api/remote-entry` shows the `device` count rose: that proves Serve, the
`Host` and the login all reached the gate. A rise in `host` or `login` names the problem.

The panel shows, top to bottom: the switch; the risk sentence; the one command to run in Terminal,
`tailscale serve --bg 4320`, with Copy (the app never runs it); the address; the allowed logins
with Add and Remove; **Add a device** and the paired devices with Remove; the status line and any
"changed outside the app" flag; **Test**; the removal command when it applies; and **Open Agent
Inbox at login**, which is `app.setLoginItemSettings({ openAtLogin })` read back with
`getLoginItemSettings()`, the app's own setting.

### 3.3 Connect mode in the desktop app (PR 3)

**Settings, keyed by hub.** On the connecting Mac, Settings → "Use another Mac's Inbox" (macOS,
owned viewer only) uses a bridge, `agentInboxConnect`, with the same gate. Main's new
`electron/remote-connect.cjs` keeps userData `remote-connect.json` with `createLockedFile`:
`{ schema: 1, active: <id> | null, hubs: { <id>: { origin, label, node, machine, device, secret,
sshHost, template } } }`, `id` a random 8-hex-character key. One hub at most here, but every
hub-specific value is keyed by `id`.

- `origin` must parse as `https:`, with no user, port, path (other than `/`), query or hash.
  Its host must pass `inTailnet(host, suffix)`, with the suffix from `suffixFrom` on this Mac's
  `tailscale status --json`, and must be the `DNSName` of a peer in that output whose `UserID` is
  `Self.UserID` and that carries no tags. That peer's `StableID` is saved as `node`; a later
  connect or reconnect that finds another node for the name is refused. Main loads both helpers
  from the built `dist/` modules by dynamic import, as it already imports `public/attention.js`.
- `label` is 1 to 40 characters with no control characters. `sshHost` must match
  `/^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,252}$/`, so it can never start with `-`.
- `secret` is the device secret encrypted with `safeStorage.encryptString` (Keychain-backed on
  macOS) and stored as base64. It is never in plain userData, never sent to any page, and never
  logged. Without `safeStorage.isEncryptionAvailable()`, connect is refused.
- `template` is covered in §3.4.

**Connect.** The form takes the address, a label and the pairing code. Main checks the address as
above, then posts the code to `/api/remote/pair` with Node's `fetch` (which validates the
certificate) and a 5-second timeout. The answer must be a 200 with
`x-agent-inbox-remote-boundary: tailnet-v1` and `{ ok, device, secret }`. Main saves the
encrypted secret, then calls `probeHub`, which fetches `/api/version` with the device header and
accepts only a 200 with the marker and a body with `current` and `machine`; `machine` is saved.
The marker is a sanity check, not proof: the tailnet check, the certificate and the secret are.
Failures read as one of: not in your tailnet, not one of your devices, cannot reach, certificate
not valid, not an Agent Inbox remote entry, code refused, or refused by the hub (this Mac is not
paired, or its login is not allowed).

**The device header.** Main adds `X-Agent-Inbox-Device` itself, in two places only: its own
fetches, through one `hubFetch(hub)` passed as the `fetchImpl` of `createConditionalReader` and
`submitNotificationResponse`; and every request the hub view makes, through
`session.webRequest.onBeforeSendHeaders` on that view's partition, filtered to
`https://<host>/*` with the origin checked again in the handler. Page script never sees request
headers, so it cannot read the secret.

**The view (my call).** A preload is fixed for each `webContents`, and the window's preload
exposes every privileged bridge. So the hub is shown in its **own** `WebContentsView` laid over
the window's content, with:

- `preload: electron/remote-preload.cjs`, `contextIsolation`, `sandbox: true`,
  `nodeIntegration: false`, and `partition: persist:hub-<id>`, so its storage, cache, headers and
  permission handlers are its own;
- `setPermissionRequestHandler` and `setPermissionCheckHandler` that allow only
  `clipboard-sanitized-write`, and only for the hub origin, so Copy works, and deny the rest;
- `will-navigate` and `will-redirect` allowed only when `isViewerUrl(url, origin)`, else
  prevented and handed to `openWebLink`; `setWindowOpenHandler` → `openWebLink`, but only while
  the view has focus and its last input event (`before-input-event`) is under 5 seconds old;
- `will-download` cancelled for every item in the partition;
- none of today's grants (Setup, updates, file links, launch, chat resume, Settings → Links). The
  install binding is never attached to it.

The local page stays loaded underneath and keeps working. **This Mac** and **<label>** items in
the View menu, plus a control the local page draws through `agentInboxConnect.show(id | null)`,
switch which view is on top. `Settings…` always shows This Mac, where connect settings live.

**The bridge.** `remote-preload.cjs` exposes exactly one object, `agentInboxDesk`:
`available()` → `{ open: boolean }`; `open({ session })` → `{ ok }` or `{ ok: false, reason }`
(§3.4); `connection()` → `{ mode: 'hub', label, state: 'online' | 'retrying' | 'refused',
version }`; and `onConnection(cb)`, which returns an unsubscribe function. Main answers a channel
only when the sender is that view's top frame and its URL is on the hub origin, checked on every
call. So after any redirect off the origin, the bridge is inert. The page feature-detects every
member, so an older or newer shell still works. `setup-preload.cjs` gains the same
`agentInboxDesk`, with `connection()` answering `{ mode: 'local' }`.

**When the hub cannot be reached.**

- With no hub page loaded, the view loads the shipped `electron/remote-offline.html` ("Can't
  reach <label>", with **Retry**, which the bridge accepts only from that file's URL).
- A hub page already loaded stays (my call), so drafts survive a short drop: main publishes
  `retrying`, the page shows a one-line banner, and its own poll recovers by itself.
- Main retries `probeHub` with backoff (2 s, doubling to 60 s), and at once on `powerMonitor`
  `resume` and `unlock-screen` and when `net.isOnline()` turns true (main has no network-change
  event). When the hub answers, main loads the hub page if the offline file shows, and reloads
  the view if `/api/version.current` changed. The page always comes from the hub, so it never
  drifts from the hub's server.
- A 403 from `probeHub` is `refused`: the offline page says "<label> no longer accepts this Mac"
  with **Pair again**, and retries stay at 60 seconds.

### 3.4 Native parts against the connected hub (PR 4)

**Attention, per source (my call).** `startAttentionWatch(win)` becomes
`createAttentionWatch({ base, fetchImpl, label, show })`, run once for This Mac and once for the
active hub, so local asks do not go silent and a multi-hub view has its shape. The dock badge is
the sum, a notification names the hub's label when two sources run, and a click calls `show()`,
which brings that view forward and sets `location.hash` in it.

- The answer button calls `submitNotificationResponse(base, target, text, hubFetch(hub))` with
  `base` the hub origin **with a trailing slash** (`https://hub.example.ts.net/`), because the
  function joins base and path with no slash. The `Origin` it sets is the hub origin.
- `known` is per source, so a reconnect announces nothing old. `runWakeAdapter` runs only for
  This Mac: the hub's own app runs one for the hub.
- Both Macs notify for a new ask on the hub: the hub cannot know which device the owner is at,
  and its screen is usually unattended. An answer on either clears it on the other.
- The predicate is the laptop's own `public/attention.js` applied to the hub's data, so Settings
  shows "This Mac runs 2.13.0, the hub 2.12.0" when the releases differ.

**The terminal command.** It is shell text that main will run, so it is set only by main. The
page sends a proposed `sshHost` and template; main shows the exact command, filled for an example
desk, in a native `dialog.showMessageBox` ("Agent Inbox will run this in Terminal when you press
Open desk"), and saves only if the owner confirms. The page can never set either silently. A
template is one line of at most 512 characters with no control characters, and uses only these
placeholders; any other `{…}` is refused:

| Placeholder | Becomes | For |
|---|---|---|
| `{host}` | the hub's `sshHost`, bare (its pattern has no shell character) | `ssh` |
| `{desk}` | the bare, pattern-checked name | a shell function that takes a name |
| `{target}` | `'=<desk>'`, one single-quoted word | `tmux attach -t {target}` |
| `{attach}` | `tmux attach -t '=<desk>'`, quoted once more as one word | `ssh -t {host} {attach}` |

`{attach}` is quoted twice because `ssh` joins its arguments and the remote shell parses them
again. Defaults: for a hub `ssh -t {host} {attach}`; for This Mac `tmux attach -t {target}`.
`{pane}` is not offered: selecting a pane on attach moves every attached client.

**`openDesk({ session })`.** In `electron/desk-open.cjs`:

1. The page names only `session`, which must match the lowercase UUID pattern, else
   `bad_request`. The calling view must have focus and an input event under 5 seconds old, else
   `no_gesture`. At most one open per 2 seconds and three per minute, else `busy`.
2. The source is the **sender**: a call from the hub view reads that hub's `/api/activity`
   through `hubFetch`; a call from the main window reads This Mac's `URL_BASE`. Never "the
   active" one. Main finds the row itself; it never takes `machine` or `desk` from the page. No
   row gives `not_found`, and no `desk` gives `no_desk`.
3. It checks `machine` and `desk` again against §3.1's patterns. For a hub, `machine` must equal
   the one saved at connect, else `not_on_hub`. For This Mac, it must equal this Mac's, else
   `not_here`.
4. It fills the template by the table. `{host}` needs `sshHost`, else `no_ssh_host`.
5. It writes `#!/bin/sh` plus `exec <login shell> -l -i -c <quoted command>` through a
   `writeChatScript` generalised to a `desk-open/` folder beside the hub. The login shell is
   `os.userInfo().shell` when it is absolute and listed in `/etc/shells`, else `/bin/zsh`.
   **(My call:** `-i` as well as `-l`. A shell function is usually defined in `.zshrc`, which a
   login shell alone does not read.)
6. It opens the script with `openInTerminal({ terminal, kind: 'script' })`, using Settings →
   Terminal's choice and its fallback.

On the hub itself the same button runs the This Mac template, stored under the key `local`, behind
the owned-viewer gate, as chat resume is.

**Where Open desk appears:** on the session card next to the meta line; in the session panel next
to Open in claude.ai; and in the Chats tab next to **Jump to session**, for a live chat whose
session has a desk. Jump to session keeps its meaning, which is to show the card; Open desk is the
terminal. The button shows only when `agentInboxDesk.available()` says `open`; elsewhere Copy
attach command stands in.

### 3.5 Coming back by itself

The hub app opens at login, and its viewer reads `remote.json` at start and reopens the remote
entry. A `--bg` Serve configuration persists across a reboot and `tailscale down` and `up`. The
laptop follows §3.3's retry rules, and its secret survives restarts in the Keychain-backed store.

**Still needs a person:** after the hub restarts, its user must log in before the app or tmux
runs, and with FileVault on macOS needs the password at boot. Agent sessions and their tmux
sessions do not survive a restart. Keeping the hub awake is a system setting the app never touches.

### 3.6 Safety

| Case | Result |
|---|---|
| Setting off, or file missing, unreadable, a symlink, not the user's, readable by others, or a newer schema | no second listener |
| No login header (tagged node, Funnel, local tool), or a login not in the list | 403 |
| The right login, with no device secret, a wrong one, a removed device's, or a made-up one sent straight to the loopback port with a forged login | 403 at the device step |
| A wrong `Host` (rebinding, a direct `127.0.0.1:4320` request); a cross-origin POST; `Sec-Fetch-Site: same-site` or `cross-site` | 403 |
| `%`, `\`, `//`, dot segments or a trailing `/` on an `/api/` path (`/%61pi/setup`); `HEAD` on a refused route | 403 |
| `/api/owner`, `/api/setup`, any launch route, `/api/chats/copilot/:id` | 403 |
| A route added to `createViewer` later | 403 until classified (a test fails until then) |
| Pairing: no code pending, a code reused, expired, or after 5 wrong tries; more than 10 tries a minute | 403 |
| Serve has another path on the host, a raw TCP forward, or Funnel | main turns the entry off and notifies |
| `remote.json` changed outside the app | native notification and a Settings flag |
| A connect address outside this tailnet, or not one of the owner's untagged nodes, or a changed node | refused |
| Invalid or self-signed certificate | refused by Node's `fetch` and by Chromium |
| The hub page calls a privileged bridge, or reads the device secret | absent in `remote-preload.cjs`; the header is added by main |
| The hub view redirects off the origin, or starts a download | redirect handed to `openWebLink`; download cancelled; bridge inert |
| Injected script in the hub page calls `openDesk` | needs focus and a fresh input event; one per 2 s, three a minute; only a listed desk on the hub's own machine |
| A checkout build and the installed app on one hub | only the viewer whose port matches `viewerPort` opens the entry |
| The loopback entry | `startLocalViewer`'s gate and headers unchanged; `/api/activity` and `/api/version` gain fields (PR 1); the loopback app gains `GET /api/remote-entry` and `POST /api/remote-entry/code` (PR 2a, 2b) |

## §4 Rollout: the owner's steps

1. Update the hub to the release, and install the same release on the laptop.
2. On the hub: Settings → "Let my other devices use this Inbox" → on. Run the one command shown,
   once, in Terminal. Press **Test**. Switch on Open Agent Inbox at login.
3. On the hub: **Add a device**. Leave the code on screen.
4. On the laptop: Settings → "Use another Mac's Inbox". Enter `https://hub.example.ts.net`, a
   label and the code. **Connect**. Then set the SSH host and, if wanted, a template, and confirm
   the command in the dialog.
5. Check `ssh -t <host> tmux ls` works from the laptop's Terminal. A non-interactive SSH shell
   often lacks Homebrew's `PATH`, so the template may need `/opt/homebrew/bin/tmux` or a shell
   function.
6. Advice, not required: a Tailscale access rule that lets only the owner's own devices reach the
   hub on port 443.

## §5 Build order

Each PR lands alone, with its tests, its docs and one `CHANGELOG.md` bullet. Everything is off
until the owner turns it on, so main is safe at every commit. A new
`docs/architecture/remote-inbox.md` with frontmatter (`paths: src/viewer-remote.ts,
electron/remote-*.cjs, electron/desk-open.cjs`) comes with PR 2a, and its row goes in `CLAUDE.md`.
`viewer-network.md` gains one paragraph pointing to it: "the tailnet entry is separate, binds
loopback too, and needs a paired device".

PR 2 is split because pairing roughly doubles it. PR 2a cannot be turned on by itself: with no
`devices` in the file every request is refused, so it is safe to merge alone.

| PR | Content | Tests |
|---|---|---|
| 0 | This spec | none |
| 1 | `src/session-place.ts` (`readPlace`, `readDesk`, `readRemoteSession`, patterns); `buildMcpServer`'s `place()` and `refreshPlace` timer; `ensureColumn` ×4, `ActivityUpdate`, `upsertActivityTxn`, `setActivityPlace`, `listActivity`, `Activity` in `src/store.ts`; `machine` in `/api/version`; `public/place.js`; card meta in `public/agents-home.js`; panel meta, Open in claude.ai and Copy attach command in `public/app.js`; `activity-and-live.md` | `test/session-place.test.ts` (each pattern, a leading `-`, a hostile tmux name, timeout, no `TMUX`; the live file: another pid's, a symlink, oversized, a bad id, none); `test/store.test.ts` (`machine`, `pane` kept on omission; `setActivityPlace` writes nulls and moves no stamp; the upsert never names `desk`); `test/live-tick.test.ts` unchanged and green; `test/mcp.integration.test.ts`; `test/place.test.ts` (URL only from a valid id; the quoted attach command); `test/dom/agents-home.test.ts`; `test/csp-source.test.ts` |
| 2a | `src/viewer-remote.ts` (`readRemoteSetting`, the setting cache, `remoteGate`, `REMOTE_ROUTES`, `startRemoteEntry` with `closeAllConnections`); `src/viewer-server.ts` (second `createViewer`, `GET /api/remote-entry`) | `test/viewer-remote.test.ts` (every gate step and order, header case, `:443`, Funnel header, device header absent, wrong, removed, timing-safe compare of all; `/%61pi/setup`, `%2e%2e`, `//`, `\`, trailing slash, `HEAD` on a refused route; no marker on 403; marker, CSP and framing on 200); `test/remote-routes.test.ts` (every route in `createViewer`'s `app.routes` classified; `/api/owner` absent on `remoteApp`); `test/remote-setting.test.ts` (symlink, other owner, mode `0644`, size, newer schema, bad device dropped, port mismatch, re-read on change, close on off) |
| 2b | Pairing in `src/viewer-remote.ts` (`POST /api/remote/pair`, the code, rate limit, device write under the lock); `POST /api/remote-entry/code`; `electron/remote-entry.cjs` (settings writes, `tailscaleCli`, `tailnetSelf`, `serveState`, the 60-second check, `selfTest`, the outside-change watch); IPC and notifications in `electron/main.cjs`; `agentInboxRemoteEntry` in `setup-preload.cjs`; the Settings section (`public/remote-settings.js`, `public/app.js`) | `test/remote-pair.test.ts` (code once, expired, five wrong tries, rate limit, no code pending, secret answered once, only the hash stored); `test/serve-state.test.ts` (fixtures: the one good shape; a second path; a TCP forward; Funnel; another port; malformed JSON; one failed read retried); `test/remote-entry-settings.test.ts` (writes, outside change flagged, an expected pairing notified); `test/dom/settings-remote.test.ts` |
| 3 | `electron/remote-connect.cjs` (settings, `validateHubOrigin` with the tailnet and peer checks, pairing, `safeStorage`, `hubFetch`, `probeHub`, backoff); `electron/remote-preload.cjs`; `electron/remote-offline.html`; the view, header injection, navigation, redirect, download and permission handlers, menu items and `powerMonitor` in `electron/main.cjs`; `agentInboxConnect` and local `agentInboxDesk` in `setup-preload.cjs`; connect settings and the banner in `public/app.js` | `test/remote-connect.test.ts` (origin rules, outside the tailnet, a tagged or another user's peer, a changed node, marker required, secret never stored in clear, backoff 2→60 s, resume and online triggers, reload only on version change, refused state); `test/remote-preload.test.ts` (one object, exact members); `test/main-source.test.ts` (the view never gets the install binding; the header handler filters on the hub origin); `test/dom/connect-banner.test.ts` |
| 4 | `createAttentionWatch` in `electron/main.cjs`; `electron/desk-open.cjs` (`fillTemplate`, `deskScript`, `openDesk`, the confirmation dialog); `writeChatScript` generalised; Open desk in `public/place.js`, `public/agents-home.js`, `public/app.js`, `public/chats-view.js` | `test/reply-watch.test.ts` (posts to the hub base with a trailing slash, its Origin and the device header); `test/attention-watch.test.ts` (badge sum, per-source `known`, wake adapter local only); `test/desk-open.test.ts` (each placeholder's quoting, parsed back by `sh` and by a second `sh -c` for `{attach}`; unknown placeholder refused; `sshHost` with a leading `-` refused; no save without the dialog; source by sender; `not_on_hub`, `not_here`; gesture and rate limits); `test/badge.test.ts` still green; `test/dom/chats-view.test.ts` |

## §6 Tests that hold across PRs

- `startLocalViewer`'s gate and headers are byte-identical to the build before PR 2a. The loopback
  app's responses change only where §3.6's last row says.
- No remote response carries `x-agent-inbox-local-boundary`, no route serves the owner token to the
  remote app, and no page-visible value or log line holds a device secret.
- Nothing in the stdio MCP import graph imports `viewer-remote.ts` or any network module
  (the existing graph test gains the file).
- Fixtures are synthetic: `hub.example.ts.net`, `owner@example.com`, `laptop`.

## §7 Proof

Beside the tests, before PR 2b, PR 3 and PR 4 merge:

1. **On the hub, the gate.** A dev copy of the app runs on a scratch database (`AGENT_INBOX_DB`),
   so its `remote.json` is the scratch hub's, with the remote entry on (checkout port 4393) and one
   device paired. With `curl` straight to `127.0.0.1:4393`, each of these is a 403: no login, a
   wrong login, a wrong `Host`; the right login with no secret, a wrong secret, or a removed
   device's; a forged login with a made-up secret; `/%61pi/setup`, `/api//items`,
   `/static/../api/setup` and `HEAD /api/setup` with a valid secret; a POST with
   `Origin: https://evil.example` or `Sec-Fetch-Site: cross-site`; and a pairing code used twice,
   after 10 minutes, or after five wrong tries. The right login, `Host` and secret answer 200
   with the marker.
2. **Over the tailnet.** The owner runs `tailscale serve --bg 4393` himself, and **Test** passes.
   From the laptop, `curl` with no secret gets 403 and the `device` count rises; from a tagged
   server, 403 and `login` rises. The owner adds a second Serve path on the same host; within a
   minute the entry turns off, a notification shows, and the panel shows the removal command.
3. **The connect flow.** First a second dev copy on the hub, with its own scratch profile, pairs
   and connects to the Serve address (it waits for the laptop if §9 item 3 says no login). Then a
   laptop build: pairing; the page loads; an answer there wakes the hub's scratch session; a
   notification's button answers; restarting the hub app and ten minutes of laptop sleep both
   recover without a click; removing the device shows "no longer accepts this Mac"; and
   `openDesk` attaches the chosen terminal to the right tmux session.
4. Afterwards the owner turns the proof's Serve configuration off. The real switch is turned on
   only in §4.

## §8 What is not in this design

- Database sync; agents reporting to another machine's hub; a merged view over several hubs; an
  offline copy with an outbox; running `tailscale serve` or editing Tailscale settings for the
  owner; selecting a pane on attach; Resume in Terminal against a hub.
- **Phones and plain browsers.** A browser on the tailnet now gets 403, because it holds no device
  secret. A later design can pair a browser with a pairing page that sets the secret as a
  `Secure`, `HttpOnly`, `SameSite=Strict` cookie; the gate would then accept the header or the
  cookie. Phone notifications come after that.

## §9 What the build must settle

1. **Settled: the Remote Control id comes from the host's live file** (§3.1). Left to check: a
   session Remote Control itself started, whose live file reports the entrypoint `sdk-cli`.
2. **Settled: `tmux` is on the MCP server's `PATH` on the hub** (seven of seven servers). Keep the
   fixed-path fallback for other setups.
3. **Does a request from the hub to its own Serve address carry its user's login?** If not, Test
   on the hub sees the `login` count rise instead of `device`, and says to test from the other Mac.
4. **Partly settled: the Tailscale fields.** Observed on 1.102.4: `Self.DNSName` (with a trailing
   dot), `User[String(Self.UserID)].LoginName`, and a top-level `CertDomains` that lists the name
   when HTTPS certificates are on; the CLI was at `/usr/local/bin/tailscale`. Not observed:
   `tailscale serve status --json` with a configuration (expected: `TCP`, `Web` keyed by
   `host:443` with `Handlers` by path and a `Proxy`, and `AllowFunnel`), the shape of a raw TCP
   forward in it, a peer's `StableID` and `Tags`, and the exact removal command
   (`tailscale serve --bg <port> off`, from the CLI reference's "add `off` to the command").
5. **App Nap.** The packaged app runs the viewer in its main process. If hours hidden slow the
   remote entry, hold `powerSaveBlocker.start('prevent-app-suspension')` while it is on.
6. **Login items.** Does `setLoginItemSettings` need approval in System Settings → Login Items?
7. **Shortcuts.** Which accelerators for This Mac and <label> are free of the page's own keys?
8. **Does the page cope with a 403 on `/api/setup`** in a browser (the empty Setup section)?
9. **Does `@hono/node-server` expose the raw request target** as `c.env.incoming.url` in the
   installed version, and does it normalise `..` before Hono sees the path? The path-form step
   needs the raw target; if it is not available, refuse any path where `new URL` normalisation
   would change it.
10. **A laptop build for the proof.** The laptop has no app today, so the laptop half of §7
    step 3 runs on the signed release, after the hub-only half has passed.
11. **PR 2b: main and the viewer must name the same `remote.json`;** main computes it by the same
    rule (the folder of `AGENT_INBOX_DB`, else `~/.agent-inbox`) or passes the path.
