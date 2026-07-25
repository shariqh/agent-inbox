// Notes: read-state + expiry (spec §8) and the calm state's ambient counts (§7).
// Pure — no DOM, no storage; the viewer passes `nowMs` and the last-seen stamp in.
import { NOTE_AGE_MS } from './attention.js'

// Notes older than NOTE_AGE_MS stop being notes and age into Done, so the tab
// count can come back down instead of growing forever.
export function partitionNotes(notes, nowMs) {
  const cutoff = nowMs - NOTE_AGE_MS
  const fresh = []
  const aged = []
  for (const n of notes) (Date.parse(n.created_at) >= cutoff ? fresh : aged).push(n)
  return { fresh, aged }
}

// "new since you last looked" — an aged-out note is never new.
export function unreadNotes(notes, lastSeenIso, nowMs) {
  const { fresh } = partitionNotes(notes, nowMs)
  return lastSeenIso ? fresh.filter((n) => n.created_at > lastSeenIso) : fresh
}

export function unreadNoteCount(notes, lastSeenIso, nowMs) {
  return unreadNotes(notes, lastSeenIso, nowMs).length
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`

// Ambient status for the "Nothing needs you" panel, as DISCRETE chips. None of
// these is attention (spec §7) — they are the things you may glance at and leave.
export function ambientChips(items, boards, nowMs, lastSeenIso) {
  const open = items.filter((i) => i.status === 'open')
  const awaiting = open.filter((i) => i.kind === 'question' && i.reply && !i.reply_seen_at).length
  const milestones = open.filter((i) => i.kind === 'done').length
  const unread = unreadNoteCount(open.filter((i) => i.kind === 'note'), lastSeenIso, nowMs)
  const complete = boards.filter((b) => b.progress.fraction === 1 && b.progress.countable > 0).length
  const chips = []
  if (awaiting) chips.push({ key: 'awaiting', label: `${awaiting} answered · awaiting agent` })
  if (unread) chips.push({ key: 'notes', label: `${unread} new note${unread > 1 ? 's' : ''}` })
  if (milestones) chips.push({ key: 'milestones', label: plural(milestones, 'milestone') })
  if (boards.length) chips.push({ key: 'boards', label: `${plural(boards.length, 'board')}${complete ? ` · ${complete} complete` : ''}` })
  return chips
}
