#!/usr/bin/env bash
# Remove the Setup runtimes nothing uses (issue #294).
#
# DRY RUN IS THE DEFAULT: it lists what --apply would remove and changes
# nothing; it takes no setup lock, cleans no trash and writes no file.
# --apply removes, under the shared setup lock, each runtime under
# ${AGENT_INBOX_RUNTIME_ROOT:-~/.agent-inbox/runtime} that
#   - is not the runtime this script runs from,
#   - no host config uses: ~/.claude.json (every scope in it),
#     ~/.claude/settings.json, ~/.claude/settings.local.json,
#     ~/.copilot/mcp-config.json or Claude Desktop's config, and
#   - no running process names,
# checking each one again just before runtime-payload.mjs prune removes it.
# A host config that cannot be read means nothing is removed. Project-scope
# configs (<project>/.mcp.json, <project>/.claude/settings*.json) are not read.
#
# Usage, from an installed runtime or the app's own runtime payload:
#   bash ~/.agent-inbox/runtime/<runtime-id>/scripts/prune-runtimes.sh          # dry run
#   bash ~/.agent-inbox/runtime/<runtime-id>/scripts/prune-runtimes.sh --apply  # remove them
# Setup's `prune-runtimes` target runs the app's own copy with --apply.
# Exit 0: done, naming anything kept because it is still in use; 1: refused,
# or a removal failed; 2: usage.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -h|--help) sed -n '/^set -u$/q;2,$p' "$0"; exit 0 ;;
    *) echo "prune-runtimes: unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

