#!/usr/bin/env node
// agent-inbox-meshctl (Mesh M1, #397; design §2.1 and §2.5): the only writer of
// `mesh.json`, the mesh's root switch. It follows install-agents.sh's habits:
// a dry run by default, `--apply` to change anything, a timestamped backup, and
// nothing touched that it does not own (keys it does not know stay as they are).
// Node core only: it never opens the hub, so it imports nothing from store.ts.
//
// Since #454 the Agents view is always on, so `enable --agents-view` writes
// nothing and an `agentsView` key in an existing file is kept like any other.
// `enable --unslop` (#483, unslop design §4.2-§4.3) turns on the unslop agent:
// the `agents.unslop` key, its profile template, caller token and shim.
// `enable --request-post` (#500, request-post design §6, §8) turns on the
// remote request-post agent: its endpoint, a copy of its bearer token and a shim. A tailnet
// endpoint must be on this Mac's tailnet (#557, mesh design §8.8), like `add`'s.
// `add` (#529, mesh design §6.7, D13–D17) writes a card-driven `agents.<id>` entry for an
// agent this repo doesn't ship: its card URL, endpoint, token copy and card pin
// (src/mesh-add.ts holds the rules); `remove` takes one out. Only `add` writes such an entry.
// `call` (#530, D15–D17) is the one generic client for such an agent (src/mesh-call.ts).
// Every enable and disable also brings `<mesh dir>/skills/` in line with the mesh.json it leaves
// (#513, src/mesh-skills.ts): a routing SKILL.md for each agent that is on and has a template,
// none for an agent that is off, and none of meshctl's links to a folder it removes. `skills link`
// and `skills unlink` add and remove those links for Claude Code, Codex and Copilot CLI.
// `enable --make-agents` writes one more fixed routing skill, make-agents, which teaches a chat to make an
// agent with `new`; its switch is a top-level `makeAgents: true` in mesh.json, not an `agents` entry.
//
//   meshctl enable --agents-view [--apply]   says the Agents view is always on
//   meshctl enable --unslop [--port <n>] [--checkout <path>] [--server <name>] [--model <name>] [--json] [--apply]
//   meshctl enable --request-post --endpoint <url> --token-file <path> [--apply]
//   meshctl disable [--apply]                turn every mesh piece off
//   meshctl disable --unslop [--purge] [--apply]
//   meshctl enable --unslop-code [--port <n>] [--checkout <path>] [--server <name>] [--model <name>] [--json] [--apply]
//   meshctl disable --unslop-code [--purge] [--apply]
//   meshctl disable --request-post [--purge] [--apply]
//   meshctl enable --make-agents [--json] [--apply]
//   meshctl disable --make-agents [--json] [--apply]
//   meshctl add <card-url> [--id <id>] [--token-file <path>] [--key-thumbprint <t>] [--expect-pin <sha256>] [--json] [--apply]
//                                            add an A2A agent this repo doesn't ship (#529)
//   meshctl add <card-url> --move <id> [--token-file <path>] [--expect-pin <sha256>] [--json] [--apply]
//                                            the same agent (its card's id) at a new endpoint (#537)
//   meshctl remove <id> [--json] [--apply]   take an added agent out again
//   meshctl new <id> --from <card file> [--try <file>] [--checkout <path>] [--json] [--apply]
//                                            make an agent from a card file (src/mesh-made.ts)
//   meshctl key create|show|rotate|retire <agent> [--apply]
//                                            an agent's card-signing key (src/mesh-keys.ts, #536)
//   meshctl call <id> [--skill <s>] [--json] [--report <file>] [--timeout <s>] < request
//                                            call an added agent (src/mesh-call.ts)
//   meshctl check <card-url> [--level local|publishable] [--strict] [--json] [--token-file <path> [--send <file>]]
//                                            a conformance check anyone can run (src/mesh-check.ts, #538)
//   meshctl check <id> […]                   the same for an added agent's card URL; keeps its card copy
//   meshctl forget-runs (--unslop | --unslop-code | --request-post | --web-search | --id <id> | --all) [--apply]
//   meshctl status                           say what mesh.json turns on
//   meshctl server list|add|set|remove|check …
//                                            the model servers local agents name (docs/model-servers.md)
//   meshctl --version                        this build's version
//   meshctl skills link|unlink [--target claude|agents|all] [--apply]
//                                            link the routing skills into the harnesses' skill folders
//   meshctl unslop --kind <kind> [--report <file>] [--timeout <s>] < draft
//                                            the shim's command (src/unslop-client.ts)
//   meshctl unslop-code [--base <ref>] [--apply] [--no-suggest] [--report <file>] [--timeout <s>] [-- <path>…]
//                                            its shim's command (src/unslop-code-client.ts, #652)
//   meshctl request-post file|status|wait …  its shim's command (src/request-post-client.ts)
//
// `server …` (model servers step 1) keeps <mesh dir>/mesh/servers.json: each model server once, by
// name, with its address and key source, or as Claude Code on this Mac (`--claude-code`: no address,
// no key); a local agent's profile names one instead of holding baseUrl and apiKey. enable, disable,
// add, remove and server add|set|remove take --json: one plan object.
//
// Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 usage;
// `unslop` has its own (0, 10-14, 4), listed in src/unslop-client.ts, `unslop-code` its own
// (0, 11-14, 4), listed in src/unslop-code-client.ts, and
// `request-post` its own (0, 11-16, 124, 4), listed in src/request-post-client.ts, and
// both shims exit 18 when they are stale (#584; 14 stays the agent being off), and
// `call` one table for every added agent (0, 11-16, 4), in docs/mesh-call.md, and `check`
// its own (0, 17, 15, 4), in the same page.
// The entry appends one run record per client run (src/mesh-runs.ts, cards view V5 §5).
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import type { LookupFunction } from 'node:net'
import { fileURLToPath } from 'node:url'
import { MESH_SCHEMA, MODEL_NAME, SERVERS_MAX, SERVERS_REASONS, SERVER_NAME, baseUrlRefusal, cardCopyFile, inTailnet, isClaudeServer, isKeySource, keyKind, loopbackPort, meshDir, meshFile, readCardCopy, readMesh, readPrivate, readServers, readTokenFile, removeCardCopy, requestPostEndpoint, serversFile, serversText, writeCardCopy, cardsFolderRefused } from './mesh-config.js'
import type { KeySource, MeshDocument, MeshRead, ServerEntry } from './mesh-config.js'
import { addSummary, cardEndpoint, cardSha256, cardSummary, checkedCard, fetchAddedCard, placeRefusal, reachOf, signatureRefusal, signedLine, type CardSummary } from './mesh-add.js'
import { BUILT_IN_AGENTS, addedEntry, addedPlace, idFromName, idRefusal } from './mesh-entry.js'
import { THUMBPRINT } from './card-signature.js'
import { frameResult } from './agent-result.js'
import { CARD_FILE_MAX, madeDescription, madeLog, madePaths, madeProfile, parseMadeCard, serverKinds } from './mesh-made.js'
import { meshLink } from './mesh-identity.js'
import { KEY_USAGE, runKey } from './mesh-keys.js'
import { appendRun, pruneRuns, runAgents, runFiles, tidyRuns } from './mesh-runs.js'
import type { RunCollector } from './mesh-runs.js'
import { CALL_USAGE, runCall } from './mesh-call.js'
import { CHECK_USAGE, publishableRefusal, runCheck } from './mesh-check.js'
import { DEFAULT_MESH_DIR, SKILL_TARGETS, holdSetupLock, shownDir, skillPlan, skillState } from './mesh-skills.js'
import type { SkillTarget } from './mesh-skills.js'
import { REQUEST_POST_USAGE, runRequestPost } from './request-post-client.js'
import type { RequestPostIo } from './request-post-client.js'
import { UNSLOP_USAGE, getCard, runUnslop, startAgent } from './unslop-client.js'
import type { UnslopIo } from './unslop-client.js'
import { UNSLOP_CODE_USAGE, runUnslopCode } from './unslop-code-client.js'
import { SERVER_CHECK_USAGE, runServerCheck } from './mesh-server-check.js'
import { publicLookup } from './public-address.js'
import { AGENT_INBOX_VERSION } from './version.js'

const UNSLOP_PORT = 4420
const UNSLOP_CODE_PORT = 4421
const ENDPOINT_RULE = 'https://<name>.<tailnet>.ts.net[:<port>] or, for the SSH fallback only, http://127.0.0.1:<port>'

const USAGE = `usage: agent-inbox-meshctl status
       agent-inbox-meshctl --version
       agent-inbox-meshctl disable [--apply]
       agent-inbox-meshctl enable --agents-view [--apply]
       agent-inbox-meshctl enable --unslop [--port <n>] [--checkout <path>] [--server <name>] [--model <name>] [--apply]
       agent-inbox-meshctl disable --unslop [--purge] [--apply]
       agent-inbox-meshctl enable --unslop-code [--port <n>] [--checkout <path>] [--server <name>] [--model <name>] [--apply]
       agent-inbox-meshctl disable --unslop-code [--purge] [--apply]
       agent-inbox-meshctl enable --request-post --endpoint <url> --token-file <path> [--apply]
       agent-inbox-meshctl disable --request-post [--purge] [--apply]
       agent-inbox-meshctl enable --make-agents [--json] [--apply]
       agent-inbox-meshctl disable --make-agents [--json] [--apply]
       agent-inbox-meshctl add <card-url> [--id <id>] [--token-file <path>] [--key-thumbprint <t>] [--expect-pin <sha256>] [--json] [--apply]
       agent-inbox-meshctl add <card-url> --move <id> [--token-file <path>] [--key-thumbprint <t>] [--expect-pin <sha256>] [--json] [--apply]
       agent-inbox-meshctl remove <id> [--json] [--apply]
       agent-inbox-meshctl new <id> --from <card file> [--try <file>] [--checkout <path>] [--json] [--apply]
       agent-inbox-meshctl key create|show|rotate|retire <agent> [--apply]
       agent-inbox-meshctl call <id> [--skill <skill>] [--json] [--report <file>] [--timeout <s>] < request
       agent-inbox-meshctl check <card-url> [--level local|publishable] [--strict] [--json] [--token-file <path> [--send <file>]]
       agent-inbox-meshctl forget-runs (--unslop | --unslop-code | --request-post | --web-search | --id <id> | --all) [--apply]
       agent-inbox-meshctl skills link|unlink [--target claude|agents|all] [--apply]
       agent-inbox-meshctl unslop --kind <kind> [--report <file>] [--timeout <s>] < draft
       agent-inbox-meshctl unslop-code [--base <ref>] [--apply] [--no-suggest] [--report <file>] [--timeout <s>] [-- <path>…]
       agent-inbox-meshctl request-post file|status|wait …
       agent-inbox-meshctl server list [--json]
       agent-inbox-meshctl server add <name> --base-url <url> (--key-file <path> | --key-env <NAME> | --no-key) [--apply]
       agent-inbox-meshctl server add <name> --from unslop|unslop-code [--move] [--apply]
       agent-inbox-meshctl server add <name> --claude-code [--apply]
       agent-inbox-meshctl server set <name> [--base-url <url>] [--key-file <path> | --key-env <NAME> | --no-key] [--apply]
       agent-inbox-meshctl server remove <name> [--apply]
       agent-inbox-meshctl server check <name> [--json]

Without --apply, enable, disable, add, new, remove, forget-runs, skills, key and server add|set|remove are dry runs: they print what they would do.
enable, disable, add, remove and server add|set|remove also take --json: they print one JSON object,
{ "applied", "steps", "refused"?, "notes"? }, each step its first line as the text prints it;
add's also has "card", the card's summary as cleaned fields (docs/mesh-call.md); new takes --json too, with the same "card".
The Agents view is always on, so enable --agents-view writes nothing.
enable --unslop needs packages/mesh built in the checkout (npm ci && npm run build there);
it listens on http://127.0.0.1:<port> only (default ${UNSLOP_PORT}). disable --unslop keeps the
profile, logs, deny list and run records unless --purge. unslop is what <mesh dir>/bin/unslop runs:
it sends one public draft to the agent (docs/unslop.md).
enable --unslop-code turns on the second local agent, which removes the comments a coding agent
added that a maintainer would not write (default port ${UNSLOP_CODE_PORT}; a port another agent
entry uses is refused). Its profile takes baseUrl and apiKey from the unslop profile when that
one is readable. unslop-code is what <mesh dir>/bin/unslop-code runs inside a git repository: it
sends the JavaScript and TypeScript files a change touched and prints the patch (docs/unslop-code.md).
disable --unslop-code keeps its profile, logs, budget and run records unless --purge.
enable --make-agents writes <mesh dir>/skills/make-agents/SKILL.md, a fixed routing skill that
teaches a chat to make an agent with new (docs/made-agents.md), and sets makeAgents in mesh.json; it
starts nothing. disable --make-agents removes both.
A model server is a backend added once, by name, to <mesh dir>/mesh/servers.json: its address and
key source (a file, a command or an environment variable; never the key). enable --unslop and
--unslop-code --server <name> make the profile name it (its baseUrl and apiKey go, every other key
stays, with a backup); --model <name> sets the model. server add --from <agent> [--move] turns an
agent's inline settings into a server. server check asks the server which models it has (GET
<address>/v1/models, no redirect, 10 seconds) and writes nothing. No server command prints a key,
a key file's path, a key command or a key variable's name (docs/model-servers.md).
server add <name> --claude-code adds Claude Code on this Mac: no address and no key; its model calls
run the claude program in print mode (the text goes to Anthropic through your Claude sign-in), its
models are haiku, sonnet and opus (sonnet unless --model says otherwise), and server check reads
only whether claude is signed in. No command prints the claude program's path.
enable --request-post copies the per-device bearer token from --token-file (never printed);
the endpoint is ${ENDPOINT_RULE}; a tailnet name must be on this Mac's tailnet (read from
tailscale status), never another tailnet or a Funnel host (docs/request-post.md).
disable --request-post keeps its run records unless --purge.
add fetches an A2A agent's card (no token, no redirect), checks it and pins it, and adds the
agent as agents.<id>: the card URL and endpoint must be http://127.0.0.1:<port> or https://<name>
on a DNS name. A <name>.<tailnet>.ts.net on this Mac's tailnet (read from tailscale status) is
local; any other name is public (#534): every address it resolves to must be public, the card must
be signed and publishable, and what you send it leaves this Mac. A loopback agent needs
--token-file (a 0600 file you own; meshctl copies it and never prints it). add never replaces an
entry or takes a built-in name; remove deletes only an entry add wrote, its token copy and card copy.
add --apply keeps the card it accepted as <mesh dir>/mesh/cards/<id>.json (0600), which the app
shows; the app never contacts an added agent.
When the card declares a stable id (its profile extension), add records it as agentId.
add verifies the card's signatures (ES256, ES384 or EdDSA by a key the card's profile lists): one that fails
refuses the card; an unsigned card is allowed on loopback and this Mac's tailnet only. The keys
the card lists are pinned in the entry (trust on first use);
--key-thumbprint <t> refuses a card not signed by the key with that RFC 7638 thumbprint.
--expect-pin <sha256> refuses a card whose pin is not the one given (a dry run prints it), so
add takes only the card that was looked at.
A card whose agent id an entry holds, signed by a key that entry pinned, is that agent at a new
endpoint: add moves it. add --move <id> moves agents.<id> to the card URL given, signed or not:
the card must declare the entry's agentId and match its pin; only the card URL and endpoint
change (and the token copy, with --token-file), so the pin and run records stay.
new makes an agent from a card file a chat wrote (name, description, instructions, server, model):
the one shared runner in packages/mesh serves it (the checkout needs packages/mesh built), sending
each request to that model server with the instructions. A dry run shows its card and pin; --try
<file> sends the sample and the instructions to the server and prints the answer; --apply writes its
description, token and start profile, starts it, and adds it as add would. call starts it when it is
not running; remove takes it out with its files (docs/made-agents.md).
key create|show|rotate|retire <agent> manages <mesh dir>/mesh/keys/<agent>.jwk, the agent's
card-signing key (0600, never printed; show prints the public key and its thumbprint).
call sends one request to an added agent: it checks the card pin and, on loopback, the agent's
identity before it sends the token or any text, and prints the result framed as untrusted
(docs/mesh-call.md).
check runs the conformance tests on an A2A agent's card and writes nothing: exit 0 conforms, 17 a
test failed, 15 the card could not be fetched, 4 usage. Live tests need --token-file and create no
work unless --send <file> is given (docs/mesh-call.md). check <id> checks an added agent's card
URL and, when the card still matches its pin, writes its card copy if it is missing or differs.
request-post is what <mesh dir>/bin/request-post runs: it files a content request with the
service, reads its status or waits for it (docs/request-post.md).
Each client run appends a record without text to <mesh dir>/mesh/runs/, kept 30 days;
forget-runs deletes an agent's records now (--id <id> an added agent's, --all every agent's);
remove deletes an added agent's with its entry. Every enable and disable deletes expired ones.
Every enable and disable writes <mesh dir>/skills/<agent>/SKILL.md, the fixed routing skill, for
each agent that is on and has one (unslop, unslop-code, make-agents), and removes the folders and links of agents that are off.
skills link makes ~/.claude/skills/<agent> (Claude Code) and ~/.agents/skills/<agent> (Codex,
Copilot CLI) links to those folders; skills unlink removes only links that point into
<mesh dir>/skills/. Neither replaces a folder or link it did not make: a skill of the same name
there, or in ~/.copilot/skills, is reported and that agent is not linked. With --apply both take
the setup lock, and refuse while another setup holds it.
mesh.json lives in AGENT_INBOX_MESH_DIR, else beside AGENT_INBOX_DB, else ~/.agent-inbox.
`

