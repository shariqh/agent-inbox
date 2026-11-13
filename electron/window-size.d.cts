// Type declarations for window-size.cjs. Runtime lives in the .cjs; this exists
// so the TS test and `tsc --noEmit` see the shapes.

export interface WindowSize {
  width: number
  height: number
}

/** The window's default size when the display has room: 1440 x 900. */
export const DEFAULT_WINDOW_SIZE: Readonly<WindowSize>

/**
 * The default size clamped to `workArea`, the work area of the display the
 * window opens on. A missing or non-positive work area gets the default.
 */
export function defaultWindowSize(workArea: unknown): WindowSize
