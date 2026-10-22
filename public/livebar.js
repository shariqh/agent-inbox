// The Live footer strip's summary line (spec §16). Pure: no DOM, no clock —
// the caller passes nowMs. Live is ambient presence, so this never produces a
// number that reads as a to-do.
import { freshnessTone } from './rowview.js'

/**
 * @param {Array<any>} activity rows from /api/activity
 * @param {number} nowMs
 * @returns {{count:number,idleCount:number,tone:string,label:string,sessions:Array<{session:string,project:string,agent:string,label:string,tone:string}>}}
 */
export function liveSummary(activity, nowMs) {
  const rows = Array.isArray(activity) ? activity.filter(Boolean) : []
  const active = rows.filter((a) => a && !a.idle)
  const sessions = active.map((a) => ({
    session: a.session,
    project: a.project,
    agent: a.agent,
    label: `${a.project}/${a.agent}`,
    tone: freshnessTone(nowMs - Date.parse(lastActivityAt(a))),
  }))
  // the strip takes the FRESHEST tone: one actively-working agent must not be
  // hidden behind a quieter one
  const rank = { fresh: 0, aging: 1, quiet: 2 }
  const tone = sessions.length
    ? sessions.reduce((best, s) => (rank[s.tone] < rank[best] ? s.tone : best), 'quiet')
    : 'idle'
  return {
    count: active.length,
    idleCount: rows.length - active.length,
    tone,
    label: active.length
      ? `${active.length} reporting work`
      : rows.length ? `${rows.length} connected · no task reported` : 'no agent connections',
    sessions,
  }
}

// ── issue #45: when a session last actually DID something ───────────────────
//
// `updated_at` is liveness, not activity: the MCP server bumps it every five
// minutes whether or not the agent has made a single call, so a dot keyed on it
// re-greens forever and "last activity 30s ago" only ever meant "this process
// has not crashed". `last_call_at` is written by real MCP calls alone. It is
// NULL until a session makes its first one (a just-registered presence row, or
// a row written by a server still running the old code), and `started_at`
// stands in — the same fallback src/store.ts uses to decide a claim is cold, so
// the dot and the decay can never disagree.
export function lastActivityAt(a) {
  return a?.last_call_at ?? a?.started_at ?? a?.updated_at
}

// Long-idle: not an error and not attention — just a terminal somebody left
// open. The Live surface keeps it (the session IS present, and its questions
// still classify as "waiting"), but it sorts last and reads as background.
export const DORMANT_MS = 8 * 60 * 60 * 1000

export function isDormant(a, nowMs) {
  return nowMs - Date.parse(lastActivityAt(a)) >= DORMANT_MS
}

// A stale claim must not stay "working", but throwing its words away leaves an
// idle session with no useful identity beyond project/agent. `last_doing` is a
// historical caption only: it never participates in state, freshness, or
// attention.
export function activitySynopsis(a) {
  const current = typeof a?.doing === 'string' ? a.doing.trim() : ''
  if (!a?.idle && current && current !== 'open') return { text: current, historical: false }
  const last = typeof a?.last_doing === 'string' ? a.last_doing.trim() : ''
  if (last && last !== 'open') return { text: last, historical: true }
  return { text: 'No task reported yet', historical: false }
}

// ── issue #197: which Agent Inbox build a session runs ───────────────────────
//
// Each session's MCP server records its own version when it registers, and
// whether it runs from an installed agent runtime or a checkout; the viewer says
// what the current build is, what it has verified, and what each host is
// registered to run (`/api/version`). A session strictly older than the current
// build gets a quiet hint whose advice fits where THAT session runs from and
// what its host would load on restart, and is left out when nothing backs it.
// Presence, not attention: nothing here reaches the badge, Needs-you or a
// notification.
// And it never guesses — both versions must be strict semver
// (https://semver.org) before anything is compared, and a session whose own
// version is unknown renders nothing at all.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
// Display only: a "version" longer than any real release is not shown at all.
const MAX_VERSION_LENGTH = 64

function parseSemver(value) {
  if (typeof value !== 'string' || value.length > MAX_VERSION_LENGTH) return null
  const m = SEMVER.exec(value)
  return m ? { core: [m[1], m[2], m[3]], pre: m[4] ? m[4].split('.') : [] } : null
}