case "${HOME:-}" in
  /*) ;;
  *) echo "prune-runtimes: HOME must be an absolute path" >&2; exit 2 ;;
esac
RUNTIME_ROOT="${AGENT_INBOX_RUNTIME_ROOT:-$HOME/.agent-inbox/runtime}"
case "$RUNTIME_ROOT" in
  /*) ;;
  *) echo "prune-runtimes: AGENT_INBOX_RUNTIME_ROOT must be an absolute path" >&2; exit 2 ;;
esac

# It runs on a runtime's own Node and helpers, and always keeps that runtime.
if [ ! -f "$ROOT/runtime-manifest.json" ]; then
  echo "prune-runtimes: run it from a packaged runtime: bash ~/.agent-inbox/runtime/<runtime-id>/scripts/prune-runtimes.sh" >&2
  exit 2
fi
NODE="$ROOT/bin/node"
PAYLOAD_HELPER="$ROOT/scripts/runtime-payload.mjs"
CONFIG_HELPER="$ROOT/scripts/runtime-config.mjs"
SETUP_LOCK_HELPER="$SCRIPT_DIR/setup-lock.sh"
[ -x "$NODE" ] || { echo "prune-runtimes: the runtime's Node is missing: $NODE" >&2; exit 1; }
for helper in "$PAYLOAD_HELPER" "$CONFIG_HELPER" "$SETUP_LOCK_HELPER"; do
  [ -f "$helper" ] || { echo "prune-runtimes: a runtime helper is missing: $helper" >&2; exit 1; }
done
if ! source "$SETUP_LOCK_HELPER" || ! declare -F acquire_setup_lock >/dev/null; then
  echo "prune-runtimes: failed to load shared setup lock helper: $SETUP_LOCK_HELPER" >&2
  exit 1
fi

# The lease every installer holds, from before the first check to after the
# last removal. A dry run changes nothing, so it takes none.
if [ "$APPLY" -eq 1 ]; then acquire_setup_lock prune-runtimes || exit 1; fi

# Its own runtime is checked before anything it says is trusted.
if ! "$NODE" "$PAYLOAD_HELPER" verify --root "$ROOT" --product agent-inbox-runtime >/dev/null; then
  echo "prune-runtimes: this runtime failed verification, so nothing was removed" >&2
  exit 1
fi
CURRENT="$("$NODE" -e '
  const id = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).runtimeId
  if (typeof id !== "string" || !id) process.exit(1)
  process.stdout.write(id)
' "$ROOT/runtime-manifest.json")" || {
  echo "prune-runtimes: this runtime's manifest names no runtime id, so nothing was removed" >&2
  exit 1
}

# runtime-config.mjs unused as tab-separated lines: verdict, runtime id,
# version, detail ("-" for none). When it cannot tell, one line: unknown and why.
verdicts() {
  local json
  json="$("$NODE" "$CONFIG_HELPER" unused --runtime-root "$RUNTIME_ROOT" --home "$HOME" --current "$CURRENT" "$@" </dev/null)" || return 1
  "$NODE" -e '
    const result = JSON.parse(process.argv[1])
    const field = (value) => String(value).replace(/[\t\n\r]/g, " ") || "-"
    if (result.status !== "ok") {
      process.stdout.write(`unknown\t-\t-\t${field(result.reason || "the host configs cannot be checked")}\n`)
      process.exit(0)
    }
    for (const r of result.runtimes) {
      // a name a line cannot carry is never removed
      const verdict = /[\t\n\r]/.test(r.runtimeId) ? "not-a-runtime" : r.verdict
      const detail = verdict === "used" ? r.usedBy.join(", ") : verdict === "in-use" ? r.pids.join(", ") : "-"
      process.stdout.write(`${verdict}\t${field(r.runtimeId)}\t${field(r.version ?? "-")}\t${field(detail)}\n`)
    }
  ' "$json" </dev/null
}

label() {
  if [ "$2" = - ]; then printf '%s' "$1"; else printf 'v%s (%s)' "$2" "$1"; fi
}

# Why a runtime stays: its verdict, its label and its detail.
kept() {
  case "$1" in
    current) echo "Kept $2: the runtime this prune runs from." ;;
    used) echo "Kept $2: used by $3." ;;
    in-use)
      case "$3" in
        *,*) echo "Kept $2: in use by running processes (pids $3). Exit those sessions, then try again." ;;
        *) echo "Kept $2: in use by a running process (pid $3). Exit that session, then try again." ;;
      esac
      ;;
    *) echo "Kept $2." ;;
  esac
}

REFUSED=""
FAILED=0
FOUND=0
REMOVED=0

# One unused runtime, checked again on its own first: a host config or a
# process may have started using it since the list was made. Seconds still
# pass between that check and the rename that removes it, while prune cleans
# old trash and hashes the folder against its manifest; a config written in
# that window is not seen (Setup's installers wait for this lock).
remove_runtime() {
  local id="$1" name="$2" again verdict detail result
  again="$(verdicts --runtime-id "$id")" || {
    echo "Kept $name: it could not be checked again."
    FAILED=1
    return
  }
  if [ -z "$again" ]; then
    echo "Kept $name: it is no longer there."
    return
  fi
  IFS=$'\t' read -r verdict _ _ detail <<EOF
$again
EOF
  if [ "$verdict" = unknown ]; then
    REFUSED="$detail"
    return
  fi
  if [ "$verdict" != unused ]; then
    kept "$verdict" "$name" "$detail"
    return
  fi
  if result="$("$NODE" "$PAYLOAD_HELPER" prune --runtime-root "$RUNTIME_ROOT" --runtime-id "$id" 2>&1 </dev/null)"; then
    REMOVED=$((REMOVED + 1))
    case "$result" in
      *'"retained":'*) echo "Removed $name. Some of its files are left in a .trash-* folder in $RUNTIME_ROOT, which the next install or prune deletes." ;;
      *) echo "Removed $name." ;;
    esac
  else
    FAILED=1
    echo "Could not remove $name: ${result#runtime-payload: }"
  fi
}

LIST="$(verdicts)" || {
  echo "prune-runtimes: could not check which runtimes are in use, so nothing was removed" >&2
  exit 1
}
case "$LIST" in
  unknown$'\t'*)
    echo "prune-runtimes: ${LIST##*$'\t'}. Nothing was removed." >&2
    exit 1
    ;;
esac

while IFS=$'\t' read -r verdict id version detail; do
  [ -n "$verdict" ] || continue
  name="$(label "$id" "$version")"
  case "$verdict" in
    not-a-runtime) echo "Left $id alone: it is not an Agent Inbox runtime." ;;
    unused)
      FOUND=$((FOUND + 1))
      if [ "$APPLY" -eq 1 ]; then remove_runtime "$id" "$name"; else echo "Would remove $name."; fi
      if [ -n "$REFUSED" ]; then break; fi
      ;;
    *) kept "$verdict" "$name" "$detail" ;;
  esac
done <<EOF
$LIST
EOF

plural() {
  if [ "$1" -eq 1 ]; then printf '1 runtime'; else printf '%s runtimes' "$1"; fi
}

if [ -n "$REFUSED" ]; then
  echo "prune-runtimes: $REFUSED. Removed $(plural "$REMOVED") before that; nothing more was removed." >&2
  exit 1
fi
if [ "$FOUND" -eq 0 ]; then
  echo "Nothing to remove."
elif [ "$APPLY" -eq 0 ]; then
  echo "Dry run: nothing was removed. Run it again with --apply to remove $(plural "$FOUND")."
else
  echo "Removed $(plural "$REMOVED")."
fi
exit "$FAILED"
