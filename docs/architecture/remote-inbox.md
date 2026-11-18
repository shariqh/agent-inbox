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
  - "public/connect-settings.js"
  - "public/hub-strip.js"
  - "public/hub-mode.js"
  - "test/dom/settings-connect.test.ts"
  - "test/dom/hub-strip.test.ts"
  - "test/dom/hub-mode.test.ts"
applyTo: "src/viewer-remote.ts,src/remote-pair.ts,test/viewer-remote.test.ts,test/remote-routes.test.ts,test/remote-setting.test.ts,test/remote-pair.test.ts,electron/remote-*.cjs,test/serve-state.test.ts,test/remote-entry-settings.test.ts,test/remote-entry-restart.test.ts,test/remote-connect.test.ts,electron/hub-view.cjs,electron/remote-offline.*,test/hub-view.test.ts,test/remote-preload.test.ts,test/remote-offline.test.ts,test/main-ipc.test.ts,public/connect-settings.js,public/hub-strip.js,public/hub-mode.js,test/dom/settings-connect.test.ts,test/dom/hub-strip.test.ts,test/dom/hub-mode.test.ts"
---

# Remote entry: one Inbox from every device (#617)

The hub's viewer listens only on loopback (`viewer-network.md`). The remote entry is a second
loopback listener, reached only through Tailscale Serve, for the owner's own paired devices.
Design: [`docs/superpowers/specs/2026-11-17-remote-inbox-design.md`](../superpowers/specs/2026-11-17-remote-inbox-design.md) §3.2.
Process boundaries: [`overview.md`](overview.md).

Claude Code and Copilot CLI load this file when they read or edit a file matching the
`paths`/`applyTo` globs above; anyone else should read it before changing the remote entry.
Later PRs add their files (`electron/desk-open.cjs`) to the globs.

## What is built (PR 2a, PR 2b, PR 2c, PR 2e, PR 3a, PR 3b, PR 3c)

- `src/viewer-remote.ts`: the setting reader, the gate, the allowlist and the listener.
- `src/remote-pair.ts` (PR 2b): the pairing code, `POST /api/remote/pair` and the device write,
  and `remoteCodeRoute` for `POST /api/remote-entry/code`. Viewer process only, like
  `viewer-remote.ts`.
- `src/viewer-server.ts`: a second `createViewer(db, { mesh })` with no owner token, its static
  files, `startRemoteEntry`, and on the loopback app `GET /api/remote-entry` and, when the viewer
  has an owner token, `POST /api/remote-entry/code`.
- `electron/remote-entry.cjs` (PR 2c): the hub controller for the desktop app's main: the
  settings store, the code and status requests to the app's own viewer, the self test and the
  watch. Its read-only Tailscale half is `electron/remote-tailscale.cjs`. Logic and tests only:
  nothing requires it yet (below).
- `electron/remote-entry-state.cjs` (PR 2e): what the controller keeps across restarts, in userData
  `remote-entry-state.json`. Only `remote-entry.cjs` requires it.
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

## What is not built yet

- The wiring of the hub controller: IPC, the `agentInboxRemoteEntry` preload bridge, the native
  notifications, the Settings panel (switch, **Add a device**, the device list with Remove,
  **Test**, the removal command) and Open at login (the next PR). Until then nothing in the app
  writes `remote.json` or asks for a code. Any local process on the hub can still make one: the
  owner token is not a secret from local processes (below).
- The rest of connect mode: Open desk (the terminal action) and notifications against a hub
  (PR 4).

So the entry is still off for everyone until the owner writes `remote.json`. With no device in it,
every request but pairing is refused.

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
  device is dropped; the rest still count.
- `enabled` is on only when it is exactly `true`.

`secretSha256` is the SHA-256 of the device secret's 43 base64url characters, as ASCII, in
lowercase hex. The hub never stores the secret.

The gate stats the file on every request and re-reads it only when the stat changed (identity,
owner, mode, size, times). A removed device is refused on its next request.

## The listener

