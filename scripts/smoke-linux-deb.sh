#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: smoke-linux-deb.sh --app-root <dir> --launcher <path> --mode <launcher|desktop> --port <port>
                           [--desktop <path>] [--offline] [--home <persistent-dir>]

--home is optional. Omitted, an ephemeral mktemp HOME is used (fully
isolated, explicit AGENT_INBOX_DB, removed on exit). Given, that exact
directory is created if missing, used as HOME as-is, left in place on exit,
and the app is allowed to create its own default `$HOME/.agent-inbox` — this
is how a caller proves that directory survives a later dpkg purge.
USAGE
  exit 2
}

# The chrome-sandbox helper MUST be root-owned mode 4755 at the exact
# installed path; an unprivileged Chromium child self-elevates through it,
# never through --no-sandbox/--disable-setuid-sandbox (both rejected below).
assert_chrome_sandbox() {
  local sandbox="$1"
  [[ -e "$sandbox" ]] || {
    echo "smoke-linux-deb: chrome-sandbox is missing at $sandbox" >&2
    return 1
  }
  local mode owner
  mode="$(stat -c '%a' "$sandbox")"
  owner="$(stat -c '%u' "$sandbox")"
  [[ "$mode" == "4755" ]] || {
    echo "smoke-linux-deb: chrome-sandbox mode is $mode, expected 4755 at $sandbox" >&2
    return 1
  }
  [[ "$owner" == "0" ]] || {
    echo "smoke-linux-deb: chrome-sandbox owner uid is $owner, expected 0 at $sandbox" >&2
    return 1
  }
}

