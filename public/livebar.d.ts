export interface LiveSessionSummary { session: string; project: string; agent: string; label: string; tone: string }
export interface LiveSummary { count: number; idleCount: number; tone: string; label: string; sessions: LiveSessionSummary[] }
export function liveSummary(activity: unknown[], nowMs: number): LiveSummary
/** issue #45 — the last REAL MCP call (never the liveness heartbeat), falling back to session start. */
export function lastActivityAt(a: unknown): string
export const DORMANT_MS: number
export function isDormant(a: unknown, nowMs: number): boolean
export function activitySynopsis(a: unknown): { text: string; historical: boolean }
/** issue #197 — a session's own build label, plus a hint when it is strictly older than `info.current` (advice follows its server_source, its host's registration in `info.hosts` and `info.updatable`), or newer than its host now runs once that host was matched back to this app. */
export function sessionBuild(a: unknown, info: unknown): { label: string; older: boolean; newer: boolean; hint: string } | null
/** issue #197 part 2 — the Setup host ('claude' | 'copilot') behind a session's inferred agent name, or null. */
export function hostOfAgent(agent: unknown): 'claude' | 'copilot' | null
/** issue #197 part 2 — semver precedence (-1, 0, 1), or null unless both are strict semver. */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null
