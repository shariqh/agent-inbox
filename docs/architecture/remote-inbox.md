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
applyTo: "src/viewer-remote.ts,src/remote-pair.ts,test/viewer-remote.test.ts,test/remote-routes.test.ts,test/remote-setting.test.ts,test/remote-pair.test.ts,electron/remote-*.cjs,test/serve-state.test.ts,test/remote-entry-settings.test.ts"
---

# Remote entry: one Inbox from every device (#617)

The hub's viewer listens only on loopback (`viewer-network.md`). The remote entry is a second
loopback listener, reached only through Tailscale Serve, for the owner's own paired devices.
Design: [`docs/superpowers/specs/2026-11-17-remote-inbox-design.md`](../superpowers/specs/2026-11-17-remote-inbox-design.md) §3.2.
Process boundaries: [`overview.md`](overview.md).

Claude Code and Copilot CLI load this file when they read or edit a file matching the
`paths`/`applyTo` globs above; anyone else should read it before changing the remote entry.
Later PRs add their files (`electron/desk-open.cjs`) to the globs.

## What is built (PR 2a, PR 2b, PR 2c)

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
Tailscale. `createRemoteEntry(options)` returns one object; every dependency (`fsImpl`,
`execFile`, `exists`, `fetch`, `now`, `sleep`, the interval functions) is an option, so the tests
run no command, open no socket of their own and never sleep. It logs nothing.

**The file.** `remoteFile(env, home)` is `remote.json` in `remoteDir()`'s folder, by the same rule;
a test compares the two over several environments. The controller reads the file by the viewer's
rules (`O_NOFOLLOW`, checked on the descriptor, owned by this user, no group or other bits, at most
64 KiB, strict UTF-8, schema 1), and a test reads many files with both readers and compares the
answers. It also refuses a device label that holds a Unicode format character (category Cf), as
the viewer's reader will.

**Tailscale, read-only.** `tailscaleCli` takes the first of `/usr/local/bin/tailscale`,
`/opt/homebrew/bin/tailscale` and `/Applications/Tailscale.app/Contents/MacOS/Tailscale` that
exists; never a search, never a configured path. Every run is `execFile` with an argument array,
no shell, a 5-second timeout and a 1 MiB cap, and only `status --json` or `serve status --json`.
Nothing here changes Tailscale's configuration. A source test pins both argument lists and the one
`execFile` call, and checks that `remote-entry.cjs` itself runs nothing.

- `tailnetSelf()`: `Self.DNSName` lowercased without its trailing dot, and
  `User[String(Self.UserID)].LoginName` (the ID is read from the JSON text, so one past 2^53 keeps
  its digits), both checked by the reader's rules. A tagged node is decided from `Self.Tags`: its
  `UserID` still resolves to a placeholder user, whose login is never returned. Otherwise a fixed
  word: `no_cli`, `failed`, `not_json`, `not_running`, `no_dns_name`, `bad_host`, `tagged`,
  `no_login`.
- `serveState(host, port)`: ok only for exactly one handler for `<host>:443` (case and a trailing
  dot ignored), at `/`, whose entry has only `Proxy` and it is exactly `http://127.0.0.1:<port>`;
  the TCP entry for 443 exactly `{ "HTTPS": true }`; no TCP entry on any port, and no other host's
  or port's handler, that names the port; no `AllowFunnel` for `<host>:443` other than `false`;
  `Foreground` and `Services` absent or empty; and no top-level key but `TCP`, `Web`,
  `AllowFunnel`, `Foreground` and `Services`. Anything else is `{ ok: false, reason, present }`,
  where `present` says some configuration names `<host>:443` or the port. A failed read is
  `unreadable`. The good shape and `{}` are from a real run (below); every other shape in the
  tests is from Tailscale's documentation, so a real shape that differs reads as not ok and the
  entry stays off.

