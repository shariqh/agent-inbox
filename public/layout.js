// Pure responsive decisions (spec §14).

export const NARROW_MAX = 1279

export function layoutMode(width) {
  return Number(width) <= NARROW_MAX ? 'narrow' : 'wide'
}

// The compact rail is horizontally scrollable, so it can keep readable names
// instead of forcing people to decode monograms. Slug separators become spaces;
// the untouched project name remains on title/aria-label.
export function railLabel(name, mode) {
  const label = String(name)
  if (mode !== 'narrow') return label
  return label.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || '?'
}
