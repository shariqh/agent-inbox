'use strict'
// Terminal of choice (#586): which terminal app Open in Terminal and Take over /
// Resume in Terminal open on macOS. One place maps (terminal, kind, absolute
// path) to the command to run: argv only, never a shell string, and the app is
// named by bundle id, never by a display name.
//
// Both kinds go to `/usr/bin/open -b <bundle id> -- <path>`. For a folder, each
// app opens a new session there. For the Take over script (a 0700
// .command file), Terminal runs it; iTerm2's own openFile handler asks "OK to
// run <path>?" first (an advanced setting can silence it) and then types the
// path into a login shell, in a new tab unless its settings say otherwise. No
// AppleScript: the shipped app has no Apple Events entitlement, so an
// `osascript` child would be refused or prompt for Automation.
//
// The setting comes from the renderer, so it is checked against the fixed list
// on every use; anything else, or nothing, means Terminal.
const path = require('node:path')

const TERMINAL_IDS = Object.freeze(['terminal', 'iterm2'])
const TERMINALS = Object.freeze({
  terminal: Object.freeze({ name: 'Terminal', bundleId: 'com.apple.Terminal' }),
  iterm2: Object.freeze({ name: 'iTerm2', bundleId: 'com.googlecode.iterm2' }),
})
const KINDS = new Set(['folder', 'script'])
const CONTROL = /[\u0000-\u001f\u007f]/

// the id a setting value names, from the fixed list only
function terminalId(value) {
  return typeof value === 'string' && Object.hasOwn(TERMINALS, value) ? value : 'terminal'
}

const terminalName = (value) => TERMINALS[terminalId(value)].name

// null unless the kind is known and the target is an absolute path with no control characters
function terminalCommand(terminal, kind, target) {
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null
  if (typeof target !== 'string' || !path.posix.isAbsolute(target) || CONTROL.test(target)) return null
  return { file: '/usr/bin/open', args: ['-b', TERMINALS[terminalId(terminal)].bundleId, '--', target] }
}

// What a runner reports for an `open` that ended with `error` (an execFile
// callback's, or null). `open` exits on its own (a number) when the app is not
// installed; a kill by the runner's timeout says nothing about the app and
// iTerm2 may still open late, so only the first allows a fallback (#586 review).
function runOutcome(error) {
  if (!error) return { ok: true }
  if (error.killed === true || error.signal) return { ok: false, timedOut: true }
  return typeof error.code === 'number' ? { ok: false, missing: true } : { ok: false }
}

async function attempt(run, command) {
  try {
    const outcome = await run(command)
    const ok = outcome?.ok === true
    return { ok, missing: !ok && outcome?.missing === true, timedOut: !ok && outcome?.timedOut === true }
  } catch {
    return { ok: false, missing: false, timedOut: false }
  }
}

// Opens `target` in the chosen terminal. The one fallback, to Terminal, happens
// only when the chosen app could not be found: after a timeout it may still
// open, and a second terminal on a take-over script would run two Copilots in
// one session.
async function openInTerminal({ terminal, kind, target, run }) {
  const chosen = terminalId(terminal)
  const command = terminalCommand(chosen, kind, target)
  if (!command) return { ok: false, used: chosen, fellBackFrom: null, timedOut: false }
  const first = await attempt(run, command)
  if (first.ok) return { ok: true, used: chosen, fellBackFrom: null, timedOut: false }
  if (chosen === 'terminal' || !first.missing) return { ok: false, used: chosen, fellBackFrom: null, timedOut: first.timedOut }
  const second = await attempt(run, terminalCommand('terminal', kind, target))
  return { ok: second.ok, used: 'terminal', fellBackFrom: chosen, timedOut: second.timedOut }
}

module.exports = { TERMINAL_IDS, TERMINALS, openInTerminal, runOutcome, terminalCommand, terminalId, terminalName }
