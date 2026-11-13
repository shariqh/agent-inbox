// The desktop window opens at 1440 x 900 so the wide layout (1280px and up)
// shows on most screens, clamped to the work area of the display it opens on.
import { describe, expect, it } from 'vitest'
import windowSize from '../electron/window-size.cjs'

const { DEFAULT_WINDOW_SIZE, defaultWindowSize } = windowSize

describe('defaultWindowSize', () => {
  it('opens at 1440 x 900 on a screen with room', () => {
    expect(DEFAULT_WINDOW_SIZE).toEqual({ width: 1440, height: 900 })
    expect(defaultWindowSize({ width: 2560, height: 1415 })).toEqual({ width: 1440, height: 900 })
  })

  it('opens at 1440 x 900 on a work area of exactly that size', () => {
    expect(defaultWindowSize({ width: 1440, height: 900 })).toEqual({ width: 1440, height: 900 })
  })

  it('clamps to a 1280 x 800 work area', () => {
    expect(defaultWindowSize({ width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 })
  })

  it('clamps each side on its own', () => {
    expect(defaultWindowSize({ width: 1920, height: 700 })).toEqual({ width: 1440, height: 700 })
    expect(defaultWindowSize({ width: 1024, height: 1200 })).toEqual({ width: 1024, height: 900 })
  })

  it('is never larger than the work area, even a tiny one', () => {
    for (const [width, height] of [[800, 600], [1366, 728], [1440, 899], [3840, 2160], [1, 1]] as const) {
      const size = defaultWindowSize({ width, height })
      expect(size.width).toBeLessThanOrEqual(width)
      expect(size.height).toBeLessThanOrEqual(height)
    }
  })

  it('rounds a fractional work area down', () => {
    expect(defaultWindowSize({ width: 1279.6, height: 799.9 })).toEqual({ width: 1279, height: 799 })
  })

  it('falls back to the default when the work area is missing or unusable', () => {
    for (const bad of [undefined, null, {}, { width: 0, height: 0 }, { width: NaN, height: 800 }, { width: 1280, height: -5 }, { width: Infinity, height: 800 }, { width: 1440, height: undefined }, 'wide']) {
      expect(defaultWindowSize(bad)).toEqual({ width: 1440, height: 900 })
    }
  })
})
