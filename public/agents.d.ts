export interface HostLine { host: string; label: string; kind: string; outdated: boolean; drift: 'older' | 'newer' | null; text: string }
export interface AgentsAction { target: 'all' | 'claude' | 'copilot'; hosts: Array<'claude' | 'copilot'>; label: string; hint: string; elsewhere: string; progress: string; done: string }
/** issue #197 part 2 — 'Claude Code' | 'Copilot CLI' | 'Claude hooks'. */
export function hostLabel(host: string): string
/** issue #197 part 2 — one host's Setup-panel line: which build it is registered to run, and which way a Setup runtime differs from this app's. */
export function hostLine(host: 'claude' | 'copilot' | 'hooks', reg: unknown, current: string | null): HostLine
/** issue #197 part 2 — the one fixed install target that moves exactly these hosts. */
export function updateTarget(hosts: string[]): 'all' | 'claude' | 'copilot' | null
/** issue #197 part 2 — the ONE action (Update agents / Match agents to vX) that moves every Setup-managed host whose runtime differs from this app's, or null. */
export function agentsAction(agents: unknown): AgentsAction | null
/** issue #197 part 2 — per moved host, the running sessions that still run another build and how to restart them. */
export function restartGuidance(activity: unknown, hosts: Array<'claude' | 'copilot'>, current: string): string[]
