// Type declarations for windows-app.cjs (#87). Runtime lives in the .cjs; this
// exists so the TS test and `tsc --noEmit` see the shapes.

/** The AppUserModelID the MSI's Start-menu shortcut carries. */
export const APP_USER_MODEL_ID: string

/** The toast activator CLSID the MSI's shortcut carries and registers. */
export const TOAST_ACTIVATOR_CLSID: string

export interface WindowsIdentityApp {
  setAppUserModelId(id: string): void
  setToastActivatorCLSID(id: string): void
}

/** On Windows, set both values before any window or notification; returns whether it did. */
export function setWindowsAppIdentity(options: { app: WindowsIdentityApp, platform: string }): boolean

export interface SessionEndWindow {
  on(event: 'session-end', listener: (event: { reasons?: string[] }) => void): unknown
}

/**
 * On Windows, quit through the app's normal path when Restart Manager asks the window
 * to close (a session-end with the reason 'close-app'); returns whether it registered.
 */
export function quitWhenRestartManagerAsks(options: {
  window: SessionEndWindow
  app: { quit(): void }
  platform: string
  log?: (message: string) => void
}): boolean
