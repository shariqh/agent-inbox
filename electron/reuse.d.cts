// Type declarations for the dependency-free launcher logic in reuse.cjs.
// Runtime lives in reuse.cjs; this exists so the TS test and `tsc --noEmit`
// see the shapes (the .cjs is not part of the TS program).

/** Re-probe before committing to reuse: true only if the viewer answers twice. */
export function confirmReuse(
  probe: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  delayMs: number,
): Promise<boolean>

export function classifyReuse(
  probeAny: () => Promise<boolean>,
  probeCompatible: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  delayMs: number,
): Promise<'none' | 'reuse' | 'incompatible'>

export interface WatchUpstreamOpts {
  intervalMs?: number
  failuresToHeal?: number
  setIntervalFn?: (fn: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
}

/** Watch a reused viewer; heal once (call onDrop) when it disappears. Returns a stop(). */
export function watchUpstream(
  probe: () => Promise<boolean>,
  onDrop: () => void,
  opts?: WatchUpstreamOpts,
): () => void

/** AGENT_INBOX_PORT when set; else 4319 packaged, 4392 for a checkout build (#465). */
export function viewerPort(options: { isPackaged: boolean; env: Record<string, string | undefined> }): number
