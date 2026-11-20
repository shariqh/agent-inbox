---
paths:
  - "src/viewer-remote.ts"
  - "src/remote-pair.ts"
  - "test/viewer-remote.test.ts"
  - "test/remote-routes.test.ts"
  - "test/remote-setting.test.ts"
  - "test/remote-pair.test.ts"
  - "electron/remote-*.cjs"
  - "test/serve-state.test.ts"
  - "test/remote-entry-settings.test.ts"
  - "test/remote-entry-restart.test.ts"
  - "test/remote-connect.test.ts"
  - "electron/hub-view.cjs"
  - "electron/remote-offline.*"
  - "test/hub-view.test.ts"
  - "test/remote-preload.test.ts"
  - "test/remote-offline.test.ts"
  - "test/main-ipc.test.ts"
  - "test/remote-entry-ipc.test.ts"
  - "test/remote-words.test.ts"
  - "public/remote-settings.js"
  - "public/remote-words.js"
  - "test/dom/settings-remote.test.ts"
  - "public/connect-settings.js"
  - "public/hub-strip.js"
  - "public/hub-mode.js"
  - "test/dom/settings-connect.test.ts"
  - "test/dom/hub-strip.test.ts"
  - "test/dom/hub-strip-keys.test.ts"
  - "test/dom/hub-strip-deck-keys.test.ts"
  - "test/dom/hub-mode.test.ts"
  - "electron/attention-watch.cjs"
  - "test/attention-watch.test.ts"
  - "electron/desk-open.cjs"
  - "test/desk-open.test.ts"
  - "public/desk-open.js"
  - "test/dom/desk-open.test.ts"
  - "src/remote-update.ts"
  - "test/remote-update.test.ts"
  - "test/remote-update-link.test.ts"
  - "electron/hub-update.cjs"
  - "test/hub-update.test.ts"
  - "src/remote-file.ts"
  - "test/remote-file.test.ts"
  - "electron/hub-files.cjs"
  - "test/hub-files.test.ts"
  - "public/hub-files.js"
  - "test/dom/hub-files.test.ts"
applyTo: "src/viewer-remote.ts,src/remote-pair.ts,test/viewer-remote.test.ts,test/remote-routes.test.ts,test/remote-setting.test.ts,test/remote-pair.test.ts,electron/remote-*.cjs,test/serve-state.test.ts,test/remote-entry-settings.test.ts,test/remote-entry-restart.test.ts,test/remote-connect.test.ts,electron/hub-view.cjs,electron/remote-offline.*,test/hub-view.test.ts,test/remote-preload.test.ts,test/remote-offline.test.ts,test/main-ipc.test.ts,test/remote-entry-ipc.test.ts,test/remote-words.test.ts,public/remote-settings.js,public/remote-words.js,test/dom/settings-remote.test.ts,public/connect-settings.js,public/hub-strip.js,public/hub-mode.js,test/dom/settings-connect.test.ts,test/dom/hub-strip.test.ts,test/dom/hub-strip-keys.test.ts,test/dom/hub-strip-deck-keys.test.ts,test/dom/hub-mode.test.ts,electron/attention-watch.cjs,test/attention-watch.test.ts,electron/desk-open.cjs,test/desk-open.test.ts,public/desk-open.js,test/dom/desk-open.test.ts,src/remote-update.ts,test/remote-update.test.ts,test/remote-update-link.test.ts,electron/hub-update.cjs,test/hub-update.test.ts,src/remote-file.ts,test/remote-file.test.ts,electron/hub-files.cjs,test/hub-files.test.ts,public/hub-files.js,test/dom/hub-files.test.ts"
---

# Remote entry: one Inbox from every device (#617)

The hub's viewer listens only on loopback (`viewer-network.md`). The remote entry is a second
loopback listener, reached only through Tailscale Serve, for the owner's own paired devices.
Design: [`docs/superpowers/specs/2026-11-17-remote-inbox-design.md`](../superpowers/specs/2026-11-17-remote-inbox-design.md) §3.2.
Process boundaries: [`overview.md`](overview.md).

Claude Code and Copilot CLI load this file when they read or edit a file matching the
`paths`/`applyTo` globs above; anyone else should read it before changing the remote entry.
Later PRs add their files to the globs.

## What is built (PR 2a, PR 2b, PR 2c, PR 2d, PR 2e, PR 3a, PR 3b, PR 3c, PR 4a, PR 4b, #637, #634)

- `src/viewer-remote.ts`: the setting reader, the gate, the allowlist and the listener.
- `src/remote-pair.ts` (PR 2b): the pairing code, `POST /api/remote/pair` and the device write,
  and `remoteCodeRoute` for `POST /api/remote-entry/code`. Viewer process only, like
  `viewer-remote.ts`.
- `src/viewer-server.ts`: a second `createViewer(db, { mesh })` with no owner token, its static
  files, `startRemoteEntry`, and on the loopback app `GET /api/remote-entry` and, when the viewer
  has an owner token, `POST /api/remote-entry/code`.
- `electron/remote-entry.cjs` (PR 2c): the hub controller for the desktop app's main: the
  settings store, the code and status requests to the app's own viewer, the self test and the
  watch. Its read-only Tailscale half is `electron/remote-tailscale.cjs`. PR 2d wires it into the
  app (below).
- `electron/remote-entry-state.cjs` (PR 2e): what the controller keeps across restarts, in userData
  `remote-entry-state.json`. Only `remote-entry.cjs` requires it.
