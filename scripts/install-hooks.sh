#!/usr/bin/env bash
# Opt-in installer for the agent-inbox backstop hooks (issues #10 / #21).
#
# DRY-RUN IS THE DEFAULT: this prints the settings.json it *would* write and
# changes nothing. Pass --apply to actually write. Nothing here runs from
# `npm install`, `npm run build`, or the Electron app — the user's global
# Claude Code config never changes by surprise.
#
# Usage:
#   npm run install:hooks                 # dry run — print the merged result
#   npm run install:hooks -- --apply      # write it (timestamped backup first)
#   npm run install:hooks -- --apply --force      # re-install over an existing one
#   npm run install:hooks -- --apply --migrate    # also retire the legacy .sh Stop hooks
#   npm run install:hooks -- --apply --uninstall  # remove every agent-inbox entry
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SETTINGS="${HOME}/.claude/settings.json"
APPLY=0; FORCE=0; UNINSTALL=0; MIGRATE=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --migrate) MIGRATE=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

SETUP_LOCK_HELPER="$SCRIPT_DIR/setup-lock.sh"
if [ ! -r "$SETUP_LOCK_HELPER" ]; then
  echo "install-hooks: failed to load shared setup lock helper: $SETUP_LOCK_HELPER" >&2
  exit 1
fi
if ! source "$SETUP_LOCK_HELPER"; then
  echo "install-hooks: failed to load shared setup lock helper: $SETUP_LOCK_HELPER" >&2
  exit 1
fi
if ! declare -F acquire_setup_lock >/dev/null; then
  echo "install-hooks: failed to load shared setup lock helper: $SETUP_LOCK_HELPER" >&2
  exit 1
fi

RUNTIME_MODE=0
RUNTIME_ROOT="${AGENT_INBOX_RUNTIME_ROOT:-$HOME/.agent-inbox/runtime}"
CONFIG_HELPER="$ROOT/scripts/runtime-config.mjs"
if [ -f "$ROOT/runtime-manifest.json" ]; then RUNTIME_MODE=1; fi

if [ "$RUNTIME_MODE" -eq 0 ]; then
  command -v jq >/dev/null 2>&1 || { echo "install-hooks: jq is required for checkout-mode hook setup" >&2; exit 1; }
fi

ENTRY="${AGENT_INBOX_HOOK_ENTRY:-$ROOT/dist/hook-cli.js}"

# ── Node 24 resolution, and the proof that it works ────────────────────────
# This is where the Node-26 hazard dies: an absolute, PROVEN Node path is baked
# into settings.json, so the hooks cannot be spawned under a Node whose ABI
# better-sqlite3 was not built for.
#
# A PATH lookup inside an fnm shell hands back an EPHEMERAL
# ~/.local/state/fnm_multishells/<pid>_<ts>/bin/node path that vanishes when
# that shell exits. Baking one into settings.json breaks every hook the next
# day, silently. `cd $(dirname) && pwd -P` resolves it to the stable
# node-versions installation path. (The wrapper, hooks/agent-inbox-hook.sh,
# deliberately does NOT do this: it re-resolves and execs in one breath, so an
# ephemeral path is valid for as long as it is used. Only a path we PERSIST
# needs to be stable.)
stable_path() {
  [ -n "${1:-}" ] || return 0
  echo "$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)/$(basename "$1")"
}

resolve_node() {
  if [ -n "${AGENT_INBOX_NODE:-}" ] && [ -x "${AGENT_INBOX_NODE}" ]; then stable_path "$AGENT_INBOX_NODE"; return; fi
  if command -v fnm >/dev/null 2>&1 && [ -r "$ROOT/.node-version" ]; then
    # NOT `fnm which` — no such subcommand exists (fnm 1.39 answers
    # "error: unrecognized subcommand 'which'"), so this branch used to yield
    # empty on every box and fall through to the PATH lookup, quietly defeating
    # the whole point of reading .node-version.
    n="$(fnm exec --using="$(cat "$ROOT/.node-version")" -- sh -c 'command -v node' 2>/dev/null || true)"
    if [ -n "$n" ] && [ -x "$n" ]; then stable_path "$n"; return; fi
  fi
  for candidate in "$HOME"/.local/share/fnm/node-versions/v24.*/installation/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  stable_path "$(command -v node || true)"
}

if [ "$RUNTIME_MODE" -eq 1 ]; then
  NODE="$ROOT/bin/node"
  ENTRY="$ROOT/dist/hook-cli.js"
  [ -x "$NODE" ] || { echo "install-hooks: packaged runtime Node is missing: $NODE" >&2; exit 1; }
  [ -f "$CONFIG_HELPER" ] || { echo "install-hooks: packaged runtime config helper is missing: $CONFIG_HELPER" >&2; exit 1; }
else
  NODE="$(resolve_node)"
fi

if [ "$UNINSTALL" -eq 0 ]; then
  [ -n "$NODE" ] || { echo "install-hooks: no Node binary found — set AGENT_INBOX_NODE" >&2; exit 1; }
  [ -f "$ENTRY" ] || { echo "install-hooks: $ENTRY is missing — run 'npm run build' first" >&2; exit 1; }
  if ! "$NODE" "$ENTRY" selftest >/dev/null 2>&1; then
    echo "install-hooks: '$NODE $ENTRY selftest' failed." >&2
    echo "  That Node cannot load better-sqlite3 (Node 24 is required — see CLAUDE.md)." >&2
    echo "  Nothing was written. Set AGENT_INBOX_NODE to a Node 24 binary and retry." >&2
    exit 1
  fi
fi

