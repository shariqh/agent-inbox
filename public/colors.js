// Deterministic per-project color (design §2). Zero-config: the hue is hashed
// from the project name, then PERSISTED on first sight so a project keeps its
// color for good; the human can pin a different palette hue. Lightness and
// chroma are fixed per theme so every project is legible in light and dark.
// Pure apart from the injected key-value store — no DOM, no global localStorage.

// The red/amber/orange band is reserved for STATE (blocked, urgency): a project
// must never look like an alarm. Palette hues live strictly outside it.
export const RESERVED_HUE = { start: 15, end: 95 }

export const PROJECT_HUES = [120, 145, 165, 185, 200, 220, 240, 260, 280, 300, 320, 340]

// one storage key holds the whole { project: hue } map
export const HUE_STORE_KEY = 'agent-inbox-hues'

// one fixed L/C pair per theme per role — color identifies, it never signals
const THEME = {
  light: { dot: { l: 0.62, c: 0.15 }, wash: { l: 0.96, c: 0.03 } },
  dark: { dot: { l: 0.72, c: 0.14 }, wash: { l: 0.28, c: 0.045 } },
}

// djb2-xor: stable across reloads and processes, unlike anything seeded
function hash(name) {
  const s = String(name ?? '')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h
}

// the store is either localStorage-shaped (getItem/setItem) or a plain object;
// corrupt or unreadable storage degrades to "no assignments yet", never throws
function readMap(store) {
  if (!store) return {}
  try {
    const raw = typeof store.getItem === 'function' ? store.getItem(HUE_STORE_KEY) : store[HUE_STORE_KEY]
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(store, map) {
  if (!store) return
  const json = JSON.stringify(map)
  try {
    if (typeof store.setItem === 'function') store.setItem(HUE_STORE_KEY, json)
    else store[HUE_STORE_KEY] = json
  } catch {
    /* storage full or blocked — the hash still gives a usable color */
  }
}

export function projectHue(name) {
  return PROJECT_HUES[hash(name) % PROJECT_HUES.length]
}

// first sight derives from the hash and writes it back, so a project's color
// survives a palette reshuffle or a name-collision rehash
export function assignedHue(name, store) {
  const key = String(name ?? '')
  const map = readMap(store)
  if (PROJECT_HUES.includes(map[key])) return map[key]
  const hue = projectHue(key)
  map[key] = hue
  writeMap(store, map)
  return hue
}

// the human pins a project to a palette hue; it is just an assignment written
// into the same map, so every later read (including projectColor) honours it
export function overrideHue(name, hue, store) {
  if (!PROJECT_HUES.includes(hue)) throw new Error(`hue ${hue} is not one of PROJECT_HUES`)
  const map = readMap(store)
  map[String(name ?? '')] = hue
  writeMap(store, map)
  return hue
}

export function projectColor(name, theme, store) {
  const t = theme === 'dark' ? THEME.dark : THEME.light
  const h = store ? assignedHue(name, store) : projectHue(name)
  return { dot: `oklch(${t.dot.l} ${t.dot.c} ${h})`, wash: `oklch(${t.wash.l} ${t.wash.c} ${h})` }
}

// Color is never the only carrier (§2): the All view puts this label beside the
// dot so a deuteranope reads the project without the hue.
export function projectMonogram(name) {
  const words = String(name ?? '').split(/[^a-zA-Z0-9]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}