- `electron/remote-entry-ipc.cjs` (PR 2d): the hub controller's channels, what the panel draws,
  the notifications, Open at login and the quit; `electron/main.cjs` makes one controller per run;
  `agentInboxRemoteEntry` in `electron/setup-preload.cjs`; Settings → Other devices in
  `public/remote-settings.js`, with its words in `public/remote-words.js` ("The hub's Settings
  panel", below).
- `electron/remote-connect.cjs` (PR 3a): the other side, for main on the connecting Mac: the
  address check, the hub among this Mac's Tailscale peers, pairing, the encrypted secret, the
  probe, the device header and the connection state. Its pure rules are in
  `electron/remote-connect-rules.cjs` ("Connecting from another Mac", below).
- `electron/hub-view.cjs` (PR 3b): the hub's page in its own view in this app's window, its
  preload `electron/remote-preload.cjs`, the offline page `electron/remote-offline.html` (with its
  `.js` and `.css`), the `agentInboxDesk` and `agentInboxConnect` bridges, the View menu items and
  the wiring in `electron/main.cjs` ("The hub view", below).
- PR 3c: the connecting Mac's screens under `public/`: Settings → Use another Mac's Inbox
  (`public/connect-settings.js`), the strip that says whose Inbox is on screen
  (`public/hub-strip.js`) and the page's hub mode (`public/hub-mode.js`) ("The connecting Mac's
  screens", below).
- `electron/attention-watch.cjs` (PR 4a): the attention watch, run once for This Mac and once for
  the connected hub, the dock badge's sum, and the one notice for a hub out of reach ("Attention
  from the hub", below).
- `electron/desk-open.cjs` (PR 4b): Open desk, a session's tmux desk on the hub opened in the
  connecting Mac's terminal, with its page part in `public/desk-open.js` and its command in
  Settings → Use another Mac's Inbox ("Open desk", below).
- #637: updating the hub from the connecting Mac. On the hub, the viewer's relay
  `src/remote-update.ts` and main's `electron/remote-update.cjs`; on the connecting Mac,
  `electron/hub-update.cjs` and a block in `public/connect-settings.js` ("Updating the hub from
  another Mac", below).
- #634: opening a card's file from the connecting Mac. On the hub, the read-only route
  `src/remote-file.ts`; on the connecting Mac, `electron/hub-files.cjs` and the page's
  `public/hub-files.js` ("Opening a card's files from another Mac", below).

## What is not built yet

- Open desk for This Mac's own sessions, and in the Chats tab: there, Copy attach command stays.
- The design's `{host}` and `{target}` placeholders and a stored SSH host: the owner types the host
  into the command.

So the entry is off until the owner switches it on in Settings → Other devices on the hub. With no
device in it, every request but pairing is refused. Any local process on the hub can still make a
pairing code: the owner token is not a secret from local processes (below).

## The setting

`remote.json` sits beside the hub database: `remoteDir()` is the folder of `AGENT_INBOX_DB`, else
`~/.agent-inbox`. `AGENT_INBOX_MESH_DIR` does not move it, so a viewer only ever opens the entry for
the database it serves, and a scratch hub never reads the real one. No environment variable turns
the entry on. PR 2b's main must name the same file, by the same rule or by being told the path.

`readRemoteSetting` opens the file with `O_NOFOLLOW`, checks the open descriptor with `fstat`
(a regular file, owned by this user, `mode & 0o077` zero, at most 64 KiB), reads from that
descriptor, and parses a JSON object with `schema: 1`. Anything else is off, and a newer schema is
off. Then:

- `host`, lowercased, matches `/^[a-z0-9-]+(\.[a-z0-9-]+)+$/`, and its last label holds a letter, so
  an address such as `127.0.0.1` is refused.
- `logins`: 1 to 16 strings of 1 to 254 characters with no control characters, kept lowercased.
- `viewerPort` and `port` are both required; `port` is 1024 to 65535 and not `viewerPort`.
- `devices`: at most 16. Each needs a 16-character lowercase hex `id`, a `label` by the device
  label rule (1 to 40 characters, no control character, no Unicode format character, no lone
  surrogate: the same rule as a pairing request, below), and a 64-character lowercase hex `secretSha256`. A bad
  device is dropped; the rest still count. The first entry with an id is the device: a later entry
  with the same id is dropped whatever it holds, so its key never opens the gate (PR 2d review round
  2; the controller reads it the same way, and a test compares the two readers on such a file).
- `enabled` is on only when it is exactly `true`.

`secretSha256` is the SHA-256 of the device secret's 43 base64url characters, as ASCII, in
lowercase hex. The hub never stores the secret.

The gate stats the file on every request and re-reads it only when the stat changed (identity,
owner, mode, size, times). A removed device is refused on its next request.

## The listener

`startRemoteEntry` binds `127.0.0.1` only, at the setting's `port`, while the setting is valid,
`enabled` is true and `viewerPort` is this viewer's port. So a checkout's viewer never binds beside
the installed one. A 5-second timer, any request that sees a changed file, and any read of the
status (`GET /api/remote-entry`) that sees one, opens or closes the listener to match. Main reads
the status right after it writes `remote.json`, so the listener follows within milliseconds, not at
the next poll (PR 2d). Closing calls `server.close()` and `server.closeAllConnections()`, so no
kept-alive connection outlives the switch. A bind failure is logged once and shown in the status;
the viewer keeps running and the next check tries again.

`createViewer` starts no timers and keeps its caches per instance, so building it twice is safe.
The remote app has no owner token, so `/api/owner` does not exist on it.

## The gate

Each refusal is `403` with the body `Forbidden` and no marker. Its reason only raises a counter.
The steps run in this order, and only the first failing step is counted:

1. **host**: `Host`, sent once, lowercased, is `host` or `host:443`. An off setting refuses here,
   and so does a request on a socket that is not the current listener's port.
2. **funnel**: any `Tailscale-Funnel-Request` header refuses.
3. **login**: `Tailscale-User-Login`, sent once and without a comma, equals one of `logins`,
   ignoring case.
4. **path**: the raw request target has no `%`, `\`, `//` or `#` anywhere and only printable ASCII;
   it starts with `/`; its path has no `.` or `..` segment and is byte-equal to `c.req.path`; an
   `/api/` path does not end in `/`.
5. **origin**: an `Origin`, when present, is sent once and equals `https://<host>`.
6. **origin**: on every method, `Sec-Fetch-Site`, when present, is sent once and is `same-origin` or
   `none`; `cross-site`, `same-site`, an empty value and a repeat are refused. Safe methods too: once
   the laptop app adds the device header by URL filter, a no-cors GET from another page would carry
   it. An unsafe method also needs the `Origin`.
7. **pairing**: a `POST` whose raw request target is exactly `/api/remote/pair` skips steps 8 and
   9 and goes to the pairing handler (below). It is the one request that passes with the login
   alone. A query string, a trailing slash, another method or any other path gets no such pass and
   goes on to step 8; a device header sent with a pairing request is ignored.
8. **device**: `X-Agent-Inbox-Device`, sent once, is 43 base64url characters. Its SHA-256 is
   compared with every paired device's `secretSha256` by `crypto.timingSafeEqual`, all of them,
   with no early exit.
9. **route**: the method (`HEAD` as `GET`) and `c.req.path` are on `REMOTE_ROUTES`, or the request
   is a `GET` outside `/api/` (a static file). That test is case-sensitive, so `/API/setup` passes as a
   static path; it is safe because Hono's routing is case-sensitive too, so no API handler runs and
   the static handler answers 404.

Headers are read from `incoming.rawHeaders`, so a repeated header is seen as two values. Node
would join or drop repeats in `incoming.headers`.

**The raw request target** is `c.env.incoming.url`. `@hono/node-server` passes the Node
`IncomingMessage` as `env.incoming` and never rewrites its `url`. It builds the `Request` URL from
it, and runs a target with `..`, `\` or other characters outside its fast pattern through
`new URL`, which normalises them; Hono then decodes `%` escapes in `c.req.path`. So `/%61pi/setup`
routes as `/api/setup` and `/static/../api/setup` as `/api/setup`. The tests send these over a raw
socket and check they are refused at step 4 (`test/viewer-remote.test.ts`).

Accepted responses get `Cache-Control: no-store`, the loopback entry's CSP, `X-Frame-Options:
DENY` and `x-agent-inbox-remote-boundary: tailnet-v1`, and never `x-agent-inbox-local-boundary`.

## What it serves

`REMOTE_ROUTES` is an explicit allowlist. A route is allowed only when the page needs it to show
or answer the Inbox. It is refused when it acts on the hub's processes or files, hands out a
credential, or belongs to setup or launching, which only make sense at the hub. `GET /api/chats`
(each chat's folder, Copilot's automatic titles), `GET /api/mesh/agents` (endpoint and fix hints)
and `GET /api/mesh/agents/runs` (a forget command) carry the owner's own hub-side details to the
owner's paired device, by decision. Refused:
`/api/owner`, `/api/setup`, every `/api/launches…` and `/api/launch-asks…` route,
`/api/launch-folders`, `/api/chats/copilot/:id`, `/api/remote-entry` and `/api/remote-entry/code`.
`test/remote-routes.test.ts` lists every route `createViewer` registers and every route
`src/viewer-server.ts` adds to the loopback app, and fails until each new one is classified.
Messaging a session is allowed: that is the owner's accepted risk (design §3.2).
`/api/remote/pair` is not on the list: it is served by the guarded app itself and reached only
through step 7. Nor are `GET` and `POST /api/remote/update` (#637): they are `GUARDED_ROUTES`,
served by the guarded app itself after every step of the gate, the device's included; step 9 lets
exactly those through besides `REMOTE_ROUTES`. #634 adds a third, `GET /api/remote/file`, the same
way (below).

The gate allows by concrete path, so the same test also asks Hono which handlers it would run for a
sample path of each allowed pattern, on the app as the entry wraps it (`guardRemoteApp`): exactly the
gate, `createViewer`'s wildcard middleware, the one handler registered with that pattern, and for a
GET the static handler. A broader route registered anywhere fails it. Hono copies the wrapped app's
routes when the entry starts, so nothing added to that app later is served. The pairing route is
registered on the guarded app, after the gate and before the wrapped app's routes; the same test
checks that Hono runs exactly the gate and that handler for it, and that the wrapped app has no
such route.

## Pairing (PR 2b)

The hub makes a short one-time code; another Mac sends it once and gets back a device secret that
step 8 accepts from then on. Agents on the hub may run commands without asking, so a device secret
is a credential for the whole hub.

**The code.** `POST /api/remote-entry/code` on the loopback app makes it. The route exists only
when the viewer was started with `AGENT_INBOX_OWNER_TOKEN` (the desktop app sets it for its own
viewer), and needs the header `X-Agent-Inbox-Owner` equal to that token, compared as SHA-256
digests with `crypto.timingSafeEqual`; otherwise 403. The loopback entry's own rules run first, so
the request also needs `Origin: http://127.0.0.1:<port>`, as every unsafe method there does; a
plain `fetch` from another local process with both headers works. While the remote entry is not on
for this viewer, or its listener is not bound on the setting's port, the route answers
`409 { "error": "remote_entry_off" }` and makes no code. Otherwise it answers
`{ code: "7K3QX-9M2PD", codeId, expiresAt }` with `Cache-Control: no-store`.

**Who can make a code.** Any local process on the hub can: `GET /api/owner` serves the owner token
to any loopback client, which is the same local trust the loopback viewer already gives. What the
token does is keep the route from existing on a viewer the desktop app did not start (a checkout's
`npm run view`, a scratch hub). So a device that paired after the app asked for a code is not proof
that the app's code paired it. `codeId` settles that: 16 random hex characters, made with the code
but not derived from it, answered only to the caller, and shown in the status only once a device
has paired with it. An expected pairing is one whose `codeId` the app itself was given.

The code is 10 Crockford base32 characters (no I, L, O or U), each drawn with `crypto.randomInt(32)`,
so 50 unbiased random bits, shown in two groups of five. The viewer keeps only its SHA-256, in
memory. At most one code exists. It is valid for 10 minutes from when it was made, used once, void
after 5 wrong tries, and voided by a newer code, by a viewer restart, and by any change to
`remote.json` after it was made.

**A code is tied to the file it was made under.** The entry remembers the setting cache's version
when it makes a code, and voids the code as soon as the cache re-reads the file for any reason: the
entry off and on again (even between two polls), a device added or removed by anyone, a hand edit
that changes nothing the entry uses. The gate reads the cache at the start of every request, so the
void happens before the pairing handler compares. The consequence for the app: any write to
`remote.json` while a code is pending voids it, so the app asks for a code after its last write. A
pairing's own write voids nothing: its code is already void, and the next code is made after it.

**`POST /api/remote/pair`.** Steps 1 to 6 of the gate apply as for any request, so it needs the
right `Host`, no Funnel header, an allowed login, a clean target, `Origin: https://<host>` and no
cross-site Fetch Metadata. Then, in order:

1. **Rate limit.** At most 10 requests in any 60 seconds are let into the handler, each counted
   when it arrives, before its body is read. It is one counter for the route, not per client:
   every request arrives from Serve on loopback. A request over the limit is refused at once, so it
   uses no try. This caps requests, not comparisons (a request let in can hold its body back and
   compare later); what bounds guessing is the five tries per code.
2. **Body.** One `Content-Type` header, exactly `application/json` (no parameters). At most
   1 KiB, checked on `Content-Length` and again while reading, which stops at the limit. Strict
   UTF-8. A JSON object with exactly the keys `code` and `label`, both strings. `label` follows the
   device label rule, shared with the reader (`isDeviceLabel`): 1 to 40 characters with no control
   character (Cc), no Unicode format character (Cf: bidirectional controls, zero-width characters,
   the byte-order mark, the soft hyphen) and no lone surrogate (Cs). A zero-width joiner is refused
   even inside an emoji sequence, so `👩‍💻` is refused while `😀` is taken. A label is read by a
   person, in Settings and in a notification. A body that fails any of these uses no try.
3. **A code is pending**, else refused.
4. **The code.** Only ASCII letters, digits, spaces and dashes are read, at most 64 of them; case,
   spaces and dashes are ignored, `I` and `L` read as `1` and `O` as `0`, and the result must be 10
   letters of the alphabet. Its SHA-256 is compared with the pending one by `timingSafeEqual`. A
   wrong code, and a code string that does not normalise (a `U`, a short code), each use one try;
   the fifth voids the code.
5. **On a match** the code is voided first, in the same synchronous step as the compare (no
   `await` between them), so two requests racing with the right code cannot both pair. Two tests
   hold this: eight real sockets that release the right code's body in the same tick, and eight
   concurrent calls of the handler in process; each pairs exactly one device. Then a 32-byte secret (43 base64url
   characters) is made, and the device is written (below). The answer is
   `200 { ok: true, device: <id>, secret: <43 characters> }` with the remote headers. The secret
   is in that one response and nowhere else.

Every refusal on this route, at any of these steps or at the write, is the same bare `403 Forbidden`
with no marker, counted under `pair`. The reason never reaches the client. A busy lock answers the
same 403, after the lock's 5-second deadline.

**The write.** `createLockedFile` from `electron/update-preferences.cjs` (it needs nothing from
Electron): the cross-process `remote.json.lock` main also uses, a temp file and rename in the same
folder, mode `0600`. Under the lock the file is read again, as it is now, by the same reader as the
gate, from the same bytes the document is parsed from. Nothing is written when it is not a regular
file this user owns with no group or other bits, has a newer schema or an invalid field, is not on
for this viewer, no longer names the port, `Host` or login the request passed the gate with, already
lists 16 devices, or would grow past 64 KiB (the reader would then refuse the whole file). Otherwise
the device `{ id, label, secretSha256, pairedAt }` is appended to `devices` (the list is created
when absent) and the whole parsed document is written back, so every field this build does not
know, at the top level and in each device, is kept by value. `id` is 16 random hex characters not
already in the file. `secretSha256` is the lowercase hex SHA-256 of the secret's 43 ASCII
characters. The gate's setting cache sees the new file on the next request, so the device works at
once.

If the write cannot be made (the lock is busy for 5 seconds, a permission error), the code stays
void, the client gets the same 403, and one fixed line is logged naming only the error's code:
`agent-inbox remote entry: pairing could not write remote.json (EACCES)`, or `(error)` for an error
with no code, such as the busy lock.

The lock waits under one deadline whatever holds it: since PR 2b it reads the lock path with
`lstat`, so a dangling symlink there is a held lock (refused after 5 seconds, or removed as stale
after 5 minutes) instead of a retry with no deadline and no sleep, which once spun forever.

Kept by value means through `JSON.parse` and `JSON.stringify`: an unknown number that does not fit
a double, or one written as `1.0`, is written back as JavaScript prints it; `-0` becomes `0`; of
duplicate keys only the last is kept; and the file is re-indented.

## Status, loopback only

`GET /api/remote-entry` on the loopback app answers `{ on, listening, port, host, error,
codePending, paired, refused: { host, funnel, login, path, origin, device, route, pair } }`.
`codePending` says a code is waiting to be used (never which: the pending code's `codeId` is not
shown); `paired` lists `{ device, codeId }` for each device this viewer paired since it started,
the device's id and the identity of the code that paired it, the last 16; the counts are since the
viewer started. `error` is a bind failure or fixed words for a refused file. It never holds a login,
a header value, a secret, a hash, a label or a code. It is not on the remote allowlist.

## Logging

The entry logs only that it opened on a port, that it closed, a bind failure with its error code,
a pairing write that failed with its error code, and for a request whose handler threw, one fixed
line naming the error's class (`agent-inbox remote entry: a request failed (TypeError)`), answered
with a bare 500. It never logs a login, a header value, a code, a secret, a hash, a label, the
tailnet host, a path or an error's message (a store error can quote ids taken from the path). The
loopback entry keeps Hono's default error handler.

## The hub controller (PR 2c)

`electron/remote-entry.cjs` is what the desktop app's main uses to own `remote.json` and to check
Tailscale; its read-only Tailscale half is `electron/remote-tailscale.cjs`.
`createRemoteEntry(options)` returns one object; every dependency (`fsImpl`, `execFile`, `exists`,
`fetch`, `now`, `sleep`, the timer and interval functions) is an option, so the tests run no
command, open no socket of their own and never sleep. It logs nothing. No public operation
rejects: a throw anywhere answers `{ ok: false, reason }`, or an unavailable view.

**When the entry is on.** `turnOn()` writes `enabled: true` only after this node's identity and
Serve's shape both read ok just then. While the entry is on, a check that fails or throws turns it
off: a failed read after one retry 5 seconds later, anything else at once. A turn-off that does not
land (the file could not be written) is retried at every 5-second tick until it does.

**The file.** `remoteFile(env, home)` is `remote.json` in `remoteDir()`'s folder, by the same rule;
a test compares the two over several environments. The controller reads the file by the viewer's
rules (`O_NOFOLLOW`, checked on the descriptor, owned by this user, no group or other bits, at most
64 KiB, strict UTF-8, schema 1), with the same device label rule (`isDeviceLabel`: 1 to 40
characters, no control, format or lone surrogate character), and a test reads many files with both
readers and compares the answers.

**Tailscale, read-only.** `tailscaleCli` takes the first of `/usr/local/bin/tailscale`,
`/opt/homebrew/bin/tailscale` and `/Applications/Tailscale.app/Contents/MacOS/Tailscale` that
exists; never a search, never a configured path. A Mac with the App Store or standalone app and no
command-line install has only the third. That binary is Tailscale's app and its command line in
one file, and it picks between them from its environment (`SHLVL`, `TERM`, `TERM_PROGRAM`, `PS1`):
run from a shell it answers `status --json`, but run by an app opened from Finder, which has none
of those, it prints "The Tailscale GUI failed to start" and exits 0. So every run adds
`TAILSCALE_BE_CLI=1` to this app's own environment, Tailscale's documented way to ask for the
command line; a real command-line install ignores it. Every run is `execFile` with an argument
array, no shell, a 5-second timeout (and a 6-second limit of its own, in case the command ignores
the kill), and only three argument lists:

- `status --json --peers=false` for this node (1 MiB cap). It leaves the peers out: this node, its
  user and its tags are all it needs, and the full list printed 822 KB for a tailnet with 531
  peers, which a larger one would push past the cap and so switch sharing off. Without peers it is
  about 5.5 KB.
- `serve status --json` for Serve's shape (1 MiB cap).
- `status --json` for the full peer list (16 MiB cap), for the connecting Mac to find the hub
  among its peers. `electron/remote-connect-rules.cjs` parses it (PR 3a, below); nothing in the
  hub controller does.

Nothing here changes Tailscale's configuration. A source test pins the three lists and the one
`execFile` call, and checks that `remote-entry.cjs` itself runs nothing.

- `tailnetSelf()`: `Self.DNSName` lowercased without its trailing dot, and
  `User[String(Self.UserID)].LoginName` (the ID is read from the JSON text, so one past 2^53 keeps
  its digits). The host follows the reader's rule; the login follows it too, and also may hold no
  format character and no leading or trailing space. A tagged node is decided from `Self.Tags`
  (`null` and `[]` are untagged); its `UserID` still resolves to Tailscale's placeholder user, and
  the placeholder login `tagged-devices` is refused as `tagged` whatever `Tags` says. Otherwise a
  fixed word: `no_cli`, `failed`, `not_json`, `not_running`, `no_dns_name`, `bad_host`, `tagged`,
  `no_login`. Its result holds the login: it is for main only, never for a page.
- `serveState(host, port)`: ok only for exactly one handler for `<host>:443` (case and a trailing
  dot ignored), at `/`, whose entry has only `Proxy` and it is exactly `http://127.0.0.1:<port>`;
  the TCP entry for 443 exactly `{ "HTTPS": true }`; no TCP forward to the port on any port (each
  `TCPForward` is read as host and port, and the port must be plain decimal digits, compared as a
  number, so `04320` is 4320); no other host's or port's handler whose `Proxy` reaches the port
  (read the same way, with the scheme's default when none is written); no `AllowFunnel` for
  `<host>:443` other than `false`; `Foreground` and `Services` absent or empty; no key it does not
  know at the top level, in a TCP entry or in a handler; and nothing nested deeper than 32 levels.
  Every walk over the output uses an explicit stack, so output nested 100,000 deep is
  `unknown_shape`, not a stack overflow. Anything else is `{ ok: false, reason, present }`, where
  `present` says some configuration names `<host>:443` or the port. A failed read is `unreadable`.
  By the "unknown is never ok" rule, a foreground `tailscale serve` on any port, or any Tailscale
  Service, switches sharing off; the reason says which (`foreground`, `services`). The good shape
  and `{}` are from a real run (below); every other shape in the tests is from Tailscale's
  documentation, so a real shape that differs reads as not ok and the entry stays off.

**The store.** Writes go through `createLockedFile` on `remote.json`, the lock the viewer's pairing
write uses: read again under the lock, temp file and rename, mode `0600`, every unknown field kept
at the top level and in each device, never past 64 KiB. A newer schema, a symlink, a folder,
another user's file and a file that is not JSON are never written. A file with group or other bits
is refused by every operation except `repairPermissions()`, which rewrites it `0600`, turns it off
and removes every device, because another user may have edited it and added one; the result says
how many. A file with an unknown field nested too deep to serialise is written by `turnOff()` only,
with the fields the reader knows (`unknownFieldsDropped: true`), because that write must land.

- `view()`: `{ available, enabled, host, port, viewerPort, logins, devices: [{ id, label,
  pairedAt }], unreadableDevices, problem }`. Never a hash. `enabled` is true only when the viewer
  would open the entry for this app's `viewerPort`; a file on for the other build's viewer reads
  `problem: 'other_viewer'`. `unreadableDevices` counts the entries the reader drops, since they
  still count toward its limit of 16.
- `turnOn()`: reads `tailnetSelf()` and then `serveState(host, port)` first, outside the lock, and
  writes only when both are ok: `enabled: true`, `host`, `port` (`entryPort()`: 4320 packaged, 4393
  for a checkout build), `viewerPort` (`viewerPort()` in `electron/reuse.cjs`) and `logins: [<this node's
  login>]`. When the stored host or logins are not exactly this node's (ignoring case, as the gate
  does), it removes every device, since their secrets were issued under another identity, and
  says how many. It never takes the entry over while the file is on for the other build's viewer,
  and never writes a file the reader would refuse. A successful `turnOn()` clears the last stop.
  After its write, outside the lock, it reads `entryStatus()` every 250 ms for at most 6 seconds
  until the viewer says it is on and listening on this port, and answers `listening: true`, or
  `listening: false` when it never does (still `ok`: the file is on), and at once when the viewer's
  status names a bind failure for this port. When the stored account or address is not this node's
  (or is unusable) and the file holds any device entry, it refuses with `would_remove_devices` and
  the count, writing nothing, unless called with `{ removeDevices: true }`. PR 2d.
- `turnOff()`: writes `enabled: false` and nothing else. It, the watch's own stop, "off means off",
  the repair and a resume each read `entryStatus()` once after the write, not waited for, so the
  viewer opens or closes the listener at once. `state().listening` is what the last status read
  said, and `state().listenError` the viewer's bind failure for this port as a fixed word
  (`port_in_use` for EADDRINUSE, else `cannot_listen`), never its text. `removeDevice(id)`: by id, never by label
  (labels are not unique); an unknown id writes nothing.
- `turnOn()` and `removeDevice()` drop the device entries the reader would drop when they write,
  and say how many. This is the one place the controller does not keep what it does not
  understand: such an entry blocks pairing at 16 with no visible cause. `clearUnreadable()` (PR 2d,
  the panel's **Clear**) drops only those entries and says how many (`removed`). It writes only a
  file the reader reads: on a file it refuses (17 entries, say), dropping entries could make the
  rest readable and so switch the entry on, so it refuses with the reader's reason.
- There is no operation that sets `logins`, `host` or `port` freely, and none that adds a device:
  devices come only from the viewer's pairing route. Every write voids a pending code, and the
  result says `voidedCode: true` when a code asked for in the last 10 minutes was pending.

**Codes and status.** `requestCode()` posts to `http://127.0.0.1:<viewerPort>/api/remote-entry/code`
with the loopback `Origin` and `X-Agent-Inbox-Owner`, retries a 409 every second for 6 seconds, and
returns `{ code, expiresAt }`; it keeps the code's `codeId` to itself. It refuses without calling
the viewer while the view is not enabled. `entryStatus()` reads `GET /api/remote-entry` and returns
it only in its known shape (`paired` as `{ device, codeId }` entries); it is for main only. The
owner token is never returned or logged.

**The watch.** `start()` runs `tick()` every 5 seconds; tests call `tick()` themselves.

- While the entry is on: at start and every 60 seconds, `tailnetSelf()` and `serveState()`. A read
  that failed, or a check that threw, is tried once more 5 seconds later before it counts. When the
  shape is not ok, or this node no longer has the stored host and an allowed login (ignoring case),
  the watch writes `enabled: false` and then calls `onStopped(reason, { off, willResume })`, once
  per stop (`willResume`: below, "Across restarts"). When that
  turn-off did not land (`off: false`), each later tick tries it again until it does, without a new
  notice. An entry switched back on (by `turnOn()` or by hand) that fails again is a new stop,
  announced again. While the entry is off,
  Serve is read once after start (when the file names a host) and on `refresh()`, for the removal
  hint only. The watch leaves a file that is on for the other build's viewer alone.
- Every tick reads the file and compares a SHA-256 over the canonical JSON of `enabled`, `host`,
  `port`, `viewerPort`, `logins`, and each device's `id`, `secretSha256` and whether the reader
  keeps it, with what main last wrote or accepted. The last part matters because a label decides
  whether the reader keeps a device: an edit that makes a dormant hash live, or a live one dormant,
  is a change, while a rename that keeps it readable is not. Devices added at the end, with nothing
  else changed, are expected only when each is in the viewer's `paired` list with the `codeId` of
  a code this controller's `requestCode()` received in the last 11 minutes, one code per device:
  `onPaired(label)` for each. Anything else calls `onOutsideChange()` once per distinct state and
  sets `flag`. A code another local process made proves nothing, and the viewer's `paired` list
  starts empty when it restarts, so a pairing seen across a restart is flagged: the safe side.
  Nothing is reverted.
- `acknowledge(digest)` takes `state().flagDigest`, the digest of the flagged state, and clears the
  flag only when the file still has that digest. Otherwise the flag stays, the result is
  `{ ok: false, reason: 'changed' }`, and the new state is announced, so a device added after the
  owner looked is never accepted with the one they saw.
- The viewer's status is read before any lock, and only when a code main asked for could explain a
  change. Under the lock the file is only compared with it, synchronously, so main's own write
  never hides an outside change, and nothing that awaits the network or a child process runs while
  the lock is held: the viewer's pairing write waits at most about 5 seconds for it.
- `state()`: the view, the last Serve answer and when, the last identity (the host and whether the
  login is allowed, never the login), the flag and `flagDigest`, the last stop, and `removalHint`,
  `tailscale serve --https=443 off`, while the entry is off and a Serve configuration naming the
  host or port is present. That command is from Tailscale's documentation and not yet seen in real
  output. While it is shown and sharing is off, Serve is read again every minute and on
  `recheckHint()` (at most every 5 seconds), so it goes once Serve no longer names the host or
  port (PR 2d). No callback and no `state()` carries a login, a hash, the owner token or a code;
  `view().logins` holds the file's logins for the panel.

**Across restarts (PR 2e).** With the `stateStore` option, the controller keeps a small state in
userData `remote-entry-state.json` (`electron/remote-entry-state.cjs`): `{ schema: 1, digest,
wanted, file, viewerPort }`, written through `createLockedFile` (mode `0600`), unknown fields kept.
`file` is the SHA-256 of `remote.json`'s absolute path and `viewerPort` the viewer it is for: the
checkout build and the installed app share one userData folder, and a state kept for another file
or viewer reads as none. The file is read as `remote.json` is: opened without following a symlink
and without blocking, a regular file this user owns, at most 64 KiB; anything else, a bad file and a
newer schema read as no state, and a newer schema is never written over. Every call to the store is
waited for at most 5 seconds; a call that takes longer counts as failed. A read that fails counts as
no state. Without a state store the controller behaves as it did in PR 2c: the first read is the
baseline, and nothing comes back by itself.

- `digest` is the digest of the state main last wrote, recorded as an expected pairing, or the owner
  acknowledged, or `pending`, which no file has. It is `pending` while a change is flagged (saved as
  soon as the flag is raised), whenever no digest is kept, and before every write main makes to
  `remote.json`: main saves `pending` (with the `wanted` the operation will leave), writes the file,
  then saves the real digest. So any start before the owner's review flags again, whatever
  `remote.json` holds, including a file put back to an earlier state main wrote; and so does a start
  after a crash between the two saves, or after the second save failed. `state().stateSaved` is
  null until the first read, false when that read or the last write failed, true otherwise. If
  every write fails (the first too), the store still holds the state before the operation, and the
  next start compares with that.
- At the first look after a start, a file whose digest differs from the kept one is an outside change:
  `onOutsideChange()` once and the flag. With no digest kept (a first run, or the state file lost or
  unreadable), a file that is on or holds any device entry, readable or not, is flagged the same way,
  and so is a file the reader refuses (it cannot tell); an absent file, or one that is off with no
  device entry, becomes the baseline silently. Nothing is reverted. When main writes while a change
  is flagged (the owner presses Remove, or the watch stops the entry), the flag stays and its digest
  becomes that of the file main wrote, so Review accepts the file as it now is.
- `review()` reads the file once and returns `{ view, digest, flag, changes }`: the panel shows that
  view, and its Review button passes that `digest` to `acknowledge()`, which accepts it only if the
  file still has it. So the owner never accepts a state they were not shown. `changes` (only while
  flagged, PR 2d) compares the file with the watched state the owner last accepted, which the
  controller keeps in memory with its labels and moves with main's own writes only while nothing is
  flagged: facts with no values, or `unknown` when the change was found at the first look after a
  start.
- `wanted` is the owner's intent. `turnOn()` sets it; `turnOff()` and `repairPermissions()` clear
  it; the watch's own stop leaves it, except a stop for this node's identity (below). Acknowledging a
  state that is not on for this viewer also clears it: a file switched off or edited by anything else
  is never switched back on by itself. The store never raises `wanted` from false to true unless the
  owner's own `turnOn()` asks it to, after reading the stored state again under its lock: another
  copy of the controller holding a stale `wanted` can lower it, never raise it, and follows the store.
- While `wanted` is true and the file is off, the watch tries to resume: at once and then every 5
  seconds for 2 minutes after `start()` or after its own stop, then every 60 seconds. A stop within
  10 minutes of a resume backs off: the next try waits 60 seconds, then 2, 4, 8 and 16 minutes, then
  30 minutes at most, and later tries come every 60 seconds; once the entry stayed on for 10 minutes,
  the next stop waits 5 seconds again. It always tries again. `state().resume` is `{ waiting, nextAt }`.
- A resume writes only when all of this holds at that moment: no flag; no identity change seen; the
  file passes the reader, is for this viewer and port, holds one login and is off; its watched fields
  are exactly those main last wrote and kept (`enabled`, `host`, `port`, `viewerPort`, `logins`, and
  each device's id, hash and whether the reader keeps it; not a label that stays readable,
  `pairedAt` or an unknown field); `tailnetSelf()` is ok with the stored host and login (case
  ignored); and `serveState(host, port)` is ok. It then writes `enabled: true` and nothing else,
  under the lock, after reading the file again and finding it equal, key for key and value for value,
  to the one checked, and after checking that the watch is still started, no owner operation ran and
  main wrote nothing meanwhile. If the owner switched it off while it wrote, no resume is announced.
  Otherwise it calls `onResumed()`, and the watch checks Serve and the identity again at the next tick.
- A stop for Serve's shape (Funnel, another path, a TCP forward, a foreground session, a service)
  or for a Tailscale that is not up resumes once the shape is again exactly the one the owner
  switched on under. The owner is usually not at this Mac: an ad-hoc `tailscale serve` run in a
  terminal must not cost them the Inbox until they are back at the keyboard.
- A stop for this node's identity never resumes. When the host or login differ from the stored ones,
  or the node is tagged (at a check while on, or when a resume reads it), nothing is written, no
  device is removed, `wanted` is cleared and saved, and `state().needsOwner` is `identity_changed`:
  only the owner's switch turns it on again (which removes the devices if the identity still
  differs), across restarts too, even when the identity comes back.
- Off means off. When the state read for this `remote.json` and viewer says `wanted: false` (the
  owner switched sharing off) and the file is on for this viewer anyway, put back or edited behind
  the app's back, the watch switches it off again at the first look after `start()` and at every
  later file check: `enabled: false` and nothing else, the same write as its own stop, before any
  Tailscale read and without waiting for one. It calls `onStopped('not_wanted', { off, willResume:
  false })` once per occurrence, `state().stopped` says so, the change is flagged as any other
  (Review accepts the file as main left it), and a write that does not land is retried at every
  tick. It never writes `enabled: true`, never removes a device and is never a resume. Only an
  explicit `wanted: false` read for this file and viewer counts: with no state, a state for another
  file or viewer, a read that failed or timed out, or no state store, the change is only flagged,
  because an unknown is not the owner's Off.
- The owner's `turnOff()`, the watch's own stop and `repairPermissions()` never wait on the state
  store: they write `remote.json` first and the state follows. The watch's file check waits for the
  first read of the state (at most 5 seconds), because the first look needs the kept digest; a
  switch-off made before that read is judged once it is done. `settled()` resolves once every queued
  state write is done; main should call it before quitting.
- `onStopped(reason, { off, willResume })`: `willResume` is true when the watch will try to switch
  it back on (a pause, not a stop). `state()` adds `wanted`, `stateSaved`, `needsOwner`, and
  `resume: { waiting, nextAt }` while it waits, `waiting` being one of `tailscale_not_running`,
  `tailscale_unreadable`, `serve_not_ok:<reason>`, `flagged`, `changed_outside`, `needs_owner` or
  `write_failed`. After a stop that will not resume, `waiting` is never a Tailscale word, and after
  `stop()` `resume` is null.
- The state file is a tripwire against a silent change, not a boundary. A process that can write both
  files defeats it: it can set the digest to match its own edit, or set `wanted`. An edit to
  `remote.json` alone is flagged at the next start, including a file put back to an earlier state
  main wrote, unless the state could not be saved at all. Such a process can already switch the entry on by editing `remote.json`; the state file
  gives it nothing more.
- Every notice is raised on the hub: a pause, a stop, a resume and an outside change are native
  notifications on the hub Mac, where the owner usually is not. The next PRs must make a pause
  visible from the connected Mac too.

**Known limits.**

- A hash swapped under a just-paired id before the next check is announced as the expected
  pairing, because the viewer's `paired` list carries no hash; the owner's device then fails to
  connect.
- On the first run with a state store, a `remote.json` that already holds devices is flagged once,
  and `wanted` starts false: until the owner switches the entry on once, a stop is not a pause.
- For the owner's Off, the watch's own stop and the repair, the `pending` save is queued before the
  file write but not awaited, so those operations never wait on the state store. A crash in that
  window, followed by `remote.json` being put back, can start without a flag.
- The checkout build and the installed app keep one state between them: when both run, each save
  replaces the other's, and the other's next start reads no state (a file with devices is then
  flagged, and `wanted` is false). Safe, but noisy.

**`selfTest()`** first waits, as `turnOn()` does, up to 6 seconds for the viewer to listen, and
answers `not_listening` if it does not (PR 2d). It then fetches `https://<host>/api/version` from
main with no device secret, a 5-second timeout and redirects refused, and reads `entryStatus()`
before and after. A 502, 503 or 504 is `no_backend`: Serve forwards, but nothing answers behind it;
any other answer but 403 is `not_refused`. It passes on a 403 with
the `device` count up by exactly one; otherwise it names the counter that rose. A request from the
hub to its own Serve address carries its user's login (below), so that is the right pass. Nothing
else depends on the self test.

## The hub's Settings panel (PR 2d)

Settings → **Other devices** is where the owner decides to expose the whole hub. A paired Mac can
read everything and message sessions that may act without asking, so the panel says so beside the
switch. It is short, in plain words, and shows one thing to do at a time: the owner is usually not
at the hub.

**Main.** `electron/main.cjs` makes one controller per run, only on macOS and only when this app
started and owns its viewer (`viewerOwned`): `createRemoteEntry({ isPackaged, ownerToken:
OWNER_TOKEN, stateStore: createRemoteEntryState({ app }), onStopped, onResumed, onPaired,
onOutsideChange })`, started right after the viewer window loads, followed by one ping so a panel
drawn as `unowned` during start asks again. When the window regains focus, main reads Serve again
for the removal hint. On `before-quit` it calls `stop()`, then waits for `settled()` for at most 5
seconds, then quits. The block is one self-contained part of `main.cjs`; the logic is in
`electron/remote-entry-ipc.cjs`.

**The port.** `entryPort()` in `remote-entry.cjs`: 4320 for the packaged app. A checkout build uses
4393, or `AGENT_INBOX_REMOTE_PORT` when it is a plain integer from 1024 to 65535 with no leading
zero. That variable is for a checkout build only, so the panel can be tried against a Serve
configuration that already forwards to another port; the packaged app ignores it. It only names the
port main writes: it never turns the entry on.

**The channels.** Twelve `ipcMain.handle` channels, `agent-inbox:remote-entry` (get) and
`agent-inbox:remote-entry-{turn-on, turn-on-remove-devices, turn-off, remove-device,
clear-unreadable, repair, acknowledge, test, add-device, open-at-login, recheck}`, gated as Settings
→ Links is, in this order: the argument count and each argument's type (a 16-hex device id, a
64-hex digest, a boolean); then `installBinding.settled()`; then the viewer window's own top frame
(`linkSender`); then macOS; then the owned-viewer grant (`linkFilesPermitted`). A bad argument or
sender gets `{ available: false }`; another platform `{ available: false, reason: 'unsupported' }`; a
viewer the app did not start `{ available: false, reason: 'unowned' }`, and the panel says "Another
Agent Inbox viewer is running on this Mac, so this window can't change sharing. Quit it, then reopen
Agent Inbox." Main sends `agent-inbox:remote-entry-changed`, a bare ping, after each callback, each
operation, and each 5-second check whose answer differs from the last (a pause's next try counted to
the minute, so the panel is not rebuilt every 5 seconds); the page then asks again.

**What the page gets.** `get()` reads the viewer's status once, then builds one answer from one
`review()` and one `state()`: `{ available, enabled, host, port, devices: [{ id, label, pairedAt }],
unreadableDevices, problem, flag, digest, wanted, stopped: { reason, willResume } | null, resume: {
waiting, nextAt } | null, needsOwner, stateSaved, serve: { ok, reason } | null, removalHint, command,
loginItem: { available, openAtLogin, needsApproval }, listening, listenError, changes, refusal }`.

- `command` is `tailscale serve --bg <port>` for this build's port. `host` is shown because it is the
  address the other Mac types.
- `listening`: the viewer said it listens on this port in that status read; a read that failed is
  not listening. `listenError`: `port_in_use` or `cannot_listen` when the viewer could not bind it.
- `resume.waiting` is refined to `self_not_ok:<reason>` when the pause waits on a reading of
  Tailscale, so the panel can say "signed out" or "not installed".
- `changes` (only while flagged): what changed since the owner last accepted, from `review()`, as
  facts with no values (below).
- `refusal`: the last refused switch-on, `{ reason, step, devices, at }`, kept in main, not the page.
  It goes as soon as a later operation works, when anything the panel shows changes (a pause's next
  try aside), and 2 minutes after it at the latest: Tailscale's state is not in the file, so a
  refusal must not outlive the moment. The page keeps no refusal of its own, and draws it as a
  message under the status line, never as the status line (review round 2).
- `inboxUnreachable`: the last three status reads all failed (the viewer down, a non-200, a bad
  shape): the status line says "Needs you: Agent Inbox can't reach its own Inbox" with "Quit and
  reopen Agent Inbox." instead of "On, starting…".
- A stop older than the owner's last switch on or off here is left out: it is history.

Never a login, a secret hash, the owner token, a code's id or a raw Tailscale answer. Each operation
answers only `ok`, a reason word (and `step` and `devices` for a refused switch-on, `rose` for Test),
and its own counts. **Add a Mac** answers `{ ok, code, expiresAt }`: the code crosses to the page
because the owner reads it off the screen; nothing logs or keeps it.

**The bridge.** `agentInboxRemoteEntry` in `setup-preload.cjs` has exactly `get`, `turnOn`,
`turnOnRemovingDevices`, `turnOff`, `removeDevice(id)`, `clearUnreadable`, `repairPermissions`,
`acknowledge(digest)`, `test`, `addDevice`, `setOpenAtLogin(boolean)`, `recheck` and
`onChange(callback)`. It checks each argument before asking main, and rebuilds every answer field by
field; an answer with a field of the wrong shape is refused whole (`{ available: false, reason:
'failed' }`, or `{ ok: false, reason: 'failed' }`), except a `pairedAt` that is not a real date,
which becomes no date: one bad field of one Mac never costs the panel. `onChange` keeps one listener
and calls it with nothing.

**Notifications.** Native notifications, as plain text, about "your other Macs". Each is worded from
the same family as the panel's status line: a pause says "Paused: <why>. Open Settings → Other
devices to see what to do."; a stop says "<Why>. Open Settings → Other devices to see what to
do."; a resume, a pairing ("<label> can now use this Inbox.") and a change outside the app have
their own words. A pause, a stop or a resume is quieted only when it is the same kind and reason as
the last one shown, less than 10 minutes ago; a resume between two pauses lets the second through,
and so does the owner's own switch: when switching on (with or without removing the paired Macs),
off or Make it private works, main resets the notifier, dropping a held pause and the last one
shown.
A pairing and an outside change are never quieted (the controller announces each flagged state
once). For the first 2 minutes after the app starts, a pause is held: if it resumes within 2 minutes
nothing is shown at all, and if it still stands then, it is shown. The words come from
`public/remote-words.js`, which main imports and the panel uses; a test checks every reason word in
`remote-entry.d.cts` has words there.

**The review box.** When `flag` is set, the first thing in the section. It lists what changed since
the owner last accepted, from `review()`'s facts: sharing switched on or off, the address changed,
the allowed Tailscale account changed, the port changed, each Mac added and removed (by label), "the
key of <label> changed", and paired Macs that can't be read added or removed; then how the settings
are now. Facts carry labels and counts only: never the login, the host, the port or a hash. What it
cannot show: the values themselves (which account, which address), a rename that keeps a Mac
readable (not watched), and anything at all when the change happened while the app was closed, when
it says "Agent Inbox can't tell what changed, because it happened while the app was closed. This is
how the settings are now:". It always ends with "If you didn't make this change, switch sharing off
and remove the paired Macs." When the file cannot be read, it says so and offers no **Looks right**.
**Looks right** acknowledges the digest `get()` gave for exactly what is on screen; if the file
changed since, the panel redraws and says "It changed again; check the list."

**The panel.** Top to bottom, only the parts that apply: the review box; the switch, **Let my other
Macs use this Inbox**, with one status line that is always the present (Off; On, starting… while the
file is on but the viewer does not listen yet; On, at the address, with **Copy address**; Paused:
why, next try at a time; Needs you: why, from a standing stop, `needsOwner`, a problem with the file,
the port held by another program, or the app unable to reach its own Inbox); the risk sentence; one
instruction for the present (with a command and **Copy** when running it is the fix or shows the
cause, and **Make it private** for a file other accounts can read); a refused switch-on as a message,
"Switching on didn't work: <why, past tense>. <what to do>", or, when switching on would remove
paired Macs, the question naming them ("…has changed since laptop was paired. Switching on removes
laptop; pair it again afterwards." with **Switch on and remove it** / **Cancel**, or for several,
**Switch on and remove them**); **Paired Macs**, each
with **Remove** and an inline confirm, and paired Macs that can't be read with **Clear**; **Add a
Mac**, which shows the code, the address and a countdown until the code is used, runs out or is
cancelled by a later change; **Test** while on; the Serve removal command while off; **Open Agent
Inbox at login** (the packaged app only), with "Allow Agent Inbox in System Settings → General →
Login Items." when macOS wants it approved; and a line when the state store could not be saved.

- The switch shows what the file says (on, or paused), never what was clicked. While an operation
  runs every control in the section is disabled and the status line says "Switching on…",
  "Switching off…", "Removing…", "Making a code…", "Testing…" or "Saving…".
- **Test** and **Add a Mac** stay disabled until the viewer listens (Test runs when the port is held
  by another program, and says so). A Test result goes when a new test starts, when the switch
  changes, and when the state it described (on, starting, paused, off, or the address) changes.
- A message lasts until what it speaks of changes (on or off, listening, the digest, the problem,
  the flag or the paired Macs) and at most 2 minutes.
- Opening Settings asks main to read Serve again for the removal hint (`recheck`); while sharing is
  off and the hint is shown, main also reads it every minute, so the line goes once Serve no longer
  forwards here.
- With no `agentInboxRemoteEntry` (a browser, or this page on another Mac) nothing is drawn.

**Open at login** is `app.getLoginItemSettings()` and `app.setLoginItemSettings({ openAtLogin })`,
the packaged app on macOS only. A checkout build answers unavailable and never reads or sets it: a
development binary must never become a login item.

Not checked without running the app: the notification and login-item calls themselves (including
`status: 'requires-approval'`), the page in Electron's window, and a pairing end to end. The tests run
the controller against a stub, main's block against fakes, and the page in jsdom.

## Connecting from another Mac (PR 3a)

`electron/remote-connect.cjs` is what main on the connecting Mac (say a laptop) uses to reach a
hub. Its pure rules are in `electron/remote-connect-rules.cjs`, split for size only. Since PR 3b,
`electron/main.cjs` makes one on macOS and the hub view uses it ("The hub view", below).
`createRemoteConnect(options)` returns one object. Every dependency
is an option (`fsImpl`, `execFile`, `exists`, `fetch`, `safeStorage`, `hostname`, `now`,
`randomBytes`, `setInterval`, `clearInterval`, `onReload`), so the tests run no command, open no
socket, touch no Keychain and never sleep. It logs nothing. No public operation rejects: a throw
anywhere answers `{ ok: false, reason }`.

The device secret is a credential for the whole hub: agents there may run commands without asking,
and a message to a session is as good as running commands. This module is the only thing on the
laptop that holds it in plain text, and only in memory.

**The store.** userData `remote-connect.json`, written only through `createLockedFile` (temp file
and rename under the lock, mode `0600`): `{ schema: 1, active: <id> | null, hubs: { <id>: {
origin, label, node, machine, device, secret, deskCommand? } } }`, `id` 8 random hex characters. One
hub at most for now, but every hub value sits under its `id`. `deskCommand` (PR 4b) is the Open desk
command, stored only after the owner confirmed it in a native dialog ("Open desk", below); an entry
whose `deskCommand` fails its rule reads as having none and stays valid. There is no SSH host. Unknown
fields are kept, at the top level and in an entry. It is read the way the hub reads
`remote.json`: opened with `O_NOFOLLOW | O_NONBLOCK`, checked on the open descriptor, and read from
that descriptor. A symlink, a FIFO, a folder, another user's file or one with any group or other
bit is `bad_file`, and a FIFO never blocks a read. A file that cannot be read, is over 64 KiB, is not
JSON, has no valid schema, has a newer schema, or holds an entry that fails any rule reads as no
hub, with a fixed `problem`: `unreadable`, `bad_file`, `too_large`, `not_json`, `bad_schema`,
`newer_schema` or `bad_entry`. Such a file is written only by `forget` (when it parses) or by a
`connect` with `replace: true`, after the owner confirms. A newer schema is never written.

**The address.** `parseHubOrigin(text)` takes `https://<host>` or a bare host, to which it adds
`https://`. It refuses, as `bad_address`: any other scheme (`http:` included), user info however it
is written (below), a port (even `:443`), a path other than `/`, a query or fragment (even empty), a space,
tab, newline, control character, backslash or `%` anywhere, and a host that fails the reader's host
rule (so an IP address, a trailing dot, an underscore or a non-ASCII name). The host is lowercased;
the answer is `https://<host>` with no trailing slash. Each rule is checked on the text as written,
because the URL parser drops an empty user, `:443`, an empty query and tabs without a trace.

**The hub must be one of the owner's own untagged devices.** `findHub(host)` runs `tailscale status
--json` (the full peer list, 16 MiB cap) through `electron/remote-tailscale.cjs`, and answers `{
ok: true, node }` only when: the backend is `Running`; this node has no tags and its `UserID`
names a user that is not Tailscale's placeholder for tagged devices; `host` is one label in front of
the tailnet's MagicDNS suffix; and exactly one peer has that `DNSName` (lowercased, trailing dot
dropped), with no tags (`null` and `[]` count as none), the same `UserID` as this node, and a
string `ID`. That `ID` is the node: Tailscale's stable node id, which the real output carries as
`ID` (there is no `StableID` key). `UserID` is read from the JSON text, so ids past 2^53 are
compared by their digits, never as floats. Otherwise a fixed word: `no_cli`, `failed`,
`not_running`, `tagged_self`, `not_in_tailnet`, `not_found`, `duplicate_name`, `not_your_device`,
`tagged_device`. The document is parsed inside the call and only the node leaves it.

A node is never in its own `Peer` list, so `host` may also be this node's own `DNSName` (same
lowercasing and trailing-dot rule): a copy of the app on the hub can connect to the hub's own
address, which lets the hub view be proved on one machine. Then this node must pass the same
checks as above (untagged, a person's user), no peer may carry the same name (`duplicate_name`),
and the node is `Self.ID` (`not_found` when it is not a string `ID`). Added in PR 3b.

The tailnet rules are mirrored from meshctl (`inTailnet` in `src/mesh-config.ts`, `suffixFrom` in
`src/meshctl.ts`), not loaded from `dist/`, so the module stays synchronous and works without a
build; the code rule (`normaliseCode`) and the label rule (`isDeviceLabel`) are mirrored from
`src/remote-pair.ts`. Tests compare each copy with the TypeScript one over many inputs.

**Connect.** `connect({ address, code, replace })`, in this order:

1. Refused off macOS (`unsupported`) and without `safeStorage.isEncryptionAvailable()`
   (`no_keychain`): there is no plain-text fallback.
2. `parseHubOrigin`, then the code, normalised the hub's way (case, spaces and dashes ignored, `I`
   and `L` read as `1`, `O` as `0`, then exactly 10 Crockford characters). A malformed code is
   refused here (`bad_code`), because on the hub it would use up one of the code's five tries.
3. The file: a newer schema (`newer_schema`), a bad file without `replace` (`bad_file`), or a hub
   already stored without `replace` (`hub_exists`) is refused before the code is spent.
4. `findHub`.
5. `POST <origin>/api/remote/pair` with exactly `Origin: <origin>` and `Content-Type:
   application/json`, the body `{ code, label }`, `redirect: 'error'` and a 5-second timeout. No
   device header, no cookie. The answer must be a 200 with `x-agent-inbox-remote-boundary:
   tailnet-v1` and a JSON body of at most 1 KiB with `ok === true`, a 16-hex `device` and a
   43-character base64url `secret`. Otherwise: `unreachable` (a network error or timeout, a
   redirect, plain HTTP on port 443), `bad_certificate`, `not_agent_inbox` (a 200 without the
   marker, any status but 403, a body of the wrong shape), or `refused` (a 403). The hub answers
   the same bare 403 for a wrong, expired or used-up code and for a login it does not allow, so
   `refused` cannot say which.
6. The secret is encrypted with `safeStorage.encryptString` and stored as base64, with `node`,
   `device`, `origin` and a provisional label, under a new `id`, made `active`. When this step
   fails after the hub has paired (the Keychain refuses, the write fails), the answer carries
   `pairedOnHub: true`: the hub lists a device this Mac cannot use, to be removed there.
7. `probeHub`. When it is online, `machine` and the final label are stored. When it is not, the
   pairing is kept and the answer says the state: `{ ok: true, id, label, state, reason }`. After
   `stop()`, the hub is stored but not probed: `state: 'retrying', reason: 'stopped'`. When the
   owner forgets the new hub during this probe, the answer is `{ ok: false, reason: 'forgotten' }`.

With `replace: true`, a hub already stored is replaced and the answer carries `replacedHub: true`.
This Mac stays paired on the old hub: it still lists the device until it is removed there, in that
hub's Settings, as after `forget`.

This Mac's name on the hub (the `label` sent with the code) is its own short host name: the part
before the first dot, without characters the label rule refuses, at most 40 characters, else `Mac`.
The hub's name on this Mac is the `machine` it reports in `/api/version` (cut to 40 characters),
else the first label of its address. The form asks only for the address and the code.

A certificate error is recognised the way Node's `fetch` reports one: a `TypeError` "fetch failed"
whose `cause` (or a deeper cause) carries OpenSSL's verify code, such as
`DEPTH_ZERO_SELF_SIGNED_CERT`, `CERT_HAS_EXPIRED`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or
`ERR_TLS_CERT_ALTNAME_INVALID`. Those two shapes were seen on Node 24 against a local server with a
self-signed certificate and with one issued to another name.

**The secret in use.** It is decrypted once per connection state and kept only in this module's
memory. A JavaScript string cannot be wiped, so "cleared" means the module drops its only
reference: on `forget`, on `stop`, on a new pairing or a new stored hub, and whenever a node check
fails, Tailscale unreadable included.

User info is refused however it is written, by one rule the address check, `deviceHeaderFor` and
`hubFetch` share: after removing tabs and newlines and trimming edge spaces and controls, as the URL
parser does, any `@` before the first `/`, `?` or `#` that follows the scheme and its leading
slashes and backslashes. So `https://@host/`, `https://:@host/`, `https:@host/`, `https:\@host/`
and `https:/\@host/` are all refused, though each parses to the hub's own origin.

- `deviceHeaderFor(url)` is synchronous and cheap, for the hub view's `onBeforeSendHeaders`. It
  answers the secret only when a hub is active, the module is not stopped, the last node check
  passed and nothing has distrusted it since, `url` is a string or a `URL` (its `href` read once)
  that parses as `https:` with no user info, and its origin equals the hub's
  `https://<host>`, compared as parsed origins, never as string prefixes. The default port and a
  host written in another case are the same origin; another port, a sub-domain, a look-alike that
  starts or ends with the hub's name, and a trailing dot are not. The URL half of that decision is
  `hubHref(url, origin)` in `remote-connect-rules.cjs`, which the hub view's navigation and
  permission rules use too, so there is one parser.
- `hubFetch()` returns a `fetch`-shaped function for main's own requests to the hub. It reads its
  input once, decides on that one parsed value and fetches exactly its `href`, so a `URL` whose
  `href` changes between reads cannot move the request. It rejects (before calling `fetch`) any
  input that is not a string or `URL` on the hub's origin, sets the header (replacing one the
  caller set), forces `redirect: 'error'` and a 5-second timeout joined to the caller's signal, and
  rejects a 3xx response a `fetch` handed back anyway. Its own refusals carry a fixed message and
  code (`not_hub_origin`, `redirect`); a network error passes through as the runtime's own error,
  and none of those seen holds the secret.

