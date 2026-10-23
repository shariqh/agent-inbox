#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: smoke-linux-appimage.sh --appimage <path> --mode <fuse|extract> --port <port> --locale <ll_CC.UTF-8> --expect-lang <ll-CC>" >&2
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

# The app runs as a user of LOCALE (LANG below), but only US and British
# English ship (#292): Chromium must choose EXPECT_LANG and pass it to every
# renderer as --lang.
assert_renderer_locale() {
  local cmdline command renderers=0
  for cmdline in /proc/[0-9]*/cmdline; do
    [[ -r "$cmdline" ]] || continue
    command="$(tr '\0' ' ' < "$cmdline" 2>/dev/null || true)"
    [[ "$command" == *" --type=renderer "* ]] || continue
    if [[ "$command" != *" --lang=$EXPECT_LANG "* ]]; then
      echo "smoke-linux-appimage: a renderer runs with $(grep -o -- '--lang=[^ ]*' <<<"$command" || echo 'no --lang'), not --lang=$EXPECT_LANG" >&2
      return 1
    fi
    renderers=$((renderers + 1))
  done
  if [[ "$renderers" -eq 0 ]]; then
    echo "smoke-linux-appimage: no renderer showed which locale Chromium chose" >&2
    return 1
  fi
  echo "smoke-linux-appimage: every renderer ($renderers) runs with --lang=$EXPECT_LANG under LANG=$LOCALE"
}

APPIMAGE=""
MODE=""
PORT=""
LOCALE=""
EXPECT_LANG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --appimage) APPIMAGE="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --locale) LOCALE="${2:-}"; shift 2 ;;
    --expect-lang) EXPECT_LANG="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$APPIMAGE" && -x "$APPIMAGE" ]] || usage
[[ "$MODE" == "fuse" || "$MODE" == "extract" ]] || usage
[[ "$PORT" =~ ^[0-9]+$ ]] || usage
[[ "$LOCALE" =~ ^[a-z]{2}_[A-Z]{2}\.UTF-8$ ]] || usage
[[ "$EXPECT_LANG" =~ ^[a-z]{2}-[A-Z]{2}$ ]] || usage

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/agent-inbox-appimage-smoke.XXXXXX")"
chmod 0700 "$SCRATCH"
APP_PID=""
LOG=""
# Signals the app's whole process group and waits until no member is left.
# `wait` alone covers only xvfb-run: Electron's helpers (zygote, renderer, GPU,
# utility) can keep writing Local Storage, Cookies and the Crashpad database
# under the scratch home for a moment longer, so removing it at once raced
# them (#348). SIGTERM, then up to ~10 s; SIGKILL, then up to ~2 s more.
stop_app_group() {
  local pgid="$1" i
  kill -TERM -- "-$pgid" >/dev/null 2>&1 || true
  for ((i = 0; i < 100; i++)); do
    kill -0 -- "-$pgid" >/dev/null 2>&1 || break
    sleep 0.1
  done
  if kill -0 -- "-$pgid" >/dev/null 2>&1; then
    echo "smoke-linux-appimage: process group $pgid outlived SIGTERM; sending SIGKILL" >&2
    kill -KILL -- "-$pgid" >/dev/null 2>&1 || true
    for ((i = 0; i < 20; i++)); do
      kill -0 -- "-$pgid" >/dev/null 2>&1 || break
      sleep 0.1
    done
  fi
  wait "$pgid" >/dev/null 2>&1 || true
  if kill -0 -- "-$pgid" >/dev/null 2>&1; then
    echo "smoke-linux-appimage: process group $pgid still has members after SIGKILL" >&2
  fi
}

# Removes a directory, retrying while a straggler may still be writing to it.
remove_scratch() {
  local dir="$1" attempt
  for ((attempt = 0; attempt < 4; attempt++)); do
    rm -rf "$dir" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  rm -rf "$dir"
}

# Runs as the EXIT trap. It must neither replace a real failure's status nor
# turn success into failure while the scratch home can still be removed, so
# it turns errexit off and always ends with an explicit exit.
cleanup() {
  local status=$?
  set +e
  if [[ "$status" -ne 0 && -f "$LOG" ]]; then
    cat "$LOG" >&2
  fi
  if [[ -n "$APP_PID" ]]; then
    stop_app_group "$APP_PID"
  fi
  mounted=0
  for mount in "$SCRATCH"/tmp/.mount_*; do
    if command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$mount"; then
      fusermount -uz "$mount" >/dev/null 2>&1 || true
      if mountpoint -q "$mount"; then
        mounted=1
      fi
    fi
  done
  if [[ "$mounted" -eq 0 ]]; then
    if ! remove_scratch "$SCRATCH"; then
      echo "smoke-linux-appimage: could not remove scratch directory $SCRATCH" >&2
      if [[ "$status" -eq 0 ]]; then
        status=1
      fi
    fi
  else
    echo "smoke-linux-appimage: retained mounted scratch path $SCRATCH" >&2
  fi
  exit "$status"
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
  -u LANGUAGE
  -u LC_ALL
  -u LC_MESSAGES
  "HOME=$SCRATCH/home"
  "XDG_CONFIG_HOME=$SCRATCH/config"
  "XDG_CACHE_HOME=$SCRATCH/cache"
  "XDG_DATA_HOME=$SCRATCH/data"
  "XDG_STATE_HOME=$SCRATCH/state"
  "TMPDIR=$SCRATCH/tmp"
  "AGENT_INBOX_DB=$SCRATCH/state/inbox.db"
  "AGENT_INBOX_PORT=$PORT"
  "LANG=$LOCALE"
)
if [[ "$MODE" == "extract" ]]; then
  launch+=("APPIMAGE_EXTRACT_AND_RUN=1")
fi

setsid xvfb-run -a "${launch[@]}" "$APPIMAGE" >"$LOG" 2>&1 &
APP_PID=$!
# Cache preparation can keep renderer startup behind the server's readiness.
for _ in {1..90}; do
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    echo "smoke-linux-appimage: application exited before the viewer and sandbox were ready" >&2
    exit 1
  fi
  if curl -fsSI "http://127.0.0.1:$PORT/" |
      grep -qi '^x-agent-inbox-local-boundary: loopback-v1' &&
      assert_chromium_sandbox 2>/dev/null; then
    break
  fi
  sleep 1
done

curl -fsSI "http://127.0.0.1:$PORT/" |
  grep -qi '^x-agent-inbox-local-boundary: loopback-v1'
assert_chromium_sandbox
for _ in {1..30}; do
  assert_renderer_locale >/dev/null 2>&1 && break
  sleep 1
done
assert_renderer_locale
