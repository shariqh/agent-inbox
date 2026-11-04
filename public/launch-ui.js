// Issue #412 step 3 — the page's half of driven sessions (design §3.6, §4.3,
// §5.3, §7, §9). Everything here exists only in the viewer the Agent Inbox app
// started and owns, with "Start sessions from Agent Inbox" on: window.
// agentInboxLaunch (electron/setup-preload.cjs) says so. Off, or in a browser,
// no element is created, nothing is read and no listener is bound (§9 b).
//
// Main decides every launch. The page names a known repository folder (or
// none, for main's own folder dialog), a mode, a model, a reasoning effort,
// budgets and the task; never a path of its own, an executable, argv or env.
// Agent text reaches the DOM only as textContent. Nothing here reaches
// public/attention.js, a badge, a count, the rail or the dock.
import {
  LAUNCH_MODES, NOT_REPOSITORY, PROMPT_WARNING, REASONING_EFFORTS, SHELL_WARNING, START_PHASES, WORKTREE_COPY,
  launchOfSession, launchSessions, launchStatus, launchSummary, launchWorktreeLine, newSessionRequest, transcriptLines, worktreeSummaryText,
} from '/launches.js'

const DEFAULT_ACTIVE_HOURS = 2
const DEFAULT_TOOL_CALLS = 500
const RESUME_WAIT_MS = 60_000
const TRANSCRIPT_POLL_MS = 2000
const TRANSCRIPT_MAX_EVENTS = 5000
const ENDED_SHOWN = 5

/**
 * @param {{
 *   bridge?: () => any,
 *   documentRef?: Document,
 *   fetchJson: (url: string) => Promise<any>,
 *   postJSON: (url: string, body?: object) => Promise<any>,
 *   activity: () => any[],
 *   launches: () => any[] | null,
 *   rel: (iso: string) => string,
 *   sendTo: (session: string, text: string) => Promise<boolean>,
 *   composer: (session: string) => HTMLElement | null,
 *   hasDraft: (session: string) => boolean,
 *   changed: () => void,
 *   settled: () => Promise<unknown>,
 *   pending: <T>(action: () => Promise<T>) => Promise<T>,
 *   openPanel: (id: string, part: 'transcript' | 'resume') => void,
 * }} deps
 */
