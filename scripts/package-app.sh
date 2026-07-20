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

# Bake agent-registration paths for the in-app Setup section: the packaged app
# cannot host the MCP server (Electron-ABI native module), so agents run it
# from this repo checkout under this Node binary.
node -e "
require('fs').writeFileSync('$STAGE/setup-info.json', JSON.stringify({
  repoRoot: '$ROOT',
  nodeBin: process.execPath,
}, null, 2))
"

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
  --platform=darwin --arch=arm64 --out="$OUT" --overwrite --no-asar \
  --icon="$ROOT/electron/icon.icns" \
  --app-bundle-id=io.coreworx.agent-inbox

# Ad-hoc codesign: macOS silently drops notifications from apps with no code
# identity at all. No certificate needed; "-" signs with an ad-hoc identity.
codesign --force --deep --sign - "$OUT/Agent Inbox-darwin-arm64/Agent Inbox.app"

echo
echo "Packaged (ad-hoc signed): $OUT/Agent Inbox-darwin-arm64/Agent Inbox.app"
