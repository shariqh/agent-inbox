export type PaneKind = 'sidebar' | 'inspector'

export interface PanePreferences {
  sidebar?: number
  inspector?: number
}

export interface PaneDimension {
  value: number
  min: number
  max: number
}

export interface PaneLayout {
  sidebar: PaneDimension
  inspector: PaneDimension
  center: number
}

export const PANE_DEFAULTS: Readonly<{
  sidebar: number
  inspector: number
}>

export function resolvePaneLayout(
  viewportWidth: number,
  preferences?: PanePreferences,
): PaneLayout

export function paneValueFromPointer(
  kind: PaneKind,
  clientX: number,
  viewportWidth: number,
): number

export function paneKeyValue(
  kind: PaneKind,
  key: string,
  current: number,
  min: number,
  max: number,
  largeStep?: boolean,
): number | null
