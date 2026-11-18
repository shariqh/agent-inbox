// Type declarations for electron/remote-tailscale.cjs (#617, PR 2c): the read-only Tailscale half
// of the hub's remote-entry controller. Runtime lives in the .cjs; electron/remote-entry.cjs
// re-exports the public part.
import type { ExecFileLike, ServeAnswer, TailnetSelf } from './remote-entry.cjs'

export const REMOVAL_HINT: 'tailscale serve --https=443 off'
export const TAILSCALE_PATHS: readonly string[]
export const TAILSCALE_ARGS: { readonly self: readonly string[]; readonly serve: readonly string[]; readonly peers: readonly string[] }

export function tailscaleCli(exists?: (path: string) => boolean): string | null
export function parseTailnetSelf(text: string): TailnetSelf
export function parseServeStatus(text: string, host: string, port: number): ServeAnswer

/** One run of a fixed argument list by its key; the text, or `failed` / `no_cli`. */
export function runTailscale(
  which: 'self' | 'serve' | 'peers',
  deps: {
    execFile?: ExecFileLike | ((...args: never[]) => unknown)
    exists?: (path: string) => boolean
    setTimeout?: (fn: () => void, ms: number) => unknown
    clearTimeout?: (handle: unknown) => void
  },
): Promise<{ ok: true; text: string } | { ok: false; reason: 'no_cli' | 'failed' }>

export function isObject(value: unknown): value is Record<string, unknown>
export function plainText(value: unknown, max: number): value is string
export function validHost(host: unknown): host is string