export function createLaunchUi(deps) {
  const bridge = deps.bridge ?? (() => globalThis.agentInboxLaunch)
  const doc = deps.documentRef ?? globalThis.document
  let state = null
  let version = 0
  // Typed text: the New session task and each parked launch's Resume and send
  // text, in window memory only. While its dialog is open, the task is a draft
  // in suspendState() (the dialog is modal, so the paused list is under it);
  // a Resume text sits in the ambient session panel, which no draft pauses, so
  // like a message composer's it only holds a viewer restart (held()). A task whose
  // dialog was cancelled is kept to fill the next one, and holds nothing.
  const drafts = new Map()
  const notes = new Map()
  const busy = new Set()
  const rows = new Map()
  const resumeInputs = new Map()
  // launches whose row shows the session's #411 composer, and the node holding it
  const openMessages = new Set()
  const slots = new Map()
  let dialog = null
  // #454: the session panel's transcript, read only while the panel shows it
  let transcript = null
  // step 5: whether the drawer lists the ended launches past the newest five (all /api/launches carries)
  let showEarlier = false
  // #432 PR 5 review: the one start in flight, owned by the dialog that started it; the launch id
  // once main reports it (with the 'copilot' phase, when the row exists), and whether the human asked to stop
  let starting = null
  let progressToken = null

  const bump = () => {
    version += 1
    deps.changed()
  }
  const on = () => state?.owned === true && state.enabled === true
  const granted = () => on() && state.available === true

  async function refresh() {
    const api = bridge()
    if (!api || typeof api.available !== 'function') return false
    const next = await api.available().catch(() => null)
    return setState(next)
  }

  function setState(next) {
    const value = next && typeof next === 'object'
      ? { owned: next.owned === true, enabled: next.enabled === true, available: next.available === true, canEnable: next.canEnable === true }
      : null
    if (JSON.stringify(value) === JSON.stringify(state)) return false
    state = value
    if (!on()) {
      closeDialog()
      stopTranscript()
    }
    bump()
    return true
  }

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const button = (text, action, extra = '') => {
    const el = make('button', `launch-action ${extra}`.trim(), text)
    el.type = 'button'
    el.dataset.launchAction = action
    return el
  }

  // ── the Live drawer's "Started from Agent Inbox" section ─────────────────
  function paintDrawer(nowMs) {
    const drawer = doc.getElementById('liveDrawer')
    let section = drawer?.querySelector('.live-launches') ?? null
    if (!drawer || !on()) {
      section?.remove()
      rows.clear()
      slots.clear()
      openMessages.clear()
      return
    }
    if (!section) {
      section = make('section', 'live-launches')
      section.setAttribute('aria-label', 'Sessions started from Agent Inbox')
      const head = make('div', 'live-launches-head')
      head.append(make('span', 'live-launches-title', 'Started from Agent Inbox'))
      const start = button('New session…', 'new', 'launch-new')
      head.append(start)
      const earlier = button('', 'earlier', 'launch-earlier')
      earlier.hidden = true
      section.append(head, make('p', 'live-launches-note'), make('div', 'live-launches-list'), earlier)
      section.addEventListener('click', onSectionClick)
      drawer.querySelector('.live-list')?.before(section) ?? drawer.append(section)
    }
    const newButton = section.querySelector('.launch-new')
    // one start at a time: New session waits for the one in flight
    const noNew = !granted() || starting !== null
    if (newButton.disabled !== noNew) newButton.disabled = noNew
    const note = section.querySelector('.live-launches-note')
    const noteText = granted() ? '' : 'Starting and approving sessions works only in Agent Inbox’s own window.'
    if (note.textContent !== noteText) note.textContent = noteText
    const list = section.querySelector('.live-launches-list')
    const all = deps.launches() ?? []
    const live = all.filter((launch) => launch.status !== 'ended')
    // the newest ended launches, and every one whose worktree is still on disk (#432), so Remove stays reachable
    const ended = all.filter((launch) => launch.status === 'ended')
    const recent = new Set(ended.slice(0, ENDED_SHOWN))
    const kept = (launch) => recent.has(launch) || (launch.worktree_path && !launch.worktree_removed_at)
    // step 5: the earlier ones on request, so their transcripts and Resume stay reachable
    const earlier = ended.filter((launch) => !kept(launch))
    const shown = [...live, ...ended.filter((launch) => kept(launch) || showEarlier)]
    const more = section.querySelector('.launch-earlier')
    if (more) {
      const moreText = showEarlier ? 'Fewer sessions' : `Earlier sessions (${earlier.length})`
      if (more.textContent !== moreText) more.textContent = moreText
      if (more.hidden !== (earlier.length === 0)) more.hidden = earlier.length === 0
      if (more.getAttribute('aria-expanded') !== String(showEarlier)) more.setAttribute('aria-expanded', String(showEarlier))
    }
    const keep = new Set(shown.map((launch) => launch.id))
    for (const [id, el] of rows) {
      if (!keep.has(id)) {
        el.remove()
        rows.delete(id)
        slots.delete(id)
        openMessages.delete(id)
      }
    }
    if (!shown.length && !list.querySelector('.empty')) list.replaceChildren(make('p', 'empty', 'No sessions started here yet.'))
    if (shown.length) list.querySelector(':scope > .empty')?.remove()
    let previous = null
    for (const launch of shown) {
      let el = rows.get(launch.id)
      if (!el) {
        el = make('article', 'live-launch')
        el.dataset.launch = launch.id
        rows.set(launch.id, el)
      }
      paintRow(el, launch, nowMs)
      // order follows the snapshot; a node already in place is never moved
      const after = previous ? previous.nextSibling : list.firstChild
      if (after !== el) list.insertBefore(el, after)
      previous = el
    }
  }

  function paintRow(el, launch, nowMs) {
    const status = launchStatus(launch, deps.activity(), nowMs)
    // a note about the state it was in goes once that state changes
    if (el.dataset.state && el.dataset.state !== status.state) notes.delete(launch.id)
    const session = granted() && status.state === 'running' ? messageSession(launch) : null
    if (!session) openMessages.delete(launch.id)
    const open = session !== null && openMessages.has(launch.id)
    const composer = open ? deps.composer(session) : null
    const key = JSON.stringify([
      launch.revision, launch.status, status.state, status.text, granted(), busy.has(launch.id), notes.get(launch.id) ?? '', launch.resumable,
      session, open, session !== null && !open && deps.hasDraft(session),
    ])
    // the composer keeps its own node, so it is only kept in step, never rebuilt
    if (composer && el.dataset.key === key && slots.get(launch.id)?.contains(composer)) return
    if (el.dataset.key === key && !open) return
    // a focused control keeps its node: rewritten only when the human is elsewhere
    const focused = doc.activeElement
    let slot = slots.get(launch.id) ?? null
    const holdsFocus = focused instanceof doc.defaultView.Element && el.contains(focused) && !slot?.contains(focused)
    el.dataset.key = key
    el.dataset.state = status.state
    const parts = []
    const title = make('div', 'live-launch-title')
    title.append(make('strong', '', launch.project), make('span', 'live-launch-summary', ` · ${launchSummary(launch)}`))
    parts.push(title)
    const worktree = launchWorktreeLine(launch)
    if (worktree) parts.push(make('p', 'live-launch-worktree', worktree))
    parts.push(make('p', 'live-launch-status', status.text))
    const actions = make('div', 'live-launch-actions')
    for (const action of status.actions) {
      if (action === 'transcript') actions.append(button('Transcript', 'transcript'))
      else if (granted() && action === 'stop') actions.append(button(launch.status === 'parked' ? 'End' : 'Stop', 'stop'))
      else if (granted() && action === 'close') actions.append(button('Close', 'close'))
      else if (granted() && action === 'park') actions.append(button('Park now', 'park'))
      // step 5: the session leaves for Terminal (`copilot --resume`); once there, Terminal can be opened on it again
      else if (granted() && (action === 'takeover' || action === 'terminal')) {
        actions.append(button(busy.has(launch.id) ? 'Handing off…' : action === 'takeover' ? 'Take over in Terminal' : 'Resume in Terminal', 'take-over'))
      }
    }
    // #432: the session's own worktree, while it is on disk; Remove only once the launch ended
    if (granted() && launch.worktree_path && !launch.worktree_removed_at) {
      actions.append(button('Open in Terminal', 'open-worktree'))
      if (launch.status === 'ended') actions.append(button('Remove worktree…', 'remove-worktree'))
    }
    if (session) {
      const draft = !open && deps.hasDraft(session)
      const message = button(draft ? 'Message · draft' : 'Message', 'message')
      message.setAttribute('aria-expanded', String(open))
      message.title = draft ? 'Message this session: your unsent draft is kept' : 'Message this session'
      actions.prepend(message)
    }
    parts.push(actions)
    // #454: Resume and send lives in the session panel; the row opens it there
    if (status.actions.includes('resume') && granted()) actions.append(button('Resume…', 'resume-panel', 'primary'))
    const note = notes.get(launch.id)
    if (note) {
      const line = make('p', 'live-launch-note', note)
      line.setAttribute('role', 'status')
      parts.push(line)
    }
    if (composer) {
      if (!slot) {
        slot = make('div', 'live-launch-composer')
        slots.set(launch.id, slot)
      }
      if (!slot.contains(composer)) slot.replaceChildren(composer)
      parts.push(slot)
    } else {
      slots.delete(launch.id)
      slot = null
    }
    if (holdsFocus) {
      const action = focused.dataset?.launchAction
      el.replaceChildren(...parts)
      // the same control, or (when this state has none) the row's first one
      const again = (action ? el.querySelector(`[data-launch-action="${action}"]`) : null)
        ?? el.querySelector('[data-launch-action]')
      if (again && doc.activeElement !== again && doc.hasFocus()) again.focus({ preventScroll: true })
    } else {
      // the composer's node, with focus and caret in it, stays where it is
      for (const child of [...el.children]) if (child !== slot) child.remove()
      el.prepend(...parts.filter((part) => part !== slot))
      if (slot && !slot.isConnected) el.append(slot)
    }
  }

  // The session a launch's Message goes to: its newest live one in Live.
  function messageSession(launch) {
    const live = launchSessions(launch, deps.activity())
    let newest = null
    for (const row of live) {
      if (!newest || String(row.started_at ?? '') >= String(newest.started_at ?? '')) newest = row
    }
    return newest?.session ?? null
  }

  function toggleMessage(id) {
    if (openMessages.has(id)) openMessages.delete(id)
    else openMessages.add(id)
    bump()
    if (openMessages.has(id)) slots.get(id)?.querySelector('textarea')?.focus()
  }

  // Cancel or Esc in a launch row's composer: the row's Message button gets focus back.
  function closeMessage(session) {
    const launch = (deps.launches() ?? []).find((l) => rows.has(l.id) && openMessages.has(l.id) && messageSession(l) === session)
    if (!launch) return
    const owned = Boolean(slots.get(launch.id)?.contains(doc.activeElement))
    openMessages.delete(launch.id)
    if (owned) doc.activeElement.blur()
    bump()
    if (owned) rows.get(launch.id)?.querySelector('[data-launch-action="message"]')?.focus({ preventScroll: true })
  }

  function setDraft(key, text) {
    if (text.trim()) drafts.set(key, text)
    else drafts.delete(key)
    deps.changed()
  }

  function onSectionClick(event) {
    const control = event.target instanceof doc.defaultView.Element ? event.target.closest('[data-launch-action]') : null
    if (!control || control.disabled) return
    const id = control.closest('[data-launch]')?.dataset.launch
    const action = control.dataset.launchAction
    if (action === 'new') openNewSession()
    else if (action === 'earlier') {
      showEarlier = !showEarlier
      bump()
    }
    else if (action === 'transcript' && id) deps.openPanel(id, 'transcript')
    else if (action === 'resume-panel' && id) deps.openPanel(id, 'resume')
    else if (action === 'stop' && id) stop(id)
    else if (action === 'close' && id) close(id)
    else if (action === 'park' && id) park(id)
    else if (action === 'message' && id) toggleMessage(id)
    else if (action === 'resume' && id) resumeAndSend(id)
    else if (action === 'take-over' && id) takeOver(id)
    else if (action === 'open-worktree' && id) openWorktree(id)
    else if (action === 'remove-worktree' && id) removeWorktree(id)
  }

  async function act(id, run) {
    if (busy.has(id)) return null
    busy.add(id)
    notes.delete(id)
    bump()
    try {
      return await deps.pending(run)
    } finally {
      busy.delete(id)
      bump()
    }
  }

  async function stop(id) {
    const result = await act(id, () => bridge().stop(id))
    if (result && !result.ok) notes.set(id, result.error ?? 'Not stopped.')
    await deps.settled()
  }

  // Park now (§7): the driver parks at its next idle point, as the idle
  // timeout would, and the launch can be resumed with Resume and send.
  async function park(id) {
    const result = await act(id, () => deps.postJSON(`/api/launches/${encodeURIComponent(id)}/park`))
    if (result) notes.set(id, result.ok ? 'Parking: Copilot stops once its turn ends, and the session is kept to resume.' : 'Not parked: it is not running.')
    await deps.settled()
  }

  // Take over in Terminal (step 5, §3.5): main confirms, hands the launch off (a running one's driver
  // cancels its turn and closes Copilot first) and opens Terminal on `copilot --resume` in its folder
  async function takeOver(id) {
    const result = await act(id, () => bridge().takeOver(id))
    if (result && !result.ok && !result.cancelled) notes.set(id, result.error ?? 'The session was not handed off.')
    await deps.settled()
  }

  // #432: main reads the path from the hub, checks it and opens Terminal there
  async function openWorktree(id) {
    const result = await act(id, () => bridge().openWorktree(id))
    if (result && !result.ok) notes.set(id, result.error ?? 'Terminal could not be opened.')
  }

  // #432: main inspects the worktree, asks in its own dialog (Discard is a separate
  // choice there), then removes it; the branch always stays
  async function removeWorktree(id) {
    const result = await act(id, () => bridge().removeWorktree(id))
    if (result && !result.ok && !result.cancelled) notes.set(id, result.error ?? 'The worktree was not removed.')
    await deps.settled()
  }

  async function close(id) {
    const result = await act(id, () => bridge().close(id))
    if (result && !result.ok) notes.set(id, result.error ?? 'Not closed.')
    await deps.settled()
  }

  // Resume and send (§5.3, §7): main starts the driver again on the parked
  // launch; once its new session shows up in Live, the message goes to it.
  // The text stays until it is sent.
  async function resumeAndSend(id) {
    const text = drafts.get(`resume:${id}`)
    if (!text?.trim()) return
    const result = await act(id, async () => {
      const started = await bridge().resume(id)
      if (!started?.ok) return started
      const session = await waitForSession(id)
      if (!session) return { ok: false, error: 'The session didn’t come back. Try again, or start a new one.' }
      const sent = await deps.sendTo(session, text)
      return sent ? { ok: true } : { ok: false, error: 'The session resumed, but your message was not confirmed. It is kept in its composer.' }
    })
    if (result?.ok) {
      drafts.delete(`resume:${id}`)
      resumeInputs.delete(id)
    } else if (result) {
      notes.set(id, result.error ?? 'Not resumed.')
    }
    await deps.settled()
  }

  async function waitForSession(id) {
    const until = Date.now() + RESUME_WAIT_MS
    while (Date.now() < until) {
      const activity = await deps.fetchJson('/api/activity').catch(() => null)
      const row = Array.isArray(activity) ? activity.find((a) => a?.driven === true && a.driven_launch === id && a.receives_messages === true) : null
      if (row) return row.session
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return null
  }

  // ── Approve and Decline on an @sessions ask (§4.3) ───────────────────────
  // Main signs the choice under the launch's key; the page names the item, the
  // revision it shows and the option. Returns a message for the card, or null.
  async function approve(item, label) {
    if (!granted()) return 'Not sent — approve this from Agent Inbox’s own window.'
    const ask = await deps.fetchJson(`/api/launch-asks/${encodeURIComponent(item.id)}`).catch(() => null)
    const option = Array.isArray(ask?.options) ? ask.options.find((o) => o?.label === label) : null
    if (!option) return ask ? 'Choose one of this approval’s options.' : 'This approval is no longer open.'
    const result = await bridge().approve({ item: item.id, revision: item.response_revision ?? 0, optionId: option.optionId })
    return result?.ok ? null : result?.error ?? 'Not sent.'
  }

  // ── New session dialog ───────────────────────────────────────────────────
  async function openNewSession() {
    if (!granted() || dialog?.open || starting) return
    dialog?.remove()
    dialog = make('dialog', 'launch-dialog')
    dialog.setAttribute('aria-labelledby', 'launchDialogTitle')
    const form = make('form', 'launch-form')
    form.method = 'dialog'
    const heading = make('h2', '', 'New session')
    heading.id = 'launchDialogTitle'
    const field = (labelText, control, hint) => {
      const wrap = make('label', 'launch-field')
      wrap.append(make('span', 'launch-field-label', labelText), control)
      if (hint) wrap.append(make('span', 'launch-field-hint', hint))
      return wrap
    }
    const project = make('select')
    project.name = 'root'
    project.append(new Option('Loading projects…', ''))
    // #432: on by default; main checks the folder is a repository and shows where the worktree goes
    const worktree = make('input')
    worktree.type = 'checkbox'
    worktree.name = 'worktree'
    worktree.checked = true
    const worktreeField = make('label', 'launch-mode launch-worktree')
    const worktreeCopy = make('span', 'launch-mode-copy', WORKTREE_COPY)
    worktreeField.append(worktree, make('strong', '', 'New worktree'), worktreeCopy)
    // the human's own choice, restored when they pick a repository again
    let wantWorktree = true
    worktree.addEventListener('change', () => { wantWorktree = worktree.checked })
    // a folder main's dialog chose that is not a repository runs in place: unticked and disabled
    const showFolder = () => {
      const notRepository = project.selectedOptions[0]?.dataset.repository === 'false'
      worktree.disabled = notRepository
      worktree.checked = !notRepository && wantWorktree
      worktreeCopy.textContent = notRepository ? NOT_REPOSITORY : WORKTREE_COPY
    }
    // Choose folder…: main's own dialog, before Start; it names the folder and whether it is a repository
    const chooseFolder = async () => {
      const api = bridge()
      if (typeof api?.chooseFolder !== 'function') return null
      const result = await api.chooseFolder().catch(() => null)
      if (dialog !== own) return null
      if (!result?.ok || typeof result.folder !== 'string') {
        message.textContent = result?.cancelled ? '' : result?.error ?? 'No folder was chosen.'
        return null
      }
      let option = [...project.options].find((o) => o.value === result.folder)
      if (!option) {
        option = new Option(`${result.project ?? result.folder} — ${result.folder}`, result.folder)
        project.insertBefore(option, project.querySelector('option[value=""]'))
      }
      option.dataset.repository = String(result.repository === true)
      project.value = result.folder
      showFolder()
      return result
    }
    let previous = ''
    project.addEventListener('change', async () => {
      if (project.value === '' && !(await chooseFolder())) project.value = previous
      showFolder()
      previous = project.value
    })
    const host = make('span', 'launch-host', 'Copilot')
    const modes = make('fieldset', 'launch-modes')
    modes.append(make('legend', '', 'Mode'))
    for (const mode of LAUNCH_MODES) {
      const wrap = make('label', 'launch-mode')
      const radio = make('input')
      radio.type = 'radio'
      radio.name = 'mode'
      radio.value = mode.id
      radio.checked = mode.id === 'ask'
      wrap.append(radio, make('strong', '', mode.label), make('span', 'launch-mode-copy', mode.copy))
      modes.append(wrap)
    }
    const model = make('input')
    model.name = 'model'
    model.placeholder = 'Copilot’s default'
    model.autocomplete = 'off'
    const effort = make('select')
    effort.name = 'effort'
    effort.append(new Option('Copilot’s setting', ''))
    for (const value of REASONING_EFFORTS) effort.append(new Option(value, value))
    const hours = make('input')
    hours.name = 'hours'
    hours.type = 'number'
    hours.min = '0.0167'
    hours.max = '8'
    hours.step = 'any'
    hours.value = String(DEFAULT_ACTIVE_HOURS)
    const calls = make('input')
    calls.name = 'calls'
    calls.type = 'number'
    calls.min = '1'
    calls.max = '2000'
    calls.value = String(DEFAULT_TOOL_CALLS)
    const prompt = make('textarea', 'launch-prompt')
    prompt.name = 'prompt'
    prompt.rows = 6
    prompt.value = drafts.get('new') ?? ''
    prompt.addEventListener('input', () => setDraft('new', prompt.value))
    const message = make('p', 'launch-dialog-message')
    message.setAttribute('role', 'status')
    const actions = make('div', 'launch-dialog-actions')
    const start = make('button', 'primary', 'Start…')
    start.type = 'submit'
    const cancel = make('button', '', 'Cancel')
    cancel.type = 'button'
    // while its start is in flight, Cancel is "Stop starting": the dialog stays until main answers
    cancel.addEventListener('click', () => {
      if (starting?.own === own) stopStarting()
      else closeDialog()
    })
    const stopStarting = () => {
      if (!starting || starting.stopAsked) return
      starting.stopAsked = true
      cancel.disabled = true
      message.textContent = 'Stopping the start…'
      if (starting.launch) bridge().stop(starting.launch).catch(() => null)
    }
    actions.append(cancel, start)
    form.append(
      heading,
      field('Project', project, 'A project Agent Inbox has seen, or a folder you choose.'),
      worktreeField,
      field('Agent', host),
      modes,
      make('p', 'launch-warning', SHELL_WARNING),
      field('Model', model),
      field('Reasoning effort', effort),
      field('Active time (hours)', hours, 'Between 1 minute and 8 hours of the session working.'),
      field('Tool calls', calls, 'Between 1 and 2000.'),
      field('Task', prompt, PROMPT_WARNING),
      message,
      actions,
    )
    dialog.append(form)
    const own = dialog
    // Escape does nothing while its start is in flight
    own.addEventListener('cancel', (event) => { if (starting?.own === own) event.preventDefault() })
    own.addEventListener('close', () => {
      own.remove()
      if (dialog === own) dialog = null
      bump()
    })
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const checked = form.querySelector('input[name="mode"]:checked')
      const values = () => newSessionRequest({
        root: project.value === '' ? null : project.value,
        worktree: worktree.checked,
        mode: checked?.value,
        model: model.value,
        reasoningEffort: effort.value,
        activeHours: hours.value,
        toolCalls: calls.value,
        prompt: prompt.value,
      })
      let made = values()
      if (made.error) {
        message.textContent = made.error
        return
      }
      // no folder chosen yet: main's dialog first; one that unticks New worktree waits for a second Start
      if (made.request.root === null && typeof bridge()?.chooseFolder === 'function') {
        const wanted = worktree.checked
        const chosen = await chooseFolder()
        if (!chosen) return
        previous = project.value
        if (wanted && !worktree.checked) return
        made = values()
        if (made.error) {
          message.textContent = made.error
          return
        }
      }
      if (starting) return
      start.disabled = true
      message.textContent = 'Agent Inbox is asking you to confirm…'
      // this start's tag: main echoes it with each phase, so phases of a start an earlier load of
      // this page made (a reload mid-start) never bind this dialog
      const startId = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
      const mine = { own, launch: null, stopAsked: false }
      starting = mine
      cancel.textContent = 'Stop starting'
      bump()
      // #432 PR 5: the dialog stays open, saying what the start is doing, until Copilot is set up or refused
      const api = bridge()
      const token = {}
      if (typeof api?.onStartProgress === 'function') {
        progressToken = token
        api.onStartProgress((phase, launch, tag) => {
          if (starting !== mine || tag !== startId) return
          if (phase === 'copilot' && typeof launch === 'string') {
            mine.launch = launch
            // a Stop asked for before the launch had a row goes now
            if (mine.stopAsked) api.stop(launch).catch(() => null)
          }
          if (dialog === own && !mine.stopAsked && START_PHASES[phase]) message.textContent = START_PHASES[phase]
        })
      }
      const result = await deps.pending(() => api.start({ ...made.request, startId })).catch(() => null)
      // only this start's listener, and only this start's dialog
      if (progressToken === token) {
        api.onStartProgress(null)
        progressToken = null
      }
      starting = null
      cancel.textContent = 'Cancel'
      cancel.disabled = false
      start.disabled = false
      bump()
      if (dialog !== own) return
      if (result?.ok) {
        drafts.delete('new')
        closeDialog()
        await deps.settled()
        return
      }
      message.textContent = result?.error ?? 'Not started.'
    })
    doc.body.append(dialog)
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    bump()
    prompt.focus()
    const folders = await deps.fetchJson('/api/launch-folders').catch(() => null)
    if (!dialog) return
    project.replaceChildren()
    for (const folder of Array.isArray(folders) ? folders : []) {
      if (folder && typeof folder.root === 'string') project.append(new Option(`${folder.project ?? folder.root} — ${folder.root}`, folder.root))
    }
    project.append(new Option('Choose folder…', ''))
    previous = project.value
  }

  function closeDialog() {
    if (!dialog) return
    if (typeof dialog.close === 'function' && dialog.open) dialog.close()
    dialog?.remove()
    dialog = null
  }

  // ── the session panel (#454, design §3.3) ──────────────────────────────
  // The launch's parts of the Dashboard's session panel: its action bar, worktree
  // box, transcript and Resume and send. app.js owns the panel and calls this from
  // its painter (both render entries); each part is rebuilt only when what it
  // shows changes, and a focused control keeps its node. Agent text is
  // textContent only. Off (§9), nothing here is drawn and the parts stay hidden.
  const TRANSCRIPT_LABELS = { text: 'Agent', tool: 'Tool', ask: 'Ask', answer: 'Answer', note: 'Note' }
  const hours = (ms) => {
    const minutes = Math.round((Number.isFinite(ms) ? ms : 0) / 60000)
    return minutes < 60 ? `${minutes}m` : minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`
  }

  /** "Ask for everything · claude-haiku-4.5 · effort high · 41 of 500 tool calls · 38m of 2h active" */
  function panelSummary(launch) {
    return [
      LAUNCH_MODES.find((m) => m.id === launch.mode)?.label ?? launch.mode,
      launch.model,
      launch.reasoning_effort ? `effort ${launch.reasoning_effort}` : '',
      `${launch.tool_calls ?? 0} of ${launch.budget_tool_calls} tool calls`,
      `${hours(launch.active_ms)} of ${hours(launch.budget_active_ms)} active`,
    ].filter(Boolean).join(' · ')
  }

  const keyed = (el, key, build) => {
    if (el.dataset.key === key) return
    el.dataset.key = key
    const focused = doc.activeElement
    const action = focused instanceof doc.defaultView.Element && el.contains(focused) ? focused.dataset?.launchAction : null
    el.replaceChildren(...build())
    if (!action) return
    const again = el.querySelector(`[data-launch-action="${action}"]`) ?? el.querySelector('[data-launch-action]')
    if (again && doc.activeElement !== again && doc.hasFocus()) again.focus({ preventScroll: true })
  }

  /**
   * @param {Element} aside the panel, holding `.sp-actions`, `.sp-note`, `.sp-worktree`, `.sp-transcript` and `.sp-resume`
   * @param {string|null} id the launch the panel shows, or null for a session that is not one of this app's launches
   */
  function paintPanel(aside, id, nowMs) {
    const launch = id && on() ? (deps.launches() ?? []).find((l) => l.id === id) ?? null : null
    const parts = ['.sp-actions', '.sp-note', '.sp-worktree', '.sp-transcript', '.sp-resume'].map((sel) => aside.querySelector(sel))
    const [actionsEl, noteEl, worktreeEl, transcriptEl, resumeEl] = parts
    if (!launch) {
      for (const el of parts) if (el && !el.hidden) el.hidden = true
      stopTranscript()
      return
    }
    for (const el of parts) if (el && el.dataset.launch !== id) el.dataset.launch = id
    if (!actionsEl.dataset.bound) {
      actionsEl.dataset.bound = '1'
      actionsEl.addEventListener('click', onSectionClick)
      resumeEl.addEventListener('click', onSectionClick)
    }
    const status = launchStatus(launch, deps.activity(), nowMs)
    const allowed = granted()
    // the action bar (§3.3): what the drawer row offered, from the launch's state and the grant
    const actions = []
    if (allowed) {
      for (const action of status.actions) {
        if (action === 'park') actions.push(['park', 'Park now'])
        else if (action === 'stop') actions.push(['stop', launch.status === 'parked' ? 'End' : 'Stop', 'danger'])
        else if (action === 'close') actions.push(['close', 'Close'])
        else if (action === 'takeover' || action === 'terminal') {
          actions.push(['take-over', busy.has(id) ? 'Handing off…' : action === 'takeover' ? 'Take over in Terminal' : 'Resume in Terminal'])
        }
      }
      if (launch.worktree_path && !launch.worktree_removed_at) {
        actions.push(['open-worktree', 'Open in Terminal'])
        actions.push(['remove-worktree', 'Remove worktree…', 'end', launch.status !== 'ended'])
      }
    }
    keyed(actionsEl, JSON.stringify([actions, busy.has(id)]), () => actions.map(([action, label, tone, off]) => {
      const el = button(label, action, tone === 'danger' ? 'danger' : tone === 'end' ? 'sp-end' : '')
      if (off) {
        el.disabled = true
        el.title = 'Only once the session has ended'
      }
      if (busy.has(id)) el.disabled = true
      return el
    }))
    if (actionsEl.hidden !== !actions.length) actionsEl.hidden = !actions.length
    const note = notes.get(id) ?? ''
    if (noteEl.textContent !== note) noteEl.textContent = note
    if (noteEl.hidden !== !note) noteEl.hidden = !note
    // the worktree box (#432)
    const box = worktreeEl.querySelector('.sp-worktree-box')
    const hasTree = typeof launch.worktree_path === 'string' && launch.worktree_path !== ''
    const branch = typeof launch.branch === 'string' ? launch.branch : ''
    const rows = !hasTree ? [] : launch.worktree_removed_at
      ? [['Worktree', `Removed; its branch ${branch} is kept.`]]
      : [['Branch', branch], ['Folder', launch.worktree_path], ['Changes', worktreeSummaryText(launch.worktree_summary, branch) || 'Not read yet']]
    keyed(box, JSON.stringify(rows), () => rows.flatMap(([term, value]) => [make('dt', '', term), make('dd', term === 'Changes' || term === 'Worktree' ? '' : 'mono', value)]))
    if (worktreeEl.hidden !== !hasTree) worktreeEl.hidden = !hasTree
    // the transcript: a section of the panel, read every 2 s only while the panel shows it
    if (transcriptEl.hidden) transcriptEl.hidden = false
    showTranscript(transcriptEl, id)
    // Resume and send (§5.3, §7) for a parked or resumable launch, in place of the composer
    const resumable = allowed && status.actions.includes('resume')
    if (resumeEl.hidden !== !resumable) resumeEl.hidden = !resumable
    if (!resumable) return
    let input = resumeInputs.get(id)
    if (!input) {
      input = make('textarea', 'sp-resume-input')
      input.rows = 2
      input.maxLength = 4000
      input.setAttribute('aria-label', 'Message to send when the session resumes')
      input.value = drafts.get(`resume:${id}`) ?? ''
      input.addEventListener('input', () => {
        setDraft(`resume:${id}`, input.value)
        const send = resumeEl.querySelector('[data-launch-action="resume"]')
        if (send) send.disabled = busy.has(id) || !input.value.trim()
      })
      resumeInputs.set(id, input)
    }
    const slot = resumeEl.querySelector('.sp-resume-slot')
    if (slot.firstElementChild !== input) slot.replaceChildren(input)
    const send = resumeEl.querySelector('[data-launch-action="resume"]')
    const label = busy.has(id) ? 'Resuming…' : 'Resume and send'
    if (send.textContent !== label) send.textContent = label
    const blocked = busy.has(id) || !input.value.trim()
    if (send.disabled !== blocked) send.disabled = blocked
  }

  /** The panel's Resume and send text, focused: an explicit click (Resume…) always lands on it. */
  function focusResume(id) {
    const input = resumeInputs.get(id)
    if (input?.isConnected) input.focus()
  }

  // Shown means connected with no hidden ancestor: a hidden panel, or the Dashboard
  // behind another tab, reads nothing until it shows again.
  const shown = (el) => el.isConnected && !el.closest('[hidden]')

  function showTranscript(section, id) {
    const list = section.querySelector('.sp-transcript-lines')
    const status = section.querySelector('.sp-transcript-status')
    if (transcript && (transcript.id !== id || transcript.list !== list)) stopTranscript()
    if (!transcript) {
      list.replaceChildren()
      status.textContent = 'Loading…'
      transcript = { id, list, status, events: [], after: 0, timer: null, drawn: 0, reading: false }
    }
    if (!transcript.timer && !transcript.reading && shown(list)) pollTranscript(transcript)
  }

  async function pollTranscript(current) {
    if (transcript !== current) return
    current.timer = null
    if (!shown(current.list)) return // resumed by the next paint that shows it
    current.reading = true
    const body = await deps.fetchJson(`/api/launches/${encodeURIComponent(current.id)}/events?after=${current.after}`).catch(() => null)
    current.reading = false
    if (transcript !== current) return
    if (!body || !Array.isArray(body.events)) {
      current.status.textContent = 'The transcript could not be read.'
    } else {
      if (body.rotated) {
        current.events = []
        current.drawn = 0
        current.list.replaceChildren()
      }
      current.events.push(...body.events)
      if (current.events.length > TRANSCRIPT_MAX_EVENTS) {
        current.events = current.events.slice(-TRANSCRIPT_MAX_EVENTS)
        current.drawn = 0
        current.list.replaceChildren()
      }
      current.after = Number.isSafeInteger(body.next) ? body.next : current.after
      drawTranscript(current)
      current.status.textContent = current.events.length ? '' : 'Nothing yet.'
      if (body.more) {
        current.timer = setTimeout(() => pollTranscript(current), 0)
        return
      }
    }
    current.timer = setTimeout(() => pollTranscript(current), TRANSCRIPT_POLL_MS)
  }

  function drawTranscript(current) {
    const lines = transcriptLines(current.events)
    const box = current.list.parentElement
    // newest at the bottom: a reader at the bottom stays there, one scrolled up stays put
    const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 8
    // the last line can still grow (agent text arrives in pieces), so it is redrawn
    const from = Math.max(0, Math.min(current.drawn, lines.length) - 1)
    while (current.list.children.length > from) current.list.lastChild.remove()
    for (const line of lines.slice(from)) {
      const item = make('li', `launch-line ${line.kind}`)
      item.append(make('span', 'tx-k', TRANSCRIPT_LABELS[line.kind] ?? ''), make('span', 'tx-b', line.text))
      current.list.append(item)
    }
    current.drawn = lines.length
    if (box && atBottom) box.scrollTop = box.scrollHeight
  }

  function stopTranscript() {
    if (!transcript) return
    clearTimeout(transcript.timer)
    transcript = null
  }

  // ── lanes (#304): a "Started here" tag and Stop on a launch's lane ───────
  function paintLane(el, session) {
    let tag = el.querySelector('.dash-lane-launch')
    const launch = on() ? launchOfSession(deps.launches(), session) : null
    if (!launch || launch.status !== 'running') {
      tag?.remove()
      return
    }
    if (!tag) {
      tag = make('div', 'dash-lane-launch')
      tag.append(make('span', 'dash-lane-launch-tag', 'Started here'))
      const stopButton = button('Stop', 'stop', 'dash-lane-stop')
      stopButton.addEventListener('click', () => {
        const id = tag.dataset.launch
        if (id) stop(id)
      })
      tag.append(stopButton)
      el.querySelector('.dash-lane-meta')?.after(tag)
    }
    if (tag.dataset.launch !== launch.id) tag.dataset.launch = launch.id
    const stopButton = tag.querySelector('.dash-lane-stop')
    const hidden = !granted() || Boolean(launch.stop_requested_at)
    if (stopButton.hidden !== hidden) stopButton.hidden = hidden
  }

  return {
    refresh,
    setState,
    on,
    granted,
    version: () => version,
    /** The drafts that pause the editable rebuild: the open dialog's task. */
    drafts: () => (dialog && drafts.has('new') ? [['new', drafts.get('new')]] : []),
    /** Whether typed text would be lost to a viewer restart's reload. */
    held: () => [...drafts.keys()].some((key) => key !== 'new' || dialog !== null) || busy.size > 0,
    paintDrawer,
    paintLane,
    approve,
    closeMessage,
    /** The Agents home's New session… (#454): null with the switch off. */
    newSession: () => (on()
      ? { disabled: !granted() || starting !== null, note: granted() ? '' : 'Starting and approving sessions works only in Agent Inbox’s own window.' }
      : null),
    openNewSession,
    /** A session card's action on its launch (#454): the drawer row's own handlers. */
    run(id, action) {
      if (!on() || !granted()) return
      if (action === 'close') close(id)
      else if (action === 'take-over') takeOver(id)
      else if (action === 'open-worktree') openWorktree(id)
    },
    paintPanel,
    panelSummary,
    focusResume,
  }
}
