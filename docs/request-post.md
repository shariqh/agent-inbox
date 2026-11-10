# request-post through the publishing service's agent

Agent Inbox can send content requests (a blog post, an X thread or post, a LinkedIn post) to the
request-post agent that Shariq's private publishing service hosts (#500, mesh phase M2b). The
service validates and screens each request, files one queue row for it, and nothing publishes
without Shariq's approval. The design is
[`docs/superpowers/specs/2026-11-07-request-post-a2a-agent-design.md`](superpowers/specs/2026-11-07-request-post-a2a-agent-design.md);
the implementation notes are in [`docs/architecture/mesh.md`](architecture/mesh.md).

It is opt-in and off by default. Turn it on below, then call `<mesh dir>/bin/request-post`
(`file`, `status` or `wait`). Media uploads, repair and approval stay in-session.

## Turn it on (from a checkout)

Use Node 24 in every step (`fnm use 24`).

1. Build the root: `npm ci && npm run build`. Nothing else is built; the agent runs on the
   service, not this machine.
2. Get this device's bearer token from the service's runbook and save it in a file you own, for
   example with `umask 077`. The token is at least 32 printable characters on one line.
3. Preview, then apply:

   ```sh
   npm run meshctl -- enable --request-post --endpoint https://<name>.<tailnet>.ts.net --token-file <file>
   npm run meshctl -- enable --request-post --endpoint https://<name>.<tailnet>.ts.net --token-file <file> --apply
   ```

   This copies the token to `<mesh dir>/mesh/tokens/request-post` (0600), writes the shim
   `<mesh dir>/bin/request-post` and sets `agents.request-post` in `mesh.json`. `<mesh dir>` is
   `~/.agent-inbox` unless `AGENT_INBOX_MESH_DIR` (or `AGENT_INBOX_DB`) says otherwise. You can
   delete the file you passed afterwards.

The endpoint is the service's `tailscale serve` name on Shariq's personal tailnet,
`https://<name>.<tailnet>.ts.net` (a port only if the runbook gives one). When the service's host
is not on that tailnet and its SSH fallback is set, forward a local port with `ssh -L` and use
`http://127.0.0.1:<port>` instead. Nothing else is accepted: not a public host, an IP address or
plain `http` to another host. While this Mac is on a tailnet shared with others, calls fail by
design.

A tailnet name must be on this Mac's own tailnet (#557, the mesh design's §8.8): `enable` reads
the Mac's MagicDNS suffix from `tailscale status --json` and refuses a name on another tailnet or
a public Funnel host, which has the same name shape and a valid certificate. When the suffix
cannot be read (Tailscale not installed, stopped or logged out) it refuses every tailnet name;
the SSH fallback's loopback form never needs it. Every call checks again before it sends the
token. When this Mac is not on the endpoint's tailnet (it switched to another account, or the
entry was written before this check or by hand), nothing is sent and the call is unavailable
(exit 15), so `wait` keeps polling: switch back, or run `enable` again with the service's name on
this Mac's tailnet.

To use a new token from the runbook, run the same `enable` command with the new file.
`npm run meshctl -- status` shows a `Request-post:` line: on and the endpoint, or off, and
whether the token and shim exist. It never prints the token.

## Turn it off

```sh
npm run meshctl -- disable --request-post
npm run meshctl -- disable --request-post --apply
```

This removes `agents.request-post` from `mesh.json` (keeping a backup; the file is deleted when
nothing else is left in it), the shim and the token copy. Ask the service's runbook owner to
revoke the device's token too. Its run records stay; add `--purge` to delete them as well (below).
`disable --apply` alone turns every mesh piece off.

## Call it

`<mesh dir>/bin/request-post` runs `meshctl request-post` with your arguments. It never reads the
terminal and never asks anything; the brief comes on stdin or from `--brief-file`.

```sh
# file one request; the brief is the row's context (at most 8 KiB of UTF-8)
<mesh dir>/bin/request-post file --brand <brand> --channels blog --title "…" --category <c> --slug <s> < brief.md
<mesh dir>/bin/request-post file --brand <brand> --channels x-thread,linkedin --title "…" [--source-url https://…] < brief.md
# read one request and its drafts, by request key or page id
<mesh dir>/bin/request-post status --key <key>
# wait (in the background) until it needs Shariq or ends; --through-go follows a blog request past the go
<mesh dir>/bin/request-post wait --key <key> [--through-go]
```

- **The key.** `file` always computes the request key from the brand, the sorted channels and
  the slug (blog), else the source URL, else the normalised title, and sends it; the brief is
  not part of it. Running the same command again, with the brief rewritten or not, finds the
  same row instead of filing a second one. `--key <k>` replaces the key, only for a deliberate
  second request about the same thing; the request then carries `keyOverride: true` beside
  `idempotencyKey` in the extension metadata, which is the only way the service accepts a key
  that is not the derived one (without it the request is refused, exit 11, naming
  `idempotencyKey`). Without `--key`, `keyOverride` is never sent. The key is in the JSON as
  `requestKey`.