export interface MeshctlIo {
  env?: NodeJS.ProcessEnv
  home?: string
  now?: () => Date
  out?: (text: string) => void
  err?: (text: string) => void
  /** This Mac's MagicDNS suffix for `add` and `enable --request-post`, or undefined when it cannot be read (default: `tailscale status --json`). */
  tailnet?: () => string | undefined
  /** The Node binary and meshctl.js the shim and start command name (tests point them at scratch files). */
  node?: string
  script?: string
  /** `add`'s DNS, the CA that replaces the system roots, and which addresses count as public (test seams only, #534) */
  lookup?: LookupFunction
  ca?: string
  isPublic?: (address: string) => boolean
}

// `~/…` for the home directory, so the output reads like the docs
function shown(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const pad = (n: number): string => String(n).padStart(2, '0')
function backupName(file: string, now: Date): string {
  const t = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${file}.bak-${t}`
}

/** Copies the current file aside, never through a symlink and never over another backup. */
function writeBackup(file: string, now: Date): string {
  const source = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes: Buffer
  try {
    if (!fstatSync(source).isFile()) throw new Error('not a regular file')
    bytes = readFileSync(source)
  } finally {
    closeSync(source)
  }
  const base = backupName(file, now)
  for (let n = 0; n < 100; n++) {
    const target = n ? `${base}-${n}` : base
    let fd: number
    try {
      fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      writeSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return target
  }
  throw new Error('no free backup name')
}

const ALWAYS_ON = 'The Agents view is always on; mesh.json no longer controls it.'

// ── unslop (#483, unslop design §4.2-§4.3) ──────────────────────────────────

function unslopPaths(dir: string) {
  const root = join(dir, 'mesh')
  return {
    root, wrappers: join(root, 'wrappers'), profile: join(root, 'wrappers', 'unslop.json'),
    tokens: join(root, 'tokens'), token: join(root, 'tokens', 'unslop'), logs: join(root, 'logs'),
    deny: join(root, 'unslop-deny.txt'), budget: join(root, 'unslop-budget.json'),
    bin: join(dir, 'bin'), shim: join(dir, 'bin', 'unslop'),
  }
}

// ── unslop-code (#652) ──────────────────────────────────────────────────────
// Its own names beside unslop's: every file match below is exact, so neither switch touches the
// other's files.

function unslopCodePaths(dir: string) {
  const root = join(dir, 'mesh')
  return {
    root, wrappers: join(root, 'wrappers'), profile: join(root, 'wrappers', 'unslop-code.json'),
    tokens: join(root, 'tokens'), token: join(root, 'tokens', 'unslop-code'), logs: join(root, 'logs'),
    budget: join(root, 'unslop-code-budget.json'), bin: join(dir, 'bin'), shim: join(dir, 'bin', 'unslop-code'),
  }
}

// the log files each agent's purge deletes: the agent's day logs and the client's start log
const UNSLOP_LOG = /^unslop-(?:\d{4}-\d{2}-\d{2}|agent)\.log$/
const UNSLOP_CODE_LOG = /^unslop-code-(?:\d{4}-\d{2}-\d{2}|agent)\.log$/

// a backend inline (baseUrl and its key source) or a model server's name (model servers step 1)
type Backend = { baseUrl: string; apiKey?: unknown } | { server: string }

// The agent refuses the placeholders (baseUrl is not a URL, the env name holds no key) and ignores
// `_about` and `start`. With unslop's backend the two values are that profile's, copied as written:
// `apiKey` is a key source (a file, a command or an env name), never a key. A server's name goes
// in their place (model servers D5), and `model` is the one given or the default.
function codeProfileTemplate(start: string[], backend: Backend | undefined, model = 'coder-next'): string {
  const inline = backend && 'baseUrl' in backend ? backend : undefined
  return `${JSON.stringify({
    _about: backend && 'server' in backend
      ? 'The unslop-code agent\'s profile (agent-inbox #652). Its backend is the model server named by "server" (meshctl server list). start is what meshctl runs.'
      : backend
        ? 'The unslop-code agent\'s profile (agent-inbox #652). baseUrl and apiKey were taken from the unslop profile; change them here if this agent needs another backend. start is what meshctl runs.'
        : 'The unslop-code agent\'s profile (agent-inbox #652). Fill in baseUrl and apiKey (or remove apiKey when the backend needs no key); the agent refuses to start until you do. start is what meshctl runs.',
    ...(backend && 'server' in backend ? { server: backend.server } : {
      baseUrl: inline ? inline.baseUrl : 'FILL IN: the https:// base URL of the OpenAI-compatible backend (http:// only on a loopback address)',
      ...(inline ? (Object.hasOwn(inline, 'apiKey') ? { apiKey: inline.apiKey } : {}) : {
        apiKey: { env: 'FILL IN: the name of the environment variable holding the key, or use { "file": "/absolute/path" } (0600) or { "command": ["/absolute/path", "arg"] }' },
      }),
    }),
    model,
    sampling: { temperature: 0, top_p: 0.9, presence_penalty: 0 },
    start,
  }, null, 2)}\n`
}

/**
 * unslop's backend when that profile is readable and filled in: its baseUrl and apiKey source, or
 * the model server it names (with no inline settings beside it).
 */
function unslopBackend(profile: string): Backend | undefined {
  try {
    const p = objectOf(JSON.parse(readPrivate(profile)))
    if (p && Object.hasOwn(p, 'server')) {
      const server = p['server']
      return typeof server === 'string' && SERVER_NAME.test(server) && !Object.hasOwn(p, 'baseUrl') && !Object.hasOwn(p, 'apiKey') ? { server } : undefined
    }
    const baseUrl = p?.['baseUrl']
    if (typeof baseUrl !== 'string' || !baseUrl || baseUrl.startsWith('FILL IN')) return undefined
    if (!Object.hasOwn(p!, 'apiKey')) return { baseUrl }
    // only a key source (file, command or env) is taken: anything else, such as a pasted key, is never copied
    return objectOf(p!['apiKey']) ? { baseUrl, apiKey: p!['apiKey'] } : undefined
  } catch {
    return undefined
  }
}

const exists = (path: string): boolean => { try { lstatSync(path); return true } catch { return false } }
const isFile = (path: string): boolean => { try { return statSync(path).isFile() } catch { return false } }
const removeIfEmpty = (dir: string): void => { try { rmdirSync(dir) } catch { /* not empty, or not ours */ } }

/** Creates `path` with exactly `mode`, through O_NOFOLLOW; `exclusive` refuses an existing file. */
function writeNew(path: string, text: string, mode: number, exclusive: boolean): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (exclusive ? constants.O_EXCL : constants.O_TRUNC), mode)
  try {
    fchmodSync(fd, mode)
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Writes through a temporary file and an atomic rename. */
function writeAtomic(path: string, text: string, mode: number): void {
  const temp = `${path}.tmp-${process.pid}`
  writeNew(temp, text, mode, true)
  try {
    renameSync(temp, path)
  } catch (error) {
    unlinkSync(temp)
    throw error
  }
}

// The agent refuses each placeholder: `skill` is not absolute, `baseUrl` is not a
// URL and the `env` name holds no key. Keys it does not read (`_about`, `start`) it ignores.
// With a server (model servers D5) the profile names it in place of baseUrl and apiKey; `skill`
// stays the person's to fill in.
function profileTemplate(start: string[], choice: BackendChoice = {}): string {
  return `${JSON.stringify({
    _about: choice.server === undefined
      ? 'The unslop agent\'s profile (agent-inbox #483). Fill in skill, baseUrl and apiKey (or remove apiKey when the backend needs no key); the agent refuses to start until you do. start is what meshctl runs.'
      : 'The unslop agent\'s profile (agent-inbox #483). Fill in skill; the agent refuses to start until you do. Its backend is the model server named by "server" (meshctl server list). start is what meshctl runs.',
    skill: 'FILL IN: the absolute path of the unslop skill folder, which holds rules.md',
    ...(choice.server === undefined ? {
      baseUrl: 'FILL IN: the https:// base URL of the OpenAI-compatible backend (http:// only on a loopback address)',
      apiKey: { env: 'FILL IN: the name of the environment variable holding the key, or use { "file": "/absolute/path" } (0600) or { "command": ["/absolute/path", "arg"] }' },
    } : { server: choice.server }),
    model: choice.model ?? 'chat-long',
    sampling: { temperature: 0.2, top_p: 0.9, presence_penalty: 0 },
    terms: [], allowEmails: [], customerPaths: [],
    start,
  }, null, 2)}\n`
}

const shQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

// The shim never reads a terminal: on a stale path it discards piped input only, and not at all
// when the draft came by --in (the skill's form), since a held-open stdin would stall the exit. A stale shim exits
// 18, not 14: 14 is the agent being off, and a caller must tell a broken install from a switch (#584).
// It pins the mesh dir it was written for, so the caller's environment (no
// AGENT_INBOX_MESH_DIR, or an AGENT_INBOX_DB) cannot point it at another one.
// unslop-code's command never reads stdin, so its stale shim drains nothing (`drains` false).
function shimText(agent: string, issue: number, node: string, script: string, dir: string, drains = true): string {
  return `#!/bin/sh
# agent-inbox ${agent} shim (#${issue}), written by meshctl enable --${agent}. Do not edit.
AGENT_INBOX_MESH_DIR=${shQuote(dir)}; export AGENT_INBOX_MESH_DIR
node=${shQuote(node)}
meshctl=${shQuote(script)}
if [ ! -x "$node" ] || [ ! -f "$meshctl" ]; then
${drains ? `  drain=1; for a in "$@"; do case "$a" in --in|--in=*) drain=0;; esac; done
  [ "$drain" = 0 ] || [ -t 0 ] || cat > /dev/null
` : ''}  echo 'agent-inbox ${agent}: this shim is stale: run meshctl enable --${agent} again' >&2
  exit 18
fi
exec "$node" "$meshctl" ${agent} "$@"
`
}

// ── request-post (#500, request-post design §6, §8) ────────────────────────

function requestPostPaths(dir: string) {
  const root = join(dir, 'mesh')
  return { root, tokens: join(root, 'tokens'), token: join(root, 'tokens', 'request-post'), bin: join(dir, 'bin'), shim: join(dir, 'bin', 'request-post') }
}

type Step = { dry: string; run: () => string; lock?: true }

/**
 * A plan a program reads (model servers D6): with --json, enable, disable, add, remove and server
 * add|set|remove print one object, `{ applied, steps, refused?, notes? }`, where each step is its
 * first line as the text prints it (never a profile's body, a template or a shim's text); add's
 * also carries `card`, the cleaned summary of the card it fetched (cardSummary in mesh-add.ts).
 */
type Plan = { steps: string[]; notes: string[]; refused?: string; card?: CardSummary }
const firstLine = (text: string): string => text.split('\n', 1)[0]!

/**
 * With --json the text goes into the plan: a refusal as `refused`, any other line as a note; a
 * usage error stays the usage text on stderr, with no JSON. `print` writes the one object.
 */
function planCapture(io: MeshctlIo): { plan: Plan; io: MeshctlIo; print: (code: number, apply: boolean) => void } {
  const plan: Plan = { steps: [], notes: [] }
  const usageText: string[] = []
  const captured: MeshctlIo = {
    ...io,
    out: (text) => { plan.notes.push(text.trim()) },
    err: (text) => {
      if (text.startsWith('usage:')) usageText.push(text)
      else if (/^(Refused: |Failed at step )/.test(text)) plan.refused ??= text.replace(/^Refused: /, '').trim()
      else plan.notes.push(text.replace(/^Note: /, '').trim())
    },
  }
  const print = (code: number, apply: boolean): void => {
    const out = io.out ?? ((text: string) => { process.stdout.write(text) })
    const err = io.err ?? ((text: string) => { process.stderr.write(text) })
    if (code === 2) err(usageText.join(''))
    else {
      out(`${JSON.stringify({
        applied: apply && code === 0, steps: plan.steps,
        ...(plan.refused === undefined ? {} : { refused: plan.refused }), ...(plan.notes.length ? { notes: plan.notes } : {}),
        ...(plan.card === undefined ? {} : { card: plan.card }),
      })}\n`)
    }
  }
  return { plan, io: captured, print }
}

function runSteps(steps: Step[], apply: boolean, out: (text: string) => void, err: (text: string) => void, failed: string, plan?: Plan): number {
  const n = steps.length
  if (plan) {
    for (const [i, step] of steps.entries()) {
      if (!apply) {
        plan.steps.push(firstLine(step.dry))
        continue
      }
      try {
        plan.steps.push(firstLine(step.run()))
      } catch {
        plan.refused = `Failed at step ${i + 1}/${n}. ${failed}`
        return 1
      }
    }
    return 0
  }
  if (!apply) {
    out(`Dry run.\n${steps.map((step, i) => `${i + 1}/${n} ${step.dry}`).join('\n')}\nNothing changed. Re-run with --apply.\n`)
    return 0
  }
  for (const [i, step] of steps.entries()) {
    try {
      out(`${i + 1}/${n} ${step.run()}\n`)
    } catch {
      err(`Failed at step ${i + 1}/${n}. ${failed}\n`)
      return 1
    }
  }
  return 0
}

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

// ── model servers (model servers step 1) ────────────────────────────────────
// `<mesh dir>/mesh/servers.json` (src/mesh-config.ts holds its rule) names each model server once;
// a local agent's profile names one by `server` instead of holding baseUrl and apiKey. meshctl
// prints a server's name, address and key KIND only: never a key, a key file's path, a key command
// or a key variable's name.

const LOCAL_AGENTS = ['unslop', 'unslop-code'] as const
type LocalAgent = typeof LOCAL_AGENTS[number]
type BackendChoice = { server?: string; model?: string }
/** The models of a Claude Code server, as `--model` takes them. */
const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus']
const profileFile = (dir: string, agent: LocalAgent): string => join(dir, 'mesh', 'wrappers', `${agent}.json`)
const SERVER_NAME_RULE = 'a server name is 1 to 40 lower-case letters, digits or "-", starting with a letter or digit'

/** A local agent's profile: its object when it is a JSON object in a private file, else why not. */
function readProfile(path: string): { p: Record<string, unknown> } | 'missing' | 'unreadable' {
  if (!exists(path)) return 'missing'
  try {
    const p = objectOf(JSON.parse(readPrivate(path)))
    return p ? { p } : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/** The server a profile names, when its name passes the rule. */
const namedServer = (p: Record<string, unknown>): string | undefined =>
  typeof p['server'] === 'string' && SERVER_NAME.test(p['server']) ? p['server'] : undefined

/** A profile's inline settings when they are filled in and pass servers.json's rule: what `server add --from` takes. */
function inlineSettings(p: Record<string, unknown>): ServerEntry | undefined {
  if (Object.hasOwn(p, 'server') || baseUrlRefusal(p['baseUrl'])) return undefined
  const baseUrl = p['baseUrl'] as string
  if (!Object.hasOwn(p, 'apiKey')) return { baseUrl }
  return isKeySource(p['apiKey']) ? { baseUrl, apiKey: p['apiKey'] } : undefined
}

/** The local agents that are on (mesh.json names them). */
function localAgentsOn(dir: string): Set<LocalAgent> {
  const mesh = readMesh(meshFile(dir))
  const agents = mesh.kind === 'present' ? objectOf(mesh.doc['agents']) : undefined
  return new Set(LOCAL_AGENTS.filter((agent) => agents !== undefined && Object.hasOwn(agents, agent)))
}

/**
 * The agents that name each server: `on` the ones that are on, which is who uses the server (the
 * local agents mesh.json turns on, and the made agents it holds an entry for, whose description names
 * the server); `kept` the local agents that are off, whose profile `disable` kept. Only `on` holds a server.
 */
function serverUsers(dir: string): { on: Map<string, string[]>; kept: Map<string, string[]> } {
  const on = new Map<string, string[]>()
  const kept = new Map<string, string[]>()
  const running = localAgentsOn(dir)
  for (const agent of LOCAL_AGENTS) {
    const read = readProfile(profileFile(dir, agent))
    const server = typeof read === 'object' ? namedServer(read.p) : undefined
    if (server === undefined) continue
    const into = running.has(agent) ? on : kept
    into.set(server, [...(into.get(server) ?? []), agent])
  }
  // made agents (agents a chat makes, D6): on while their entry exists
  const mesh = readMesh(meshFile(dir))
  const agents = mesh.kind === 'present' ? objectOf(mesh.doc['agents']) ?? {} : {}
  for (const id of Object.keys(agents)) {
    const read = addedEntry(id, agents[id])
    const made = read === undefined || read === 'invalid' ? undefined : madeDescription(dir, id)
    if (typeof made === 'object') on.set(made.card.server, [...(on.get(made.card.server) ?? []), id])
  }
  return { on, kept }
}

/** One line per server, for `server list` and `status`: its name, address, key kind and the agents naming it. */
const serverLine = (name: string, entry: ServerEntry, agents: string[]): string =>
  `Server ${name}: ${isClaudeServer(entry) ? 'Claude Code on this Mac' : `${entry.baseUrl}; key: ${keyKind(entry)}`}; agents: ${agents.length ? agents.join(', ') : 'none'}.`

/**
 * The profile with `server` in place of its inline baseUrl and apiKey (when a server is given) and
 * `model` set (when one is given), every other key kept where it was; which keys it sets and removes.
 */
function rewriteProfile(p: Record<string, unknown>, choice: BackendChoice): { next: Record<string, unknown>; set: string[]; removed: string[] } {
  const entries: Array<[string, unknown]> = []
  const removed: string[] = []
  let placed = false
  for (const [key, value] of Object.entries(p)) {
    if (choice.server !== undefined && (key === 'baseUrl' || key === 'apiKey' || key === 'server')) {
      if (key !== 'server') removed.push(key)
      if (!placed) entries.push(['server', choice.server])
      placed = true
    } else entries.push([key, key === 'model' && choice.model !== undefined ? choice.model : value])
  }
  if (choice.server !== undefined && !placed) entries.push(['server', choice.server])
  if (choice.model !== undefined && !Object.hasOwn(p, 'model')) entries.push(['model', choice.model])
  const set = [...(choice.server !== undefined && p['server'] !== choice.server ? ['server'] : []), ...(choice.model !== undefined && p['model'] !== choice.model ? ['model'] : [])]
  // fromEntries defines each key as the object's own, a "__proto__" key included
  return { next: Object.fromEntries(entries), set, removed }
}

/** Why a --key-file is refused, in words that never hold its path: it is checked here, never read. */
function keyFileRefusal(path: string): string | undefined {
  if (!isAbsolute(path) || !isKeySource({ file: path })) return 'the key file must be given as an absolute path'
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return 'the key file does not exist'
  }
  if (!stat.isFile()) return 'the key file must be a regular file, not a symlink or a folder'
  if (process.getuid && stat.uid !== process.getuid()) return 'the key file must be a file you own'
  if (stat.mode & 0o077) return 'the key file is open to other users: chmod 600 it'
  return undefined
}

/**
 * Whether a command takes --json for a plan (D6): enable, disable, remove and server add|set|remove.
 * add takes it too, in runAdd (it is async, and this path answers add with 4).
 */
const wantsPlan = (argv: string[]): boolean => argv.includes('--json')
  && (argv[0] === 'enable' || argv[0] === 'disable' || argv[0] === 'remove' || (argv[0] === 'server' && ['add', 'set', 'remove'].includes(argv[1] ?? '')))

export function runMeshctl(argv: string[], io: MeshctlIo = {}): number {
  const json = wantsPlan(argv) ? planCapture(io) : undefined
  const code = json ? meshctl(argv, json.io, json.plan) : meshctl(argv, io)
  json?.print(code, argv.includes('--apply'))
  // deleting expired run records is housekeeping, not a configuration change, so a dry run
  // does it too (cards view V5 §5.6)
  if ((argv[0] === 'enable' || argv[0] === 'disable') && code !== 2) {
    pruneRuns(resolve(meshDir(io.env ?? process.env, io.home ?? homedir())), (io.now ?? (() => new Date()))().getTime())
  }
  return code
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function meshctl(argv: string[], io: MeshctlIo, plan?: Plan): number {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const now = io.now ?? (() => new Date())
  const out = io.out ?? ((text: string) => { process.stdout.write(text) })
  const err = io.err ?? ((text: string) => { process.stderr.write(text) })

  const [command, ...rest] = argv
  const usage = (): number => { err(USAGE); return 2 }
  if (command === 'help' || command === '--help' || command === '-h') { out(USAGE); return 0 }
  if (command === '--version' || command === 'version') {
    if (rest.length) return usage()
    out(`agent-inbox-meshctl ${AGENT_INBOX_VERSION}\n`)
    return 0
  }
  if (command === 'unslop') {
    // async: the entry below runs it (runUnslop in src/unslop-client.ts)
    err(UNSLOP_USAGE)
    return 4
  }
  if (command === 'unslop-code') {
    // async: the entry below runs it (runUnslopCode in src/unslop-code-client.ts)
    err(UNSLOP_CODE_USAGE)
    return 4
  }
  if (command === 'request-post') {
    // async: the entry below runs it (runRequestPost in src/request-post-client.ts)
    err(REQUEST_POST_USAGE)
    return 4
  }
  if (command === 'add') {
    // async: the entry below runs it (runAdd)
    err(USAGE)
    return 4
  }
  if (command === 'new') {
    // async: the entry below runs it (runNew)
    err(USAGE)
    return 4
  }
  if (command === 'call') {
    // async: the entry below runs it (runCall in src/mesh-call.ts)
    err(CALL_USAGE)
    return 4
  }
  if (command === 'check') {
    // async: the entry below runs it (runCheck in src/mesh-check.ts)
    err(CHECK_USAGE)
    return 4
  }
  if (command === 'key') {
    if (rest[0] === 'help' || rest[0] === '--help') { out(KEY_USAGE); return 0 }
    return runKey(rest, { dir: resolve(meshDir(env, home)), show: (path) => shown(path, home), out, err })
  }
  const flags = new Set<string>()
  const values = new Map<string, string>()
  // `server` reads its own arguments (below)
  const parsed = command === 'server' ? [] : rest
  for (let i = 0; i < parsed.length; i++) {
    const arg = parsed[i]!
    if (['--port', '--checkout', '--endpoint', '--token-file', '--id', '--target', '--server', '--model'].includes(arg)) {
      const value = parsed[++i]
      if (value === undefined || values.has(arg)) return usage()
      values.set(arg, value)
    } else if (flags.has(arg)) return usage()
    else flags.add(arg)
  }
  // --json (D6) is enable's, disable's and remove's only; runMeshctl prints the plan
  if (flags.delete('--json') && !plan) return usage()
  // --server and --model (D5) are enable --unslop's and --unslop-code's only
  if ((values.has('--server') || values.has('--model')) && !(command === 'enable' && (flags.has('--unslop') || flags.has('--unslop-code')))) return usage()
  const apply = flags.delete('--apply')
  const unslop = flags.delete('--unslop')
  const requestPost = flags.delete('--request-post')
  const unslopCode = flags.delete('--unslop-code')
  if (command === 'forget-runs') {
    const all = flags.delete('--all')
    const id = values.get('--id')
    const picked: string[] = [...(unslop ? ['unslop'] : []), ...(unslopCode ? ['unslop-code'] : []), ...(requestPost ? ['request-post'] : []), ...(flags.delete('--web-search') ? ['web-search'] : []), ...(id === undefined ? [] : [id])]
    if (flags.size || [...values.keys()].some((key) => key !== '--id') || (all ? picked.length : picked.length !== 1) || (id !== undefined && idRefusal(id))) return usage()
    return forgetRuns(resolve(meshDir(env, home)), all ? 'all' : picked, apply, now().getTime(), out, err)
  }
  // after forget-runs, which has its own flags: --make-agents is not one of them
  const makeAgents = flags.delete('--make-agents')
  // one agent flag per command
  if (Number(unslop) + Number(requestPost) + Number(unslopCode) + Number(makeAgents) > 1) return usage()
  const only = (...names: string[]): boolean => [...values.keys()].every((key) => names.includes(key))

  const dir = resolve(meshDir(env, home))
  const file = meshFile(dir)
  const name = shown(file, home)
  const paths = unslopPaths(dir)
  const show = (path: string): string => shown(path, home)
  const refuse = (reason: string): number => { err(`Refused: ${reason}. Nothing changed.\n`); return 1 }
  const writeMesh = (doc: MeshDocument, replacing: boolean): string => {
    const backup = replacing ? ` (backup: ${show(writeBackup(file, now()))})` : ''
    writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, 0o644)
    return backup
  }
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const node = io.node ?? process.execPath
  const self = fileURLToPath(import.meta.url)
  const script = io.script ?? (self.endsWith('.js') ? self : join(repo, 'dist', 'meshctl.js'))
  // mesh.json without agents.<agent>: undefined when the file would be deleted (nothing else left)
  const withoutAgent = (existing: MeshRead, agent: string): MeshDocument | undefined => {
    if (existing.kind !== 'present') return undefined
    const agents = objectOf(existing.doc['agents'])
    if (!agents || !Object.hasOwn(agents, agent)) return existing.doc
    const { [agent]: _gone, ...others } = agents
    const next: MeshDocument = { ...existing.doc, agents: others }
    if (!Object.keys(others).length) delete next['agents']
    return Object.keys(next).length === 1 ? undefined : next
  }
  // the step that takes agents.<agent> out of mesh.json, deleting the file when nothing else is left
  const dropAgent = (existing: MeshRead, agent: string): Step | undefined => {
    const agents = existing.kind === 'present' ? objectOf(existing.doc['agents']) : undefined
    if (existing.kind !== 'present' || !agents || !Object.hasOwn(agents, agent)) return undefined
    const next = withoutAgent(existing, agent)
    return next === undefined
      ? {
          dry: `Would delete ${name}: agents.${agent} was its only setting (keeping a backup beside it).`,
          run: () => { const backup = writeBackup(file, now()); unlinkSync(file); return `Deleted ${name} (backup: ${show(backup)}).` },
        }
      : {
          dry: `Would remove agents.${agent} from ${name}, keeping every other key (and a backup beside it).`,
          run: () => `Removed agents.${agent} from ${name}${writeMesh(next, true)}.`,
        }
  }

  // #513: the routing skills follow the mesh.json a command leaves; a refusal there is a note,
  // never a reason to refuse the command itself
  const skillCtx = { dir, home, now: now(), show }
  const withSkills = (steps: Step[], doc: MeshDocument | undefined): Step[] => {
    const plan = skillPlan(skillCtx, doc)
    for (const words of plan.refused) err(`Note: ${words}.\n`)
    return [...steps, ...plan.steps]
  }
  // runSteps, holding the setup lock (scripts/setup-lock.sh) when a step changes a harness's skill folder
  const run = (steps: Step[], failed: string): number => {
    if (!apply || !steps.some((step) => step.lock)) return runSteps(steps, apply, out, err, failed, plan)
    const lock = holdSetupLock(env, home)
    if ('refused' in lock) return refuse(lock.refused)
    try {
      return runSteps(steps, apply, out, err, failed, plan)
    } finally {
      lock.release()
    }
  }

  // ── model servers (model servers step 1, D4) ──
  const sFile = serversFile(dir)
  const sName = show(sFile)
  // enable's --server and --model (D5): the server must be in servers.json, the model a plain name
  // a Claude Code server (Claude Code D2) takes haiku, sonnet or opus only: with no --model, a
  // profile's model is kept when it is already one of them, else it becomes sonnet. Without
  // --server the rule holds for the server the profile will name: the one it names now, or, for a
  // new profile, the one it copies from `copyFrom` (unslop's profile, for enable --unslop-code)
  const backendChoice = (profilePath: string, copyFrom?: string): BackendChoice | { refused: string } => {
    const server = values.get('--server')
    const model = values.get('--model')
    if (model !== undefined && !MODEL_NAME.test(model)) return { refused: 'a model name is 1 to 64 letters, digits, ".", "_", ":", "/" or "-"' }
    if (server === undefined) {
      if (model === undefined || CLAUDE_MODELS.includes(model)) return { model }
      const existing = readProfile(profilePath)
      const copied = existing === 'missing' && copyFrom !== undefined ? unslopBackend(copyFrom) : undefined
      const named = typeof existing === 'object' ? namedServer(existing.p) : copied && 'server' in copied ? copied.server : undefined
      return named !== undefined && claudeServer(named) ? { refused: `the server ${named} is Claude Code on this Mac: its models are haiku, sonnet and opus` } : { model }
    }
    if (!SERVER_NAME.test(server)) return { refused: SERVER_NAME_RULE }
    const read = readServers(dir)
    if (read.kind === 'refused') return { refused: `${sName} ${SERVERS_REASONS[read.reason]}` }
    if (read.kind === 'missing' || !Object.hasOwn(read.servers, server)) return { refused: `the server ${server} is not in ${sName}: meshctl server add ${server} adds it` }
    if (!isClaudeServer(read.servers[server]!)) return { server, model }
    if (model !== undefined) return CLAUDE_MODELS.includes(model) ? { server, model } : { refused: `the server ${server} is Claude Code on this Mac: its models are haiku, sonnet and opus` }
    const existing = readProfile(profilePath)
    const kept = typeof existing === 'object' && typeof existing.p['model'] === 'string' && CLAUDE_MODELS.includes(existing.p['model'])
    return { server, model: kept ? undefined : 'sonnet' }
  }
  /** Whether `server` is a Claude Code server in servers.json. */
  const claudeServer = (server: string): boolean => {
    const read = readServers(dir)
    return read.kind === 'present' && Object.hasOwn(read.servers, server) && isClaudeServer(read.servers[server]!)
  }
  // the one change enable makes to an existing profile (D5): server and model set, the inline
  // baseUrl and apiKey removed, every other key kept, a backup beside it; it names keys, never values
  const changeProfile = (path: string, choice: BackendChoice): Step | { refused: string } => {
    const read = readProfile(path)
    if (typeof read !== 'object') return { refused: `the profile ${show(path)} cannot be read (it must be a JSON object in a file you own with mode 0600), so enable cannot change it` }
    const { next, set, removed } = rewriteProfile(read.p, choice)
    if (!set.length && !removed.length) {
      return { dry: `Would keep the profile ${show(path)} (it already names the server and model given).`, run: () => `Kept ${show(path)}: it already names the server and model given.` }
    }
    const what = (removedWord: string): string => [...(set.length ? [`set ${set.join(' and ')}`] : []), ...(removed.length ? [`${removedWord} ${removed.join(' and ')}`] : [])].join('; ')
    return {
      dry: `Would change the profile ${show(path)} (keeping a backup beside it): ${what('remove')}; every other key stays.`,
      run: () => {
        const backup = writeBackup(path, now())
        writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600)
        return `Changed ${show(path)} (backup: ${show(backup)}): ${what('removed')}.`
      },
    }
  }

  if (command === 'server') {
    const [sub, ...args] = rest
    if (sub === 'check') {
      // async: the entry below runs it (runServerCheck in src/mesh-server-check.ts)
      err(SERVER_CHECK_USAGE)
      return 4
    }
    const names: string[] = []
    const opts = new Map<string, string>()
    const switches = new Set<string>()
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (['--base-url', '--key-file', '--key-env', '--from'].includes(arg)) {
        const value = args[++i]
        if (value === undefined || opts.has(arg)) return usage()
        opts.set(arg, value)
      } else if (arg.startsWith('-')) {
        if (switches.has(arg) || !['--apply', '--json', '--no-key', '--move', '--claude-code'].includes(arg)) return usage()
        switches.add(arg)
      } else names.push(arg)
    }
    // each subcommand's options and switches
    const allowed = {
      list: [[], ['--json']],
      add: [['--base-url', '--key-file', '--key-env', '--from'],
        ['--apply', '--json', '--no-key', '--move', '--claude-code']],
      set: [['--base-url', '--key-file', '--key-env'], ['--apply', '--json', '--no-key']],
      remove: [[], ['--apply', '--json']],
    }
    if (sub !== 'list' && sub !== 'add' && sub !== 'set' && sub !== 'remove') return usage()
    const [optsOk, switchesOk] = allowed[sub]
    if ([...opts.keys()].some((key) => !optsOk!.includes(key)) || [...switches].some((key) => !switchesOk!.includes(key))) return usage()
    if (names.length !== (sub === 'list' ? 0 : 1)) return usage()
    const sApply = switches.has('--apply')
    const read = readServers(dir)

    if (sub === 'list') {
      const users = serverUsers(dir).on
      const listed = read.kind === 'present' ? read.servers : {}
      const rows = Object.entries(listed).map(([name, entry]) => ({
        // a Claude Code row keeps baseUrl "" and key "none", the shape an older app's bridge requires
        name, kind: isClaudeServer(entry) ? 'claude-code' : 'http', baseUrl: isClaudeServer(entry) ? '' : entry.baseUrl, key: keyKind(entry), agents: users.get(name) ?? [],
      }))
      const inline = LOCAL_AGENTS.filter((agent) => {
        const profile = readProfile(profileFile(dir, agent))
        return typeof profile === 'object' && inlineSettings(profile.p) !== undefined
      })
      const refused = read.kind === 'refused' ? `${sName} ${SERVERS_REASONS[read.reason]}` : undefined
      if (switches.has('--json')) {
        out(`${JSON.stringify({ servers: rows, inline, ...(refused ? { refused } : {}) })}\n`)
        return refused ? 1 : 0
      }
      if (refused) out(`Model servers: ${refused}, so no agent can use a server. Fix or remove it by hand.\n`)
      else if (read.kind === 'missing') out(`No model servers: ${sName} is missing (meshctl server add <name> --base-url <url> adds one).\n`)
      else if (!rows.length) out(`No model servers in ${sName}.\n`)
      else out(`Model servers in ${sName}:\n${rows.map((row) => `${serverLine(row.name, listed[row.name]!, row.agents)}\n`).join('')}`)
      if (inline.length) out(`Inline settings: the ${inline.join(' and ')} profile${inline.length === 1 ? ' holds' : 's hold'} baseUrl itself (meshctl server add <name> --from <agent> --move turns that into a server).\n`)
      return refused ? 1 : 0
    }

    const server = names[0]!
    if (!SERVER_NAME.test(server)) return refuse(SERVER_NAME_RULE)
    if (read.kind === 'refused') return refuse(`${sName} ${SERVERS_REASONS[read.reason]}. Fix or remove it by hand`)
    const present = read.kind === 'present'
    const current = read.kind === 'present' ? read.servers : {}
    const writeServers = (servers: Record<string, ServerEntry>, replacing: boolean): string => {
      mkdirSync(join(dir, 'mesh'), { recursive: true, mode: 0o700 })
      const backup = replacing ? ` (backup: ${show(writeBackup(sFile, now()))})` : ''
      writeAtomic(sFile, serversText(servers), 0o600)
      return backup
    }
    const failed = 'Steps before it are done; nothing after it ran.'
    // the key option of add and set: a key source, null for --no-key, undefined when none is given
    const keyGiven = [opts.has('--key-file'), opts.has('--key-env'), switches.has('--no-key')].filter(Boolean).length
    if (keyGiven > 1) return usage()
    // --claude-code (Claude Code D2) stands alone: no address, no key option, no --from (add's only
    // value options) and no --move
    const claude = switches.has('--claude-code')
    if (claude && (opts.size || switches.has('--no-key') || switches.has('--move'))) return usage()
    let key: KeySource | null | undefined
    if (opts.has('--key-file')) {
      const bad = keyFileRefusal(opts.get('--key-file')!)
      if (bad) return refuse(bad)
      key = { file: opts.get('--key-file')! }
    } else if (opts.has('--key-env')) {
      key = { env: opts.get('--key-env')! }
      if (!isKeySource(key)) return refuse('the key variable\'s name must be letters, digits and "_", not starting with a digit')
    } else if (switches.has('--no-key')) key = null
    const url = opts.get('--base-url')
    const urlBad = url === undefined ? undefined : baseUrlRefusal(url)

    if (sub === 'add') {
      const from = opts.get('--from')
      if (!claude && (from === undefined ? url === undefined || !keyGiven || switches.has('--move') : url !== undefined || keyGiven)) return usage()
      if (Object.hasOwn(current, server)) return refuse(`the server ${server} is already in ${sName}: meshctl server set changes it`)
      if (Object.keys(current).length >= SERVERS_MAX) return refuse(`${sName} already holds ${SERVERS_MAX} servers, the most it may`)
      const steps: Step[] = []
      const create = (what: string, done: string, sep = ','): Step => ({
        dry: present ? `Would add the server ${server} to ${sName}${sep} ${what}, keeping every other server (and a backup beside it).` : `Would create ${sName} (0600) with the server ${server}${sep} ${what}.`,
        run: () => `Added the server ${server} to ${sName}${writeServers({ ...current, [server]: entry }, present)}${done}.`,
      })
      let entry: ServerEntry
      if (claude) {
        entry = { kind: 'claude-code' }
        steps.push(create('Claude Code on this Mac (its model calls run the claude program; the text goes to Anthropic)', ': Claude Code on this Mac', ':'))
      } else if (from === undefined) {
        if (urlBad) return refuse(urlBad)
        entry = { baseUrl: url!, ...(key ? { apiKey: key } : {}) }
        steps.push(create(`at ${entry.baseUrl}, key: ${keyKind(entry)}`, `: at ${entry.baseUrl}, key: ${keyKind(entry)}`))
      } else {
        if (from !== 'unslop' && from !== 'unslop-code') return refuse('--from takes a local agent: unslop or unslop-code')
        const path = profileFile(dir, from)
        const profile = readProfile(path)
        if (profile === 'missing') return refuse(`the ${from} profile ${show(path)} is missing: meshctl enable --${from} writes it`)
        if (profile === 'unreadable') return refuse(`the ${from} profile ${show(path)} cannot be read (it must be a JSON object in a file you own with mode 0600)`)
        if (Object.hasOwn(profile.p, 'server')) {
          const named = namedServer(profile.p)
          return refuse(`the ${from} profile already names ${named === undefined ? 'a server' : `the server ${named}`}`)
        }
        const inline = inlineSettings(profile.p)
        if (!inline) return refuse(`the ${from} profile's baseUrl and apiKey are not filled in, or break the servers.json rule (https://, or http:// on a loopback address; a key source, never a key)`)
        entry = inline
        const keyed = Object.hasOwn(inline, 'apiKey')
        // the words enable --unslop-code uses for settings it copies: neither value is printed
        steps.push(create(`taking baseUrl${keyed ? ' and the apiKey source' : ''} from ${show(path)} (not printed)`, `, with the ${from} profile's settings (not printed)`))
        if (switches.has('--move')) {
          const { next } = rewriteProfile(profile.p, { server })
          steps.push({
            dry: `Would rewrite the profile ${show(path)} to name the server ${server}, removing baseUrl${keyed ? ' and apiKey' : ''} and keeping every other key (and a backup beside it).`,
            run: () => {
              const backup = writeBackup(path, now())
              writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600)
              return `Rewrote ${show(path)} (backup: ${show(backup)}): it names the server ${server}.`
            },
          })
        }
      }
      return runSteps(steps, sApply, out, err, failed, plan)
    }

    if (sub === 'set') {
      if (url === undefined && !keyGiven) return usage()
      if (!Object.hasOwn(current, server)) return refuse(`the server ${server} is not in ${sName}: meshctl server add adds it`)
      const old = current[server]!
      if (isClaudeServer(old)) return refuse(`the server ${server} is Claude Code on this Mac: it has no address or key to change`)
      if (urlBad) return refuse(urlBad)
      const apiKey = keyGiven ? key ?? undefined : old.apiKey
      const entry = { baseUrl: url ?? old.baseUrl, ...(apiKey ? { apiKey } : {}) }
      const changes = [
        ...(entry.baseUrl !== old.baseUrl ? [`address to ${entry.baseUrl}`] : []),
        ...(JSON.stringify(entry.apiKey ?? null) !== JSON.stringify(old.apiKey ?? null) ? [`key to ${keyKind(entry)}`] : []),
      ].join(' and ')
      if (!changes) {
        out(`The server ${server} already has these settings in ${sName}. Nothing to do.\n`)
        return 0
      }
      const users = serverUsers(dir).on.get(server) ?? []
      const restart = users.length
        ? ` The ${users.join(' and ')} profile${users.length === 1 ? ' names' : 's name'} it: its agent stops within a minute and starts with the new settings on the next call.`
        : ''
      return runSteps([{
        dry: `Would change the server ${server} in ${sName} (keeping a backup beside it): ${changes}.${restart}`,
        run: () => `Changed the server ${server} in ${sName}${writeServers({ ...current, [server]: entry }, true)}: ${changes}.${restart}`,
      }], sApply, out, err, failed, plan)
    }

    // remove
    if (!Object.hasOwn(current, server)) {
      out(`The server ${server} is not in ${sName}. Nothing to do.\n`)
      return 0
    }
    const naming = serverUsers(dir)
    const users = naming.on.get(server) ?? []
    const madeUsers = users.filter((agent) => !(LOCAL_AGENTS as readonly string[]).includes(agent))
    if (users.length && !madeUsers.length) {
      return refuse(`the server ${server} is named by the ${users.join(' and ')} profile${users.length === 1 ? '' : 's'}: point ${users.length === 1 ? 'it' : 'them'} at another server first (meshctl enable --<agent> --server <name>)`)
    }
    if (users.length) {
      const local = users.filter((agent) => !madeUsers.includes(agent))
      const who = [...(local.length ? [`the ${local.join(' and ')} profile${local.length === 1 ? '' : 's'}`] : []), `the made agent${madeUsers.length === 1 ? '' : 's'} ${madeUsers.join(' and ')}`].join(' and ')
      const fixes = [...(local.length ? [`point ${local.length === 1 ? 'that profile' : 'those profiles'} at another server (meshctl enable --<agent> --server <name>)`] : []), `remove ${madeUsers.length === 1 ? 'that agent' : 'those agents'} (meshctl remove <id> --apply)`].join(' and ')
      return refuse(`the server ${server} is named by ${who}: ${fixes} first`)
    }
    // an agent that is off keeps its profile; it does not hold the server, and says so
    const kept = naming.kept.get(server) ?? []
    const still = kept.length ? ` The kept settings of ${kept.join(' and ')} still name it: turning ${kept.length === 1 ? 'that agent' : 'those agents'} on again needs --server <name>.` : ''
    const { [server]: _gone, ...others } = current
    return runSteps([Object.keys(others).length ? {
      dry: `Would remove the server ${server} from ${sName}, keeping every other server (and a backup beside it).${still}`,
      run: () => `Removed the server ${server} from ${sName}${writeServers(others, true)}.${still}`,
    } : {
      dry: `Would delete ${sName}: the server ${server} was its only one (keeping a backup beside it).${still}`,
      run: () => { const backup = writeBackup(sFile, now()); unlinkSync(sFile); return `Deleted ${sName} (backup: ${show(backup)}).${still}` },
    }], sApply, out, err, failed, plan)
  }

  if (command === 'skills') {
    const sub = rest[0]
    if ((sub !== 'link' && sub !== 'unlink') || !flags.delete(sub) || flags.size || !only('--target') || unslop || requestPost || unslopCode || makeAgents) return usage()
    const target = values.get('--target') ?? 'all'
    if (target !== 'all' && !SKILL_TARGETS.includes(target as SkillTarget)) return usage()
    const targets = target === 'all' ? SKILL_TARGETS : [target as SkillTarget]
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}`)
    const plan = skillPlan(skillCtx, existing.kind === 'present' ? existing.doc : undefined, sub === 'link' ? { link: targets } : { unlink: targets })
    // unlink changes links only; the folders follow mesh.json
    const steps = sub === 'link' ? plan.steps : plan.steps.filter((step) => step.lock)
    for (const words of plan.refused) err(`Refused: ${words}.\n`)
    const code = steps.length
      ? run(steps, 'Steps before it are done; nothing after it ran.')
      : (out(sub === 'link' && !plan.agents.length && !plan.refused.length ? `No agent with a routing skill is on in ${name}. Nothing to link.\n` : 'Nothing to do.\n'), 0)
    return code || (plan.refused.length ? 1 : 0)
  }

  if (command === 'status') {
    if (flags.size || values.size || apply || unslop || requestPost || unslopCode || makeAgents) return usage()
    out(`${ALWAYS_ON}\n`)
    const existing = readMesh(file)
    const agents = existing.kind === 'present' ? objectOf(existing.doc['agents']) : undefined
    const entry = agents?.['unslop']
    const port = entry === undefined ? undefined : loopbackPort(objectOf(entry)?.['endpoint'])
    const codeEntry = agents?.['unslop-code']
    const codePort = codeEntry === undefined ? undefined : loopbackPort(objectOf(codeEntry)?.['endpoint'])
    const rpEntry = agents?.['request-post']
    const rpEndpoint = rpEntry === undefined ? undefined : requestPostEndpoint(objectOf(rpEntry)?.['endpoint'])
    const added = Object.entries(agents ?? {}).flatMap(([id, value]) => {
      const read = addedEntry(id, value)
      return read === undefined ? [] : [{ id, read }]
    })
    const valid = added.filter((a) => a.read !== 'invalid').length
    // makeAgents is a switch of its own, not an agent: only the value true turns it on
    const makeValue = existing.kind === 'present' ? existing.doc['makeAgents'] : undefined
    // the skill serves ~/.agent-inbox alone (skillPlan leaves it out of any other mesh dir), so it is not on elsewhere
    const makeHere = shownDir(dir, home) === DEFAULT_MESH_DIR
    const pieces = [...(port ? ['unslop'] : []), ...(codePort ? ['unslop-code'] : []), ...(rpEndpoint ? ['request-post'] : []), ...(makeValue === true && makeHere ? ['the make-agents skill'] : []), ...(valid ? [plural(valid, 'added agent')] : [])].join(' and ')
    if (existing.kind === 'missing') out(`Mesh: off. No ${name}.\n`)
    else if (existing.kind === 'refused') out(`Mesh: off. ${name} ${existing.reason}, so it is read as off.\n`)
    else out(pieces ? `Mesh: on. ${name} turns on ${pieces}.\n` : `Mesh: off. ${name} turns on no piece this build reads.\n`)
    const has = (path: string): string => (exists(path) ? 'present' : 'missing')
    const state = port ? `on at http://127.0.0.1:${port}` : entry === undefined ? 'off' : 'off (agents.unslop.endpoint is not http://127.0.0.1:<port>)'
    out(`Unslop: ${state}. Profile ${show(paths.profile)}: ${has(paths.profile)}; token: ${has(paths.token)}; shim ${show(paths.shim)}: ${has(paths.shim)}.\n`)
    // which server a local agent's profile names (D7); a name that breaks the rule is never echoed
    const namesLine = (agent: LocalAgent, label: string): void => {
      const read = readProfile(profileFile(dir, agent))
      if (typeof read !== 'object' || !Object.hasOwn(read.p, 'server')) return
      const server = namedServer(read.p)
      out(`${label} profile: ${server === undefined ? 'its "server" is not a server name' : `names the server ${server}`}.\n`)
    }
    namesLine('unslop', 'Unslop')
    const code = unslopCodePaths(dir)
    const codeState = codePort ? `on at http://127.0.0.1:${codePort}` : codeEntry === undefined ? 'off' : 'off (agents.unslop-code.endpoint is not http://127.0.0.1:<port>)'
    out(`Unslop-code: ${codeState}. Profile ${show(code.profile)}: ${has(code.profile)}; token: ${has(code.token)}; shim ${show(code.shim)}: ${has(code.shim)}.\n`)
    namesLine('unslop-code', 'Unslop-code')
    // the endpoint is printed only when it passed the rule, so it can hold no token
    const rp = requestPostPaths(dir)
    const rpState = rpEndpoint ? `on at ${rpEndpoint}` : rpEntry === undefined ? 'off' : `off (agents.request-post.endpoint is not ${ENDPOINT_RULE})`
    out(`Request-post: ${rpState}. Token: ${has(rp.token)}; shim ${show(rp.shim)}: ${has(rp.shim)}.\n`)
    if (makeValue === undefined) out('Make-agents skill: off.\n')
    else if (makeValue !== true) out(`Make-agents skill: off (makeAgents in ${name} is not true).\n`)
    else if (!makeHere) out(`Make-agents skill: off (the mesh dir is not ${DEFAULT_MESH_DIR}).\n`)
    else {
      const state = skillState({ dir, home }, 'make-agents')
      const yes = (host: 'claude' | 'agents'): string => (state.hosts[host] === 'linked' ? 'yes' : 'no')
      // a skills folder or agent folder that is a file or a link is refused by enable, so it is no rewrite to advise
      const fileWords = state.file === 'blocked' ? `blocked: ${show(state.blocker!)} is not a folder meshctl wrote` : state.file === 'present' ? 'present' : `${state.file} (meshctl enable --make-agents --apply rewrites it)`
      out(`Make-agents skill: on. ${show(join(dir, 'skills', 'make-agents', 'SKILL.md'))}: ${fileWords}; linked for Claude Code: ${yes('claude')}; for Codex and Copilot CLI: ${yes('agents')}.\n`)
    }
    // a made agent (D6) says so, with its server and model; never its instructions or a path
    const madeWords = (id: string): string => {
      const made = madePaths(dir, id)
      if (!exists(made.description) && !(exists(made.profile) && madeProfile(dir, id) !== 'missing')) return ''
      const read = madeDescription(dir, id)
      return typeof read === 'object' ? `; made here, on the server ${read.card.server} with the model ${read.card.model}`
        : `; made here, but its description ${read === 'missing' ? 'is missing' : 'cannot be read or breaks the rule'} (meshctl remove ${id} --apply, then make it again)`
    }
    // an id or field that breaks its rule is never echoed: it is a hand edit, and could hold anything
    for (const { id, read } of added) {
      const who = idRefusal(id) ? 'an entry with an id meshctl add refuses' : id
      out(read === 'invalid'
        ? `Added agent ${who}: off (the entry breaks meshctl add's rules; remove it and add it again).\n`
        : `Added agent ${id}: at ${read.endpoint}${read.agentId === undefined ? '' : ` (agent id ${read.agentId})`}; card pin ${read.cardSha256.slice(0, 12)}…; token: ${read.tokenFile === undefined ? 'none' : has(read.tokenFile)}${madeWords(id)}.\n`)
    }
    // one line per model server (D7); a missing servers.json prints nothing
    const servers = readServers(dir)
    if (servers.kind === 'refused') out(`Model servers: ${sName} ${SERVERS_REASONS[servers.reason]}, so no agent can use a server.\n`)
    else if (servers.kind === 'present') {
      const users = serverUsers(dir).on
      for (const [server, entry] of Object.entries(servers.servers)) out(`${serverLine(server, entry, users.get(server) ?? [])}\n`)
    }
    return existing.kind === 'refused' ? 1 : 0
  }

  if (command === 'remove') {
    const ids = rest.filter((arg) => arg !== '--apply' && arg !== '--json')
    if (ids.length !== 1 || rest.length > 3 || ids[0]!.startsWith('-')) return usage()
    const id = ids[0]!
    const bad = idRefusal(id)
    if (bad) return refuse(BUILT_IN_AGENTS.includes(id) ? `${id} is a built-in agent: meshctl disable turns it off` : bad)
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const agents = existing.kind === 'present' ? objectOf(existing.doc['agents']) : undefined
    if (agents && Object.hasOwn(agents, id) && addedEntry(id, agents[id]) === undefined) return refuse(`agents.${id} was not written by meshctl add, so remove leaves it alone`)
    const tokens = join(dir, 'mesh', 'tokens')
    const token = join(tokens, id)
    const drop = dropAgent(existing, id)
    const steps: Step[] = drop ? [drop] : []
    // its run history goes with it, so an agent added later under this id starts with none (V5 §5.9)
    const files = runFiles(dir, id)
    if (files.length) {
      const what = `${plural(files.length, 'run file')} (${plural(files.reduce((n, f) => n + f.runs, 0), 'run')}) for ${id}`
      steps.push({
        dry: `Would delete ${what}.`,
        run: () => { for (const f of files) unlinkSync(f.path); tidyRuns(dir); removeIfEmpty(join(dir, 'mesh')); return `Deleted ${what}.` },
      })
    }
    if (exists(token)) {
      steps.push({
        dry: `Would delete the token copy ${show(token)}.`,
        run: () => { unlinkSync(token); removeIfEmpty(tokens); removeIfEmpty(join(dir, 'mesh')); return `Deleted ${show(token)}.` },
      })
    }
    // the card copy the app shows (Agent cards step 1, D6) goes with its entry
    const cardCopy = cardCopyFile(dir, id)
    if (exists(cardCopy)) {
      steps.push({
        dry: `Would delete the card copy ${show(cardCopy)}.`,
        run: () => { removeCardCopy(dir, id); removeIfEmpty(join(dir, 'mesh')); return `Deleted ${show(cardCopy)}.` },
      })
    }
    // a made agent's own files (agents a chat makes, D5): its start profile and description; its
    // runner learns at its next gate tick, the entry being gone. Its logs (the exact names a made
    // agent's runner writes) go whenever they exist, so a failed new's start log can be deleted too
    const made = madePaths(dir, id)
    const remove = (path: string, dry: string): void => {
      if (exists(path)) steps.push({ dry, run: () => { unlinkSync(path); removeIfEmpty(join(path, '..')); removeIfEmpty(join(dir, 'mesh')); return `Deleted ${show(path)}.` } })
    }
    if (exists(made.description) || (exists(made.profile) && madeProfile(dir, id) !== 'missing')) {
      remove(made.profile, `Would delete the start profile ${show(made.profile)}; a running ${id} stops within a minute.`)
      remove(made.description, `Would delete the description ${show(made.description)}.`)
    }
    const logs = join(dir, 'mesh', 'logs')
    let logFiles: string[] = []
    try {
      if (lstatSync(logs).isDirectory()) logFiles = readdirSync(logs).filter((entry) => madeLog(id).test(entry)).sort()
    } catch { /* no logs */ }
    for (const log of logFiles) remove(join(logs, log), `Would delete the log ${show(join(logs, log))}.`)
    if (!steps.length) {
      out(`${id} is not in ${name}. Nothing to do.\n`)
      return 0
    }
    return runSteps(steps, apply, out, err, 'Steps before it are done; nothing after it ran.', plan)
  }

  // ── make-agents (the routing skill that teaches a chat to make an agent with `new`) ──
  // Its switch is a top-level `makeAgents: true`, never an `agents` entry: the app and `status` count every
  // `agents` key as an agent, and routingSkills() reads this key from the mesh.json a command leaves.
  if (command === 'enable' && makeAgents) {
    if (flags.size || values.size) return usage()
    // the skill's commands run ~/.agent-inbox/bin/meshctl, a shim that sets no mesh dir
    if (shownDir(dir, home) !== DEFAULT_MESH_DIR) return refuse(`the make-agents skill runs ~/.agent-inbox/bin/meshctl, which acts on ~/.agent-inbox, but the mesh dir is ${shownDir(dir, home)}`)
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const doc: MeshDocument = existing.kind === 'present' ? existing.doc : { schema: MESH_SCHEMA }
    const next: MeshDocument = { ...doc, makeAgents: true }
    const current = existing.kind === 'present' && doc['makeAgents'] === true
    // here the skill is the whole effect, so a skill that cannot be written refuses the command; another agent's stays a note
    const skills = skillPlan(skillCtx, next)
    const blocked = skills.refused.find((words) => words.endsWith('so the make-agents routing skill is not written'))
    for (const words of skills.refused) if (words !== blocked) err(`Note: ${words}.\n`)
    if (!skills.agents.includes('make-agents')) return refuse(blocked ?? 'the make-agents routing skill cannot be written')
    const json = `${JSON.stringify(next, null, 2)}\n`
    const last: Step = current ? { dry: `Would keep ${name} (the make-agents skill is on).`, run: () => `Kept ${name}: the make-agents skill is on.` } : {
      dry: `Would ${existing.kind === 'present' ? 'replace' : 'create'} ${name}${existing.kind === 'present' ? ' (keeping a backup beside it)' : ''}:\n${json}`,
      run: () => `Wrote ${name}${writeMesh(next, existing.kind === 'present')}: the make-agents skill is on.`,
    }
    // the routing skill goes before the switch, which stays the last thing written
    const code = run([...skills.steps, last], `Steps before it are done; ${name} was not changed.`)
    if (apply && code === 0) {
      // skills link would link it: say so when a link is missing and nothing of that name blocks one
      const state = skillState({ dir, home }, 'make-agents')
      const hosts = Object.values(state.hosts)
      if (hosts.includes('missing') && !hosts.includes('foreign') && state.copilot !== 'foreign') out('Next: meshctl skills link --apply links it for Claude Code, Codex and Copilot CLI.\n')
    }
    return code
  }

  if (command === 'disable' && makeAgents) {
    if (flags.size || values.size) return usage()
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const present = existing.kind === 'present' && Object.hasOwn(existing.doc, 'makeAgents')
    let next: MeshDocument | undefined
    // the switch goes last, like enable's: a failure in the middle leaves it on with the skill still there, which agree
    const drop: Step[] = []
    if (existing.kind === 'present') {
      const { makeAgents: _gone, ...others } = existing.doc
      next = present ? (Object.keys(others).length === 1 ? undefined : others) : existing.doc
      if (present) {
        drop.push(next === undefined
          ? {
              dry: `Would delete ${name}: makeAgents was its only setting (keeping a backup beside it).`,
              run: () => { const backup = writeBackup(file, now()); unlinkSync(file); return `Deleted ${name} (backup: ${show(backup)}).` },
            }
          : {
              dry: `Would remove makeAgents from ${name}, keeping every other key (and a backup beside it).`,
              run: () => `Removed makeAgents from ${name}${writeMesh(others, true)}.`,
            })
      }
    }
    const steps = [...withSkills([], next), ...drop]
    if (!steps.length) {
      out('The make-agents skill is already off. Nothing to do.\n')
      return 0
    }
    return run(steps, 'Steps before it are done; nothing after it ran.')
  }

  if (command === 'enable' && !unslop && !requestPost && !unslopCode && !makeAgents) {
    if (!flags.delete('--agents-view') || flags.size || values.size) return usage()
    out(`${ALWAYS_ON} Nothing written.\n`)
    return 0
  }

  if (command === 'enable' && requestPost) {
    const endpointText = values.get('--endpoint')
    const tokenFile = values.get('--token-file')
    if (flags.size || !only('--endpoint', '--token-file') || endpointText === undefined || tokenFile === undefined) return usage()
    const endpoint = requestPostEndpoint(endpointText)
    if (!endpoint) return refuse(`the endpoint must be ${ENDPOINT_RULE}: never a public host, another IP address, plain http to another host, or port 80 there`)
    // §8.8 (#557): the bearer token goes only to a name in this Mac's tailnet; the SSH fallback never asks
    if (endpoint.startsWith('https:')) {
      const suffix = (io.tailnet ?? magicDnsSuffix)()
      if (suffix === undefined) return refuse('the endpoint is on a tailnet name, but this Mac\'s tailnet could not be read (is Tailscale installed, running and logged in?), so enable cannot tell it from another tailnet or a Funnel host')
      if (!inTailnet(new URL(endpoint).hostname, suffix)) return refuse(`the endpoint is on another tailnet or a Funnel host, not this Mac's tailnet (${suffix}): use the service's name on this Mac's tailnet, or the SSH fallback's http://127.0.0.1:<port>`)
    }
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const doc: MeshDocument = existing.kind === 'present' ? existing.doc : { schema: MESH_SCHEMA }
    const agents = doc['agents'] === undefined ? {} : objectOf(doc['agents'])
    if (!agents) return refuse(`${name} has an "agents" value that is not an object`)
    const source = resolve(tokenFile)
    const read = readTokenFile(source)
    if ('refused' in read) return refuse(read.refused)
    if (!isFile(script)) return refuse(`${show(script)} is missing: run npm run build in ${show(repo)}`)
    if ([node, script, dir].some((path) => /[\x00-\x1f\x7f]/.test(path))) return refuse('a path holds a control character')
    const rp = requestPostPaths(dir)
    const wanted = { endpoint }
    const next: MeshDocument = { ...doc, agents: { ...agents, 'request-post': wanted } }
    const current = existing.kind === 'present' && JSON.stringify(agents['request-post']) === JSON.stringify(wanted)
    const shim = shimText('request-post', 500, node, script, dir)
    const json = `${JSON.stringify(next, null, 2)}\n`
    const dirs = (): void => {
      for (const d of [rp.tokens, rp.bin]) mkdirSync(d, { recursive: true, mode: 0o700 })
    }
    const steps: Step[] = [
      {
        dry: `Would copy the bearer token in ${show(source)} to ${show(rp.token)} (0600${exists(rp.token) ? ', replacing the one there' : ''}); it is never printed.`,
        run: () => { dirs(); writeAtomic(rp.token, `${read.token}\n`, 0o600); return `Copied the token to ${show(rp.token)}.` },
      },
      {
        dry: `Would write the shim ${show(rp.shim)} (0755):\n${shim}`,
        run: () => { dirs(); writeAtomic(rp.shim, shim, 0o755); return `Wrote ${show(rp.shim)}.` },
      },
      current ? { dry: `Would keep ${name} (request-post is on at ${endpoint}).`, run: () => `Kept ${name}: request-post is on at ${endpoint}.` } : {
        dry: `Would ${existing.kind === 'present' ? 'replace' : 'create'} ${name}${existing.kind === 'present' ? ' (keeping a backup beside it)' : ''}:\n${json}`,
        run: () => `Wrote ${name}${writeMesh(next, existing.kind === 'present')}: request-post is on at ${endpoint}.`,
      },
    ]
    // the routing skill goes before the switch, which stays the last thing written
    const last = steps.pop()!
    return run([...withSkills(steps, next), last], `Steps before it are done; ${name} was not changed.`)
  }

  if (command === 'disable' && requestPost) {
    const purge = flags.delete('--purge')
    if (flags.size || values.size) return usage()
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const rp = requestPostPaths(dir)
    const drop = dropAgent(existing, 'request-post')
    const head: Step[] = drop ? [drop] : []
    // --purge removes its run records and nothing else (cards view V5 §5.6)
    for (const run of purge ? runFiles(dir, 'request-post') : []) {
      head.push({ dry: `Would delete ${show(run.path)}.`, run: () => { unlinkSync(run.path); tidyRuns(dir); removeIfEmpty(rp.root); return `Deleted ${show(run.path)}.` } })
    }
    for (const [path, parents] of [[rp.shim, [rp.bin]], [rp.token, [rp.tokens, rp.root]]] as const) {
      if (exists(path)) head.push({ dry: `Would delete ${show(path)}.`, run: () => { unlinkSync(path); parents.forEach(removeIfEmpty); return `Deleted ${show(path)}.` } })
    }
    const steps = withSkills(head, withoutAgent(existing, 'request-post'))
    if (!steps.length) {
      out(`Request-post is already off${purge ? ' and purged' : ''}. Nothing to do.\n`)
      return 0
    }
    return run(steps, 'Steps before it are done; nothing after it ran.')
  }

  if (command === 'enable' && unslopCode) {
    if (flags.size || !only('--port', '--checkout', '--server', '--model')) return usage()
    const portText = values.get('--port') ?? String(UNSLOP_CODE_PORT)
    const port = /^\d{1,5}$/.test(portText) ? loopbackPort(`http://127.0.0.1:${portText}`) : undefined
    if (!port) return refuse('the port must be a number from 1 to 65535 other than 80; the endpoint is always http://127.0.0.1:<port>')
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const doc: MeshDocument = existing.kind === 'present' ? existing.doc : { schema: MESH_SCHEMA }
    const agents = doc['agents'] === undefined ? {} : objectOf(doc['agents'])
    if (!agents) return refuse(`${name} has an "agents" value that is not an object`)
    // two agents on one port: whichever started first would answer the other's calls
    const portOf = (value: unknown): number | undefined => {
      const endpoint = objectOf(value)?.['endpoint']
      return typeof endpoint === 'string' ? Number(/^http:\/\/127\.0\.0\.1:(\d{1,5})(?:\/|$)/.exec(endpoint)?.[1]) || undefined : undefined
    }
    const clash = Object.entries(agents).find(([key, value]) => key !== 'unslop-code' && portOf(value) === port)?.[0]
    // a key that breaks the id rule is a hand edit, never echoed
    if (clash !== undefined) return refuse(`port ${port} is the endpoint of ${BUILT_IN_AGENTS.includes(clash) || !idRefusal(clash) ? `agents.${clash}` : 'another agent entry'} in ${name}: pass --port <another>`)
    const wanted = { endpoint: `http://127.0.0.1:${port}`, profile: 'unslop-code' }
    const next: MeshDocument = { ...doc, agents: { ...agents, 'unslop-code': wanted } }
    const current = existing.kind === 'present' && JSON.stringify(agents['unslop-code']) === JSON.stringify(wanted)

    const checkout = resolve(values.get('--checkout') ?? repo)
    const wrap = join(checkout, 'packages', 'mesh', 'dist', 'wrap.js')
    if (!isFile(wrap)) {
      return refuse(isFile(join(checkout, 'packages', 'mesh', 'package.json'))
        ? `${show(wrap)} is missing: run npm ci && npm run build in ${show(join(checkout, 'packages', 'mesh'))} (Node 24)`
        : `${show(checkout)} is not an agent-inbox checkout: pass --checkout <path of one>`)
    }
    if (!isFile(script)) return refuse(`${show(script)} is missing: run npm run build in ${show(repo)}`)
    if ([node, wrap, script, dir].some((path) => /[\x00-\x1f\x7f]/.test(path))) return refuse('a path holds a control character')
    const code = unslopCodePaths(dir)
    const choice = backendChoice(code.profile, paths.profile)
    if ('refused' in choice) return refuse(choice.refused)
    const start = [node, wrap, '--agent', 'openai-compatible', '--profile', 'unslop-code']
    // --server names a server; without it the profile takes unslop's backend, inline or the server it names (D5)
    const backend: Backend | undefined = choice.server !== undefined ? { server: choice.server } : unslopBackend(paths.profile)
    // a Claude Code server taken from unslop's profile, with no --model, gets sonnet (Claude Code D2)
    const copiedClaude = choice.server === undefined && choice.model === undefined && backend !== undefined && 'server' in backend && claudeServer(backend.server)
    const template = codeProfileTemplate(start, backend, copiedClaude ? 'sonnet' : choice.model)
    // the dry run shows where the backend comes from, never the URL or the key source
    const hidden = '(taken from the unslop profile; not printed)'
    const shownTemplate = backend && 'baseUrl' in backend ? codeProfileTemplate(start, { baseUrl: hidden, ...(Object.hasOwn(backend, 'apiKey') ? { apiKey: hidden } : {}) }, choice.model) : template
    const changed = exists(code.profile) && (choice.server !== undefined || choice.model !== undefined) ? changeProfile(code.profile, choice) : undefined
    if (changed && 'refused' in changed) return refuse(changed.refused)
    const shim = shimText('unslop-code', 652, node, script, dir, false)
    const json = `${JSON.stringify(next, null, 2)}\n`
    const dirs = (): void => {
      for (const d of [code.wrappers, code.tokens, code.bin]) mkdirSync(d, { recursive: true, mode: 0o700 })
    }

    const steps: Step[] = [
      exists(code.token)
        ? { dry: `Would keep the caller token ${show(code.token)} (present).`, run: () => `Kept ${show(code.token)}.` }
        : {
            dry: `Would write a new random caller token to ${show(code.token)} (0600).`,
            run: () => { dirs(); writeNew(code.token, `${randomBytes(32).toString('base64url')}\n`, 0o600, true); return `Wrote ${show(code.token)}.` },
          },
      changed ?? (exists(code.profile)
        ? {
            dry: `Would keep the profile ${show(code.profile)} (present; never overwritten).`,
            run: () => `Kept ${show(code.profile)}. If Node or the checkout moved, set its "start" by hand to ${JSON.stringify(start)}.`,
          }
        : {
            dry: backend && 'server' in backend
              ? `Would write the profile ${show(code.profile)} (0600), naming the server ${backend.server}${choice.server === undefined ? `, as ${show(paths.profile)} does` : ''}:\n${template}`
              : backend
                ? `Would write the profile ${show(code.profile)} (0600), taking baseUrl${Object.hasOwn(backend, 'apiKey') ? ' and the apiKey source' : ''} from ${show(paths.profile)} (not printed):\n${shownTemplate}`
                : `Would write the profile template ${show(code.profile)} (0600):\n${template}`,
            run: () => {
              dirs()
              writeNew(code.profile, template, 0o600, true)
              return backend && 'server' in backend ? `Wrote ${show(code.profile)}: it names the server ${backend.server}.`
                : backend ? `Wrote ${show(code.profile)} with the unslop profile's backend.` : `Wrote ${show(code.profile)}: fill in baseUrl and apiKey.`
            },
          }),
      {
        dry: `Would write the shim ${show(code.shim)} (0755):\n${shim}`,
        run: () => { dirs(); writeAtomic(code.shim, shim, 0o755); return `Wrote ${show(code.shim)}.` },
      },
      current ? { dry: `Would keep ${name} (unslop-code is on at ${wanted.endpoint}).`, run: () => `Kept ${name}: unslop-code is on at ${wanted.endpoint}.` } : {
        dry: `Would ${existing.kind === 'present' ? 'replace' : 'create'} ${name}${existing.kind === 'present' ? ' (keeping a backup beside it)' : ''}:\n${json}`,
        run: () => `Wrote ${name}${writeMesh(next, existing.kind === 'present')}: unslop-code is on at http://127.0.0.1:${port}.`,
      },
    ]
    // the routing skill goes before the switch, which stays the last thing written
    const last = steps.pop()!
    return run([...withSkills(steps, next), last], `Steps before it are done; ${name} was not changed.`)
  }

  if (command === 'disable' && unslopCode) {
    const purge = flags.delete('--purge')
    if (flags.size || values.size) return usage()
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const code = unslopCodePaths(dir)
    const drop = dropAgent(existing, 'unslop-code')
    const steps: Step[] = drop ? [drop] : []
    const remove = (path: string, parent?: string): void => {
      if (exists(path)) steps.push({ dry: `Would delete ${show(path)}.`, run: () => { unlinkSync(path); if (parent) removeIfEmpty(parent); return `Deleted ${show(path)}.` } })
    }
    remove(code.shim, code.bin)
    remove(code.token, code.tokens)
    if (purge) {
      remove(code.profile, code.wrappers)
      remove(code.budget)
      let logs: string[] = []
      try {
        if (lstatSync(code.logs).isDirectory()) logs = readdirSync(code.logs).filter((entry) => UNSLOP_CODE_LOG.test(entry)).sort()
      } catch { /* no logs */ }
      for (const log of logs) remove(join(code.logs, log), code.logs)
      for (const run of runFiles(dir, 'unslop-code')) remove(run.path, join(code.root, 'runs'))
      if (steps.length) steps.push({ dry: `Would remove ${show(code.root)} if it is then empty.`, run: () => { removeIfEmpty(code.root); return `Tidied ${show(code.root)}.` } })
    }
    steps.push(...withSkills([], withoutAgent(existing, 'unslop-code')))
    if (!steps.length) {
      out(`Unslop-code is already off${purge ? ' and purged' : ' (its profile, logs, budget and run records stay; --purge removes them)'}. Nothing to do.\n`)
      return 0
    }
    return run(steps, 'Steps before it are done; nothing after it ran.')
  }

  if (command === 'enable' && !makeAgents) {
    if (flags.size || !only('--port', '--checkout', '--server', '--model')) return usage()
    const portText = values.get('--port') ?? String(UNSLOP_PORT)
    const port = /^\d{1,5}$/.test(portText) ? loopbackPort(`http://127.0.0.1:${portText}`) : undefined
    if (!port) return refuse('the port must be a number from 1 to 65535 other than 80; the endpoint is always http://127.0.0.1:<port>')
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const doc: MeshDocument = existing.kind === 'present' ? existing.doc : { schema: MESH_SCHEMA }
    const agents = doc['agents'] === undefined ? {} : objectOf(doc['agents'])
    if (!agents) return refuse(`${name} has an "agents" value that is not an object`)
    const wanted = { endpoint: `http://127.0.0.1:${port}`, profile: 'unslop' }
    const next: MeshDocument = { ...doc, agents: { ...agents, unslop: wanted } }
    const current = existing.kind === 'present' && JSON.stringify(agents['unslop']) === JSON.stringify(wanted)

    const checkout = resolve(values.get('--checkout') ?? repo)
    const wrap = join(checkout, 'packages', 'mesh', 'dist', 'wrap.js')
    if (!isFile(wrap)) {
      return refuse(isFile(join(checkout, 'packages', 'mesh', 'package.json'))
        ? `${show(wrap)} is missing: run npm ci && npm run build in ${show(join(checkout, 'packages', 'mesh'))} (Node 24)`
        : `${show(checkout)} is not an agent-inbox checkout: pass --checkout <path of one>`)
    }
    if (!isFile(script)) return refuse(`${show(script)} is missing: run npm run build in ${show(repo)}`)
    if ([node, wrap, script, dir].some((path) => /[\x00-\x1f\x7f]/.test(path))) return refuse('a path holds a control character')
    const choice = backendChoice(paths.profile)
    if ('refused' in choice) return refuse(choice.refused)
    const changed = exists(paths.profile) && (choice.server !== undefined || choice.model !== undefined) ? changeProfile(paths.profile, choice) : undefined
    if (changed && 'refused' in changed) return refuse(changed.refused)
    const start = [node, wrap, '--agent', 'openai-compatible', '--profile', 'unslop']
    const template = profileTemplate(start, choice)
    const shim = shimText('unslop', 483, node, script, dir)
    const json = `${JSON.stringify(next, null, 2)}\n`
    const dirs = (): void => {
      for (const d of [paths.wrappers, paths.tokens, paths.bin]) mkdirSync(d, { recursive: true, mode: 0o700 })
    }

    const steps: Step[] = [
      exists(paths.token)
        ? { dry: `Would keep the caller token ${show(paths.token)} (present).`, run: () => `Kept ${show(paths.token)}.` }
        : {
            dry: `Would write a new random caller token to ${show(paths.token)} (0600).`,
            run: () => { dirs(); writeNew(paths.token, `${randomBytes(32).toString('base64url')}\n`, 0o600, true); return `Wrote ${show(paths.token)}.` },
          },
      changed ?? (exists(paths.profile)
        ? {
            dry: `Would keep the profile ${show(paths.profile)} (present; never overwritten).`,
            run: () => `Kept ${show(paths.profile)}. If Node or the checkout moved, set its "start" by hand to ${JSON.stringify(start)}.`,
          }
        : {
            dry: `Would write the profile template ${show(paths.profile)} (0600)${choice.server === undefined ? '' : `, naming the server ${choice.server}`}:\n${template}`,
            run: () => {
              dirs()
              writeNew(paths.profile, template, 0o600, true)
              return `Wrote ${show(paths.profile)}: fill in ${choice.server === undefined ? 'skill, baseUrl and apiKey' : 'skill'}.`
            },
          }),
      {
        dry: `Would write the shim ${show(paths.shim)} (0755):\n${shim}`,
        run: () => { dirs(); writeAtomic(paths.shim, shim, 0o755); return `Wrote ${show(paths.shim)}.` },
      },
      current ? { dry: `Would keep ${name} (unslop is on at ${wanted.endpoint}).`, run: () => `Kept ${name}: unslop is on at ${wanted.endpoint}.` } : {
        dry: `Would ${existing.kind === 'present' ? 'replace' : 'create'} ${name}${existing.kind === 'present' ? ' (keeping a backup beside it)' : ''}:\n${json}`,
        run: () => `Wrote ${name}${writeMesh(next, existing.kind === 'present')}: unslop is on at http://127.0.0.1:${port}.`,
      },
    ]
    // the routing skill goes before the switch, which stays the last thing written
    const last = steps.pop()!
    return run([...withSkills(steps, next), last], `Steps before it are done; ${name} was not changed.`)
  }

  if (command === 'disable' && unslop) {
    const purge = flags.delete('--purge')
    if (flags.size || values.size) return usage()
    const existing = readMesh(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const drop = dropAgent(existing, 'unslop')
    const steps: Step[] = drop ? [drop] : []
    const remove = (path: string, parent?: string): void => {
      if (exists(path)) steps.push({ dry: `Would delete ${show(path)}.`, run: () => { unlinkSync(path); if (parent) removeIfEmpty(parent); return `Deleted ${show(path)}.` } })
    }
    remove(paths.shim, paths.bin)
    remove(paths.token, paths.tokens)
    if (purge) {
      remove(paths.profile, paths.wrappers)
      remove(paths.deny)
      remove(paths.budget)
      let logs: string[] = []
      try {
        if (lstatSync(paths.logs).isDirectory()) logs = readdirSync(paths.logs).filter((entry) => UNSLOP_LOG.test(entry)).sort()
      } catch { /* no logs */ }
      for (const log of logs) remove(join(paths.logs, log), paths.logs)
      for (const run of runFiles(dir, 'unslop')) remove(run.path, join(paths.root, 'runs'))
      if (steps.length) steps.push({ dry: `Would remove ${show(paths.root)} if it is then empty.`, run: () => { removeIfEmpty(paths.root); return `Tidied ${show(paths.root)}.` } })
    }
    steps.push(...withSkills([], withoutAgent(existing, 'unslop')))
    if (!steps.length) {
      out(`Unslop is already off${purge ? ' and purged' : ' (its profile, logs, deny list and run records stay; --purge removes them)'}. Nothing to do.\n`)
      return 0
    }
    return run(steps, 'Steps before it are done; nothing after it ran.')
  }

  if (command === 'disable' && !makeAgents) {
    if (flags.size || values.size) return usage()
    const existing = readMesh(file)
    if (existing.kind === 'refused') {
      err(`Refused: ${name} ${existing.reason}. Nothing changed. Remove it by hand if you are sure.\n`)
      return 1
    }
    // with the mesh off, every routing skill folder and every link meshctl made goes (#513)
    const skills = withSkills([], undefined)
    if (existing.kind === 'missing' && !skills.length) {
      out(`The mesh is already off: no ${name}. Nothing to do.\n`)
      return 0
    }
    // M1 has one step. Later phases put theirs before it (§2.5): pause the
    // registry, archive every active @mesh plan, then delete the file.
    return run([
      ...(existing.kind === 'missing' ? [] : [{
        dry: `Would delete ${name} (keeping a backup beside it).`,
        run: () => {
          const backup = writeBackup(file, now())
          unlinkSync(file)
          return `Deleted ${name} (backup: ${shown(backup, home)}).`
        },
      }]),
      ...skills,
    ], skills.length ? 'Steps before it are done; nothing after it ran.' : `${name} was not removed.`)
  }

  return usage()
}

