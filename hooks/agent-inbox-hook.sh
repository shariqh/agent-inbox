#!/usr/bin/env bash
# agent-inbox hook wrapper — the portable entry point for users who cannot bake
# an absolute Node path into ~/.claude/settings.json. The installer's exec-form
# entry (scripts/install-hooks.sh) is preferred; this exists for hand-editors.
#
# Two rules this file exists to honour, both learned the hard way:
#   1. It must NOT redirect stdout — prompt-submit, session-start and stop all
#      write a meaningful payload there.
#   2. It must NOT redirect stderr either — for the asyncRewake `watch`
#      subcommand, stderr IS the message the model is woken with. Diagnostics
#      already go to ~/.agent-inbox/hook.log from inside Node.
# And it forwards the child's exit status (`exit $?`), because `watch` exits 2
# on purpose: swallowing that makes #21's async half a silent no-op.
#
# `set -u` only — never `set -e`: a hook must fail open.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Node 24 resolution. `better-sqlite3`'s binding is ABI-pinned; bare `node` on a
# Node 26 box dies on every invocation, silently, forever. `.node-version` is
# resolved relative to THIS script, not the cwd — the hook runs with the cwd set
# to the user's own project, where `cat .node-version` finds nothing (or worse,
# finds someone else's).
NODE=""
if [ -n "${AGENT_INBOX_NODE:-}" ] && [ -x "${AGENT_INBOX_NODE}" ]; then
  NODE="$AGENT_INBOX_NODE"
elif command -v fnm >/dev/null 2>&1 && [ -r "$ROOT/.node-version" ]; then
  NODE="$(fnm which "$(cat "$ROOT/.node-version")" 2>/dev/null || true)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  for candidate in "$HOME"/.local/share/fnm/node-versions/v24.*/installation/bin/node; do
    [ -x "$candidate" ] && NODE="$candidate" && break
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || exit 0   # no Node at all: fail open, never break the session

ENTRY="$ROOT/dist/hook-cli.js"
[ -f "$ENTRY" ] || exit 0  # not built yet: fail open

"$NODE" "$ENTRY" "$@"
exit $?
