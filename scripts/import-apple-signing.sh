#!/bin/bash
set -euo pipefail
set +x

COMMAND="${1:-}"
STATE_DIR="${APPLE_SIGNING_STATE_DIR:-${RUNNER_TEMP:-}/agent-inbox-signing}"
SECURITY_BIN="${APPLE_SECURITY_BIN:-/usr/bin/security}"
KEYCHAIN="$STATE_DIR/agent-inbox.keychain-db"
P12="$STATE_DIR/developer-id.p12"
ORIGINAL_KEYCHAINS="$STATE_DIR/original-user-keychains"
ORIGINAL_KEYCHAINS_TMP="$STATE_DIR/original-user-keychains.tmp"

if [[ -z "$STATE_DIR" || "$STATE_DIR" == /agent-inbox-signing ]]; then
  echo "import-apple-signing: APPLE_SIGNING_STATE_DIR or RUNNER_TEMP is required" >&2
  exit 1
fi
if [[ "$SECURITY_BIN" != /* || ! -x "$SECURITY_BIN" ]]; then
  echo "import-apple-signing: security executable must be an absolute executable path" >&2
  exit 1
fi

read_saved_keychains() {
  local line
  SAVED_KEYCHAINS=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    if [[ "$line" != \"*\" || "$line" != *\" ]]; then
      echo "import-apple-signing: invalid saved user keychain search list" >&2
      return 1
    fi
    line="${line#\"}"
    line="${line%\"}"
    if [[ -z "$line" ]]; then
      echo "import-apple-signing: invalid empty keychain in saved search list" >&2
      return 1
    fi
    SAVED_KEYCHAINS[${#SAVED_KEYCHAINS[@]}]="$line"
  done < "$ORIGINAL_KEYCHAINS"
}

capture_original_keychains() {
  rm -f "$ORIGINAL_KEYCHAINS_TMP"
  "$SECURITY_BIN" list-keychains -d user > "$ORIGINAL_KEYCHAINS_TMP"
  mv "$ORIGINAL_KEYCHAINS_TMP" "$ORIGINAL_KEYCHAINS"
  read_saved_keychains
}

restore_original_keychains() {
  read_saved_keychains
  if [[ "${#SAVED_KEYCHAINS[@]}" -eq 0 ]]; then
    "$SECURITY_BIN" list-keychains -d user -s
  else
    "$SECURITY_BIN" list-keychains -d user -s "${SAVED_KEYCHAINS[@]}"
  fi
}

activate_signing_keychain() {
  if [[ "${#SAVED_KEYCHAINS[@]}" -eq 0 ]]; then
    "$SECURITY_BIN" list-keychains -d user -s "$KEYCHAIN"
  else
    "$SECURITY_BIN" list-keychains -d user -s "$KEYCHAIN" "${SAVED_KEYCHAINS[@]}"
  fi
}

cleanup() {
  local failed=0
  if [[ -e "$ORIGINAL_KEYCHAINS" ]]; then
    restore_original_keychains || failed=1
  elif [[ -e "$KEYCHAIN" ]]; then
    echo "import-apple-signing: original user keychain search list is unavailable" >&2
    failed=1
  fi
  if [[ -e "$KEYCHAIN" ]]; then
    "$SECURITY_BIN" delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || failed=1
  fi
  rm -f "$P12" "$KEYCHAIN" "$ORIGINAL_KEYCHAINS" "$ORIGINAL_KEYCHAINS_TMP"
  rmdir "$STATE_DIR" >/dev/null 2>&1 || true
  return "$failed"
}

cleanup_on_exit() {
  local status=$?
  trap - EXIT
  if ! cleanup && [[ "$status" == 0 ]]; then
    status=1
  fi
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
capture_original_keychains

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
activate_signing_keychain

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