**The node check.** Before every probe, online ones included, `findHub(host)` runs again (a peer
list of about 600 KB parses in a few milliseconds). A check counts only when nothing distrusted the
last one while it ran: a `kick()`, a failed probe, a dropped secret, `stop()` or `forget()` each
make a check already in flight stale, so a peer list read before a wake event never lets the secret
out, and the round the kick asked for reads the peers again. When the node differs
from the stored one, or the hub is no longer this person's untagged device, nothing is sent, the
secret is dropped from memory, and the state is `refused` with `node_changed` (or the `findHub`
word). It is checked again every 60 seconds; only the stored node passes, so it stays refused until
the name is back on that node or the owner pairs again. When Tailscale cannot be read (`no_cli`,
`failed`, `not_running`), nothing is sent and the state is `retrying`: the secret is never sent on a
guess. A stored secret that cannot be decrypted is `refused` (`secret_unreadable`); a Keychain that
is not available is `retrying` (`no_keychain`).

**The probe.** `probeHub()` sends `GET <origin>/api/version` through `hubFetch` and answers `{ ok:
true, state, version, machine }`: `online` only for a 200 with the marker and a JSON body (at most
64 KiB) whose `current` is a string of 1 to 64 characters with no control character, with
`machine` kept only when it passes the place-name rule; `refused` for a 403 (this Mac is no longer
paired, or its login is no longer allowed); `unreachable` for a network error, a timeout, a
certificate error or a redirect; `not_agent_inbox` for anything else. When the node check holds the
request back, it answers `{ ok: false, reason }` with the check's word and sends nothing.

