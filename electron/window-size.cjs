'use strict'

// The window's default size. 1440 x 900 opens above the Dashboard's 1280px wide
// breakpoint, so the wide layout shows on most screens; a smaller display gets
// the whole of its work area instead of a window that runs off it. The caller
// passes the work area of the display the window opens on (Electron's
// `screen`), which keeps the arithmetic here free of Electron. The size is not
// remembered and there is no minimum.

const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1440, height: 900 })

const usable = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 1

/**
 * The default size, never larger than `workArea` ({ width, height }). A work
 * area that is missing or not a positive size gets the default unclamped.
 */
function defaultWindowSize(workArea) {
  if (!workArea || !usable(workArea.width) || !usable(workArea.height)) return { ...DEFAULT_WINDOW_SIZE }
  return {
    width: Math.min(DEFAULT_WINDOW_SIZE.width, Math.floor(workArea.width)),
    height: Math.min(DEFAULT_WINDOW_SIZE.height, Math.floor(workArea.height)),
  }
}

module.exports = { DEFAULT_WINDOW_SIZE, defaultWindowSize }
