#!/usr/bin/env bash
# Opt-in Copilot CLI hooks for Agent Inbox (#466 PR 3). They stamp when a
# session's turn starts and ends and when it runs a tool, so the Agents view can
# show a session busy with other tools as working. One file, owned outright:
# ${COPILOT_HOME:-~/.copilot}/hooks/agent-inbox.json.
#
# DRY RUN IS THE DEFAULT: it prints the file it would write and changes nothing.
#   npm run install:copilot-hooks                              # dry run
#   npm run install:copilot-hooks -- --apply                   # write it (an older copy is backed up)
#   npm run install:copilot-hooks -- --apply --no-tool-stamps  # turn stamps only, no per-tool hook
#   npm run install:copilot-hooks -- --apply --uninstall       # remove it
# Any other file at that path is refused, never replaced. See docs/hooks.md.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY=0; UNINSTALL=0; TOOL_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --no-tool-stamps) TOOL_FLAG="--no-tool-stamps" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

HOOKS_DIR="${COPILOT_HOME:-$HOME/.copilot}/hooks"
TARGET="$HOOKS_DIR/agent-inbox.json"
ENTRY="${AGENT_INBOX_HOOK_ENTRY:-$ROOT/dist/hook-cli.js}"
HELPER="$SCRIPT_DIR/copilot-hooks.mjs"
say() { echo "install-copilot-hooks: $*" >&2; }

# shellcheck source=setup-lock.sh
if ! source "$SCRIPT_DIR/setup-lock.sh" 2>/dev/null || ! declare -F acquire_setup_lock >/dev/null; then
  say "failed to load the shared setup lock helper: $SCRIPT_DIR/setup-lock.sh"; exit 1
fi

# The Node baked into the file must be stable and proven (install-hooks.sh's rule):
# an fnm multishell path vanishes with its shell.
stable_path() { [ -n "${1:-}" ] && echo "$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)/$(basename "$1")"; }
NODE=""
if [ -n "${AGENT_INBOX_NODE:-}" ] && [ -x "$AGENT_INBOX_NODE" ]; then NODE="$(stable_path "$AGENT_INBOX_NODE")"; fi
if [ -z "$NODE" ]; then
  for candidate in "$HOME"/.local/share/fnm/node-versions/v24.*/installation/bin/node; do
    if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi
[ -n "$NODE" ] || NODE="$(stable_path "$(command -v node || true)")"
[ -n "$NODE" ] || { say "no Node binary found — set AGENT_INBOX_NODE"; exit 1; }

SELFTEST_DIR=""; STAGED=""
cleanup() { [ -n "$STAGED" ] && rm -f "$STAGED"; [ -n "$SELFTEST_DIR" ] && rm -rf "$SELFTEST_DIR"; return 0; }
trap cleanup EXIT

if [ "$UNINSTALL" -eq 0 ]; then
  [ -f "$ENTRY" ] || { say "$ENTRY is missing — run 'npm run build' first"; exit 1; }
  # The dry run proves Node against a throwaway hub; --apply against the real one.
  if [ "$APPLY" -eq 1 ]; then
    "$NODE" "$ENTRY" selftest >/dev/null 2>&1; STATUS=$?
  else
    SELFTEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-inbox-selftest.XXXXXX")" || { say "could not create a throwaway database"; exit 1; }
    AGENT_INBOX_DB="$SELFTEST_DIR/inbox.db" "$NODE" "$ENTRY" selftest >/dev/null 2>&1; STATUS=$?
  fi
  if [ "$STATUS" -ne 0 ]; then
    say "'$NODE $ENTRY selftest' failed: that Node cannot load better-sqlite3 (Node 24 is required). Nothing was written."
    exit 1
  fi
fi

if [ "$APPLY" -eq 1 ]; then acquire_setup_lock install-copilot-hooks || exit 1; fi

# Read under the lock: a file this installer did not write is never touched.
if [ -L "$TARGET" ] || { [ -e "$TARGET" ] && [ ! -f "$TARGET" ]; }; then
  say "$TARGET is not a regular file — refusing to touch it"; exit 1
fi
if [ -f "$TARGET" ] && ! "$NODE" "$HELPER" check "$TARGET"; then
  say "$TARGET is not an Agent Inbox hooks file — refusing to touch it. Move it aside and run this again."
  exit 1
fi

backup() { cp -p "$TARGET" "$TARGET.bak.$(date +%Y%m%d-%H%M%S)" || { say "could not back up $TARGET — nothing was changed"; exit 1; }; }

if [ "$UNINSTALL" -eq 1 ]; then
  if [ ! -f "$TARGET" ]; then say "no Agent Inbox hooks file at $TARGET — nothing to remove"; exit 0; fi
  if [ "$APPLY" -eq 0 ]; then say "dry run: would remove $TARGET (pass --apply)"; exit 0; fi
  backup
  rm -f "$TARGET" || { say "could not remove $TARGET"; exit 1; }
  say "removed $TARGET; new Copilot CLI sessions run without it"
  exit 0
fi

CONTENT="$("$NODE" "$HELPER" build "$NODE" "$ENTRY" $TOOL_FLAG)" || { say "could not build the hooks file — nothing was written"; exit 1; }
if [ "$APPLY" -eq 0 ]; then
  printf '%s\n' "$CONTENT"
  say "dry run: would write $TARGET (pass --apply)"
  exit 0
fi
if [ -f "$TARGET" ] && [ "$(cat "$TARGET")" = "$CONTENT" ]; then say "$TARGET is already up to date"; exit 0; fi
mkdir -p "$HOOKS_DIR" || { say "could not create $HOOKS_DIR — nothing was written"; exit 1; }
# The staged copy's name does not end in .json, so Copilot never loads it.
STAGED="$(mktemp "$HOOKS_DIR/agent-inbox.json.tmp.XXXXXX")" || { say "could not stage a file in $HOOKS_DIR — nothing was written"; exit 1; }
printf '%s\n' "$CONTENT" > "$STAGED" || { say "could not write $STAGED — nothing was written"; exit 1; }
if [ -f "$TARGET" ]; then backup; fi
mv -f "$STAGED" "$TARGET" || { say "could not replace $TARGET — it is unchanged"; exit 1; }
STAGED=""
say "wrote $TARGET; new Copilot CLI sessions pick it up"
