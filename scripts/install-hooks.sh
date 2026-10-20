#!/usr/bin/env bash
# Opt-in installer for the agent-inbox backstop hooks (issues #10 / #21).
#
# DRY-RUN IS THE DEFAULT: this prints the settings.json it *would* write and
# changes nothing. Pass --apply to actually write. Nothing here runs from
# `npm install` or `npm run build`, and the Electron app runs it only when the
# human asks Setup to move hooks a Setup runtime installed (#206): this
# script from the installed runtime, with --apply alone. The user's global
# Claude Code config never changes by surprise.
#
# Usage:
#   npm run install:hooks                 # dry run — print the merged result
#   npm run install:hooks -- --apply      # write it (timestamped backup first)
#   npm run install:hooks -- --apply --force      # re-install over this install's own hooks
#   npm run install:hooks -- --apply --replace-existing  # also replace another Agent Inbox install's
#   npm run install:hooks -- --apply --migrate    # also retire the legacy .sh Stop hooks
#   npm run install:hooks -- --apply --uninstall  # remove this install's hooks
#
# Hooks from another Agent Inbox install (a Setup runtime, another checkout)
# are refused, never doubled: docs/hooks.md, "One set of hooks".
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SETTINGS="${HOME}/.claude/settings.json"
APPLY=0; FORCE=0; UNINSTALL=0; MIGRATE=0; REPLACE=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --migrate) MIGRATE=1 ;;
    --replace-existing) REPLACE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done
if [ "$UNINSTALL" -eq 1 ] && [ "$REPLACE" -eq 1 ]; then
  echo "install-hooks: --replace-existing installs this set in place of every other; it cannot be combined with --uninstall" >&2
  exit 2
fi

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

# Scratch paths this run owns. The EXIT trap removes them on every way out (a
# refused step, a failed write, an interrupt), so a run that fails never leaves
# a staged settings file or a throwaway selftest database behind.
SELFTEST_DIR=""
STAGED=""
cleanup() {
  if [ -n "$STAGED" ]; then rm -f "$STAGED"; fi
  if [ -n "$SELFTEST_DIR" ]; then rm -rf "$SELFTEST_DIR"; fi
}
trap cleanup EXIT

if [ "$UNINSTALL" -eq 0 ]; then
  [ -n "$NODE" ] || { echo "install-hooks: no Node binary found — set AGENT_INBOX_NODE" >&2; exit 1; }
  [ -f "$ENTRY" ] || { echo "install-hooks: $ENTRY is missing — run 'npm run build' first" >&2; exit 1; }
  # Opening a database creates and migrates it, and the dry run promises to
  # change nothing. All the preview has to prove is that this Node loads
  # better-sqlite3, which any database proves, so it gets a throwaway one.
  # --apply still proves it against the hub its hooks will open, before
  # anything is written.
  if [ "$APPLY" -eq 1 ]; then
    "$NODE" "$ENTRY" selftest >/dev/null 2>&1
    SELFTEST_STATUS=$?
  else
    SELFTEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-inbox-selftest.XXXXXX")" || {
      echo "install-hooks: could not create a throwaway database for the dry-run selftest" >&2
      exit 1
    }
    AGENT_INBOX_DB="$SELFTEST_DIR/inbox.db" "$NODE" "$ENTRY" selftest >/dev/null 2>&1
    SELFTEST_STATUS=$?
    rm -rf "$SELFTEST_DIR" && SELFTEST_DIR=""
  fi
  if [ "$SELFTEST_STATUS" -ne 0 ]; then
    echo "install-hooks: '$NODE $ENTRY selftest' failed." >&2
    echo "  That Node cannot load better-sqlite3 (Node 24 is required — see CLAUDE.md)." >&2
    echo "  Nothing was written. Set AGENT_INBOX_NODE to a Node 24 binary and retry." >&2
    exit 1
  fi
fi

if [ "$APPLY" -eq 1 ]; then acquire_setup_lock install-hooks || exit 1; fi

