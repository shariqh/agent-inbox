export const PINS_DIR: '.pins'

export type ProcessIdentityOptions = {
  platform?: NodeJS.Platform
  procRoot?: string
  psBin?: string
}
export type ProcessIdentities = { ok: true; ids: Map<number, string> } | { ok: false; reason: string }

export function linuxProcessStart(statText: string): { state: string; starttime: string } | null
export function linuxIdentity(statText: string, bootId: string): string | null
export function processIdentities(pids: number[], options?: ProcessIdentityOptions): ProcessIdentities
export function processIdentity(pid: number, options?: ProcessIdentityOptions): string | null

export type RuntimePin = { runtimeId: string; launchId: string; pid: number; startedAt: string; path: string }
export function readRuntimePins(options: { runtimeRoot: string }):
  | { status: 'ok'; pins: RuntimePin[] }
  | { status: 'unknown'; reason: string }
export type RuntimePins =
  | { status: 'ok'; live: Map<string, Array<{ launchId: string; pid: number }>>; stale: RuntimePin[] }
  | { status: 'unknown'; reason: string }
type IdentityReader = (pids: number[]) => ProcessIdentities
export function runtimePins(options: { runtimeRoot: string; identities?: IdentityReader }): RuntimePins
export function pinLabel(pid: number): string
export function sweepStalePins(options: { runtimeRoot: string; limit?: number; identities?: IdentityReader }):
  { status: 'ok' | 'unknown'; removed: number; reason?: string }
export function pinHolds(options: { runtimeRoot: string; runtimeId: string; identities?: IdentityReader }): string | null
