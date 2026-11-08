# request-post through the publishing service's agent

Agent Inbox can send content requests (a blog post, an X thread or post, a LinkedIn post) to the
request-post agent that Shariq's private publishing service hosts (#500, mesh phase M2b). The
service validates and screens each request, files one queue row for it, and nothing publishes
without Shariq's approval. The design is
[`docs/superpowers/specs/2026-11-07-request-post-a2a-agent-design.md`](superpowers/specs/2026-11-07-request-post-a2a-agent-design.md);
the implementation notes are in [`docs/architecture/mesh.md`](architecture/mesh.md).

It is opt-in and off by default. **This page is a stub:** turning the client on and off has
landed (R2), but the `request-post` command itself (`file`, `status`, `wait`), its exit codes and
the text callers follow arrive with R3. Until then `<mesh dir>/bin/request-post` exits 14, and
requests are filed in-session.

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
revoke the device's token too. `disable --apply` alone turns every mesh piece off.
