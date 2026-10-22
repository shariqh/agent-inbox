export interface KeyboardUIOptions {
  getScope(): Document | HTMLElement
  getActionScope(): HTMLElement | null
  navigate(destination: string): void
}

export function createKeyboardUI(options: KeyboardUIOptions): {
  refresh(): void
  destroy(): void
}
/** Scroll `target` into view through the scrolling ancestors inside `scope` only. */
export function revealControl(target: Element, scope: Element): void