# Confirms the .desktop launcher entry and its referenced icon are actually
# installed, not merely present in package metadata.
assert_desktop_entry() {
  local desktop="$1"
  [[ -f "$desktop" ]] || {
    echo "smoke-linux-deb: desktop entry is missing at $desktop" >&2
    return 1
  }
  grep -Eq '^Exec=' "$desktop" || {
    echo "smoke-linux-deb: desktop entry has no Exec= line" >&2
    return 1
  }
  local icon_name
  icon_name="$(sed -n 's/^Icon=//p' "$desktop" | head -n1)"
  [[ -n "$icon_name" ]] || {
    echo "smoke-linux-deb: desktop entry has no Icon= line" >&2
    return 1
  }
  if [[ "$icon_name" = /* ]]; then
    [[ -f "$icon_name" ]] || {
      echo "smoke-linux-deb: desktop icon path is missing: $icon_name" >&2
      return 1
    }
  else
    local found=0
    while IFS= read -r -d '' candidate; do
      found=1
      break
    done < <(find /usr/share/icons /usr/share/pixmaps -type f \
      \( -name "${icon_name}.png" -o -name "${icon_name}.svg" -o -name "${icon_name}.xpm" \) \
      -print0 2>/dev/null)
    [[ "$found" == 1 ]] || {
      echo "smoke-linux-deb: no installed icon file found for Icon=$icon_name" >&2
      return 1
    }
  fi
}

# Parses the Exec= line of a .desktop entry into an argv array, stripping the
# standard field codes (%f %F %u %U %i %c %k) rather than passing them
# through literally to the launched process.
desktop_exec_argv() {
  local desktop="$1" line
  line="$(sed -n 's/^Exec=//p' "$desktop" | head -n1)"
  [[ -n "$line" ]] || return 1
  line="${line//%f/}"
  line="${line//%F/}"
  line="${line//%u/}"
  line="${line//%U/}"
  line="${line//%i/}"
  line="${line//%c/}"
  line="${line//%k/}"
  # shellcheck disable=SC2086
  read -r -a DESKTOP_ARGV <<< "$line"
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
  echo "smoke-linux-deb: no Chromium child demonstrated userns plus seccomp sandboxing" >&2
  return 1
}

APP_ROOT=""
LAUNCHER=""
DESKTOP=""
MODE=""
PORT=""
OFFLINE=0
HOME_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-root) APP_ROOT="${2:-}"; shift 2 ;;
    --launcher) LAUNCHER="${2:-}"; shift 2 ;;
    --desktop) DESKTOP="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --offline) OFFLINE=1; shift 1 ;;
    --home) HOME_ARG="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -d "$APP_ROOT" ]] || usage
[[ -f "$LAUNCHER" && -x "$LAUNCHER" ]] || usage
[[ "$MODE" == "launcher" || "$MODE" == "desktop" ]] || usage
[[ "$PORT" =~ ^[0-9]+$ ]] || usage
if [[ "$MODE" == "desktop" ]]; then
  [[ -n "$DESKTOP" ]] || usage
fi

assert_chrome_sandbox "$APP_ROOT/chrome-sandbox"
if [[ -n "$DESKTOP" ]]; then
  assert_desktop_entry "$DESKTOP"
fi

LAUNCH_ARGV=()
if [[ "$MODE" == "launcher" ]]; then
  LAUNCH_ARGV=("$LAUNCHER")
else
  desktop_exec_argv "$DESKTOP"
  LAUNCH_ARGV=("${DESKTOP_ARGV[@]}")
fi

# A caller-supplied --home is treated as PERSISTENT evidence: it is created
# (not wiped) if missing and never removed on exit, and the app is left to
# create its own true default `$HOME/.agent-inbox` rather than an
# AGENT_INBOX_DB override — this is what lets a workflow launch once, then
# assert `~/.agent-inbox` (the DB sentinel) survives a later dpkg purge.
# Without --home, a throwaway mktemp scratch dir is used and fully isolated
# (including an explicit AGENT_INBOX_DB override) and removed on exit.
PERSISTENT_HOME=0
if [[ -n "$HOME_ARG" ]]; then
  PERSISTENT_HOME=1
  SCRATCH="$HOME_ARG"
  mkdir -p "$SCRATCH"
  chmod 0700 "$SCRATCH"
else
  SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/agent-inbox-deb-smoke.XXXXXX")"
  chmod 0700 "$SCRATCH"
fi
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
  if [[ "$PERSISTENT_HOME" == 0 ]]; then
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

mkdir -p \
  "$SCRATCH/.config" \
  "$SCRATCH/.cache" \
  "$SCRATCH/.local/share" \
  "$SCRATCH/.local/state" \
  "$SCRATCH/.tmp"
chmod 0700 "$SCRATCH/.tmp"
LOG="$SCRATCH/.tmp/app.log"
if ! unshare --user --map-root-user true; then
  echo "smoke-linux-deb: unprivileged user namespaces are required" >&2
  exit 1
fi

launch=(
  env
  "HOME=$SCRATCH"
  "XDG_CONFIG_HOME=$SCRATCH/.config"
  "XDG_CACHE_HOME=$SCRATCH/.cache"
  "XDG_DATA_HOME=$SCRATCH/.local/share"
  "XDG_STATE_HOME=$SCRATCH/.local/state"
  "TMPDIR=$SCRATCH/.tmp"
  "AGENT_INBOX_PORT=$PORT"
)
if [[ "$PERSISTENT_HOME" == 0 ]]; then
  # Fully ephemeral runs pin the DB path explicitly too, so cleanup never
  # depends on the app's own default resolution.
  launch+=("AGENT_INBOX_DB=$SCRATCH/.local/state/inbox.db")
fi

setsid xvfb-run -a "${launch[@]}" "${LAUNCH_ARGV[@]}" >"$LOG" 2>&1 &
APP_PID=$!
for _ in {1..90}; do
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    echo "smoke-linux-deb: application exited before the viewer responded" >&2
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
assert_chromium_sandbox

if [[ "$OFFLINE" == 1 ]]; then
  kill -- "-$APP_PID" >/dev/null 2>&1 || true
  wait "$APP_PID" >/dev/null 2>&1 || true
  APP_PID=""

  OFFLINE_PORT=$((PORT + 1))
  if curl -fsS --max-time 2 http://93.184.216.34/ >/dev/null 2>&1; then
    echo "smoke-linux-deb: external network unexpectedly reachable during offline gate" >&2
    exit 1
  fi

  OFFLINE_HOME="$SCRATCH/.tmp/offline-home"
  OFFLINE_LOG="$SCRATCH/.tmp/offline-app.log"
  mkdir -p "$OFFLINE_HOME/.tmp"
  chmod 0700 "$OFFLINE_HOME/.tmp"
  setsid xvfb-run -a env \
    "HOME=$OFFLINE_HOME" \
    "XDG_CONFIG_HOME=$OFFLINE_HOME/.config" \
    "XDG_CACHE_HOME=$OFFLINE_HOME/.cache" \
    "XDG_DATA_HOME=$OFFLINE_HOME/.local/share" \
    "XDG_STATE_HOME=$OFFLINE_HOME/.local/state" \
    "TMPDIR=$OFFLINE_HOME/.tmp" \
    "AGENT_INBOX_DB=$OFFLINE_HOME/inbox.db" \
    "AGENT_INBOX_PORT=$OFFLINE_PORT" \
    "${LAUNCH_ARGV[@]}" >"$OFFLINE_LOG" 2>&1 &
  APP_PID=$!
  ok=0
  for _ in {1..90}; do
    if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
      break
    fi
    if curl -fsSI "http://127.0.0.1:$OFFLINE_PORT/" |
        grep -qi '^x-agent-inbox-local-boundary: loopback-v1'; then
      ok=1
      break
    fi
    sleep 1
  done
  [[ "$ok" == 1 ]] || {
    cat "$OFFLINE_LOG" >&2
    echo "smoke-linux-deb: offline relaunch never served the loopback marker" >&2
    exit 1
  }
fi
