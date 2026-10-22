export interface KeyHintsOptions {
  /** A disconnected root retires this instance instead of falling back to document. */
  getScope?(): Document | HTMLElement
  onChange?(active: boolean): void
  onAnnounce?(message: string): void
}

export function createKeyHints(options?: KeyHintsOptions): {
  toggle(): void
  close(): void
  isActive(): boolean
  /** True means the caller must prevent default and stop ordinary app shortcuts. */
  handleKey(event: KeyboardEvent): boolean
  refresh(): void
  destroy(): void
}
