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

cd "$ROOT"
npm run build

rm -rf "$STAGE"
mkdir -p "$STAGE/docs"
cp -R "$ROOT/dist" "$ROOT/public" "$ROOT/electron" "$STAGE/"
cp "$ROOT/docs/reporting-snippet.md" "$STAGE/docs/"

# Bake, for the in-app Setup section:
#  · the agent-registration paths — the packaged app cannot host the MCP server
#    (Electron-ABI native module), so agents run it from this repo checkout
#    under this Node binary;
#  · WHICH BUILD THIS IS (issue #40) — the commit and the build time. The viewer
#    compares the commit against $ROOT's live HEAD and says so when the bundle
#    has fallen behind. If git cannot answer, the commit is omitted, never guessed.
node "$ROOT/scripts/write-setup-info.mjs" "$ROOT" "$STAGE/setup-info.json"

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
npm install --omit=dev --no-audit --no-fund --min-release-age=0
npx --yes @electron/rebuild -f -w better-sqlite3 -v "$ELECTRON_VERSION" -m "$STAGE"

cd "$ROOT"
# --no-asar: the server chdirs into the app dir and serves ./public from the
# real filesystem — neither works from inside an asar archive.
npx --yes @electron/packager "$STAGE" "Agent Inbox" \
  --platform=darwin --arch=arm64 --out="$OUT" --overwrite --no-asar \
  --icon="$ROOT/electron/icon.icns" \
  --app-bundle-id=io.github.shariqh.agent-inbox

# Electron requires alert-style notifications for native action buttons on
# macOS. Write the key before signing so the signature covers the final plist.
APP="$OUT/Agent Inbox-darwin-arm64/Agent Inbox.app"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :NSUserNotificationAlertStyle alert" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSUserNotificationAlertStyle string alert" "$PLIST"

# Ad-hoc codesign: macOS silently drops notifications from apps with no code
# identity at all. No certificate needed; "-" signs with an ad-hoc identity.
codesign --force --deep --sign - "$APP"

echo
echo "Packaged (ad-hoc signed): $APP"