// Digit strings without leading zeros: the longer one is larger, and equal
// lengths compare as text. No Number(), so nothing rounds past 2^53.
function compareDigits(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

// semver §11: numeric identifiers compare numerically and sort below
// alphanumeric ones, which compare in ASCII order.
function compareIdentifiers(a, b) {
  const numeric = /^\d+$/
  const an = numeric.test(a)
  const bn = numeric.test(b)
  if (an && bn) return compareDigits(a, b)
  if (an !== bn) return an ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

// Precedence only: build metadata never counts, and a release outranks its
// own pre-releases.
function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    const c = compareDigits(a.core[i], b.core[i])
    if (c) return c
  }
  if (!a.pre.length || !b.pre.length) {
    if (a.pre.length === b.pre.length) return 0
    return a.pre.length ? -1 : 1
  }
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const c = compareIdentifiers(a.pre[i], b.pre[i])
    if (c) return c
  }
  return a.pre.length === b.pre.length ? 0 : a.pre.length < b.pre.length ? -1 : 1
}

// The Setup host behind a session's MCP client, by the agent name its server
// inferred (src/infer.ts inferAgent). Any other client is not one Setup
// registers, so nothing here can say what a restart of it would load.
const SETUP_HOSTS = { 'claude-code': 'claude', copilot: 'copilot' }

/** @returns {'claude'|'copilot'|null} */
export function hostOfAgent(agent) {
  return typeof agent === 'string' && Object.hasOwn(SETUP_HOSTS, agent) ? SETUP_HOSTS[agent] : null
}

/** Semver precedence of two versions (-1, 0, 1), or null unless both are strict semver. */
export function compareVersions(a, b) {
  const x = parseSemver(a)
  const y = parseSemver(b)
  return x && y ? compareSemver(x, y) : null
}

// What a restart of THIS runtime session would load: its host's registration,
// when that is Setup's runtime at a known version (#197 part 2). Only a release
// viewer verifies registrations against a runtime it can install, so a
// checkout viewer, a checkout or legacy session, a client that is neither host
// and an older viewer without `hosts` all answer null.
function registeredRuntime(a, info) {
  if (a.server_source !== 'runtime' || info.mode !== 'release') return null
  const host = hostOfAgent(a.agent)
  const hosts = info.hosts && typeof info.hosts === 'object' ? info.hosts : null
  const registered = host && hosts ? hosts[host] : null
  if (registered?.kind !== 'runtime') return null
  const version = parseSemver(registered.version)
  return version ? { version, label: `v${registered.version}` } : null
}

// The advice that would update an OLDER session to the current build, or none.
// A checkout session is updated in its checkout, whatever this viewer is. A
// runtime session loads, on restart, whatever ITS HOST is registered to run, not
// merely what is installed. So it is told to restart only when that
// registration is Setup's runtime at the current build or later, and to update
// its agents from Setup first only when Setup would actually offer that
// (`updatable`: the app's own runtime verifies, so Setup shows the action).
// Anything else gets no advice.
function remedy(a, info, current) {
  if (a.server_source === 'checkout') return ' — update and rebuild its checkout, then restart this session'
  const registered = registeredRuntime(a, info)
  if (!registered) return ''
  if (compareSemver(registered.version, current) >= 0) return ` — restart this session to load ${registered.label}`
  if (info.updatable === true) return ' — update agents from Setup, then restart this session'
  return ''
}

/**
 * `older`: the session runs an older build than `info.current`, with the advice
 * that backs it. `newer` (#197 part 2): it runs a newer build than its host is
 * now registered to run, and that registration IS this app's build — after
 * agents were matched back to a downgraded app — so a restart loads it. A newer
 * session whose host still runs that newer build, or runs an older one than
 * the app, gets no marker: a restart would not bring it to this app's build.
 * @param {any} a an /api/activity row, with its agent, server_version and server_source
 * @param {any} info the /api/version body: {current, mode, runtimeInstalled, updatable, hosts}, or null
 * @returns {{label: string, older: boolean, newer: boolean, hint: string} | null} null renders nothing
 */
export function sessionBuild(a, info) {
  const own = parseSemver(a?.server_version)
  if (!own) return null
  const label = `v${a.server_version}`
  const current = parseSemver(info?.current)
  const none = { label, older: false, newer: false, hint: '' }
  if (!current) return none
  const order = compareSemver(own, current)
  if (order < 0) return { label, older: true, newer: false, hint: `older build (${label})${remedy(a, info, current)}` }
  if (order === 0) return none
  const registered = registeredRuntime(a, info)
  if (!registered || compareSemver(registered.version, current) !== 0) return none
  return { label, older: false, newer: true, hint: `newer build (${label}) — restart this session to load ${registered.label}` }
}
