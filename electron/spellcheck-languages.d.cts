// Type declarations for spellcheck-languages.cjs (#292). Runtime lives in the
// .cjs; this exists so the TS test and `tsc --noEmit` see the shapes.

/**
 * Chromium's spellchecker codes for the system's languages, in their order:
 * exact match first, then the base language, one per base language, at most
 * three.
 */
export function spellcheckLanguagesFor(preferred: unknown, available: unknown): string[]

export interface SpellcheckApp {
  getPreferredSystemLanguages(): string[]
}

export interface SpellcheckSession {
  readonly availableSpellCheckerLanguages: string[]
  getSpellCheckerLanguages(): string[]
  setSpellCheckerLanguages(languages: string[]): void
}

/**
 * On Linux and Windows, set the session's spellchecker languages to the
 * system's when they differ, and never to none. Returns what it set, or null.
 */
export function syncSpellcheckLanguages(options: {
  platform: string
  app: SpellcheckApp
  session: SpellcheckSession
}): string[] | null
