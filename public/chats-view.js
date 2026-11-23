// public/chats-view.js
// The chats in Find (#586; UX pass, slice 4, step B: the Chats page folded into Find's Chats chip,
// docs/architecture/chats.md). It reads /api/chats only when Find is entered (and the list is
// missing or over a minute old), on Refresh or Retry, when Show all changes, and after a refusal
// that may have changed a row: never from the poll. It paints nothing on its own: Find's frame
// (app.js renderFind) draws the rows, keyed `chat:<tool>:<id>`, and asks this view to paint a chat
// row's one action slot and its open body, the line under the chips and the failure line at the
// list's foot. Every change here asks app.js for that frame (`changed`), which goes through the
// page's gated render. Every open, busy and confirmed state lives here, so a frame redraws it.
// Chat text (title, project, branch, folder) is untrusted: textContent and attributes only. The
// one markup write is the PR link, from textLinkHtml.
// PR 3: in the desktop app's own window on macOS (the preload's agentInboxChats says so), a row's
// slot holds Resume, which asks main to open the chat in the chosen terminal; main reads the folder
// from the index itself. The slot is chosen by whether that bridge exists, never by main's answer,
// so it never swaps under a press: Resume is drawn off with "Checking…" until main answers, and
// with main's reason when this window cannot resume. Without the bridge the slot holds Copy resume.
// #586 phase 2: in the window main grants launches, with the driven-sessions switch on, each
// Copilot row's body also gets Continue here…, which opens launch-ui.js's dialog; a chat one of this
// app's launches holds gets Show session in its slot, Live "· here" while that launch runs, and
// Resume and Copy resume off. The link is the launches the page already reads with the switch on
// (each launch's chat_id); with the switch off none of this is drawn or read.
// Jump to session (#586): in any window, a live chat the list names a session for gets Jump to
// session in its body, which asks the app to open that session's card.

import {
  allSwitchText, chatLaunch, chatsUrl, CHECKING_TEXT, CONTINUE_LABEL, continueControl, continueOutcome, displayFolder, drivenView, emptyText,
  HERE_TEXT, hiddenLabel, inferHome, JUMP_GONE_TEXT, JUMP_LABEL, jumpControl, lastActiveView, readChatsBody, RESUME_BUSY_LABEL, RESUME_CHECKING,
  RESUME_LABEL, RESUME_UNAVAILABLE, resumeControl, resumeOutcome, resumeTerminalControl, retentionText, SESSIONS_UNREAD_TEXT, SHOW_SESSION_LABEL,
  shouldFetchOnOpen, toolLabel, TRUNCATED_TEXT,
} from './chats.js'
import { githubRef } from './links.js'
import { textLinkHtml } from './source.js'
import { writeClipboard } from './structured-copy.js'

const COPY_LABEL = 'Copy resume'
const CONFIRM_MS = 1500
const TOOL_FILTERS = [['all', 'All'], ['claude', 'Claude Code'], ['copilot', 'Copilot']]

/**
 * @param {import('./chats-view.js').ChatsViewDeps} deps
 */
