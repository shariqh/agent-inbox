interface ViewerWindow {
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  webContents: {
    isDestroyed(): boolean
    session: { clearCache(): Promise<void> }
    reload(): void
  }
}

export function loadViewer(win: ViewerWindow, url: string): Promise<void>
export function reloadViewer(win: ViewerWindow): Promise<void>
