// public/chats-view.js
// The Chats tab (#586 PR 2, docs/architecture/chats.md "Chats tab"). It reads
// /api/chats only when the tab is opened (and the list is missing or over a
// minute old), on Refresh or Retry, and when Show all changes: never from the
// poll. It paints #chats alone, from its own state: render() calls paint() while
// the panel shows, and a settled read or a control paints the region directly,
// as search paints its results. The header and table are built once and rows are
// keyed by tool and id, so the search box, focus and a Copy press survive a paint.
// Chat text (title, project, branch, folder) is untrusted: textContent and
// attributes only. The one markup write is the PR link, from textLinkHtml.
// PR 3: in the desktop app's own window on macOS (the preload's agentInboxChats
// says so), each row also gets Resume, which asks main to open the chat in the
// chosen terminal; main reads the folder from the index itself.
// #586 phase 2: in the window main grants launches, with the driven-sessions switch on, each
// Copilot row also gets Continue here…, which opens launch-ui.js's dialog; a chat one of this
// app's launches holds gets Show session in its place, Live "· here" while that launch runs, and
// Resume and Copy resume off beside it. The link is the launches the page already reads with the
// switch on (each launch's chat_id); with the switch off none of this is drawn or read.
// Jump to session (#586): in any window, a live chat the list names a session for gets Jump to
// session, which asks the app to open that session's card. The list's own `session` is the link.

import {
  allSwitchText, chatLaunch, chatsUrl, CHECKING_TEXT, CONTINUE_LABEL, continueControl, continueOutcome, displayFolder, drivenView, emptyText,
  filterChats, HERE_TEXT, hiddenLabel, inferHome, JUMP_GONE_TEXT, JUMP_LABEL, jumpControl, lastActiveView, projectOptions, readChatsBody, RESUME_BUSY_LABEL, RESUME_LABEL,
  resumeControl, resumeOutcome, resumeTerminalControl, retentionText, SESSIONS_UNREAD_TEXT, SHOW_SESSION_LABEL, shouldFetchOnOpen, shownText, sortChats,
  titleView, toolLabel, TRUNCATED_TEXT,
} from './chats.js'
import { githubRef } from './links.js'
import { pressHeld, PRESS_GRACE_MS } from './poll.js'
import { captureSelection, restoreSelection } from './selection.js'
import { textLinkHtml } from './source.js'
import { writeClipboard } from './structured-copy.js'

const COPY_LABEL = 'Copy resume'
const CONFIRM_MS = 1500
const TOOL_FILTERS = [['all', 'All'], ['claude', 'Claude Code'], ['copilot', 'Copilot']]
const COLUMNS = ['Tool', 'Title', 'Project', 'Branch', 'Folder', 'Last active', 'Live', 'Actions']

/**
 * @param {{ doc: Document, host: () => HTMLElement | null, fetch: (url: string) => Promise<Response>, now: () => number,
 *   resume?: () => ({ resumeAvailable(): Promise<unknown>, resume(request: { tool: string, id: string }): Promise<unknown> } | null),
 *   drive?: () => ({ available(): Promise<boolean>, granted(): boolean, launches(): unknown[] | null, launchesFailed(): boolean,
 *     continueChat(chat: { tool: string, id: string, title: string | null, folder: string | null },
 *       hooks: { returnFocus: () => HTMLElement | null, answered: (result: unknown) => void }): boolean,
 *     showSession(launchId: string): void } | null),
 *   jump?: ((session: string) => boolean | Promise<boolean>) | null }} deps
 */
