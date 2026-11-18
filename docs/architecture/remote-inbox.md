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
applyTo: "src/viewer-remote.ts,src/remote-pair.ts,test/viewer-remote.test.ts,test/remote-routes.test.ts,test/remote-setting.test.ts,test/remote-pair.test.ts,electron/remote-*.cjs,test/serve-state.test.ts,test/remote-entry-settings.test.ts,test/remote-entry-restart.test.ts"
---

# Remote entry: one Inbox from every device (#617)

The hub's viewer listens only on loopback (`viewer-network.md`). The remote entry is a second
loopback listener, reached only through Tailscale Serve, for the owner's own paired devices.
Design: [`docs/superpowers/specs/2026-11-17-remote-inbox-design.md`](../superpowers/specs/2026-11-17-remote-inbox-design.md) §3.2.
Process boundaries: [`overview.md`](overview.md).

Claude Code and Copilot CLI load this file when they read or edit a file matching the
`paths`/`applyTo` globs above; anyone else should read it before changing the remote entry.
Later PRs add their files (`electron/desk-open.cjs`) to the globs.

## What is built (PR 2a, PR 2b, PR 2c, PR 2e)

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

## What is not built yet

- The wiring of the hub controller: IPC, the `agentInboxRemoteEntry` preload bridge, the native
  notifications, the Settings panel (switch, **Add a device**, the device list with Remove,
  **Test**, the removal command) and Open at login (the next PR). Until then nothing in the app
  writes `remote.json` or asks for a code. Any local process on the hub can still make one: the
  owner token is not a secret from local processes (below).
- Connect mode in the desktop app (PR 3), and Open desk and notifications against a hub (PR 4).

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
  among its peers in the next PR. Nothing here parses it yet.

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
  main wrote. Such a process can already switch the entry on by editing `remote.json`; the state file
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
- The checkout build and the installed app keep one state between them: when both run, each save
  replaces the other's, and the other's next start reads no state (a file with devices is then
  flagged, and `wanted` is false). Safe, but noisy.

**`selfTest()`** fetches `https://<host>/api/version` from main with no device secret, a 5-second
timeout and redirects refused, and reads `entryStatus()` before and after. It passes on a 403 with
the `device` count up by exactly one; otherwise it names the counter that rose. A request from the
hub to its own Serve address carries its user's login (below), so that is the right pass. Nothing
else depends on the self test.

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
