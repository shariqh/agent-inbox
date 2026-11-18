---
paths:
  - "src/viewer-remote.ts"
  - "test/viewer-remote.test.ts"
  - "test/remote-routes.test.ts"
  - "test/remote-setting.test.ts"
applyTo: "src/viewer-remote.ts,test/viewer-remote.test.ts,test/remote-routes.test.ts,test/remote-setting.test.ts"
---

# Remote entry: one Inbox from every device (#617)

The hub's viewer listens only on loopback (`viewer-network.md`). The remote entry is a second
loopback listener, reached only through Tailscale Serve, for the owner's own paired devices.
Design: [`docs/superpowers/specs/2026-11-17-remote-inbox-design.md`](../superpowers/specs/2026-11-17-remote-inbox-design.md) §3.2.
Process boundaries: [`overview.md`](overview.md).

Claude Code and Copilot CLI load this file when they read or edit a file matching the
`paths`/`applyTo` globs above; anyone else should read it before changing the remote entry.
Later PRs add their files (`electron/remote-*.cjs`, `electron/desk-open.cjs`) to the globs.

## What is built (PR 2a)

- `src/viewer-remote.ts`: the setting reader, the gate, the allowlist and the listener.
- `src/viewer-server.ts`: a second `createViewer(db, { mesh })` with no owner token, its static
  files, `startRemoteEntry`, and `GET /api/remote-entry` on the loopback app.

## What is not built yet

- Pairing: `POST /api/remote/pair`, pairing codes, `POST /api/remote-entry/code` (PR 2b). Until then
  the only way to add a device is to write `remote.json` by hand.
- The Settings panel, every Tailscale command, the Serve check and the notifications (PR 2b).
- Connect mode in the desktop app (PR 3), and Open desk and notifications against a hub (PR 4).

So after this PR the entry is off for everyone. With no `remote.json`, or with no device in it,
every request is refused.

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
7. Pairing is PR 2b. `POST /api/remote/pair` is not on the allowlist, so it is refused like any
   unlisted route.
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
`/api/launch-folders`, `/api/chats/copilot/:id`, and `/api/remote-entry`.
`test/remote-routes.test.ts` lists every route `createViewer` registers and fails until each new one
is classified. Messaging a session is allowed: that is the owner's accepted risk (design §3.2).

The gate allows by concrete path, so the same test also asks Hono which handlers it would run for a
sample path of each allowed pattern, on the app as the entry wraps it (`guardRemoteApp`): exactly the
gate, `createViewer`'s wildcard middleware, the one handler registered with that pattern, and for a
GET the static handler. A broader route registered anywhere fails it. Hono copies the wrapped app's
routes when the entry starts, so nothing added to that app later is served; PR 2b's pairing route
must be registered on the guarded app.

## Status, loopback only

`GET /api/remote-entry` on the loopback app answers `{ on, listening, port, host, error, refused:
{ host, funnel, login, path, origin, device, route } }`, counts since the viewer started. `error`
is a bind failure or fixed words for a refused file. It never holds a login, a header value, a
device id or a hash. It is not on the remote allowlist.

## Logging

The entry logs only that it opened on a port, that it closed, a bind failure with its error code,
and for a request whose handler threw, one fixed line naming the error's class
(`agent-inbox remote entry: a request failed (TypeError)`), answered with a bare 500. It never logs a
login, a header value, a secret, a hash, the tailnet host, a path or an error's message (a store
error can quote ids taken from the path). The loopback entry keeps Hono's default error handler.
