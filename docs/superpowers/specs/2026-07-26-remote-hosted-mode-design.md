# Design: remote / hosted mode — streamable-HTTP + auth (issue #8)

**Date:** 2026-07-26
**Status:** design only. **Three blocking decisions are open** (§11.1–§11.3) and must be
answered by the repo owner before any code is written. Nothing in this wave is implemented.
**Scope of this wave:** this document. Zero source changes, zero test changes.
**Scope chosen for the future wave:** remote mode ships as a **third entry point**
(`src/hosted-server.ts`) that mounts the MCP endpoint and the existing `createViewer(db)`
Hono app on one port in one process. `src/mcp-server.ts` and `src/viewer-server.ts` keep
their behaviour; `src/store.ts` is not modified at all.

---

## §0 — Historical finding: the "local" v1 viewer was LAN-reachable

**Resolved 2026-08-07.** The local entry now composes a viewer-process-only guard,
binds a single listener to `127.0.0.1`, validates exact loopback Host/Origin values,
denies framing, and gives Electron a boundary marker for fail-closed reuse. The finding
below is the historical baseline that motivated that release-blocking fix.

**This was a fact about the code when this design was written, not a remote-mode design
note.** It is recorded first because it changes how the rest of this document should be read.

`src/viewer-server.ts` calls:

```ts
serve({ fetch: app.fetch, port })
```

with **no `hostname`**. `@hono/node-server` (`dist/index.mjs`) does
`server.listen(options?.port ?? 3e3, options.hostname, …)`, and `hostname?: string` is
optional in its `ServeOptions`. Passing `undefined` makes Node listen on **all interfaces**
(`::` / `0.0.0.0`), not loopback.

Consequence: anyone on the same wifi can reach `http://<your-lan-ip>:4319/` right now and
read the entire inbox — every flag title, every `context` blob, every board — with no
credential. That is a hand-rolled, unauthenticated version of the very feature #8 exists to
provide.

**This was not fixed in this design wave.** It was handled separately. It is documented because (a) the
hosted design's "the tunnel connects to us over loopback" story is only correct once the bind
is explicit, and (b) shipping remote mode while the local server quietly answers the LAN is
incoherent. See §11.6 for the decision and §11.6's Electron blast radius, which is larger
than "LAN reachability" and is the reason this is not a one-line change.

At the time, the corroborating fact — and the reason nobody caught it — was that **no test
file in the repo referenced `src/viewer-server.ts` at all.** `test/viewer.test.ts` exercised
`createViewer(db)` directly. The entry point that added `serveStatic`, `serve()` and the
startup `console.log` had zero coverage. See §7 for what that cost the "v1 is provably
untouched" claim.

---

## §1 — Problem, and the shape of the answer

The inbox is a laptop-local hub: one SQLite file at `~/.agent-inbox/inbox.db`, one stdio MCP
server per agent session, one Hono viewer on `localhost:4319`. Two things it cannot do:

1. **Phone reach.** The human is away from the desk; the badge that is supposed to be the
   trustworthy attention signal is on a machine they are not looking at.
2. **Cloud-agent reach.** An agent running on someone else's infrastructure has no stdio
   pipe to your laptop and no filesystem access to your DB, so it cannot flag at all.

The answer is a **third entry point**, never a modification of the two that exist:

| Entry | Transport | Auth | DB | Status |
|---|---|---|---|---|
| `src/mcp-server.ts` | stdio, one process per session | none | local file | v1, unchanged |
| `src/viewer-server.ts` | HTTP, localhost | none | local file | v1, unchanged (except §11.6) |
| `src/hosted-server.ts` | HTTP: `/mcp` + viewer + static | bearer / cookie | its own local file | **new** |

Everything below is what has to be true for that third column to work without damaging the
first two.

---

## §2 — Transport: `WebStandardStreamableHTTPServerTransport`, stateful

### The choice

Installed SDK is `@modelcontextprotocol/sdk` **1.29.0**. `package.json` declares `^1.12.0`,
which **already resolves to 1.29.0** — verified. No dependency bump is *required* for any of
this to run. (Raising the floor to `^1.29.0` is optional hygiene and rewrites
`package-lock.json`; decide that separately, it is not a blocker.)

Two server transports exist and both import cleanly under Node 24 (verified by runtime
import):

- `StreamableHTTPServerTransport` from `.../server/streamableHttp.js` — Node
  `IncomingMessage`/`ServerResponse`, `handleRequest(req, res, parsedBody?)`.
- `WebStandardStreamableHTTPServerTransport` from
  `.../server/webStandardStreamableHttp.js` — `handleRequest(req: Request, options?:
  { parsedBody?: unknown; authInfo?: AuthInfo }): Promise<Response>`.

**Choose the Web-Standard one.** Hono's `c.req.raw` *is* a Web `Request`, so the endpoint
mounts on the same Hono app as `createViewer` with no adapter. The SDK's own docstring
spells the idiom verbatim:

```ts
// Hono.js usage
app.all('/mcp', async (c) => {
  return transport.handleRequest(c.req.raw);
});
```

Options type is `WebStandardStreamableHTTPServerTransportOptions`: `sessionIdGenerator?`,
`onsessioninitialized?`, `onsessionclosed?`, `enableJsonResponse?`, `eventStore?`,
`retryInterval?`, plus **deprecated** `allowedHosts` / `allowedOrigins` /
`enableDnsRebindingProtection` (the SDK says to use external middleware — do that, in Hono;
see §9.6). No new npm dependency is needed: `hono`, `@hono/node-server`, the SDK and
`node:crypto` cover everything.

### Stateful, one `McpServer` per session — and do not let a reviewer "simplify" this

`buildMcpServer` closes over a per-session `scope` and a per-session `sessionId`, and **every
tool handler reads both**. Stateless mode (`sessionIdGenerator: undefined`) would collapse
every remote agent into **one Live row and one `register` scope**, silently regressing #28
and destroying the identity seam. Stateful multi-session hosting is mandatory here, not a
preference.

Worth knowing: this would make remote identity *stricter* than local, not equal to it. On the
stdio path a "session" is really a **client process** — a subagent's calls are served by its
parent CLI's long-lived server (measured during #42: servers running 4+ days), so a fan-out
shares one `sessionId`, one Live row and one in-memory ledger. Streamable-HTTP's
`sessionIdGenerator` is what finally makes one session mean one agent. Do not assume the local
path already behaves that way when porting anything that keys on `sessionId`.

