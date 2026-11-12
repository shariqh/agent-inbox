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
//
//   meshctl enable --agents-view [--apply]   says the Agents view is always on
//   meshctl enable --unslop [--port <n>] [--checkout <path>] [--apply]
//   meshctl enable --request-post --endpoint <url> --token-file <path> [--apply]
//   meshctl disable [--apply]                turn every mesh piece off
//   meshctl disable --unslop [--purge] [--apply]
//   meshctl disable --request-post [--purge] [--apply]
//   meshctl add <card-url> [--id <id>] [--token-file <path>] [--key-thumbprint <t>] [--apply]
//                                            add an A2A agent this repo doesn't ship (#529)
//   meshctl add <card-url> --move <id> [--token-file <path>] [--apply]
//                                            the same agent (its card's id) at a new endpoint (#537)
//   meshctl remove <id> [--apply]            take an added agent out again
//   meshctl key create|show|rotate|retire <agent> [--apply]
//                                            an agent's card-signing key (src/mesh-keys.ts, #536)
//   meshctl call <id> [--skill <s>] [--json] [--report <file>] [--timeout <s>] < request
//                                            call an added agent (src/mesh-call.ts)
//   meshctl check <card-url> [--level local|publishable] [--strict] [--json] [--token-file <path> [--send <file>]]
//                                            a conformance check anyone can run (src/mesh-check.ts, #538)
//   meshctl forget-runs (--unslop | --request-post | --web-search | --id <id> | --all) [--apply]
//   meshctl status                           say what mesh.json turns on
//   meshctl --version                        this build's version
//   meshctl skills link|unlink [--target claude|agents|all] [--apply]
//                                            link the routing skills into the harnesses' skill folders
//   meshctl unslop --kind <kind> [--report <file>] [--timeout <s>] < draft
//                                            the shim's command (src/unslop-client.ts)
//   meshctl request-post file|status|wait …  its shim's command (src/request-post-client.ts)
//
// Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 usage;
// `unslop` has its own (0, 10-14, 4), listed in src/unslop-client.ts, and
// `request-post` its own (0, 11-16, 124, 4), listed in src/request-post-client.ts, and
// `call` one table for every added agent (0, 11-16, 4), in docs/mesh-call.md, and `check`
// its own (0, 17, 15, 4), in the same page.
// The entry appends one run record per client run (src/mesh-runs.ts, cards view V5 §5).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LookupFunction } from 'node:net'
import { fileURLToPath } from 'node:url'
import { MESH_SCHEMA, inTailnet, loopbackPort, meshDir, meshFile, readMesh, readTokenFile, requestPostEndpoint } from './mesh-config.js'
import type { MeshDocument, MeshRead } from './mesh-config.js'
import { BUILT_IN_AGENTS, addSummary, addedEntry, addedPlace, cardEndpoint, cardSha256, fetchAddedCard, idFromName, idRefusal, placeRefusal, reachOf, signatureRefusal, signedLine } from './mesh-add.js'
import { THUMBPRINT } from './card-signature.js'
import { KEY_USAGE, runKey } from './mesh-keys.js'
import { appendRun, pruneRuns, runAgents, runFiles, tidyRuns } from './mesh-runs.js'
import type { RunCollector } from './mesh-runs.js'
import { CALL_USAGE, runCall } from './mesh-call.js'
import { CHECK_USAGE, publishableRefusal, runCheck } from './mesh-check.js'
import { SKILL_TARGETS, holdSetupLock, skillPlan } from './mesh-skills.js'
import type { SkillTarget } from './mesh-skills.js'
import { REQUEST_POST_USAGE, runRequestPost } from './request-post-client.js'
import type { RequestPostIo } from './request-post-client.js'
import { UNSLOP_USAGE, runUnslop } from './unslop-client.js'
import type { UnslopIo } from './unslop-client.js'
import { publicLookup } from './public-address.js'
import { AGENT_INBOX_VERSION } from './version.js'

const UNSLOP_PORT = 4420
const ENDPOINT_RULE = 'https://<name>.<tailnet>.ts.net[:<port>] or, for the SSH fallback only, http://127.0.0.1:<port>'

