'use strict'
// Resume a chat in Terminal (#586 PR 3, docs/architecture/chats.md "Resume in
// Terminal"). The page sends { tool, id } and nothing else; main looks the chat
// up in the index through the viewer's own GET /api/chats (then ?all=1), takes the
// folder from there, refuses a live chat or a folder that is gone, writes a
// fresh 0700 script that cds there and execs the tool's own resume command, and
// opens it with openInTerminal. It is the person opening their own terminal, so
// it needs no driven-sessions switch (#412) and shows no dialog.
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { openInTerminal, terminalId, terminalName } = require('./terminal-launch.cjs')

// the index's own id rule: a lowercase UUID (docs/architecture/chats.md)
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CHAT_TOOLS = Object.freeze(['claude', 'copilot'])
// C0, DEL, C1 and the two Unicode line breaks: any of them could end a shell line (as public/chats.js)
const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
// iTerm2's "OK to run?" may sit open for a while, so an old script is kept a day
const SCRIPT_KEEP_MS = 24 * 60 * 60 * 1000
// A chat reads as live only once its tool has started (and, in iTerm2, once the
// person said OK), so a second Resume of the same chat is refused for this long.
const REOPEN_MS = 2 * 60 * 1000
const CHAT_ROUTES = Object.freeze(['/api/chats', '/api/chats?all=1'])
const CHANNELS = Object.freeze({ available: 'agent-inbox:chat-resume-available', resume: 'agent-inbox:chat-resume' })
const SCRIPT_NAME = /^(?:claude|copilot)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{16}\.command$/

const ERRORS = Object.freeze({
  unavailable: 'Resume in Terminal works only in Agent Inbox’s own window on macOS.',
  invalid: 'This chat can’t be resumed.',
  quitting: 'Agent Inbox is quitting, so nothing was opened.',
  busy: 'Another chat is opening. Try again in a moment.',
  index: 'Agent Inbox could not read the chat list.',
  missing: 'This chat is no longer listed.',
  live: 'This chat is live in another process.',
  folder: 'Its folder no longer exists.',
  write: 'Agent Inbox could not write the Terminal script.',
})

const refused = (reason, error = ERRORS[reason]) => ({ ok: false, reason, error })
const isTool = (value) => typeof value === 'string' && CHAT_TOOLS.includes(value)
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The request's tool and id, read from a plain object and nothing else; null unless both check. */
function chatResumeRequest(value) {
  if (!isPlainObject(value)) return null
  const { tool, id } = value
  return isTool(tool) && typeof id === 'string' && CHAT_ID.test(id) ? { tool, id } : null
}

// A POSIX shell word: single-quoted, each ' written as '\'' (as resumeCommand in public/chats.js)
const shellWord = (text) => `'${text.replaceAll("'", "'\\''")}'`

/**
 * The whole script: cd to the folder, then exec the tool's own resume command,
 * the same command Copy resume copies. Null unless the tool is known, the id is
 * a lowercase UUID and the folder an absolute path with no control or line-break
 * character, so the id goes in only after its check and nothing in the folder is expanded.
 */
function chatResumeScript({ tool, id, cwd }) {
  if (!isTool(tool) || typeof id !== 'string' || !CHAT_ID.test(id)) return null
  if (typeof cwd !== 'string' || !path.posix.isAbsolute(cwd) || UNSAFE_PATH.test(cwd)) return null
  return [
    '#!/bin/sh',
    `# Agent Inbox: Resume a chat in Terminal (#586, ${tool} ${id.slice(0, 8)})`,
    `cd -- ${shellWord(cwd)} || exit 1`,
    tool === 'claude' ? `exec claude --resume ${id}` : `exec copilot --resume=${id}`,
    '',
  ].join('\n')
}

/** A fresh name per open, so a script a terminal is still about to run is never replaced. */
function scriptName(tool, id, random) {
  return `${tool}-${id}-${random}.command`
}

// Old scripts of ours only: lstat, so a link or a folder is never followed or removed.
function sweepScripts(dir, nowMs) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!SCRIPT_NAME.test(name)) continue
    const file = path.join(dir, name)
    try {
      const stat = fs.lstatSync(file)
      if (stat.isFile() && nowMs - stat.mtimeMs > SCRIPT_KEEP_MS) fs.unlinkSync(file)
    } catch {
      // gone meanwhile, or not ours to remove
    }
  }
}

/**
 * Writes `text` to a new file `name` in `dir` and returns its path, or null. The
 * folder is made 0700 and must be a real directory this user owns (a wider mode
 * is tightened); the file is created with O_EXCL and O_NOFOLLOW at 0700, so an
 * existing name or a link is never written through. Old scripts are swept first.
 */
function writeChatScript({ dir, name, text, now = Date.now }) {
  if (!path.isAbsolute(dir) || typeof name !== 'string' || !SCRIPT_NAME.test(name)) return null
  let fd = null
  const file = path.join(dir, name)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const folder = fs.lstatSync(dir)
    if (!folder.isDirectory() || folder.isSymbolicLink()) return null
    if (typeof process.getuid === 'function' && folder.uid !== process.getuid()) return null
    if ((folder.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700)
    sweepScripts(dir, now())
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
    fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o700)
    fs.fchmodSync(fd, 0o700)
    fs.writeFileSync(fd, text)
    fs.closeSync(fd)
    return file
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
      try { fs.unlinkSync(file) } catch { /* nothing to remove */ }
    }
    return null
  }
}