### The three wiring traps — all three produce a *working-looking* server if you get them wrong

These were verified empirically against this repo's installed `hono` and SDK. Each one is
written out because none is inferable from the SDK docs.

**Trap 1 — the body can only be read once.**

```
$ node verify.mjs
2) raw.json after req.json -> TypeError: Body is unusable: Body has already been read
3) json() on GET -> SyntaxError: Unexpected end of JSON input
```

Detecting the initialize POST requires `isInitializeRequest(body)` from
`@modelcontextprotocol/sdk/types.js` (verified exported), which requires reading the body.
The transport then reads the body *itself* (`rawMessage = await req.json()`) **unless**
`options.parsedBody !== undefined`. So the docstring idiom `handleRequest(c.req.raw)` and
`isInitializeRequest` are **mutually exclusive** unless you pass `parsedBody` through.
GET (the SSE stream) and DELETE have no body at all, so the `.json()` must additionally be
gated on `POST`.

**Trap 2 — `sessionIdGenerator` mints its id too late to hand to `buildMcpServer`.**

The SDK sets `this.sessionId = this.sessionIdGenerator?.()` *inside* `handleRequest`, while
processing the initialize POST — i.e. **after** `buildMcpServer()` has already run and
`server.connect(transport)` has already happened. There is no ordering in which
`buildMcpServer(db, cwd, { sessionId })` can receive an id the transport has not yet
generated. Follow §2 and §3 naively and you mint **two** UUIDs: `items.session` and the
activity row hold id A; the `mcp-session-id` header, `onsessionclosed(sessionId)` and
`transport.sessionId` hold id B. The stated goal — the items column, the activity row key and
the MCP session all agreeing — is then silently unmet, and `onsessionclosed(B)` deletes
nothing from a map keyed on A, leaking a server + transport per session forever.

**Fix: mint exactly one id in the entry, before constructing anything**, and pass it to
both.

**Trap 3 — the SDK cannot 404 a session your map does not hold.**

`validateSession` is a private *instance* method that compares the header against
`this.sessionId`; it 400s on a missing header and 404s on a mismatch. It only runs once you
already have a transport. A header naming an id absent from your map yields
`map.get(id) === undefined` and there is nothing to call `handleRequest` on. Under `strict`
that is a typecheck failure; non-null-asserted, it is a runtime `TypeError`. **The entry owns
the map-miss branch.** The SDK handles a *mismatched* id within a live transport; it cannot
handle an id that never reached one.

### The wiring, written out (sketch for `src/mcp-http.ts`)

```ts
const sessions = new Map<string, { server: McpServer; transport: WebStandardStreamableHTTPServerTransport; dispose(): void }>()

export function createMcpHttpHandler(db: Database.Database) {
  return async (c: Context): Promise<Response> => {
    // Trap 1: POST only. A bare c.req.json() on the SSE GET throws SyntaxError.
    const body = c.req.method === 'POST' ? await c.req.json().catch(() => undefined) : undefined
    const isInit = body !== undefined && isInitializeRequest(body)

    if (isInit) {
      // Trap 2: ONE id, minted here, before anything is constructed.
      const id = randomUUID()
      const seed = {                                   // §4, construction-time only
        project: c.req.header('x-agent-inbox-project'),
        stream: c.req.header('x-agent-inbox-stream'),
      }
      const { server, dispose } = buildMcpServer(db, process.cwd(), {
        sessionId: id, infer: false, seed, selfHeartbeat: false,   // §3
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => id,                  // the id the McpServer already holds
        onsessionclosed: (sid) => { sessions.get(sid)?.dispose(); sessions.delete(sid) },
      })
      transport.onclose = () => { sessions.get(id)?.dispose(); sessions.delete(id) }
      await server.connect(transport)
      sessions.set(id, { server, transport, dispose })
      return transport.handleRequest(c.req.raw, { parsedBody: body })   // Trap 1
    }

    // Trap 3: the entry owns the map miss.
    const headerId = c.req.header('mcp-session-id')
    if (headerId === undefined) return jsonRpcError(c, 400, -32000, 'Bad Request: Mcp-Session-Id header is required')
    const entry = sessions.get(headerId)
    if (entry === undefined) return jsonRpcError(c, 404, -32001, 'Session not found')
    return entry.transport.handleRequest(c.req.raw, body === undefined ? undefined : { parsedBody: body })
  }
}
```

---

## §3 — What `buildMcpServer` must gain, and why stdio must not notice

`src/mcp.ts` does five process-global things at the top of `buildMcpServer` (locate them by
content — the `registerPresence` / `heartbeat` block, not by line number). All five are only
correct at **one process per session**. Under HTTP, one process holds N sessions.

1. **`const sessionId = randomUUID()`** — must *be* the transport's session id in HTTP mode,
   so `items.session`, the activity row key and the MCP session agree and `endActivity` on
   close targets the right row. See Trap 2.
2. **`setInterval(() => touchActivity(db, sessionId), 5 * 60000).unref()`** — leaks one timer
   per remote session forever, and, far worse, **keeps a dead remote client's Live row fresh
   indefinitely**, so `listActivity`'s 15-minute cutoff never fires and the viewer shows
   phantom live sessions. That is a direct hit on tenet 2 (the badge must stay trustworthy).
   **In HTTP mode this interval must be OFF.** `heartbeat()` — already called by every tool
   handler — plus the 15-minute cutoff is the truth. A live session that makes no tool call
   for 15 minutes is indistinguishable from a dead one, and treating it as dead is the
   correct, badge-preserving default.
3. **`setTimeout(registerPresence, 2000).unref()`** — must be cleared by `dispose()`.
4. **`process.on('exit', …)`** — N listeners per process. Each ends only its own row so the
   semantics survive, but Node warns past 10.
5. **the `SIGINT`/`SIGTERM` → `process.exit(0)` loop** — must not be registered per session
   under HTTP. A hosted server wants a graceful drain, not instant exit on the first signal.

**Proposed signature change:**

```ts
export function buildMcpServer(
  db: Database.Database,
  cwd: string,
  opts?: { sessionId?: string; infer?: boolean; seed?: ScopeSeed; selfHeartbeat?: boolean },
): { server: McpServer; dispose(): void }
```

