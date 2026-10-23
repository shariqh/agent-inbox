#!/usr/bin/env bash
# Build a self-contained "Agent Inbox.app" (macOS, no installer, no signing).
#
# The viewer server runs inside Electron's bundled Node, so better-sqlite3 must
# be compiled against Electron's ABI. That happens in an isolated staging dir
# (build/stage) so the repo's node_modules stays built for system Node 24 —
# `npm run view` / `npm test` keep working.
#
# The stage receives the same inputs as the release thin app, including the
# checked-in package.json + package-lock.json pair, and `npm ci` installs that
# lockfile's production graph. Like the release builders, it then drops what
# nothing loads at runtime from node_modules (#291) and every Electron locale
# but English from the packaged app (#292). Packaging stops if the staged or
# packaged graph differs from package-lock.json (#139).
#
# Usage: npm run package:app   (any Node; the app itself needs none)
set -euo pipefail

# Physical paths throughout: npm ci --prefix treats a symlinked prefix as a linked
# root, and nothing below may depend on how the checkout was reached.
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
STAGE="$ROOT/build/stage"
OUT="$ROOT/out"
ELECTRON_VERSION="$(node -p "require('$ROOT/node_modules/electron/package.json').version")"
# The checkout's lockfile-pinned rebuild, never whatever npx would fetch.
REBUILD="$ROOT/node_modules/.bin/electron-rebuild"
[ -x "$REBUILD" ] || {
  echo "package-app: $REBUILD is missing; run npm ci in the checkout first" >&2
  exit 1
}
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

# Without its staged manifest and lockfile, npm ci in the stage would walk up
# and reinstall the checkout itself, production-only.
require_staged_manifest() {
  [ -f "$STAGE/package.json" ] && [ -f "$STAGE/package-lock.json" ] || {
    echo "package-app: $STAGE is missing its staged package.json or package-lock.json; refusing to run npm ci" >&2
    exit 1
  }
}

# Check an installed tree against package-lock.json and require the check's own
# confirmation, so a check that silently did not run can never pass.
verify_graph() {
  local label="$1" app="$2" report
  report="$(node "$ROOT/scripts/package-app-stage.mjs" verify "$ROOT/package-lock.json" "$app" --label "$label")"
  case "$report" in
    "package-app: $label dependency graph matches package-lock.json: "*) printf '%s\n' "$report" ;;
    *)
      echo "package-app: the $label dependency graph check did not confirm $app" >&2
      exit 1
      ;;
  esac
}

# Prune the installed tree as the release builders do (#291), requiring the
# tool's own confirmation.
prune_modules() {
  local app="$1" report
  report="$(node "$ROOT/scripts/package-app-stage.mjs" prune "$app")"
  case "$report" in
    "package-app: pruned "*) printf '%s\n' "$report" ;;
    *)
      echo "package-app: pruning did not confirm $app" >&2
      exit 1
      ;;
  esac
}

# Keep only the English Electron locale, as the release builders do (#292),
# requiring the tool's own confirmation.
prune_locales() {
  local app="$1" report
  report="$(node "$ROOT/scripts/package-app-stage.mjs" locales "$app")"
  case "$report" in
    "package-app: kept only the English Electron locale in "*) printf '%s\n' "$report" ;;
    *)
      echo "package-app: locale pruning did not confirm $app" >&2
      exit 1
      ;;
  esac
}

cd "$ROOT"
npm run generate:icons -- --check
npm run build

rm -rf "$STAGE"
node "$ROOT/scripts/package-app-stage.mjs" stage "$ROOT" "$STAGE"
require_staged_manifest

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

cd "$STAGE"
# No install scripts and no prebuilds (#315): better-sqlite3's install script
# and electron-rebuild's default both unpack a cached or downloaded prebuild
# without checking a digest, so the addon is always compiled from the
# lockfile-pinned source.
npm ci --prefix "$STAGE" --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund
"$REBUILD" -f -w better-sqlite3 -v "$ELECTRON_VERSION" -m "$STAGE" --build-from-source
prune_modules "$STAGE"
verify_graph staged "$STAGE"

cd "$ROOT"
# --no-asar: the server chdirs into the app dir and serves ./public from the
# real filesystem — neither works from inside an asar archive.
# --no-prune: the staged manifest lists devDependencies that `npm ci --omit=dev`
# never installed; the verified tree is packaged as-is.
npx --yes @electron/packager "$STAGE" "Agent Inbox" \
  --platform=darwin --arch=arm64 --out="$OUT" --overwrite --no-asar --no-junk --no-prune \
  --icon="$ROOT/electron/icon.icns" \
  --app-bundle-id=io.github.shariqh.agent-inbox

APP="$OUT/Agent Inbox-darwin-arm64/Agent Inbox.app"
prune_locales "$APP"
verify_graph packaged "$APP/Contents/Resources/app"

# Electron requires alert-style notifications for native action buttons on
# macOS. Write the key before signing so the signature covers the final plist.
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
