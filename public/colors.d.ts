export type Theme = 'light' | 'dark'

/** localStorage in the browser; a plain object in tests */
export type HueStore =
  | { getItem(key: string): string | null; setItem(key: string, value: string): void }
  | Record<string, string>

export interface ProjectColor {
  /** OKLCH css color for the project dot */
  dot: string
  /** OKLCH css color for the selected-project background wash */
  wash: string
}

export const RESERVED_HUE: { start: number; end: number }
export const PROJECT_HUES: readonly number[]
export const HUE_STORE_KEY: string

export function projectHue(name: string): number
export function assignedHue(name: string, store: HueStore): number
export function overrideHue(name: string, hue: number, store: HueStore): number
export function projectColor(name: string, theme: Theme, store?: HueStore): ProjectColor
export function projectMonogram(name: string): string
