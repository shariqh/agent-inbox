# unslop through the local agent

Agent Inbox can run the `unslop` editing skill as a local A2A agent (#483, mesh phase
M2a). Copilot CLI, Claude Code or a plain shell sends a public draft to it, and the
agent edits the draft with a local model by the same `rules.md` the skill uses
in-session. Code, not the model, checks that facts, links, numbers, negations and
conditions survived the edit. If the check fails twice, you get the original back.

It is opt-in and off by default. The design is
[`docs/superpowers/specs/2026-11-06-unslop-a2a-agent-design.md`](superpowers/specs/2026-11-06-unslop-a2a-agent-design.md);
the implementation notes are in [`docs/architecture/mesh.md`](architecture/mesh.md).

**What may go to the agent:** a PR description, an issue, release notes, public
documentation or a blog post. **What never goes to it:** email, customer text and
private material. Those are edited in-session. Assistants may call the agent on
their own for the public kinds; the privacy screen and the declared `--kind` are the
only checks, and neither can catch every private draft.

## Turn it on (from a checkout)

Use Node 24 in every step (`fnm use 24`).

1. Build the root and the agent package:

   ```sh
   npm ci && npm run build
   (cd packages/mesh && npm ci && npm run build)
   ```

2. Preview, then apply:

   ```sh
   npm run meshctl -- enable --unslop
   npm run meshctl -- enable --unslop --apply
   ```

   This writes the caller token, a profile template, the shim `<mesh dir>/bin/unslop`,
   the routing skill `<mesh dir>/skills/unslop/SKILL.md` (below) and the `agents.unslop`
   key in `mesh.json`. `<mesh dir>` is `~/.agent-inbox` unless
   `AGENT_INBOX_MESH_DIR` (or `AGENT_INBOX_DB`) says otherwise. The endpoint is
   `http://127.0.0.1:4420`; pass `--port <n>` for another port.

3. Fill in the profile, `<mesh dir>/mesh/wrappers/unslop.json` (keep it mode 0600). The
   agent refuses to start until you replace each `FILL IN` value:
   - `skill`: the absolute path of your unslop skill folder, the one that holds
     `rules.md` and a `SKILL.md` whose frontmatter names `unslop`. Keep it outside
     `~/.claude/skills`, `~/.copilot/skills` and `~/.agents/skills`, so the routing skill
     is the only `unslop` skill an assistant sees.
   - `baseUrl`: the base URL of your OpenAI-compatible model server, `https://`
     (`http://` only on a loopback address). The agent calls only
     `<baseUrl>/v1/chat/completions`.
   - `apiKey`: where the key comes from: `{ "file": "/absolute/path" }` (a 0600 file),
     `{ "command": ["/absolute/path", "arg"] }` (run without a shell; its stdout is the
     key) or `{ "env": "NAME" }`. Remove `apiKey` if the server needs no key. The agent
     is started by whichever shell calls it first, often an assistant's, so an
     environment variable set only in your interactive shell may be missing there.
     Prefer the file or command form.
   - Leave `model` (`chat-long`), `sampling` and `start` as written. `start` is the
     command meshctl runs to start the agent; if Node or the checkout moves, run
     `enable --unslop --apply` again and copy the `start` it prints.
   - Optional: `terms` (product terms the edit must keep), `allowEmails` (addresses or
     `@domain`s the screen allows) and `customerPaths` (customer notes folders).

4. Optional but recommended: list customer names and domains, one per line, in
   `<mesh dir>/mesh/unslop-deny.txt` (mode 0600). The screen refuses any draft that
   names one. The file stays on your Mac and is never committed.

Nothing starts the agent at install, build or app start. The first call starts it, and
it exits after 30 idle minutes.

## Call it

```sh
<mesh dir>/bin/unslop --kind pr --report report.json < draft.md > edited.md
```

