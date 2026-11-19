'use strict'
// The attention watch (issue #19; per source since #617 PR 4a): poll one Inbox, report the size of
// its attention set for the dock badge, and fire ONE native notification per poll for newly arrived
// entries only. Nothing notifies on a watch's first poll: what already needs you is on screen, and a
// watch made for a newly connected hub announces nothing old.
//
// Main runs one watch for This Mac's own viewer and one for the connected hub (another Mac's Inbox,
// read through remote-connect.cjs's hubFetch). Each watch owns everything it remembers: the asks it
// has announced, its conditional reader and its response watch. So one source can never make the
// other announce, forget or remind anything.
//
// WHAT counts as attention is not decided here and is not described here: that is
// public/attention.js's job, and this file must never restate its rule even in a comment. A
// restatement is a second predicate by another name: nothing executes it, so it rots in silence.
// Read the predicate. test/badge.test.ts enforces this against the whole file, prose included.
//
// Policy only, with every Electron object and every request injected, so
// test/attention-watch.test.ts runs it without Electron.
const { createConditionalReader } = require('./conditional-read.cjs')
const {
  attentionNotification,
  answerableByNotification,
  cannedResponseActions,
  createResponseWatch,
  formatResponseReminder,
  freshAttentionNotifications,
  knownNotificationIds,
  refreshNotificationTarget,
  responseForNotificationAction,
  submitNotificationResponse,
} = require('./reply-watch.cjs')

const APP_NAME = 'Agent Inbox'
// how long a hub may stay out of reach, in awake time with a network, before one notice says so
const LOST_HUB_AFTER_MS = 2 * 60_000

/**
 * A notification title for this source: This Mac's titles are unchanged, a hub's name the hub
 * after the app's name (`Agent Inbox · <label> — needs you`). The label is text only.
 */
function sourceTitle(label, title) {
  if (typeof label !== 'string' || !title.startsWith(APP_NAME)) return title
  return `${APP_NAME} · ${label}${title.slice(APP_NAME.length)}`
}

/** Whether a hub's watch may poll and count now: that hub is connected and online, and its view may be shown. */
function hubLive(connection, id, canShow) {
  return connection !== null && typeof connection === 'object' && connection.mode === 'hub'
    && typeof id === 'string' && connection.id === id && connection.state === 'online' && canShow === true
}

/**
 * A hub's fetch that does not lose an answer to a check in progress. While the connection checks
 * the hub again (after a wake, an unlock or the network coming back) its fetch refuses every
 * request with an error whose `code` is `not_hub_origin`. A request that changes something (any
 * method but GET and HEAD) that is refused that way waits for `recheck()` to settle (a rejection
 * counts as settled), for at most `options.capMs` (10 seconds) of `options.setTimeout`'s time, and
 * is sent exactly once more; whatever that gives is returned or thrown. Reads and every other error
 * are thrown as they came, and `recheck` is called at most once per call, and only for that refusal.
 */
function waitingHubFetch(hubFetch, recheck, options = {}) {
  const capMs = options.capMs ?? 10_000
  const setTimeoutFn = options.setTimeout ?? setTimeout
  const clearTimeoutFn = options.clearTimeout ?? clearTimeout
  return async (input, init) => {
    try {
      return await hubFetch(input, init)
    } catch (error) {
      const method = String(init?.method ?? 'GET').toUpperCase()
      if (error?.code !== 'not_hub_origin' || method === 'GET' || method === 'HEAD') throw error
    }
    let timer = null
    await new Promise((resolve) => {
      timer = setTimeoutFn(resolve, capMs)
      Promise.resolve().then(recheck).then(resolve, resolve)
    })
    try {
      if (timer !== null) clearTimeoutFn(timer)
    } catch {
      // already gone
    }
    return hubFetch(input, init)
  }
}

const asCount = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)

/**
 * The dock badge: This Mac's count plus each hub's last count, where a hub counts only while
 * hubLive() says so. A hub that is not online, cannot be shown, or was dropped counts 0.
 */
function badgeTotal({ local, hubs = [], connection = null, canShow = false }) {
  let total = asCount(local)
  for (const hub of hubs) {
    if (hub && hubLive(connection, hub.id, canShow)) total += asCount(hub.count)
  }
  return total
}