/**
 * `forget-runs` (cards view V5 §5.9): one agent's run records, or every agent's (the built-ins and
 * every id with a day file, #530), whether it is on or off, and every other agent's expired ones.
 * A dry run deletes nothing, expired files included.
 */
function forgetRuns(dir: string, picked: string[] | 'all', apply: boolean, now: number, out: (text: string) => void, err: (text: string) => void): number {
  const found = runAgents(dir)
  const known = [...new Set([...BUILT_IN_AGENTS, ...found])]
  const agents = picked === 'all' ? known : picked
  const others = known.filter((agent) => !agents.includes(agent))
  const expired = others.length ? pruneRuns(dir, now, others, apply).length : 0
  const lines: string[] = []
  let failed = false
  for (const agent of agents) {
    const files = runFiles(dir, agent)
    const what = `${plural(files.length, 'run file')} (${plural(files.reduce((n, f) => n + f.runs, 0), 'run')}) for ${agent}`
    if (!files.length) lines.push(`No run records for ${agent}.`)
    else if (!apply) lines.push(`Would delete ${what}.`)
    else {
      try {
        for (const f of files) unlinkSync(f.path)
        lines.push(`Deleted ${what}.`)
      } catch {
        failed = true
        lines.push(`Could not delete every run file for ${agent}.`)
      }
    }
  }
  if (expired) lines.push(`${apply ? 'Deleted' : 'Would also delete'} ${plural(expired, 'expired run file')} of other agents (older than 30 days).`)
  if (apply) tidyRuns(dir)
  out(`${lines.join('\n')}\n${apply ? '' : 'Nothing changed. Re-run with --apply.\n'}`)
  if (failed) err('Failed: some run files could not be deleted.\n')
  return failed ? 1 : 0
}

