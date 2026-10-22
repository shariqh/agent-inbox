export interface KeyContext {
  typing?: boolean
  deckOpen?: boolean
  expanded?: boolean
  peeking?: boolean
  optionCount?: number
}

export type KeyIntent =
  | { type: 'move'; delta: number }
  | { type: 'expand' }
  | { type: 'collapse' }
  | { type: 'exitPeek' }
  | { type: 'clearSelection' }
  | { type: 'blur' }
  | { type: 'option'; index: number }
  | { type: 'dismiss' }
  | { type: 'resolve' }
  | { type: 'search' }
  | { type: 'deckPrev' }
  | { type: 'deckNext' }
  | { type: 'closeDeck' }
  | { type: 'openDeck' }

export const KEYS: { next: string[]; prev: string[] }
export interface KeyboardCommand {
  id: string
  key: string
  display: string
  label: string
  group: string
  prefix?: string
  selector?: string
  legacy?: boolean
}
export const KEYBOARD_COMMANDS: readonly KeyboardCommand[]
export function keyAction(key: string, ctx?: KeyContext): KeyIntent | null
export function rovingIndex(current: number, key: string, count: number): number
export function ariaAnswerLabel(
  option: { label?: string; detail?: string; recommended?: boolean } | null | undefined,
): string | null
export function livenessGlyph(liveness: string): { glyph: string; text: string }
export function deckEntryAt<T>(entries: readonly T[] | null | undefined, index: number): T | null
