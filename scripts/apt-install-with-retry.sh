#!/usr/bin/env bash
set -euo pipefail

readonly MAX_ATTEMPTS=3
readonly RETRY_DELAY_SECONDS="${APT_RETRY_DELAY_SECONDS:-5}"
readonly APT_LISTS_DIR="${APT_LISTS_DIR:-/var/lib/apt/lists}"

if (( $# == 0 )); then
  echo "usage: apt-install-with-retry.sh PACKAGE..." >&2
  exit 2
fi
if [[ ! "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "apt-install-with-retry: APT_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 2
fi
if [[ "$APT_LISTS_DIR" != /* || "$APT_LISTS_DIR" == / ]]; then
  echo "apt-install-with-retry: APT_LISTS_DIR must be an absolute non-root path" >&2
  exit 2
fi

for (( attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1 )); do
  echo "apt-install-with-retry: attempt $attempt/$MAX_ATTEMPTS" >&2
  if apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; then
    exit 0
  else
    status=$?
  fi

  if (( attempt == MAX_ATTEMPTS )); then
    echo "apt-install-with-retry: failed after $MAX_ATTEMPTS attempts (last exit $status)" >&2
    exit "$status"
  fi

  echo "apt-install-with-retry: attempt $attempt/$MAX_ATTEMPTS failed; clearing APT caches before retry" >&2
  apt-get clean
  rm -rf -- "${APT_LISTS_DIR:?}/"*
  sleep "$((RETRY_DELAY_SECONDS * attempt))"
done
