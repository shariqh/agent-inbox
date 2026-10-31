// The human's messages to one running agent session (#411, design
// docs/superpowers/specs/2026-10-30-session-messages-design.md §4–§5). Pure:
// no DOM, no clock, no fetch. app.js mounts the composer, the per-session
// history and the Live drawer's "Not delivered" fold from what these return.
//
// Presence, not attention: nothing here is read by public/attention.js, a
// badge, a count, the rail, the dock or a notification.

// What the store accepts (src/store.ts MESSAGE_MAX_TEXT): UTF-16 units, never trimmed.
export const MESSAGE_MAX_TEXT = 4000
// The first release whose MCP server receives messages.
const RECEIVING_VERSION = 'v2.2.0'
const HISTORY_SHOWN = 5
const UNDELIVERED_SHOWN = 10

export const MESSAGE_SHARED = 'Any agent of this session, a subagent included, may pick it up first.'
export const MESSAGE_UNCONFIRMED = 'Your send was not confirmed. Send again: it will not send twice.'

/**
 * What happens to a message sent now, from the session's /api/activity row
 * (design §4, "The delivery state"). Every flag is served only when true, so an
 * absent one is false; an absent `push_wake` means unknown, never "won't wake".
 * `driven` marks a session an Agent Inbox driver runs (#412): it gets each
 * message as a new turn, pushed by the driver.
 * @param {any} row the session's /api/activity row, or null when it is no longer listed
 * @returns {{state: 'now'|'next-check'|'cannot'|'gone', text: string, canSend: boolean}}
 */
export function deliveryState(row) {
  if (!row) return { state: 'gone', text: 'This session is no longer running.', canSend: false }
  if (row.receives_messages !== true) {
    return { state: 'cannot', text: `Can’t receive: restart this session to load ${RECEIVING_VERSION} or later.`, canSend: false }
  }
  if (row.driven === true) return { state: 'now', text: 'Arrives now: Agent Inbox runs this session.', canSend: true }
  if (row.push_wake === true) return { state: 'now', text: 'Arrives now: Agent Inbox pushes it into this session.', canSend: true }
  if (row.wakes === true) return { state: 'now', text: 'Arrives now: this session wakes for it.', canSend: true }
  return { state: 'next-check', text: 'It sees this when it next checks Agent Inbox.', canSend: true }
}

/** The composer's label, naming the session the way Live does. */
export function composerLabel({ agent, project, stream }) {
  return ['Message to ' + (agent || 'unknown'), project, stream].filter(Boolean).join(' · ')
}

/**
 * One message's status line. `ago(iso)` is the page's relative age ("2m",
 * "moments"). An acknowledged message carries its outcome separately: it is
 * agent text, which the caller renders as such.
 * @returns {{tone: string, text: string, outcome: string|null, withdrawable: boolean}}
 */
export function messageStatus(message, ago) {
  if (message.status === 'acknowledged') {
    return { tone: 'acknowledged', text: `Acknowledged ${ago(message.closed_at)} ago:`, outcome: message.outcome ?? '', withdrawable: false }
  }
  if (message.status === 'withdrawn') {
    return message.delivered_at
      ? { tone: 'withdrawn', text: 'Withdrawn after pickup: it may have started', outcome: null, withdrawable: false }
      : { tone: 'withdrawn', text: 'Withdrawn', outcome: null, withdrawable: false }
  }
  return message.delivered_at
    ? { tone: 'picked-up', text: `Picked up ${ago(message.delivered_at)} ago · working on it`, outcome: null, withdrawable: true }
    : { tone: 'sent', text: `Sent ${ago(message.created_at)} ago · not picked up yet`, outcome: null, withdrawable: true }
}

const newestFirst = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1)

const allMessages = (snapshot) => [...(snapshot?.open ?? []), ...(snapshot?.closed ?? [])]

/** One session's messages, newest first: the first five, and how many earlier. */
export function sessionMessages(snapshot, session) {
  const mine = allMessages(snapshot).filter((message) => message.session === session).sort(newestFirst)
  return { shown: mine.slice(0, HISTORY_SHOWN), earlier: mine.slice(HISTORY_SHOWN) }
}

/** Whether the snapshot holds this message id, open or closed. */
export function snapshotHolds(snapshot, id) {
  return allMessages(snapshot).some((message) => message.id === id)
}

/**
 * The "Not delivered" fold: every open message whose session /api/activity no
 * longer lists, newest first, ten shown. The clock never changes it.
 */
export function undeliveredMessages(snapshot, activity) {
  const listed = new Set((activity ?? []).map((row) => row?.session))
  const lost = (snapshot?.open ?? []).filter((message) => !listed.has(message.session)).sort(newestFirst)
  return {
    total: lost.length,
    shown: lost.slice(0, UNDELIVERED_SHOWN),
    more: lost.slice(UNDELIVERED_SHOWN),
  }
}

export function undeliveredReason(message) {
  return message.delivered_at
    ? 'Picked up, but the session ended before acknowledging'
    : 'Not delivered: this session is no longer running'
}

/** What a refused send or withdraw says, from the store's reason. */
export function refusalText(result, action = 'send') {
  switch (result?.reason) {
    case 'session_gone': return 'Not sent: this session is no longer running.'
    case 'session_cannot_receive': return `Not sent: this session can’t receive messages. Restart it to load ${RECEIVING_VERSION} or later.`
    case 'too_many_open': return 'Not sent: this session already has 20 open messages. Withdraw one, or wait for it to acknowledge them.'
    case 'too_much_open': return 'Not sent: this session’s open messages are too long in total. Withdraw one, or wait for it to acknowledge them.'
    case 'id_conflict': return 'Not sent. Send again to try once more.'
    case 'not_found': return 'This message is no longer there.'
    case 'revision_changed': return 'This message changed since this page showed it. Check its status and try again.'
    case 'not_open':
      return result.status === 'acknowledged' ? 'Not withdrawn: the session already acknowledged it.' : 'Already withdrawn.'
    default: return action === 'withdraw' ? 'Not withdrawn.' : 'Not sent.'
  }
}