- **The output.** On exit 0 stdout holds the result as JSON: for `file`, `created`, `pageId`,
  `url`, `requestKey`, `brand`, `channels`, `phase` and `readBack`; for `status` and `wait`, the
  snapshot (`phase`, `status`, `drafts`, `prUrl`, `error`, `humanAction`, `final`). stderr gets
  one line saying what happened. `--report <file>` also writes the data part of every answer that
  has one, exit 0 or not, and `{ "code": <exit> }` on an exit without one (mode 0600, never
  through a symlink), so an old report never survives a new run.
- **`wait`** reads the status every 2 minutes for 30 minutes, then every 15, and exits 0 with the
  snapshot when the phase is `awaiting-go`, `ready-for-human`, `proposed`, `needs-fix`, `failed`,
  `rejected` or `published` (with `--through-go`, `awaiting-go` is not final). It prints a line
  when the phase changes and is silent otherwise. Busy answers and failures (an HTTP 5xx, a cut
  answer, the service unreachable during a redeploy) are retried with backoff; only 30 minutes of
  failure in a row exits 15. Each run ends after 4 hours with 124: run it again if it still
  matters. Copilot CLI launches it as a detached async command; Claude Code as a background
  shell task.

| Exit | Meaning | What the caller does |
|---|---|---|
| 0 | Filed and read back, or already filed (`created: false`); for `status` and `wait`, the snapshot | Report the row. For blog, say it waits for Shariq's go |
| 11 | Refused: the named fields (with the allowed values) or the screen's classes | Fix the named fields, or ask the user, and send again |
| 12 | Busy: a rate limit, the filing lock or the daily budget | Try again after the time it gives |
| 13 | Outcome unknown: sent, then cut off, timed out, failed or answered with a redirect on the call | Run the same command once more (the key makes it safe) or `status --key`; never file it in-session |
| 14 | Off: no `agents.request-post`, or the device token is missing | The in-session path is fine |
| 15 | Unavailable: DNS, TLS, refused, a redirect on the card, a refused token, a card that does not match ("update agent-inbox or the service"), or this Mac not on the endpoint's tailnet or its tailnet unreadable; nothing was filed | Retry once, then report to the user; no in-session filing |
| 16 | Conflict: another row already covers this | Report that row; never change the slug, title or channels to get around it |
| 124 | `wait` ran 4 hours without a final phase | Run the same `wait` again if it still matters |
| 4 | Usage, a terminal on stdin, or an unreadable `--brief-file` | Fix the command |

stdout is empty on every exit but 0. **These codes are request-post's own.** They share numbers
with [unslop's](unslop.md) but not meanings: unslop's 13 means failed, its 14 also covers an
unreachable agent and a card mismatch, and it has no 15 or 16.

While this machine is on a tailnet shared with others, the service's name does not resolve or
refuses the device: exit 15, by design.

## What this Mac keeps

The meshctl entry that runs the command appends one line per call to
`<mesh dir>/mesh/runs/request-post-<date>.jsonl` (a 0700 folder, 0600 files, the date of the call's
end). A line is written once the command has read the agent's switch in `mesh.json` and found it
on, whatever the exit, and also when the call is killed by `SIGTERM`, `SIGHUP` or Ctrl-C
(`interrupted`). A call that ends before that (a usage error, or input refused on the Mac), a call
while the agent is off and `kill -9` write nothing. Writing never changes the exit code, stdout or
stderr.

Each line holds the end time, the duration, the subcommand (`file`, `status` or `wait`), the
exit code and an outcome word, plus the answer's fixed facts: its phase (for an interrupted
`wait`, the last phase it saw), `created`, `--through-go`, the reason, the screen's classes and
the names of refused fields. The brand and channels are kept only on exit 0, so a refused brand
(perhaps a typo or a name) is never kept.

It never holds the brief, the title, the slug, the source URL, the category, the page URL or id,
any request key (yours from `--key` or the derived one), `humanAction` or error text from the
service, or the token, or anything about who called. Records older than 30 days are deleted by
the next call on a later day, or by the next `meshctl enable` or `disable`. To delete them now:

```sh
npm run meshctl -- forget-runs --request-post           # preview
npm run meshctl -- forget-runs --request-post --apply
```

`disable --request-post --purge` deletes them too. A later Agent Inbox shows them in the agent's Run
history; nothing reads them today.

## The caller's `SKILL.md`

The private request-post skill keeps the brief guidance (audience, angle, facts, exclusions, call
to action; only material Shariq would publish) and routes with this text:

> Run `<mesh dir>/bin/request-post file --brand … --channels … --title … [--category … --slug …] < brief.md`.
> **0:** report the row; for blog, say it awaits Shariq's go (follow it with `wait --through-go --key <key>`).
> **11:** fix the named fields or ask the user. **12:** wait the seconds the stderr line gives ("try again in about N s"), then send again.
> **13:** run the same command once more (the key makes it safe) or `status --key`; never file in-session.
> **16:** report the existing row; never change fields to get around it.
> **15:** retry once, then report to the user; no in-session filing.
> **14:** the agent is off; the in-session path is fine on the Mac.
> Monitoring uses `status` and `wait`; repair is in-session. Ready is not approval: at
> `awaiting-go`, `ready-for-human` or `proposed`, report `humanAction` and stop.