**The connection state.** `start()` sets a 1-second timer that calls `tick()`; tests call `tick()`
themselves. `connection()` answers `{ mode: 'local' }` with no active hub, else `{ mode: 'hub', id,
label, state, reason, version }`, `state` one of `online`, `retrying` or `refused`. Before the first
probe it is `retrying` with the reason `connecting`. `onConnection(callback)` returns an unsubscribe
function and calls back only when the answer changes; a callback that throws stops nothing.

- Online: probed every 60 seconds, with the node check before each probe.
- Retrying: from 2 seconds, doubling to 60 (2, 4, 8, 16, 32, 60, 60, ...), with the node check
  before each try.
- Refused: tried every 60 seconds.
- `kick()` (main calls it on wake, unlock and when the network comes back) holds the header
  back at once, resets the backoff, and checks the node and probes straight away; a kick that lands
  during a check makes that check stale and runs another. It answers `{ ok: true }`.
- When `version` differs from the last online probe's, `onReload()` is called once. The first online
  probe after start does not call it.
- Probes never overlap: connect, forget and every probe run one at a time.
- `stop()` clears the timer, drops the secret and any probe or node check in flight, and nothing
  more is sent until `start()`. For an active hub `connection()` then answers `state: 'retrying',
  reason: 'stopped'`; `deviceHeaderFor` answers null; `probeHub()`, `kick()` and `tick()` do nothing
  and answer `{ ok: false, reason: 'stopped' }`. `connect()` and `forget()` still change the store,
  but start no probing. Only `start()` resumes.

**`view()`**, for the Settings form: `{ available, keychain, hub: { id, label, origin, machine,
state, reason } | null, problem }`. It never holds the secret, the encrypted blob, the device id or
the node id. `available` is false off macOS. `problem` is `forget_not_saved` while a `forget` has not
been written (below). `keychain` is false once the Keychain was needed and could not be used, and
true before anything needed it: `view()` asks `safeStorage` only after a connect or a stored hub's
start has. This Mac's own page reads `view()` at every start (the strip), and
`safeStorage.isEncryptionAvailable()` reads or creates the app's Keychain item on macOS, so asking
there would touch the Keychain, and could prompt, for people who never use another Mac's Inbox.

