#!/bin/bash
set -euo pipefail
set +x

KIND="${1:-}"
SUBMITTED="${2:-}"
STAPLE_TARGET="${3:-}"
RECEIPT="${4:-}"
XCRUN_BIN="${APPLE_XCRUN_BIN:-/usr/bin/xcrun}"
if [[ "$KIND" != app && "$KIND" != dmg ]] || [[ -z "$SUBMITTED" || -z "$STAPLE_TARGET" || -z "$RECEIPT" ]]; then
  echo "usage: notarize-macos.sh app|dmg SUBMITTED STAPLE_TARGET RECEIPT" >&2
  exit 1
fi
if [[ "$XCRUN_BIN" != /* || ! -x "$XCRUN_BIN" ]]; then
  echo "notarize-macos: xcrun executable must be an absolute executable path" >&2
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

"$XCRUN_BIN" stapler staple "$STAPLE_TARGET"
"$XCRUN_BIN" stapler validate "$STAPLE_TARGET"