/**
 * add's refusal for a card that declares the agent id an entry holds, with no key that entry pinned
 * among its signers (`signed`: some other key signed it). The app's Add an agent page reads the
 * holder from its opening words to say the agent is already added (add step 2, G5).
 */
export function heldIdRefusal(holder: string, signed: boolean): string {
  return signed
    ? `the card declares the agent id that agents.${holder} holds, but no key agents.${holder}'s pinned card lists signed it, so add cannot tell it is that agent`
    : `the card declares the agent id that agents.${holder} holds, so it is that agent: to move ${holder} here, add --move ${holder} (its pin and run records stay)`
}

const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

/** The MagicDNS suffix in `tailscale status --json` output, only while the backend runs and logged in. */
export function suffixFrom(json: string): string | undefined {
  let status: Record<string, unknown> | undefined
  try {
    status = objectOf(JSON.parse(json))
  } catch { /* not JSON */ }
  const suffix = status?.['MagicDNSSuffix']
  if (status?.['BackendState'] !== 'Running' || typeof suffix !== 'string') return undefined
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/.test(suffix) ? suffix : undefined
}

/** This Mac's MagicDNS suffix from the tailscale CLI, or undefined (no CLI, stopped, logged out). */
function magicDnsSuffix(): string | undefined {
  for (const command of TAILSCALE) {
    const r = spawnSync(command, ['status', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    if (!r.error) return suffixFrom(r.stdout)
  }
  return undefined
}

type ClientIo = Pick<UnslopIo & RequestPostIo, 'env' | 'home' | 'stdin' | 'out' | 'err'>

/**
 * `add <card-url> [--id <id> | --move <id>] [--token-file <path>] [--expect-pin <sha256>] [--json] [--apply]` (#529, mesh design
 * §6.7, D13–D17): fetches and checks the card, applies the endpoint rule and, with `--apply`,
 * copies the token (0600, never printed) and writes `agents.<id>` = { card, endpoint, tokenFile?,
 * cardSha256, agentId? }, keeping every other key and a backup. It never replaces an entry or takes
 * a built-in name, and sends no token: a loopback agent's identity proof (D17) runs before every
 * call (#530). `agentId` is the card's stable id (#537, publishable-agent design §3.4); a card
 * whose id an entry already holds is that agent, which `--move <id>` relocates (the unsigned
 * path): the same id and pin at a new card URL, changing only `card` and `endpoint` (and the token
 * copy, with --token-file), so the pin and run records, keyed by the local id, stay.
 * Since #536 (§3.10) add verifies the card's signatures: a failing one refuses the card, an
 * unsigned card is allowed (add takes only loopback and this Mac's tailnet, decision Q4), and the
 * entry pins `keyThumbprints`, the keys the card lists (trust on first use, Q3);
 * `--key-thumbprint` refuses a card that key did not sign. A card whose id an entry holds and that
 * a key the entry pinned signed is the signed move (§3.4): the same as `--move <that id>`.
 * Since #534 (§8.8, D18) a public name is allowed: fetched only through publicLookup(), the card
 * must be signed and pass the publishable level's network-free must tests (publishableRefusal),
 * and the entry records `public: true`. A move never changes whether an entry is public.
 * With `--json` (add an agent by its card address, D1) it prints the plan as one object, as the
 * other --json commands do, with `card` (cardSummary) from the point the card's pin is known.
 */
export async function runAdd(args: string[], io: MeshctlIo = {}): Promise<number> {
  if (!args.includes('--json')) return addAgent(args, io)
  const json = planCapture(io)
  // `applied` follows the --apply the parser took, never the word: a flag's value can be "--apply"
  const parsed = { apply: false }
  const code = await addAgent(args, json.io, json.plan, parsed)
  json.print(code, parsed.apply)
  return code
}

async function addAgent(args: string[], io: MeshctlIo, plan?: Plan, parsed?: { apply: boolean }): Promise<number> {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const now = io.now ?? (() => new Date())
  const out = io.out ?? ((text: string) => { process.stdout.write(text) })
  const err = io.err ?? ((text: string) => { process.stderr.write(text) })
  const usage = (): number => { err(USAGE); return 2 }
  // the card, once its pin is known: every answer from there on carries it (--json)
  let summary: (() => CardSummary) | undefined
  const refuse = (reason: string): number => { if (plan && summary) plan.card = summary(); err(`Refused: ${reason}. Nothing changed.\n`); return 1 }
  const show = (path: string): string => shown(path, home)

  let cardUrl: string | undefined
  let id: string | undefined
  let move: string | undefined
  let tokenFile: string | undefined
  let thumbprint: string | undefined
  let expectPin: string | undefined
  let apply = false
  let asJson = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--apply' && !apply) apply = true
    else if (arg === '--json' && plan && !asJson) asJson = true
    else if (arg === '--id' || arg === '--move' || arg === '--token-file' || arg === '--key-thumbprint' || arg === '--expect-pin') {
      const value = args[++i]
      if (value === undefined || (arg === '--id' ? id : arg === '--move' ? move : arg === '--token-file' ? tokenFile : arg === '--key-thumbprint' ? thumbprint : expectPin) !== undefined) return usage()
      if (arg === '--id') id = value
      else if (arg === '--move') move = value
      else if (arg === '--token-file') tokenFile = value
      else if (arg === '--key-thumbprint') thumbprint = value
      else expectPin = value
    } else if (!arg.startsWith('-') && cardUrl === undefined) cardUrl = arg
    else return usage()
  }
  // --expect-pin (D2): the pin of the card that was looked at, as the dry run prints it
  if (cardUrl === undefined || (id !== undefined && move !== undefined) || (expectPin !== undefined && !/^[0-9a-f]{64}$/.test(expectPin))) return usage()
  if (parsed) parsed.apply = apply
  const idBad = id === undefined ? undefined : idRefusal(id)
  if (idBad) return refuse(idBad)
  const moveBad = move === undefined ? undefined : idRefusal(move)
  if (moveBad) return refuse(BUILT_IN_AGENTS.includes(move!) ? `${move} is a built-in agent: meshctl enable and disable manage it` : moveBad)
  if (thumbprint !== undefined && !THUMBPRINT.test(thumbprint)) return refuse('--key-thumbprint must be a key\'s RFC 7638 SHA-256 thumbprint: 43 base64url characters (meshctl key show prints one)')
  const place = addedPlace(cardUrl)
  if ('refused' in place) return refuse(placeRefusal('the card URL'))
  // the endpoint must share the card URL's origin, so this one placing covers both
  const reach = reachOf(place, io.tailnet ?? magicDnsSuffix)
  const seams = reach === 'public' ? { lookup: publicLookup(io.lookup, io.isPublic), ca: io.ca } : { lookup: io.lookup, ca: io.ca }
  const NEEDS_TOKEN = 'a loopback agent needs --token-file: meshctl call proves its identity with that token before it sends anything (D17)'
  if (place.loopback && tokenFile === undefined && move === undefined) return refuse(NEEDS_TOKEN)

  const dir = resolve(meshDir(env, home))
  const file = meshFile(dir)
  const name = shown(file, home)
  if (/[\x00-\x1f\x7f]/.test(dir)) return refuse('a path holds a control character')
  const source = tokenFile === undefined ? undefined : resolve(tokenFile)
  let token: string | undefined
  if (source !== undefined) {
    const read = readTokenFile(source, true)
    if ('refused' in read) return refuse(read.refused)
    token = read.token
  }
  // the agents object of a readable mesh.json, or the refusal; read again after the fetch
  const agentsOf = (read: MeshRead): Record<string, unknown> | string => {
    if (read.kind === 'refused') return `${name} ${read.reason}. Remove it by hand if you are sure`
    const value = read.kind === 'present' ? read.doc['agents'] : undefined
    return (value === undefined ? {} : objectOf(value)) ?? `${name} has an "agents" value that is not an object`
  }
  const taken = (agentId: string): string => `the id ${agentId} is already in ${name}, and add never replaces an entry`
  // the entry --move relocates: one add wrote, valid, with the stable id the new card must match
  type Movable = Exclude<ReturnType<typeof addedEntry>, 'invalid' | undefined> & { agentId: string }
  const movable = (agents: Record<string, unknown>, target: string): { entry: Movable } | string => {
    const read = Object.hasOwn(agents, target) ? addedEntry(target, agents[target]) : undefined
    if (!Object.hasOwn(agents, target)) return `${target} is not in ${name}: add it without --move`
    if (read === undefined) return `agents.${target} was not written by meshctl add, so add cannot move it`
    if (read === 'invalid') return `the entry for ${target} breaks meshctl add's rules: remove it and add it again`
    if (read.agentId === undefined) return `agents.${target} records no agent id (its card declared none when it was added), so add cannot tell the new card is the same agent: remove it and add it again`
    return { entry: { ...read, agentId: read.agentId } }
  }
  const early = agentsOf(readMesh(file))
  if (typeof early === 'string') return refuse(early)
  if (id !== undefined && Object.hasOwn(early, id)) return refuse(taken(id))
  if (move !== undefined) {
    const was = movable(early, move)
    if (typeof was === 'string') return refuse(was)
    if (place.loopback && tokenFile === undefined && was.entry.tokenFile === undefined) return refuse(NEEDS_TOKEN)
  }

  const fetched = await fetchAddedCard(place, undefined, seams)
  if (fetched.reason !== undefined) return refuse(fetched.reason)
  const card = fetched.card
  const endpoint = cardEndpoint(card, place.origin)
  if ('refused' in endpoint) return refuse(endpoint.refused)
  const profile = fetched.profile
  const verdict = fetched.signatures
  // an unsigned card only on loopback and this Mac's tailnet (the local level); a public name needs the publishable level (#534, D18)
  const signatureBad = signatureRefusal(verdict, reach !== 'public', thumbprint)
  if (signatureBad) return refuse(signatureBad)
  const unpublishable = reach === 'public' ? publishableRefusal(card) : undefined
  if (unpublishable) return refuse(`the card is on a public name, so it must be publishable, and it fails ${unpublishable} (meshctl check <card-url> lists every test)`)
  const signedBy = 'signed' in verdict ? verdict.signed : []
  const pin = cardSha256(card)
  // the card's id (D1): --id, else the --move target or the signed move's holder, else the usable id its name makes
  const derived = idFromName(card['name'])
  let cardId = id ?? move ?? (derived === undefined || idRefusal(derived) ? undefined : derived)
  let keysNew: boolean | undefined
  summary = () => cardSummary(card, { id: cardId, reach, endpoint: endpoint.endpoint, signed: 'signed' in verdict, keysNew, pin })

  const existing = readMesh(file)
  const agents = agentsOf(existing)
  // read as no entry when mesh.json is refused, so a changed card's refusal comes first (D2)
  const listed = typeof agents === 'string' ? {} : agents
  const holder = profile === undefined ? undefined : Object.keys(listed).find((key) => {
    const read = addedEntry(key, listed[key])
    return read !== undefined && read !== 'invalid' && read.agentId === profile.id
  })
  // the signed move (§3.4): the holder's pinned keys signed this card, so it is that agent
  const held = holder === undefined ? undefined : addedEntry(holder, listed[holder])
  const endorsed = held !== undefined && held !== 'invalid' && (held.keyThumbprints ?? []).some((k) => signedBy.includes(k))
  const target = move ?? (endorsed && id === undefined ? holder : undefined)
  cardId = id ?? target ?? cardId
  // the card that was looked at, or nothing (D2): before any other refusal, in the dry run too
  if (expectPin !== undefined && pin !== expectPin) return refuse('the card is not the one that was checked (its pin differs): check it again')
  if (typeof agents === 'string') return refuse(agents)
  const pinned = { ...(verdict.keys.length ? { keyThumbprints: verdict.keys } : {}) }
  let agentId: string
  let entry: Record<string, unknown>
  let moved: Movable | undefined
  if (target === undefined) {
    if (holder !== undefined) {
      return refuse(endorsed
        ? `the card is agents.${holder}'s agent, signed by a key its pinned card lists: to move ${holder} here, add it without --id`
        : heldIdRefusal(holder, signedBy.length > 0))
    }
    const picked = id ?? idFromName(card['name'])
    if (picked === undefined) return refuse('the card\'s name makes no usable id: pass --id <id>')
    const derivedBad = idRefusal(picked)
    if (derivedBad) return refuse(derivedBad)
    if (Object.hasOwn(agents, picked)) return refuse(taken(picked))
    agentId = picked
    entry = { card: place.url, endpoint: endpoint.endpoint, ...(token === undefined ? {} : { tokenFile: join(dir, 'mesh', 'tokens', picked) }), cardSha256: pin, ...(profile ? { agentId: profile.id } : {}), ...pinned, ...(reach === 'public' ? { public: true } : {}) }
  } else {
    const was = movable(agents, target)
    if (typeof was === 'string') return refuse(was)
    moved = was.entry
    if (moved.public !== (reach === 'public')) return refuse(`the new card URL is ${reach === 'public' ? 'on a public name' : 'on loopback or this Mac\'s tailnet'} and agents.${target} is not, so add cannot move it there: remove it and add it again`)
    if (profile === undefined) return refuse(`the card declares no agent id, so add cannot tell it is ${target}'s agent`)
    if (profile.id !== moved.agentId) return refuse(`the card declares another agent id than agents.${target}'s, so it is another agent: add it without --move`)
    if (pin !== moved.cardSha256) return refuse(`the card at the new URL is not the one you added (pin ${moved.cardSha256.slice(0, 12)}, now ${pin.slice(0, 12)}): moving a changed card waits for accepting it (#531)`)
    if (moved.card === place.url && moved.endpoint === endpoint.endpoint && token === undefined) {
      if (plan) plan.card = summary()
      out(`agents.${target} is already at ${place.url}. Nothing to do.\n`)
      return 0
    }
    agentId = target
    // only the card URL and endpoint change (and the token copy with --token-file); every other key
    // stays, and the keys the (same) card lists are pinned when an older entry had none
    entry = { ...objectOf(agents[target])!, card: place.url, endpoint: endpoint.endpoint, ...(token === undefined ? {} : { tokenFile: join(dir, 'mesh', 'tokens', target) }), ...pinned }
  }
  // how the summary describes the verified keys: the human's thumbprint, this entry's pin, another entry's, or new
  const pinnedFor = (kid: string): string | undefined => Object.keys(agents).find((key) => {
    const read = addedEntry(key, agents[key])
    return read !== undefined && read !== 'invalid' && (read.keyThumbprints ?? []).includes(kid)
  })
  const knownAs = signedBy.map(pinnedFor).find((key) => key !== undefined)
  const trust = thumbprint !== undefined ? 'matches --key-thumbprint'
    : knownAs !== undefined ? `already pinned for agents.${knownAs}` : 'new to this Mac: trusted from now on if you --apply'
  keysNew = thumbprint === undefined && knownAs === undefined
  const tokens = join(dir, 'mesh', 'tokens')
  const copy = join(tokens, agentId)
  const present = existing.kind === 'present'
  const next: MeshDocument = { ...(present ? existing.doc : { schema: MESH_SCHEMA }), agents: { ...agents, [agentId]: entry } }
  const json = `${JSON.stringify(next, null, 2)}\n`

  // with --json the card object carries the summary (D1)
  if (plan) plan.card = summary()
  else out(addSummary(card, { cardUrl: place.url, endpoint: endpoint.endpoint, reach, token: token !== undefined || moved?.tokenFile !== undefined, pin, profile, signed: signedLine(verdict, trust) }))
  if (moved) {
    const sends = token !== undefined || moved.tokenFile !== undefined ? '; meshctl call will send the token to the new endpoint' : ''
    const why = move === undefined ? `, signed by a key its pinned card lists` : ''
    out(`Move       this is ${agentId} at a new endpoint (was ${moved.endpoint})${why}: its card pin${token === undefined ? ', token copy' : ''} and run records stay${sends}.\n`)
  }
  const steps: Step[] = []
  if (token !== undefined) {
    steps.push({
      dry: `Would copy the bearer token in ${show(source!)} to ${show(copy)} (0600${exists(copy) ? ', replacing the one there' : ''}); it is never printed.`,
      run: () => { mkdirSync(tokens, { recursive: true, mode: 0o700 }); writeAtomic(copy, `${token}\n`, 0o600); return `Copied the token to ${show(copy)}.` },
    })
  }
  // the card as accepted, which the app shows without contacting the agent (Agent cards step 1, D6)
  const cardCopy = cardCopyFile(dir, agentId)
  steps.push({
    dry: `Would keep the card as ${show(cardCopy)} (0600) for the app to show.`,
    // best effort: the add worked before the copy existed, so a copy that cannot be kept is said, not fatal
    run: () => {
      try {
        writeCardCopy(dir, agentId, card)
        return `Kept the card as ${show(cardCopy)}.`
      } catch (error) {
        return `Could not keep the card copy (${error instanceof Error ? error.message : String(error)}); meshctl check ${agentId} keeps it later.`
      }
    },
  })
  steps.push({
    dry: `Would ${present ? 'replace' : 'create'} ${name}${present ? ' (keeping a backup beside it)' : ''}:\n${json}`,
    run: () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const backup = present ? ` (backup: ${show(writeBackup(file, now()))})` : ''
      writeAtomic(file, json, 0o644)
      return `Wrote ${name}${backup}: ${agentId} is ${moved ? 'moved to' : 'added at'} ${endpoint.endpoint}.`
    },
  })
  const code = runSteps(steps, apply, out, err, `Steps before it are done; ${name} was not changed.`, plan)
  if (apply && code === 0) {
    out(moved
      ? `${agentId} keeps its card pin and run records. meshctl call ${agentId} < request calls it at the new endpoint.\n`
      : `This --apply is your approval for ${agentId} (D14). meshctl call ${agentId} < request calls it; meshctl remove ${agentId} --apply takes it out.\n`)
  }
  return code
}

