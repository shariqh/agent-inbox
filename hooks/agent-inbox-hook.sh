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
# The exit status is forwarded selectively, not blindly — see the policy at the
# foot of this file, which is where the "never break the session" contract is
# actually enforced.
#
# `set -u` only — never `set -e`: a hook must fail open.
set -u

SUB="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Node 24 resolution. `better-sqlite3`'s binding is ABI-pinned; bare `node` on a
# Node 26 box dies on every invocation, silently, forever. `.node-version` is
# resolved relative to THIS script, not the cwd — the hook runs with the cwd set
# to the user's own project, where `cat .node-version` finds nothing (or worse,
# finds someone else's).
#
# Deliberately NO `pwd -P` normalisation here, unlike scripts/install-hooks.sh.
# That normalisation exists solely to stop an EPHEMERAL
# ~/.local/state/fnm_multishells/<pid>_<ts>/bin/node path being BAKED into
# ~/.claude/settings.json, where it rots the moment the shell that minted it
# exits. This wrapper re-resolves Node on every single invocation and execs it
# immediately, so an ephemeral path is valid for exactly as long as it is used.
# Adding a stable_path() here would buy nothing.
NODE=""
if [ -n "${AGENT_INBOX_NODE:-}" ] && [ -x "${AGENT_INBOX_NODE}" ]; then
  NODE="$AGENT_INBOX_NODE"
elif command -v fnm >/dev/null 2>&1 && [ -r "$ROOT/.node-version" ]; then
  # NOT `fnm which` — that subcommand does not exist (fnm 1.39 answers
  # "error: unrecognized subcommand 'which'"), so this branch used to yield the
  # empty string on every box and fall silently through to the glob below.
  # `fnm exec --using=<version>` is the invocation that actually resolves.
  NODE="$(fnm exec --using="$(cat "$ROOT/.node-version")" -- sh -c 'command -v node' 2>/dev/null || true)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  for candidate in "$HOME"/.local/share/fnm/node-versions/v24.*/installation/bin/node; do
    [ -x "$candidate" ] && NODE="$candidate" && break
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || NODE="$(command -v node || true)"
# `-x`, not just `-n`: bash's `command -v` reports the first PATH entry MATCHING
# BY NAME and does not require the execute bit, so a `node` in PATH with mode
# 644 comes back as a perfectly non-empty path. Executing it costs the user a
# "Permission denied" and status 126 on every single hook event, forever.
[ -x "$NODE" ] || exit 0   # no usable Node: fail open, never break the session

ENTRY="$ROOT/dist/hook-cli.js"
[ -f "$ENTRY" ] || exit 0  # not built yet: fail open

"$NODE" "$ENTRY" "$@"
STATUS=$?

# ── exit-code policy ────────────────────────────────────────────────────────
# VERIFIED against the Claude Code hooks reference ("Exit code 2 behavior per
# event", code.claude.com/docs/en/hooks), not assumed:
#   0             success — stdout is parsed for JSON output.
#   2             BLOCKING. Stop: "Yes, blocks. Prevents Claude from stopping,
#                 continues the conversation" — which is exactly how `watch`
#                 wakes the model. But UserPromptSubmit: "Yes, blocks. Blocks
#                 prompt processing and ERASES THE PROMPT" — and this wrapper is
#                 the entry point for prompt-submit too.
#   anything else non-blocking, but the transcript still shows a
#                 "<hook name> hook error" notice with the first line of stderr.
#
# So a blanket `exit $?` is not fail-open: it hands the harness a 126 from a
# broken Node path, a 127 from a missing one, a 137 from an OOM kill, or a
# future stray `process.exit(2)` — the last of which would silently eat the
# human's prompt. We forward only the statuses the CLI emits ON PURPOSE:
#   watch     2 is #21's wake signal; swallowing it makes the async half a
#             silent no-op. Any OTHER status from watch is a crash, not a wake.
#   selftest  not a hook event at all — it is the installer's proof that this
#             Node can load better-sqlite3, so its status must survive.
#   the rest  always 0. A broken install must be invisible, never an error
#             notice on every prompt and never a blocked session.
case "$SUB" in
  watch)    [ "$STATUS" -eq 2 ] && exit 2 || exit 0 ;;
  selftest) exit "$STATUS" ;;
  *)        exit 0 ;;
esac
