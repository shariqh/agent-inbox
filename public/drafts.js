// Unsent drafts that survive a reload, a window close and an app restart (#279).
//
// Kept in this browser or app profile's localStorage under one versioned key and
// nowhere else: never the viewer server, the hub database or an agent. Pure: the
// caller does every storage read and write, so this module only decides what a
// stored entry may look like and how one window's changes merge into what the
// profile's other windows wrote.
//
// The rule for two windows on one profile: per entry key, the last write wins;
// a window deletes only the copy it last loaded or wrote (compare-and-delete on
// `savedAt`), and never touches an entry it was not told about. Any write drops
// what this build cannot read, so a later build that adds a kind needs a new key.

export const DRAFTS_KEY = 'agent-inbox-drafts-v1'

const VERSION = 1
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 100
const MAX_CHARS = 200_000
const MAX_TEXT = 100_000
const MAX_LABEL = 2_000
const MAX_ID = 200
const MAX_KEY = 600
const KINDS = new Set(['answer', 'clarify', 'decline'])

const isText = (value, max = MAX_TEXT) => typeof value === 'string' && value.length <= max
const isId = (value, max = MAX_ID) => typeof value === 'string' && value.length > 0 && value.length <= max
const isInt = (value, min) => Number.isSafeInteger(value) && value >= min
const filled = (...values) => values.some((value) => value.trim() !== '')

// undefined means "invalid"; null means "no intent"
function intentOf(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return undefined
  const { clientId, sequence, actionId } = value
  if (!isId(clientId, 128) || !isId(actionId, 128) || !isInt(sequence, 1)) return undefined
  return { clientId, sequence, actionId }
}

const optionalInt = (value, min) => (value === null || value === undefined ? null : isInt(value, min) ? value : undefined)

// The one canonical shape of each kind: unknown fields are dropped and the key
// order is fixed, so equal drafts serialize to equal JSON. Null for anything
// this module cannot vouch for; it never throws.
export function draftEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const reason = raw.reason ?? ''
  switch (raw.type) {
    case 'reply': {
      const intent = intentOf(raw.intent)
      if (intent === undefined || !isId(raw.itemId) || !isText(raw.title, MAX_LABEL)
        || !isText(raw.text) || !isText(raw.context) || !filled(raw.text, raw.context)
        || !isInt(raw.responseRevision, 0)) return null
      return {
        type: 'reply', itemId: raw.itemId, title: raw.title, text: raw.text, context: raw.context,
        responseRevision: raw.responseRevision, intent,
      }
    }
    case 'item-recovery': {
      const intent = intentOf(raw.intent)
      if (intent === undefined || !isId(raw.itemId) || !isText(raw.title, MAX_LABEL)
        || !isText(raw.text) || !isText(raw.context) || !filled(raw.text, raw.context)
        || !KINDS.has(raw.kind) || !isText(reason, MAX_LABEL)) return null
      return {
        type: 'item-recovery', itemId: raw.itemId, title: raw.title, text: raw.text, context: raw.context,
        kind: raw.kind, intent, reason,
      }
    }
    case 'row': {
      const actionVersion = optionalInt(raw.actionVersion, 0)
      if (actionVersion === undefined || !isId(raw.rowId) || !isId(raw.boardId) || !isInt(raw.boardRevision, 0)
        || !isInt(raw.revision, 0) || !isText(raw.text) || !filled(raw.text) || !KINDS.has(raw.kind)
        || !isText(raw.boardTitle, MAX_LABEL) || !isText(raw.label, MAX_LABEL) || !isText(raw.context)
        || typeof (raw.setAside ?? false) !== 'boolean') return null
      return {
        type: 'row', rowId: raw.rowId, boardId: raw.boardId, boardRevision: raw.boardRevision,
        revision: raw.revision, actionVersion, text: raw.text, kind: raw.kind, boardTitle: raw.boardTitle,
        label: raw.label, context: raw.context, setAside: raw.setAside === true,
      }
    }
    case 'row-recovery': {
      const actionVersion = optionalInt(raw.actionVersion, 0)
      // -1 is the revision a recovery records when its row's revision was unknown
      if (actionVersion === undefined || !isId(raw.rowId) || !isInt(raw.revision, -1) || !isText(raw.text)
        || !filled(raw.text) || !KINDS.has(raw.kind) || !isText(raw.boardTitle, MAX_LABEL)
        || !isText(raw.label, MAX_LABEL) || !isText(raw.context) || typeof (raw.setAside ?? false) !== 'boolean'
        || !isText(reason, MAX_LABEL)) return null
      return {
        type: 'row-recovery', rowId: raw.rowId, revision: raw.revision, actionVersion, text: raw.text,
        kind: raw.kind, boardTitle: raw.boardTitle, label: raw.label, context: raw.context,
        setAside: raw.setAside === true, reason,
      }
    }
    case 'note': {
      // an empty text is a Note attempt that clears the stored note
      if (!isId(raw.itemId) || !isText(raw.title, MAX_LABEL) || !isText(raw.text) || !isText(raw.error, MAX_LABEL)
        || typeof raw.pending !== 'boolean') return null
      return { type: 'note', itemId: raw.itemId, title: raw.title, text: raw.text, error: raw.error, pending: raw.pending }
    }
    default:
      return null
  }
}

