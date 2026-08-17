#!/bin/bash
set -euo pipefail
set +x

COMMAND="${1:-}"
STATE_DIR="${APPLE_SIGNING_STATE_DIR:-${RUNNER_TEMP:-}/agent-inbox-signing}"
SECURITY_BIN="${APPLE_SECURITY_BIN:-/usr/bin/security}"
KEYCHAIN="$STATE_DIR/agent-inbox.keychain-db"
P12="$STATE_DIR/developer-id.p12"

if [[ -z "$STATE_DIR" || "$STATE_DIR" == /agent-inbox-signing ]]; then
  echo "import-apple-signing: APPLE_SIGNING_STATE_DIR or RUNNER_TEMP is required" >&2
  exit 1
fi
if [[ "$SECURITY_BIN" != /* || ! -x "$SECURITY_BIN" ]]; then
  echo "import-apple-signing: security executable must be an absolute executable path" >&2
  exit 1
fi

cleanup() {
  local failed=0
  if [[ -e "$KEYCHAIN" ]]; then
    "$SECURITY_BIN" delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || failed=1
  fi
  rm -f "$P12" "$KEYCHAIN"
  rmdir "$STATE_DIR" >/dev/null 2>&1 || true
  return "$failed"
}

cleanup_on_exit() {
  local status=$?
  cleanup || true
  exit "$status"
}

if [[ "$COMMAND" == cleanup ]]; then
  cleanup
  exit
fi
if [[ "$COMMAND" != import ]]; then
  echo "usage: import-apple-signing.sh import|cleanup" >&2
  exit 1
fi

node scripts/macos-release-gates.mjs credentials --scope signing >/dev/null
umask 077
mkdir -p "$STATE_DIR"
trap cleanup_on_exit EXIT

node -e '
  const fs = require("node:fs")
  const value = process.env.APPLE_DEVELOPER_ID_P12_BASE64
  const bytes = Buffer.from(value, "base64")
  if (!bytes.length || bytes.toString("base64") !== value) process.exit(1)
  fs.writeFileSync(process.argv[1], bytes, { mode: 0o600 })
' "$P12"

KEYCHAIN_PASSWORD="$(/usr/bin/openssl rand -hex 32)"
"$SECURITY_BIN" create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
"$SECURITY_BIN" set-keychain-settings -lut 21600 "$KEYCHAIN"
"$SECURITY_BIN" unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
"$SECURITY_BIN" import "$P12" \
  -k "$KEYCHAIN" \
  -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" \
  -T /usr/bin/codesign
"$SECURITY_BIN" set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null

IDENTITIES="$("$SECURITY_BIN" find-identity -v -p codesigning "$KEYCHAIN")"
MATCH_COUNT="$(grep -Fc "\"$APPLE_DEVELOPER_IDENTITY\"" <<<"$IDENTITIES" || true)"
if [[ "$MATCH_COUNT" != 1 ]]; then
  echo "import-apple-signing: expected exactly one matching Developer ID identity" >&2
  exit 1
fi
CERT_SUBJECT="$("$SECURITY_BIN" find-certificate -c "$APPLE_DEVELOPER_IDENTITY" -p "$KEYCHAIN" |
  /usr/bin/openssl x509 -noout -subject)"
if ! printf '%s\n' "$CERT_SUBJECT" | grep -Eq "OU[[:space:]]*=[[:space:]]*$APPLE_TEAM_ID([,/]|$)"; then
  echo "import-apple-signing: certificate team does not match APPLE_TEAM_ID" >&2
  exit 1
fi

rm -f "$P12"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'keychain=%s\n' "$KEYCHAIN"
    printf 'identity=%s\n' "$APPLE_DEVELOPER_IDENTITY"
    printf 'team=%s\n' "$APPLE_TEAM_ID"
  } >> "$GITHUB_OUTPUT"
fi
trap - EXIT