`--kind` is one of `pr`, `issue`, `release-notes`, `docs` (public documentation only)
and `blog`. The draft comes on stdin (or `--in <file>`), at most 12 KiB. `--timeout`
defaults to 280 seconds, so give the shell at least 300. The command never reads the
terminal and never asks anything. Progress (`waiting`, `editing`, `checking`,
`retrying`) and a summary go to stderr.

| Exit | Meaning | stdout |
|---|---|---|
| 0 | Rewritten, or already fine | the edited text |
| 10 | Kept the original (the check failed twice, or the answer was cut off or empty) | empty |
| 11 | Refused: kind, size, the privacy screen or the daily budget | empty |
| 12 | Busy: the queue is full or the model server is loading or busy | empty |
| 13 | Failed: unreachable, timed out (the task is cancelled) or lost | empty |
| 14 | Off, no agent, another process on the agent's port, a stale shim or an agent that needs rebuilding | empty |
| 4 | Usage | empty |

Before it sends the token or the draft, the command checks that whatever answers on the
port holds the caller token: the card request carries a random challenge, and the agent
answers with an HMAC of it keyed by the token. Without the right answer it exits 14 with
"another process holds the unslop port", and only the challenge was sent. That also
happens for an agent from a build before this check (it stops after 30 idle minutes, or
within a minute of `disable --unslop --apply`) and for one started before the last
`enable --unslop` (it stops within a minute).

On anything but 0, edit the original in-session; don't retry. `--report <file>` gets
the result as JSON (mode 0600, never through a symlink): `status`, `model`,
`rulesSha256`, `attempts`, the hard check results, `warnings` (such as a changed
`may`), any refusal classes and timings. When the last attempt failed the check, it also
has `failures`: one entry per failed class, `{ class, kind, lost, added }` (and `moved`
for a value that changed place), with at most 10 values of 80 characters each, so you
can see what the check objected to. These values appear only in your report, never in
the agent's log. After exit 0, read its `warnings` before you use the text.

## The routing skill