`startRemoteEntry` binds `127.0.0.1` only, at the setting's `port`, while the setting is valid,
`enabled` is true and `viewerPort` is this viewer's port. So a checkout's viewer never binds beside
the installed one. A 5-second timer, and any request that sees a changed file, opens or closes the
listener to match. Closing calls `server.close()` and `server.closeAllConnections()`, so no
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
through step 7.

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
command-line install has only the third, and that binary answers `status --json` when run
directly. Every run is `execFile` with an argument array, no shell, a 5-second timeout (and a
6-second limit of its own, in case the command ignores the kill), and only three argument lists:

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
  writes only when both are ok: `enabled: true`, `host`, `port` (4320 packaged, 4393 for a checkout
  build), `viewerPort` (`viewerPort()` in `electron/reuse.cjs`) and `logins: [<this node's
  login>]`. When the stored host or logins are not exactly this node's (ignoring case, as the gate
  does), it removes every device, since their secrets were issued under another identity, and
  says how many. It never takes the entry over while the file is on for the other build's viewer,
  and never writes a file the reader would refuse. A successful `turnOn()` clears the last stop.
- `turnOff()`: writes `enabled: false` and nothing else. `removeDevice(id)`: by id, never by label
  (labels are not unique); an unknown id writes nothing.
- `turnOn()` and `removeDevice()` drop the device entries the reader would drop when they write,
  and say how many. This is the one place the controller does not keep what it does not
  understand: such an entry blocks pairing at 16 with no visible cause.
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
  output. No callback and no `state()` carries a login, a hash, the owner token or a code;
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
- `review()` reads the file once and returns `{ view, digest, flag }`: the panel shows that view, and
  its Review button passes that `digest` to `acknowledge()`, which accepts it only if the file still
  has it. So the owner never accepts a state they were not shown.
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