// ── made agents (agents a chat makes, step 1) ──────────────────────────────
// `new <id> --from <card file>` makes an agent from a card file (src/mesh-made.ts holds its rule):
// the one shared runner in packages/mesh serves it, and to the rest of the mesh it is an agent
// `add` added by its loopback card address, plus its description and start profile.

/** The ports a made agent may take: the lowest one free. */
const MADE_PORTS = [4430, 4499] as const
const MADE_START_MS = 10_000
const RUNNER_CARD_MS = 10_000
const RUNNER_TRY_MS = 300_000

/** Whether nothing listens on 127.0.0.1:`port`: it binds the port and lets it go. */
const portFree = (port: number): Promise<boolean> => new Promise((done) => {
  const server = createNetServer()
  server.once('error', () => done(false))
  server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
})

/** The lowest port from 4430 to 4499 that no mesh.json endpoint names and nothing listens on. */
async function madePort(agents: Record<string, unknown>): Promise<number | undefined> {
  const used = new Set(Object.values(agents).map((value) => {
    const endpoint = objectOf(value)?.['endpoint']
    return typeof endpoint === 'string' ? Number(/^http:\/\/127\.0\.0\.1:(\d{1,5})(?:\/|$)/.exec(endpoint)?.[1]) : NaN
  }))
  for (let port = MADE_PORTS[0]; port <= MADE_PORTS[1]; port++) if (!used.has(port) && await portFree(port)) return port
  return undefined
}

