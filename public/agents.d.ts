export interface HostLine { host: string; label: string; kind: string; outdated: boolean; text: string }
/** issue #197 part 2 — 'Claude Code' | 'Copilot CLI' | 'Claude hooks'. */
export function hostLabel(host: string): string
/** issue #197 part 2 — one host's Setup-panel line: which build it is registered to run, and whether that is an older Setup runtime. */
export function hostLine(host: 'claude' | 'copilot' | 'hooks', reg: unknown, current: string | null): HostLine
/** issue #197 part 2 — the hosts whose registration is a Setup runtime older than `agents.current`. */
export function outdatedHosts(agents: unknown): Array<'claude' | 'copilot'>
/** issue #197 part 2 — the one fixed install target that moves exactly these hosts. */
export function updateTarget(hosts: string[]): 'all' | 'claude' | 'copilot' | null
/** issue #197 part 2 — per updated host, the running sessions that still run an older build and how to restart them. */
export function restartGuidance(activity: unknown, hosts: Array<'claude' | 'copilot'>, current: string): string[]
