// Unsent drafts that survive a reload, a window close and an app restart (#279).
//
// Kept in this browser or app profile's localStorage under one versioned key and
// nowhere else: never the viewer server, the hub database or an agent. Pure: the
// caller does every storage read and write, so this module only decides what a
// stored entry may look like and how one window's changes merge into what the
// profile's other windows wrote.
//
// The rule for two windows on one profile: per entry key, the latest write wins;
// a window deletes only the copy it last loaded or wrote (compare-and-delete on
// `savedAt`), and never touches an entry it was not told about. Any write drops
// what this build cannot read, so a later build that adds a kind needs a new key.
// A stamp from the future (the clock was set back) is never yet expired, and
// any write brings it back to now, so it can be overwritten and does expire.

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

const optionalInt = (value, min) => (value === null || value === undefined ? null : isInt(value, min) ? value : undefined)
const optionalText = (value, max) => value === null || isText(value, max)

// What a question draft, and each reply intent, is pinned to: the question's
// answer (when it was last written, by whom, of what kind, and its text), never
// response_revision, which the human's own Note also moves. undefined means
// "invalid"; null means "not known".
function answerOf(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return undefined
  const text = value.text ?? null
  if (!optionalText(value.at, 64) || !optionalText(value.source, 32) || !optionalText(value.kind, 32)
    || !optionalText(text, MAX_TEXT)) return undefined
  return { at: value.at, source: value.source, kind: value.kind, text }
}

// undefined means "invalid"; null means "no intent". An intent without its pin
// is never replayed: its Retry sends afresh.
function intentOf(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return undefined
  const { clientId, sequence, actionId } = value
  const pin = answerOf(value.pin)
  if (!isId(clientId, 128) || !isId(actionId, 128) || !isInt(sequence, 1) || pin === undefined) return undefined
  return { clientId, sequence, actionId, pin }
}

// The one canonical shape of each kind: unknown fields are dropped and the key
// order is fixed, so equal drafts serialize to equal JSON. Null for anything
// this module cannot vouch for; it never throws.
export function draftEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const reason = raw.reason ?? ''
  switch (raw.type) {
    case 'reply': {
      const intent = intentOf(raw.intent)
      const answer = answerOf(raw.answer)
      if (intent === undefined || answer === undefined || !isId(raw.itemId) || !isText(raw.title, MAX_LABEL)
        || !isText(raw.text) || !isText(raw.context) || !filled(raw.text, raw.context)) return null
      return {
        type: 'reply', itemId: raw.itemId, title: raw.title, text: raw.text, context: raw.context, answer, intent,
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
        || typeof (raw.setAside ?? false) !== 'boolean' || typeof (raw.unconfirmed ?? false) !== 'boolean') return null
      // unconfirmed: its send was in flight, or lost its answer, when this was written
      return {
        type: 'row', rowId: raw.rowId, boardId: raw.boardId, boardRevision: raw.boardRevision,
        revision: raw.revision, actionVersion, text: raw.text, kind: raw.kind, boardTitle: raw.boardTitle,
        label: raw.label, context: raw.context, setAside: raw.setAside === true, unconfirmed: raw.unconfirmed === true,
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
    case 'message': {
      // #411: one per session. `intent` is the id a send claimed and the text it
      // sent, so a retry of that text replays exactly; a `reason` means it is in
      // the unsent responses, its session gone or unable to receive.
      const intent = raw.intent ?? null
      if (intent !== null && (typeof intent !== 'object' || !isId(intent.id, 64) || !isText(intent.text))) return null
      if (!isId(raw.session) || !isText(raw.project, MAX_LABEL) || !isText(raw.agent, MAX_LABEL)
        || !isText(raw.stream ?? '', MAX_LABEL) || !isText(raw.text) || !filled(raw.text) || !isText(reason, MAX_LABEL)) return null
      return {
        type: 'message', session: raw.session, project: raw.project, agent: raw.agent, stream: raw.stream ?? '',
        text: raw.text, intent: intent && { id: intent.id, text: intent.text }, reason,
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
    case 'message': return `message:${draft.session}`
    default: return null
  }
}

function keyFits(key, draft) {
  if (typeof key !== 'string' || key.length > MAX_KEY) return false
  if (draft.type === 'item-recovery') return key.startsWith('item-recovery:') && key.length > 'item-recovery:'.length
  return key === draftKey(draft)
}

// Whether an entry last written at `savedAt` is past the retention period.
export function draftExpired(savedAt, nowMs, retentionMs = RETENTION_MS) {
  return savedAt < nowMs - retentionMs
}

function limitsOf({ retentionMs = RETENTION_MS, maxEntries = MAX_ENTRIES, maxChars = MAX_CHARS } = {}) {
  return { retentionMs, maxEntries, maxChars }
}

const serialize = (drafts) => JSON.stringify({ v: VERSION, entries: Object.fromEntries(drafts) })

// The bounds, oldest first. An entry that can never fit goes first, so it
// cannot evict everything older.
function bounded(drafts, { maxEntries, maxChars }) {
  // `"key":value` plus its comma: never less than what the entry adds to the JSON
  const base = serialize(new Map()).length
  const sizes = new Map([...drafts].map(([key, value]) => [key, JSON.stringify(key).length + JSON.stringify(value).length + 2]))
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
  return drafts
}

// Every valid entry younger than the retention period, within both bounds, in
// stored order, each with the stamp it is stored under. Unreadable, unknown,
// mislabelled and expired entries are left out, never thrown.
export function readDrafts(raw, nowMs, limits) {
  const bounds = limitsOf(limits)
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
    if (draftExpired(value.savedAt, nowMs, bounds.retentionMs)) continue
    const draft = draftEntry(value.draft)
    if (!draft || !keyFits(key, draft)) continue
    drafts.set(key, { savedAt: value.savedAt, draft })
  }
  return bounded(drafts, bounds)
}

// What storage should hold after this window's changes: deletes apply only to
// the copy this window last saw, every remaining stamp from the future is
// brought back to `nowMs`, upserts are stamped `nowMs`, and the bounds evict the
// oldest entries.
export function mergeDrafts(raw, { upserts, deletes }, nowMs, limits) {
  const drafts = readDrafts(raw, nowMs, limits)
  for (const [key, savedAt] of deletes) {
    if (drafts.get(key)?.savedAt === savedAt) drafts.delete(key)
  }
  for (const value of drafts.values()) value.savedAt = Math.min(value.savedAt, nowMs)
  for (const [key, value] of upserts) {
    const draft = draftEntry(value)
    if (draft && keyFits(key, draft)) drafts.set(key, { savedAt: nowMs, draft })
  }
  return serialize(bounded(drafts, limitsOf(limits)))
}