const USAGE = `usage: agent-inbox-meshctl status
       agent-inbox-meshctl --version
       agent-inbox-meshctl disable [--apply]
       agent-inbox-meshctl enable --agents-view [--apply]
       agent-inbox-meshctl enable --unslop [--port <n>] [--checkout <path>] [--apply]
       agent-inbox-meshctl disable --unslop [--purge] [--apply]
       agent-inbox-meshctl enable --request-post --endpoint <url> --token-file <path> [--apply]
       agent-inbox-meshctl disable --request-post [--purge] [--apply]
       agent-inbox-meshctl add <card-url> [--id <id>] [--token-file <path>] [--key-thumbprint <t>] [--apply]
       agent-inbox-meshctl add <card-url> --move <id> [--token-file <path>] [--key-thumbprint <t>] [--apply]
       agent-inbox-meshctl remove <id> [--apply]
       agent-inbox-meshctl key create|show|rotate|retire <agent> [--apply]
       agent-inbox-meshctl call <id> [--skill <skill>] [--json] [--report <file>] [--timeout <s>] < request
       agent-inbox-meshctl check <card-url> [--level local|publishable] [--strict] [--json] [--token-file <path> [--send <file>]]
       agent-inbox-meshctl forget-runs (--unslop | --request-post | --web-search | --id <id> | --all) [--apply]
       agent-inbox-meshctl skills link|unlink [--target claude|agents|all] [--apply]
       agent-inbox-meshctl unslop --kind <kind> [--report <file>] [--timeout <s>] < draft
       agent-inbox-meshctl request-post file|status|wait …

Without --apply, enable, disable, add, remove, forget-runs, skills and key are dry runs: they print what they would do.
The Agents view is always on, so enable --agents-view writes nothing.
enable --unslop needs packages/mesh built in the checkout (npm ci && npm run build there);
it listens on http://127.0.0.1:<port> only (default ${UNSLOP_PORT}). disable --unslop keeps the
profile, logs, deny list and run records unless --purge. unslop is what <mesh dir>/bin/unslop runs:
it sends one public draft to the agent (docs/unslop.md).
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
entry or takes a built-in name; remove deletes only an entry add wrote, and its token copy.
When the card declares a stable id (its profile extension), add records it as agentId.
add verifies the card's signatures (ES256, ES384 or EdDSA by a key the card's profile lists): one that fails
refuses the card; an unsigned card is allowed on loopback and this Mac's tailnet only. The keys
the card lists are pinned in the entry (trust on first use);
--key-thumbprint <t> refuses a card not signed by the key with that RFC 7638 thumbprint.
A card whose agent id an entry holds, signed by a key that entry pinned, is that agent at a new
endpoint: add moves it. add --move <id> moves agents.<id> to the card URL given, signed or not:
the card must declare the entry's agentId and match its pin; only the card URL and endpoint
change (and the token copy, with --token-file), so the pin and run records stay.
key create|show|rotate|retire <agent> manages <mesh dir>/mesh/keys/<agent>.jwk, the agent's
card-signing key (0600, never printed; show prints the public key and its thumbprint).
call sends one request to an added agent: it checks the card pin and, on loopback, the agent's
identity before it sends the token or any text, and prints the result framed as untrusted
(docs/mesh-call.md).
check runs the conformance tests on an A2A agent's card and writes nothing: exit 0 conforms, 17 a
test failed, 15 the card could not be fetched, 4 usage. Live tests need --token-file and create no
work unless --send <file> is given (docs/mesh-call.md).
request-post is what <mesh dir>/bin/request-post runs: it files a content request with the
service, reads its status or waits for it (docs/request-post.md).
Each client run appends a record without text to <mesh dir>/mesh/runs/, kept 30 days;
forget-runs deletes an agent's records now (--id <id> an added agent's, --all every agent's);
remove deletes an added agent's with its entry. Every enable and disable deletes expired ones.
Every enable and disable writes <mesh dir>/skills/<agent>/SKILL.md, the fixed routing skill, for
each agent that is on and has one (unslop), and removes the folders and links of agents that are off.
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
function profileTemplate(start: string[]): string {
  return `${JSON.stringify({
    _about: 'The unslop agent\'s profile (agent-inbox #483). Fill in skill, baseUrl and apiKey (or remove apiKey when the backend needs no key); the agent refuses to start until you do. start is what meshctl runs.',
    skill: 'FILL IN: the absolute path of the unslop skill folder, which holds rules.md',
    baseUrl: 'FILL IN: the https:// base URL of the OpenAI-compatible backend (http:// only on a loopback address)',
    apiKey: { env: 'FILL IN: the name of the environment variable holding the key, or use { "file": "/absolute/path" } (0600) or { "command": ["/absolute/path", "arg"] }' },
    model: 'chat-long',
    sampling: { temperature: 0.2, top_p: 0.9, presence_penalty: 0 },
    terms: [], allowEmails: [], customerPaths: [],
    start,
  }, null, 2)}\n`
}

const shQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

// The shim never reads a terminal: on a stale path it discards piped input only.
// It pins the mesh dir it was written for, so the caller's environment (no
// AGENT_INBOX_MESH_DIR, or an AGENT_INBOX_DB) cannot point it at another one.
function shimText(agent: string, issue: number, node: string, script: string, dir: string): string {
  return `#!/bin/sh
