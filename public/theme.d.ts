export type ThemePreference = 'light' | 'dark' | 'system'
export type EffectiveTheme = 'light' | 'dark'

export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ThemeRoot {
  dataset: Record<string, string>
}

export interface ThemeMedia {
  matches: boolean
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void
}

export interface ThemeController {
  readonly preference: ThemePreference
  readonly effective: EffectiveTheme
  setPreference(preference: ThemePreference): EffectiveTheme
  destroy(): void
}

export const THEME_STORAGE_KEY: string
export const THEME_PREFERENCES: readonly ThemePreference[]

export function readThemePreference(storage: Pick<ThemeStorage, 'getItem'>): ThemePreference
export function saveThemePreference(storage: Pick<ThemeStorage, 'setItem'>, preference: ThemePreference): ThemePreference
export function resolveTheme(preference: ThemePreference, systemDark: boolean): EffectiveTheme
export function createThemeController(options: {
  storage: ThemeStorage
  root: ThemeRoot
  media: ThemeMedia
  onChange?: (preference: ThemePreference, effective: EffectiveTheme) => void
}): ThemeController