Defaults reproduce today's stdio behaviour: `sessionId` = a fresh `randomUUID()`, `infer` =
`true`, `seed` = none, `selfHeartbeat` = `true` (the 2s `registerPresence` fallback and the
5-minute `touchActivity` interval both stay).

**The contract is NOT "byte-for-byte identical".** It cannot be: the return type changes and
items 4 and 5 move out of `buildMcpServer` into the entry files. State it precisely instead:

> `src/mcp-server.ts` must re-register **both** `process.on('exit', () => dispose())` **and**
> `for (const sig of ['SIGINT','SIGTERM'] as const) process.on(sig, () => process.exit(0))`.

If the `exit` handler is not re-registered, `test/mcp.integration.test.ts`'s
*"sessions auto-register presence; status upgrades it; done reverts; exit removes"* goes red —
the exact test named as the regression gate. That test asserts `listActivity(openDb(dbPath))`
is empty after `client.close()`.

**One invariant survives completely unchanged, and must be restated so nobody "cleans it
up":** `clientName()` stays `server.server.getClientVersion()?.name`, read **lazily inside
handlers**. `clientInfo` arrives via the initialize handshake over HTTP exactly as it does
over stdio, so agent inference keeps working remotely. Capturing it at build time still
yields `undefined`.

---

## §4 — Identity without a `cwd`: `register` is the seam, but is not sufficient alone

Four gaps, stated as findings.

### Gap 1 — silent misattribution (the dangerous one)

`src/mcp-server.ts` passes `process.cwd()`. An HTTP entry doing the same makes `inferProject`
run `git remote get-url origin` **in the server's own directory**. If the server runs from a
repo checkout — likely, since you deploy *this* repo — then **every remote agent's flags get
attributed to project `agent-inbox`, on the server's branch.**

"Fail open, never lose a flag" is satisfied. **"Attribute to `unknown`" is violated**, and a
wrong-but-plausible label is strictly worse than `unknown`, because nobody notices.

Remote mode must therefore run with inference **OFF**, not merely overridden:

```ts
makeScope(cwd, { infer: false, seed })
// project: 'unknown', stream: '', agent: still derived from clientInfo
```

`inferAgent(clientName)` takes the client name, not the cwd, and never shells out to git, so
agent attribution is unaffected by turning inference off.

### Gap 2 — `register` is a call the agent must remember

Every flag raised before the first `register` lands in `unknown`. Fix additively with **scope
headers**, carried by the same client config that carries the token. Verified against the
installed CLI (`-H, --header <header...>` is variadic and repeats):

```sh
claude mcp add --transport http agent-inbox https://inbox.example/mcp \
  --header "Authorization: Bearer $AGENT_INBOX_TOKEN" \
  --header "X-Agent-Inbox-Project: my-project"
```

**Precedence must be `register` > header > `'unknown'`.** `register` is the stated seam and
must keep winning.

**Seed at construction only — read the headers off the Hono context on the initialize POST**
(`c.req.header('x-agent-inbox-project')`), and pass them into `makeScope`. Do **not** read
them per-call off `extra.requestInfo.headers`. Two reasons:

- Per-call seeding would have to go through `scope.override()`, which would **clobber an
  earlier `register` on the very next tool call**, inverting the mandated precedence.
- Threading `extra` means changing the callback signature of **all ten** `registerTool`
  handlers in `src/mcp.ts` (`flag`, `resolve`, `pending`, `status`, `register`, `whoami`,
  `board_upsert`, `board_row`, `board_archive`, `board_get`), not just the two this design
  otherwise touches.

Construction-time seeding makes register-wins **structural** rather than ordering-dependent,
and costs zero handler signature changes.

**Known limitation, write it in the docs:** headers are static per client config, so `stream`
(the branch) goes stale the moment the agent switches branches. Headers are good for
`project`, poor for `stream`. Remote agents should still `register({ stream })` or pass
`flag({ stream })`.

### Gap 3 — `register` cannot set `agent`

Five cloud agents are five undifferentiated `claude-code` rows. Add optional `agent` to
`register`'s `inputSchema` and to `makeScope().override()`. Both optional, both
backwards-compatible.

### Gap 4 — debuggability, without breaking the `register`/`whoami` payload

A human debugging a misattributed flag deserves an answer, not a shrug. But **`source` must
not become a fourth key on the `Scope` return**, for two reasons:

- `register` and `whoami` both do `JSON.stringify(scope.get(clientName()))` **wholesale**, so
  a fourth key silently changes `register`'s reply payload as well as `whoami`'s.
- A single `source` string is ambiguous: `project` can come from `register` while `stream`
  comes from a header. It has to be per-field or it is misinformation.

**Decision:** keep `Scope` at three keys. Add a separate
`scope.origins(): { project: Origin; stream: Origin; agent: Origin }` where
`Origin = 'register' | 'header' | 'cwd' | 'default'`, read **only** by `whoami`, which returns
`{ ...scope.get(name), origins: scope.origins() }`. `register`'s payload is unchanged.

(For the record: `test/scope.test.ts`'s two existing cases use per-field `.toBe`, and
`test/mcp.integration.test.ts` only reads `.project`, so both would have survived either
choice. The `register` payload is what settles it, not the tests.)

### Gap 5 — multi-human

`listItems` / `listBoards` / `listActivity` return **everything** with no owner column, and
the viewer renders the whole DB. Two humans on one hosted instance see each other's flags.
This is decision point §11.1 and the recommendation is single-tenant, which keeps
`src/store.ts` at a **zero diff**.

---

## §5 — Auth: one shared bearer token, opt-in, and why not the SDK's

**Model:** a single static secret, single-tenant, in `AGENT_INBOX_TOKEN`.
**Absent ⇒ hosted mode is off** and `src/hosted-server.ts` refuses to start (and refuses to
bind a non-loopback interface). That one rule simultaneously protects the hard constraint (the
local path never sees auth) and prevents an accidentally-exposed open inbox.

**Provisioning:** operator-generated (`openssl rand -base64 32`), delivered via service env or
a `0600` `~/.agent-inbox/token` file. No login page, no user table, no OAuth.

**Do not use the SDK's auth stack.** `requireBearerAuth` returns an **Express**
`RequestHandler` (verified in `bearerAuth.d.ts`) and this repo is Hono;
`mcpAuthRouter` / OAuth / DCR is enormously more surface than one static token. The same
applies to `hostHeaderValidation` and `localhostHostValidation` — both Express-only.

