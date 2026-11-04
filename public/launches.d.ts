export interface LaunchMode { id: 'ask' | 'read-only' | 'plan' | 'edits'; label: string; copy: string }
export const LAUNCH_MODES: readonly LaunchMode[]
export const REASONING_EFFORTS: readonly string[]
export const SHELL_WARNING: string
export const PROMPT_WARNING: string
export interface NewSessionFields {
  root: string | null
  mode: string | undefined
  model: string
  reasoningEffort: string
  activeHours: string | number
  toolCalls: string | number
  prompt: string
}
export function newSessionRequest(fields: NewSessionFields): { request: Record<string, unknown> } | { error: string }
export type LaunchState = 'starting' | 'running' | 'stopping' | 'lost' | 'parked' | 'ended' | 'failed' | 'handed_off'
export function launchSessions(launch: { id: string }, activity: unknown[] | null | undefined): unknown[]
export function launchStatus(launch: Record<string, unknown>, activity: unknown[] | null | undefined, nowMs: number): { state: LaunchState; text: string; actions: string[] }
export function transcriptLines(events: unknown[] | null | undefined): Array<{ kind: 'text' | 'tool' | 'ask' | 'answer' | 'note'; text: string }>
