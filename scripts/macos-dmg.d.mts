/** Throws unless hdiutil reports `dmg` as the release format (ULMO); returns that format. */
export function requireReleaseDmgFormat(dmg: string): string

/** Builds the drag-to-Applications release DMG for `app` at `output` and checks its format. */
export function createReleaseDmg(options: {
  app: string
  title: string
  icon: string
  output: string
}): Promise<string>