export function installChatsView({
  doc, fetch, now, resume = () => null, drive = () => null, jump = null, rowEl = () => null, changed = () => {}, reveal = () => {},
}) {
  const win = doc.defaultView
  // window-local and never persisted, like Show archived: they survive leaving Find and reads
  const filter = { tool: 'all' }
  let showAll = false
  let body = null      // the last list read, kept when a later read fails
  let loadedAt = null  // when that list was read
  let loading = false
  let error = null     // { status } of the last read when it failed
  let seq = 0          // only the newest read is applied, so Show all mid-read never shows the other set
  let version = 0
  let bar = null
  let foot = null
  const chatByKey = new Map()
  // Resume in Terminal (PR 3): asked again on every entry into Find, so a reload's re-proof and a
  // Settings → Terminal change both show; null until main first answers (the slot says Checking…)
  let resumeAnswer = null
  let askSeq = 0
  const resumeBusy = new Set()
  const resumeConfirm = new Map() // key → "Opened in iTerm2", for CONFIRM_MS
  const resumeTimers = new Map()
  const resumeNotes = new Map()   // key → the fallback notice or main's reason, until the next press
  // Jump to session: key → that the session was not found, until the row is pressed again or the
  // list is next read for another reason (the read a failed jump asks for keeps it)
  const jumpNotes = new Map()
  // key → the last chat object, for a chat that left the list in the read its own refused action
  // asked for (a folder gone, a chat removed): its row, open with the note, stays until the note is
  // cleared, so the reason is seen. Listed only while a note holds it (departedChats).
  const departed = new Map()
  let keepJumpNotes = false
  // #586 phase 2: Continue here… and Show session, asked again on every entry into Find like
  // Resume; each chat's link to a launch of this app, from the last frame
  let canDrive = false
  let driveSeq = 0
  const drivenByKey = new Map()
  // the last launch list read while this window may continue chats: a later failed read keeps it,
  // so a failed tick never turns Copy resume and Resume back on beside a chat a session here holds
  let lastLaunches = null
  // key → why Copy resume and Resume are off for a Copilot chat (driven here, or not known yet)
  const heldOff = new Map()
  // what this frame draws from: whether the launches are read, and whether a read of them failed
  let launchesRead = false
  let checking = false
  let sessionsUnread = false
  let home = null // the one home folder every chat folder shares, shown as ~
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
  // `passive`: nobody pressed for this (a read on entering Find, main's answer, a timer); `reset`: a
  // deliberate change of what the Chats chip lists (the tool toggle, Show all)
  const notify = ({ passive = false, reset = false } = {}) => {
    version += 1
    changed({ passive, reset })
  }

  function button(className, text, onClick) {
    const el = make('button', className, text)
    el.type = 'button'
    el.addEventListener('click', onClick)
    return el
  }

  const bridgeOf = () => {
    const bridge = resume()
    return bridge && typeof bridge.resumeAvailable === 'function' ? bridge : null
  }
  const canResume = () => resumeAnswer?.available === true
  const terminal = () => (resumeAnswer?.terminal === 'iterm2' ? 'iterm2' : 'terminal')

  // `keepNoted`: the read a refused Resume or a failed Jump asks for, which keeps a chat that left
  // the list for as long as its note is shown; any other read drops them
  async function read({ passive = false, reset = false, quiet = false, keepNoted = false } = {}) {
    const mine = ++seq
    if (keepJumpNotes) keepJumpNotes = false
    else jumpNotes.clear()
    loading = true
    // entering Find paints its own frame at once: the read's start then needs none of its own
    if (quiet) version += 1
    else notify({ passive, reset })
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
      const there = new Set(next.chats.map((chat) => `${chat.tool}:${chat.id}`))
      const before = [...(body?.chats ?? []), ...departed.values()]
      departed.clear()
      for (const chat of before) {
        const key = `${chat.tool}:${chat.id}`
        if (there.has(key)) continue
        if (keepNoted && (resumeNotes.has(key) || jumpNotes.has(key))) departed.set(key, chat)
      }
      body = next
      loadedAt = now()
      error = null
    } else {
      error = failed
    }
    notify({ passive })
  }

  async function copy(key, control) {
    const chat = chatByKey.get(key)
    if (!chat || control.getAttribute('aria-disabled') === 'true') return
    const { command } = resumeControl(chat)
    if (!command) return
    const copied = await writeClipboard(doc, command).catch(() => false)
    // a frame never writes this label, so a poll cannot cut "Copied" short
    control.textContent = copied ? 'Copied' : 'Copy failed'
    win.clearTimeout(Number(control.dataset.confirmTimer))
    control.dataset.confirmTimer = String(win.setTimeout(() => { control.textContent = COPY_LABEL }, CONFIRM_MS))
  }

  function askResume() {
    const mine = ++askSeq
    const bridge = bridgeOf()
    const settle = (answer) => {
      if (mine !== askSeq) return
      const next = { available: answer?.available === true, terminal: answer?.terminal === 'iterm2' ? 'iterm2' : 'terminal' }
      if (resumeAnswer && next.available === resumeAnswer.available && next.terminal === resumeAnswer.terminal) return
      resumeAnswer = next
      notify({ passive: true })
    }
    if (!bridge) {
      resumeAnswer = { available: false, terminal: 'terminal' }
      return
    }
    Promise.resolve().then(() => bridge.resumeAvailable()).then(settle, () => settle(null))
  }

  async function resumeChat(key) {
    const chat = chatByKey.get(key)
    const bridge = bridgeOf()
    if (!chat || !bridge || !canResume() || resumeBusy.has(key) || !resumeTerminalControl(chat, terminal()).enabled) return
    // a chat driven here, or one not yet known not to be, is never opened in a terminal too (§3.5)
    if (heldOff.has(key)) return
    resumeBusy.add(key)
    win.clearTimeout(resumeTimers.get(key))
    resumeTimers.delete(key)
    resumeConfirm.delete(key)
    resumeNotes.delete(key)
    jumpNotes.delete(key)
    notify()
    let result = null
    try {
      result = await bridge.resume({ tool: chat.tool, id: chat.id })
    } catch {
      result = null
    }
    resumeBusy.delete(key)
    const outcome = resumeOutcome(result)
    if (outcome.note) {
      resumeNotes.set(key, outcome.note)
      // pressed on a collapsed row, the answer opens it so the note is seen
      reveal(key)
    }
    if (outcome.label) {
      resumeConfirm.set(key, outcome.label)
      resumeTimers.set(key, win.setTimeout(() => {
        resumeTimers.delete(key)
        resumeConfirm.delete(key)
        notify({ passive: true })
      }, CONFIRM_MS))
    }
    // after live, folder, missing or opened the list is read again, so the row's off state catches up
    if (outcome.refresh) read({ keepNoted: true })
    else notify()
  }

  function setDriveAvailable(available) {
    if (available === canDrive) return
    canDrive = available
    notify({ passive: true })
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
      returnFocus: () => rowEl(key)?.querySelector('.chats-continue, .chats-show') ?? null,
      answered: (result) => {
        const outcome = continueOutcome(result)
        if (outcome.note) {
          resumeNotes.set(key, outcome.note)
          reveal(key)
        } else resumeNotes.delete(key)
        if (outcome.refresh) read()
        else notify()
      },
    })
    if (opened && resumeNotes.delete(key)) notify()
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
    if (jumpNotes.delete(key)) notify()
    const gone = () => {
      jumpNotes.set(key, JUMP_GONE_TEXT)
      keepJumpNotes = true
      reveal(key)
      read({ keepNoted: true })
    }
    Promise.resolve().then(() => jump(view.session)).then((went) => { if (went !== true) gone() }, gone)
  }

  // ── what a frame draws ───────────────────────────────────────────────────

  /** Called once at the start of each Find frame: the chats and their launches, as of now. */
  const departedChats = () => [...departed].filter(([key]) => resumeNotes.has(key) || jumpNotes.has(key)).map(([, chat]) => chat)

  function beginPaint() {
    const chats = body ? [...body.chats, ...departedChats()] : []
    home = inferHome(chats)
    chatByKey.clear()
    drivenByKey.clear()
    heldOff.clear()
    // #586 phase 2: what Continue here… and Show session are drawn from, the last list read while
    // this window may continue chats. None yet (no grant, or the launches not read yet) draws
    // neither; with the grant, Copilot rows then keep Copy resume and Resume off until it lands.
    const bridge = driving()
    const held = bridge?.launches()
    if (!bridge) lastLaunches = null
    else if (Array.isArray(held)) lastLaunches = held
    launchesRead = lastLaunches !== null
    checking = Boolean(bridge) && !launchesRead
    // said once on the Chats line, only after the list's own read finished and a launches read failed
    sessionsUnread = checking && !loading && (body !== null || error !== null) && bridge.launchesFailed?.() === true
    for (const chat of chats) {
      const key = `${chat.tool}:${chat.id}`
      chatByKey.set(key, chat)
      const driven = launchesRead && chat.tool === 'copilot' ? drivenView(chatLaunch(lastLaunches, chat.id)) : NOT_DRIVEN
      drivenByKey.set(key, driven)
      // beside Show session nothing is copied or opened: a second Copilot would open on a chat
      // driven here; nor before the launches are first read, when that is not known yet
      const offTitle = driven.show ? driven.offTitle : checking && chat.tool === 'copilot' ? CHECKING_TEXT : null
      if (offTitle) heldOff.set(key, offTitle)
    }
  }

  // What the slot beside a row's main button holds: Show session for a chat a launch here holds;
  // else Resume wherever the desktop app's bridge exists; else Copy resume.
  const slotKind = (key) => (drivenByKey.get(key)?.show ? 'show' : bridgeOf() ? 'resume' : 'copy')

  function paintCopy(control, key) {
    const chat = chatByKey.get(key)
    const offTitle = heldOff.get(key) ?? null
    const view = resumeControl(chat)
    setAttr(control, 'title', offTitle ?? view.title)
    setAttr(control, 'aria-disabled', view.command && !offTitle ? null : 'true')
  }

  function paintResume(control, key) {
    const chat = chatByKey.get(key)
    const offTitle = heldOff.get(key) ?? null
    const view = !resumeAnswer ? { enabled: false, title: RESUME_CHECKING, ariaLabel: null }
      : !resumeAnswer.available ? { enabled: false, title: RESUME_UNAVAILABLE, ariaLabel: null }
        : offTitle ? { enabled: false, title: offTitle, ariaLabel: null }
          : resumeTerminalControl(chat, terminal())
    const busy = resumeBusy.has(key)
    const confirm = resumeConfirm.get(key) ?? null
    setText(control, busy ? RESUME_BUSY_LABEL : confirm ?? RESUME_LABEL)
    setAttr(control, 'title', view.title)
    // aria-disabled, not disabled: a focused control that becomes disabled drops focus to the page
    setAttr(control, 'aria-disabled', busy || !view.enabled ? 'true' : null)
    // off while the label says what happened, so "Opening…" and "Opened in …" are what is announced
    setAttr(control, 'aria-label', busy || confirm ? null : view.ariaLabel)
  }

  function slotControl(kind, key) {
    if (kind === 'show') return button('chats-show', SHOW_SESSION_LABEL, () => showSession(key))
    if (kind === 'resume') return button('chats-resume', RESUME_LABEL, () => resumeChat(key))
    // no aria-label: the visible text is the name, so "Copied" and "Copy failed" reach a screen reader
    const control = button('chats-copy', COPY_LABEL, () => copy(key, control))
    return control
  }

  /** Paints the one action slot beside a chat row's main button. Its width is the CSS's, fixed. */
  function paintSlot(slot, key) {
    if (!chatByKey.has(key)) {
      slot.replaceChildren()
      return
    }
    const kind = slotKind(key)
    let control = slot.firstElementChild
    if (!control || control.dataset.chatsSlot !== kind) {
      const focused = Boolean(control) && doc.activeElement === control
      control = slotControl(kind, key)
      control.dataset.chatsSlot = kind
      slot.replaceChildren(control)
      // a launch that starts or ends swaps Resume and Show session: a keyboard user stays in the slot
      if (focused) control.focus({ preventScroll: true })
    }
    if (kind === 'show') setAttr(control, 'title', drivenByKey.get(key).title)
    else if (kind === 'resume') paintResume(control, key)
    else paintCopy(control, key)
  }

  function fact(facts, label, className) {
    const dt = make('dt', '', label)
    const dd = make('dd', className)
    facts.append(dt, dd)
    return dd
  }

  function buildBody(el, key) {
    el.replaceChildren()
    el.dataset.chatKey = key
    const facts = make('dl', 'chats-facts')
    fact(facts, 'Tool', 'chats-tool')
    const branch = fact(facts, 'Branch', 'chats-branch')
    branch.append(make('span', 'chats-branch-text'), make('span', 'chats-pr'))
    fact(facts, 'Folder', 'chats-folder')
    fact(facts, 'Last active', 'chats-active')
    fact(facts, 'Live', 'chats-live')
    fact(facts, 'Hidden', 'chats-reasons')
    const actions = make('div', 'chats-actions')
    el.append(facts, actions)
  }

  const showFact = (dd, shown) => {
    setHidden(dd, !shown)
    setHidden(dd.previousElementSibling, !shown)
  }

  // Jump to session after Copy resume on a live chat whose process has a session card. A chat a
  // session here holds has Show session for that, and while this window does not yet know whether
  // one does (a Copilot chat before the launches are read) it draws neither. Returns the control.
  function paintJump(actions, key, chat, driven) {
    const unsure = checking && chat.tool === 'copilot'
    const view = jump && !driven.show && !unsure ? jumpControl(chat) : null
    let control = actions.querySelector('.chats-jump')
    if (!view) {
      if (control) {
        // focus never falls to the page when its control goes: it moves to the row's Copy resume
        const focused = doc.activeElement === control
        control.remove()
        if (focused) rowEl(key)?.querySelector('.chats-copy')?.focus({ preventScroll: true })
      }
      return null
    }
    if (!control) control = button('chats-jump', JUMP_LABEL, () => jumpChat(key))
    setAttr(control, 'title', view.title)
    return control
  }

  // #586 phase 2: Continue here… on a Copilot row; none unless this window may continue chats, and
  // none beside Show session (the slot holds that). Returns the control.
  function paintContinue(actions, key, chat, driven, allowed) {
    const view = allowed && !driven.show ? continueControl(chat) : null
    let control = actions.querySelector('.chats-continue')
    if (!view) {
      control?.remove()
      return null
    }
    if (!control) {
      control = button('chats-continue', CONTINUE_LABEL, () => continueChat(key))
      // the dialog it opens is modal
      control.setAttribute('aria-haspopup', 'dialog')
    }
    setAttr(control, 'title', view.title)
    setAttr(control, 'aria-disabled', view.enabled ? null : 'true')
    return control
  }

  /** Paints an open chat row's body: its facts, then the Chats page's controls the slot does not hold, then its note. */
  function paintBody(el, key, nowMs) {
    const chat = chatByKey.get(key)
    if (!chat) return
    if (el.dataset.chatKey !== key) buildBody(el, key)
    const facts = el.querySelector('.chats-facts')
    const [, tool, , branchCell, , folder, , active, , live, , reasons] = facts.children
    setText(tool, toolLabel(chat.tool))
    setText(branchCell.querySelector('.chats-branch-text'), chat.branch ?? '')
    const pr = branchCell.querySelector('.chats-pr')
    const prUrl = chat.pr?.url ?? ''
    if (pr.dataset.prUrl !== prUrl) {
      pr.dataset.prUrl = prUrl
      const ref = prUrl ? githubRef(prUrl) : null
      // the product's one href builder, and only for a github.com pull request page
      pr.innerHTML = ref?.kind === 'pr' ? textLinkHtml(prUrl, `#${ref.number}`, 'pr') : ''
    }
    showFact(branchCell, Boolean(chat.branch) || pr.childElementCount > 0)
    setText(folder, displayFolder(chat.cwd, home) || '—')
    setAttr(folder, 'title', chat.cwd ?? 'No folder recorded')
    // the exact local time ("No activity recorded" without one), with how long ago as its title
    const when = lastActiveView(chat.lastActiveAt, nowMs)
    setText(active, when.title)
    setAttr(active, 'title', when.text === '—' ? null : when.text)
    // Live from the index, or "Live · here" while a launch of this app runs the chat (§3.5)
    const driven = drivenByKey.get(key) ?? NOT_DRIVEN
    const showLive = chat.live || driven.here
    let chip = live.querySelector('.chats-live')
    if (showLive && !chip) live.prepend((chip = make('span', 'chip chats-live', 'Live')))
    if (!showLive && chip) chip.remove()
    let here = live.querySelector('.chats-here')
    if (driven.here && !here) {
      here = make('span', 'chats-here', HERE_TEXT)
      here.title = driven.hereTitle
      live.append(here)
    }
    if (!driven.here && here) here.remove()
    showFact(live, showLive)
    // Show all's reasons, as neutral chips
    const reasonKey = chat.hidden.join(' ')
    if (reasons.dataset.reasons !== reasonKey) {
      reasons.dataset.reasons = reasonKey
      reasons.replaceChildren(...chat.hidden.map((reason) => make('span', 'chip chip-neutral chats-reason', hiddenLabel(reason))))
    }
    showFact(reasons, chat.hidden.length > 0)

    const actions = el.querySelector('.chats-actions')
    // Copy resume, unless the slot holds it
    let copyControl = actions.querySelector('.chats-copy')
    if (slotKind(key) === 'copy') {
      copyControl?.remove()
      copyControl = null
    } else {
      if (!copyControl) copyControl = button('chats-copy', COPY_LABEL, () => copy(key, copyControl))
      paintCopy(copyControl, key)
    }
    const allowed = launchesRead
    // a live Copilot chat's Continue here… could only be off: Jump to session takes its place
    const jumpButton = paintJump(actions, key, chat, driven)
    const continueButton = paintContinue(actions, key, chat, driven, allowed && !jumpButton)
    // the note: Resume's, Continue here…'s or a failed jump's. A row that can get one has it from the
    // start, empty, so a screen reader hears it when it is filled.
    let note = actions.querySelector('.chats-resume-note')
    if (!bridgeOf() && !allowed && !jumpButton && !jumpNotes.has(key) && !resumeNotes.has(key)) {
      note?.remove()
      note = null
    } else {
      if (!note) {
        note = make('span', 'chats-resume-note')
        note.setAttribute('role', 'status')
      }
      setText(note, resumeNotes.get(key) ?? jumpNotes.get(key) ?? '')
    }
    // the Chats page's order: Copy resume, then Jump to session or Continue here…, then the note.
    // Only a new node is inserted: one already in place never moves, so focus stays on it.
    const order = [copyControl, jumpButton, continueButton, note].filter(Boolean)
    order.forEach((node, index) => {
      if (actions.children[index] !== node) actions.insertBefore(node, actions.children[index] ?? null)
    })
    setHidden(actions, order.length === 0)
  }

  // ── the Chats line under the chips, and the failure line at the list's foot ─────────────────

  function buildBar(root) {
    const tools = make('div', 'queue-filter-group chats-tools')
    tools.setAttribute('role', 'group')
    tools.setAttribute('aria-label', 'Tool')
    for (const [value, label] of TOOL_FILTERS) {
      const toggle = button('header-toggle', label, () => {
        if (filter.tool === value) return
        filter.tool = value
        notify({ reset: true })
      })
      toggle.dataset.chatsTool = value
      tools.append(toggle)
    }
    const all = make('label', 'header-switch chats-all')
    const allInput = make('input')
    allInput.type = 'checkbox'
    allInput.setAttribute('role', 'switch')
    allInput.addEventListener('change', () => {
      showAll = allInput.checked
      read({ reset: true })
    })
    all.append(allInput, make('span', 'chats-all-label', 'Show all'))
    const refresh = button('header-toggle chats-refresh', 'Refresh', () => {
      if (!loading) read()
    })
    const controls = make('div', 'chats-header')
    controls.append(tools, all, refresh)
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
    const state = make('p', 'empty chats-state')
    root.replaceChildren(controls, retention, truncated, errorBox, state)
    return { root, tools, allInput, allLabel: all.querySelector('.chats-all-label'), refresh, retention, truncated, errorBox, errorText, state }
  }

  const errorWords = () => {
    const status = error?.status ? ` (${error.status})` : ''
    return body ? `Couldn't refresh chats${status}. Showing the last list.` : `Couldn't load chats${status}.`
  }

  // made only when needed, so a window that may not continue chats draws none of it
  function paintSessionsNote(show) {
    let note = bar.root.querySelector('.chats-sessions')
    if (!show) {
      note?.remove()
      return
    }
    if (!note) {
      note = make('p', 'chats-note chats-sessions', SESSIONS_UNREAD_TEXT)
      note.setAttribute('role', 'status')
      bar.root.insertBefore(note, bar.state)
    }
  }

  /** Paints the line under the chips, drawn while the Chats chip is selected. `shown`: the chat rows listed. */
  function paintBar(root, { shown = 0 } = {}) {
    if (!bar || bar.root !== root) bar = buildBar(root)
    for (const toggle of bar.tools.children) {
      const on = toggle.dataset.chatsTool === filter.tool
      toggle.classList.toggle('active', on)
      setAttr(toggle, 'aria-pressed', String(on))
    }
    if (bar.allInput.checked !== showAll) bar.allInput.checked = showAll
    setText(bar.allLabel, allSwitchText(body?.counts ?? null))
    setText(bar.refresh, loading ? 'Refreshing…' : 'Refresh')
    // aria-disabled, not disabled: a focused control that becomes disabled drops focus to the page
    setAttr(bar.refresh, 'aria-disabled', loading ? 'true' : null)
    setText(bar.retention, retentionText(body?.claudeDays ?? 30))
    setHidden(bar.retention, !body)
    setHidden(bar.truncated, !body?.truncated)
    setHidden(bar.errorBox, !error)
    if (error) setText(bar.errorText, errorWords())
    paintSessionsNote(sessionsUnread)
    const stateText = body
      ? emptyText({ loaded: body.chats.length, shown, hidden: body.counts.hidden, all: showAll })
      : loading ? 'Loading chats…' : null
    setText(bar.state, stateText ?? '')
    setHidden(bar.state, stateText === null)
  }

  /** Paints the failure line at the list's foot (All with a query), or empties it. */
  function paintFoot(root, show) {
    if (!foot || foot.root !== root) {
      const line = make('div', 'chats-error find-chats-fail')
      line.setAttribute('role', 'status')
      const text = make('span')
      const retry = button('header-toggle chats-retry', 'Retry', () => {
        if (!loading) read()
      })
      line.append(text, ' ', retry)
      root.replaceChildren(line)
      foot = { root, text, retry }
    }
    // the first read still in flight is said here too: with no chats listed yet, an empty list
    // under a query is not "Nothing matches", and the foot is the line that speaks for them
    const reading = !body && !error && loading
    const visible = show && (Boolean(error) || reading)
    if (visible) setText(foot.text, error ? errorWords() : 'Loading chats…')
    setHidden(foot.retry, !error)
    foot.root.firstElementChild.classList.toggle('chats-reading', !error)
    setHidden(root, !visible)
  }

  return {
    /** Find was entered from elsewhere (or from Settings): ask the bridges again, and read when nothing is loaded or the list is stale. */
    opened() {
      askResume()
      askDrive()
      if (shouldFetchOnOpen({ loadedAt, loading, nowMs: now() })) read({ passive: true, quiet: true })
    },
    /** The list as last read, plus a chat that left it while its refusal note shows; null before any read. */
    list: () => (body ? [...body.chats, ...departedChats()] : null),
    /** The Chats line's tool toggle. */
    tool: () => filter.tool,
    /** Whether the last read failed. */
    failed: () => error !== null,
    /** Whether a read is in flight. */
    loading: () => loading,
    /** Whether a chat (`<tool>:<id>`) is live: in the index, or run by a launch of this app (§3.5). */
    live: (key) => chatByKey.get(key)?.live === true || drivenByKey.get(key)?.here === true,
    beginPaint,
    paintSlot,
    paintBody,
    paintBar,
    paintFoot,
    /** Changes with every read, settle and control change, for the poll's frameInputs(). */
    state: () => String(version),
  }
}
