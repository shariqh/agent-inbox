export interface LiveSessionSummary { session: string; project: string; agent: string; label: string; tone: string }
export interface LiveSummary { count: number; idleCount: number; tone: string; label: string; sessions: LiveSessionSummary[] }
export function liveSummary(activity: unknown[], nowMs: number): LiveSummary
/** issue #45 — the last REAL MCP call (never the liveness heartbeat), falling back to session start. */
export function lastActivityAt(a: unknown): string
export const DORMANT_MS: number
export function isDormant(a: unknown, nowMs: number): boolean
export function activitySynopsis(a: unknown): { text: string; historical: boolean }
/** issue #197 — a session's own build label, plus a hint when it is strictly older than `info.current`; its advice follows the session's server_source and `info` (the /api/version body). */
export function sessionBuild(a: unknown, info: unknown): { label: string; older: boolean; hint: string } | null
