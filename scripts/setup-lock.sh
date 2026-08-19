#!/usr/bin/env bash

# Source-only Setup lease. The calling installer owns fd 9 for its full
# transaction; do not invoke acquisition through a subshell or pipeline.
_AGENT_INBOX_SETUP_LOCK_HELD=0
_AGENT_INBOX_SETUP_LOCK_TOOL=""

acquire_setup_lock() {
  local caller="${1:-setup}"
  local lock_file="${AGENT_INBOX_INSTALL_LOCK_DIR:-$HOME/.agent-inbox/install-agents.lock}"
  local lock_dir
  local lock_kind
  local lock_tool
  local status

  if [ "$_AGENT_INBOX_SETUP_LOCK_HELD" -eq 1 ]; then
    return 0
  fi

  case "${OSTYPE:-unknown}" in
    darwin*)
      if [ -x /usr/bin/lockf ]; then
        lock_kind=lockf
        lock_tool=/usr/bin/lockf
      else
        lock_kind=flock
        lock_tool="$(command -v flock 2>/dev/null || true)"
        if [ -z "$lock_tool" ]; then
          echo "$caller: setup requires lockf or flock for safe concurrent installation" >&2
          return 1
        fi
      fi
      ;;
    linux*)
      lock_kind=flock
      lock_tool="$(command -v flock 2>/dev/null || true)"
      if [ -z "$lock_tool" ]; then
        echo "$caller: setup requires flock for safe concurrent installation" >&2
        return 1
      fi
      ;;
    *)
      echo "$caller: setup locking is unsupported on ${OSTYPE:-unknown}" >&2
      return 1
      ;;
  esac

  if [ -L "$lock_file" ] || { [ -e "$lock_file" ] && [ ! -f "$lock_file" ]; }; then
    echo "$caller: install lock path must be a regular file: $lock_file" >&2
    return 1
  fi

  lock_dir="${lock_file%/*}"
  if [ "$lock_dir" = "$lock_file" ]; then lock_dir=.; fi
  if ! mkdir -p "$lock_dir"; then
    echo "$caller: could not create install lock directory: $lock_dir" >&2
    return 1
  fi

  if [ -L "$lock_file" ] || { [ -e "$lock_file" ] && [ ! -f "$lock_file" ]; }; then
    echo "$caller: install lock path must be a regular file: $lock_file" >&2
    return 1
  fi

  if ! exec 9>> "$lock_file"; then
    echo "$caller: could not open install lock: $lock_file" >&2
    return 1
  fi

  if [ "$lock_kind" = lockf ]; then
    "$lock_tool" -s -t 0 9
    status=$?
  else
    "$lock_tool" -E 75 -n 9
    status=$?
  fi

  if [ "$status" -ne 0 ]; then
    exec 9>&-
    if [ "$status" -eq 75 ]; then
      echo "$caller: another setup is already running" >&2
    else
      echo "$caller: setup lock utility failed (exit $status)" >&2
    fi
    return 1
  fi

  _AGENT_INBOX_SETUP_LOCK_TOOL="$lock_tool"
  _AGENT_INBOX_SETUP_LOCK_HELD=1
}