**`forget(id)`** removes the hub's entry, clears `active`, drops the secret and stops the retries at
once, even when the file cannot be written. When the write does not land, the file still holds the
hub and its encrypted secret, which a restart would use, so `view()` says `forget_not_saved` and the
next `connect`, `forget` or probe writes it again. The hub still lists the device until it is
removed there, in the hub's Settings.

**What it never does.** It runs no Tailscale command but `status --json`, and never changes
Tailscale. It never sends the secret to any origin but the active hub's, never follows a redirect,
sends no cookie, never stores the secret unencrypted, never returns, logs or throws the secret or
the code, and never sends the pairing request with a device header.

**What the hub view does with it (PR 3b).** These were the next PR's duties; "The hub view",
below, says how each is met.

- The hub view's partition must use a direct connection (`session.setProxy({ mode: 'direct' })`).
  Chromium uses the system proxy and trust store while main's `fetch` does not, so a
  TLS-intercepting proxy with a root the user trusts would otherwise see the device header.
- Its `onBeforeSendHeaders` handler must delete every page-set device header, whatever its case,
  before it sets the one `deviceHeaderFor(details.url)` gives.
- `wss://` gets no header: the hub's page must not depend on one there.
- While the header is withheld (before the first check after `start()`, after a `kick()` until the
  next check passes, after a failed probe, while `refused` or `stopped`), the hub answers the page's
  requests with bare 403s. The view shows the offline page before the first hub page has loaded and
  whenever the state is `refused`; a hub page already loaded stays through `retrying`, so drafts
  survive a short drop, and the bridge tells the page the state (below).

## The hub view (PR 3b)

When a hub is connected, the hub's own page is loaded from the hub and shown in this app's window,
in a view of its own. That page comes from another machine, so it gets none of this app's
privileges, and no page can read the device secret. The policy is `electron/hub-view.cjs`, with
every Electron object injected, so `test/hub-view.test.ts` runs without Electron.
`electron/main.cjs` only wires it.

**The view.** One `WebContentsView` for the active hub, laid over the window's content area below
a top inset, and following its resizes. Since PR 3c the local page draws whose Inbox is on screen
in that inset ("The connecting Mac's screens", below): the strip is `HUB_STRIP_HEIGHT` (36) CSS
pixels of the local page, so the inset is `insetFor(zoom)`, that height times the local page's zoom
factor, rounded, in window pixels, read again whenever the view is laid out or put on top. The View
menu's Actual Size, Zoom In and Zoom Out are `zoomMenuItems`: they do what Electron's roles do to
the focused contents and then lay the view out, since no event says the local page's zoom changed.
The view gets the window's own opaque background colour before it is added, so a view whose page
has not painted yet never lets this Mac's page show through under a strip that names the other
Mac. The local page stays loaded underneath and is never unloaded. Its
`webPreferences` are exactly `preload: electron/remote-preload.cjs`, `contextIsolation: true`,
`sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `disableDialogs: true` (a macOS sheet
shows no origin, so the page could put up a dialog that looks like the app's own) and `partition:
persist:hub-<id>` (`partitionFor` throws for anything but an 8-hex id). Before anything loads, the
partition's session gets:

- `setProxy({ mode: 'direct' })`, awaited. Chromium would otherwise use the system proxy, and a
  TLS-intercepting proxy would see the device header.
- `webRequest.onBeforeSendHeaders` for every request, whatever its URL or type, through
  `sendHeaders`: every header named `x-agent-inbox-device` in any case is removed first, then the
  one `deviceHeaderFor(details.url)` answers is added, if it answers one and the URL is on this
  partition's own hub's origin. So a page-set header never leaves, and the secret goes only to the
  hub's exact origin over `https`, after a passed node check: never to `wss:`, `blob:`, `file:`, plain
  `http:` or a redirect target on another origin. The own-origin check matters during a replace:
  `deviceHeaderFor` already answers for the new hub while the old hub's partition may still send.
- Permission request and check handlers that allow only `clipboard-sanitized-write`, asked by the
  top frame of a page on the hub's origin (`allowPermission`). A device permission handler that
  denies every device.
- `will-download` cancelling every item.

No `certificate-error` handler is registered, so Chromium refuses a certificate it does not trust.
A `select-client-certificate` request from the view is answered with no certificate (Electron's
default would offer the first identity in the store to any server the page makes this Mac contact).
In a packaged app, developer tools are closed as soon as they open on the hub view, since the
Network panel shows the device header as sent; a checkout build keeps them.

**Navigation.** `will-navigate`, `will-frame-navigate` (every frame) and `will-redirect` are
prevented unless `allowNavigation` holds: an `https` URL whose origin is exactly the hub's (the
same `hubHref` rule as the device header) or the offline file's exact `file:` URL, with no query
or fragment. A prevented top-level `http(s)` navigation goes to the system browser through
`openWebLink` only when `mayOpenExternally`: the view has focus and there was a key press or a click
in the view in the last 5 seconds. Any key press counts, so typing into the hub's page counts.
Input is a key event (`before-input-event`) or a press (`input-event` of type
`mouseDown`, `mouseUp`, `keyDown`, `rawKeyDown`, `keyUp`, `char`, `gestureTap`, `touchStart`,
`touchEnd`); a mouse move or wheel does not count. Each input opens at most one link: it is used up
by the open. `setWindowOpenHandler` always denies, and opens an `http(s)` URL externally by the same
rule. A sub-frame never opens anything.

**What it shows**, from the controller's `onConnection`:

| Connection | View |
|---|---|
| `retrying` with reason `connecting` (the first check after start), nothing loaded | nothing yet |
| `online`, no hub page loaded | loads `<origin>/` |
| `online` or `retrying`, a hub page loaded | keeps it (drafts survive a short drop) |
| `retrying`, no hub page loaded | the offline file |
| `refused` | the offline file, even over a loaded hub page |
| a hub page fails to load (not an aborted load), or its renderer goes away | the offline file |
| `onReload` (the hub's version changed) | reloads a loaded hub page, bypassing the cache |
| the active hub goes away (`forget`, or a new hub replaces it) | the view is closed, This Mac is shown, and the partition's session is asked to clear everything (below) |
| the hub's page closes its own view (`window.close()`) | the dead view is dropped and This Mac shown; a fresh view comes at the next connection change or `show(id)`, at most 3 a minute, after which only `show(id)` makes one, once the minute has passed (`busy` until then) |

The origin comes from the controller's `view()` and must be a canonical `https://<host>`, or no
view is made. A failing offline file is not loaded again, so nothing loops. When the window closes,
the view is closed first and its session kept, so what the page writes as it goes away reaches the
session; `will-quit` then writes the partition's storage to disk (`flush()`), and that storage stays.
On quit, main stops the controller first (`before-quit`).

**Clearing a partition.** When the active hub goes away, the session's `clearData()` is called with
no options, which clears every type it knows (cache, cookies, local storage, IndexedDB, service
workers, file systems and the rest), also for a partition still being set up. `forget` answers once
that is done, or after 5 seconds. At start, the names in the profile's `Partitions` folder are listed
and every `hub-<8 hex>` partition but the stored hub's is cleared the same way; nothing is cleared
while the store reports a problem or the folder cannot be read. Only sessions are asked: no file is
removed, so the folders themselves stay.

**Which view is on top.** This Mac stays on top until something asks: `show(id | null)`, from the
View menu's **This Mac** and **<the hub's label>** (a radio pair, present only while a hub exists)
or from `agentInboxConnect.show`. An id other than the active hub's is refused. **Settings…**,
**Check for Updates…**, an update notification and a click on an attention notification show This
Mac first. The window title is `Agent Inbox — <label>` while the
hub's view is on top. Focus moves to the view that comes forward.

**Settings… while the hub is on top.** Settings is on This Mac's page, so **Settings…** and
**Check for Updates…** bring that page forward (`showSettings` and `openUpdatesWindow` in
`main.cjs`, both through `openSettings` in `hub-view.cjs`) and send their message
(`agent-inbox:toggle-settings`, `agent-inbox:open-updates`) with `true` when the hub was on top.
The page then opens Settings instead of toggling them, gives them the keyboard, and closing them
with the shortcut, the gear or Escape calls `agentInboxConnect.show` with the id of the hub that
`view()` names then, so the hub's Inbox is on top again. Choosing a tab or a project on This Mac's
page, or the hub coming back on top by another way, forgets that.

