import { describe, expect, it } from 'vitest'
import {
  PANE_DEFAULTS,
  paneKeyValue,
  paneValueFromPointer,
  resolvePaneLayout,
} from '../public/panes.js'

describe('resizable pane layout', () => {
  it('opens the item pane substantially wider while preserving a useful queue', () => {
    const layout = resolvePaneLayout(1400, {})

    expect(PANE_DEFAULTS.inspector).toBe(520)
    expect(layout.inspector.value).toBe(520)
    expect(layout.center).toBeGreaterThanOrEqual(400)
  })

  it('clamps both preferences so a compact desktop never crushes the queue', () => {
    const layout = resolvePaneLayout(1100, { sidebar: 320, inspector: 720 })

    expect(layout.center).toBe(400)
    expect(layout.sidebar.value).toBeGreaterThanOrEqual(layout.sidebar.min)
    expect(layout.inspector.value).toBeGreaterThanOrEqual(layout.inspector.min)
  })

  it('keeps roomy preferences on a large display', () => {
    const layout = resolvePaneLayout(1800, { sidebar: 300, inspector: 680 })

    expect(layout.sidebar.value).toBe(300)
    expect(layout.inspector.value).toBe(680)
    expect(layout.center).toBeGreaterThan(400)
  })

  it('maps pointer position from each side of the workspace', () => {
    expect(paneValueFromPointer('sidebar', 286, 1400)).toBe(286)
    expect(paneValueFromPointer('inspector', 800, 1400)).toBe(572)
  })

  it('uses mirrored arrow keys and supports Home/End', () => {
    expect(paneKeyValue('sidebar', 'ArrowRight', 220, 180, 320)).toBe(236)
    expect(paneKeyValue('sidebar', 'ArrowLeft', 220, 180, 320)).toBe(204)
    expect(paneKeyValue('inspector', 'ArrowLeft', 520, 360, 720)).toBe(536)
    expect(paneKeyValue('inspector', 'ArrowRight', 520, 360, 720)).toBe(504)
    expect(paneKeyValue('inspector', 'Home', 520, 360, 720)).toBe(360)
    expect(paneKeyValue('inspector', 'End', 520, 360, 720)).toBe(720)
    expect(paneKeyValue('inspector', 'Enter', 520, 360, 720)).toBeNull()
  })
})
