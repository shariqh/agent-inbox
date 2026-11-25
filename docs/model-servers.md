# Model servers

A **model server** is an OpenAI-compatible backend that the local agents (`unslop` and
`unslop-code`) send their model calls to. You add it once, by name, and each agent's profile
names it. When the server's address or key source changes, you change it in one place, and
every agent that names it picks the change up on its next call.

The servers live in `<mesh dir>/mesh/servers.json` (mode 0600 in a 0700 folder). `<mesh dir>` is
`~/.agent-inbox` unless `AGENT_INBOX_MESH_DIR` (or `AGENT_INBOX_DB`) says otherwise. `meshctl` is
the only thing that writes it; the agents only read it.

```json
{
  "schema": 1,
  "servers": {
    "box": { "baseUrl": "https://models.example/llm", "apiKey": { "file": "/Users/you/.keys/box" } }
  }
}
```

- A **name** is 1 to 40 lower-case letters, digits or `-`, starting with a letter or digit.
- **`baseUrl`** is `https://`, or `http://` on a loopback address only (`127.0.0.1`, `[::1]`), with
  no credentials, query or fragment. The agents call `<baseUrl>/v1/chat/completions`.
- **`apiKey`** says where the key comes from, never the key itself: `{ "file": "/absolute/path" }`
  (a 0600 file you own), `{ "command": ["/absolute/path", "arg"] }` (run without a shell; its
  output is the key) or `{ "env": "NAME" }`. Leave it out when the server needs no key.
- At most 32 servers. A server holds only `baseUrl` and `apiKey`, and the file only `schema` and
  `servers`. A file that breaks any rule is refused whole; the message names the rule, never a
  value from the file.

## In the app

The app's Agent cards tab has a **Model servers** section that runs these same commands, a dry
run first, in the app's own window on the Mac that runs the agents (never in a browser or from
another Mac). Each server shows its address, where its key comes from and the agents that name
it, with **Check** (`server check`: reachable and how many models, or why not) and **Remove**,
which asks first. **Add a server** takes a name, an address and either no key or a key file picked
in the app's own file dialog (the app keeps the file's path in the main process; the page sees only
its name). A key from a command or a variable is added with `meshctl`. **Make it a server** turns
an agent's inline settings into a server (`server add --from <agent> --move`). Setting up
unslop-code, or **Change server** on its page, picks a server and a model from the server's own
list. The commands below stay the way to do everything else.

### A key the app cannot read

The app runs these commands with a short fixed environment (`PATH`, `HOME`, and a few others), not
your shell's. So **Check** in the app can fail on a key where `server check` in a terminal works:

- A key from a variable is never visible to the app. **Check** says the key is in a shell variable.
- A key from a command works only if the command needs nothing from your shell. A command that
  reads a token from a variable gives no key there, and **Check** says the key's command gave no key.

You can still set up an agent on that server in the app: it asks you to type the model's name
instead of picking it from the server's list.

To let the app read the key too, use a key file (`server set <name> --key-file …`), or make the
command load your shell's settings first. With zsh, put `/bin/zsh -c 'exec "$@"' zsh` in front of
the command:

```json
"apiKey": { "command": ["/bin/zsh", "-c", "exec \"$@\"", "zsh", "/usr/local/bin/keytool", "read", "box"] }
```

A zsh started this way reads `~/.zshenv` and no other startup file of yours, so the variable the
command needs must be set there.

## How an agent names a server

A local agent's profile (`<mesh dir>/mesh/wrappers/unslop.json` or `unslop-code.json`) holds
either `"server": "<name>"` or its own inline `baseUrl` (with an optional `apiKey`), never both.
A profile with both, or with neither, is refused when the agent starts, with a message that names
the profile and the rule. `model`, `sampling` and the other keys stay in the profile as before.
Inline profiles keep working exactly as they did.

The agent reads the server's entry when it starts. Every minute it reads the entry again; when
the entry changed or is gone, it stops (its log says `stopped (server)`), and the next call starts
it with the new settings. An agent with an inline profile never reads `servers.json`.

## The commands

Use Node 24 (`fnm use 24`) and run them from a checkout as `npm run meshctl -- …`, or with the
app's own `~/.agent-inbox/bin/meshctl`. Every command that writes is a dry run until you add
`--apply`.

### See what you have

```sh
npm run meshctl -- server list
```

Expect one line per server: `Server box: https://models.example/llm; key: file; agents: unslop-code.`
The key is shown by its kind only (`file`, `command`, `env` or `none`). A last line names the
agents whose profiles still hold inline settings, which you can turn into a server (below).
`meshctl status` prints the same server lines and, for each local agent, the server its profile
names.

### Add a server

```sh
npm run meshctl -- server add box --base-url https://models.example/llm --key-file ~/.keys/box
npm run meshctl -- server add box --base-url https://models.example/llm --key-file ~/.keys/box --apply
```

