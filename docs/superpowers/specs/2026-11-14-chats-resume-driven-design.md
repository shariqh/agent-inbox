# Design: continue a listed chat as a driven session (#586 phase 2)

Status: proposed on 2026-11-14, not built. It builds on phase 1: the chat index on main
(`docs/architecture/chats.md`) and the Chats tab with Resume in Terminal and Copy resume, which
are on their own branch and must land first. §7 holds the owner's open questions.

## §0 Summary

Phase 2 of #586 lets a person take a Copilot CLI chat from the Chats tab and carry it on as a
session Agent Inbox drives, in the chat's own folder, behind the driven-sessions switch and main's
own confirmation (#412). The row gets one more control, **Continue here…**. It opens a small
dialog for a mode and a first message. Main checks the chat again and shows its native
confirmation. The driver then loads the chat with ACP `session/load` and sends the message as the
first turn. The session shows as an ordinary launch card in the Dashboard's Working lane, and the
chat's row then offers **Show session**.

What the code shows, before the design:

- **The load path exists, but only for sessions the driver made itself.** `Driver` takes
  `loadSessionId` and sends `session/load` in `onSetupResponse` (`src/driver.ts`), and
  `driver-cli.ts` `run` passes it only for a `resume` spec, from a launch row that
  `resumeLaunch` (`src/store.ts`) moved from parked or stopped. Nobody has checked whether Copilot
  loads a session that the terminal CLI created. Take over (`docs/architecture/driven-sessions.md`,
  "Step 5, part 1") checked the other direction, from ACP to `copilot --resume`. So the first
  build step is that check, and it can stop this design (§5, PR 2).
- **The resume path is wrong for a chat in three ways.** A load that answers `-32002` starts a
  fresh `session/new` and sends the stored task (`onSetupResponse`), and a fresh session is not
  the chat. A loaded session sends no first prompt, because `taskSent` starts true when
  `loadSessionId` is set (the `Driver` constructor). A failed load parks the launch (`closeRow` in
  `driver-cli.ts` `run`), which assumes a launch the person has already run here.
- **No spec carries a chat id.** `parseLaunchSpec` (`src/launch-spec.ts`) has two kinds, each
  with exact keys. `new` has no session field, and `resume` takes its facts from an existing row.
- **The index and the driver can look in different folders.** `createChatIndex`
  (`src/chat-index.ts`) reads `<home>/.copilot/session-state` and ignores `COPILOT_HOME`. The
  driven Copilot keeps `COPILOT_HOME` from the login shell (`childEnv`, `src/driver-policy.ts`).
- **Nothing links a chat to a launch.** `/api/chats` entries carry no launch, and `launchView`
  (`src/store.ts`) serves no ACP session. The Chats tab's "Show session is left out" note on the
  phase 1 branch says the same.
- **A loaded session with no prompt is idle.** It would sit in the Quiet lane, not Working. That
  is one reason the first message is part of the request (§3.3).

## §1 What is wrong today

- A Copilot chat can be continued only in a terminal (Resume, Copy resume). Its approvals,
  messages and transcript then stay out of Agent Inbox.
- A driven session can only be started fresh (New session) or resumed from its own launch row.
  The work and context of a chat that began in a terminal cannot be handed to the app.
- The Chats tab cannot say which chat is the session on a card, so a live chat's row has no link.

## §2 Goals, non-goals, anti-goals

Goals:

1. Continue a listed, eligible Copilot CLI chat as a driven session, with its history, in its own
   folder, from the Chats tab.
2. Ask for the same consent as New session: the switch, the `launch` grant and main's own
   confirmation, which shows what will be sent.
3. Never run one chat twice, whether from the app, the app and a terminal, or two clicks.
4. Link a chat to its launch, so the row reads Live and offers Show session.
5. Change nothing with the driven-sessions switch off.

Non-goals:

- Claude Code chats. They follow when driven Claude sessions exist (#475).
- Cloud or remote Copilot sessions (`mc_task_id`), as in #586.
- Choosing another folder for a chat whose folder moved or is gone.
- A worktree for a continued chat (§3.2).
- Model, reasoning effort and budget fields in the dialog. A continued chat runs on Copilot's
  default model with no budget limit (#479's default). Resume with more budget… does not apply.
- A link for a chat that is live in a terminal rather than driven here (§3.6).

Anti-goals: a second confirmation surface that differs from main's; a path, argv or env sent by
the page; a fresh session presented as the chat; a chat driven while a terminal holds it.

## §3 The design

### 3.1 Which chats can be continued

Decision: **Copilot CLI chats only**, and only when all of these hold:

| Rule | Checked by | Why |
|---|---|---|
| `tool` is `copilot` | page, main | Claude has no driven sessions yet (#475) |
| the id is a lowercase UUID | page, main, the spec | `isChatId` (`src/chat-parse.ts`); the id becomes a path segment and an ACP parameter |
| the index lists it | main (§3.7) | main never trusts the page's copy |
| not live in another process | main, then the driver | a Copilot holding `inuse.<pid>.lock` owns the session |
| no launch of this app is running, parked or stopped with its session | main, the store | one launch per chat (§3.6) |
| `hidden` holds none of `empty`, `non-interactive`, `folder-gone` | page, main | nothing to load, a one-shot or app-made run, or nowhere to run it |
| no `mc_task_id` key in `workspace.yaml` | main, through the lookup route (§3.7) | cloud and remote sessions are a non-goal |
| the folder is a directory now, its path free of control characters | main (`realDirectory`), the driver | the session runs there |

`temp` is not a refusal. It is only a list filter, and a chat in `/tmp` loads like any other.

Rejected: allowing `non-interactive` chats. That reason covers `agent-inbox-driver`'s own sessions,
which belong to launch rows and resume from their cards, and other clients whose sessions nobody
here has tested. Also rejected: allowing `mc_task_id` chats that hold a local `events.jsonl`. 19
such chats on the author's Mac are ordinary `github/cli` chats (`chats.md`, "Hidden by default"),
but how `session/load` treats them is unknown. Refusing them costs little, because Resume in
Terminal still offers them. PR 2 may relax this rule if it shows they load like any other chat.

What a row shows when the chat is not eligible: Continue here… is `aria-disabled` with the reason
in its `title`, as Resume does on the phase 1 branch:

- live: "This chat is live in another process, so it is not continued a second time."
- `folder-gone`: "Its folder no longer exists."
- `empty`: "Nothing was ever said in this chat."
- `non-interactive`: "This was not an interactive chat."

The page cannot see `mc_task_id`. Main refuses such a chat, and the refusal shows in the row's
note (§3.5). Claude Code rows get no Continue here… control at all, so the row is not crowded with
a control that is always off.

### 3.2 Where it runs

Decision: **in the chat's own folder**: the index's `cwd`, resolved by main's `realDirectory`
(`electron/main.cjs`, `realpathSync.native`) and again by the driver (`realpathSync`, as `run` does
for a `new` spec). There is **no worktree**, unlike every New session launch since #432.

Why: the chat's history names files by their paths in that folder, and a loaded session acts on
what its history says. In a worktree the agent would still read and edit those paths, so the
worktree would only look like isolation. It would also lack the uncommitted state the chat may be
about, and Edits' allow rule would cover the wrong folder. Rejected: a worktree made from the
folder's last commit (the #432 rule), for those reasons.

What it risks, and what the design does about it:

- **The person's own uncommitted work.** The agent changes files where the person works. Only
  **Ask for everything** and **Read-only** are offered (owner question 1), so each tool call asks
  first, except tools the person's own Copilot settings already allow (`MODES.ask.copy`,
  `electron/launch-controller.cjs`). The confirmation says it works in the folder itself.
- **Another session in the folder.** A terminal Claude Code or Copilot, or another launch, may
  work there too. Main warns and does not refuse, because an idle terminal is common and harmless.
  The warning counts the running launches whose `cwd` is the folder (as `start` already computes
  `shared`) and the live chats in `/api/chats` with that `cwd`.
- **A folder that is not a repository.** This is allowed, with a line in the confirmation saying
  git cannot show or undo the changes. Main runs no git. It looks for a `.git` folder or file at
  the folder and up to 10 levels above it, the walk the index uses for origins (`chats.md`,
  "Project").

### 3.3 How it runs

The path, end to end:

1. The page sends `continueChat({ tool, id, mode, prompt, startId })` (§3.5).
2. Main checks the chat (§3.7), shows its confirmation (§3.4), captures the login-shell env in the
   folder, and refuses when that env's `COPILOT_HOME` does not resolve to the folder the index read
   (`<home>/.copilot`). Copilot would not find the chat there.
3. Main spawns the driver through the existing `spawnDriver` with a new spec kind:
   `{ v: 1, kind: 'chat', launchId, host: 'copilot', chatId, cwd, mode, prompt, env, launchKey, maxDrivers? }`.
4. The driver's `run` claims a slot (`claimDriverSlot`), checks the chat is not live (below), writes
   the row with `createLaunch` (with `chat_id` and `acp_session` set to the chat id; no worktree; both
   budgets `null`), and spawns Copilot with `copilotArgs` as usual.
5. `Driver` sends `initialize`. It refuses to go on when the result's `agentCapabilities.loadSession`
   is not `true`. It then sends `session/load` with the chat id and the folder, ignores the replayed
   history (as today), sets and verifies the mode and `allow_all` (as today), and then sends the
   message as the first turn.

What changes, by file:

- **`src/launch-spec.ts`.** Add the `chat` kind: exact keys, `chatId` a lowercase UUID, `mode`
  `ask` or `read-only`, and `prompt` 1 to 65,536 characters. `LAUNCH_SPEC_VERSION` stays 1. An
  older driver refuses the unknown kind ("kind must be new or resume", exit 65), so it fails
  closed, as #432's `worktree` field and #451's `raise` did.
- **`src/driver.ts`.** Add one option, `chat: true`. With it, a load does not mark the task as
  sent, so `maybePrompt` sends the prompt after the load. A `-32002` answer ends the launch with
  `error:load` and the failure "Copilot has no chat with this id." and never falls back to
  `session/new`. A load error ends the same way, with Copilot's message (sanitized with
  `terminalSafe`, at most 300 characters, as `loadError` is today). A missing `loadSession`
  capability ends it too. `startFailure()` returns each of these, so the row reads "Didn't start:
  …" (#432 PR 5).
- **`src/driver-policy.ts`.** Add `chatPrompt(text)`: "The human continued this chat via Agent Inbox
  and says:\n\n" plus the text. It follows `firstPrompt`'s framing, so the text can never begin a
  turn with `/` (`promptSafe`).
- **`src/driver-cli.ts` `run`.**
  - The `chat` branch follows the `new` branch without a worktree.
  - Before `createLaunch`, it lists `<COPILOT_HOME or $HOME/.copilot>/session-state/<chatId>/`
    with `lstat` only. It refuses when an `inuse.<pid>.lock` there has a live pid, using
    `lockPid` (`src/chat-parse.ts`, which is pure) and the index's liveness rule. That narrows the
    race between main's check and Copilot taking its own lock.
  - `closeRow` ends a `chat` launch's first start on `error:load` with `end_detail`, instead of
    parking it, since there is nothing here to retry. The chat stays in the Chats tab, and
    Continue here… is offered again.
  - A later resume of a parked chat launch is an ordinary `resume` spec. It passes `chat: true`
    when the row has a `chat_id`, so `-32002` ends the launch and never starts a fresh session.
- **`src/store.ts`.** Add a `chat_id` column (§3.6) and the unique index. `createLaunch` writes
  both columns.
- **`electron/launch-controller.cjs`.** Add `chatRequest` (exact keys, like `launchRequest`),
  `continueChat` and `chatConfirmation`. Change `resume`: for a launch with a `chat_id`, it
  re-reads the chat (§3.7) and refuses when a terminal now holds it live ("This chat is live in
  another process.").
- **`electron/launch-ipc.cjs`.** Add `continueChat: 'continue-chat'` to the one-argument channels,
  behind the `launch` grant. `electron/setup-preload.cjs` adds `agentInboxLaunch.continueChat`,
  which checks the shape.

Main's own checks run before any of this (§3.7). The table says what the person sees when the
driver or Copilot fails. Each failure after the spawn leaves a launch card that reads "Didn't
start: …" with its transcript, and the dialog's progress line shows the same text:

| Failure | What the person sees |
|---|---|
| Copilot does not know the id (`-32002`) | "Didn't start: Copilot has no chat with this id. If your shell sets COPILOT_HOME, Copilot looks there." |
| `session/load` refused for another reason | "Didn't start: Copilot could not load the chat: <its message>" |
| this Copilot does not offer `loadSession` | "Didn't start: this Copilot cannot load chats over ACP. Update Copilot CLI." |
| the runtime's driver predates the `chat` kind | main maps exit 65 with "kind must be new or resume" to "This Agent Inbox runtime is older than the app. Update agents in Setup." No row is written. |
| the load works but the folder is not the chat's folder | Main and the driver both pass the index's `cwd`, so this happens only if the folder was replaced between the check and the spawn. The driver's `realpathSync` then refuses with "<folder> is not a folder" before Copilot starts. A chat whose folder moved is `folder-gone` and is refused before the dialog. |
| Copilot refuses the model's effort on load | not known yet (PR 2). If it happens, `effortFallback` is extended to a chat launch's first load, which has run nothing. |

### 3.4 Gate and consent

Decision: the same gate as New session. Main's `blocked()` covers the switch, macOS, the key store
and a quit begun. The IPC needs the `launch` grant (`createInstallBinding`). Main's native
confirmation is the consent: what it shows is what it sends (§8 of the driven-sessions design).
There is no second confirmation for a later Resume and send, as today.

`chatConfirmation`. Text from agents or chats goes through `displayLine` or `displaySafe`.
Cancel is the default button (main's `confirm` sets `defaultId: 1`).

```
Continue this Copilot chat in <project>?

Chat: <title, or Untitled> (<first 8 of the id>)
Folder: <folder>
It works in this folder itself, not in a worktree: what it changes, it changes in your files there, uncommitted work included.
[This folder is not inside a git repository, so git cannot show or undo what it changes.]
[Another session is live in this folder.]
Agent Inbox drives it from this window: the agent acts in that folder, its approvals come here, and your messages reach it as turns.
Mode: Ask for everything. Each tool call asks you first, except what your own Copilot settings already allow.
Once any shell command is allowed, the session can run anything, in its folder and beyond. Answer each approval with that in mind.
Budgets: no limit on active turn time or tool calls.
Each turn spends Copilot premium requests, as it would in your terminal.

Message: <the first 300 characters>
                                                          [Continue] [Cancel]
```

The Read-only line is `MODES['read-only']`'s copy. If PR 2 finds that a terminal chat's "allow for
the rest of this session" approvals survive `session/load`, the dialog adds: "Tools you allowed for
the rest of this chat may still run without asking." The driver cannot clear them, because
`promptSafe` refuses a slash command.

### 3.5 The page

**The control.** In the Chats tab's Actions cell, after Resume and Copy resume, Copilot rows get
**Continue here…**. It is drawn only in the window that holds the `launch` grant, with the switch
on (`agentInboxLaunch.available()`), and asked again on every entry into the tab, as Resume's
availability is. Its `title` is "Continue this chat in Agent Inbox, as a session it drives". The
three ways are told apart by their verbs and titles. Copy resume copies a command. Resume ("Resume
in Terminal") opens the person's terminal. Continue here… keeps the chat in this window, and its
ellipsis says a dialog follows. Below 620px the buttons wrap on the row's second line, spaced with
`--sp-2`. No new font size is added (DESIGN.md Typography).

**The dialog.** A modal `<dialog>` in `public/launch-ui.js`, beside New session, titled "Continue in
Agent Inbox". It shows the chat's title and folder as text, a mode choice (Ask for everything,
the default, or Read-only, with their plain copy from `public/launches.js`), and a required
**Message** box with "Don't paste secrets here: the message is stored with the session." Then
Continue and Cancel. The message is a draft in `suspendState()` while the dialog is open, as New
session's task is. After Continue, the dialog shows main's phases through the existing
`onStartProgress` and the request's `startId`. It closes once the driver's status line says
started, or shows the refusal. Rejected: a variant of the New session dialog, because five of its
seven controls (folder, worktree, model, effort, budgets) would be hidden.

**After it starts.** The launch is an ordinary card (`public/sessions.js`, origin `started here`).
It is in the Working lane while its first turn runs, then follows the usual lane rules. Its session
panel adds one line, "Continued from a Copilot chat (<first 8 of the id>)", linked to `#chats`.
In the Chats tab, a chat whose id is some launch's `chat_id` (from the launches the page already
holds with the switch on) changes two cells:

- Live: a running launch reads "Live" with "· here".
- Actions: **Show session** replaces Continue here… for a running, parked or stopped-with-session
  launch. It switches to the Dashboard and opens the panel `launch:<id>` (`openSessionFocus` in
  `public/app.js`), where Resume and send, Take over and Stop already live.

An ended launch that cannot resume (handed off, `error:*`, forgotten) gives the row back its
Continue here…. Resume in Terminal is unchanged: a driven chat reads live, so it is refused there.

**Refusals** show in the row's existing `.chats-resume-note` (`role="status"`). After a `live`,
`driven`, `folder` or `missing` refusal the list is read again, as Resume does.

### 3.6 Identity

Decision: a nullable `launches.chat_id` (TEXT, a lowercase UUID). The driver writes it in
`createLaunch` for a `chat` spec, and nothing changes it afterwards. `launchView` serves it, since
it passes through every column it does not strip, so `/api/launches` carries it. A partial unique
index, `UNIQUE (chat_id) WHERE chat_id IS NOT NULL AND status <> 'ended'`, makes "one live or
resumable launch per chat" a store rule: a second `createLaunch` for the same chat fails inside its
own statement, and the driver refuses with "This chat already has a session here." Adding the
column gives the whole-table `launches` domain's update trigger a new name, as `end_detail` did
(`docs/architecture/driven-sessions.md`, #432 PR 5).

Why a column, not `acp_session`: `acp_session` is not served (`launchView` strips it on purpose).
It can be forgotten (`forgetSession` after `-32002`), and it is also set on launches started fresh
here, whose chats are app-made. `chat_id` records where the launch came from, and that is what the
Chats tab needs.

Where the link is read: the Chats view maps chat id to the newest launch with that `chat_id`,
from the launches the page already reads while the switch is on (`lastData.launches`). That gives
Show session with no new page read. Main's lookup route (§3.7) answers the same question with
`chat_id = ? OR acp_session = ?`, so a chat that is any launch's session is never continued again.

Not covered: a chat live in a terminal. Its lock's pid could be matched to an activity row's host
pid, but which process holds the lock is unverified, and a pid reused within a boot cannot be told
apart (`chats.md`, "Live"). That is a separate step.

### 3.7 Safety

- **The page sends only the tool, the id, the mode, the message and its start tag.** Main reads
  everything else. Before the dialog it reads the chat through one new route, `GET
  /api/chats/copilot/:id`. The viewer reads that chat's `workspace.yaml` and lock list fresh, with
  no cache. It answers `{ chat, remote, launch }`: the index entry or null, whether `mc_task_id` is
  present, and the newest launch whose `chat_id` or `acp_session` is the id. It follows the
  viewer's Host and Origin rules. A non-UUID is a 400, and an unknown chat is `chat: null`. It
  replaces the phase 1 branch's two list reads, which can miss a chat past the 2,000 cap. The
  folder, title and project always come from that answer.
- **Refusals in main**, in order, with nothing spawned for any of them:

  | Reason | When | Text |
  |---|---|---|
  | blocked | quitting, not macOS, the switch off, no key store | `blocked()`'s texts |
  | `invalid` | not exactly the keys; a tool other than `copilot`; a bad id, mode or message | "This chat can't be continued here." ("Only Copilot CLI chats can be continued here for now." for another tool) |
  | `busy` | this chat is already being continued (an in-memory set of chat ids) | "This chat is already starting." |
  | `index` | the lookup failed | "Agent Inbox could not read the chat list." |
  | `missing` | `chat: null` | "This chat is no longer listed." |
  | `driven` | `launch` is running, parked, or stopped with its session | "This chat already has a session here: use Show session." |
  | `live` | `chat.live` | "This chat is live in another process." |
  | `remote` | `remote` | "Cloud and remote Copilot sessions can't be continued here." |
  | `kind` | `hidden` holds `empty` or `non-interactive` | "Only interactive chats with something said can be continued here." |
  | `folder` | no folder, a control character in it, or not a directory now | "Its folder no longer exists." |
  | runtime | `runtimeOrRefusal()` | its text |
  | cancelled | Cancel in the confirmation | nothing shown |
  | environment | the shell capture failed | `environment()`'s texts |
  | `copilot_home` | `COPILOT_HOME` points elsewhere | "Your shell sets COPILOT_HOME to another folder, so Copilot would not find this chat." |

  After these, the driver's own refusals apply: the cap (exit 75), the lock re-check, the unique
  index, and the load failures in §3.3.
- **Never twice.** There are four guards. Main's lookup refuses a live or driven chat. Main's
  in-memory set refuses a second click. The driver's lock re-check catches a terminal Copilot that
  started after main's check. The unique index catches a second launch. Resume of a parked chat
  launch re-reads the chat (§3.3), so a chat a terminal resumed meanwhile is not loaded twice. Take
  over works as it does for any launch (`copilot --resume=<id>` is the same id), and its
  confirmation already warns against two Copilots in one session.
- **Mode and escalation.** A terminal chat may have been left in autopilot or with allow-all on.
  The load restores that (`docs/superpowers/specs/2026-10-31-copilot-acp-spike.md` §4). The
  existing setup re-asserts the mode and `allow_all` off and verifies both before any prompt, or
  ends the launch with `error:mode_escalation`. The option allow-list (`filterOptions`) and signed
  approvals (`appAsks`, `src/driver-launch.ts`) are unchanged.
- **The switch-off contract.**
  - With the switch off, the page reads no `/api/launch*`. The Chats tab draws no Continue
    here…, no Show session and no "· here", and `/api/chats` keeps its exact body: no field is
    added to it.
  - Main's `continueChat` refuses in `blocked()` before any read.
  - The IPC needs the `launch` grant, which needs the switch.
  - The new route exists, but nothing calls it.
  - The `chat_id` column and its index are added at open on every hub, as #432's columns were, and
    stay null on a hub nobody launches from.
  - PR 6's DOM test pins that the tab's reads and DOM with the switch off match the phase 1
    build exactly.
- **Older builds.** An older driver refuses the `chat` kind (exit 65). An older viewer or main
  shows a chat launch as an ordinary launch and ignores `chat_id`. An older driver that resumes a
  parked chat launch loads it as any launch. On `-32002` it would fall back to a fresh session
  holding the stored first message, which is the only degraded case. It needs a downgrade, since
  main always spawns its own release's runtime (`driverRuntime`).

## §4 What this replaces

| Earlier decision | Now |
|---|---|
| #432: every New session launch gets its own worktree by default | A continued chat runs in its own folder, with no worktree (§3.2); New session is unchanged |
| A `session/load` that answers `-32002` falls back to a fresh session with the stored task | Not for a launch with a `chat_id`: it ends (§3.3) |
| A failed load parks the launch to retry | Not on a chat launch's first start: it reads "Didn't start" (§3.3) |
| `chats.md`: "Show session is left out" | Shown for a chat driven here (§3.6); still left out for a terminal chat |
| Phase 1 branch: main finds a chat in `/api/chats`, then `?all=1` | Continue here… uses one fresh lookup route (§3.7); Resume in Terminal may move to it later |

## §5 Build order

Each PR leaves the app working. Public merges are approved by the owner. Docs change with the code
(`docs/architecture/driven-sessions.md`, `chats.md`, `electron-app.md`, `DESIGN.md` for the row,
and one `CHANGELOG.md` bullet each).

| PR | Content | Tests |
|---|---|---|
| 1 | This spec | none |
| 2 | **Check, with a stop gate.** Against Copilot CLI 1.0.108 with a scratch `COPILOT_HOME` and a synthetic chat made in a terminal: does `session/load` load it with its history? What does load do with a `cwd` other than the recorded one? Does the ACP host take `inuse.<pid>.lock`? Does load rewrite `workspace.yaml`'s `client_name` (which would hide the chat as `non-interactive`)? Do "allow for this session" approvals survive? Does load hit the reasoning-effort refusal? How do `mc_task_id` chats load? The findings go in the spike doc, and the recorded frames go in `test/fixtures/acp/copilot-1.0.108/`. If load does not work for terminal chats, phase 2 stops and #586 is updated. | the fixtures replay in `test/driver.test.ts` |
| 3 | Store and driver: `chat_id`, the unique index and the renamed trigger; the `chat` spec kind; `Driver`'s `chat` option and `chatPrompt`; `run`'s `chat` branch, lock re-check and first-start `closeRow`; `chat: true` on a later resume. Nothing calls it yet. | `test/launch-spec.test.ts` (the kind's exact keys, modes, id); `test/launches.test.ts` (the column, `launchView`, the unique index refusing a second running launch and allowing one after an end); `test/driver.test.ts` (load then the framed prompt; `-32002` ends and sends no `session/new`; a load error ends and does not park; no `loadSession` ends); `test/driver-run.test.ts` against the fake `copilot` with a synthetic `session-state` folder (the row, a live lock refused, a stale lock ignored, a second start refused, "Didn't start"); `test/mixed-version.test.ts` (an older spec check refuses the kind) |
| 4 | Viewer: `GET /api/chats/copilot/:id` and reading `mc_task_id`'s presence in `parseWorkspaceYaml` | `test/chat-index.test.ts` (fresh read past the cache, `remote`, the launch link by either column, 400 and null, Host and Origin); `/api/chats` byte-identical; `test/prstate.test.ts` import pins |
| 5 | Main: `chatRequest`, `continueChat`, `chatConfirmation`, the IPC and preload, and `resume`'s re-check for a chat launch | `test/launch-electron.test.ts` (every refusal in order and that each spawns nothing; the confirmation's lines with hostile titles and folders; `COPILOT_HOME`; the spec main sends; the IPC arity and grant; off reads nothing) |
| 6 | Page: the row control and its off states, the dialog, Show session, "· here", the panel line, CSS with the tokens, and `DESIGN.md` | `test/chats-model.test.ts` (the pure eligibility and link rules); `test/dom/chats-continue.test.ts` (drawn only with the grant; disabled reasons; the dialog's request; progress; refusals in the note; Show session opens `launch:<id>`; switch off draws and reads exactly what phase 1 did); `test/chats-style.test.ts` (tokens only) |

PRs 4 and 5 do not depend on each other's code, but 5 needs 4's route to be useful. PR 6 needs the
phase 1 Chats tab and Resume in Terminal on main.

## §6 Tests that hold across PRs

- With the switch off, `/api/chats`, `/api/launches` (not read) and the Chats tab's DOM are
  byte-identical to the phase 1 build.
- No path, argv or env from the page reaches main's spec; a test builds the spec from a request
  with extra keys and expects a refusal.
- One chat, one launch: two concurrent `continueChat` calls spawn one driver, and two drivers for
  one chat write one row.
- A continued chat is never a fresh session: no `session/new` is sent on any path of a launch with
  a `chat_id`.
- Fixtures are synthetic: no real chat titles, messages, ids or paths.

## §7 Open questions for the owner

1. **Which modes may a continued chat use?** It runs in the person's own folder.
   - **Ask for everything and Read-only (recommended).** Every write asks, in a folder that may
     hold uncommitted work.
   - Also Plan first. It works with a first message, but it adds the plan approval step to a chat
     that already has its context.
   - Also Edits in the folder. Edits run unasked in the person's own checkout, guarded only by the
     `.git` deny rules.
2. **Is the first message required?**
   - **Required (recommended).** The confirmation shows the first turn, the card lands in Working,
     and the driver needs no idle-load state.
   - Optional. Load and wait idle in the Quiet lane until a message is sent from the session panel.
     The confirmation could not show the first turn.
3. **What should the control be called?**
   - **"Continue here…" (recommended).** It says where the chat goes on, next to Resume (Terminal)
     and Copy resume.
   - "Drive here…". This names the mechanism, which is less plain.
   - "Resume here…". This is close to Resume, and the two would be easy to confuse.
4. **When the folder has uncommitted changes, is the confirmation's line enough?**
   - **Yes (recommended).** Main runs no git. Every tool call asks in both offered modes.
   - Add a count of uncommitted files. The driver or main would need to run git before the dialog.
   - Refuse a dirty folder. This is safest, but it blocks the common case of continuing work in
     progress.
