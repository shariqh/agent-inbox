export interface LiveSessionSummary { session: string; label: string; tone: string }
export interface LiveSummary { count: number; tone: string; label: string; sessions: LiveSessionSummary[] }
export function liveSummary(activity: unknown[], nowMs: number): LiveSummary
/** issue #45 — the last REAL MCP call (never the liveness heartbeat), falling back to session start. */
export function lastActivityAt(a: unknown): string
export const DORMANT_MS: number
export function isDormant(a: unknown, nowMs: number): boolean
