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
  - "test/remote-entry-ipc.test.ts"
  - "test/remote-words.test.ts"
  - "public/remote-settings.js"
  - "public/remote-words.js"
  - "test/dom/settings-remote.test.ts"
applyTo: "src/viewer-remote.ts,src/remote-pair.ts,test/viewer-remote.test.ts,test/remote-routes.test.ts,test/remote-setting.test.ts,test/remote-pair.test.ts,electron/remote-*.cjs,test/serve-state.test.ts,test/remote-entry-settings.test.ts,test/remote-entry-restart.test.ts,test/remote-connect.test.ts,test/remote-entry-ipc.test.ts,test/remote-words.test.ts,public/remote-settings.js,public/remote-words.js,test/dom/settings-remote.test.ts"
---

# Remote entry: one Inbox from every device (#617)

The hub's viewer listens only on loopback (`viewer-network.md`). The remote entry is a second
loopback listener, reached only through Tailscale Serve, for the owner's own paired devices.
Design: [`docs/superpowers/specs/2026-11-17-remote-inbox-design.md`](../superpowers/specs/2026-11-17-remote-inbox-design.md) §3.2.
Process boundaries: [`overview.md`](overview.md).

Claude Code and Copilot CLI load this file when they read or edit a file matching the
`paths`/`applyTo` globs above; anyone else should read it before changing the remote entry.
Later PRs add their files (`electron/desk-open.cjs`) to the globs.

## What is built (PR 2a, PR 2b, PR 2c, PR 2d, PR 2e, PR 3a)

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
  `electron/remote-connect-rules.cjs`. Logic and tests only: nothing requires it yet
  ("Connecting from another Mac", below).

## What is not built yet

- The rest of connect mode (the next PR): the hub's page in its own view with its own partition
  and preload, the header handler, navigation, download and permission handlers, the menu items,
  the offline page, `powerMonitor` and the Settings form. Open desk and notifications against a hub
  are PR 4.

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
  device is dropped; the rest still count.
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
  It goes as soon as a later operation works, or the next `get()` finds another digest, problem or
  on/off. The page keeps no refusal of its own.
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
the last one shown, less than 10 minutes ago; a resume between two pauses lets the second through.
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
Macs use this Inbox**, with one status line (Off; On, starting… while the file is on but the viewer
does not listen yet; On, at the address, with **Copy address**; Paused: why, next try at a time;
Needs you: why, including "another program on this Mac is using port <port>"); the risk sentence;
one instruction for what to do, chosen from the reason (with a command and **Copy** when running it
is the fix or shows the cause, **Make it private** for a file other accounts can read, and **Switch on
and remove them** / **Cancel** when switching on would remove paired Macs); **Paired Macs**, each
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
hub. Its pure rules are in `electron/remote-connect-rules.cjs`, split for size only. Logic and
tests only: nothing requires it yet. There is no view, no form, no menu item, no offline page and
no IPC; the next PR adds them. `createRemoteConnect(options)` returns one object. Every dependency
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
`tagged_device`. The document is parsed inside the call and only the node leaves it. The hub's own
name is never in `Peer`, so a copy of the app on the hub cannot connect to the hub's own address
(`not_found`).

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

- `deviceHeaderFor(url)` is synchronous and cheap, for the next PR's `onBeforeSendHeaders`. It
  answers the secret only when a hub is active, the module is not stopped, the last node check
  passed and nothing has distrusted it since, `url` is a string or a `URL` (its `href` read once)
  that parses as `https:` with no user info, and its origin equals the hub's
  `https://<host>`, compared as parsed origins, never as string prefixes. The default port and a
  host written in another case are the same origin; another port, a sub-domain, a look-alike that
  starts or ends with the hub's name, and a trailing dot are not.
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
- `kick()` (the next PR calls it on wake, unlock and when the network comes back) holds the header
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

**What the next PR must do with it.**

- The hub view's partition must use a direct connection (`session.setProxy({ mode: 'direct' })`).
  Chromium uses the system proxy and trust store while main's `fetch` does not, so a
  TLS-intercepting proxy with a root the user trusts would otherwise see the device header.
- Its `onBeforeSendHeaders` handler must delete every page-set device header, whatever its case,
  before it sets the one `deviceHeaderFor(details.url)` gives.
- `wss://` gets no header: the hub's page must not depend on one there.
- While the header is withheld (before the first check after `start()`, after a `kick()` until the
  next check passes, after a failed probe, while `refused` or `stopped`), the hub answers the page's
  requests with bare 403s, so the view must show the offline page rather than let the hub's page
  run on them.

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
