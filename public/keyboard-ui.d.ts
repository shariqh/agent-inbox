export interface KeyboardUIOptions {
  getScope(): Document | HTMLElement
  getActionScope(): HTMLElement | null
  navigate(destination: string): void
}

export function createKeyboardUI(options: KeyboardUIOptions): {
  refresh(): void
  destroy(): void
}
