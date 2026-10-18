// Issue #197, part 2 — the Setup panel's agents block. Pure: no DOM, no fetch.
//
// The viewer reports what each host is REGISTERED to run (/api/setup `agents`,
// read from the host config files by src/agent-hosts.ts). This says it in one
// line per host, picks the Setup-managed hosts whose runtime is older than this
// app's, names the one fixed install target that moves exactly those, and —
// after an update — says which running sessions still need a restart and how.
// A restart is the only way a running session loads a new build, so nothing
// here ever says one reloaded.
import { compareVersions, hostOfAgent } from './livebar.js'

const LABELS = { claude: 'Claude Code', copilot: 'Copilot CLI', hooks: 'Claude hooks' }
const RESUME = { claude: 'claude --resume', copilot: 'copilot --resume' }
const KINDS = new Set(['none', 'runtime', 'checkout', 'other', 'unknown'])

/** @param {'claude'|'copilot'|'hooks'} host */
export function hostLabel(host) {
  return LABELS[host] ?? host
}

// A version this module will print: strict semver, as livebar.js compares it.
const isVersion = (value) => compareVersions(value, value) !== null
const plural = (n, one, many) => (n === 1 ? one : many)

function registration(reg) {
  return reg && typeof reg === 'object' && KINDS.has(reg.kind) ? reg : { kind: 'unknown' }
}

/**
 * One host's line: which build it is registered to run, and whether that is a
 * Setup runtime older than `current` (the runtime this app installs; null on a
 * checkout viewer, which has none to compare with).
 * @returns {{host: string, label: string, kind: string, outdated: boolean, text: string}}
 */
export function hostLine(host, reg, current) {
  const r = registration(reg)
  const label = hostLabel(host)
  const line = (text, outdated = false) => ({ host, label, kind: r.kind, outdated, text })
  switch (r.kind) {
    case 'none':
      return line(host === 'hooks' ? 'not installed' : 'not registered')
    case 'runtime': {
      const order = compareVersions(r.version, current)
      if (order === null) return line(isVersion(r.version) ? `v${r.version} runtime (Setup)` : 'Setup runtime (version unknown)')
      if (order < 0) return line(`v${r.version} runtime (Setup) — older than this app's v${current}`, true)
      if (order > 0) return line(`v${r.version} runtime (Setup) — newer than this app's v${current}`)
      return line(`v${r.version} runtime (Setup)`)
    }
    case 'checkout':
      return line(typeof r.path === 'string' && r.path
        ? `source checkout at ${r.path} (not managed by Setup)`
        : 'source checkout (not managed by Setup)')
    case 'other':
      return line(host === 'hooks' ? 'custom hooks (not managed by Setup)' : 'custom command (not managed by Setup)')
    default:
      return line('could not be verified, so Setup leaves it unchanged')
  }
}

/** The hosts whose agent-inbox registration is a Setup runtime older than `agents.current`. */
export function outdatedHosts(agents) {
  if (!agents || typeof agents !== 'object') return []
  return ['claude', 'copilot'].filter((host) => hostLine(host, agents[host], agents.current ?? null).outdated)
}

/** The one fixed install target that moves exactly these hosts, or null. */
export function updateTarget(hosts) {
  const set = new Set(hosts)
  if (set.has('claude') && set.has('copilot')) return 'all'
  if (set.has('claude')) return 'claude'
  if (set.has('copilot')) return 'copilot'
  return null
}


/**
 * After an update: for each updated host, the running sessions that still run
 * an older build than `current`, and how to restart them. Sessions too old to
 * report a build are counted separately rather than guessed at.
 * @returns {string[]}
 */
export function restartGuidance(activity, hosts, current) {
  const rows = Array.isArray(activity) ? activity.filter(Boolean) : []
  return hosts.map((host) => {
    const mine = rows.filter((a) => hostOfAgent(a.agent) === host)
    const older = mine.filter((a) => compareVersions(a.server_version, current) === -1).length
    const silent = mine.filter((a) => !isVersion(a.server_version)).length
    const label = hostLabel(host)
    let text = older
      ? `${label}: ${older} running ${plural(older, 'session still runs', 'sessions still run')} an older build. `
        + `Restart ${plural(older, 'it', 'each one')} to load v${current}: exit it, then run ${RESUME[host]} to pick the conversation back up.`
      : `${label}: no running session reports an older build.`
    if (silent) {
      text += ` ${silent} ${plural(silent, 'session does not report its build; restart it', 'sessions do not report their build; restart them')} to be sure.`
    }
    return text
  })
}
