// Type declarations for electron/launch-controller.cjs (issue #412 step 3).
export type LaunchResult = { ok: boolean; error?: string; launch?: string; cancelled?: boolean; status?: string; killed?: boolean; reason?: string }
export interface LaunchController {
  canEnable(options?: { withKeys?: boolean }): LaunchResult | null
  available(): { enabled: boolean; available: boolean; error?: string }
  start(request: unknown): Promise<LaunchResult>
  resume(id: unknown): Promise<LaunchResult>
  stop(id: unknown): Promise<LaunchResult>
  close(id: unknown): Promise<LaunchResult>
  approve(request: unknown): Promise<LaunchResult>
  running(): Promise<Array<{ id: string; project: string; mode: string }>>
  stopAll(launches: Array<{ id: string }>): Promise<void>
  beginQuit(): void
  starting(): boolean
}
export const MODES: Readonly<Record<string, { label: string; copy: string }>>
export function createLaunchController(deps: Record<string, unknown>): LaunchController
export function launchRequest(value: unknown): Record<string, unknown> | null
export function approvalRequest(value: unknown): { item: string; revision: number; optionId: string } | null
export function launchEnv(env: Record<string, unknown>): Record<string, string>
export function displaySafe(text: string): string
export function confirmation(facts: {
  project: string
  folder: string
  mode: string
  model?: string
  reasoningEffort?: string
  budgets: { activeMs: number; toolCalls: number }
  prompt: string
}): { message: string; detail: string; buttons: string[] }
export function quitChoice(options: {
  running: Array<{ id: string; project: string; mode: string }>
  showMessageBox: (options: Record<string, unknown>) => Promise<{ response: number }>
}): Promise<'keep' | 'stop'>