**The store.** Writes go through `createLockedFile` on `remote.json`, the lock the viewer's pairing
write uses: read again under the lock, temp file and rename, mode `0600`, every unknown field kept
at the top level and in each device. A newer schema, a symlink, a folder, another user's file and
a file that is not JSON are never written. A file with group or other bits is refused by every
operation except `repairPermissions()`, which rewrites it `0600` and turns it off, because another
user may have edited it. No operation throws for a bad file; each answers `{ ok: true, view }` or
`{ ok: false, reason }` with a fixed word.

- `view()`: `{ available, enabled, host, port, viewerPort, logins, devices: [{ id, label,
  pairedAt }], unreadableDevices, problem }`. Never a hash. `enabled` is true only when the viewer
  would open the entry for this app's `viewerPort`; a file on for the other build's viewer reads
  `problem: 'other_viewer'`. `unreadableDevices` counts the entries the reader drops, since they
  still count toward its limit of 16.
- `turnOn()`: reads `tailnetSelf()` and then `serveState(host, port)` first, outside the lock, and
  writes only when both are ok: `enabled: true`, `host`, `port` (4320 packaged, 4393 for a checkout
  build), `viewerPort` (`viewerPort()` in `electron/reuse.cjs`) and `logins: [<this node's
  login>]`. When the stored host or logins are not exactly this node's, it removes every device,
  since their secrets were issued under another identity, and says how many. It never takes the
  entry over while the file is on for the other build's viewer.
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
it only in its known shape (`paired` as `{ device, codeId }` entries). The owner token is never
returned or logged.

**The watch.** `start()` runs `tick()` every 5 seconds; tests call `tick()` themselves.

- While the entry is on: at start and every 60 seconds, `tailnetSelf()` and `serveState()`. A read
  that failed is tried once more 5 seconds later before it counts. When the shape is not ok, or
  this node no longer has the stored host and an allowed login, the watch calls `turnOff()` and
  then `onStopped(reason, { off })` once. While it is off, Serve is read once after start (when the
  file names a host) and on `refresh()`, for the removal hint only.
- Every tick reads the file and compares a SHA-256 over the canonical JSON of `enabled`, `host`,
  `port`, `viewerPort`, `logins` and each device's `id` and `secretSha256` with what main last
  wrote or accepted. Devices added at the end are expected only when each is in the viewer's
  `paired` list with the `codeId` of a code this controller's `requestCode()` received in the last
  11 minutes, one code per device: `onPaired(label)` for each. Anything else calls
  `onOutsideChange()` once per distinct state and sets `flag` until `acknowledge()`. A code another
  local process made proves nothing, and the viewer's `paired` list starts empty when it restarts,
  so a pairing seen across a restart is flagged: the safe side. The first read after `start()` is
  the baseline, so a change made while the app was closed is not flagged. Nothing is reverted.
- A write reads the viewer's status before it takes the lock and observes the file under it, so
  main's own write never hides an outside change. No Tailscale run and no request to the viewer
  happens while the lock is held: the viewer's pairing write waits at most about 5 seconds for it.
- `state()`: the view, the last Serve answer and when, the last identity (the host and whether the
  login is allowed, never the login), the flag, the last stop, and `removalHint`,
  `tailscale serve --https=443 off`, while the entry is off and a Serve configuration naming the
  host or port is present. That command is from Tailscale's documentation and not yet seen in real
  output. No callback or state carries a login (other than `view().logins`), a hash, the owner
  token or a code.

**`selfTest()`** fetches `https://<host>/api/version` from main with no device secret, a 5-second
timeout and redirects refused, and reads `entryStatus()` before and after. It passes on a 403 with
the `device` count up by exactly one; otherwise it names the counter that rose. Whether a request
from the hub to its own Serve address carries its user's login: it does (below). Nothing else
depends on the self test.

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

Not yet confirmed by a real run: the `off` form of the removal hint, and the Funnel, TCP-forward,
extra-path and services shapes. Those stay as documented.