# ── the file actually written ───────────────────────────────────────────────
# A symlinked settings.json (a dotfiles checkout, say) is written THROUGH, the
# rule install-agents.sh applies to instruction files: the backup, the staged
# copy and the rename all happen beside the link's target, so the link survives
# and its target is what changes. Replacing the link instead would silently fork
# the live config from the dotfiles copy. A dangling link, or a path that is not
# a regular file, is refused before anything is read or written.
TARGET="$SETTINGS"
if [ -L "$SETTINGS" ]; then
  if [ ! -e "$SETTINGS" ]; then
    echo "install-hooks: $SETTINGS is a dangling symlink — refusing to replace it" >&2
    exit 1
  fi
  TARGET="$(realpath "$SETTINGS" 2>/dev/null)" && [ -n "$TARGET" ] || {
    echo "install-hooks: could not resolve the symlink $SETTINGS — refusing to touch it" >&2
    exit 1
  }
fi
if [ -e "$TARGET" ] && [ ! -f "$TARGET" ]; then
  echo "install-hooks: $TARGET is not a regular file — refusing to touch it" >&2
  exit 1
fi

unmergeable() {
  echo "install-hooks: could not merge the agent-inbox hooks into $SETTINGS — nothing was written" >&2
  exit 1
}

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
  hook_args=(hooks --settings "$TARGET" --node "$NODE" --entry "$ENTRY" --runtime-root "$RUNTIME_ROOT" --installer "$SELF")
  [ "$UNINSTALL" -eq 1 ] && hook_args+=(--uninstall)
  [ "$MIGRATE" -eq 1 ] && hook_args+=(--migrate)
  [ "$REPLACE" -eq 1 ] && hook_args+=(--replace-existing)
  # Packaged mode deliberately never forwards --force: only exact
  # manifest-owned release hooks may be replaced or removed, plus, with
  # --replace-existing, another Agent Inbox install's and dead ones (#218).
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
    }')" || unmergeable

  if [ -e "$TARGET" ]; then
    CURRENT="$(cat "$TARGET")" || { echo "install-hooks: could not read $TARGET — refusing to touch it" >&2; exit 1; }
  else
    CURRENT='{}'
  fi
  # A blank file holds no settings: read it as {}, as runtime-config.mjs does.
  case "$CURRENT" in *[![:space:]]*) ;; *) CURRENT='{}' ;; esac
  echo "$CURRENT" | jq empty 2>/dev/null || { echo "install-hooks: $SETTINGS is not valid JSON — refusing to touch it" >&2; exit 1; }

  # Another Agent Inbox install's set (a Setup runtime, another checkout) is
  # never doubled (#218): the helper sorts every agent-inbox-shaped entry by
  # the rule both modes share, refuses beside another install's hooks or dead
  # ones (the one-step --replace-existing first) or beside ones that run but
  # cannot be verified, and with --replace-existing lists the entries to strip
  # below. Another tool's look-alike is never one of them.
  FOREIGN='[]'
  if [ "$UNINSTALL" -eq 0 ]; then
    [ -f "$CONFIG_HELPER" ] || { echo "install-hooks: the hook attribution helper is missing: $CONFIG_HELPER" >&2; exit 1; }
    owner_args=(foreign-hooks --settings "$TARGET" --entry "$ENTRY" --runtime-root "$RUNTIME_ROOT" --installer "$SELF")
    [ "$REPLACE" -eq 1 ] && owner_args+=(--replace-existing)
    FOREIGN="$("$NODE" "$CONFIG_HELPER" "${owner_args[@]}")" || exit 1
  fi

  # Every jq step is checked: a failed one prints nothing, and writing that
  # nothing over settings.json would be data loss reported as success.
  ALREADY="$(echo "$CURRENT" | jq --arg entry "$ENTRY" '[ (.hooks // {}) | .[]? | .[]? | .hooks[]? | select((.args // [])[0] == $entry) ] | length')" || unmergeable
  if [ "$UNINSTALL" -eq 0 ] && [ "${ALREADY:-0}" -gt 0 ] && [ "$FORCE" -eq 0 ] && [ "$REPLACE" -eq 0 ]; then
    echo "install-hooks: agent-inbox hooks are already installed in $SETTINGS." >&2
    echo "  Re-run with --force to replace them, or --uninstall to remove them." >&2
    exit 1
  fi

  # Strip our own entries (idempotent re-install, and the whole of --uninstall).
  # --migrate additionally retires the legacy hand-written shell hooks, leaving
  # the .sh files themselves on disk so the user can roll back by hand.
  # --replace-existing strips the entries listed above (other installs' and
  # dead ones), by their exact command and arguments.
  STRIPPED="$(echo "$CURRENT" | jq --arg entry "$ENTRY" --argjson migrate "$MIGRATE" --argjson foreign "$FOREIGN" '
    def mine: (.args // [])[0] == $entry
              or (($migrate == 1) and (((.command // "") | test("agent-inbox-(pending|watch)\\.sh"))))
              or (. as $hook | any($foreign[]; .command == $hook.command and .args == $hook.args));
    if (.hooks | type) == "object" then
      .hooks |= ( with_entries(.value |= ( map(.hooks |= map(select(mine | not)))
                                         | map(select((.hooks // []) | length > 0)) ))
                | with_entries(select((.value | length) > 0)) )
    else . end
    | if (.hooks == {}) then del(.hooks) else . end')" || unmergeable

  if [ "$UNINSTALL" -eq 1 ]; then
    MERGED="$STRIPPED"
  else
    # Our groups are appended as SIBLINGS of anything already registered for the
    # same event — an existing PostToolUse (or anyone else's Stop hook) survives.
    MERGED="$(echo "$STRIPPED" | jq --argjson block "$BLOCK" '
      .hooks = ((.hooks // {}) as $h
        | reduce ($block | keys_unsorted[]) as $k ($h; .[$k] = (($h[$k] // []) + $block[$k])))')" || unmergeable
  fi
fi
[ -n "$MERGED" ] || unmergeable

if [ "$APPLY" -eq 0 ]; then
  echo "── dry run: nothing was written. Re-run with --apply to install. ──" >&2
  if [ "$RUNTIME_MODE" -eq 1 ]; then printf '%s\n' "$MERGED"; else echo "$MERGED" | jq .; fi
  exit 0
fi

# ── stage, back up, publish ─────────────────────────────────────────────────
# Every step is checked and nothing is reported until the rename has landed: a
# step that fails exits non-zero with the target unchanged, and the EXIT trap
# removes the staged copy. The copy starts as a clone of the target so the
# published file keeps the target's mode (settings.json can carry secrets) —
# which is why a target this user cannot write (read-only, or immutable on
# macOS) is refused first: its clone could be neither filled nor removed.
if [ -f "$TARGET" ] && [ ! -w "$TARGET" ]; then
  echo "install-hooks: $TARGET is read-only — nothing was written; make it writable and retry" >&2
  exit 1
fi
TARGET_DIR="$(dirname "$TARGET")"
mkdir -p "$TARGET_DIR" || { echo "install-hooks: could not create $TARGET_DIR — nothing was written" >&2; exit 1; }
STAGED="$(mktemp "$TARGET_DIR/$(basename "$TARGET").tmp.XXXXXX")" || {
  echo "install-hooks: could not stage a settings file in $TARGET_DIR — nothing was written" >&2
  exit 1
}
if [ -f "$TARGET" ] && ! cp -p "$TARGET" "$STAGED"; then
  echo "install-hooks: could not stage a copy of $TARGET — nothing was written" >&2
  exit 1
fi
if [ "$RUNTIME_MODE" -eq 1 ]; then
  printf '%s\n' "$MERGED" > "$STAGED"
  WROTE=$?
else
  echo "$MERGED" | jq . > "$STAGED"
  WROTE=$?
fi
if [ "$WROTE" -ne 0 ]; then
  echo "install-hooks: could not write the staged settings file $STAGED — nothing was written" >&2
  exit 1
fi
if [ -f "$TARGET" ]; then
  STAMP="$(date +%Y%m%d%H%M%S)"
  BACKUP="$TARGET.bak.$STAMP.$$"
  n=0
  while [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; do
    n=$((n + 1))
    BACKUP="$TARGET.bak.$STAMP.$$.$n"
  done
  cp -p "$TARGET" "$BACKUP" || { echo "install-hooks: could not back up $TARGET — refusing to write" >&2; exit 1; }
  echo "backed up → $BACKUP" >&2
fi
if ! mv -f "$STAGED" "$TARGET"; then
  echo "install-hooks: could not replace $TARGET — it is unchanged" >&2
  exit 1
fi
STAGED=""

SHOWN="$SETTINGS"
if [ "$TARGET" != "$SETTINGS" ]; then SHOWN="$SETTINGS → $TARGET"; fi
if [ "$UNINSTALL" -eq 1 ]; then
  echo "agent-inbox hooks removed from $SHOWN" >&2
else
  echo "agent-inbox hooks installed in $SHOWN (Node: ${NODE:-node})" >&2
fi
echo "Claude Code reads hooks when a session starts and normally applies a change to running sessions too; restart a session to be sure it has this one." >&2