export function installChatsView({ doc, host, fetch, now, resume = () => null, drive = () => null, jump = null }) {
  const win = doc.defaultView
  // window-local and never persisted, like Show archived: they survive tab switches and reads
  const filter = { query: '', tool: 'all', project: null }
  let showAll = false
  let body = null      // the last list read, kept when a later read fails
  let loadedAt = null  // when that list was read
  let loading = false
  let error = null     // { status } of the last read when it failed
  let seq = 0          // only the newest read is applied, so Show all mid-read never shows the other set
  let opened = false
  let version = 0
  let ui = null
  const rowEls = new Map()
  const chatByKey = new Map()
  // a press inside the region holds a paint that would move or remove rows (#38)
  let pressedAt = null
  let heldPaint = false
  let heldTimer = null
  // Resume in Terminal (PR 3): asked again on every entry into the tab, so a reload's re-proof
  // and a Settings → Terminal change both show; per-row state lives here, so a paint keeps it
  let canResume = false
  let terminal = 'terminal'
  let askSeq = 0
  const resumeBusy = new Set()
  const resumeConfirm = new Map() // key → "Opened in iTerm2", for CONFIRM_MS
  const resumeTimers = new Map()
  const resumeNotes = new Map()   // key → the fallback notice or main's reason, until the next press
  // #586 phase 2: Continue here… and Show session, asked again on every entry into the tab like
  // Resume; each row's link to a launch of this app, from the last paint
  let canDrive = false
  let driveSeq = 0
  const drivenByKey = new Map()
  // the last launch list read while this window may continue chats: a later failed read keeps it,
  // so a failed tick never turns Copy resume and Resume back on beside a chat a session here holds
  let lastLaunches = null
  // key → why Copy resume and Resume are off for a Copilot chat (driven here, or not known yet)
  const heldOff = new Map()
  const NOT_DRIVEN = drivenView(null)

  const make = (tag, className, text) => {
    const el = doc.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setHidden = (el, hidden) => { if (el.hidden !== hidden) el.hidden = hidden }
  const setAttr = (el, name, value) => {
    if (value === null) { if (el.hasAttribute(name)) el.removeAttribute(name) } else if (el.getAttribute(name) !== value) el.setAttribute(name, value)
  }
  const changed = () => { version += 1 }

  function button(className, text, onClick) {
    const el = make('button', className, text)
    el.type = 'button'
    el.addEventListener('click', onClick)
    return el
  }

  function build(root) {
    const header = make('div', 'tab-header chats-header')
    const search = make('input', 'chats-search')
    search.type = 'search'
    search.placeholder = 'Search chats'
    search.setAttribute('aria-label', 'Search chats')
    search.autocomplete = 'off'
    search.spellcheck = false
    search.addEventListener('input', () => {
      filter.query = search.value
      changed()
      settlePaint()
    })
    const tools = make('div', 'queue-filter-group chats-tools')
    tools.setAttribute('role', 'group')
    tools.setAttribute('aria-label', 'Tool')
    for (const [value, label] of TOOL_FILTERS) {
      const toggle = button('header-toggle', label, () => {
        filter.tool = value
        changed()
        settlePaint()
      })
      toggle.dataset.chatsTool = value
      tools.append(toggle)
    }
    const project = make('label', 'queue-sort chats-project')
    const select = make('select')
    select.addEventListener('change', () => {
      filter.project = select.value || null
      changed()
      settlePaint()
    })
    project.append(make('span', '', 'Project'), select)
    const all = make('label', 'header-switch chats-all')
    const allInput = make('input')
    allInput.type = 'checkbox'
    allInput.setAttribute('role', 'switch')
    allInput.addEventListener('change', () => {
      showAll = allInput.checked
      read()
    })
    all.append(allInput, make('span', 'chats-all-label', 'Show all'))
    const refresh = button('header-toggle chats-refresh', 'Refresh', () => {
      if (!loading) read()
    })
    header.append(search, tools, project, all, refresh)

    const retention = make('p', 'chats-note chats-retention')
    const truncated = make('p', 'chats-note chats-truncated', TRUNCATED_TEXT)
    truncated.hidden = true
    const errorBox = make('div', 'chats-error')
    errorBox.setAttribute('role', 'status')
    errorBox.hidden = true
    const errorText = make('span')
    errorBox.append(errorText, ' ', button('header-toggle chats-retry', 'Retry', () => {
      if (!loading) read()
    }))
    const countLine = make('p', 'chats-count')
    countLine.setAttribute('aria-live', 'polite')
    const state = make('p', 'empty chats-state')
    const table = make('table', 'chats-table')
    const head = make('tr')
    for (const label of COLUMNS) {
      const th = make('th', '', label)
      th.scope = 'col'
      if (label === 'Actions') th.className = 'visually-hidden'
      head.append(th)
    }
    table.append(make('thead'), make('tbody'))
    table.tHead.append(head)
    root.addEventListener('pointerdown', () => { pressedAt = now() })
    const release = () => {
      if (pressedAt === null) return
      pressedAt = null
      // after the click this press makes has landed on the node it started on
      if (heldPaint) win.setTimeout(flushHeld, 0)
    }
    win.addEventListener('pointerup', release, true)
    win.addEventListener('pointercancel', release, true)
    root.append(header, retention, truncated, errorBox, countLine, state, table)
    return { root, search, tools, select, allInput, allLabel: all.querySelector('.chats-all-label'), refresh, retention, truncated, errorBox, errorText, countLine, state, table }
  }

  async function read() {
    const mine = ++seq
    loading = true
    changed()
    settlePaint()
    let next = null
    let failed = null
    try {
      const response = await fetch(chatsUrl(showAll))
      if (!response.ok) failed = { status: response.status }
      else {
        next = readChatsBody(await response.json())
        if (!next) failed = { status: null }
      }
    } catch {
      failed = { status: null }
    }
    if (mine !== seq) return
    loading = false
    if (next) {
      body = next
      loadedAt = now()
      error = null
    } else {
      error = failed
    }
    changed()
    settlePaint()
  }

  // A paint outside render(): it keeps a text selection the way render() does, and
  // waits for a press inside the region to end, bounded like the app's press guard.
  function settlePaint() {
    if (!opened) return
    if (pressHeld(pressedAt, now())) {
      heldPaint = true
      if (heldTimer === null) heldTimer = win.setTimeout(flushHeld, PRESS_GRACE_MS)
      return
    }
    const bookmark = captureSelection(doc)
    paint()
    restoreSelection(bookmark, doc)
  }

  function flushHeld() {
    if (heldTimer !== null) win.clearTimeout(heldTimer)
    heldTimer = null
    if (!heldPaint) return
    heldPaint = false
    pressedAt = null
    settlePaint()
  }

  async function copy(key, control) {
    const chat = chatByKey.get(key)
    if (!chat || control.getAttribute('aria-disabled') === 'true') return
    const { command } = resumeControl(chat)
    if (!command) return
    const copied = await writeClipboard(doc, command).catch(() => false)
    control.textContent = copied ? 'Copied' : 'Copy failed'
    win.clearTimeout(Number(control.dataset.confirmTimer))
    control.dataset.confirmTimer = String(win.setTimeout(() => { control.textContent = COPY_LABEL }, CONFIRM_MS))
  }

  function setResumeAvailable(available, id) {
    const next = id === 'iterm2' ? 'iterm2' : 'terminal'
    if (available === canResume && next === terminal) return
    canResume = available
    terminal = next
    changed()
    settlePaint()
  }

  function askResume() {
    const mine = ++askSeq
    const bridge = resume()
    if (!bridge || typeof bridge.resumeAvailable !== 'function') {
      setResumeAvailable(false, 'terminal')
      return
    }
    Promise.resolve().then(() => bridge.resumeAvailable()).then(
      (answer) => { if (mine === askSeq) setResumeAvailable(answer?.available === true, answer?.terminal) },
      () => { if (mine === askSeq) setResumeAvailable(false, 'terminal') },
    )
  }

  async function resumeChat(key) {
    const chat = chatByKey.get(key)
    const bridge = resume()
    if (!chat || !bridge || !canResume || resumeBusy.has(key) || !resumeTerminalControl(chat, terminal).enabled) return
    // a chat driven here, or one not yet known not to be, is never opened in a terminal too (§3.5)
    if (heldOff.has(key)) return
    resumeBusy.add(key)
    win.clearTimeout(resumeTimers.get(key))
    resumeTimers.delete(key)
    resumeConfirm.delete(key)
    resumeNotes.delete(key)
    changed()
    settlePaint()
    let result = null
    try {
      result = await bridge.resume({ tool: chat.tool, id: chat.id })
    } catch {
      result = null
    }
    resumeBusy.delete(key)
    const outcome = resumeOutcome(result)
    if (outcome.note) resumeNotes.set(key, outcome.note)
    if (outcome.label) {
      resumeConfirm.set(key, outcome.label)
      resumeTimers.set(key, win.setTimeout(() => {
        resumeTimers.delete(key)
        resumeConfirm.delete(key)
        changed()
        settlePaint()
      }, CONFIRM_MS))
    }
    changed()
    // after live, folder, missing or opened the list is read again, so the row's off state catches up
    if (outcome.refresh) read()
    else settlePaint()
  }

  function setDriveAvailable(available) {
    if (available === canDrive) return
    canDrive = available
    changed()
    settlePaint()
  }

  function askDrive() {
    const mine = ++driveSeq
    const bridge = drive()
    if (!bridge || typeof bridge.available !== 'function') {
      setDriveAvailable(false)
      return
    }
    Promise.resolve().then(() => bridge.available()).then(
      (answer) => { if (mine === driveSeq) setDriveAvailable(answer === true) },
      () => { if (mine === driveSeq) setDriveAvailable(false) },
    )
  }

  // the drive bridge while this window may continue chats now, else null
  const driving = () => {
    if (!canDrive) return null
    const bridge = drive()
    return bridge && typeof bridge.granted === 'function' && bridge.granted() === true ? bridge : null
  }

  // Continue here…: launch-ui.js's dialog; main's answer lands in the row's note, and after a
  // live, driven, folder or missing refusal the list is read again, as Resume does
  function continueChat(key) {
    const chat = chatByKey.get(key)
    const bridge = driving()
    if (!chat || !bridge || drivenByKey.get(key)?.show || continueControl(chat)?.enabled !== true) return
    const opened = bridge.continueChat({ tool: chat.tool, id: chat.id, title: chat.title, folder: chat.cwd }, {
      returnFocus: () => rowEls.get(key)?.querySelector('.chats-continue, .chats-show') ?? null,
      answered: (result) => {
        const outcome = continueOutcome(result)
        if (outcome.note) resumeNotes.set(key, outcome.note)
        else resumeNotes.delete(key)
        changed()
        if (outcome.refresh) read()
        else settlePaint()
      },
    })
    if (opened && resumeNotes.delete(key)) {
      changed()
      settlePaint()
    }
  }

  function showSession(key) {
    const id = drivenByKey.get(key)?.show
    const bridge = driving()
    if (id && bridge) bridge.showSession(id)
  }

  // Jump to session (#586): the app opens the chat's session card. When it is no longer listed the
  // row's note says so and the list is read again, which drops the control with the session.
  function jumpChat(key) {
    const chat = chatByKey.get(key)
    const view = chat && jump && !drivenByKey.get(key)?.show ? jumpControl(chat) : null
    if (!view) return
    if (resumeNotes.delete(key)) {
      changed()
      settlePaint()
    }
    const gone = () => {
      resumeNotes.set(key, JUMP_GONE_TEXT)
      changed()
      read()
    }
    Promise.resolve().then(() => jump(view.session)).then((went) => { if (went !== true) gone() }, gone)
  }

  // Jump to session after Copy resume on a live chat whose process has a session card. A chat a
  // session here holds has Show session for that. Returns whether the row has the control.
  function paintJump(tr, chat, driven) {
    const key = tr.dataset.chatKey
    const actions = tr.querySelector('.chats-actions')
    const view = jump && !driven.show ? jumpControl(chat) : null
    let control = actions.querySelector('.chats-jump')
    if (!view) {
      control?.remove()
      return false
    }
    if (!control) {
      control = button('chats-jump', JUMP_LABEL, () => jumpChat(key))
      actions.querySelector('.chats-copy').after(control)
    }
    setAttr(control, 'title', view.title)
    return true
  }

  // The Resume button exists only while main says this window can resume. Beside Show session it
  // is off (§3.5): this chat has a session here.
  function paintResume(tr, chat, offTitle) {
    const key = tr.dataset.chatKey
    const actions = tr.querySelector('.chats-actions')
    let control = actions.querySelector('.chats-resume')
    if (!canResume) {
      control?.remove()
      return
    }
    if (!control) {
      control = button('chats-resume', RESUME_LABEL, () => resumeChat(key))
      actions.prepend(control)
    }
    const view = offTitle ? { enabled: false, title: offTitle, ariaLabel: null } : resumeTerminalControl(chat, terminal)
    const busy = resumeBusy.has(key)
    const confirm = resumeConfirm.get(key) ?? null
    setText(control, busy ? RESUME_BUSY_LABEL : confirm ?? RESUME_LABEL)
    setAttr(control, 'title', view.title)
    setAttr(control, 'aria-disabled', busy || !view.enabled ? 'true' : null)
    // off while the label says what happened, so "Opening…" and "Opened in …" are what is announced
    setAttr(control, 'aria-label', busy || confirm ? null : view.ariaLabel)
  }

  // #586 phase 2: Continue here… after Copy resume on a Copilot row, or Show session in its place
  // for a chat one of this app's launches holds; neither exists unless this window may continue chats
  function paintContinue(tr, chat, driven, allowed) {
    const key = tr.dataset.chatKey
    const actions = tr.querySelector('.chats-actions')
    const view = allowed ? continueControl(chat) : null
    let control = actions.querySelector('.chats-continue')
    let show = actions.querySelector('.chats-show')
    if (!view || driven.show) control?.remove()
    if (!view || !driven.show) show?.remove()
    if (!view) return
    const copy = actions.querySelector('.chats-copy')
    if (driven.show) {
      if (!show) {
        show = button('chats-show', SHOW_SESSION_LABEL, () => showSession(key))
        copy.after(show)
      }
      setAttr(show, 'title', driven.title)
      return
    }
    if (!control) {
      control = button('chats-continue', CONTINUE_LABEL, () => continueChat(key))
      // the dialog it opens is modal
      control.setAttribute('aria-haspopup', 'dialog')
      copy.after(control)
    }
    setAttr(control, 'title', view.title)
    setAttr(control, 'aria-disabled', view.enabled ? null : 'true')
  }

  // The note under the controls: the fallback notice or main's reason, Resume's or Continue here…'s,
  // or that a jump found no session. A row with none of the three keeps phase 1's cell.
  function paintNote(tr, allowed) {
    const key = tr.dataset.chatKey
    const actions = tr.querySelector('.chats-actions')
    let note = actions.querySelector('.chats-resume-note')
    if (!canResume && !allowed && !resumeNotes.has(key)) {
      note?.remove()
      return
    }
    if (!note) {
      note = make('span', 'chats-resume-note')
      note.setAttribute('role', 'status')
      actions.append(note)
    }
    setText(note, resumeNotes.get(key) ?? '')
  }

  function rowEl(key) {
    const tr = make('tr')
    tr.dataset.chatKey = key
    const titleCell = make('td', 'chats-title')
    titleCell.append(make('span', 'chats-title-text'), make('span', 'chats-reasons'))
    const branchCell = make('td', 'chats-branch')
    branchCell.append(make('span', 'chats-branch-text'), make('span', 'chats-pr'))
    const control = button('chats-copy', COPY_LABEL, () => copy(key, control))
    // no aria-label: the visible text is the name, so "Copied" and "Copy failed" reach a screen reader
    const actions = make('td', 'chats-actions')
    actions.append(control)
    tr.append(make('td', 'chats-tool'), titleCell, make('td', 'chats-project'), branchCell, make('td', 'chats-folder'),
      make('td', 'chats-active'), make('td', 'chats-live'), actions)
    return tr
  }

  // A kept row changes only where its chat did. The Copy label is never set
  // here, so a paint cannot cut a "Copied" short.
  function paintRow(tr, chat, home, nowMs, launches, checking) {
    const [tool, titleCell, projectCell, branchCell, folderCell, activeCell, liveCell] = tr.children
    setText(tool, toolLabel(chat.tool))
    const title = titleView(chat)
    const titleText = titleCell.querySelector('.chats-title-text')
    setText(titleText, title.text)
    titleText.classList.toggle('chats-quiet', title.quiet)
    setAttr(titleText, 'title', title.title)
    const reasons = titleCell.querySelector('.chats-reasons')
    const reasonKey = chat.hidden.join(' ')
    if (reasons.dataset.reasons !== reasonKey) {
      reasons.dataset.reasons = reasonKey
      reasons.replaceChildren(...chat.hidden.map((reason) => make('span', 'chip chip-neutral chats-reason', hiddenLabel(reason))))
    }
    setText(projectCell, chat.project)
    setText(branchCell.querySelector('.chats-branch-text'), chat.branch ?? '')
    const pr = branchCell.querySelector('.chats-pr')
    const prUrl = chat.pr?.url ?? ''
    if (pr.dataset.prUrl !== prUrl) {
      pr.dataset.prUrl = prUrl
      const ref = prUrl ? githubRef(prUrl) : null
      // the product's one href builder, and only for a github.com pull request page
      pr.innerHTML = ref?.kind === 'pr' ? textLinkHtml(prUrl, `#${ref.number}`, 'pr') : ''
    }
    setText(folderCell, displayFolder(chat.cwd, home) || '—')
    setAttr(folderCell, 'title', chat.cwd ?? 'No folder recorded')
    const active = lastActiveView(chat.lastActiveAt, nowMs)
    setText(activeCell, active.text)
    setAttr(activeCell, 'title', active.title)
    // #586 phase 2: the launches are read only with the switch on; null otherwise
    const allowed = launches !== null
    const driven = allowed && chat.tool === 'copilot' ? drivenView(chatLaunch(launches, chat.id)) : NOT_DRIVEN
    drivenByKey.set(tr.dataset.chatKey, driven)
    // Live from the index, or "Live · here" while a launch of this app runs the chat (§3.5)
    const live = liveCell.querySelector('.chats-live')
    const showLive = chat.live || driven.here
    if (showLive && !live) liveCell.prepend(make('span', 'chip chats-live', 'Live'))
    if (!showLive && live) live.remove()
    let here = liveCell.querySelector('.chats-here')
    if (driven.here && !here) {
      here = make('span', 'chats-here', HERE_TEXT)
      here.title = driven.hereTitle
      liveCell.append(here)
    }
    if (!driven.here && here) here.remove()
    // beside Show session nothing is copied or opened: a second Copilot would open on a chat
    // driven here; nor before the launches are first read, when that is not known yet
    const offTitle = driven.show ? driven.offTitle : checking && chat.tool === 'copilot' ? CHECKING_TEXT : null
    if (offTitle) heldOff.set(tr.dataset.chatKey, offTitle)
    const control = tr.querySelector('.chats-copy')
    const copyView = resumeControl(chat)
    setAttr(control, 'title', offTitle ?? copyView.title)
    setAttr(control, 'aria-disabled', copyView.command && !offTitle ? null : 'true')
    paintResume(tr, chat, offTitle)
    // a live Copilot chat's Continue here… could only be off: Jump to session takes its place
    const jumping = paintJump(tr, chat, driven)
    paintContinue(tr, chat, driven, allowed && !jumping)
    paintNote(tr, allowed)
  }

  // made only when needed, so a window that may not continue chats draws exactly what phase 1 did
  function paintSessionsNote(show) {
    let note = ui.root.querySelector('.chats-sessions')
    if (!show) {
      note?.remove()
      return
    }
    if (!note) {
      note = make('p', 'chats-note chats-sessions', SESSIONS_UNREAD_TEXT)
      note.setAttribute('role', 'status')
      ui.root.insertBefore(note, ui.countLine)
    }
  }

  function paintHeader(projects) {
    for (const toggle of ui.tools.children) {
      const on = toggle.dataset.chatsTool === filter.tool
      toggle.classList.toggle('active', on)
      setAttr(toggle, 'aria-pressed', String(on))
    }
    const options = ['', ...projects]
    if (ui.select.dataset.options !== JSON.stringify(options)) {
      ui.select.dataset.options = JSON.stringify(options)
      ui.select.replaceChildren(...options.map((value) => new win.Option(value || 'All projects', value)))
    }
    if (ui.select.value !== (filter.project ?? '')) ui.select.value = filter.project ?? ''
    if (ui.allInput.checked !== showAll) ui.allInput.checked = showAll
    setText(ui.allLabel, allSwitchText(body?.counts ?? null))
    setText(ui.refresh, loading ? 'Refreshing…' : 'Refresh')
    // aria-disabled, not disabled: a focused control that becomes disabled drops focus to the page
    setAttr(ui.refresh, 'aria-disabled', loading ? 'true' : null)
  }

  /** Paints #chats from the view's own state; nothing before the tab is first opened. */
  function paint() {
    const root = opened ? host() : null
    if (!root) return
    if (!ui || ui.root !== root) {
      rowEls.clear()
      ui = build(root)
    }
    const chats = body ? sortChats(body.chats) : []
    const projects = projectOptions(chats)
    // a project no longer in the list falls back to All
    if (filter.project !== null && !projects.includes(filter.project)) filter.project = null
    paintHeader(projects)
    const home = inferHome(chats)
    const visible = filterChats(chats, filter, home)
    setText(ui.retention, retentionText(body?.claudeDays ?? 30))
    setHidden(ui.retention, !body)
    setHidden(ui.truncated, !body?.truncated)
    setHidden(ui.errorBox, !error)
    if (error) {
      const status = error.status ? ` (${error.status})` : ''
      setText(ui.errorText, body ? `Couldn't refresh chats${status}. Showing the last list.` : `Couldn't load chats${status}.`)
    }
    setText(ui.countLine, body ? shownText(visible.length, chats.length) : '')
    setHidden(ui.countLine, !body || chats.length === 0)
    const stateText = body
      ? emptyText({ loaded: chats.length, shown: visible.length, hidden: body.counts.hidden, all: showAll })
      : loading ? 'Loading chats…' : null
    setText(ui.state, stateText ?? '')
    setHidden(ui.state, stateText === null)
    setHidden(ui.table, visible.length === 0)

    const tbody = ui.table.tBodies[0]
    const keys = visible.map((chat) => `${chat.tool}:${chat.id}`)
    const keep = new Set(keys)
    for (const [key, el] of rowEls) {
      if (keep.has(key)) continue
      el.remove()
      rowEls.delete(key)
    }
    chatByKey.clear()
    drivenByKey.clear()
    heldOff.clear()
    const nowMs = now()
    // #586 phase 2: what Continue here… and Show session are drawn from, the last list read while
    // this window may continue chats. None yet (no grant, or the launches not read yet) draws
    // neither; with the grant, Copilot rows then keep Copy resume and Resume off until it lands.
    const bridge = driving()
    const held = bridge?.launches()
    if (!bridge) lastLaunches = null
    else if (Array.isArray(held)) lastLaunches = held
    const launches = lastLaunches
    const checking = Boolean(bridge) && launches === null
    // said once above the table, only after the tab's own read finished and a launches read failed
    paintSessionsNote(checking && !loading && (body !== null || error !== null) && bridge.launchesFailed?.() === true)
    visible.forEach((chat, index) => {
      const key = keys[index]
      chatByKey.set(key, chat)
      let el = rowEls.get(key)
      if (!el) rowEls.set(key, (el = rowEl(key)))
      paintRow(el, chat, home, nowMs, launches, checking)
      if (tbody.children[index] !== el) tbody.insertBefore(el, tbody.children[index] ?? null)
    })
  }

  return {
    /** The tab was entered from elsewhere: read when nothing is loaded or the list is stale, then paint. */
    opened() {
      opened = true
      askResume()
      askDrive()
      if (shouldFetchOnOpen({ loadedAt, loading, nowMs: now() })) read()
      else settlePaint()
    },
    paint,
    /** Changes with every read, settle and control change, for the poll's frameInputs(). */
    state: () => String(version),
  }
}