/**
 * One source's watch. Options: `base` (the source's origin with a trailing slash; paths are joined
 * to it with no slash), `fetchImpl` (every request of this source goes through it), `label` (null
 * for This Mac; for a hub, its stored label or a function that reads it), `show(hash | null)` (bring this source's view
 * forward and land on the hash), `mods` (the promise of the shared attention modules), the
 * `Notification` class and the `retainer`, `onCount(n)` (this source's visible count after each
 * successful poll), an optional `wake(due)` (This Mac only), `now` and `logger`.
 *
 * `poll()` runs one pass, never rejects and never overlaps itself (a call during a pass gets that
 * pass). `stop()` drops the source: a pass in flight then announces and counts nothing.
 */
function createAttentionWatch(options) {
  const { base, label = null, mods, Notification, retainer, show } = options
  // a hub's requests may only go through its own fetch: never fall back to the global one
  if (label !== null && typeof options.fetchImpl !== 'function') {
    throw new TypeError('a hub attention watch needs its own fetchImpl')
  }
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const onCount = typeof options.onCount === 'function' ? options.onCount : () => {}
  const now = options.now ?? Date.now
  const logger = options.logger ?? console
  const isHub = label !== null
  // the wake adapter is This Mac's only: a hub's own app runs one for the hub
  const wake = !isHub && typeof options.wake === 'function' ? options.wake : null
  // a hub's label may be a function, read at each notification: the stored label can change while
  // the same hub stays connected (its machine name is recorded after the first answer)
  const hubName = () => {
    let name = label
    try {
      if (typeof label === 'function') name = label()
    } catch {
      name = null
    }
    return typeof name === 'string' ? name : 'another Mac'
  }
  const title = (text) => (isHub ? sourceTitle(hubName(), text) : text)
  // ids seen on the previous successful poll; null until the first one
  let known = null
  let polling = null
  let stopped = false
  // Issue #287: the two projections are conditional. Each read sends the validator its last answer
  // carried, and an unchanged one comes back as a bodyless 304 the reader answers from what it
  // parsed then. Through this source's fetchImpl, so a hub's reads go only through hubFetch.
  const read = createConditionalReader(fetchImpl)
  const responseWatch = options.responseWatch ?? createResponseWatch()

  const supported = () => {
    try {
      return Notification.isSupported() === true
    } catch {
      return false
    }
  }
  const open = (hash) => () => {
    try {
      show(hash)
    } catch (err) {
      logger.error('[agent-inbox] could not show the notification’s Inbox', err)
    }
  }

  async function pass() {
    let shared
    try {
      shared = await mods
    } catch {
      return // main owns the (loud) reporting of a failed import
    }
    const { attentionEntries, laterEntries, focusHashFor, optionOrder } = shared
    try {
      // The lean projections (issues #156 and #287): the same shapes without the closed history
      // and the plan rows this watcher never reads, which would otherwise be built, sent and parsed
      // every few seconds. An older viewer ignores the parameter and sends the full payload, which
      // the shared module reads the same way, with or without a validator;
      // test/reply-watch.test.ts pins that every one of them yields one result.
      const g = await read(`${base}api/items?scope=attention`)
      const boards = await read(`${base}api/boards?scope=attention`)
      const activity = await (await fetchImpl(`${base}api/activity`)).json()
      // Projects the human closed (issue #32). FAIL OPEN, deliberately: an older standalone viewer
      // from a different checkout has no such route, and confirmReuse() will happily attach this
      // app to it. An unknown closed set must mean "suppress nothing" (a truthful over-count),
      // never a dark badge.
      const closed = await fetchImpl(`${base}api/projects/closed`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
      if (stopped) return
      const at = now()
      const items = g.needsYou.flatMap((gr) => gr.items)
      const { newTargets, reminders } = responseWatch.scan(g, boards, at)
      const dueByKey = new Map([...newTargets, ...reminders].map((target) => [target.key, target]))
      const due = [...dueByKey.values()]
      if (wake && due.length) {
        try {
          await wake(due)
        } catch (err) {
          logger.error(`[agent-inbox] wake adapter failed: ${err?.message}`)
        }
      }
      if (stopped) return
      if (reminders.length && supported()) {
        const reminder = formatResponseReminder(reminders)
        const note = new Notification({ ...reminder, title: title(reminder.title) })
        note.on('click', open(reminders.length === 1 ? focusHashFor(reminders[0].focusId) : null))
        retainer.show(note)
      }
      const liveSessions = new Set(activity.map((a) => a.session))
      // THE §7 attention set: the exact same call the viewer's badge, rail, tab count and triage
      // deck all read from (spec §7 / tenet 3). No inline re-derivation, and no local copy of the
      // rule: whatever the shared module includes or drops, the dock follows for free.
      // `attn` is the VISIBLE set (closed projects suppressed): it sizes this source's share of the
      // dock badge and fills the notification body. It is computed on every tick, 304s or not
      // (#287): what the shared module decides can change with the clock alone.
      const attn = attentionEntries(items, boards, at, liveSessions, closed)
      onCount(attn.length)
      const entries = attn.map(attentionNotification)
      // …but `known` is maintained from the UNSUPPRESSED set. If it tracked only what is visible,
      // closing a project would drop its items from `known` and reopening would re-announce every
      // one of them as new. `known` tracks what EXISTS; the badge and the notification body track
      // what is VISIBLE. It also keeps the asks the human pinned for later (#247), so bringing one
      // back announces nothing.
      const everything = attentionEntries(items, boards, at, liveSessions)
      const fresh = freshAttentionNotifications(known, entries)
      known = knownNotificationIds(everything, laterEntries(items, boards, at))
      // Per-item notifications stay (owner's call).
      if (fresh.length && supported()) {
        // a hub's line names no host and carries none of the hub's text
        if (isHub) logger.log(`[agent-inbox] notifying: ${fresh.length} new from the connected hub`)
        else logger.log(`[agent-inbox] notifying: ${fresh.length} new (${fresh[0].text})`)
        // #412 step 3: an app launch's approval gets no buttons; a click opens its card
        const actionable = fresh.length === 1 && answerableByNotification(fresh[0]) ? fresh[0] : null
        const canned = cannedResponseActions(actionable ? optionOrder(actionable.item.options) : [])
        const note = new Notification({
          title: title(fresh.length === 1 ? 'Agent Inbox — needs you' : `Agent Inbox — ${fresh.length} new need you`),
          body: fresh.slice(0, 3).map((f) => f.text).join('\n'),
          ...(canned.actions.length ? { actions: canned.actions } : {}),
        })
        const hash = fresh.length === 1 ? focusHashFor(fresh[0].itemId) : null
        note.on('action', async (details, legacyActionIndex) => {
          const answer = responseForNotificationAction(canned.responses, details, legacyActionIndex)
          if (!answer || !actionable) return
          try {
            await submitNotificationResponse(base, actionable.target, answer, fetchImpl)
          } catch (firstError) {
            let saved = false
            if (actionable.target.source === 'row') {
              try {
                // The default representation, read fresh and unconditionally (#287): a refused
                // answer is rare, and its retry is pinned to the row revision the notification showed.
                const latestBoards = await (await fetchImpl(`${base}api/boards`)).json()
                const refreshed = refreshNotificationTarget(latestBoards, actionable.target)
                if (refreshed) {
                  await submitNotificationResponse(base, refreshed, answer, fetchImpl)
                  saved = true
                }
              } catch { /* surface the original choice below */ }
            }
            if (saved) return
            logger.error(`[agent-inbox] could not save notification response: ${firstError?.message}`)
            if (supported()) {
              const failed = new Notification({
                title: title('Agent Inbox — Response not applied'),
                body: isHub
                  ? `“${answer}” was not saved on ${hubName()}. Open Agent Inbox to answer it there.`
                  : `“${answer}” was preserved here because the action changed. Open Agent Inbox to review it.`,
              })
              failed.on('click', open(hash))
              retainer.show(failed)
            }
          }
        })
        // Clicking only opens the app and, for a single item, lands on it.
        note.on('click', open(hash))
        retainer.show(note)
      }
    } catch { /* the source is briefly unreachable: quiet, retried next tick */ }
  }

  function poll() {
    if (polling) return polling
    polling = pass().catch(() => {}).finally(() => { polling = null })
    return polling
  }

  return Object.freeze({
    poll,
    stop() {
      stopped = true
    },
  })
}

/** The one notice for a hub that stays out of reach: its title and body, from the connection as it is when it fires. */
function lostHubText(connection) {
  const label = typeof connection?.label === 'string' ? connection.label : ''
  return {
    title: `Agent Inbox — can't reach ${label}`,
    body: connection?.state === 'refused' && connection?.reason === 'refused'
      ? `${label} no longer accepts this Mac. Pair it again in Settings → Use another Mac's Inbox.`
      : `New asks from ${label} will not show on this Mac until it is back. Agent Inbox keeps trying.`,
  }
}

/**
 * One notice when the connected hub is lost. Fed every connection change (`update`), `awake()` on
 * resume and unlock, and `isOnline()`: when the same hub has been continuously not online
 * (`retrying` or `refused`, never for the reason `stopped`) for 2 minutes of awake time while this
 * Mac has a network, it shows ONE notification, then stays silent until that hub has been online
 * again. `awake()` and a change of hub restart the 2 minutes; a timer that fires while this Mac has
 * no network starts over. A click brings that hub's view forward (`show(id)`), whose offline page
 * explains. There is no "it is back" notice.
 */
function createLostHubNotice(options) {
  const { Notification, retainer, show } = options
  const isOnline = options.isOnline ?? (() => true)
  const setTimeoutFn = options.setTimeout ?? setTimeout
  const clearTimeoutFn = options.clearTimeout ?? clearTimeout
  const delayMs = options.delayMs ?? LOST_HUB_AFTER_MS
  const logger = options.logger ?? console
  let latest = null
  let armed = true
  let timer = null

  function disarmTimer() {
    if (timer !== null) {
      try {
        clearTimeoutFn(timer)
      } catch {
        // already gone
      }
    }
    timer = null
  }

  function startTimer() {
    disarmTimer()
    timer = setTimeoutFn(fire, delayMs)
    timer?.unref?.()
  }

  function networkUp() {
    try {
      return isOnline() === true
    } catch {
      return false
    }
  }

  function fire() {
    timer = null
    if (!armed || latest === null || latest.state === 'online') return
    // time without a network does not count: start over
    if (!networkUp()) {
      startTimer()
      return
    }
    armed = false
    try {
      if (Notification.isSupported() !== true) return
      const { title, body } = lostHubText(latest)
      const note = new Notification({ title, body })
      const id = latest.id
      note.on('click', () => {
        try {
          show(id)
        } catch (err) {
          logger.error('[agent-inbox] could not show the hub', err)
        }
      })
      retainer.show(note)
    } catch (err) {
      logger.error('[agent-inbox] could not show the hub notice', err)
    }
  }

  function update(connection) {
    const hub = connection !== null && typeof connection === 'object' && connection.mode === 'hub' && typeof connection.id === 'string'
      ? connection : null
    if (hub === null) {
      latest = null
      armed = true
      disarmTimer()
      return
    }
    if (latest === null || latest.id !== hub.id) {
      armed = true
      disarmTimer()
    }
    latest = { id: hub.id, label: hub.label, state: hub.state, reason: hub.reason }
    if (hub.state === 'online') {
      armed = true
      disarmTimer()
    } else if (hub.reason === 'stopped' || (hub.state !== 'retrying' && hub.state !== 'refused')) {
      // the app is quitting or the state is unknown: nothing counts toward the notice
      disarmTimer()
    } else if (armed && timer === null) {
      startTimer()
    }
  }

  return Object.freeze({
    update,
    /** The Mac woke or was unlocked: the 2 minutes start over. */
    awake() {
      if (timer !== null) startTimer()
    },
    stop: disarmTimer,
  })
}

module.exports = {
  LOST_HUB_AFTER_MS,
  badgeTotal,
  createAttentionWatch,
  createLostHubNotice,
  hubLive,
  lostHubText,
  sourceTitle,
  waitingHubFetch,
}
