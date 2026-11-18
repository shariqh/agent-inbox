// Types for public/remote-words.js (#617, PR 2d).
export interface FamilyWords {
  why: string
  refused: string
  paused?: string
  command?: boolean
  repair?: boolean
}

export const FAMILY_WORDS: Readonly<Record<
  | 'serve_setup' | 'serve_other' | 'funnel' | 'serve_running' | 'no_tailscale' | 'tailscale_off' | 'tailscale_signin' | 'tailscale_name'
  | 'tailscale_unreadable' | 'tagged' | 'identity' | 'switch_again' | 'changed' | 'not_wanted' | 'other_build' | 'file_open' | 'file_newer'
  | 'file_fields' | 'file_damaged' | 'write_failed' | 'port_clash' | 'failed',
  FamilyWords
>>

/** A reason word's family; a word this build does not know is `failed`. */
export function reasonFamily(kind: string, reason: unknown, step?: unknown): keyof typeof FAMILY_WORDS

/** The one sentence a stop that will not come back by itself is announced with. */
export function stopNotice(reason: unknown): string

export function testWords(result: { ok: boolean; reason?: string; rose?: string | null } | null | undefined, host: string): string

export function codeWords(reason: unknown): string
