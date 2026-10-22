#!/usr/bin/env bash
# Deterministically derive browser, macOS, and Windows icon assets from assets/icon.svg
# and the tiny single-color derivative in assets/icon-mark.svg.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK=true
elif [[ $# -gt 0 ]]; then
  echo "usage: npm run generate:icons [-- --check]" >&2
  exit 2
fi

for tool in iconutil shasum sips cmp node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "generate-icons: required tool '$tool' is unavailable" >&2
    exit 1
  fi
done
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "generate-icons: iconutil requires macOS" >&2
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-inbox-icons.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
ICONSET="$TMP/AgentInbox.iconset"
mkdir -p "$ICONSET" "$TMP/public" "$TMP/assets" "$TMP/electron"

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

if $CHECK; then
  MANIFEST="$ROOT/assets/icon-manifest.json"
  [[ -f "$MANIFEST" ]] || {
    echo "generate-icons: missing assets/icon-manifest.json" >&2
    exit 1
  }
  manifest_hash() {
    node -e '
      const manifest = require(process.argv[1])
      const value = process.argv[2].split(".").reduce((current, key) => current?.[key], manifest)
      if (typeof value !== "string") process.exit(1)
      process.stdout.write(value)
    ' "$MANIFEST" "$1"
  }
  check_hash() {
    local key="$1" file="$2"
    [[ -f "$file" ]] && [[ "$(sha256 "$file")" == "$(manifest_hash "$key")" ]] || {
      echo "generate-icons: stale or missing ${file#"$ROOT/"}" >&2
      return 1
    }
  }
  stale=false
  check_hash "sources.icon" "$ROOT/assets/icon.svg" || stale=true
  check_hash "sources.mark" "$ROOT/assets/icon-mark.svg" || stale=true
  check_hash "outputs.icon1024" "$ROOT/assets/icon-1024.png" || stale=true
  check_hash "outputs.faviconSvg" "$ROOT/public/favicon.svg" || stale=true
  check_hash "outputs.favicon16" "$ROOT/public/favicon-16.png" || stale=true
  check_hash "outputs.favicon32" "$ROOT/public/favicon-32.png" || stale=true
  check_hash "outputs.markSvg" "$ROOT/public/icon-mark.svg" || stale=true
  check_hash "outputs.icns" "$ROOT/electron/icon.icns" || stale=true
  check_hash "outputs.ico" "$ROOT/electron/icon.ico" || stale=true
  cmp -s "$ROOT/assets/icon.svg" "$ROOT/public/favicon.svg" || {
    echo "generate-icons: public/favicon.svg does not match assets/icon.svg" >&2
    stale=true
  }
  cmp -s "$ROOT/assets/icon-mark.svg" "$ROOT/public/icon-mark.svg" || {
    echo "generate-icons: public/icon-mark.svg does not match assets/icon-mark.svg" >&2
    stale=true
  }
  dimensions() {
    sips -g pixelWidth -g pixelHeight "$1" 2>/dev/null |
      awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w "x" h}'
  }
  [[ "$(dimensions "$ROOT/assets/icon-1024.png")" == "1024x1024" ]] || stale=true
  [[ "$(dimensions "$ROOT/public/favicon-16.png")" == "16x16" ]] || stale=true
  [[ "$(dimensions "$ROOT/public/favicon-32.png")" == "32x32" ]] || stale=true
  iconutil --convert iconset --output "$ICONSET" "$ROOT/electron/icon.icns"
  for rep in \
    icon_16x16.png icon_16x16@2x.png \
    icon_32x32.png icon_32x32@2x.png \
    icon_128x128.png icon_128x128@2x.png \
    icon_256x256.png icon_256x256@2x.png \
    icon_512x512.png icon_512x512@2x.png; do
    [[ -f "$ICONSET/$rep" ]] || stale=true
  done
  $stale && exit 1
  exit 0
fi

command -v rsvg-convert >/dev/null 2>&1 || {
  echo "generate-icons: required tool 'rsvg-convert' is unavailable" >&2
  exit 1
}

render() {
  local source="$1" size="$2" output="$3"
  rsvg-convert --width "$size" --height "$size" --keep-aspect-ratio \
    --output "$output" "$source"
}

render "$ROOT/assets/icon.svg" 1024 "$TMP/assets/icon-1024.png"
cp "$ROOT/assets/icon.svg" "$TMP/public/favicon.svg"
cp "$ROOT/assets/icon-mark.svg" "$TMP/public/icon-mark.svg"
render "$ROOT/assets/icon.svg" 16 "$TMP/public/favicon-16.png"
render "$ROOT/assets/icon.svg" 32 "$TMP/public/favicon-32.png"
render "$ROOT/assets/icon.svg" 256 "$TMP/electron/icon-256.png"

render "$ROOT/assets/icon.svg" 16 "$ICONSET/icon_16x16.png"
render "$ROOT/assets/icon.svg" 32 "$ICONSET/icon_16x16@2x.png"
render "$ROOT/assets/icon.svg" 32 "$ICONSET/icon_32x32.png"
render "$ROOT/assets/icon.svg" 64 "$ICONSET/icon_32x32@2x.png"
render "$ROOT/assets/icon.svg" 128 "$ICONSET/icon_128x128.png"
render "$ROOT/assets/icon.svg" 256 "$ICONSET/icon_128x128@2x.png"
render "$ROOT/assets/icon.svg" 256 "$ICONSET/icon_256x256.png"
render "$ROOT/assets/icon.svg" 512 "$ICONSET/icon_256x256@2x.png"
render "$ROOT/assets/icon.svg" 512 "$ICONSET/icon_512x512.png"
render "$ROOT/assets/icon.svg" 1024 "$ICONSET/icon_512x512@2x.png"
iconutil --convert icns --output "$TMP/electron/icon.icns" "$ICONSET"
node "$ROOT/scripts/build-windows-ico.mjs" "$TMP/electron/icon.ico" \
  "$TMP/public/favicon-16.png" "$TMP/public/favicon-32.png" "$TMP/electron/icon-256.png"
rm "$TMP/electron/icon-256.png"

cat > "$TMP/assets/icon-manifest.json" <<EOF
{
  "schema": 1,
  "sources": {
    "icon": "$(sha256 "$ROOT/assets/icon.svg")",
    "mark": "$(sha256 "$ROOT/assets/icon-mark.svg")"
  },
  "outputs": {
    "icon1024": "$(sha256 "$TMP/assets/icon-1024.png")",
    "faviconSvg": "$(sha256 "$TMP/public/favicon.svg")",
    "favicon16": "$(sha256 "$TMP/public/favicon-16.png")",
    "favicon32": "$(sha256 "$TMP/public/favicon-32.png")",
    "markSvg": "$(sha256 "$TMP/public/icon-mark.svg")",
    "icns": "$(sha256 "$TMP/electron/icon.icns")",
    "ico": "$(sha256 "$TMP/electron/icon.ico")"
  }
}
EOF

outputs=(
  "assets/icon-1024.png"
  "assets/icon-manifest.json"
  "public/favicon.svg"
  "public/favicon-16.png"
  "public/favicon-32.png"
  "public/icon-mark.svg"
  "electron/icon.icns"
  "electron/icon.ico"
)

for output in "${outputs[@]}"; do
  mkdir -p "$(dirname "$ROOT/$output")"
  mv "$TMP/$output" "$ROOT/$output"
done
