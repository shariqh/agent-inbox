export interface PaletteTarget {
  key: string
  title: string
  context: string
  haystack: string
  action: { type: 'answer' | 'plan' | 'session'; id: string }
}

export type PaletteAction = PaletteTarget['action'] | { type: 'command'; fill: string }

export interface PaletteResult {
  key: string
  targetId: ''
  section: 'actions'
  sectionLabel: 'Actions'
  kind: string
  title: string
  titleRanges: number[]
  match: null
  source: null
  context: string
  action: PaletteAction
}

export function paletteResults(
  query: string,
  targets: { asks: PaletteTarget[]; plans: PaletteTarget[]; sessions: PaletteTarget[] },
  searchFn: (haystack: string[], needle: string) => Array<{ index: number; ranges: number[] }> | null,
): PaletteResult[]