/**
 * Main's handler. Refusals, in order: unavailable (not macOS), invalid,
 * quitting, busy (one resume at a time), index, missing, live, opened (this
 * chat was opened moments ago), folder, invalid (the script cannot be built),
 * write, open.
 */
function createChatResume({
  platform, isQuitting, viewer, isDirectory, terminal, scriptDir,
  writeScript = (dir, name, text) => writeChatScript({ dir, name, text, now }),
  now = Date.now,
  random = () => randomBytes(8).toString('hex'),
}) {
  let inFlight = false
  const recent = new Map() // `${tool}:${id}` → { at, terminal }

  async function chosenTerminal() {
    try {
      return terminalId(await terminal.read())
    } catch {
      return 'terminal'
    }
  }

  async function resumeChecked({ tool, id }) {
    // The page's default list first, then ?all=1: each is cut at 2,000 after its
    // own filter, so a chat either view lists is found in one of them.
    let chat = null
    for (const route of CHAT_ROUTES) {
      const body = await Promise.resolve(viewer.getJson(route)).catch(() => null)
      if (!isPlainObject(body) || !Array.isArray(body.chats)) return refused('index')
      chat = body.chats.find((entry) => isPlainObject(entry) && entry.tool === tool && entry.id === id)
      if (chat) break
    }
    if (!chat) return refused('missing')
    if (chat.live === true) return refused('live')
    const key = `${tool}:${id}`
    const nowMs = now()
    for (const [k, seen] of recent) if (nowMs - seen.at >= REOPEN_MS) recent.delete(k)
    const last = recent.get(key)
    if (last) {
      return refused('opened', `This chat was opened in ${terminalName(last.terminal)} moments ago. If it did not open, try again in two minutes.`)
    }
    // the folder is the index's, never the page's
    const cwd = chat.cwd
    if (typeof cwd !== 'string' || !path.posix.isAbsolute(cwd)) return refused('folder')
    const text = chatResumeScript({ tool, id, cwd })
    if (!text) return refused('invalid')
    if (!isDirectory(cwd)) return refused('folder')
    const chosen = await chosenTerminal()
    const file = writeScript(scriptDir, scriptName(tool, id, random()), text)
    if (typeof file !== 'string') return refused('write')
    const opened = await openInTerminal({ terminal: chosen, kind: 'script', target: file, run: (command) => Promise.resolve(terminal.run(command)) })
    if (!opened.ok) {
      const what = opened.fellBackFrom ? `${terminalName(opened.fellBackFrom)} or Terminal` : terminalName(opened.used)
      return refused('open', `Could not open ${what}.`)
    }
    recent.set(key, { at: now(), terminal: opened.used })
    return opened.fellBackFrom
      ? { ok: true, terminal: opened.used, notice: `${terminalName(opened.fellBackFrom)} could not be opened, so Terminal was opened instead.` }
      : { ok: true, terminal: opened.used }
  }

  return {
    async available() {
      if (platform !== 'darwin') return { available: false, terminal: 'terminal' }
      return { available: true, terminal: await chosenTerminal() }
    },
    async resume(value) {
      if (platform !== 'darwin') return refused('unavailable')
      const request = chatResumeRequest(value)
      if (!request) return refused('invalid')
      if (isQuitting()) return refused('quitting')
      if (inFlight) return refused('busy')
      inFlight = true
      try {
        return await resumeChecked(request)
      } catch {
        return refused('open', 'Could not open the terminal.')
      } finally {
        inFlight = false
      }
    },
  }
}

/**
 * The two channels, on macOS only (elsewhere none is registered). Each takes an
 * exact number of arguments, waits for any re-proof of the window in flight
 * (#216) and answers only the owned viewer window, as launch-available and
 * Settings → Terminal do. `chatResume` is a function, so the handler is made on first use.
 */
function registerChatResumeIpc({ ipcMain, platform, settled, isOwned, chatResume }) {
  if (platform !== 'darwin') return
  ipcMain.handle(CHANNELS.available, async (event, ...args) => {
    const off = { available: false, terminal: 'terminal' }
    if (args.length !== 0) return off
    await settled()
    if (!isOwned(event)) return off
    return chatResume().available()
  })
  ipcMain.handle(CHANNELS.resume, async (event, ...args) => {
    if (args.length !== 1) return refused('invalid')
    await settled()
    if (!isOwned(event)) return refused('unavailable')
    return chatResume().resume(args[0])
  })
}

module.exports = {
  CHANNELS, CHAT_ID, CHAT_TOOLS, REOPEN_MS, SCRIPT_KEEP_MS,
  chatResumeRequest, chatResumeScript, createChatResume, registerChatResumeIpc, scriptName, writeChatScript,
}
