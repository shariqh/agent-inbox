// Types for public/remote-words.js (#617, PR 2d).
export interface FamilyWords {
  why: string
  /** the reason in the past tense, for a refused switch-on */
  was: string
  refused: string
  paused?: string
  /** true: this build's `tailscale serve --bg <port>`; a string: that command */
  command?: true | string
  repair?: true
}

/** A reason word's family; a word this build does not know is `failed`. */
export function reasonFamily(kind: string, reason: unknown, step?: unknown): string

/** A family's words with this build's port and the count of paired Macs filled in. */
export function familyWords(family: string, values?: { port?: number; count?: number; label?: string | null }): FamilyWords

export function testWords(result: { ok: boolean; reason?: string; rose?: string | null } | null | undefined, host: string, port: number): string

export function codeWords(reason: unknown): string