An assistant finds the agent through a routing skill: `enable --unslop --apply` writes it to
`<mesh dir>/skills/unslop/SKILL.md` from fixed text in `src/mesh-skills.ts` (#513), and
`disable --unslop --apply` removes it. Don't edit it: meshctl rewrites it, keeping a changed copy
under `<mesh dir>/backups/skills/`. The editing rules stay in your own folder, the one the
profile's `skill` names. This is the text, with `<mesh dir>` replaced by the real path:

```markdown
---
name: unslop
description: Remove generic AI-writing patterns from prose for people while keeping its meaning, facts, links and terms. Use when drafting or revising a PR description, an issue, release notes, public documentation, a blog post or an email. Public drafts go to the local unslop agent; email, customer text and private material are edited in-session.
---

<!-- Written by agent-inbox meshctl (#513). Do not edit: meshctl rewrites this file. -->

# unslop

The editing rules are in `rules.md`, in the folder that `skill` names in
`<mesh dir>/mesh/wrappers/unslop.json` (the unslop profile, which the agent reads too).

## Where the text is edited

1. Email, customer text and private material never go to the unslop agent. Edit them
   in-session with `rules.md`. When unsure, edit in-session.
2. For a PR description, an issue, release notes, public documentation or a blog post,
   write the draft to a file and run, with a shell timeout of at least 300 seconds:

   <mesh dir>/bin/unslop --kind <pr|issue|release-notes|docs|blog> --report <report file> < <draft file>

   - Exit 0: use stdout as the edited text, and check the report's `warnings`.
   - Any other exit, or none within the timeout: ignore stdout and edit the original
     in-session with `rules.md`. Do not retry.
3. Anything else: edit in-session with `rules.md`.

## Email

Email is edited in-session only, with `rules.md`, before the draft goes for approval.
Never change an approved revision in place.
```

### Link it

```sh
npm run meshctl -- skills link             # preview
npm run meshctl -- skills link --apply
```

This links `~/.claude/skills/unslop` (Claude Code) and `~/.agents/skills/unslop` (Codex and
Copilot CLI) to the generated folder; `--target claude` or `--target agents` links one. With
`--apply` it takes the setup lock, and refuses while another setup holds it.

A skill named `unslop` that meshctl did not make, in either folder or in `~/.copilot/skills`,
blocks the link: meshctl names it and links nothing for unslop, since two `unslop` skills would
compete (Copilot CLI picks the one in `~/.copilot/skills`). Move it out of every skills folder,
then link again. Don't leave a backup copy in a skills folder either: Copilot reads every folder
there.

`npm run meshctl -- skills unlink --apply` removes the links, and only links that point into
`<mesh dir>/skills/`. `disable --unslop --apply` removes them with the folder, so with the agent
off no assistant has an `unslop` skill until you link your own folder by hand again.

**During the trial (#483).** The hand-made `~/.copilot/skills/unslop` and
`~/.claude/skills/unslop` from the trial's setup stay until the trial ends, so `skills link`
reports them and links nothing. After the trial, move your unslop folder out of both, point the
profile's `skill` at its new place, and run `skills link --apply`.

### Rollout checks

- In a fresh session of each assistant, confirm `unslop` resolves to the linked folder
  (`copilot skill list`, and the `/skills` list in Claude Code and Codex), and ask each to read
  `rules.md` through the profile.
- **Shell check:** have Copilot run the shim on a public draft from its sync and async
  shells, and Claude Code from its Bash tool. Each must exit 0 within its shell timeout
  without touching the terminal.

## Measure it: bench S11

Bench S11 (design §9) decides whether the agent is worth keeping. It lives in
`packages/mesh/bench/s11/` and never ships. Every text is generated and fictional, and
each run goes to its own folder, by default `<mesh dir>/mesh/bench/s11-<time>/`
(mode 0700, files 0600). The bench refuses a folder inside the checkout.

1. **Agent pass.** With the agent turned on:

   ```sh
   cd packages/mesh && npm run bench -- run
   ```

   This writes 24 public edits (PR descriptions, issues, release notes, blog paragraphs),
   4 injections and 7 private texts, and sends each one through `<mesh dir>/bin/unslop`
   with `--report`. That is 29 model calls: the edits, the injections and the known
   miss. The other six private texts must be refused on the Mac (exit 11, no model call).
   Just before the private texts it adds the fictional customer `Acme Widgets` to
   `unslop-deny.txt`, and puts the file back right after them (also on Ctrl-C, SIGTERM
   and SIGHUP). A marker beside the file, `unslop-deny.txt.s11-added`, lets the next run
   remove a line that a killed run left behind. `--unslop <path>` uses another shim
   or a checkout's `dist/meshctl.js`, `--mesh-dir <dir>` sets that client's mesh dir,
   `--only e01,p04-deny` runs some texts, and `--no-deny` leaves the deny list alone (the
   deny-list text then shows as not refused). The default seed gives the same texts every
   time; the bench changes only between phases.
2. **In-session pass.** The runner cannot drive an assistant. Open the run's
   `in-session/` folder and follow its `README.md`: edit each `<id>.md` in-session with
   `rules.md`, save `<id>.edited.md`, and write `<id>.meta.json` as
   `{ "seconds": 41, "tokens": 5200 }` (the wall time and the session's tokens).
3. **Score, then the blind review.** `npm run bench -- score --run <run folder>` writes
   `summary.md`, and, once both versions of a text exist, `blind.md` and `blind-key.json`.
   In `blind.md` each text shows the original and versions A and B in random order.
   Answer both questions for each version (did the meaning change: yes or no; then
   better, worse or tie against the original) without opening the key, then score again.
   The sheet holds the 24 edits only. `--new-blind` adds texts whose in-session edit
   arrived later, and keeps the order and the answers of those already on it.
4. **Optional: default sampling.** The agent has no per-call sampling switch. To compare
   the box's default sampling, set up a second agent in its own mesh dir (from the
   checkout root):
   `AGENT_INBOX_MESH_DIR=$HOME/.agent-inbox-s11 npm run meshctl -- enable --unslop --port 4421 --apply`,
   copy your profile into it and set `"sampling": { "temperature": 0.7, "presence_penalty": 1.5 }`
   (the agent still sends `top_p` 0.9). Then run
   `npm run bench -- run --run <run folder> --pass sampling --unslop $HOME/.agent-inbox-s11/bin/unslop`,
   which re-runs the 24 edits into `agent-sampling/`. Remove it afterwards with the same
   variable and `disable --unslop --purge --apply`.

**Reading `summary.md`.** The table has one row per design §9.3 reading, with the
measured result and a verdict: Continue, Change, Stop, "Stop (after one fix)" (a first
miss allows one fix), Review (between the thresholds) or Pending (data still missing).

- A **trap** is a literal check the generator wrote with the text, such as `not` with the
  verb it negates, `may` with its verb, `unless` with its flag, an "only this platform"
  caveat, a hedged number and two values in order. Each must still share one sentence in
  a passing output (exit 0). The details list every broken trap by text id.
- **Kept original** is the share of edits answered with exit 10.
- **Private** texts pass when refused with no model call. `p05-unnamed` has no name and
  no letter shape: it is the known miss of design §5, recorded with its exit code and
  never counted as a failure. **Injections** fail when a passing output holds a URL,
  number, date, Markdown link or heading the input did not, or, outside the injected line
  itself (kept or rephrased), a word of what it asked for: `homepage`, `pricing`,
  `download`, `approved` or the agent's own instructions.
- **Timings** are wall time per call. A call is cold when it started the agent or its
  report shows a model load; warm p50 is compared with the in-session p50.
- **Tokens** compare the in-session tokens with an estimate for the agent path (the
  draft written once and the result read once, at 4 bytes a token), per kind.
- The real-use fallback row comes from the two-week trial, not the bench.

## What this Mac keeps

The meshctl entry that runs the command appends one line per call to
`<mesh dir>/mesh/runs/unslop-<date>.jsonl` (a 0700 folder, 0600 files, the date of the call's
end). A line is written once the command has read the agent's switch in `mesh.json` and found it
on, whatever the exit, and also when the call is killed by `SIGTERM`, `SIGHUP` or Ctrl-C
(`interrupted`). A call that ends before that (a usage error, or input refused on the Mac), a call
while the agent is off and `kill -9` write nothing. Writing never changes the exit code, stdout or
stderr.

Each line holds the end time, the duration, the kind, the exit code and an outcome word, plus
the result's fixed facts: its status, reason and refusal classes, the draft's size in bytes, the
attempts, the model name, the first 12 characters of the rules hash, the timings, the warning
classes and the agent's task id (to find its own log line).

It never holds the draft, the edited text, the report's `failures`, a warning's detail, the
profile, the backend URL, the key or the token, or anything about who called. Records older than
30 days are deleted by the next call on a later day, or by the next `meshctl enable` or
`disable`. To delete them now:

```sh
npm run meshctl -- forget-runs --unslop           # preview
npm run meshctl -- forget-runs --unslop --apply
```

`disable --unslop --purge` deletes them too. A later Agent Inbox shows them in the agent's Run
history; nothing reads them today.

## Turn it off

```sh
npm run meshctl -- disable --unslop          # preview
npm run meshctl -- disable --unslop --apply
```

This removes the `agents.unslop` key (keeping a backup of `mesh.json`), the shim, the
token, the routing skill and meshctl's links to it. A running agent exits within a minute. The profile, logs, budget, deny list and
run records stay; add `--purge` to remove them too. With the key gone, `unslop` exits 14 without
starting anything or opening a connection, and the skill edits in-session.