Cmd+, does this wherever the keyboard is. In the hub's view, `before-input-event` takes the
shortcut (Cmd+, and also Ctrl+,, which the hub's page would otherwise handle itself) before the
hub's page and before the menu, and calls `showSettings`. On This Mac's page under the strip, the
strip stops Cmd+, without cancelling it, so the menu item acts. A held key acts once: the hub view
and the page cancel its repeats. Before this, the hub's page handled the key itself unless a
button or link had focus, and the menu item toggled This Mac's Settings, which closed them when
they had been left open underneath.

**After a restart (#635).** Whose Inbox the person chose is stored with the connection:
`shown: true` on the hub's entry in `remote-connect.json` (`remoteConnect.setShown`, written only
when it changes, read back by `storedHub()` with no Keychain). The hub view reports it through
`onChosen`. The hub's Inbox on top always counts. This Mac counts only when the person picked it:
the View menu's **This Mac** and the strip's, which arrive as `show(null, true)`. So
**Settings…**, **Check for Updates…** and a click on one of This Mac's notifications leave what is
stored alone, and an update's restart comes back to the hub. At start, main reads `storedHub()`
and calls `hubView.restore(id)` when it says `shown`. The view then comes on top by itself as soon
as it exists and this window's page is the owned one, with the hub's page or, when the hub is out
of reach, the offline page. Any `show(null)` before that gives the restore up, and so does a
minute passing (`RESTORE_WINDOW_MS`), so a view that is slow to appear never jumps over what the
person is doing.

Since PR 3c, the hub's view is on top only while this window's own page can draw the strip, and
`current()` names a hub only when its view really is on top:

- One guard, `mayShow` (main passes `fileLinkWebContentsId !== null && fileLinkWebContentsId ===
  win.webContents.id`: the window shows the viewer the app started and owns, the only page that
  hears `agentInboxConnect`), decides every way of showing the hub, since all go through
  `show(id)`. Without it `show(id)` answers `not_owned` and the View menu leaves the hub pair out
  (`canShow()`). An absent `mayShow` is false.
- When the binding changes (a reload, a navigation, a renderer that went away, the binding proved
  again), main's install binding calls `ownerChanged()`: on a loss This Mac comes forward, and the
  menu follows either way.
- A build that stops early (the store no longer names the hub, the session could not be set up)
  clears what is being built, so the next connection change or `show(id)` tries again, and drops a
  `show` that was waiting for it. `show(id)` with no view and none being built answers `not_ready`
  and starts one; with one being built (or rebuilt after the page closed itself) it is accepted,
  and `current()` stays null until that view is on top.

**`agentInboxDesk`, in the hub view.** `remote-preload.cjs` is the view's only preload and exposes
exactly one object, `agentInboxDesk`, and nothing else on `window`. It runs sandboxed and requires
only `electron`. Every answer is rebuilt field by field in the preload, so an unexpected field
never crosses:

- `available()` → a promise of `{ open }` (PR 4b): main's `agent-inbox:desk-available`, reduced to
  whether `open` is exactly `true`. Any argument, any other answer and any error are `{ open: false }`.
- `open({ session })` (PR 4b) → a promise of `{ ok: true, notice? }` or `{ ok: false, reason }`,
  `reason` one of a fixed list of words. Anything but exactly one plain object holding exactly a
  `session` id is answered `bad_request` by the preload itself, without asking main; the request
  goes to main as a fresh `{ session }`.
- `connection()` → a promise of `{ mode: 'hub', label, state, version }`, `state` one of `online`,
  `retrying` or `refused`, or `null` when main refuses. Never an id, an origin or a reason.
- `onConnection(callback)` → an unsubscribe function. Main's change message carries nothing; the
  preload asks `connection()` again and calls back with that.
- `retry()` → a promise of `{ ok }`. Main takes it only from the offline file: it kicks the
  controller (the node check and a probe at once) and loads the hub page if the hub is online.

Main answers `agent-inbox:desk-connection` and `agent-inbox:desk-retry` only
when `trustedDeskSender` holds, checked on every call from `event.sender` and `event.senderFrame`:
the sender is the hub view's own `webContents`, not destroyed, and the frame is its top frame
(`parent === null`) on the hub's origin or on the offline file. A sub-frame, the view after it
showed anything else, and the local window's `webContents` are all refused, with `{ available:
false }` (or `{ ok: false }` for retry). Off macOS there is no view: `desk-connection` answers `{
available: false }` and `desk-retry` answers `{ ok: false }`. PR 4b's `agent-inbox:desk-available`
and `agent-inbox:desk-open` are narrower: only the top frame on the hub's own page (`'hub'`), never
the offline file ("Open desk", below).

**The offline page.** `electron/remote-offline.html` with `remote-offline.js` and
`remote-offline.css` beside it: no inline script or style, a Content-Security-Policy meta of
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none';
font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, and no remote
resource. It says "Can't reach <label>" with **Retry**, or, when refused, "<label> no longer
accepts this Mac" with the instruction to pair again in Settings on This Mac, and no Retry. It gets
its words only through `agentInboxDesk`, sets the label with `textContent`, and follows light and
dark through `prefers-color-scheme` alone.

**In the local page.** `setup-preload.cjs` gains the same `agentInboxDesk`, answering `{ mode:
'local' }` and `{ open: false }`, with a no-op `onConnection`, and no IPC. It has no `open` (PR 4b):
Open desk is offered only in the hub's page. It also gains
`agentInboxConnect`, for the Settings form a later PR adds:

- `view()` → the controller's `view()` plus `showing` (the id on top, or null).
- `connect({ address, code, replace })`, `forget(id)` → the controller's answers.
- `show(id | null)` → `{ ok: true, showing }` or `{ ok: false, reason }` (`bad_id`, `not_found`, `busy`).
- `onChange(callback)` → an unsubscribe function; the message carries nothing, so the page asks
  `view()` again.
- `setDeskCommand({ id, command })` (PR 4b) → `{ ok: true }` or `{ ok: false, reason }`; exactly
  those two keys, both text. Main shows the command in a native dialog before it stores it.

The preload checks each argument and rebuilds each answer field by field. Main
(`registerHubIpc`) answers these four channels only for the viewer this app started and owns
(`linkSender` and `linkFilesPermitted`, after `installBinding.settled()`, as chat resume is),
checks the argument count and each type again (`connect` takes exactly one plain object with only
`address`, `code` and an optional boolean `replace`), and answers anyone else `{ available: false
}`. A viewer this app reused rather than started (no file-link grant) gets the same. Off macOS
there is no controller, and these four channels answer `{ available: false }`. No answer
holds the secret, the encrypted blob, the device id or the node id: a test sends every channel
through the real controller and scans the answers.

**Main's wiring.** On macOS only, after the window exists: one `createRemoteConnect({ app,
safeStorage, onReload })`, the hub view, `kick()` on `powerMonitor` `resume` and `unlock-screen`
and when `net.isOnline()` turns from false to true (read every 10 seconds; main has no event for
it), then `start()`. `stop()` runs at the top of `before-quit`. Nothing in the hub view is ever
assigned to `linkWindow`, `themeWindow`, `updateWindow`, `fileLinkWebContentsId`, the install
binding, or any launch or chat grant; `test/main-ipc.test.ts` pins each assignment. That test also
runs the real `main.cjs` top level against a fake `electron`, enumerates every channel it
registers, and requires each to be classified (local page only, or hub view for the two desk
channels): a channel added later fails until someone classifies it. Every local-only channel must
answer the hub view (its top frame, a sub-frame, the offline file, or a frame claiming the local
viewer's URL) exactly as a stranger, and call nothing. Its fake `BrowserWindow.fromWebContents`
answers the window for the hub view too, so a handler that trusted "a page in my window" would be
caught, and a source check finds no handler registered through `webContents.ipc` or a frame's `ipc`.

**Not built yet.** Keyboard shortcuts for the menu items. Open desk is PR 4b ("Open desk", below). Notifications and the dock badge for the hub are PR 4a ("Attention
from the hub", below). The Settings form, the
strip and the page's hub mode are PR 3c, below.

## The connecting Mac's screens (PR 3c)

The hub's page controls every pixel of its view, and its label is the hub's own machine name (from
its `/api/version`). So what says whose Inbox is on screen is drawn by this app's own page, outside
that view, and nothing is built on the label being true: it is display text, always set with
`textContent`. A machine name that reads as This Mac or local (`thismac` or `local`, ignoring case,
spaces, `-` and `_`) is not used: `hubLabelFor` takes the first label of the address the owner
typed instead.

**One word per state**, `stateWord` in `public/connect-settings.js`, used by the strip and the form,
and by the other Mac's page for `retrying`:

| State | Word |
|---|---|
| `online` | Online |
| `retrying`, reason `connecting` (the first check) | Connecting… |
| `retrying`, any other reason | Reconnecting… (the other Mac's page: "Reconnecting to <label>…") |
| `refused` | Not connected (every refused reason: the other Mac may still list this one) |
| not known | Checking… |

**Settings → Use another Mac's Inbox** (`public/connect-settings.js`, `renderConnectSettings`,
called from `renderSetup` after Other devices). Drawn only where `window.agentInboxConnect` exists
and `agentInboxDesk.connection()` answers `{ mode: 'local' }`: a missing desk, one that answers null
or throws, and the hub's page draw nothing and ask main nothing. One state at a time, from
`agentInboxConnect.view()`, read again on every `onChange` and when Settings opens; a read that
lands after a newer one is dropped.

| State | What it shows |
|---|---|
| `available: false` | one sentence: macOS only (when `navigator.platform` is not a Mac), else that another Agent Inbox viewer is running, so this window can't use another Mac's Inbox: quit it, then reopen Agent Inbox (the hub panel's sentence for the same case is the model; main answers both the same way) |
| no hub, `keychain: false` (only after a connect found the Keychain unusable) | one sentence about the Keychain (unlock, choose Allow if macOS asks); no form |
| no hub | **Address** (placeholder `mac-name.tail1234.ts.net`), **Code** and **Connect**, and one line of help naming Settings → Other devices → Add a Mac on the other Mac; a saved file's `problem` is said above it, and `newer_schema` hides the form, since that file is never written |
| no hub, `problem: 'forget_not_saved'` (main's answer after a disconnect whose write failed) | "This Mac has stopped using the other Mac's Inbox, but couldn't save that. Connecting a Mac will try again.", with the form |
| connecting or disconnecting | every input and button disabled, and "Connecting…" or "Disconnecting…"; main may store the hub before `connect()` answers, but the form stays until it does |
| a refusal | one sentence per reason, with what to do next; the fields keep what was typed |
| a hub | "<label>'s Inbox", the address's host, its status (the word, then why), **Show its Inbox** (`show(id)`) and **Disconnect** |

- The code is checked here first with a copy of the hub's `normaliseCode` (case, spaces and dashes
  ignored, `I` and `L` read as `1`, `O` as `0`, exactly 10 Crockford characters; the test compares
  it with the controller's over thousands of inputs), and the normalised code is what is sent. A
  malformed code and an empty address are never sent. The address is trimmed; the controller checks
  the rest.
- Every word `connect()` can answer (`ConnectReason`, `HubReason` and `forgotten`, `changed`,
  `failed`, read by the test from `electron/remote-connect.d.cts`) has its own sentence; a word
  added there fails the test until it has one. None says "tailnet" ("your Tailscale network"), a
  tagged device is "belongs to a tag, not to your account", a certificate problem points at
  Tailscale's HTTPS certificates, and `failed` (also what the preload answers for any failed call)
  blames nothing in particular. An unknown word gets "Agent Inbox couldn't connect. Try again." An
  answer with `pairedOnHub` says the other Mac now lists this Mac and that it should be removed
  there before trying again with a new code, whatever the reason.
- `hub_exists` and `bad_file` offer **Replace it**, which asks inline ("This Mac stops using
  <label>'s Inbox and uses the new one. <label> keeps this Mac in its list until you remove it
  there.", or "This replaces the saved connection on this Mac.") with **Replace** and **Keep**.
  Replace calls `connect` again with `replace: true` and the address and code of the refused try
  (both refusals come before the code is spent); typing in either field drops the offer and its
  question, so Replace never sends what was typed before. `replacedHub` then says, as a note and not
  in the error colour, that the old Mac still lists this Mac. Keep reads the view again. A
  `hub_exists` while main names no hub and reports `forget_not_saved` is that unsaved disconnect,
  said as such, with no Replace.
- The status is the word, then why, from `hub.reason`: a sentence for each reason the controller
  retries on (cannot reach, the certificate, not sharing with the switch to check on the other Mac,
  Tailscale on this Mac missing, unreadable or not running, the Keychain) and one per refused reason,
  with "To pair again: press Disconnect, then connect with a new code from <label>.".
- **Disconnect** asks inline ("This Mac stops using <label>'s Inbox. <label> keeps this Mac in its
  list until you remove it there.", **Disconnect** and **Keep**, focus on Keep), then calls
  `forget(id)`. A question about something no longer on screen is closed. A disconnect whose write
  failed shows the `forget_not_saved` sentence above, not "couldn't disconnect".
- `show(id)` refusals: `busy` (the hub's page closed itself), `not_found`, `not_ready` (its view is
  not ready yet), `not_owned`, else a plain retry line.
- A sentence from an answer goes when what is shown changes (the hub, its state, or what is on top)
  and when Settings is opened again; an open Replace offer keeps its own until it is answered.

**The strip** (`public/hub-strip.js`, `installHubStrip`, made at boot). Drawn by this Mac's own page
under the same rule as the form, and only while `view().showing` is the stored hub's id: a `div`
with `role="region"` named "Whose Inbox is on screen", fixed to the top of the window,
`HUB_STRIP_HEIGHT` CSS pixels tall (main lays the view out at that height times the local page's
zoom, above), prepended to `body`. It says "Showing <label>'s Inbox", the word, and **This Mac**,
which calls `show(null)` and reads the view again. In a narrow window the word gives way first, then
the name; This Mac never does.

- This Mac is never disabled: it is this Mac's own IPC and works whether or not the hub answers.
- An answer that is not `available: true` (the preload turns every failed call into `{ available:
  false }`) or a read that throws changes nothing on screen: the strip reads again after 1, 2, 4, 8
  and 15 seconds, then every 30 seconds, until main answers. A read that lands after a newer one is
  dropped. Known limit: when this Mac's own page reloads while the other Mac's Inbox is on top (it
  reloads itself when the local viewer restarts), main brings This Mac forward at once, and the old
  page, inert and about to be replaced, keeps its strip until the new page loads.
- While it shows, this Mac's page is covered by the other Mac's view and acts only through the
  strip: every other element of `body` (and any added meanwhile) is `inert`, and every `keydown`,
  `keypress` and `keyup` is stopped on the window in the capture phase, before any of the page's
  own handlers, wherever it is aimed (with the triage deck open the page's handler acts on a digit
  even when a button has focus: `1` pressed on This Mac answered a hidden question). A key aimed
  outside the strip also loses its default action, and Tab from outside moves focus to This Mac;
  inside the strip the browser's own action stays, so Enter and Space press This Mac. Both end the
  moment the strip goes, and what was inert before stays inert. (Reproduced in the real app before
  this: with the other Mac's Inbox on top, `j` then `e` resolved a question on this Mac's hidden
  Inbox.) The strip is reached by keyboard from this Mac's page, which has focus only after a click
  on the strip; from the other Mac's view, View → This Mac is the keyboard's way back.
- With nothing shown the strip is not in the document. `HUB_STRIP_HEIGHT` is 36 in both
  `public/hub-strip.js` and `electron/hub-view.cjs`; `test/dom/hub-strip.test.ts` pins them equal,
  and the page sets the strip's height from its own constant.

**Hub mode** (`public/hub-mode.js`, `installHubMode`, made before `renderSetup`). The same `public/`
code runs in the hub view, where `agentInboxDesk.connection()` answers `{ mode: 'hub', label,
state, version }` and no other bridge exists. The mode is read once at start and on `onConnection`,
every member feature-detected: no `agentInboxDesk` (a browser, an older app) is local at once and
the page is exactly as before; a present desk is local only when its first answer is `{ mode:
'local' }`, and any other answer, null or a throw is hub mode, which never turns back (a later
answer that is not a hub's changes nothing). While a present desk has not answered, the sidebar line
is blank. In hub mode:

- The sidebar's "Local workspace" reads "<label>'s Inbox" ("Another Mac's Inbox" for an empty
  label).
- Nothing calls a route the remote entry refuses. Of those, the page itself fetches only
  `/api/setup` (Settings' Setup blocks, and `readSetup` behind the agents and runtimes blocks), which
  `hubMode.local()` guards; `/api/launches…`, `/api/launch-asks…` and `/api/launch-folders` are read
  only while `agentInboxLaunch` says its switch is on, and the hub view has no such bridge; the page
  never fetches `/api/owner` or `/api/chats/copilot/:id`. `test/dom/hub-mode.test.ts` boots the
  whole page in hub mode, opens Settings and the Chats tab, polls, and checks every request against
  `remoteRouteAllowed`.
- Settings draws the page's own preferences (Appearance, sort, motion, Later, Plans, Copy) and, in
  place of the rest, one line: "Settings for this Inbox are changed on <label> itself." Not drawn:
  Links, Terminal, Agent sessions, Updates, Other devices, Use another Mac's Inbox and every Setup
  block (the build line, agents, runtimes, the setup menu, the manual commands, the database path).
- While `state` is `retrying`, `#hubReconnecting` in the top bar says "Reconnecting to <label>…",
  and `body.hub-reconnecting` hides `#status`, whose "disconnected" would say the same thing again.
  Online again, both go.

**Requests that fail while reconnecting.** While `retrying` the controller withholds the device
header, so the hub answers the page's requests with bare 403s (or the network fails). The poll
(`load()`) throws on the 403 of `/api/items`, logs it, sets `#status` to "disconnected" (hidden
above) and keeps the last frame; the next poll that is answered paints and clears it, so the page
leaves that state by itself within 3 seconds of the hub answering again. A write (`postJSON`) fails
with "write failed (403)" and keeps the draft with its own error beside Send. The Chats tab keeps
"Couldn't load chats" until Refresh or until the tab is opened again. No request is retried by this
PR.

## Attention from the hub (PR 4a)

All agent chats may run on the hub while the owner sits at the connecting Mac, so that Mac must
notify for the hub's asks and let them be answered from the notification. Main's attention watch
moved into `electron/attention-watch.cjs` (`createAttentionWatch`), which takes everything it
touches as an option and runs under vitest with fakes. Main runs it twice:

- **This Mac**, as before: its own viewer every 3 seconds, the same titles, bodies, buttons,
  reminder, wake adapter, refused-answer retry and fail-open read of closed projects, and nothing
  announced on the first poll.
- **The connected hub**: one watch per hub id, made when `remoteConnect.connection()` first names
  that hub and dropped (its count and what it announced with it) when the hub changes or the mode
  returns to local. It polls every 5 seconds, and only while the connection for that id is `online`
  and `hubView.canShow()` is true: a hub that cannot be shown neither notifies nor counts. Every
  request goes through `remoteConnect.hubFetch()` (its origin only, the device header, no redirect,
  a 5-second timeout), to `remoteConnect.hubBase(id)`, the hub's origin with a trailing slash, read
  from memory (no store read, no Keychain). The hub side needs no change: the four reads and the two
  answer routes are on the remote entry's allowlist, and a hub on 2.12.0 serves them.

Each watch keeps its own record of what it announced, its own conditional reader and its own
response watch. The hub's record survives offline stretches of the same hub, so asks that arrived
while this Mac slept are announced once when the hub is back (one summary for several), and a new
watch starts empty, so connecting announces nothing old. The wake adapter runs only for This Mac
(the hub's own app runs its own); the "waiting for agent" reminder runs for both. A failed poll is
quiet and retried at the next tick; the watch never kicks or probes the hub. The hub's watch polls
at once when the connection becomes `online` (the 5-second interval stays beside it; the watch never
overlaps itself).

**Titles name the hub**: `Agent Inbox · <label> — needs you`, `… — <n> new need you`,
`… — waiting for agent` (and its plural) and `… — Response not applied`, with the connection's
stored label as text only. This Mac's titles are unchanged. A hub's log line says only how many new
asks there are, never the hub's text, its host or its label.

**Answer buttons** on a hub notification post through the same `hubFetch` to the hub's base, with
the hub's origin as `Origin`; a refused row answer reads `<base>api/boards` through it too, as This
Mac's does. An app launch's approval still gets no buttons. Waking, unlocking or the network coming
back makes the connection distrust the hub until its next check passes, and until then `hubFetch`
refuses every request. A button pressed in that window would fail, so the hub watch's fetch is
wrapped in `waitingHubFetch`: a request that changes something (not GET or HEAD) and is refused
for that reason waits for the connection's check to finish, for at most 10 seconds, and is sent
once more. Reads and every other error are never retried. A hub watch cannot be made without its own
fetch. If the answer still cannot be saved, the "Response not applied" notice for a hub says it was
not saved on the hub and to answer it there; This Mac's notice keeps its wording.

**A click** on a hub notification shows the hub's view (`hubView.show(id)`), brings the window
forward, and lands on the ask with `hubView.land(id, hash)`: it sets `location.hash` (JSON-quoted)
only when that id's view exists, the hub's own page (not the offline file) is what loaded and is on
the hub's origin, and the hash is one item link (`#item/` and 1 to 200 of `A-Z a-z 0-9 % . _ ~ -`).
Anything else does nothing. A view not built yet (`not_ready`) still brings the window forward; no
landing is queued.

**The dock badge** is the sum of This Mac's last count and the hub's (`badgeTotal`), where the hub
counts 0 while it is not `online`, while it cannot be shown, and once dropped. It is set whenever a
count, the connection or what may be shown changes, and the hub's stored count is zeroed at each
connection change while it is not live, so an old count cannot come back for a few seconds when the
hub does. A failed import of the shared attention modules
still sets it to 0 once, loudly.

**One notice when the hub is lost** (`createLostHubNotice`): when the same hub has been continuously
`retrying` or `refused` (never for the reason `stopped`, which is this app quitting) for 2 minutes of
awake time while this Mac has a network, one notification says `Agent Inbox — can't reach <label>`.
Its body says the hub no longer accepts this Mac only when it was refused for that reason, and
otherwise that new asks will not show until it is back. Waking or unlocking the Mac, the network
coming back, and another hub, restart the 2 minutes; a wait that ends with no network starts over. It says nothing more until that hub has been online again,
and there is no "it is back" notice. Its click brings the window forward and shows the hub's view,
whose offline page explains.

Tests: `test/attention-watch.test.ts` drives both kinds of watch against a real viewer on a scratch
database, and once through the real remote entry and its gate on a loopback listener (a question
flagged in the store is announced, its button stores the answer, every read is answered);
`test/hub-view.test.ts` covers `land`; `test/badge.test.ts` holds its pins, and its guard that the
code never restates the attention rule, for both `electron/main.cjs` and the new file.

## Open desk (PR 4b)

On the connecting Mac, a session in the hub's page (its card, its Quiet row and its session panel)
gets **Open desk**, which opens this Mac's terminal attached to that session's tmux session (its
desk) on the hub. It runs one command template the owner typed in Settings on this Mac. The design
is §3.4 of the spec, cut down: no `{host}` or `{target}`, no stored SSH host, nothing for This Mac's
own sessions and nothing in the Chats tab.

**The command.** One string per hub, `deskCommand` on the hub's entry in `remote-connect.json`.
`validDeskCommand` (in `remote-connect-rules.cjs`) is its one rule: 1 to 512 printable ASCII
characters (`/^[\x20-\x7e]{1,512}$/`, so one line and no control character), `{desk}` or `{attach}`
at least once, and no other `{` or `}` anywhere. The command is plain ASCII on purpose: the
confirmation dialog must show exactly what will run, and a bidirectional control, a zero-width
character, a non-ASCII space or a look-alike letter could make the dialog read as something else. Only the owned local page can propose one, through
`agentInboxConnect.setDeskCommand({ id, command })` and the `agent-inbox:connect-desk-command`
channel (gated as the other connect channels are, with exactly those two keys). The controller's
`setDeskCommand` removes the command for `''`, with no question. Any other text must pass the rule
(`bad_command`) and `id` must be the stored active hub (`not_found`); then main shows
`dialog.showMessageBox` on the app's window, a warning with Cancel as the default and the Escape
answer: "Run this in your terminal when you press Open desk?", the command filled for the desk
`example-desk`, a blank line, and "It runs on this Mac, in your login shell, to open a desk on
<label>." (`<label>` is the stored active hub's label, passed to `confirmDeskCommand(command, label)`
and shown as text only when it passes the device label rule; otherwise the sentence ends at "login
shell."). One confirmation is open at a time: from the moment a proposal has passed its rule until its dialog settles, any other
`setDeskCommand` call, a removal included, is `busy` with no dialog and no write. Only **Save** stores it, under the
store's lock and spreading the entry as `recordMachine` does, and only if the same hub (same device)
is still active after the dialog; anything else is `cancelled`. The dialog is injected into
`createRemoteConnect` as `confirmDeskCommand`: without it nothing is stored. A saved or removed
command sends the hub's page the empty change message (`hubView.pageChanged()`), so a page already
loaded asks `available()` again. A new pairing writes a new entry, without a command. `view().hub.deskCommand` shows the valid stored one to Settings; it
never goes to the hub or its page.

**Filling.** `fillDeskCommand(template, desk)` in `desk-open.cjs`. `{desk}` becomes the desk name,
bare: it matches §3.1's place-name rule (`PLACE`, compared with `public/place.js`'s `PLACE_NAME` in a
test), which has no shell character and no leading `-`. `{attach}` becomes `tmux attach -t
'=<desk>'` quoted once more as one shell word, because `ssh` joins its arguments and the remote shell
parses them again. Tests parse the result back with a real `sh` and, where it exists, `zsh` (which
reads an unquoted word starting with `=` as a command path), and for `{attach}` through a stand-in
`ssh` that joins its arguments and a second shell that reads them.

