// Type declarations for electron/link-preferences.cjs (issue #300 part 2).
import type { LinkRules } from './link-open.cjs'
import type { UpdatePreferencesFs } from './update-preferences.cjs'

export type SettingsError = 'invalid' | 'covered' | 'blocked' | 'exists' | 'full' | 'not-an-app' | 'runs-code' | 'newer' | 'failed'

export interface LinkSettingsRule {
  id: string
  label: string
  kind: 'web' | 'file'
  handler: 'default' | 'quicklook' | 'reveal' | 'app'
  /** the chosen app's name; never its path */
  appName: string | null
  removable: boolean
  /** whether "System default" is offered: only for the types link-open.cjs's allow-list opens */
  systemDefault: boolean
}

export interface LinkSettingsView {
  available: boolean
  rules: LinkSettingsRule[]
  error?: SettingsError
}

export interface LinkPreferencesStore {
  read(): Promise<LinkRules>
  update(change: (prefs: LinkRules) => LinkRules | { refused: SettingsError }): Promise<{ prefs: LinkRules; refused?: SettingsError }>
}

export function parseLinkPreferences(bytes: string | Buffer): { prefs: LinkRules; record: Record<string, unknown> | null; writable: boolean }

export function createLinkPreferences(options:
  | { filePath: string; fsImpl?: UpdatePreferencesFs }
  | { app: { getPath(name: 'userData'): string }; filename?: string; fsImpl?: UpdatePreferencesFs }
): LinkPreferencesStore

export function chosenApp(paths: unknown, fsp?: unknown): Promise<{ app: string } | { error: 'not-an-app' | 'runs-code' }>

export interface LinkSettings {
  view(): Promise<LinkSettingsView> | LinkSettingsView
  setHandler(id: unknown, handler: unknown): Promise<LinkSettingsView>
  chooseApp(id: unknown): Promise<LinkSettingsView>
  addType(extension: unknown): Promise<LinkSettingsView>
  removeType(id: unknown): Promise<LinkSettingsView>
}

export function createLinkSettings(options: {
  preferences: LinkPreferencesStore
  platform: string
  /** main's own native picker: the chosen paths, or null when cancelled */
  chooseApp: () => Promise<string[] | null>
  fsp?: unknown
}): LinkSettings
