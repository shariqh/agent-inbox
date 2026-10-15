#!/bin/bash
set -euo pipefail
set +x

KIND="${1:-}"
SUBMITTED="${2:-}"
STAPLE_TARGET="${3:-}"
RECEIPT="${4:-}"
XCRUN_BIN="${APPLE_XCRUN_BIN:-/usr/bin/xcrun}"
SLEEP_BIN="${STAPLER_RETRY_SLEEP_BIN:-/bin/sleep}"
if [[ "$KIND" != app && "$KIND" != dmg ]] || [[ -z "$SUBMITTED" || -z "$STAPLE_TARGET" || -z "$RECEIPT" ]]; then
  echo "usage: notarize-macos.sh app|dmg SUBMITTED STAPLE_TARGET RECEIPT" >&2
  exit 1
fi
if [[ "$XCRUN_BIN" != /* || ! -x "$XCRUN_BIN" ]]; then
  echo "notarize-macos: xcrun executable must be an absolute executable path" >&2
  exit 1
fi
if [[ "$SLEEP_BIN" != /* || ! -x "$SLEEP_BIN" ]]; then
  echo "notarize-macos: sleep executable must be an absolute executable path" >&2
  exit 1
fi

node scripts/macos-release-gates.mjs credentials --scope notary >/dev/null
WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/agent-inbox-notary.XXXXXX")"
KEY="$WORK/AuthKey_${APPLE_NOTARY_KEY_ID}.p8"
SUBMIT_JSON="$WORK/submit.json"
LOG_JSON="$WORK/log.json"
cleanup() {
  rm -f "$KEY" "$SUBMIT_JSON" "$LOG_JSON"
  rmdir "$WORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
umask 077

node -e '
  const fs = require("node:fs")
  const value = process.env.APPLE_NOTARY_PRIVATE_KEY_BASE64
  const bytes = Buffer.from(value, "base64")
  if (!bytes.length || bytes.toString("base64") !== value) process.exit(1)
  fs.writeFileSync(process.argv[1], bytes, { mode: 0o600 })
' "$KEY"

"$XCRUN_BIN" notarytool submit "$SUBMITTED" \
  --key "$KEY" \
  --key-id "$APPLE_NOTARY_KEY_ID" \
  --issuer "$APPLE_NOTARY_ISSUER_ID" \
  --wait \
  --output-format json > "$SUBMIT_JSON"
SUBMISSION_ID="$(node scripts/macos-release-gates.mjs submission-id --submit-json "$SUBMIT_JSON")"
"$XCRUN_BIN" notarytool log "$SUBMISSION_ID" "$LOG_JSON" \
  --key "$KEY" \
  --key-id "$APPLE_NOTARY_KEY_ID" \
  --issuer "$APPLE_NOTARY_ISSUER_ID"
node scripts/macos-release-gates.mjs receipt \
  --kind "$KIND" \
  --submitted "$SUBMITTED" \
  --submit-json "$SUBMIT_JSON" \
  --log-json "$LOG_JSON" \
  --output "$RECEIPT" >/dev/null

# Apple has already accepted the submission; stapler now only fetches and checks the
# ticket through Apple's CloudKit ticket service. Retry a dropped connection to that
# service, or a ticket it has not published yet, with bounded backoff. Any other
# failure stops at once with stapler's own output and exit status.
STAPLER_RETRY_DELAYS=(15 30 60 120)

stapler_failure_is_transient() {
  case "$1" in
    *NSURLErrorDomain* | *"network connection"* | *"CloudKit's response is inconsistent"* | *"Record not found"*)
      return 0
      ;;
  esac
  return 1
}

stapler_with_retry() {
  local attempt=1 attempts=$((${#STAPLER_RETRY_DELAYS[@]} + 1)) delay output status
  while true; do
    status=0
    output="$("$@" 2>&1)" || status=$?
    if [[ -n "$output" ]]; then
      printf '%s\n' "$output"
    fi
    if ((status == 0)); then
      return 0
    fi
    if ! stapler_failure_is_transient "$output"; then
      echo "notarize-macos: $2 $3 failed (exit $status) without a transient Apple network or ticket error; not retrying" >&2
      return "$status"
    fi
    if ((attempt == attempts)); then
      echo "notarize-macos: $2 $3 still failing after $attempts attempts (exit $status); giving up" >&2
      return "$status"
    fi
    delay="${STAPLER_RETRY_DELAYS[attempt - 1]}"
    echo "notarize-macos: $2 $3 attempt $attempt/$attempts hit a transient Apple ticket-service error (exit $status); retrying in ${delay}s" >&2
    "$SLEEP_BIN" "$delay"
    attempt=$((attempt + 1))
  done
}

stapler_with_retry "$XCRUN_BIN" stapler staple "$STAPLE_TARGET"
stapler_with_retry "$XCRUN_BIN" stapler validate "$STAPLE_TARGET"