**The open.** `agentInboxDesk.available()` is `{ open: true }` only for the hub view's top frame on
the hub's own page, on macOS, while the stored active hub has a valid command (and is the
controller's active hub). `open({ session })` runs these checks in order, each with its word:

1. The sender is that same frame (`unavailable`), and the request is exactly `{ session }`, a
   session id (`bad_request`).
2. The view is focused and had a key press or click under 5 seconds ago, used up by this open
   (`no_gesture`). `hubView.takeGesture(event)` does this with the same `lastInputAt` the view's link
   rule uses, so one press opens one link or one desk.
3. At most one open per 2 seconds and three a minute, never two at once (`busy`).
4. The stored active hub, the one the view shows, has a valid command (`no_command`).
5. Main reads the hub's `GET /api/activity` itself, through `remoteConnect.hubFetch()` at
   `hubBase(id)`, never data from the page. A failed or non-200 read, a body over 5 MB or one that is
   not a list is `unreachable`. No row whose `session` equals the request is `not_found`; a row
   whose `desk` is missing or fails the place-name rule is `no_desk`, and nothing is written.
6. When the row has a `machine` that passes the rule and the stored hub has one, they must be equal
   (`not_on_hub`); with either missing the check passes.
7. The filled command goes into a script: `#!/bin/sh`, a comment, and `exec '<login shell>' -l -i
   -c '<command>'`. The login shell is `os.userInfo().shell` when it is absolute, has no control
   character and `/etc/shells` lists it, else `/bin/zsh` (`csh` and `tcsh`, by basename, are never used: they do not
   accept `-l -i -c` together); `-i` because a shell function the
   template calls usually lives in `.zshrc`. The script is `desk-<16 hex>.command`, mode 0700, in a
   private 0700 `desk-open/` folder beside the local database (where `chat-resume/` is), written
   through chat resume's `writePrivateScript` with its own name pattern (`O_EXCL | O_NOFOLLOW`, a
   real directory this user owns, day-old scripts of that pattern swept). A write failure is
   `failed`.
8. `openInTerminal` opens it in Settings → Terminal's app, as chat resume does: not opened is
   `terminal_failed`; opened after falling back to Terminal is `{ ok: true, notice }`.

Nothing from the hub but the pattern-checked desk reaches the command, and the script holds only the
shell path and the filled command. A refusal logs only its word, a success `desk-open: opened`; the
refusals before the gesture check (`unavailable`, `bad_request`, `no_gesture`) log nothing, so a page
calling in a loop writes no line per call.

**On the page.** `public/desk-open.js` asks `available()` once per page load and again on each
`onConnection`, and draws a button only where it said `{ open: true }`, for a row with a
pattern-checked desk and a session id: beside the place on a card and on a Quiet row (its click
never reaches the card), and in the session panel before Copy attach command. While an open runs the
button is disabled; then it says "Opened" for 1.5 seconds (with the fallback notice when there is
one), or a refusal's one sentence sits beside it for 6 seconds, as text. On This Mac's page and in
a browser, nothing changes. Settings → Use another Mac's Inbox gains, while a Mac is connected, an
"Open desk" block: a sentence naming the label, an example (`ssh -t my-mac {attach}`), the field,
Save, Remove when one is saved, and a line saying Open desk appears on each session in that Mac's
Inbox.

Tests: `test/desk-open.test.ts` (the rule, filling with real shells, the script, each check in
order, the real private writer), `test/remote-connect.test.ts` (setting the command),
`test/hub-view.test.ts` (`takeGesture`, the channels), `test/remote-preload.test.ts` (the bridges'
members and reductions), `test/main-ipc.test.ts` (the channels' senders and main's wiring), and the
DOM tests in `test/dom/desk-open.test.ts`, `agents-home.test.ts`, `dashboard-focus.test.ts` and
`settings-connect.test.ts`.

## Updating the hub from another Mac (#637)

The hub is often a Mac nobody sits at. From the connecting Mac, Settings → Use another Mac's Inbox
shows the hub's version and, when the hub's own update controller has verified a newer release, one
button, **Update <label>**. The hub does the whole update itself, through the update controller it
already has (`updates.md`): download, verify, install, restart. No schedule and no automatic install.

**What a request may say.** Nothing. `POST /api/remote/update` carries no query and no body (the
handler answers `400 { ok: false, reason: 'bad_request' }` for either, and for a
`Transfer-Encoding` header); the hub installs only the release its own controller verified, never a
version, URL or file from the caller. Because the request names nothing, the hub installs the newest
release its controller has verified when the request arrives. That can be newer than the release the
connecting Mac's page last showed; the hub's notification and the connecting Mac's status line name
the version actually being installed.

**The hub's viewer** (`src/remote-update.ts`). The remote entry relays; it decides nothing.

- `GET /api/remote/update` and `POST /api/remote/update` are on the guarded app only, after the
  whole gate: a paired device's secret (step 8), the hub's `Origin` on the POST (steps 5 and 6).
  Step 8 now also notes which device matched (`remoteDeviceOf(incoming)`, kept in a `WeakMap` per
  request, never answered or logged), so the relay knows who asked; each handler also refuses by
  itself (403) when the request carries no matched device. Neither route exists on the loopback
  app, so a process on the hub cannot start an update with a plain local request (it has no device
  secret: the hub never stores one). That is not a wall against a local process, which can read the
  owner token (`GET /api/owner`), ask for a pairing code, pair itself as a device through the
  entry, and then do whatever a paired device can, now including starting an update. That is true
  of every remote route and is not new with this change; what it can cause here is the install of
  the hub's own verified release.
- GET answers `{ current, status, newer, canStart, reason }`: what main last reported. Statuses:
  `current`, `checking`, `available`, `downloading`, `installing`, `failed`. Reasons when
  `canStart` is false: `setup_running`, `installing`, `not_here`, `nothing_newer`, `busy`, and the
  viewer's own `not_ready` when main has not reported for 15 seconds (or ever). A GET also notes
  that a device looked.
- POST answers `202 { ok: true }` and records one request `{ id, device }` (16 random hex, the
  device's id) when the report says `canStart`, and marks the hub as installing until main's next
  report; a second press is `409 { ok: false, reason: 'installing' }`. Otherwise `409 { ok: false,
  reason }` with the report's word.
- `POST /api/remote-entry/update` on the loopback app, only with the owner token (as the code
  route), is main's report: exactly those five keys, a start only with a newer version and no
  reason, a refusal always with one, at most 1 KiB with its `Content-Length`; else 400. It answers
  `{ request, looked }`: the request since the last report (handed out once) and whether a device
  looked. A local process holding the owner token can drop a request or report a false state to
  the viewer, and (as above) can pair itself as a device and then ask for an update, but the report
  route itself starts nothing: main decides on its own state, and installs only the release its own
  controller verified.

**The hub's main** (`electron/remote-update.cjs`, made in `startRemoteEntry()` for the owned viewer
on macOS). It reports every 3 seconds, and whenever the controller emits a state (`sendUpdateState`
calls `remoteUpdate?.changed()` first), with the loopback `Origin` and the owner token, `redirect:
'error'`, and only while this Mac shares its Inbox: the link asks `shared()` before every report
(a gate that throws, or none, counts as not shared). Main answers it from `remoteShared`, set by
`watchRemoteEntry`'s `onView` from the same `panel.get()` read every 5 seconds: the remote entry is
on and has at least one paired device. Turning shared on reports at once; turning it off needs
nothing, because the viewer answers `not_ready` once reports stop.
`updateSummary()` builds the report from the controller's state and main's own gates:

- a start needs a verified release newer than the running app, `downloadable` and `installable`
  (an installer registered and feasible here), `installPermitted` (the window holds the install
  grant the local install needs, #216), and no agent setup, install or quit running;
- `not_here` is the controller's own "cannot install from the app" (not in Applications,
  translocated, read-only, another user's copy, a `.deb`, an arm64-only release on an Intel Mac, a
  build with no controller such as a checkout); `busy` is a check or a download already running,
  a quit, or a window that has lost its grant for a moment (a reload);
- a remote update under way reads `installing` (or `downloading`) with `canStart: false`.

On a request it computes the summary again, so a request the viewer let through is dropped when
main cannot start now. Each request id is handled once. A start shows a native notification on the
hub, "Agent Inbox is updating" / "<label> started the update to version <v>. Agent Inbox restarts
by itself when it is ready." (`<label>` from `remote.json`'s devices by id, as text; "A paired Mac"
when unknown; a click opens Settings → Updates). Then it runs the controller: `downloadNow()` when
the release is not downloaded yet, then, only for a `verified` (or `install-failed`) state of
the release main started with (the one its summary named when the request arrived: a download that
ends on a different release is not installed), still `installPermitted`, with no setup or quit
running, `installNow()`. The controller's own checks run again inside it (setup, newer, the rollback mark,
feasibility), and its install ends in the restart it always asks for.

A device's look may make the hub check for a release: when the answer says a device looked, the
controller is idle, current, unverified or stale, and main has not started such a check in the last
hour, it calls `checkNow()`. Automatic checks are off by default, so without this a hub nobody sits
at would never know of a release. That check reads the signed manifest exactly as Check for
Updates… does.

**Unattended install.** Nothing on the remote path needs a person at the hub. The install IPC's
"the page that asked" check (`canRunSetup`) is replaced by the same window grant it stands for
(`installPermitted`), which the window holds while it shows the owned viewer, focused or not.
`update-install-macos.cjs` mounts with `-nobrowse -noautoopen`, closes every tool's stdin so a
licence prompt fails instead of waiting, runs `codesign` and `spctl` without a dialog, and its
helper swaps the bundle and relaunches with `/usr/bin/open`; the update quit (`requestUpdateRestart`)
returns from `before-quit` before the driven-sessions question. What tests cannot show: whether
macOS asks anything when the helper replaces the bundle (App Management) on a Mac nobody is at; the
local install takes the same path.

**The connecting Mac's main** (`electron/hub-update.cjs`, made on first use once connect mode
exists). Both requests go through `remoteConnect.hubFetch()` at `hubBase(id)`: the hub's origin
only, the device header, no redirect, a timeout. The secret never reaches a page. `state(id)` and
`start(id)` answer for the active hub only (`not_found` otherwise).

- `start(id)` needs the connection `online` with a version (`offline` otherwise), posts with
  `Origin: <hub origin>` and no body, and answers `{ ok: true }` on a 202, the hub's word on a 409,
  `refused` on a 403, `unreachable` when the fetch fails, else `failed`. A start is remembered as
  `{ from: <the connection's version>, to: <the newer version last shown>, at }`.
- `state(id)` answers `{ ok, phase, version, status, newer, canStart, reason }`. Phases: `idle`
  (the hub's report), `offline` (not online, nothing asked), `old_hub` (an online hub that answers
  the route 403 and whose probed version is a valid version older than 2.15.0,
  `UPDATE_ROUTES_FROM`), `refused` (any other 403: this Mac was removed from the hub's list, or its
  login or host changed; the connection is asked to check the hub again, once per run of refusals),
  `unreadable`; and after a start: `updating` while the hub
  reports a check, download or install, `restarting` while it does not answer (the connection is
  kicked once, so it notices before its next 60-second probe) or the connection is not online,
  `done` once the hub reports a version newer than `from`, `failed` when it is online on `from` and
  no longer updating, and `not_back` when it has been away for 5 minutes since the start. A result
  is forgotten 15 minutes after the start.
- Channels: `agent-inbox:connect-hub-update` and `agent-inbox:connect-hub-update-start`, in
  `registerHubIpc` behind the same `owned` check as the other connect channels, with exactly one
  hub id (8 lowercase hex) as the only argument. The bridge's new members are
  `agentInboxConnect.hubUpdate(id)` and `updateHub(id)`, which check that argument and rebuild each
  answer field by field (a version must be three numbers; an unknown phase is refused whole).

**Settings on the connecting Mac.** Between the connected Mac's controls and Open desk: "<label>
runs Agent Inbox <version>.", one status line, and **Update <label>** only while the hub may start
(`idle` or `failed` with `canStart`). One sentence per refusal word, per phase and per start
refusal; while a start is asked the line says "Asking <label> to update…" and the button is
disabled. While an update is followed (`updating`, `restarting`, or a check, download or install
the hub reports), the section asks again every 5 seconds; it also asks after every connection
change and when Settings opens. The label is the other Mac's text, set as text only.

**Version skew.** A hub older than this change (the routes exist from 2.15.0) has no route: the
connecting Mac offers nothing and says "<label> runs an older Agent Inbox that can't be updated from
here. Update it once on <label>: Agent Inbox → Check for Updates…". A 403 from a hub that is not
older says "<label> didn't accept this Mac's request. Check that this Mac is still listed under
Settings → Other devices on <label>." (also when a start answers `refused`). A connecting Mac older
than the hub never asks.

