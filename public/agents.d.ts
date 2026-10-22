export interface HostLine { host: string; label: string; kind: string; outdated: boolean; drift: 'older' | 'newer' | null; text: string }
export interface AgentsStep { host: 'claude' | 'copilot' | 'hooks'; progress: string; done: string }
export interface AgentsAction { steps: AgentsStep[]; label: string; hint: string; elsewhere: string }
/** issue #197 part 2 — 'Claude Code' | 'Copilot CLI' | 'Claude hooks'. */
export function hostLabel(host: string): string
/** issue #197 part 2 — one host's Setup-panel line: which build it is registered to run, and which way a Setup runtime differs from this app's. */
export function hostLine(host: 'claude' | 'copilot' | 'hooks', reg: unknown, current: string | null): HostLine
/** issue #197 part 2 — the ONE action (Update agents / Match agents to vX) that moves every Setup-managed host whose runtime differs from this app's, as one fixed install target per host, Claude's hooks last (#206); or null. */
export function agentsAction(agents: unknown): AgentsAction | null
/** issue #278 — what the Setup panel adds about Claude's hooks on another Setup runtime than this app's, so that line always ends in a step the human can take; `command` is viewer-built shell text to show and copy. */
export function hooksNextStep(agents: unknown, canRun: boolean): { text: string; command: string | null } | null
/** issue #197 part 2 — per moved host, the running sessions whose build differs from what that host now runs, and how to restart them. */
export function restartGuidance(activity: unknown, moves: Array<{ host: 'claude' | 'copilot'; version: string }>): string[]
/** issue #206 — after the hooks step reported success: whether the re-read shows Claude's hooks on exactly `version`, and what to tell the human. */
export function hooksGuidance(agents: unknown, version: string): { moved: boolean; text: string }
