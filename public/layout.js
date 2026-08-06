// Pure responsive decisions (spec §14). Relative specifier so the same module
// resolves in the browser (both files are served from /) and in vitest.
import { projectMonogram } from './colors.js'

export const NARROW_MAX = 1279

export function layoutMode(width) {
  return Number(width) <= NARROW_MAX ? 'narrow' : 'wide'
}

// The narrow rail is a dot column: monogram only. The full name stays on
// title/aria-label so the label never disappears entirely (§2: colour is never
// the only carrier).
export function railLabel(name, mode) {
  return mode === 'narrow' ? projectMonogram(name) : String(name)
}