/** One run of the made-agent runner in a mode that serves nothing (--card, --try): its exit code and output. */
function runRunner(node: string, runner: string, args: string[], env: NodeJS.ProcessEnv, dir: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    execFile(node, [runner, ...args], { env: { ...env, AGENT_INBOX_MESH_DIR: dir }, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, out, err) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, out, err })
    })
  })
}

/** The runner's one line on stderr (its last, after any warning Node printed), without control characters. */
const runnerLine = (err: string): string => (err.trim().split('\n').at(-1) ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 300) || 'it printed nothing'

/**
 * `new <id> --from <card file> [--try <file>] [--checkout <path>] [--json] [--apply]` (agents a chat
 * makes, D3): checks the card file, picks the port, asks the runner for the card the agent will have
 * (no network) and prints add's summary of it and its pin. `--try` (dry run only) has the runner
 * make one model call with the sample and prints the answer framed as call frames one. With
 * `--apply` it writes the description, a new caller token and the start profile, starts the runner,
 * waits for its identity proof, and adds it by the same code `add` runs, with the pin it showed.
 * A step that fails undoes every step before it.
 */
export async function runNew(args: string[], io: MeshctlIo = {}): Promise<number> {
  if (!args.includes('--json')) return newAgent(args, io)
  const json = planCapture(io)
  const parsed = { apply: false }
  const code = await newAgent(args, json.io, json.plan, parsed)
  json.print(code, parsed.apply)
  return code
}

