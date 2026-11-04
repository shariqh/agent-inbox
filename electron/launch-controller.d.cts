// Type declarations for electron/launch-controller.cjs (issue #412 step 3).
export type WorktreeRoot = { path: string; isDefault: boolean }
export type LaunchResult = {
  ok: boolean; error?: string; launch?: string; cancelled?: boolean; status?: string; killed?: boolean; reason?: string; worktreeRoot?: WorktreeRoot
  folder?: string; project?: string; repository?: boolean; maxSessions?: number
}
export interface LaunchController {
  canEnable(options?: { withKeys?: boolean }): LaunchResult | null
  available(): { enabled: boolean; available: boolean; error?: string }
  start(request: unknown): Promise<LaunchResult>
  resume(id: unknown): Promise<LaunchResult>
  stop(id: unknown): Promise<LaunchResult>
  close(id: unknown): Promise<LaunchResult>
  approve(request: unknown): Promise<LaunchResult>
  /** #432: null with the switch off */
  chooseFolder(): Promise<LaunchResult>
  removeWorktree(id: unknown): Promise<LaunchResult>
  maxSessions(): Promise<number | null>
  setMaxSessions(value: unknown): Promise<LaunchResult>
  openWorktree(id: unknown): Promise<LaunchResult>
  /** step 5: Take over in Terminal (or open Terminal again on a launch already handed off) */
  takeOver(id: unknown): Promise<LaunchResult>
  worktreeRoot(): Promise<WorktreeRoot | null>
  chooseWorktreeRoot(): Promise<LaunchResult>
  resetWorktreeRoot(): Promise<LaunchResult>
  running(): Promise<Array<{ id: string; project: string; mode: string }>>
  stopAll(launches: Array<{ id: string }>): Promise<void>
  beginQuit(): void
  settled(): Promise<void>
}
export const MODES: Readonly<Record<string, { label: string; copy: string }>>
export function createLaunchController(deps: Record<string, unknown>): LaunchController
export function launchRequest(value: unknown): Record<string, unknown> | null
export function approvalRequest(value: unknown): { item: string; revision: number; optionId: string } | null
export function launchEnv(env: Record<string, unknown>): Record<string, string>
export function displaySafe(text: string): string
export function displayLine(text: string, options?: { tail?: boolean }): string
export function confirmation(facts: {
  project: string
  folder: string
  worktree?: { path: string; branch: string; shared: boolean } | null
  mode: string
  model?: string
  reasoningEffort?: string
  budgets: { activeMs: number; toolCalls: number }
  prompt: string
}): { message: string; detail: string; buttons: string[] }
export function runningAtQuit(controller: LaunchController, options?: { settleMs?: number; readMs?: number }): Promise<Array<{ id: string; project: string; mode: string }>>
export function quitChoice(options: {
  running: Array<{ id: string; project: string; mode: string }>
  showMessageBox: (options: Record<string, unknown>) => Promise<{ response: number }>
}): Promise<'keep' | 'stop'>
export function removalConfirmation(facts: {
  project: string; path: string; branch: string; missing: boolean; dirty: number; ahead: number; upstream: boolean
  examples?: string[]; noDiscard?: string | null; handedOff?: boolean
}): { message: string; detail: string; buttons: string[] }
export function takeOverConfirmation(facts: {
  project: string; folder: string; state: 'running' | 'parked' | 'stopped' | 'handed_off'
}): { message: string; detail: string; buttons: string[] }
export function takeOverScript(facts: {
  launchId: string; folder: string; session: string; model?: string | null; reasoningEffort?: string | null
}): string | null