Give exactly one of `--key-file <path>` (an absolute path to a regular file you own, mode 0600;
meshctl checks it and never reads it), `--key-env <NAME>` or `--no-key`. The dry run says what it
would write: the name, the address and the key's kind. A name that is already there is refused;
`server set` changes it.

### Turn an agent's inline settings into a server

```sh
npm run meshctl -- server add box --from unslop --move
npm run meshctl -- server add box --from unslop --move --apply
```

This copies the unslop profile's `baseUrl` and `apiKey` source into a new server named `box`,
printing neither value. With `--move` it also rewrites the profile to name `box`: `server` takes
`baseUrl`'s place, `apiKey` goes, every other key stays, and a backup of the old profile is
written beside it. Without `--move` the profile is left as it is. It is refused when the profile
already names a server, still holds `FILL IN` values, or cannot be read.

### Point an agent at a server, or change its model

```sh
npm run meshctl -- enable --unslop-code --server box --model coder-next
npm run meshctl -- enable --unslop-code --server box --model coder-next --apply
```

- When the profile does not exist yet, it is written with `server`, `model` (the one given, else
  the agent's default) and the agent's other template keys. unslop's profile also needs `skill`,
  which stays yours to fill in.
- When it exists, only `server` and `model` are set, the inline `baseUrl` and `apiKey` are
  removed, every other key is kept, and a backup is written beside it. The dry run names the keys
  that change, never their values.
- `--model <name>` alone changes only `model`. A model name is 1 to 64 letters, digits, `.`, `_`,
  `:`, `/` or `-`.
- Without either option, `enable` works as before. `enable --unslop-code` copies unslop's inline
  settings as it always has; when unslop's profile names a server, the new profile names the same
  server instead.

### Change or remove a server

```sh
npm run meshctl -- server set box --base-url https://models.example/v2 --apply
npm run meshctl -- server set box --key-env BOX_KEY --apply
npm run meshctl -- server remove box --apply
```

`set` changes the address, the key source, or both, keeping a backup; the agents that name the
server stop within a minute and start with the new settings on their next call. `remove` is
refused while an agent that is on names the server; point that agent at another server first.
An agent that is off keeps its settings but does not hold a server: `remove` goes through and
says that the kept settings still name it, and turning that agent on again needs `--server`.
Removing the last server deletes `servers.json` (keeping a backup).

### Ask a server which models it has

```sh
npm run meshctl -- server check box
```

This sends one `GET <baseUrl>/v1/models`, with the key when the server has one, to the server's
own address. It follows no redirect, waits at most 10 seconds, reads at most 256 KiB and writes
nothing. Expect `reachable` and the model ids, quoted under a line that says they come from the
server and are unverified; only ids that are plain model names are listed (at most 50, sorted).
Otherwise it names a class of failure and exits 1: `unreachable`, `unauthorized`,
`not-a-model-server` (another answer, a redirect, or too much), `timeout`, or `key` (the key
source gave no usable key, so nothing was sent).

**If something's off**

- An agent exits at once and its log says `the profile names the server box, which
  mesh/servers.json does not hold`: run `server list`, then `server add box …` or point the agent
  at a server that exists.
- An agent says its profile `holds both server and an inline baseUrl or apiKey`: run
  `enable --<agent> --server <name> --apply`, which removes the inline keys.
- `server list` says `servers.json` is refused: the reason names the broken rule. Fix the file by
  hand or move it aside, then add the servers again.
- `server check` says `unauthorized`: the key source gives a key the server refuses; `server set
  <name> --key-file …` changes the source.

## Output for programs (`--json`)

`enable`, `disable`, `server add`, `server set` and `server remove` take `--json`. They then print
one JSON object and nothing else, with the same exit codes:

```json
{ "applied": false, "steps": ["Would add the server box to …/servers.json, at https://models.example/llm, key: file, keeping every other server (and a backup beside it)."] }
```

- `applied`: true only when `--apply` was given and the command ended with exit 0 (also when
  there was nothing to do).
- `steps`: each step's first line, as the text output prints it. A profile's body, a template or
  a shim's text is never included.
- `refused` (only when it was refused or a step failed): the reason, as the text output words it.
- `notes` (only when there are some): other lines the text output prints, such as `Nothing to do.`
  or a note about a routing skill.
- A usage error (exit 2) prints the usage text on stderr and no JSON.

`server list --json` prints `{ "servers": [{ "name", "baseUrl", "key", "agents" }], "inline":
["<agent>"], "refused"?: "<reason>" }`. `server check --json` prints `{ "server", "baseUrl", "key",
"reachable", "failure"?, "models": [], "skipped" }`, or `{ "server", "refused" }` when the server
cannot be checked.

## What is never printed

No command prints a key, a key file's path, a key command or a key variable's name, in any mode,
JSON included. A server's address is printed only by `server list`, `server check`, `status`, and
the dry run or result of the `server add` or `server set` that was given it. Model ids from
`server check` are untrusted text, printed quoted under a fixed header. `disable --purge` of an
agent never touches `servers.json`.

The implementation notes are in [`docs/architecture/mesh.md`](architecture/mesh.md#model-servers).
