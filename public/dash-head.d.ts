export type LaneChip = 'needs' | 'working' | 'quiet'

export interface DashHeadDeps {
  doc?: Document
  /** a chip's click: scroll to its lane and focus its first card (it never filters) */
  onChip(key: LaneChip): void
}

export function installDashHead(deps: DashHeadDeps): {
  /** `div.dash-head`: the chip row and the actions slot, made once */
  element(): HTMLElement
  /** the slot at the head's right end that New session… is mounted in */
  actions(): HTMLElement
  /** each chip's count; null while it is still being read ("…") */
  paint(counts: { needs: number; working: number | null; quiet: number | null }): void
}