// One entry per question, row, row action and Note target. An item recovery is
// one of several possible per question, so the window that made it names it.
export function draftKey(draft) {
  switch (draft.type) {
    case 'reply': return `reply:${draft.itemId}`
    case 'row': return `row:${draft.rowId}`
    case 'row-recovery': return `row-recovery:${draft.rowId}:${draft.revision}`
    case 'note': return `note:${draft.itemId}`
    default: return null
  }
}

function keyFits(key, draft) {
  if (typeof key !== 'string' || key.length > MAX_KEY) return false
  if (draft.type === 'item-recovery') return key.startsWith('item-recovery:') && key.length > 'item-recovery:'.length
  return key === draftKey(draft)
}

function limitsOf({ retentionMs = RETENTION_MS, maxEntries = MAX_ENTRIES, maxChars = MAX_CHARS } = {}) {
  return { retentionMs, maxEntries, maxChars }
}

// Every valid entry younger than the retention period, in stored order.
// Unreadable, unknown, mislabelled and expired entries are left out, never thrown.
export function readDrafts(raw, nowMs, limits) {
  const { retentionMs } = limitsOf(limits)
  const drafts = new Map()
  let parsed = null
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : null
  } catch {
    return drafts
  }
  const entries = parsed && parsed.v === VERSION ? parsed.entries : null
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return drafts
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== 'object' || !isInt(value.savedAt, 0)) continue
    if (value.savedAt < nowMs - retentionMs) continue
    const draft = draftEntry(value.draft)
    if (!draft || !keyFits(key, draft)) continue
    drafts.set(key, { savedAt: value.savedAt, draft })
  }
  return drafts
}

const serialize = (drafts) => JSON.stringify({ v: VERSION, entries: Object.fromEntries(drafts) })

// What storage should hold after this window's changes: deletes apply only to
// the copy this window last saw, upserts are stamped `nowMs` unless a copy
// stamped later is already there, and the bounds evict the oldest entries.
export function mergeDrafts(raw, { upserts, deletes }, nowMs, limits) {
  const { maxEntries, maxChars } = limitsOf(limits)
  const drafts = readDrafts(raw, nowMs, limits)
  for (const [key, savedAt] of deletes) {
    if (drafts.get(key)?.savedAt === savedAt) drafts.delete(key)
  }
  for (const [key, value] of upserts) {
    const draft = draftEntry(value)
    if (!draft || !keyFits(key, draft)) continue
    if ((drafts.get(key)?.savedAt ?? -Infinity) > nowMs) continue
    drafts.set(key, { savedAt: nowMs, draft })
  }
  // `"key":value` plus its comma: never less than what the entry adds to the JSON
  const base = serialize(new Map()).length
  const sizes = new Map([...drafts].map(([key, value]) => [key, JSON.stringify(key).length + JSON.stringify(value).length + 2]))
  // An entry that can never fit goes first, so it cannot evict everything older.
  for (const [key, size] of sizes) {
    if (base + size > maxChars) {
      drafts.delete(key)
      sizes.delete(key)
    }
  }
  const oldestFirst = [...drafts].sort(([leftKey, left], [rightKey, right]) =>
    left.savedAt - right.savedAt || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
  let chars = base + [...sizes.values()].reduce((sum, size) => sum + size, 0)
  for (const [key] of oldestFirst) {
    if (drafts.size <= maxEntries && chars <= maxChars) break
    drafts.delete(key)
    chars -= sizes.get(key) ?? 0
  }
  return serialize(drafts)
}