async function newAgent(args: string[], io: MeshctlIo, plan?: Plan, parsed?: { apply: boolean }): Promise<number> {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const out = io.out ?? ((text: string) => { process.stdout.write(text) })
  const err = io.err ?? ((text: string) => { process.stderr.write(text) })
  const usage = (): number => { err(USAGE); return 2 }
  const refuse = (reason: string): number => { err(`Refused: ${reason}. Nothing changed.\n`); return 1 }
  const show = (path: string): string => shown(path, home)

  let id: string | undefined
  const values = new Map<string, string>()
  let apply = false
  let asJson = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--apply' && !apply) apply = true
    else if (arg === '--json' && plan && !asJson) asJson = true
    else if (arg === '--try' || arg === '--checkout' || arg === `--from`) {
      const value = args[++i]
      if (value === undefined || values.has(arg)) return usage()
      values.set(arg, value)
    } else if (!arg.startsWith('-') && id === undefined) id = arg
    else return usage()
  }
  const from = values.get('--from')
  const sample = values.get('--try')
  // --try is a dry run's: it changes nothing, and its answer is text, never a plan
  if (id === undefined || from === undefined || (sample !== undefined && (apply || asJson))) return usage()
  if (parsed) parsed.apply = apply

  const idBad = idRefusal(id)
  if (idBad) return refuse(idBad)
  if (id.endsWith('-next')) return refuse('an id ending in -next is kept for a signing key\'s rotation, so the agent could not start: pick another id')
  const dir = resolve(meshDir(env, home))
  const file = meshFile(dir)
  const name = shown(file, home)
  const existing = readMesh(file)
  if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
  const agents = existing.kind === 'present' && existing.doc['agents'] !== undefined ? objectOf(existing.doc['agents']) : {}
  if (!agents) return refuse(`${name} has an "agents" value that is not an object`)
  if (Object.hasOwn(agents, id)) return refuse(`the id ${id} is already in ${name}, and new never replaces an entry: meshctl remove ${id} --apply first`)

  const cardFile = resolve(from)
  let text: string
  try {
    const stat = lstatSync(cardFile)
    if (!stat.isFile()) throw new Error('not a file')
    // the size first: a file over the cap is never read
    if (stat.size > CARD_FILE_MAX) return refuse('the card file is larger than 64 KiB')
    text = readFileSync(cardFile, 'utf8')
  } catch {
    return refuse('the card file cannot be read: pass a regular file')
  }
  const servers = readServers(dir)
  if (servers.kind === 'refused') return refuse(`${show(serversFile(dir))} ${SERVERS_REASONS[servers.reason]}`)
  const read = parseMadeCard(text, id, serverKinds(dir))
  if ('refused' in read) return refuse(read.refused)
  const card = read.card

  const repo = fileURLToPath(new URL('..', import.meta.url))
  const checkout = resolve(values.get('--checkout') ?? repo)
  const runner = join(checkout, 'packages', 'mesh', 'dist', 'made-agent.js')
  // enable --unslop's check and words
  if (!isFile(runner)) {
    return refuse(isFile(join(checkout, 'packages', 'mesh', 'package.json'))
      ? `${show(runner)} is missing: run npm ci && npm run build in ${show(join(checkout, 'packages', 'mesh'))} (Node 24)`
      : `${show(checkout)} is not an agent-inbox checkout: pass --checkout <path of one>`)
  }
  const node = io.node ?? process.execPath
  if ([node, runner, dir].some((path) => /[\x00-\x1f\x7f]/.test(path))) return refuse('a path holds a control character')
  const port = await madePort(agents)
  if (port === undefined) return refuse(`no port from ${MADE_PORTS[0]} to ${MADE_PORTS[1]} is free: every one is a mesh.json endpoint or taken`)

  // the card the agent will have, from the runner itself, with no network
  const printed = await runRunner(node, runner, ['--card', `--from`, cardFile, '--port', String(port)], env, dir, RUNNER_CARD_MS)
  let shownCard: Record<string, unknown> | undefined
  try {
    if (printed.code === 0) shownCard = objectOf(JSON.parse(printed.out))
  } catch { /* below */ }
  if (!shownCard) return refuse(`the runner could not print the card (${runnerLine(printed.err)})`)
  const checked = checkedCard(shownCard)
  if (checked.reason !== undefined) return refuse(`the runner printed a card add would refuse: ${checked.reason}`)
  const pin = cardSha256(shownCard)
  const endpoint = `http://127.0.0.1:${port}/`
  const cardUrl = `http://127.0.0.1:${port}/.well-known/agent-card.json`
  const signed = 'signed' in checked.signatures
  if (plan) plan.card = cardSummary(shownCard, { id, reach: 'loopback', endpoint, signed, keysNew: undefined, pin })
  else out(addSummary(shownCard, { cardUrl, endpoint, reach: 'loopback', token: true, pin, profile: checked.profile, signed: signedLine(checked.signatures, `the key ${id} has on this Mac`) }))

  if (sample !== undefined) {
    out(`This sends the sample and the instructions to the server ${card.server}.\n`)
    const tried = await runRunner(node, runner, ['--try', `--from`, cardFile, '--input', resolve(sample)], env, dir, RUNNER_TRY_MS)
    if (tried.code !== 0) {
      err(`${runnerLine(tried.err)}\n`)
      return 1
    }
    out(frameResult(tried.out, { agent: id, cardSha256: pin }))
  }

  const paths = madePaths(dir, id)
  const tokens = join(dir, 'mesh', 'tokens')
  const token = join(tokens, id)
  const start = [node, runner, '--id', id]
  // what this run wrote and started, undone in reverse when a later step fails: a made agent is
  // never left half made (files a killed new left are replaced here, and remove deletes them). A
  // file is removed only while it still holds what this run wrote, so an agent another command
  // wrote under the same id meanwhile (an add --id, say) keeps its files
  const written: Array<{ path: string; text: string }> = []
  let started: { stop: () => void } | undefined
  let adding = false
  const write = (path: string, text: string): void => {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeAtomic(path, text, 0o600)
    written.push({ path, text })
  }
  const undo = (): void => {
    started?.stop()
    // add's card copy: only when this run's add ran and no entry holds the id
    if (adding) {
      const now = readMesh(file)
      const listed = now.kind === 'present' ? objectOf(now.doc['agents']) : undefined
      if (now.kind !== 'refused' && !(listed && Object.hasOwn(listed, id))) {
        try { removeCardCopy(dir, id) } catch { /* none */ }
      }
    }
    for (const { path, text } of written.reverse()) {
      try {
        if (readPrivate(path) === text) unlinkSync(path)
      } catch { /* gone, or not ours any more */ }
    }
  }
  let secret = ''
  const steps: Array<{ dry: string; run: () => string | Promise<string> }> = [
    {
      dry: `Would write the description ${show(paths.description)} (0600): ${id}, on the server ${card.server} with the model ${card.model}; its instructions are not printed.`,
      run: () => { write(paths.description, `${JSON.stringify({ schema: 1, ...card }, null, 2)}\n`); return `Wrote ${show(paths.description)}.` },
    },
    {
      dry: `Would write a new random caller token to ${show(token)} (0600).`,
      run: () => { secret = randomBytes(32).toString('base64url'); write(token, `${secret}\n`); return `Wrote ${show(token)}.` },
    },
    {
      dry: `Would write the start profile ${show(paths.profile)} (0600): port ${port}, start ${JSON.stringify(start)}.`,
      run: () => { write(paths.profile, `${JSON.stringify({ made: true, port, start }, null, 2)}\n`); return `Wrote ${show(paths.profile)}.` },
    },
    {
      dry: `Would start the agent from that profile (its log: ${show(paths.log)}) and wait up to ${MADE_START_MS / 1000} s for it to prove it holds its token at ${endpoint}.`,
      run: async () => {
        const s = startAgent(dir, { env }, id, `meshctl remove ${id} --apply, then make it again`)
        if (typeof s === 'string') throw new StepFailure(`the agent could not be started: ${s}`)
        started = s
        const link = meshLink(port, secret, 'a2a-mesh')
        try {
          for (const until = Date.now() + MADE_START_MS; Date.now() < until;) {
            const gone = s.exited()
            const got = await getCard(link)
            if (got.kind === 'ok') return `Started ${id} at ${endpoint}: it proved it holds its token.`
            // an answer without the proof is another process on the port
            if (got.kind === 'unproven') throw new StepFailure(`another process answers at ${endpoint}: it did not prove it holds ${id}'s token (another meshctl new may have just taken the port: try again)`)
            if (gone) break
            await new Promise((done) => setTimeout(done, 200))
          }
        } finally {
          link.close()
        }
        throw new StepFailure(`the agent did not start; see ${show(s.log)}`)
      },
    },
    {
      dry: `Would add it as meshctl add ${cardUrl} --id ${id} --token-file ${show(token)} --expect-pin ${pin} does: the token copy, the card copy and agents.${id} in ${name}.`,
      // add's own code path, with the pin the dry run showed: the card added is the card shown
      run: async () => {
        adding = true
        const added: Plan = { steps: [], notes: [] }
        const said: string[] = []
        const code = await addAgent([cardUrl, '--id', id, '--token-file', token, '--expect-pin', pin, '--apply'], { ...io, out: () => {}, err: (text) => said.push(text) }, added)
        if (code !== 0) throw new StepFailure(`add refused it: ${(added.refused ?? said.join(' ')).replace(/^Refused: /, '').replace(/\.? ?Nothing changed\.\s*$/, '').trim()}`)
        return `Added ${id}: ${added.steps.join(' ')}`
      },
    },
  ]
  if (!apply) return runSteps(steps.map((step) => ({ dry: step.dry, run: () => '' })), false, out, err, '', plan)
  // the setup lock (enable's, scripts/setup-lock.sh) for the whole --apply: two news, or a new and
  // an enable, never interleave; add takes no lock, so the in-process add below cannot wait on it
  const lock = holdSetupLock(env, home)
  if ('refused' in lock) return refuse(lock.refused)
  try {
    const n = steps.length
    for (const [i, step] of steps.entries()) {
      try {
        const line = await step.run()
        if (plan) plan.steps.push(firstLine(line))
        else out(`${i + 1}/${n} ${line}\n`)
      } catch (error) {
        undo()
        // the runner's start log stays, for the reason it holds
        const left = started ? `, and only its start log ${show(paths.log)} is left (meshctl remove ${id} --apply deletes it)` : ', so nothing changed'
        err(`Failed at step ${i + 1}/${n}: ${error instanceof StepFailure ? error.message : 'it could not be done'}. Every step before it was undone (the agent stopped, the files this run wrote removed)${left}.\n`)
        return 1
      }
    }
  } finally {
    lock.release()
  }
  out(`This --apply is your approval for ${id} (D14). meshctl call ${id} < request calls it; meshctl remove ${id} --apply takes it out.\n`)
  return 0
}