**Where it lives:** a **new `src/auth.ts`**. Never inside `src/viewer.ts` — keeping it out is
exactly what keeps `createViewer`'s signature and `test/viewer.test.ts`'s credential-less
`app.request('/api/items')` calls untouched.

**MCP gate:** compare `Authorization: Bearer …` with `crypto.timingSafeEqual` over
equal-length buffers (**length-guard first** — `timingSafeEqual` throws on length mismatch);
`401` + `WWW-Authenticate: Bearer` on failure. Optionally build an `AuthInfo` and pass
`transport.handleRequest(c.req.raw, { parsedBody, authInfo })` so it reaches `extra.authInfo`
— unused single-tenant, but it is the seam for per-token identity later (§11.1 option 3).

**Viewer gate — a genuinely different mechanism.** A browser cannot set `Authorization` on a
document navigation. `GET /?token=…` (or a tiny `/login` form) sets a cookie; all routes then
accept **cookie OR bearer**.

```
Set-Cookie: agent_inbox=<token>; HttpOnly; SameSite=Strict; Path=/[; Secure]
```

**`Secure` must be conditional, not mandatory.** A private tailnet URL is
`http://100.x.y.z:4319` — not a secure context and not `localhost`, so the browser silently
**discards** a `Secure` cookie: the human clicks the magic link, nothing is stored, every
subsequent request 401s, and there is no error explaining why. That would make the
*recommended* deployment (§11.3 option 1) unusable with the *recommended* auth mechanism.
Rule:

- Set `Secure` when the request arrived over https (`https:` scheme, or
  `X-Forwarded-Proto: https` from the tunnel).
- Omit it otherwise, and **log once at startup** that the cookie is being issued without
  `Secure` and why.
- Under §11.3 option 1, the right answer is `tailscale serve`, which terminates TLS with a
  real MagicDNS cert — then `Secure` is on and the plain-IP URL is documented as
  degraded-but-working rather than mysteriously broken.

**`SameSite=Strict` is load-bearing.** The seven write routes — `POST
/api/items/:id/{resolve,dismiss,annotate,reply}`, `POST /api/boards/:id/{archive,unarchive}`,
`POST /api/boards/:id/rows/:rowId/annotate` — have **no CSRF token** today. (Verified: the
only response header `createViewer` sets is `x-inbox-boot`.)

