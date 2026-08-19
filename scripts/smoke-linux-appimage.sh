#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: smoke-linux-appimage.sh --appimage <path> --mode <fuse|extract> --port <port>" >&2
  exit 2
}

assert_chromium_sandbox() {
  local host_user_ns status pid command user_ns
  host_user_ns="$(readlink /proc/self/ns/user)"
  for status in /proc/[0-9]*/status; do
    [[ -r "$status" ]] || continue
    pid="${status#/proc/}"
    pid="${pid%/status}"
    [[ -r "/proc/$pid/cmdline" && -r "/proc/$pid/ns/user" ]] || continue
    command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    [[ "$command" == *"--type="* ]] || continue
    grep -Eq '^NoNewPrivs:[[:space:]]+1$' "$status" || continue
    grep -Eq '^Seccomp:[[:space:]]+2$' "$status" || continue
    user_ns="$(readlink "/proc/$pid/ns/user" 2>/dev/null || true)"
    if [[ -n "$user_ns" && "$user_ns" != "$host_user_ns" ]]; then
      return 0
    fi
  done
  echo "smoke-linux-appimage: no Chromium child demonstrated userns plus seccomp sandboxing" >&2
  return 1
}

APPIMAGE=""
MODE=""
PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --appimage) APPIMAGE="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$APPIMAGE" && -x "$APPIMAGE" ]] || usage
[[ "$MODE" == "fuse" || "$MODE" == "extract" ]] || usage
[[ "$PORT" =~ ^[0-9]+$ ]] || usage

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/agent-inbox-appimage-smoke.XXXXXX")"
APP_PID=""
LOG=""
cleanup() {
  status=$?
  if [[ "$status" -ne 0 && -f "$LOG" ]]; then
    cat "$LOG" >&2
  fi
  if [[ -n "$APP_PID" ]]; then
    kill -- "-$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi
  for mount in "$SCRATCH"/tmp/.mount_*; do
    if command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$mount"; then
      fusermount -u "$mount" >/dev/null 2>&1 || true
    fi
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

mkdir -p \
  "$SCRATCH/home" \
  "$SCRATCH/config" \
  "$SCRATCH/cache" \
  "$SCRATCH/data" \
  "$SCRATCH/state" \
  "$SCRATCH/tmp"
chmod 0700 "$SCRATCH/tmp"
LOG="$SCRATCH/app.log"
if ! unshare --user --map-root-user true; then
  echo "smoke-linux-appimage: unprivileged user namespaces are required" >&2
  exit 1
fi
launch=(
  env
  "HOME=$SCRATCH/home"
  "XDG_CONFIG_HOME=$SCRATCH/config"
  "XDG_CACHE_HOME=$SCRATCH/cache"
  "XDG_DATA_HOME=$SCRATCH/data"
  "XDG_STATE_HOME=$SCRATCH/state"
  "TMPDIR=$SCRATCH/tmp"
  "AGENT_INBOX_DB=$SCRATCH/state/inbox.db"
  "AGENT_INBOX_PORT=$PORT"
)
if [[ "$MODE" == "extract" ]]; then
  launch+=("APPIMAGE_EXTRACT_AND_RUN=1")
fi

setsid xvfb-run -a "${launch[@]}" "$APPIMAGE" >"$LOG" 2>&1 &
APP_PID=$!
for _ in {1..90}; do
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    echo "smoke-linux-appimage: application exited before the viewer responded" >&2
    exit 1
  fi
  if curl -fsSI "http://127.0.0.1:$PORT/" |
      grep -qi '^x-agent-inbox-local-boundary: loopback-v1'; then
    break
  fi
  sleep 1
done

curl -fsSI "http://127.0.0.1:$PORT/" |
  grep -qi '^x-agent-inbox-local-boundary: loopback-v1'
grep -Fq 'viewer running in-process' "$LOG"
if grep -Fq 'falling back to spawning node' "$LOG"; then
  cat "$LOG" >&2
  echo "smoke-linux-appimage: packaged Electron fell back to a host runtime" >&2
  exit 1
fi
assert_chromium_sandbox
