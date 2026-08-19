#!/usr/bin/env bash
# Build a self-contained "Agent Inbox.app" (macOS, no installer, no signing).
#
# The viewer server runs inside Electron's bundled Node, so better-sqlite3 must
# be compiled against Electron's ABI. That happens in an isolated staging dir
# (build/stage) so the repo's node_modules stays built for system Node 24 —
# `npm run view` / `npm test` keep working.
#
# Usage: npm run package:app   (any Node; the app itself needs none)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/build/stage"
OUT="$ROOT/out"
ELECTRON_VERSION="$(node -p "require('$ROOT/node_modules/electron/package.json').version")"
RUNTIME_ARM64="${AGENT_INBOX_RUNTIME_DARWIN_ARM64:-}"
RUNTIME_X64="${AGENT_INBOX_RUNTIME_DARWIN_X64:-}"
PORTABLE_RELEASE=0
if [ -n "$RUNTIME_ARM64" ] || [ -n "$RUNTIME_X64" ]; then
  [ -n "$RUNTIME_ARM64" ] && [ -n "$RUNTIME_X64" ] || {
    echo "package-app: portable staging requires both AGENT_INBOX_RUNTIME_DARWIN_ARM64 and AGENT_INBOX_RUNTIME_DARWIN_X64" >&2
    exit 1
  }
  PORTABLE_RELEASE=1
fi

cd "$ROOT"
npm run generate:icons -- --check
npm run build

rm -rf "$STAGE"
mkdir -p "$STAGE/docs"
cp -R "$ROOT/dist" "$ROOT/public" "$ROOT/electron" "$ROOT/release" "$STAGE/"
cp "$ROOT/docs/reporting-snippet.md" "$STAGE/docs/"

if [ "$PORTABLE_RELEASE" -eq 1 ]; then
  mkdir -p "$STAGE/runtime"
  cp -R "$RUNTIME_ARM64" "$STAGE/runtime/darwin-arm64"
  cp -R "$RUNTIME_X64" "$STAGE/runtime/darwin-x64"
  VERSION="$(node -p "require('$ROOT/package.json').version")"
  node "$ROOT/scripts/write-setup-info.mjs" --release "$STAGE/setup-info.json" \
    --version "$VERSION" --source-root "$ROOT" --payload-root "$STAGE" \
    --runtime-key darwin-arm64 \
    --runtime-key darwin-x64 \
    --payload darwin-arm64=runtime/darwin-arm64 \
    --payload darwin-x64=runtime/darwin-x64
else
  # Development package compatibility: keep the checkout-backed setup path.
  # Release callers must provide both architecture payloads above.
  node "$ROOT/scripts/write-setup-info.mjs" "$ROOT" "$STAGE/setup-info.json"
fi

# Minimal staged package.json: runtime deps only, entry at electron/main.cjs.
node -e "
const p = require('$ROOT/package.json')
const staged = {
  name: 'agent-inbox',
  productName: 'Agent Inbox',
  version: p.version,
  main: 'electron/main.cjs',
  dependencies: p.dependencies,
}
require('fs').writeFileSync('$STAGE/package.json', JSON.stringify(staged, null, 2))
"

cd "$STAGE"
npm install --omit=dev --no-audit --no-fund
npx --yes @electron/rebuild -f -w better-sqlite3 -v "$ELECTRON_VERSION" -m "$STAGE"

cd "$ROOT"
# --no-asar: the server chdirs into the app dir and serves ./public from the
# real filesystem — neither works from inside an asar archive.
npx --yes @electron/packager "$STAGE" "Agent Inbox" \
  --platform=darwin --arch=arm64 --out="$OUT" --overwrite --no-asar --no-junk \
  --icon="$ROOT/electron/icon.icns" \
  --app-bundle-id=io.github.shariqh.agent-inbox

# Electron requires alert-style notifications for native action buttons on
# macOS. Write the key before signing so the signature covers the final plist.
APP="$OUT/Agent Inbox-darwin-arm64/Agent Inbox.app"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :NSUserNotificationAlertStyle alert" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSUserNotificationAlertStyle string alert" "$PLIST"

if [ "$PORTABLE_RELEASE" -eq 1 ]; then
  # Intentionally unsigned in Layer 1. Layer 2 must finalize layout, sign every
  # nested runtime Mach-O, regenerate both manifests and setup-info, then sign
  # only the outer app without --deep and verify every signature/manifest.
  echo "Portable package staged unsigned; Layer 2 owns nested and outer signing."
else
  # Development compatibility only. Portable/release packages never use this
  # deep-sign path because it can mutate nested bytes after manifesting.
  codesign --force --deep --sign - "$APP"
fi

echo
if [ "$PORTABLE_RELEASE" -eq 1 ]; then
  echo "Packaged (portable, unsigned): $APP"
else
  echo "Packaged (development, ad-hoc signed): $APP"
fi
