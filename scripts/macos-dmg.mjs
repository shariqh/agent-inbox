// The one way a macOS release DMG is built (#289). assemble-macos-release.mjs makes
// the provisional DMG and `macos-release-gates.mjs build-dmg` makes the final DMG
// from the stapled app; both call createReleaseDmg(), so they share one layout and
// one format.
import { execFileSync } from 'node:child_process'

// lzma-compressed UDIF. The v1.5.0 DMG measured 338.7 MB as zlib (UDZO) and
// 254.4 MB as ULMO. ULMO needs macOS 10.15, below the app's 13.5 minimum, and the
// in-app updater of every release since 1.3.0 attaches it with its fixed hdiutil
// flags (read-only, checksums verified) exactly as it attached UDZO.
const RELEASE_DMG_FORMAT = 'ULMO'

// Fails closed unless hdiutil reports the release format, so a builder that ignored
// the requested format can never reach signing or notarization.
export function requireReleaseDmgFormat(dmg) {
  // Only the format goes to stdout; newer macOS adds a deprecation warning on stderr.
  const format = execFileSync('/usr/bin/hdiutil', ['imageinfo', '-format', dmg], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  }).trim()
  if (format !== RELEASE_DMG_FORMAT) {
    throw new Error(`${dmg} is ${format || 'an unknown format'}, not ${RELEASE_DMG_FORMAT}`)
  }
  return format
}

export async function createReleaseDmg({ app, title, icon, output }) {
  // Imported on use: the release gates also run where node_modules is absent.
  const { createDMG } = await import('electron-installer-dmg')
  // appdmg (behind electron-installer-dmg) accepts ULMO and hands it to
  // `hdiutil convert -format`, so the image is compressed once, straight to lzma.
  await createDMG({
    appPath: app,
    name: 'Agent Inbox',
    title,
    icon,
    iconSize: 96,
    format: RELEASE_DMG_FORMAT,
    overwrite: false,
    dmgPath: output,
    contents: [
      { x: 180, y: 220, type: 'file', path: app },
      { x: 480, y: 220, type: 'link', path: '/Applications' },
    ],
  })
  requireReleaseDmgFormat(output)
  return output
}