**Rejected alternative, and why:** localStorage token + `Authorization` header on every
fetch. It forces edits to every fetch call site (`load()`, `renderSetup()`, `postJSON()` in
`public/app.js`, plus the three fetches in `electron/main.cjs`'s `startAttentionWatch`), it is
XSS-exfiltratable, and it **cannot authorize the initial document or the static module
requests at all**. The cookie leaves `public/` untouched — which matters because `public/` has
no build step and Electron lifts the directory wholesale.

---

## §6 — Composition: the gate-ordering trap that ships an open inbox with no error

**This is the single most dangerous line in the whole design.** `createViewer(db)` returns a
Hono app with **all routes already registered**. In Hono, a `use('*')` middleware registered
*after* a matching route never runs — the route handler matches first and never calls
`next()`.

Verified empirically against this repo's installed `hono`:

```
1)  route registered, THEN use('*') gate   -> 200 {"ok":true}      ← UNAUTHENTICATED
1b) use('*') gate, THEN route             -> 401 gated
1c) new Hono() + use('*') + route('/', sub) -> 401 gated
```

So `const app = createViewer(db); app.use('*', bearerGate())` — the most natural reading of a
manifest that lists "openDb, createViewer, bearerGate, app.all('/mcp'), serve" — ships an
**internet-facing inbox with no auth on `/api/items`, `/api/boards` or any write route**,
silently, with no error, passing every test except one specifically written to catch it.

**Never call `app.use()` on the app `createViewer` returns.** The composition is literal:

```ts
const db = openDb()                                   // AGENT_INBOX_DB seam
const app = new Hono()
app.use('*', securityHeaders())                       // CSP etc. — §9.4
app.use('*', hostGate())                              // DNS rebinding — §9.6
app.use('*', bearerGate())                            // 401 for everything below — §5
app.all('/mcp', createMcpHttpHandler(db))             // §2
app.route('/', createViewer(db))                      // the v1 viewer, byte-identical
app.get('/*', serveStatic({ root: staticRoot }))      // MUST NOT be forgotten — see below
serve({ fetch: app.fetch, port, hostname })           // explicit hostname — §9.3
```

**`serveStatic` is not part of `createViewer`.** It lives in `src/viewer-server.ts`. A hosted
entry built without it answers `/api/*` and `/mcp` but **404s `/`, `/app.js`, `/style.css`,
`/attention.js`** — i.e. "phone reach", the entire point of #8, is not delivered.

**`root: './public'` is cwd-relative.** `electron/main.cjs` already documents this constraint
for the spawned viewer ("cwd must be the repo root: viewer-server serves static files from
./public"). A systemd unit started from `/` would silently serve nothing. The hosted entry
must either resolve an absolute root from `import.meta.url` or document a required
`WorkingDirectory=`.

**`openDb` is called exactly once** and the same handle is shared by `/mcp` and the viewer —
see §8.

---

## §7 — The hard constraint: what "v1 is untouched" actually proves

Enumerated as checkable facts, not a promise.

- **(a)** `src/viewer-server.ts` and `src/mcp-server.ts` keep their current behaviour. The
  only proposed change to `viewer-server.ts` is passing an explicit `hostname` (§0 / §11.6),
  and it is called out as **the one local-path behaviour change** so it gets signed off rather
  than slipping in as a side effect.
- **(b)** `createViewer(db)`'s signature is unchanged and it **never imports `src/auth.ts`**.
  The gate is installed by the hosted entry, *before* `app.route('/', createViewer(db))`.
- **(c)** `buildMcpServer`'s new third parameter is optional with stdio-preserving defaults;
  the return-type change and the relocated signal handlers are spelled out in §3 rather than
  waved at.
- **(d)** The three existing seams carry the whole feature: `register` = identity (§4),
  `AGENT_INBOX_DB` = which DB the hosted process owns, `AGENT_INBOX_PORT` = which port it
  binds. Exactly **one** new env var is introduced (`AGENT_INBOX_TOKEN`), plus optionally
  `AGENT_INBOX_HOST`.
- **(e)** **`src/store.ts` is not modified at all** under the single-tenant recommendation —
  no schema change, no new column, no migration. That is the single largest risk reduction
  available in this design and it should be defended in review.
- **(f)** The stdout invariant, with its correct scope: it is a property of the **stdio**
  server, but `src/mcp.ts`, `src/store.ts` and `src/infer.ts` are **shared by both entries**,
  so "never `console.log` from these three modules" is unchanged. Only the new hosted entry
  may log. `src/infer.ts`'s `stdio: ['ignore','pipe','ignore']` stays even though remote mode
  should not be calling it at all.

### The proof is weaker than it looks — say so

It is tempting to claim "`test/viewer.test.ts` green with zero edits" as **the** proof that
v1's no-auth local path is intact. **It proves strictly less than that.** Every case in that
file calls `createViewer(db).request(...)` directly. At design time the actual local entry
point was `src/viewer-server.ts`, which added `serveStatic`, `serve()` and a `console.log` —
and **had zero test coverage** (verified then: no test file referenced it). The static-file
surface that §9.2 calls the dangerous one is exactly what `viewer.test.ts` structurally
cannot see.

Correct claim: *`test/viewer.test.ts` unmodified proves `createViewer`'s **routes** gained no
gate.* It is necessary, not sufficient. The weight is carried instead by a **gate-ordering
test that boots the composed hosted app** and asserts 401 on `/`, `/app.js`, `/api/items` and
`/api/boards` with no credential, and 200 with the bearer (§12).

---

## §8 — SQLite locality, and the sync non-goal

**Hard fact first: SQLite must never be accessed over a network filesystem.** WAL is
explicitly unsupported on NFS/SMB and locking is unreliable there. The failure mode is
**corruption**, not slowness.

- **T1 (recommended).** The DB is **local to the hosted process**. One Node process on the
  server owns its `inbox.db` on local disk and serves both `/mcp` and the viewer from the same
  Hono app and the **same `openDb` handle**. Remote agents speak MCP over HTTP; there is no
  remote filesystem and no new multi-writer problem. `openDb`'s WAL + `busy_timeout=5000` stay
  exactly as they are; `AGENT_INBOX_DB` is the existing seam and needs no change.
- **T2 (rejected).** Mounting the DB over a share so several machines open it.

> **The consequence the owner will be surprised by: the local hub
> (`~/.agent-inbox/inbox.db`) and the hosted hub are TWO INDEPENDENT INBOXES, not one hub seen
> twice. There is no sync, and building one is out of scope.**

If the goal is one inbox, the answer is to point the **laptop's** agents at the remote
endpoint too (the laptop stops using stdio), never to reconcile two SQLite files. Reconciling
them would mean merging human annotations that this repo calls *sacred* and boards whose
absent rows are *deleted* — that is a distributed-systems project, not a feature. This is
decision point §11.2, and it determines whether hosted mode actually delivers phone reach or
just adds a second place to look.

**One new pressure worth naming and not pre-optimizing:** `better-sqlite3` is synchronous, so
under T1 a slow query blocks the event loop and therefore blocks MCP responses. Today's tables
are tiny and the existing indexes (`idx_items_status_project`, `idx_boards_status_project`,
`idx_activity_live`) cover the list queries. Measure before touching it.

---

## §9 — Security: ten things that must be true before this touches the internet

The framing that matters: **the DB holds agent-authored, attacker-influenced text and the
viewer renders it.** A prompt-injected agent writes whatever an attacker wants into
`title` / `detail` / `context` / board rows, and a tunnel makes that page reachable by anyone
who learns the URL.

**1. TLS end to end.** A bearer token over plaintext HTTP is a token in every intermediary's
log. Cloudflare Tunnel / Tailscale Funnel / `tailscale serve` terminate TLS; a raw
port-forward does not.

**2. No unauthenticated route, including static files.** Today `app.get('/*', serveStatic({
root: './public' }))` serves `index.html` and every module to anyone. The gate must cover
`'*'`, registered before everything — see §6.

**3. Bind explicitly.** See §0. Bind loopback and let the tunnel connect locally; worth doing
regardless of #8.

**4. CSP — and the naive header breaks the UI.** There is no CSP header today (the only
response header set anywhere is `x-inbox-boot`). `public/index.html` is clean: no inline
`<script>`, no `style=` attribute; `/ufuzzy.iife.min.js` is a same-origin *classic* script
covered by `script-src 'self'`. **But `public/app.js` writes four inline `style=` attributes
into `innerHTML`:**

| Function | Markup |
|---|---|
| `needsRowEl` | `<span class="pdot" style="background:${color.dot}" …>` |
| `boardEl` | `<span class="proj-dot" style="background:${c.dot}">` |
| `boardEl` | `<div class="bar-fill" style="width:${p.secondary}">` |
| `itemCardEl` | `<span class="pdot" style="background:${color.dot}">` |

Under `style-src 'self'` with no `'unsafe-inline'` (CSP3 falls `style-src-attr` back to
`style-src`), all four are blocked: **every project colour dot goes transparent and every
board progress bar renders at zero width.** So the header is not "compatible as written" — it
would ship a visibly broken UI.

**This spec picks the first option, explicitly:**

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';
base-uri 'none'; form-action 'self'
```

Rationale: CSP here is the **second** line of defence. The primary control is that `esc()` is
the only path into `innerHTML`, that **no `href` is ever built from agent text** (verified:
zero `href` occurrences in `public/app.js`, no `<a >` constructed anywhere) and that **no
inline `on*=` handler exists in any `public/*.js`**. `script-src 'self'` — the half that
actually stops injected script — is entirely unaffected by relaxing `style-src`.

The tighter alternative is a **follow-up, not a precondition**: move the four to CSS custom
properties (`el.style.setProperty('--dot', …)` plus rules for `.pdot`, `.proj-dot`,
`.bar-fill` in `public/style.css`) and then tighten to `style-src 'self'`. That drags
`public/app.js` and `public/style.css` into the implementation wave, which is why it is not
the first cut.

**5. `esc()` stays the only path into `innerHTML` — and name the specific landmine.** Issue
**#30** (source + PR links) renders agent-supplied and third-party URLs as anchors, and
`esc()` does **not** neutralise `javascript:` in an `href` (`public/esc.js` does not touch
schemes). #30's accepted design already mandates a `safeHttpUrl` scheme allowlist; **that
allowlist is a precondition for hosted exposure**, not a nicety. Verified clean today, which
is exactly the state a source-text guard should pin so it cannot regress silently.

**6. DNS rebinding on the local server.** The SDK ships
`hostHeaderValidation(['localhost','127.0.0.1','[::1]'])` but it is Express-only, so write the
Hono equivalent (a `Host`-header allowlist) rather than importing it. The transport's own
`allowedHosts`/`enableDnsRebindingProtection` options are deprecated in favour of exactly
this.

**7. Body-size cap + crude per-IP rate limit on the pre-auth path.** `/mcp` accepts unbounded
JSON and every write is an unbounded DB insert; a token-guesser or a runaway agent fills the
disk.

**8. The stdout rule for the shared modules** — §7(f).

**9. Data classification.** `docs/reporting-snippet.md` actively instructs agents to put
"relevant files/PRs/links" and long background into `context`. Exposing that to the internet
is a **conscious decision**, not a default.

**10. Rotation / revocation.** One static env token means restart-to-rotate and no revocation
short of rotation. Acceptable single-tenant — but write it down rather than discovering it.

---

## §10 — Presence across machines, and #10's hook backstop when the DB is remote

**Presence already works cross-machine.** The `activity` table keys on `session` (a UUID) and
carries `project`/`stream`/`agent` — nothing machine-scoped — once the MCP transport session
id **is** the presence key (§2 Trap 2 / §3.1).

**What breaks is teardown.** `process.on('exit')` no longer ends remote rows, so a cloud agent
whose container dies never sends `DELETE /mcp` and its row lingers until the 15-minute
`listActivity` cutoff. That cutoff **is** the designed backstop and is adequate — **provided
the 5-minute self-heartbeat interval is off in HTTP mode (§3.2)**, because otherwise the
server keeps a dead client's row green forever and the Live view lies.

**Optional, explicitly not required:** a `host` column so the Live footer can say *where* a
session is (`ensureColumn(db, 'activity', 'host', …)` + pass-through in
`ActivityUpdate`/`Activity` + a render in `public/livebar.js`). That crosses the
store/viewer/public contract and is a **separate follow-up**, not part of #8.

**#10's backstop over HTTP.** The two Stop hooks shell out against the local DB file under
`$HOME/.agent-inbox/`. With a remote hub there is no local DB and they no-op silently (they guard
`[ -f "$DB" ] || exit 0`, which is correctly fail-open but invisible).

- **Read path already exists.** `GET /api/items` returns the grouped set including `reply` and
  `reply_seen_at`, so a "human answered, agent has not picked it up" count becomes `curl` +
  `jq`.
- **Write path is missing.** #10's core move — *insert an item when the agent never flagged at
  all* — has **no HTTP door**: the viewer exposes no `POST /api/items`. Hosted mode should add
  exactly one bearer-gated endpoint, body = `NewItem` minus `session`, forcing a
  distinguishable `agent: 'hook'` so auto-items are sweepable.
- **Put it on the hosted entry only**, never in `src/viewer.ts` — see §11.5. Giving the local
  server an unauthenticated insert endpoint would be a regression in its own right, given §0.
- Hooks must `curl --max-time 2` and `exit 0` on any failure. **A hosted inbox that is down
  must never trap a session.**

**Sequencing note, corrected for reality:** the general claim "#8 should land before #10" is
true only for the *hosted* case. In this wave, the issues-10-21 workstream runs after this one
and lands its hooks against the **local** SQLite path via `store.ts`, which is correct for a
local hub and needs no HTTP door. The endpoint above is needed only once a hosted hub actually
exists.

---

## §11 — Decision points

Three of these are **blocking**: the design cannot be implemented until they are answered.
Each carries a recommendation, not an assumption.

### §11.1 — BLOCKING: single-tenant or multi-tenant?

| Option | Consequence |
|---|---|
| **A. Single-tenant, one shared `AGENT_INBOX_TOKEN`** | `src/store.ts` is not modified at all — no owner column, no migration, no token→user table. The whole feature stays additive behind the existing seams. |
| B. Multi-tenant, per-token identity | `owner` column on `items`/`boards`/`activity`, `WHERE owner = ?` on every list function, a token registry. Puts the highest-risk change squarely inside the one file the invariants protect most. |
| **C. Single-tenant now, with `AuthInfo` threaded through `handleRequest({ authInfo })` as an unused seam** | Same zero-diff on `store.ts`, plus a later additive step to B. |

**Recommendation: C.** It delivers the stated goal — your phone and your cloud agents reaching
your inbox — while leaving `src/store.ts` untouched, which is the single largest available
risk reduction. Multi-tenant is a product decision, not an auth decision.

### §11.2 — BLOCKING: two inboxes, or do the laptop's agents move to the remote endpoint?

The hosted inbox is a **separate hub with its own DB** (§8). So:

| Option | Consequence |
|---|---|
| **A. Laptop agents also register against the remote endpoint** | **One** inbox; phone reach actually delivered. Cost: a server outage means local agents cannot flag, so fail-open discipline has to be airtight and the snippet's polling advice must tolerate a dead endpoint. |
| B. Keep local stdio for the laptop; hosted hub for cloud agents only | No new local failure mode — but you now have two inboxes and the desktop badge is telling you about half of them. Direct hit on tenet 2. |
| C. Build local↔remote sync | Explicitly rejected in this design (§8). |

**Recommendation: A.** The whole point of #8 is reaching **one** inbox from the phone. B
quietly reintroduces the exact firehose problem this tool exists to solve, and the desktop
badge stops being trustworthy. Accept the outage coupling and make every client path fail open
*loudly*.

### §11.3 — BLOCKING: how is it exposed?

| Option | Consequence |
|---|---|
| **A. Tailscale, private tailnet, no public exposure** | Phone is on the tailnet; nothing is reachable from the internet; the token becomes defence in depth rather than the only wall. A token leak is not immediately catastrophic. Pair with `tailscale serve` for TLS so the §5 cookie can carry `Secure`. |
| B. Cloudflare Tunnel with a public hostname + the bearer gate | Reachable by anything with the URL and the token — which is what cloud agents on someone else's infrastructure need. **Every precondition in §9 becomes mandatory rather than advisable.** |
| C. Public tunnel for `/mcp` only; viewer private on the tailnet | Splits the blast radius: agents can write from anywhere, but the rendered page — the XSS surface — is never public. |

**Recommendation: A if your cloud agents can join the tailnet; C if they cannot.** B puts a
page that renders attacker-influenced agent text on the public internet behind one static
secret, which is a materially different risk posture from anything this repo has shipped.

### §11.4 — Non-blocking: header-seeded scope as well as `register`?

**Recommendation: both, precedence `register` > header > `'unknown'` (§4 Gap 2).** The same
`claude mcp add --header` line that carries the token carries the project, so an agent that
forgets `register` still attributes correctly, and `register` stays authoritative. Document
the limitation: headers are fine for `project`, stale for `stream`.

### §11.5 — Non-blocking: where does #10's write endpoint live?

**Recommendation: hosted entry only, bearer-gated.** `src/viewer.ts` stays exactly as it is,
so the local zero-config surface gains no unauthenticated write endpoint and
`test/viewer.test.ts` needs no edit. Local hooks already have a working path through
`store.ts` on the local file.

### §11.6 — Non-blocking, but bigger than it looks: should `viewer-server.ts` bind `127.0.0.1`?

**Resolved 2026-08-07:** yes. Electron now uses `127.0.0.1` consistently, a real-listener
test asserts the bound address, and reuse requires the hardened viewer marker. This made a
single IPv4 listener sufficient; no `::1` listener or `AGENT_INBOX_HOST` escape hatch was
added. `localhost` remains an exact browser Host/Origin alias for compatibility.

Given §0, the answer looks obviously yes. **The blast radius is Electron, not just the LAN.**
`electron/main.cjs` hardcodes ``URL_BASE = `http://localhost:${PORT}/` `` and uses it for the
reuse `http.get` probe, `win.loadURL`, and the three attention fetches. On macOS `localhost`
resolves `::1` first. Node's `autoSelectFamily` and Chromium's happy-eyeballs *should* fall
back to `127.0.0.1` — but **nothing in the repo verified it then, and no test file referenced
`src/viewer-server.ts` at all**, so the change would have shipped with zero coverage on the
one path the desktop app depends on.

The original recommendation was to **bind explicitly, but bind both** — listen on `127.0.0.1` **and** `::1` (two
listeners), or gate the change on a recorded manual `npm run electron` smoke check, with
`AGENT_INBOX_HOST` to widen it. Called out loudly in the changelog: it is the only local-path
behaviour change in this design, so it should be deliberate and signed off.

### §11.7 — Non-blocking: does `docs/reporting-snippet.md` change?

**Recommendation: no — ship a separate `docs/reporting-snippet-remote.md` addendum.** The main
snippet is `@`-imported into `~/.claude/CLAUDE.md` and governs **every agent on every project
on this machine**; editing it to explain remote registration would push remote-mode
instructions at agents that will never use them. It is also served verbatim by the in-app
Setup section (`setupInfo()` → `renderSetup()`), so an addendum is the only change that does
not alter what every user sees in the Setup tab. Treat that file as **frozen** for this issue.

---

## §12 — FUTURE WAVE: implementation manifest and proposed tests

**Nothing in this section belongs to this wave.** It is the manifest the implementing wave
works from, recorded as prose so it does not create false conflict edges against workstreams
that will actually edit these files.

### New source

- **`src/hosted-server.ts`** — the entry. `openDb`, the §6 composition in exactly that order,
  `serve({ fetch, port, hostname })`, refuse-to-start without `AGENT_INBOX_TOKEN`, absolute
  static root or documented `WorkingDirectory`.
- **`src/auth.ts`** — `readToken`, `bearerGate` Hono middleware, `timingSafeEqualStr`, cookie
  helpers. Isolated so the local path provably never imports it.
- **`src/mcp-http.ts`** — `createMcpHttpHandler(db)`: the session map + transport factory,
  extracted so the entry stays thin and the map is unit-testable.

### Modified source

- **`src/mcp.ts`** — the presence/lifecycle block (`registerPresence`, `heartbeat`, the
  `setTimeout`/`setInterval`/`process.on('exit')`/SIGINT-SIGTERM lines) plus the `register` and
  `whoami` handlers (optional `agent`; `origins` on `whoami`). **Only these two handlers** —
  the construction-time seeding of §4 Gap 2 is what keeps the other eight `registerTool`
  callbacks at their current signature. Do not take the `extra`-threading path.
- **`src/scope.ts`** — `makeScope(cwd, opts?: { infer?, seed? })`, `override` gains `agent`,
  new `origins()`.
- **`src/mcp-server.ts`** — picks up the new `buildMcpServer` signature and **owns both**
  `process.on('exit', () => dispose())` and the SIGINT/SIGTERM loop (§3).
- **`src/viewer-server.ts`** — explicit `hostname` only, if §11.6 says yes.
- **`src/viewer.ts`** — **only** if `POST /api/items` lands there rather than in the hosted
  entry. Recommendation (§11.5) is that it does not, keeping `viewer.ts` local-only.
- **`package.json`** — a `serve:hosted` script. **No new dependency.** Bumping the SDK floor to
  `^1.29.0` is optional (`^1.12.0` already resolves to the installed 1.29.0) and, if done,
  rewrites **`package-lock.json`** — mention it so the diff is not a surprise.
- **`tsconfig.build.json`** needs **no** edit: it includes `src/**/*.ts`, so new `src` files are
  picked up automatically. Stated so nobody adds an entry.
- **`public/app.js` + `public/style.css`** — required **only** if the tight CSP is chosen over
  §9.4's first cut. Under the recommendation here, `public/` is untouched.
- **`electron/main.cjs`** — **explicitly DEFERRED, and named so the dependency is on record.**
  It hardcodes `URL_BASE`, imports `public/attention.js` and `public/badge.js`, and holds three
  uncredentialed fetches. Pointing the app at a remote inbox needs `AGENT_INBOX_URL` plus a
  header injector (`session.defaultSession.webRequest.onBeforeSendHeaders`) and is out of scope
  for the first cut.

### Docs

- `docs/reporting-snippet-remote.md` (**new** addendum — never an edit to
  `docs/reporting-snippet.md`, §11.7), `README.md` (Status + Project layout + a hosted
  section), `docs/INSTALL.md` (a hosted install path), `CLAUDE.md` (move #8 from Open backlog
  to Shipped).

### Proposed tests — all FUTURE WAVE

- **`test/mcp.http.test.ts`**
  - *"an MCP client over streamable-HTTP flags an item and register overrides its project"* —
    spawn `src/hosted-server.ts` with `AGENT_INBOX_DB=mkdtempSync(...)` and
    `AGENT_INBOX_TOKEN='t'`, connect a real `Client` over `StreamableHTTPClientTransport`
    (verified exported) with `{ requestInit: { headers: { Authorization: 'Bearer t' } } }`,
    `callTool` flag + register, assert against a real `openDb(dbPath)`. Mirrors
    `test/mcp.integration.test.ts`'s real-spawn discipline; never mocks the store.
  - *"a closed HTTP session ends its Live row and disposes its server"* — `DELETE /mcp`, then
    assert `listActivity(openDb(dbPath))` is empty **and the session map shrank**. (Do **not**
    name this "…and clears its heartbeat": §3.2 removes the heartbeat in HTTP mode, so there is
    nothing to clear and the name would promise coverage that cannot exist.)
  - *"a remote session that vanishes without DELETE falls out of listActivity"* — assert with
    `listActivity(db, { staleMinutes: 0 })` after a real few-millisecond sleep, so the cutoff
    equals *now* and `updated_at >= cutoff` is false. **Do not backdate `updated_at` with raw
    SQL in a test file** — `upsertActivity` and `touchActivity` both stamp *now* and
    `endActivity` only sets `ended_at`, so there is no exported path that writes an arbitrary
    `updated_at`, and reaching for `db.prepare('UPDATE activity SET updated_at = ?')` would put
    raw SQL outside `store.ts`. Note the argument order: `listActivity(db, { staleMinutes })` —
    `db` is the **first** parameter.
- **`test/auth.test.ts`** — *"the gate 401s a missing/wrong bearer and passes the right one"*;
  *"the gate is timing-safe on equal-length tokens"*.
- **`test/hosted.test.ts`**
  - *"hosted entry refuses to start without AGENT_INBOX_TOKEN"*.
  - *"no route is reachable without a credential, including static files"* — boot the
    **composed** app and assert `/`, `/app.js`, `/api/items`, `/api/boards` all 401 with no
    token and 200 with the bearer. **This is the gate-ordering test**, and it is what actually
    carries §7's weight.
  - *"responses carry the CSP and the explicit bind hostname"*.
  - *"hosted-server opens the db exactly once"* (source-text count of `openDb(`).
  - *"createViewer is never wrapped in auth on the local path"* — source-text assertion, in the
    style `test/hardening.test.ts` already uses: `src/viewer.ts` contains no import of
    `./auth.js` and no reference to `AGENT_INBOX_TOKEN`.
- **`test/scope.test.ts`** (extended) — *"with infer:false the scope never touches git and
  defaults to unknown"* (over a real git checkout path, proving a server-side checkout cannot
  leak into attribution); *"a header seed loses to a register override"*; *"register can set
  agent"*. Write them with **per-field `.toBe`**, matching the two existing cases, not a
  whole-object `toEqual`. The two existing cases stay green untouched.
- **`test/hardening.test.ts`** (extended) — *"no anchor href is built from agent-authored text
  in `public/app.js`"*, pinning today's verified-clean state so #30 cannot regress it silently.

### The gate on that wave

`fnm exec --using=24 -- npm test` green with **`test/viewer.test.ts` and
`test/mcp.integration.test.ts` unmodified**, plus `npm run typecheck` clean under
`noUncheckedIndexedAccess`. Any edit to either of those two files is evidence the hard
constraint was broken. (Necessary, not sufficient — §7.)

---

## §13 — Verification log

Everything asserted above as "verified" was executed against this checkout on 2026-07-26, not
inferred:

- SDK **1.29.0** installed; `package.json`'s `^1.12.0` already resolves to it. Runtime imports
  under Node 24 confirmed for `WebStandardStreamableHTTPServerTransport`,
  `isInitializeRequest` (`types.js`), and `StreamableHTTPClientTransport` +
  `StreamableHTTPError` (`client/streamableHttp.js`).
- `handleRequest(req, options?: { parsedBody?, authInfo? }): Promise<Response>`; the Hono
  docstring idiom is verbatim in the transport source; the options interface is exactly as
  §2 lists it, deprecated `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection`
  included. `this.sessionId = this.sessionIdGenerator?.()` is set inside `handleRequest`;
  `validateSession` is a private instance method that 400s a missing header and 404s a
  mismatch.
- `requireBearerAuth`, `hostHeaderValidation` and `localhostHostValidation` all return Express
  `RequestHandler` — both rejections in §5/§9.6 are correct.
- Hono behaviour, run locally: route-then-`use('*')` → **200 unauthenticated**;
  `use('*')`-then-route → 401; `new Hono()` + `use('*')` + `route('/', sub)` → 401.
  `await c.req.json()` then `c.req.raw.json()` → `TypeError: Body is unusable: Body has already
  been read`. `c.req.json()` on a bodyless GET → `SyntaxError: Unexpected end of JSON input`.
- `@hono/node-server` does `server.listen(options?.port ?? 3e3, options.hostname, …)` and,
  at verification time, `src/viewer-server.ts` passed no hostname. **§0 was real.**
- `grep -n href public/app.js` → **zero hits**; no `<a >` built anywhere; no inline `on*=`
  handlers in any `public/*.js`. Four inline `style=` attributes exist, in `needsRowEl`,
  `boardEl` (×2) and `itemCardEl`.
- `x-inbox-boot` is the only response header `createViewer` sets. No CSRF token on any of the
  seven write routes.
- `listActivity(db, opts)` defaults to `staleMinutes: 15`; `upsertActivity`/`touchActivity`
  stamp *now*; `endActivity` sets only `ended_at`. Indexes `idx_items_status_project`,
  `idx_boards_status_project`, `idx_activity_live` all exist.
- `claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"` verified
  against the installed CLI; `-H, --header <header...>` is variadic and repeats.
- All six `test/mcp.integration.test.ts` cases, the quoted `test/viewer.test.ts` cases, and the
  two `test/scope.test.ts` cases exist with the names used above; the scope cases use per-field
  `.toBe`.
- Baseline suite at the time of writing: **456 tests in 35 files, green.** This wave changes
  none of them.
