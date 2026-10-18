// Issue #197, part 2 — the Setup panel's agents block. Pure: no DOM, no fetch.
//
// The viewer reports what each host is REGISTERED to run (/api/setup `agents`,
// read from the host config files by src/agent-hosts.ts). This says it in one
// line per host, picks the Setup-managed hosts whose runtime differs from this
// app's (older, or newer after an app downgrade), names the one action that
// moves exactly those — one fixed install target per host — and, afterwards,
// says which running sessions still run another build than their host now
// loads, and how to restart them. A restart is the only way a running session
// loads another build, so nothing here ever says one reloaded.
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
 * One host's line: which build it is registered to run and, for a Setup
 * runtime, which way it differs from `current` (the runtime this app installs;
 * null on a checkout viewer, which has none to compare with).
 * @returns {{host: string, label: string, kind: string, outdated: boolean, drift: 'older'|'newer'|null, text: string}}
 */
export function hostLine(host, reg, current) {
  const r = registration(reg)
  const label = hostLabel(host)
  const line = (text, drift = null) => ({ host, label, kind: r.kind, outdated: drift === 'older', drift, text })
  switch (r.kind) {
    case 'none':
      return line(host === 'hooks' ? 'not installed' : 'not registered')
    case 'runtime': {
      const order = compareVersions(r.version, current)
      if (order === null) return line(isVersion(r.version) ? `v${r.version} runtime (Setup)` : 'Setup runtime (version unknown)')
      if (order < 0) return line(`v${r.version} runtime (Setup) — older than this app's v${current}`, 'older')
      if (order > 0) return line(`v${r.version} runtime (Setup) — newer than this app's v${current}`, 'newer')
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

const names = (hosts) => hosts.map(hostLabel).join(' and ')
const KEEP = 'Running sessions keep their build until you restart them.'

/**
 * The ONE action that moves every Setup-managed host whose runtime differs
 * from this app's onto it, or null. It works in both directions (the installer
 * replaces a registration it owns either way): hosts that are only behind get
 * "Update agents"; a host that is ahead — the app was downgraded — gets "Match
 * agents to vX", which also names the action when hosts differ both ways. It
 * never includes a checkout, a custom or unverifiable registration, or a
 * runtime of unknown version, and there is none where Setup cannot install this
 * app's runtime (`updatable`) or there is no runtime to compare with.
 *
 * Its `steps` are one fixed install target per host, run one after another:
 * `--target all` stops before changing anything when one host's CLI is gone,
 * which would leave the other host stuck behind it too.
 * @returns {{steps: Array<{host: string, progress: string, done: string}>, label: string, hint: string, elsewhere: string} | null}
 */
export function agentsAction(agents) {
  if (!agents || typeof agents !== 'object' || agents.updatable !== true) return null
  const current = typeof agents.current === 'string' ? agents.current : null
  if (!current) return null
  const lines = ['claude', 'copilot'].map((host) => hostLine(host, agents[host], current)).filter((line) => line.drift)
  if (!lines.length) return null
  const older = lines.filter((line) => line.drift === 'older').map((line) => line.host)
  const newer = lines.filter((line) => line.drift === 'newer').map((line) => line.host)
  const hosts = lines.map((line) => line.host)
  const steps = lines.map(({ host, label, drift }) => drift === 'older'
    ? { host, progress: `Updating ${label}…`, done: `${label} updated.` }
    : { host, progress: `Matching ${label} to v${current}…`, done: `${label} now matches v${current}.` })
  if (!newer.length) {
    return {
      steps,
      label: 'Update agents',
      hint: `Update agents moves ${names(older)} to the v${current} runtime. ${KEEP}`,
      elsewhere: `Open Settings in the Agent Inbox app to update ${names(older)} to the v${current} runtime.`,
    }
  }
  const label = `Match agents to v${current}`
  return {
    steps,
    label,
    hint: older.length
      ? `${label} updates ${names(older)} and moves ${names(newer)} back to this app's runtime. ${KEEP}`
      : `${names(newer)} ${plural(newer.length, 'runs', 'run')} a newer runtime than this app. ${label} moves ${plural(newer.length, 'it', 'them')} to this app's runtime. ${KEEP}`,
    elsewhere: `Open Settings in the Agent Inbox app to match ${names(hosts)} to the v${current} runtime.`,
  }
}

/**
 * After an update or match: for each moved host, the running sessions whose
 * build differs from what THAT host is now registered to run (`moves`:
 * `{host, version}`) — older, newer, or both — and how to restart them.
 * Sessions too old to report a build are counted separately rather than
 * guessed at.
 * @returns {string[]}
 */
export function restartGuidance(activity, moves) {
  const rows = Array.isArray(activity) ? activity.filter(Boolean) : []
  return moves.map(({ host, version }) => {
    const label = hostLabel(host)
    const mine = rows.filter((a) => hostOfAgent(a.agent) === host)
    if (!mine.length) return `${label}: no running sessions.`
    const order = mine.map((a) => compareVersions(a.server_version, version))
    const behind = order.filter((o) => o === -1).length
    const ahead = order.filter((o) => o === 1).length
    const differ = behind + ahead
    const silent = mine.filter((a) => !isVersion(a.server_version)).length
    const build = !ahead ? 'an older build' : !behind ? 'a newer build' : 'a different build'
    const parts = [`${label}:`]
    if (differ) {
      parts.push(`${differ} running ${plural(differ, 'session still runs', 'sessions still run')} ${build}.`
        + ` Restart ${plural(differ, 'it', 'each one')} to load v${version}: exit it, then run ${RESUME[host]} to pick the conversation back up.`)
    } else if (silent < mine.length) {
      parts.push(`every running session that reports its build already runs v${version}.`)
    }
    if (silent) {
      parts.push(`${silent} ${plural(silent, 'session does not report its build; restart it', 'sessions do not report their build; restart them')} to be sure.`)
    }
    return parts.join(' ')
  })
}
