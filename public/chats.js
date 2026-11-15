// public/chats.js
// The Chats tab's pure model (#586 PR 2): reading the /api/chats body, the sort,
// search and filters, the home folder shown as ~, the labels, the fetch rule and
// the resume command, and (PR 3) the Resume in Terminal control and its outcome.
// No DOM, clock or fetch; public/chats-view.js paints it.
// Every chat string here is untrusted text: the view sets it as textContent only.

import { terminalName } from './launches.js'
import { relMs } from './rowview.js'

export const CHATS_HASH = '#chats'
const STALE_MS = 60_000
const DEFAULT_CLAUDE_DAYS = 30
// the index's own id rule: a lowercase UUID (docs/architecture/chats.md)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// C0, DEL, C1 and the two Unicode line breaks: any of them could end a shell line
const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const HOME = /^\/(?:Users|home)\/[^/]+/
const TOOLS = { claude: 'Claude Code', copilot: 'Copilot' }
const HIDDEN = { temp: 'Temp folder', 'non-interactive': 'Non-interactive', empty: 'Empty', 'folder-gone': 'Folder gone' }
const AUTO_TITLE = "Copilot's automatic name: the opening of the chat's first prompt"
const LIVE_WARNING = 'This chat is live in another process; resuming it opens a second copy.'
const RESUME_LIVE = 'This chat is live in another process, so it is not resumed a second time.'
const RESUME_FAILED = 'Could not resume this chat.'
// main's refusals after which the list is read again, so the row's off state catches up
const RESUME_REFRESH = new Set(['live', 'folder', 'missing', 'opened'])

export const RESUME_LABEL = 'Resume'
export const RESUME_BUSY_LABEL = 'Opening…'

/** Whether a location hash is the Chats tab's deep link. */
export function isChatsHash(hash) {
  return hash === CHATS_HASH || hash === 'chats'
}

export function chatsUrl(all) {
  return all ? '/api/chats?all=1' : '/api/chats'
}

const str = (value) => (typeof value === 'string' ? value : null)
// A transcript in a folder that is not a repository, or on a detached checkout, records the
// branch as HEAD: that names no branch, so the list shows none.
const branchOf = (value) => (typeof value === 'string' && value !== 'HEAD' ? value : null)
const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0)

function readPr(pr) {
  if (!pr || typeof pr !== 'object' || typeof pr.url !== 'string') return null
  return { number: Number(pr.number) || 0, repo: String(pr.repo ?? ''), url: pr.url }
}

function readChat(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.tool !== 'string') return null
  return {
    id: entry.id,
    tool: entry.tool,
    title: str(entry.title),
    titleAuto: entry.titleAuto === true,
    project: str(entry.project) ?? '',
    cwd: str(entry.cwd),
    branch: branchOf(entry.branch),
    createdAt: str(entry.createdAt),
    lastActiveAt: str(entry.lastActiveAt),
    live: entry.live === true,
    pr: readPr(entry.pr),
    hidden: Array.isArray(entry.hidden) ? entry.hidden.filter((r) => typeof r === 'string') : [],
  }
}

/** The /api/chats body, with malformed entries dropped; null when it is not a list at all. */
export function readChatsBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.chats)) return null
  const chats = body.chats.map(readChat).filter(Boolean)
  const c = body.counts && typeof body.counts === 'object' ? body.counts : {}
  const days = body.retention?.claudeDays
  return {
    chats,
    counts: {
      total: count(c.total), hidden: count(c.hidden), claude: count(c.claude), copilot: count(c.copilot), live: count(c.live),
    },
    truncated: body.truncated === true,
    claudeDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_CLAUDE_DAYS,
  }
}

const activeMs = (chat) => {
  const ms = chat.lastActiveAt ? Date.parse(chat.lastActiveAt) : NaN
  return Number.isFinite(ms) ? ms : null
}
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Last active, newest first; no time last; then by id and tool. A new array. */
export function sortChats(chats) {
  return [...chats].sort((a, b) => {
    const am = activeMs(a)
    const bm = activeMs(b)
    if (am !== bm) {
      if (am === null) return 1
      if (bm === null) return -1
      return bm - am
    }
    return byText(a.id, b.id) || byText(a.tool, b.tool)
  })
}

/** The one /Users/<name> or /home/<name> every chat folder under a home shares, else null. */
export function inferHome(chats) {
  const homes = new Set()
  for (const chat of chats) {
    const match = chat.cwd ? HOME.exec(chat.cwd) : null
    if (match && match[0] !== '/Users/Shared') homes.add(match[0])
  }
  return homes.size === 1 ? [...homes][0] : null
}