if [ "$APPLY" -eq 1 ]; then acquire_setup_lock install-hooks || exit 1; fi

# ── build the block ─────────────────────────────────────────────────────────
# exec form (`args`), never a shell string: paths containing quotes, $ or
# backticks never reach a shell parser.
#
# The Notification entry deliberately has NO matcher. The CLI's Notification
# matcher matches notification_type, so a matcher here would stop the hook from
# ever running for other types — killing both the message fallback for older
# CLIs and the log line that discovers the real enumeration. The single gate is
# AGENT_INBOX_HOOK_NOTIFY_TYPES (default: permission_prompt).
if [ "$RUNTIME_MODE" -eq 1 ]; then
  hook_args=(hooks --settings "$SETTINGS" --node "$NODE" --entry "$ENTRY" --runtime-root "$RUNTIME_ROOT")
  [ "$UNINSTALL" -eq 1 ] && hook_args+=(--uninstall)
  [ "$MIGRATE" -eq 1 ] && hook_args+=(--migrate)
  # Packaged mode deliberately never forwards --force: only exact
  # manifest-owned release hooks may be replaced or removed.
  MERGED="$("$NODE" "$CONFIG_HELPER" "${hook_args[@]}")" || exit 1
else
  BLOCK="$(jq -n --arg node "${NODE:-node}" --arg entry "$ENTRY" '
    def h($sub; $t): { type: "command", command: $node, args: [$entry, $sub], timeout: $t };
    {
      Notification:     [ { hooks: [ h("notification"; 5) ] } ],
      SessionStart:     [ { matcher: "startup|resume", hooks: [ h("session-start"; 5) ] } ],
      SessionEnd:       [ { hooks: [ h("session-end"; 5) ] } ],
      UserPromptSubmit: [ { hooks: [ h("prompt-submit"; 10) ] } ],
      Stop: [ { hooks: [
        h("stop"; 10)    + { statusMessage: "Checking agent-inbox for answered questions…" },
        h("watch"; 1800) + { statusMessage: "Arming agent-inbox answer watcher…", asyncRewake: true, rewakeSummary: "Agent Inbox: your answer arrived" }
      ] } ]
    }')"

  CURRENT="$(cat "$SETTINGS" 2>/dev/null || echo '{}')"
  echo "$CURRENT" | jq empty 2>/dev/null || { echo "install-hooks: $SETTINGS is not valid JSON — refusing to touch it" >&2; exit 1; }

  ALREADY="$(echo "$CURRENT" | jq --arg entry "$ENTRY" '[ (.hooks // {}) | .[]? | .[]? | .hooks[]? | select((.args // [])[0] == $entry) ] | length')"
  if [ "$UNINSTALL" -eq 0 ] && [ "${ALREADY:-0}" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
    echo "install-hooks: agent-inbox hooks are already installed in $SETTINGS." >&2
    echo "  Re-run with --force to replace them, or --uninstall to remove them." >&2
    exit 1
  fi

  # Strip our own entries (idempotent re-install, and the whole of --uninstall).
  # --migrate additionally retires the legacy hand-written shell hooks, leaving
  # the .sh files themselves on disk so the user can roll back by hand.
  STRIPPED="$(echo "$CURRENT" | jq --arg entry "$ENTRY" --argjson migrate "$MIGRATE" '
    def mine: (.args // [])[0] == $entry
              or (($migrate == 1) and (((.command // "") | test("agent-inbox-(pending|watch)\\.sh"))));
    if (.hooks | type) == "object" then
      .hooks |= ( with_entries(.value |= ( map(.hooks |= map(select(mine | not)))
                                         | map(select((.hooks // []) | length > 0)) ))
                | with_entries(select((.value | length) > 0)) )
    else . end
    | if (.hooks == {}) then del(.hooks) else . end')"

  if [ "$UNINSTALL" -eq 1 ]; then
    MERGED="$STRIPPED"
  else
    # Our groups are appended as SIBLINGS of anything already registered for the
    # same event — an existing PostToolUse (or anyone else's Stop hook) survives.
    MERGED="$(echo "$STRIPPED" | jq --argjson block "$BLOCK" '
      .hooks = ((.hooks // {}) as $h
        | reduce ($block | keys_unsorted[]) as $k ($h; .[$k] = (($h[$k] // []) + $block[$k])))')"
  fi
fi

if [ "$APPLY" -eq 0 ]; then
  echo "── dry run: nothing was written. Re-run with --apply to install. ──" >&2
  if [ "$RUNTIME_MODE" -eq 1 ]; then printf '%s\n' "$MERGED"; else echo "$MERGED" | jq .; fi
  exit 0
fi

mkdir -p "$(dirname "$SETTINGS")"
if [ -f "$SETTINGS" ]; then
  BACKUP="$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
  cp "$SETTINGS" "$BACKUP" || { echo "install-hooks: could not back up $SETTINGS — refusing to write" >&2; exit 1; }
  echo "backed up → $BACKUP" >&2
fi
TMP="$SETTINGS.tmp.$$"
if [ "$RUNTIME_MODE" -eq 1 ]; then
  printf '%s\n' "$MERGED" > "$TMP" && mv "$TMP" "$SETTINGS"
else
  echo "$MERGED" | jq . > "$TMP" && mv "$TMP" "$SETTINGS"
fi
if [ "$UNINSTALL" -eq 1 ]; then
  echo "agent-inbox hooks removed from $SETTINGS" >&2
else
  echo "agent-inbox hooks installed in $SETTINGS (Node: ${NODE:-node})" >&2
fi
echo "New registrations are picked up only on a FRESH Claude Code session." >&2