/** A failed step of new's --apply, in words for the person. */
class StepFailure extends Error {}

/**
 * `check` (#538), and `check <id>` (Agent cards step 1, D6): an added agent's id stands for its
 * entry's card URL. When the card fetched there still matches the entry's pin, its card copy is
 * written if it is missing or differs, so agents added before the copy existed show their card in
 * the app. A copy that breaks the file rule (a symlink, another user's) is left alone and named.
 */
export async function runCheckCommand(args: string[], io: MeshctlIo & { cardMs?: number } = {}): Promise<number> {
  const out = io.out ?? ((text: string) => { process.stdout.write(text) })
  const err = io.err ?? ((text: string) => { process.stderr.write(text) })
  const checkIo = { tailnet: io.tailnet, lookup: io.lookup, ca: io.ca, isPublic: io.isPublic, cardMs: io.cardMs, out, err }
  const id = args[0]
  if (id === undefined || id.startsWith('-') || id.includes(':')) return runCheck(args, checkIo)
  const home = io.home ?? homedir()
  const dir = resolve(meshDir(io.env ?? process.env, home))
  const mesh = readMesh(meshFile(dir))
  const agents = mesh.kind === 'present' ? objectOf(mesh.doc['agents']) ?? {} : {}
  const entry = idRefusal(id) || !Object.hasOwn(agents, id) ? undefined : addedEntry(id, agents[id])
  if (entry === undefined || entry === 'invalid') {
    err(`meshctl check: ${idRefusal(id) ? 'that is neither a card URL nor an added agent\'s id' : entry === 'invalid' ? `the entry for ${id} breaks meshctl add's rules: remove it and add it again` : `${id} is not an agent meshctl add wrote`}\n${CHECK_USAGE}`)
    return 4
  }
  let fetched: Record<string, unknown> | undefined
  const code = await runCheck([entry.card, ...args.slice(1)], { ...checkIo, card: (card) => { fetched = card } })
  const say = (text: string): void => { if (!args.includes('--json')) out(`Card copy  ${text}\n`) }
  const copy = shown(cardCopyFile(dir, id), home)
  if (!fetched) return code
  let pin: string | undefined
  try { pin = cardSha256(fetched) } catch { /* nested too deeply */ }
  if (pin !== entry.cardSha256) {
    say(`not kept: the card is not the one you added (pin ${entry.cardSha256.slice(0, 12)}, now ${pin?.slice(0, 12) ?? 'none'})`)
    return code
  }
  const kept = readCardCopy(dir, id)
  if (kept === 'refused') {
    if (cardsFolderRefused(dir)) say(`${shown(join(dir, 'mesh', 'cards'), home)} breaks the folder rule (a symlink, another user's or open to others): fix or delete the folder, then run check again`)
    else say(`${copy} breaks the file rule (a symlink, another user's or open to others): delete it, then run check again`)
    return code
  }
  let same = false
  try { same = kept !== 'missing' && cardSha256(kept.card) === pin } catch { /* rewritten below */ }
  if (same) {
    say(`${copy} matches the card`)
    return code
  }
  try {
    writeCardCopy(dir, id, fetched)
    say(`kept the card as ${copy} for the app to show`)
  } catch {
    say(`could not write ${copy}`)
  }
  return code
}

/**
 * call's start for a made agent (D4): undefined when `id` has no made start profile, so call goes on
 * exactly as for any added agent; else a start from that profile, which must be a private file you
 * own naming the entry's port, by the built-ins' starter (detached, no shell, its log beside theirs).
 */
function madeStart(dir: string, id: string, env: NodeJS.ProcessEnv): { start(port: number): { exited: () => boolean; log: string } | string } | undefined {
  if (idRefusal(id)) return undefined
  const profile = madeProfile(dir, id)
  if (profile === 'missing') return undefined
  const fix = `meshctl remove ${id} --apply, then make it again`
  return {
    start: (port) => profile === 'refused' ? `its start profile ${madePaths(dir, id).profile} must be a JSON file you own with mode 0600 that names its port: ${fix}`
      : profile.port !== port ? `its start profile names port ${profile.port}, not its entry's ${port}: ${fix}`
        : startAgent(dir, { env }, id, fix),
  }
}

const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const

/**
 * The shims' entry (cards view V5 §5.3): runs one client and appends its run record on every
 * end: a return, an internal error (13) and SIGTERM, SIGHUP or SIGINT, whose synchronous handler
 * writes `interrupted` and re-raises the signal, so the process still dies by it.
 * V5e adds `web-search` here once W5b's client exists; it fills `io.run` with §5.4's common
 * fields only (mesh-runs.ts already allows no other field for it). `call` records under the
 * added agent's id, once its entry passed the rule (#530). `call` and `request-post` get this
 * Mac's tailnet suffix reader for their §8.8 re-check (#557).
 */
export async function runClient(command: 'unslop' | 'unslop-code' | 'request-post' | 'call', args: string[], io: ClientIo & { tailnet?: () => string | undefined; cwd?: string }): Promise<number> {
  const dir = resolve(meshDir(io.env, io.home))
  const run: RunCollector = {}
  const agent = command === 'call' ? args[0] ?? '' : command
  const onSignal = (signal: NodeJS.Signals): void => {
    appendRun(dir, agent, run, { exit: null, signal })
    for (const s of SIGNALS) process.removeListener(s, onSignal)
    process.kill(process.pid, signal)
  }
  for (const s of SIGNALS) process.once(s, onSignal)
  try {
    const code = command === 'unslop'
      ? await runUnslop(args, { ...io, run }).catch(() => { run.internal = true; io.err('unslop: failed (internal error). Edit it in-session.\n'); return 13 })
      : command === 'unslop-code'
        ? await runUnslopCode(args, { ...io, cwd: io.cwd ?? process.cwd(), run }).catch(() => { run.internal = true; io.err('unslop-code: failed (internal error); nothing was applied.\n'); return 13 })
        : command === 'call'
          ? await runCall(args, { tailnet: magicDnsSuffix, made: (id) => madeStart(dir, id, io.env), ...io, run }).catch(() => { run.internal = true; io.err('meshctl call: failed (internal error).\n'); return 13 })
          : await runRequestPost(args, { tailnet: magicDnsSuffix, ...io, run }).catch(() => { run.internal = true; io.err('request-post: outcome unknown (internal error): run the same command again; never file it in-session.\n'); return 13 })
    appendRun(dir, agent, run, { exit: code })
    return code
  } finally {
    for (const s of SIGNALS) process.removeListener(s, onSignal)
  }
}

const entry = process.argv[1]
let isMain = false
try {
  isMain = Boolean(entry) && realpathSync(entry!) === realpathSync(fileURLToPath(import.meta.url))
} catch { /* not run directly */ }
if (isMain) {
  const [command, ...rest] = process.argv.slice(2)
  process.exitCode = command === 'unslop' || command === 'unslop-code' || command === 'request-post' || command === 'call'
    ? await runClient(command, rest, { env: process.env, home: homedir(), stdin: process.stdin, out: (text) => { process.stdout.write(text) }, err: (text) => { process.stderr.write(text) } })
    : command === 'add' ? await runAdd(rest)
      : command === 'new' ? await runNew(rest)
      : command === 'server' && rest[0] === 'check' ? await runServerCheck(rest.slice(1))
      : command === 'check' ? await runCheckCommand(rest, { tailnet: magicDnsSuffix })
        : runMeshctl(process.argv.slice(2))
}