# agent-inbox ${agent} shim (#${issue}), written by meshctl enable --${agent}. Do not edit.
AGENT_INBOX_MESH_DIR=${shQuote(dir)}; export AGENT_INBOX_MESH_DIR
node=${shQuote(node)}
meshctl=${shQuote(script)}
if [ ! -x "$node" ] || [ ! -f "$meshctl" ]; then
  [ -t 0 ] || cat > /dev/null
  echo 'agent-inbox ${agent}: this shim is stale: run meshctl enable --${agent} again' >&2
  exit 14
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

function runSteps(steps: Step[], apply: boolean, out: (text: string) => void, err: (text: string) => void, failed: string): number {
  const n = steps.length
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

export function runMeshctl(argv: string[], io: MeshctlIo = {}): number {
  const code = meshctl(argv, io)
  // deleting expired run records is housekeeping, not a configuration change, so a dry run
  // does it too (cards view V5 §5.6)
  if ((argv[0] === 'enable' || argv[0] === 'disable') && code !== 2) {
    pruneRuns(resolve(meshDir(io.env ?? process.env, io.home ?? homedir())), (io.now ?? (() => new Date()))().getTime())
  }
  return code
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function meshctl(argv: string[], io: MeshctlIo): number {
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
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (['--port', '--checkout', '--endpoint', '--token-file', '--id', '--target'].includes(arg)) {
      const value = rest[++i]
      if (value === undefined || values.has(arg)) return usage()
      values.set(arg, value)
    } else if (flags.has(arg)) return usage()
    else flags.add(arg)
  }
  const apply = flags.delete('--apply')
  const unslop = flags.delete('--unslop')
  const requestPost = flags.delete('--request-post')
  if (command === 'forget-runs') {
    const all = flags.delete('--all')
    const id = values.get('--id')
    const picked: string[] = [...(unslop ? ['unslop'] : []), ...(requestPost ? ['request-post'] : []), ...(flags.delete('--web-search') ? ['web-search'] : []), ...(id === undefined ? [] : [id])]
    if (flags.size || [...values.keys()].some((key) => key !== '--id') || (all ? picked.length : picked.length !== 1) || (id !== undefined && idRefusal(id))) return usage()
    return forgetRuns(resolve(meshDir(env, home)), all ? 'all' : picked, apply, now().getTime(), out, err)
  }
  if (unslop && requestPost) return usage()
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
    if (!apply || !steps.some((step) => step.lock)) return runSteps(steps, apply, out, err, failed)
    const lock = holdSetupLock(env, home)
    if ('refused' in lock) return refuse(lock.refused)
    try {
      return runSteps(steps, apply, out, err, failed)
    } finally {
      lock.release()
    }
  }

  if (command === 'skills') {
    const sub = rest[0]
    if ((sub !== 'link' && sub !== 'unlink') || !flags.delete(sub) || flags.size || !only('--target') || unslop || requestPost) return usage()
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
    if (flags.size || values.size || apply || unslop || requestPost) return usage()
    out(`${ALWAYS_ON}\n`)
    const existing = readMesh(file)
    const agents = existing.kind === 'present' ? objectOf(existing.doc['agents']) : undefined
    const entry = agents?.['unslop']
    const port = entry === undefined ? undefined : loopbackPort(objectOf(entry)?.['endpoint'])
    const rpEntry = agents?.['request-post']
    const rpEndpoint = rpEntry === undefined ? undefined : requestPostEndpoint(objectOf(rpEntry)?.['endpoint'])
    const added = Object.entries(agents ?? {}).flatMap(([id, value]) => {
      const read = addedEntry(id, value)
      return read === undefined ? [] : [{ id, read }]
    })
    const valid = added.filter((a) => a.read !== 'invalid').length
    const pieces = [...(port ? ['unslop'] : []), ...(rpEndpoint ? ['request-post'] : []), ...(valid ? [plural(valid, 'added agent')] : [])].join(' and ')
    if (existing.kind === 'missing') out(`Mesh: off. No ${name}.\n`)
    else if (existing.kind === 'refused') out(`Mesh: off. ${name} ${existing.reason}, so it is read as off.\n`)
    else out(pieces ? `Mesh: on. ${name} turns on ${pieces}.\n` : `Mesh: off. ${name} turns on no piece this build reads.\n`)
    const has = (path: string): string => (exists(path) ? 'present' : 'missing')
    const state = port ? `on at http://127.0.0.1:${port}` : entry === undefined ? 'off' : 'off (agents.unslop.endpoint is not http://127.0.0.1:<port>)'
    out(`Unslop: ${state}. Profile ${show(paths.profile)}: ${has(paths.profile)}; token: ${has(paths.token)}; shim ${show(paths.shim)}: ${has(paths.shim)}.\n`)
    // the endpoint is printed only when it passed the rule, so it can hold no token
    const rp = requestPostPaths(dir)
    const rpState = rpEndpoint ? `on at ${rpEndpoint}` : rpEntry === undefined ? 'off' : `off (agents.request-post.endpoint is not ${ENDPOINT_RULE})`
    out(`Request-post: ${rpState}. Token: ${has(rp.token)}; shim ${show(rp.shim)}: ${has(rp.shim)}.\n`)
    // an id or field that breaks its rule is never echoed: it is a hand edit, and could hold anything
    for (const { id, read } of added) {
      const who = idRefusal(id) ? 'an entry with an id meshctl add refuses' : id
      out(read === 'invalid'
        ? `Added agent ${who}: off (the entry breaks meshctl add's rules; remove it and add it again).\n`
        : `Added agent ${id}: at ${read.endpoint}${read.agentId === undefined ? '' : ` (agent id ${read.agentId})`}; card pin ${read.cardSha256.slice(0, 12)}…; token: ${read.tokenFile === undefined ? 'none' : has(read.tokenFile)}.\n`)
    }
    return existing.kind === 'refused' ? 1 : 0
  }

  if (command === 'remove') {
    const ids = rest.filter((arg) => arg !== '--apply')
    if (ids.length !== 1 || rest.length > 2 || ids[0]!.startsWith('-')) return usage()
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
    if (!steps.length) {
      out(`${id} is not in ${name}. Nothing to do.\n`)
      return 0
    }
    return runSteps(steps, apply, out, err, 'Steps before it are done; nothing after it ran.')
  }

  if (command === 'enable' && !unslop && !requestPost) {
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

  if (command === 'enable') {
    if (flags.size || !only('--port', '--checkout')) return usage()
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
    const start = [node, wrap, '--agent', 'openai-compatible', '--profile', 'unslop']
    const template = profileTemplate(start)
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
      exists(paths.profile)
        ? {
            dry: `Would keep the profile ${show(paths.profile)} (present; never overwritten).`,
            run: () => `Kept ${show(paths.profile)}. If Node or the checkout moved, set its "start" by hand to ${JSON.stringify(start)}.`,
          }
        : {
            dry: `Would write the profile template ${show(paths.profile)} (0600):\n${template}`,
            run: () => { dirs(); writeNew(paths.profile, template, 0o600, true); return `Wrote ${show(paths.profile)}: fill in skill, baseUrl and apiKey.` },
          },
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
        if (lstatSync(paths.logs).isDirectory()) logs = readdirSync(paths.logs).filter((entry) => /^unslop-/.test(entry)).sort()
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

  if (command === 'disable') {
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
 * `add <card-url> [--id <id> | --move <id>] [--token-file <path>] [--apply]` (#529, mesh design
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
 */
export async function runAdd(args: string[], io: MeshctlIo = {}): Promise<number> {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const now = io.now ?? (() => new Date())
  const out = io.out ?? ((text: string) => { process.stdout.write(text) })
  const err = io.err ?? ((text: string) => { process.stderr.write(text) })
  const usage = (): number => { err(USAGE); return 2 }
  const refuse = (reason: string): number => { err(`Refused: ${reason}. Nothing changed.\n`); return 1 }
  const show = (path: string): string => shown(path, home)

  let cardUrl: string | undefined
  let id: string | undefined
  let move: string | undefined
  let tokenFile: string | undefined
  let thumbprint: string | undefined
  let apply = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--apply' && !apply) apply = true
    else if (arg === '--id' || arg === '--move' || arg === '--token-file' || arg === '--key-thumbprint') {
      const value = args[++i]
      if (value === undefined || (arg === '--id' ? id : arg === '--move' ? move : arg === '--token-file' ? tokenFile : thumbprint) !== undefined) return usage()
      if (arg === '--id') id = value
      else if (arg === '--move') move = value
      else if (arg === '--token-file') tokenFile = value
      else thumbprint = value
    } else if (!arg.startsWith('-') && cardUrl === undefined) cardUrl = arg
    else return usage()
  }
  if (cardUrl === undefined || (id !== undefined && move !== undefined)) return usage()
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

  const existing = readMesh(file)
  const agents = agentsOf(existing)
  if (typeof agents === 'string') return refuse(agents)
  const holder = profile === undefined ? undefined : Object.keys(agents).find((key) => {
    const read = addedEntry(key, agents[key])
    return read !== undefined && read !== 'invalid' && read.agentId === profile.id
  })
  // the signed move (§3.4): the holder's pinned keys signed this card, so it is that agent
  const held = holder === undefined ? undefined : addedEntry(holder, agents[holder])
  const endorsed = held !== undefined && held !== 'invalid' && (held.keyThumbprints ?? []).some((k) => signedBy.includes(k))
  const target = move ?? (endorsed && id === undefined ? holder : undefined)
  const pinned = { ...(verdict.keys.length ? { keyThumbprints: verdict.keys } : {}) }
  let agentId: string
  let entry: Record<string, unknown>
  let moved: Movable | undefined
  if (target === undefined) {
    if (holder !== undefined) {
      return refuse(endorsed
        ? `the card is agents.${holder}'s agent, signed by a key its pinned card lists: to move ${holder} here, add it without --id`
        : signedBy.length
          ? `the card declares the agent id that agents.${holder} holds, but no key agents.${holder}'s pinned card lists signed it, so add cannot tell it is that agent`
          : `the card declares the agent id that agents.${holder} holds, so it is that agent: to move ${holder} here, add --move ${holder} (its pin and run records stay)`)
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
  const tokens = join(dir, 'mesh', 'tokens')
  const copy = join(tokens, agentId)
  const present = existing.kind === 'present'
  const next: MeshDocument = { ...(present ? existing.doc : { schema: MESH_SCHEMA }), agents: { ...agents, [agentId]: entry } }
  const json = `${JSON.stringify(next, null, 2)}\n`

  out(addSummary(card, { cardUrl: place.url, endpoint: endpoint.endpoint, reach, token: token !== undefined || moved?.tokenFile !== undefined, pin, profile, signed: signedLine(verdict, trust) }))
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
  steps.push({
    dry: `Would ${present ? 'replace' : 'create'} ${name}${present ? ' (keeping a backup beside it)' : ''}:\n${json}`,
    run: () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const backup = present ? ` (backup: ${show(writeBackup(file, now()))})` : ''
      writeAtomic(file, json, 0o644)
      return `Wrote ${name}${backup}: ${agentId} is ${moved ? 'moved to' : 'added at'} ${endpoint.endpoint}.`
    },
  })
  const code = runSteps(steps, apply, out, err, `Steps before it are done; ${name} was not changed.`)
  if (apply && code === 0) {
    out(moved
      ? `${agentId} keeps its card pin and run records. meshctl call ${agentId} < request calls it at the new endpoint.\n`
      : `This --apply is your approval for ${agentId} (D14). meshctl call ${agentId} < request calls it; meshctl remove ${agentId} --apply takes it out.\n`)
  }
  return code
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
export async function runClient(command: 'unslop' | 'request-post' | 'call', args: string[], io: ClientIo & { tailnet?: () => string | undefined }): Promise<number> {
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
      : command === 'call'
        ? await runCall(args, { tailnet: magicDnsSuffix, ...io, run }).catch(() => { run.internal = true; io.err('meshctl call: failed (internal error).\n'); return 13 })
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
  process.exitCode = command === 'unslop' || command === 'request-post' || command === 'call'
    ? await runClient(command, rest, { env: process.env, home: homedir(), stdin: process.stdin, out: (text) => { process.stdout.write(text) }, err: (text) => { process.stderr.write(text) } })
    : command === 'add' ? await runAdd(rest)
      : command === 'check' ? await runCheck(rest, { tailnet: magicDnsSuffix, out: (text) => { process.stdout.write(text) }, err: (text) => { process.stderr.write(text) } })
        : runMeshctl(process.argv.slice(2))
}
