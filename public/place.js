// Where a session runs (#617, PR 1): the line a card and the session panel show, the
// claude.ai link, and the tmux command that attaches to the session. Pure, with no DOM,
// so every rule here tests on a plain row.
//
// A row's values were checked by the server before they were stored, and are checked
// AGAIN here, by the same patterns, before any of them becomes a link or a command: the
// page never builds either from text that is not a plain name. A value that fails is
// left out, never trimmed or cut to fit.

// The one definition of the four patterns, for the page and the server alike: src/session-place.ts
// (the writer) and src/store.ts (`listActivity`, which serves only a matching value) import them from
// here. This file is a plain module on purpose: the store runs under a bare `node` in tests that
// cannot resolve a `.js` import to a `.ts` file, and the stdio MCP server's graph stays pure
// (test/prstate.test.ts).
// machine and desk (a tmux session name). No accepted name starts with `-`, so none
// can read as an option where a command uses it.
export const PLACE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
// a tmux pane
export const PLACE_PANE = /^%[0-9]{1,6}$/
// a Claude Code Remote Control session id
export const PLACE_REMOTE_SESSION = /^session_[A-Za-z0-9]{1,64}$/

/** The value, only when it is a string that passes `pattern`. */
function checked(row, key, pattern) {
  const value = row !== null && typeof row === 'object' ? row[key] : undefined
  return typeof value === 'string' && pattern.test(value) ? value : ''
}

/** "machine · desk", "machine", or "" (a row an older server wrote has neither). */
export function placeLine(row) {
  const machine = checked(row, 'machine', PLACE_NAME)
  if (!machine) return ''
  const desk = checked(row, 'desk', PLACE_NAME)
  return desk ? `${machine} · ${desk}` : machine
}

/** https://claude.ai/code/<remote_session>, or "" unless the id passes its pattern. */
export function claudeSessionUrl(row) {
  const id = checked(row, 'remote_session', PLACE_REMOTE_SESSION)
  return id ? `https://claude.ai/code/${id}` : ''
}

/**
 * `tmux attach -t '=<desk>'`, or "". The `=` asks tmux for that exact name, so "api" never
 * attaches to "api2", and the quotes stop zsh reading a word that starts with `=` as a command path.
 */
export function attachCommand(row) {
  const desk = checked(row, 'desk', PLACE_NAME)
  return desk ? `tmux attach -t '=${desk}'` : ''
}