Tests: `test/remote-update.test.ts` (the relay, main's report route, and both routes through the
real gate and listener: refusals by device, `Origin`, query and body, and no route on the loopback
app), `test/remote-routes.test.ts` (the guarded routes' Hono chains), `test/remote-update-link.test.ts`
(the summary for each controller state and gate, and main's link against the real relay through
`app.request`), `test/remote-entry-ipc.test.ts` (main's block: the link's options, its stop on quit,
the notification), `test/hub-update.test.ts`, `test/hub-view.test.ts` and `test/main-ipc.test.ts`
(the channels), `test/remote-preload.test.ts` (the bridge), and `test/dom/settings-connect.test.ts`.

Not checked without the real app: an update started from the connecting Mac end to end, the native
notification, macOS's behaviour while the bundle is replaced with nobody at the hub, and how long
the connecting Mac takes to see the hub again.

## Opening a card's files from another Mac (#634)

A card's file links name paths on the hub, which do not exist on the connecting Mac. There, a
listed document opens as a copy when its link is clicked, in the card's Links strip or inline in its
text (#645): main fetches the file from the hub, saves a private copy and opens it with the person's
default app. There is no separate button; the chip keeps its **Copy path** icon. No
preview in the app, no editing, no upload; the text of items and plan rows only, never a message or
a row's earlier steps. Both Macs need this release: the hub serves the route and draws the
links, the connecting app fetches.

**The hub's route** (`src/remote-file.ts`). `GET /api/remote/file` is a `GUARDED_ROUTES` entry,
served by the guarded app after the whole gate (a paired device's secret, step 8), never by the
wrapped app and not on the loopback app. It is the first route that returns file contents. The
handler refuses a request with no matched device (403), a `HEAD`, a body, or any other method, and
then checks in order, each refusal `{ ok: false, reason }` with one word and nothing else:

1. `bad_request` (400): the raw target is exactly the path and a query of exactly `kind` (`item`
   or `row`), `id` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`) and `path`, each once, in any order. `path`
   is canonical unpadded base64url of strict UTF-8, because the gate refuses `%` anywhere in a
   target, so a path with a space or a non-ASCII letter could not travel as plain text. The decoded
   path is absolute (`/…`) or `~/…`, at most 4,096 characters, with no control character and no
   empty, `.` or `..` segment. Nothing is decoded further: `%2e` is three characters of a name.
2. `not_linked` (404): the entity exists (`getItem`, or `getBoardRowWithPlan`, a new reader for a
   row of an active or archived plan with its plan: every plan the remote routes show) and its card
   draws the path as a file link. "Linked" has no rule of its own: the hub runs the page's scanner,
   `cardLinks` from `public/link-strip.js` (the Links strip's model, which reads the card's
   agent-written fields through `public/structured-text.js` and `public/links.js`), on the item
   against itself or the row against its plan, with no link index, and accepts the request only
   when its path is exactly the `path` of one of the found links of kind `file` that is absolute or
   starts with `~/`. A repo-relative link (one that needs the card's recorded folder) is not served.
   The fields are an item's title, detail, context, next step, impact, next-after, outcome, option
   labels and details; a row's label, note and the same others; never a reply, an annotation or a
   row's history. An unknown entity reads the same as an unlinked path. A `~/…` path is the hub
   user's home (`os.homedir()` in `src/viewer-server.ts`). The scanner is imported by
   `src/remote-file.ts` only, which `src/viewer-remote.ts` and `src/viewer-server.ts` reach and the
   stdio MCP server never does (`test/prstate.test.ts`), so that server's import graph is unchanged.
   What the scanner turns into an absolute or `~/` file link is therefore what a paired device may
   ask for: a path that starts with `~/` or with `/` and one of the roots `Applications`, `Library`,
   `Network`, `System`, `Users`, `Volumes`, `etc`, `home`, `media`, `mnt`, `nix`, `opt`, `private`,
   `root`, `snap`, `srv`, `tmp`, `usr`, `var` or `workspaces`; made of letters, digits, combining
   marks, `.`, `_`, `~`, `@`, `%`, `+`, `-` and `/`; after the start of the text, whitespace or one of
   `` ( [ { " ' ` « “ ‘ , ; = ``; ending at the end, whitespace, a closing mark, or a sentence mark
   (`. , ; : ! ? …`) followed by one of those, with trailing dots dropped and an optional
   `:line`, `:line:column` or `:line-line` after it; in plain text, backticks or a Markdown link
   target, never in a fenced block, glued to a word, in angle brackets or as a `file://` URL.
3. `not_a_document` (415): the path is under `~/` or one of the allowed roots (`ALLOWED_ROOTS`:
   `/Users/`, `/tmp/`, `/private/tmp/`, `/var/folders/`, `/private/var/folders/`), so
   system locations (`/etc`, `/private/etc`, `/Library`, `/System`, `/Applications`, `/usr`, `/opt`,
   the rest of `/var`) and volumes (`/Volumes`: a path on a network or removable volume can hang the
   hub's viewer, which serves everything else) stay on the hub, and such a link keeps Copy path and
   the line that it opens only on the other Mac; its name ends in one of `.md .markdown .txt .log .json .yaml .yml
   .csv .tsv .pdf .png .jpg .jpeg .gif .webp`, compared without case (a name that is only an
   extension is not one); and no segment of the path starts with `.`: a hidden file or folder
   (`~/.ssh`, `~/.config`, `.git/…`, `.env.json`) stays on the hub. The route's own form rule has
   already refused an empty, `.` or `..` segment.
4. The file (`openLinkedFile`): `realpath` resolves every link (a missing or looping one is
   `not_found`, 404; any other error `unreadable`, 422); the resolved path must again be under an
   allowed root or the hub user's real home folder (so `/tmp/x.md`, which resolves to
   `/private/tmp/x.md`, is served, and a link in the home folder to `/etc/…` is not) and have no
   hidden segment, else it is `not_found`, the word a missing target gets, so a refusal never says
   whether a target outside the rule exists; inside the rule its name must again be listed
   (`not_a_document`). It is then opened with `O_NONBLOCK` and, on macOS, `O_NOFOLLOW_ANY` (value
   `0x20000000`, not in `fs.constants`; the kernel refuses it together with `O_NOFOLLOW`, so it
   replaces it), which fails with `ELOOP` on a link in ANY component of the resolved path: a folder
   swapped for a link after the check (possible in world-writable places such as `/tmp`) is
   `not_found` instead of widening what is served. Other platforms keep `O_NOFOLLOW` (the last
   component only); the remote entry runs on macOS only. Type and size come from `fstat` on the
   opened descriptor alone: a regular file (`not_found`: a folder, a pipe) of at most 25 MB
   (`too_large`, 413). The earlier `lstat` and the device-and-inode comparison are gone: every rule
   is on the resolved path string, so another regular file at that same path cannot change an
   outcome, and a link at the path fails the open.

At most two files are served at once by a hub (`FILE_SLOTS`). Right after the request's form is
accepted, a third answers `busy` (429) before the card or the file system is read. A slot is held
while the file is open and given back when the response ends, the reader cancels, the client
disconnects, or 120 seconds after the response started (`FILE_TIME_MS`), when the stream is
destroyed, the socket cut and the descriptor closed. The connecting Mac passes the hub's `busy` on
as its own word, so the page shows its existing "One moment" sentence.

Only after steps 1 to 3 does the route touch the file system, so no answer says whether a path
outside the rule exists. Nothing is logged and nothing is written on the hub.

The answer is `200` with `Content-Type: application/octet-stream`, `Content-Disposition: attachment;
filename="<name>"` (the path's last segment in ASCII letters, digits, `.`, `_` and `-`, no leading
dot, at most 120 characters), `Content-Length` (the size `fstat` gave), `X-Content-Type-Options:
nosniff` and `Cache-Control: no-store`, plus the gate's own headers and marker. The body is streamed
in 64 KiB reads from fixed positions (`fileStream`). Before the chunk that completes the length goes
out, one more byte is asked for: a file that grew, like one that shrank or failed to read, errors
the stream with fewer bytes sent than promised, and the route destroys the socket, so the client
sees the response cut off. So a file that grows while read fails whether or not it passes 25 MB.

**The connecting Mac's main** (`electron/hub-files.cjs`, made on first use once the connection
controller and the hub view exist, macOS only). The hub's page asks through two new members of the
sealed view's bridge, `agentInboxDesk.filesAvailable()` and `agentInboxDesk.openFile({ kind, id,
path })` (`electron/remote-preload.cjs`; the preload checks the shape and rebuilds every answer), on
the channels `agent-inbox:desk-files-available` and `agent-inbox:desk-open-file`, which
`registerHubIpc` answers only for the hub view's top frame on the hub's own page, as Open desk's.
`filesAvailable()` is `{ files: true }` for that frame, on macOS, while the connection has a hub
base. `openFile` runs these checks in order:

1. The sender (`unavailable`), then the request is exactly `{ kind, id, path }` with a path by the
   hub's form rule (`bad_request`), then the hub's own document rule: `~/` or an allowed root, a
   listed name and no hidden segment (`not_a_document`). None of these use a press or log anything.
2. A fresh key press or click in the view, used up by this open (`no_gesture`), as Open desk's.
3. At most one open a second and twenty a minute, never two at once (`busy`).
4. Day-old copies are swept (below). Main fetches `<hub>/api/remote/file?kind=…&id=…&path=<base64url>`
   through `remoteConnect.hubFetch()` only, with a 60-second `timeoutMs` (the hub fetch now takes a
   caller's longer timeout, up to 2 minutes; 5 seconds stays the default). A failed fetch, or an
   answer without the remote entry's marker, is `unreachable`. A 403 is `old_hub` when the
   connection's probed version is older than 2.16.0 (`FILES_FROM`), else `refused`. Any other
   non-200 passes on the hub's word when it is one of its seven (the six refusals and `busy`), else `failed`.
5. A 200 must be exactly `application/octet-stream` with a decimal `Content-Length` (`failed`) of
   at most 25 MB (`too_large`). The copy's name is the path's last segment with every separator,
   `:`, control or format character (a right-to-left override, a zero-width space) and line
   separator as `_`, no leading dot, at most 120 characters and 240 UTF-8 bytes, ending in a listed
   extension; the hub's `Content-Disposition` is never read. It goes to
   `hub-files/<hub id>/<first 16 hex of the path's SHA-256>/<name>` beside the local database:
   each folder made 0700 (a link or another user's folder is `failed`, a wider mode tightened), the
   body written to `.<16 random hex>.part` created with `O_EXCL | O_NOFOLLOW` at 0600, counted
   against the length as it arrives (longer, shorter or broken off is `failed`, and the partial file
   is removed), then renamed over `<name>`, which replaces an earlier copy (or a link there) without
   following it.
6. The final name's extension is checked once more, and the copy is opened through
   `openHubCopy` in `electron/link-open.cjs`, main's one place that opens files: it resolves the
   hub-files folder and the copy, and opens with `shell.openPath` only a regular file whose real
   path is inside that folder and whose name has a listed extension; otherwise it answers `outside`,
   `not_file` or `type`, and a default app that does not open it is `failed`. Any of these is
   `open_failed`. Main passes it only the folder and `shell`; `test/electron-links.test.ts` still
   finds no `shell.openPath` in main.

Nothing from the hub is run, and nothing whose extension is off the list is opened. Copies older than
24 hours are swept with `sweepCopies` at the start of every open, as desk scripts are before every
write, and (#645) by `scheduleCopySweep`: once about ten seconds after the app is ready and every hour
after that, on macOS only, over the same folder (`path.join(path.dirname(launchHubPath()),
'hub-files')`), so a copy goes even when nothing is opened and whether or not a hub is connected. The
schedule reads no connection file, calls no `safeStorage` and creates nothing (a missing folder stays
missing, and a folder that is itself a link is not swept); its timers are unref'd and a sweep never
throws into main. It is started from the app's ready handler beside `startRemoteConnect`, not from the
controller, which only exists with a hub. The sweep touches only regular files in folders of the two
hex patterns, through `lstat`, and folders left empty. A refusal logs its word, a success `hub-files:
opened`; the three refusals before the gesture check log nothing.

**On the page** (`public/hub-files.js`, `public/link-open.js`). The page asks `filesAvailable()` once
per load and on each `onConnection`; the answer is a frame input, so the next poll repaints. Where it
is yes, a file link that is not repo-relative, whose path `hubFileListed` accepts and whose owner
(`hubFileEntity`: the item or plan row whose text holds it) is known, carries `data-hub-file-kind`
(`item` or `row`) and `data-hub-file-id` beside its own attributes, and its title is "Open a copy on
this Mac: <path>". That is the chip in a card's Links strip and in the session panel's
(`linkStripHtml`'s `hubFiles` option, whose callback gets `chip(attrs, title)`, the chip's own
escaped markup with more attributes) and the inline link (`ctx.hubFile`, a function from a path to its
attributes and title that `textContext` binds to the owner, passed on by `links.js` to `fileLinkHtml`;
`source.js` itself imports nothing from `hub-files.js`, which keeps it out of the MCP server's graph). The chip is still a group with its **Copy path** icon; a file off
the list keeps its chip, the icon and the line "This file opens only on the other Mac." There is no
other button, listener or note. The form rule is `hubFileListed` (the hub's: `~/` or an allowed
root, a listed name, no hidden segment), and main asks for exactly those. Each side keeps the roots
and the extensions in one list (`ALLOWED_ROOTS` and `DOCUMENT_EXTENSIONS` in `src/remote-file.ts` and
`electron/hub-files.cjs`, `HUB_FILE_ROOTS` and `HUB_FILE_EXTENSIONS` in `public/hub-files.js`), and
tests compare them; one test feeds the same texts, system locations included, through the page's,
main's and the hub's rules and compares the sets. On the card's path only `~/` stands for the home:
an absolute path to a home outside the listed roots (a Linux `/home/…`) is not served, so all three
sides can decide alike without knowing the hub's home.

The click is handled by `link-open.js`, still the one handler for `[data-link-kind]` (mouse, and
Enter or Space on the inline link through its keydown handling). `initLinkOpening` takes the option
`hubFiles`, the object `installHubFiles` returns (`available()`, `request(el)`, `open(request)`),
and asks it first for a file link: where `request(el)` gives `{ kind, id, path }` it calls
`open(request)` once and copies nothing. What the person is told goes in the existing status region
(`#linkOpenStatus`): "Getting the file from the other Mac…" at once, kept until the answer;
"Opened a copy on this Mac." (the usual 2.6 seconds); or the refusal's sentence, one per reason word
(`HUB_FILE_REFUSALS`, `no_gesture` being "Click the file again."), in the error state for 6 seconds,
and `HUB_FILE_FALLBACK` for a missing bridge, an `openFile` that throws or an answer it does not
understand. A path is never copied as a stand-in for a failed open. While an open runs the link is
marked `aria-busy="true"` and another click on that same element does nothing; a repaint that
replaced the element is harmless. A file link that cannot open (off the list, no owner,
repo-relative) copies its path as before, and where hub files are available the note after "Copied
the path." is "This file opens only on the other Mac." instead of "Files open only in Agent Inbox's
own window." The words for an older hub say to update it once on that Mac (Agent Inbox → Check for
Updates…), in a sentence of their own. On This Mac's page and in a browser nothing changes: This
Mac's `agentInboxDesk` has no `filesAvailable`, no link carries `data-hub-file-*`, and a click opens
the file locally or copies as before. An older connecting app has no such member either, so a new
hub's page shows what it shows today; an older hub's page has no link to click.

Tests: `test/remote-file.test.ts` (the request and path rules, and what the scanner links, as
tables with hostile inputs, the one rule on three sides, the file checks with links, folders, pipes, a swap between the check and the open, the
stream's size held while reading, and the route through the real gate and listener),
`test/remote-routes.test.ts` (the guarded route's Hono chain), `test/hub-files.test.ts` (each check
in order, the copy's name, the real private writer, the sweep and its schedule (`scheduleCopySweep`, with
injected timers and clock), and `openHubCopy` with a path outside
the folder, a link inside it that points outside, an unlisted extension and a directory), `test/remote-connect.test.ts` (the
longer timeout), `test/hub-view.test.ts`, `test/main-ipc.test.ts` and `test/remote-preload.test.ts`
(the channels and the bridge, and the sweep's wiring), and the DOM tests in `test/dom/hub-files.test.ts`
(the markup, one click, the three messages, a second click while it runs, Enter on the inline link,
the unlisted file's copy and its note, and the app's own window) and `test/dom/card-links.test.ts`.

Known limits, accepted:

- A hard link to a file is that file: the resolved path is the link's own name, so a visible listed
  name that is a hard link to a file elsewhere serves it.
- Any key press or click in the hub's view counts as the press for an open (as for Open desk).
- Each request scans the card's text again, so a very large card costs the hub time.
- A fetched copy opens in whatever application the connecting Mac uses for its type.
- The file-system calls on the hub are synchronous (`realpath`, `open`, `fstat`), so a slow file
  system holds the hub's viewer for as long as it takes; reads in the stream are asynchronous.

Not checked without the real app: a file fetched over the tailnet and opened in its default app,
the time a large file takes over Tailscale (the 60-second limit), and how macOS treats a copy the
app wrote (it is not quarantined: the app writes it itself).

## Checked against real Tailscale Serve

On 2026-11-17, on macOS with Tailscale 1.102.4, after the owner ran `tailscale serve --bg 4320`:

- `tailscale serve status --json` printed exactly the one good shape: `TCP` with `"443":
  { "HTTPS": true }`, and `Web` with `"<host>:443"` holding one handler at `/` whose only field is
  `Proxy: "http://127.0.0.1:4320"`. No `AllowFunnel`, `Foreground` or `Services` key. With nothing
  configured it printed `{}`.
- What Serve forwards to the loopback port: `Host` is the tailnet name with no `:443`, and the
  request target arrives exactly as the client sent it (`/static/../api/setup` and `/%61pi/setup`
  unchanged). From a device of the same user: exactly one `Tailscale-User-Login`, plus
  `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`, `Tailscale-Headers-Info` and
  `X-Forwarded-For`, `-Host` and `-Proto: https`. A request the hub makes to its own Serve address
  carries the same headers with the hub user's login.
- Serve removed a client's own `Tailscale-User-Login`, `Tailscale-Funnel-Request`,
  `Tailscale-User-Name` and `X-Forwarded-For` and set its own: one login header, no Funnel header.
- From a tagged server: no `Tailscale-User-Login`, `-Name` or `-Headers-Info` at all, only
  `X-Forwarded-*`; the gate refused it at `login`, even with a valid device secret.
- The gate behind real Serve: a paired device got 200 with the marker; no secret was a 403 counted
  `device` (also from the hub itself, which is the self test's pass); the dot-segment and
  percent-encoded targets were 403 `path`; `/api/setup` and `/api/launches` were 403 `route`; a
  POST with the page's `Origin` passed, and one with no or a foreign `Origin` was 403 `origin`.

- `tailscale status --json` on a tailnet whose user has many exit nodes listed 531 peers in 822,251
  bytes; `status --json --peers=false` was 5,566 bytes, with `Peer` empty and one `User` entry, and
  still held `BackendState`, `Self` (`DNSName`, `UserID`, `Tags`) and this node's user.

Not yet confirmed by a real run: the `off` form of the removal hint, and the Funnel, TCP-forward,
extra-path and services shapes. Those stay as documented.
