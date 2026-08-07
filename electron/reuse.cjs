// Pure launcher decision logic for the Electron shell (GitHub issue #23).
//
// Dependency-free CommonJS so `main.cjs` can `require('./reuse.cjs')` directly
// (no dist build, no Electron ABI concerns) and the vitest suite can unit-test
// it in isolation. All time/IO is injected, so these functions are pure and
// deterministic under test.

/**
 * Decide whether to reuse an already-running viewer, re-probing before we
 * commit. A single probe can catch a DYING standalone viewer mid-shutdown: it
 * answers once, we choose "reuse", it then vanishes, and the app strands on a
 * dead page without ever starting its own server (issue #23). So probe, wait a
 * beat, and probe again — only reuse when it is still alive the second time.
 *
 * @param {() => Promise<boolean>} probe   resolves true if the port answers
 * @param {(ms: number) => Promise<void>} sleep
 * @param {number} delayMs                 gap between the two probes
 * @returns {Promise<boolean>} true only if BOTH probes succeed
 */
async function confirmReuse(probe, sleep, delayMs) {
  if (!(await probe())) return false // nothing there → start our own server
  await sleep(delayMs)
  return probe() // still alive? reuse. gone? fall through to start our own.
}

/**
 * Distinguish a free port from a hardened viewer and a persistent unmarked
 * listener. The last case must fail closed: starting another server would race
 * an occupied port, while reusing it would retain the pre-hardening exposure.
 *
 * @param {() => Promise<boolean>} probeAny
 * @param {() => Promise<boolean>} probeCompatible
 * @param {(ms: number) => Promise<void>} sleep
 * @param {number} delayMs
 * @returns {Promise<'none'|'reuse'|'incompatible'>}
 */
async function classifyReuse(probeAny, probeCompatible, sleep, delayMs) {
  if (!(await probeAny())) return 'none'
  if (await confirmReuse(probeCompatible, sleep, delayMs)) return 'reuse'
  return (await probeAny()) ? 'incompatible' : 'none'
}

/**
 * Watch a reused upstream viewer and self-heal if it disappears (issue #23).
 * On `failuresToHeal` CONSECUTIVE failed probes it invokes `onDrop` once (which
 * starts our in-process/spawned server) and stops watching. A single failed
 * probe is treated as a transient blip and does not heal — the failure count
 * resets on any successful probe.
 *
 * @param {() => Promise<boolean>} probe
 * @param {() => void} onDrop            called once when the upstream is gone
 * @param {{ intervalMs?: number, failuresToHeal?: number,
 *           setIntervalFn?: (fn: () => void, ms: number) => unknown,
 *           clearIntervalFn?: (handle: unknown) => void }} [opts]
 * @returns {() => void} stop            cancels the watch
 */
function watchUpstream(probe, onDrop, opts) {
  const o = opts || {}
  const intervalMs = o.intervalMs ?? 3000
  const failuresToHeal = o.failuresToHeal ?? 2
  const setIntervalFn = o.setIntervalFn || setInterval
  const clearIntervalFn = o.clearIntervalFn || clearInterval

  let healed = false
  let failures = 0
  const timer = setIntervalFn(async () => {
    if (healed) return
    if (await probe()) {
      failures = 0
      return
    }
    failures += 1
    if (failures >= failuresToHeal) {
      healed = true
      clearIntervalFn(timer)
      onDrop()
    }
  }, intervalMs)

  return () => clearIntervalFn(timer)
}

module.exports = { classifyReuse, confirmReuse, watchUpstream }