**`selfTest()`** fetches `https://<host>/api/version` from main with no device secret, a 5-second
timeout and redirects refused, and reads `entryStatus()` before and after. It passes on a 403 with
the `device` count up by exactly one; otherwise it names the counter that rose. A request from the
hub to its own Serve address carries its user's login (below), so that is the right pass. Nothing
else depends on the self test.

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
origin, label, node, machine, device, secret } } }`, `id` 8 random hex characters. One hub at most
for now, but every hub value sits under its `id`. There is no terminal command or SSH host yet
(PR 4). Unknown fields are kept, at the top level and in an entry. It is read the way the hub reads
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
been written (below).

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
a top inset of `HUB_STRIP_HEIGHT` (36 CSS pixels, since PR 3c), and following its resizes. The local
page draws whose Inbox is on screen in that inset ("The connecting Mac's screens", below). The local page stays loaded underneath and is never unloaded. Its
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

**`agentInboxDesk`, in the hub view.** `remote-preload.cjs` is the view's only preload and exposes
exactly one object, `agentInboxDesk`, and nothing else on `window`. It runs sandboxed and requires
only `electron`. Every answer is rebuilt field by field in the preload, so an unexpected field
never crosses:

- `available()` → a promise of `{ open: false }`, with no IPC. The terminal action is PR 4; the
  member is here so the page can feature-detect it.
- `connection()` → a promise of `{ mode: 'hub', label, state, version }`, `state` one of `online`,
  `retrying` or `refused`, or `null` when main refuses. Never an id, an origin or a reason.
- `onConnection(callback)` → an unsubscribe function. Main's change message carries nothing; the
  preload asks `connection()` again and calls back with that.
- `retry()` → a promise of `{ ok }`. Main takes it only from the offline file: it kicks the
  controller (the node check and a probe at once) and loads the hub page if the hub is online.

Main answers these two channels (`agent-inbox:desk-connection`, `agent-inbox:desk-retry`) only
when `trustedDeskSender` holds, checked on every call from `event.sender` and `event.senderFrame`:
the sender is the hub view's own `webContents`, not destroyed, and the frame is its top frame
(`parent === null`) on the hub's origin or on the offline file. A sub-frame, the view after it
showed anything else, and the local window's `webContents` are all refused, with `{ available:
false }` (or `{ ok: false }` for retry). Off macOS there is no view: `desk-connection` answers `{
available: false }` and `desk-retry` answers `{ ok: false }`.

**The offline page.** `electron/remote-offline.html` with `remote-offline.js` and
`remote-offline.css` beside it: no inline script or style, a Content-Security-Policy meta of
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none';
font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, and no remote
resource. It says "Can't reach <label>" with **Retry**, or, when refused, "<label> no longer
accepts this Mac" with the instruction to pair again in Settings on This Mac, and no Retry. It gets
its words only through `agentInboxDesk`, sets the label with `textContent`, and follows light and
dark through `prefers-color-scheme` alone.

**In the local page.** `setup-preload.cjs` gains the same `agentInboxDesk`, answering `{ mode:
'local' }` and `{ open: false }`, with a no-op `onConnection`, and no IPC. It also gains
`agentInboxConnect`, for the Settings form a later PR adds:

- `view()` → the controller's `view()` plus `showing` (the id on top, or null).
- `connect({ address, code, replace })`, `forget(id)` → the controller's answers.
- `show(id | null)` → `{ ok: true, showing }` or `{ ok: false, reason }` (`bad_id`, `not_found`, `busy`).
- `onChange(callback)` → an unsubscribe function; the message carries nothing, so the page asks
  `view()` again.

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

**Not built yet.** The terminal action (`available()` says `open: false`), notifications and the
dock badge for the hub (PR 4), and keyboard shortcuts for the menu items. The Settings form, the
strip and the page's hub mode are PR 3c, below.

## The connecting Mac's screens (PR 3c)

The hub's page controls every pixel of its view, and its label is the hub's own machine name (from
its `/api/version`). So what says whose Inbox is on screen is drawn by this app's own page, outside
that view, and nothing is built on the label being true: it is display text, always set with
`textContent`.

**Settings → Use another Mac's Inbox** (`public/connect-settings.js`, `renderConnectSettings`,
called from `renderSetup` after Agent sessions). Drawn only where `window.agentInboxConnect` exists
and `agentInboxDesk.connection()` answers `{ mode: 'local' }`: a missing desk, one that answers null
or throws, and the hub's page draw nothing and ask main nothing. One state at a time, from
`agentInboxConnect.view()`, read again on every `onChange` and when Settings opens; a read that
lands after a newer one is dropped.

| State | What it shows |
|---|---|
| `available: false` | one sentence: macOS only (when `navigator.platform` is not a Mac), else "works only in Agent Inbox's own window, not in a viewer it found already running" (main answers both the same way) |
| no hub, `keychain: false` | one sentence about the Keychain; no form |
| no hub | **Address** (placeholder `mac-name.your-tailnet.ts.net`), **Code** and **Connect**, and one line of help naming Settings → Other devices → Add a Mac on the other Mac; a saved file's `problem` is said above it, and `newer_schema` hides the form, since that file is never written |
| connecting or disconnecting | every input and button disabled, and "Connecting…" or "Disconnecting…"; main may store the hub before `connect()` answers, but the form stays until it does |
| a refusal | one sentence per reason, with what to do next; the fields keep what was typed |
| a hub | "<label>'s Inbox", the address's host, its status in words, **Show its Inbox** (`show(id)`) and **Disconnect** |

- The code is checked here first with a copy of the hub's `normaliseCode` (case, spaces and dashes
  ignored, `I` and `L` read as `1`, `O` as `0`, exactly 10 Crockford characters; the test compares
  it with the controller's over thousands of inputs), and the normalised code is what is sent. A
  malformed code and an empty address are never sent. The address is trimmed; the controller checks
  the rest.
- Every word `connect()` can answer (`ConnectReason`, `HubReason` and `forgotten`, `changed`,
  `failed`, read by the test from `electron/remote-connect.d.cts`) has its own sentence; a word
  added there fails the test until it has one. An unknown word gets "Agent Inbox couldn't connect.
  Try again." An answer with `pairedOnHub` says the other Mac now lists this Mac and that it should
  be removed there before trying again with a new code, whatever the reason.
- `hub_exists` and `bad_file` offer **Replace it**, which asks inline ("This Mac stops using
  <label>'s Inbox and uses the new one. <label> keeps this Mac in its list until you remove it
  there.", or "This replaces the saved connection on this Mac.") with **Replace** and **Keep**.
  Replace calls `connect` again with `replace: true` and the same address and code (both refusals
  come before the code is spent); `replacedHub` then says the old Mac still lists this Mac. Keep
  reads the view again.
- The status comes from `hub.state` and `hub.reason`: Online; Connecting… (the first check);
  Reconnecting… (no reason, `stopped`, or a reason it does not know); a sentence for each reason the
  controller retries on (cannot reach, certificate, not sharing, Tailscale on this Mac missing,
  unreadable or not running, the Keychain); "<label> no longer accepts this Mac: pair again." and
  one sentence per refused reason, with "To pair again: press Disconnect, then connect with a new
  code from <label>."; Checking… when the state is not known. `forget_not_saved` replaces the status
  with "This Mac stopped using <label>'s Inbox, but couldn't save that. Press Disconnect to try
  again." and hides Show its Inbox.
- **Disconnect** asks inline ("This Mac stops using <label>'s Inbox. <label> keeps this Mac in its
  list until you remove it there.", **Disconnect** and **Keep**, focus on Keep), then calls
  `forget(id)`. A question about something no longer on screen is closed.
- `show(id)` refusals: `busy` (the hub's page closed itself), `not_found`, else a plain retry line.

**The strip** (`public/hub-strip.js`, `installHubStrip`, made at boot). Drawn by this Mac's own page
under the same rule as the form, and only while `view().showing` is the stored hub's id: a `div`
with `role="region"` named "Whose Inbox is on screen", fixed to the top of the window,
`HUB_STRIP_HEIGHT` pixels tall, prepended to `body` so it is the first stop for the keyboard. It
says "Showing <label>'s Inbox", the status in a word (Online; Reconnecting… for the first check,
`stopped` or no reason; Can't reach it for any other retry reason; No longer paired; Checking… when
unknown) and **This Mac**, which calls `show(null)` and reads the view again. This Mac is never
disabled: it is this Mac's own IPC and works whether or not the hub answers, and a failed read
leaves the strip as it was, since it says nothing about what is on top. With nothing shown the strip
is not in the document. `HUB_STRIP_HEIGHT` is 36 in both `public/hub-strip.js` and
`electron/hub-view.cjs`; `test/dom/hub-strip.test.ts` pins them equal, and the page sets the strip's
height from its own constant.

**Hub mode** (`public/hub-mode.js`, `installHubMode`, made before `renderSetup`). The same `public/`
code runs in the hub view, where `agentInboxDesk.connection()` answers `{ mode: 'hub', label,
state, version }` and no other bridge exists. The mode is read once at start and on `onConnection`,
every member feature-detected: no `agentInboxDesk` (a browser, an older app) is local at once and
the page is exactly as before; a present desk is local only when it answers `{ mode: 'local' }`, and
any other answer, null or a throw is hub mode, which never turns back. In hub mode:

- The sidebar's "Local workspace" reads "<label>'s Inbox" ("Another Mac's Inbox" for an empty
  label).
- Nothing calls a route the remote entry refuses. Of those, the page itself fetches only
  `/api/setup` (Settings' Setup blocks, and `readSetup` behind the agents and runtimes blocks), which
  `hubMode.local()` now guards; `/api/launches…`, `/api/launch-asks…` and `/api/launch-folders` are
  read only while `agentInboxLaunch` says its switch is on, and the hub view has no such bridge; the
  page never fetches `/api/owner` or `/api/chats/copilot/:id`. `test/dom/hub-mode.test.ts` boots the
  whole page in hub mode, opens Settings and the Chats tab, polls, and checks every request against
  `remoteRouteAllowed`.
- Settings draws the page's own preferences (Appearance, sort, motion, Later, Plans, Copy) and, in
  place of the rest, one line: "Settings for this Inbox are changed on <label> itself." Not drawn:
  Links, Terminal, Agent sessions, Updates, Use another Mac's Inbox and every Setup block (the build
  line, agents, runtimes, the setup menu, the manual commands, the database path). Those that need a
  bridge drew nothing there already; Links and Setup did, and Setup called `/api/setup`. A block
  added later after Agent sessions in `renderSetup` (such as Other devices) is not drawn there
  either.
- While `state` is `retrying`, `#hubReconnecting` in the top bar says "Reconnecting to <label>…",
  and `body.hub-reconnecting` hides `#status`, whose "disconnected" would say the same thing again.
  Online again, both go.

**Requests that fail while reconnecting.** While `retrying` the controller withholds the device
header, so the hub answers the page's requests with bare 403s (or the network fails). Found: the
poll (`load()`) throws on the 403 of `/api/items`, logs it, sets `#status` to "disconnected" and
keeps the last frame; the next poll that is answered paints and clears it, so the page leaves that
state by itself within 3 seconds of the hub answering again. A write (`postJSON`) fails with "write
failed (403)" and keeps the draft with its own error beside Send, which is what a person's action
should show. The Chats tab keeps "Couldn't load chats" until Refresh or until the tab is opened
again. Changed: only the hidden `#status` above; no request is retried by this PR. A reload the hub
asks for while it cannot be reached fails to load, and the hub view then shows the offline page,
which `electron/hub-view.cjs` replaces with the hub's page when the connection turns online again.

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
