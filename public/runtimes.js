// Issue #294, part B — the Setup panel's Runtimes block. Pure: no DOM, no fetch.
//
// The viewer lists each folder under the runtime root (/api/setup `runtimes`,
// from src/runtime-inventory.ts) with its size and what uses it, by the rule
// prune-runtimes.sh applies before it removes one. This says each line, names
// the ONE action that removes the unused ones, and says why there is none. The
// action is Setup's fixed `prune-runtimes` target, which takes no list: the
// script decides again under the setup lock, and also keeps a runtime that a
// running process uses.

export const RUNTIMES_LEAD = 'Setup keeps a copy of Node for each Agent Inbox version it installed, in ~/.agent-inbox/runtime.'
export const PROJECT_SCOPE_NOTE = "Setup does not read a project's own settings (.mcp.json or .claude/settings.json). A session started from one keeps its runtime while it runs."

const LEFT_ALONE = {
  changed: 'changed since Setup installed it, so Setup leaves it',
  'not-a-runtime': 'not an Agent Inbox runtime, so Setup leaves it',
}
const plural = (n, one, many) => (n === 1 ? one : many)
const and = (items) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/** A size as Settings says it: 171 MB, 850 KB. */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

function entriesOf(runtimes) {
  return runtimes && typeof runtimes === 'object' && Array.isArray(runtimes.entries)
    ? runtimes.entries.filter((e) => e && typeof e.runtimeId === 'string')
    : []
}

// What each runtime is called: its version, or with its id when two share one.
function names(entries) {
  const count = new Map()
  for (const e of entries) if (typeof e.version === 'string') count.set(e.version, (count.get(e.version) ?? 0) + 1)
  return new Map(entries.map((e) => [e.runtimeId,
    typeof e.version !== 'string' ? e.runtimeId : count.get(e.version) > 1 ? `v${e.version} (${e.runtimeId})` : `v${e.version}`]))
}

/** Running sessions that report running Setup's runtime of `version` (Live's /api/activity rows). */
function sessionsOn(activity, version) {
  return Array.isArray(activity)
    ? activity.filter((a) => a && a.server_source === 'runtime' && a.server_version === version).length
    : 0
}

/**
 * One line per runtime folder: its name, what uses it or why Setup leaves it,
 * and its size. An unused runtime that running sessions report they run says
 * so, since the prune keeps it while they run.
 * @returns {Array<{runtimeId: string, status: string, text: string}>}
 */
export function runtimeLines(runtimes, activity) {
  const entries = entriesOf(runtimes)
  const named = names(entries)
  return entries.map((e) => {
    const size = typeof e.bytes === 'number' ? ` · ${formatBytes(e.bytes)}` : ''
    const usedBy = Array.isArray(e.usedBy) ? e.usedBy.filter((u) => typeof u === 'string') : []
    let what = ''
    if (e.status === 'current') what = ": this app's runtime"
    else if (e.status === 'used') what = `: used by ${and(usedBy)}`
    else if (e.status === 'unused') what = ': not used'
    else if (Object.hasOwn(LEFT_ALONE, e.status)) what = `: ${LEFT_ALONE[e.status]}`
    const sessions = e.status === 'unused' ? sessionsOn(activity, e.version) : 0
    const live = sessions
      ? ` · ${sessions} running ${plural(sessions, 'session reports', 'sessions report')} v${e.version}, which keeps it while ${plural(sessions, 'it runs', 'they run')}`
      : ''
    return { runtimeId: e.runtimeId, status: e.status, text: `${named.get(e.runtimeId)}${what}${size}${live}` }
  })
}

/**
 * The ONE action that removes every unused runtime, or null: only when the
 * viewer could tell what uses each one and Setup can run its prune here. `ids`
 * is what it names, for the check just before it runs; it is never sent.
 * @returns {{ids: string[], label: string, hint: string} | null}
 */
export function runtimesAction(runtimes) {
  if (!runtimes || runtimes.state !== 'ok' || runtimes.removable !== true) return null
  const entries = entriesOf(runtimes)
  const unused = entries.filter((e) => e.status === 'unused')
  if (!unused.length) return null
  const named = names(entries)
  const which = unused.map((e) => named.get(e.runtimeId))
  const size = formatBytes(unused.reduce((sum, e) => sum + (typeof e.bytes === 'number' ? e.bytes : 0), 0))
  return {
    ids: unused.map((e) => e.runtimeId),
    label: unused.length === 1 ? `Remove the ${which[0]} runtime (${size})` : `Remove ${unused.length} unused runtimes (${size})`,
    hint: `Removes the ${and(which)} ${plural(unused.length, 'runtime', 'runtimes')}. Setup checks again first and keeps any runtime that an agent, a hook or a running session still uses.`,
  }
}

/**
 * What the block says when it offers no button for unused runtimes, or null:
 * a host config that proves nothing (and why), a window that may not run
 * Setup, or a build whose Setup cannot run the prune.
 */
export function runtimesNote(runtimes, canRun) {
  if (!runtimes || typeof runtimes !== 'object') return null
  if (runtimes.state === 'unknown') {
    const lead = "Setup can't tell which runtimes are in use, so it offers to remove none."
    const { unreadable: file, reason } = runtimes
    return typeof file === 'string' && file && typeof reason === 'string' && reason ? `${lead} ${file} ${reason}.` : lead
  }
  if (!entriesOf(runtimes).some((e) => e.status === 'unused')) return null
  if (runtimes.removable !== true) {
    return 'Setup removes runtimes only in a release build of the Agent Inbox app. From a terminal, a runtime\'s own scripts/prune-runtimes.sh --apply does the same; docs/INSTALL.md says how.'
  }
  return canRun ? null : 'Open Settings in the Agent Inbox app to remove them.'
}
