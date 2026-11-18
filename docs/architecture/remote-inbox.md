---
paths:
  - "src/viewer-remote.ts"
  - "src/remote-pair.ts"
  - "test/viewer-remote.test.ts"
  - "test/remote-routes.test.ts"
  - "test/remote-setting.test.ts"
  - "test/remote-pair.test.ts"
applyTo: "src/viewer-remote.ts,src/remote-pair.ts,test/viewer-remote.test.ts,test/remote-routes.test.ts,test/remote-setting.test.ts,test/remote-pair.test.ts"
---

# Remote entry: one Inbox from every device (#617)

The hub's viewer listens only on loopback (`viewer-network.md`). The remote entry is a second
loopback listener, reached only through Tailscale Serve, for the owner's own paired devices.
Design: [`docs/superpowers/specs/2026-11-17-remote-inbox-design.md`](../superpowers/specs/2026-11-17-remote-inbox-design.md) §3.2.
Process boundaries: [`overview.md`](overview.md).

Claude Code and Copilot CLI load this file when they read or edit a file matching the
`paths`/`applyTo` globs above; anyone else should read it before changing the remote entry.
Later PRs add their files (`electron/remote-*.cjs`, `electron/desk-open.cjs`) to the globs.

## What is built (PR 2a, PR 2b)

- `src/viewer-remote.ts`: the setting reader, the gate, the allowlist and the listener.
- `src/remote-pair.ts` (PR 2b): the pairing code, `POST /api/remote/pair` and the device write,
  and `remoteCodeRoute` for `POST /api/remote-entry/code`. Viewer process only, like
  `viewer-remote.ts`.
- `src/viewer-server.ts`: a second `createViewer(db, { mesh })` with no owner token, its static
  files, `startRemoteEntry`, and on the loopback app `GET /api/remote-entry` and, when the viewer
  has an owner token, `POST /api/remote-entry/code`.

## What is not built yet

- The desktop app's half of pairing: Settings → **Add a device**, the paired-device list with
  Remove, main's settings writer, every Tailscale command, the Serve check and the notifications
  (the next PR). Until then nothing in the app asks for a code: a code is made only by a local
  process that holds the owner token and calls the code route itself.
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
- `devices`: at most 16. Each needs a 16-character lowercase hex `id`, a `label` of 1 to 40
  characters with no control characters, and a 64-character lowercase hex `secretSha256`. A bad
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
`{ code: "7K3QX-9M2PD", expiresAt }` with `Cache-Control: no-store`.

The code is 10 Crockford base32 characters (no I, L, O or U), each drawn with `crypto.randomInt(32)`,
so 50 unbiased random bits, shown in two groups of five. The viewer keeps only its SHA-256, in
memory. At most one code exists. It is valid for 10 minutes from when it was made, used once, void
after 5 wrong tries, and voided by a newer code, by the entry turning off (even if it comes back on)
and by a viewer restart.

**`POST /api/remote/pair`.** Steps 1 to 6 of the gate apply as for any request, so it needs the
right `Host`, no Funnel header, an allowed login, a clean target, `Origin: https://<host>` and no
cross-site Fetch Metadata. Then, in order:

1. **Rate limit.** At most 10 requests in any 60 seconds go further. It is one counter for the
   route, not per client: every request arrives from Serve on loopback. A request over the limit
   is refused before its body is read, so it uses no try.
2. **Body.** One `Content-Type` header, exactly `application/json` (no parameters). At most
   1 KiB, checked on `Content-Length` and again while reading, which stops at the limit. Strict
   UTF-8. A JSON object with exactly the keys `code` and `label`, both strings. `label` is 1 to 40
   characters with no control characters and no lone surrogate (the reader's rule, plus the
   surrogate). A body that fails any of these uses no try.
3. **A code is pending**, else refused.
4. **The code.** Only ASCII letters, digits, spaces and dashes are read, at most 64 of them; case,
   spaces and dashes are ignored, `I` and `L` read as `1` and `O` as `0`, and the result must be 10
   letters of the alphabet. Its SHA-256 is compared with the pending one by `timingSafeEqual`. A
   wrong code, and a code string that does not normalise (a `U`, a short code), each use one try;
   the fifth voids the code.
5. **On a match** the code is voided first, in the same synchronous step as the compare, so two
   requests racing with the right code cannot both pair. Then a 32-byte secret (43 base64url
   characters) is made, and the device is written (below). The answer is
   `200 { ok: true, device: <id>, secret: <43 characters> }` with the remote headers. The secret
   is in that one response and nowhere else.

Every refusal on this route, at any of these steps or at the write, is the same bare `403 Forbidden`
with no marker, counted under `pair`. The reason never reaches the client.

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
`agent-inbox remote entry: pairing could not write remote.json (EACCES)`.

Kept by value means through `JSON.parse` and `JSON.stringify`: an unknown number that does not fit
a double, or one written as `1.0`, is written back as JavaScript prints it, and the file is
re-indented.

## Status, loopback only

`GET /api/remote-entry` on the loopback app answers `{ on, listening, port, host, error,
codePending, paired, refused: { host, funnel, login, path, origin, device, route, pair } }`.
`codePending` says a code is waiting to be used; `paired` lists the ids of the devices this viewer
paired since it started, the last 16; the counts are since the viewer started. `error` is a bind
failure or fixed words for a refused file. It never holds a login, a header value, a secret, a
hash, a label or a code. It is not on the remote allowlist.

## Logging

The entry logs only that it opened on a port, that it closed, a bind failure with its error code,
a pairing write that failed with its error code, and for a request whose handler threw, one fixed
line naming the error's class (`agent-inbox remote entry: a request failed (TypeError)`), answered
with a bare 500. It never logs a login, a header value, a code, a secret, a hash, a label, the
tailnet host, a path or an error's message (a store error can quote ids taken from the path). The
loopback entry keeps Hono's default error handler.