/** A folder as shown: the home folder as ~, '' for none. */
export function displayFolder(cwd, home) {
  if (!cwd) return ''
  if (home && cwd === home) return '~'
  if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`
  return cwd
}

/** The chats that match the search (title, project, branch, folder) and both filters. */
export function filterChats(chats, filter, home) {
  const query = String(filter.query ?? '').trim().toLowerCase()
  return chats.filter((chat) => {
    if (filter.tool !== 'all' && chat.tool !== filter.tool) return false
    if (filter.project !== null && chat.project !== filter.project) return false
    if (!query) return true
    return [chat.title, chat.project, chat.branch, chat.cwd, displayFolder(chat.cwd, home)]
      .some((field) => typeof field === 'string' && field.toLowerCase().includes(query))
  })
}

/** The projects present in the list, once each, sorted. */
export function projectOptions(chats) {
  return [...new Set(chats.map((chat) => chat.project))].sort((a, b) => a.localeCompare(b))
}

/**
 * The command that resumes a chat in its folder, or null when the id is not a
 * UUID or the folder is not a plain absolute path. The folder is single-quoted
 * for a POSIX shell, each embedded ' written as '\'' (close, escaped quote, reopen),
 * so nothing inside it is expanded.
 */
export function resumeCommand(chat) {
  const { id, tool, cwd } = chat
  if (typeof id !== 'string' || !UUID.test(id)) return null
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || UNSAFE_PATH.test(cwd)) return null
  const folder = `'${cwd.replaceAll("'", "'\\''")}'`
  if (tool === 'claude') return `cd ${folder} && claude --resume ${id}`
  if (tool === 'copilot') return `cd ${folder} && copilot --resume=${id}`
  return null
}

/**
 * The Copy control: the command, or null with the reason it is unavailable. A live
 * chat still copies; its warning is the title's second line, so the first line is
 * always exactly what is copied.
 */
export function resumeControl(chat) {
  // the index marks a missing cwd folder-gone too, so the missing folder is asked first
  if (!chat.cwd) return { command: null, title: "The chat's files name no folder to resume in." }
  if (chat.hidden.includes('folder-gone')) return { command: null, title: "The chat's folder no longer exists, so it cannot be resumed there." }
  const command = resumeCommand(chat)
  if (!command) return { command: null, title: "This chat's id or folder can't be made into a safe command." }
  return { command, title: chat.live ? `${command}\n${LIVE_WARNING}` : command }
}

/**
 * The Resume in Terminal control (desktop app only): off, with the reason in its
 * title, for a live chat (#586: never resumed a second time) and wherever Copy
 * resume is off. Its title names the app; the aria-label does too for iTerm2,
 * because the visible label stays the generic word (the terminal setting's rule).
 */
export function resumeTerminalControl(chat, terminal) {
  if (chat.live) return { enabled: false, title: RESUME_LIVE, ariaLabel: null }
  const copy = resumeControl(chat)
  if (!copy.command) return { enabled: false, title: copy.title, ariaLabel: null }
  const name = terminalName(terminal)
  const title = `Resume in ${name}`
  return { enabled: true, title, ariaLabel: name === 'Terminal' ? null : title }
}

/**
 * What the row shows after main answered: the button's confirmation label
 * ("Opened in iTerm2"), the note under it (the fallback notice or main's reason),
 * and whether to read the list again.
 */
export function resumeOutcome(result) {
  if (result?.ok === true) {
    const notice = typeof result.notice === 'string' && result.notice ? result.notice : null
    return { label: `Opened in ${terminalName(result.terminal)}`, note: notice, refresh: false }
  }
  const error = typeof result?.error === 'string' && result.error ? result.error : RESUME_FAILED
  return { label: null, note: error, refresh: RESUME_REFRESH.has(result?.reason) }
}

export function toolLabel(tool) {
  return Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : String(tool)
}

export function hiddenLabel(reason) {
  return Object.hasOwn(HIDDEN, reason) ? HIDDEN[reason] : String(reason)
}

/** A title as shown: Copilot's automatic name and a missing title are quiet. */
export function titleView(chat) {
  if (chat.title === null || chat.title === '') return { text: 'Untitled', quiet: true, title: null }
  if (chat.titleAuto) return { text: chat.title, quiet: true, title: AUTO_TITLE }
  return { text: chat.title, quiet: false, title: null }
}

/** Last active as relative text, with the exact local time for its title. */
export function lastActiveView(iso, nowMs) {
  const ms = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ms)) return { text: '—', title: 'No activity recorded' }
  const age = nowMs - ms
  return { text: age < 60_000 ? 'just now' : `${relMs(age)} ago`, title: new Date(ms).toLocaleString() }
}

const number = (n) => n.toLocaleString('en-US')
const chatsWord = (n) => `${number(n)} chat${n === 1 ? '' : 's'}`

/** The shown-rows line under the header. */
export function shownText(shown, loaded) {
  return shown === loaded ? chatsWord(loaded) : `Showing ${number(shown)} of ${chatsWord(loaded)}`
}

/** The Show all switch's label, with how many chats the default list leaves out. */
export function allSwitchText(counts) {
  return counts && counts.hidden > 0 ? `Show all (${number(counts.hidden)} hidden)` : 'Show all'
}

/** The empty state for a loaded list, or null when rows show. */
export function emptyText({ loaded, shown, hidden, all }) {
  if (loaded === 0) {
    if (all || hidden === 0) return 'No chats found.'
    return `No chats found. ${number(hidden)} hidden chat${hidden === 1 ? '' : 's'}: turn on Show all.`
  }
  return shown === 0 ? 'No chats match the search and filters.' : null
}

export function retentionText(claudeDays) {
  return `Claude Code deletes chats that have been untouched for ${number(claudeDays)} days. Agent Inbox does not copy them.`
}

export const TRUNCATED_TEXT = 'This list is incomplete: the chat index stopped at a scan limit.'

/** Opening the tab reads the list when none is loaded, or the last one is over a minute old. */
export function shouldFetchOnOpen({ loadedAt, loading, nowMs }) {
  return !loading && (loadedAt === null || nowMs - loadedAt > STALE_MS)
}
