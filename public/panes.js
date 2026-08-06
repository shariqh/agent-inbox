export const PANE_DEFAULTS = Object.freeze({ sidebar: 220, inspector: 520 })

const LIMITS = Object.freeze({
  sidebar: { min: 180, max: 320 },
  inspector: { min: 360, max: 720 },
  centerMin: 400,
  fixedChrome: 92,
  inspectorEdge: 28,
})

function finite(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function dynamicMax(kind, viewport, other) {
  const limit = LIMITS[kind]
  return Math.max(
    limit.min,
    Math.min(limit.max, viewport - other - LIMITS.fixedChrome - LIMITS.centerMin),
  )
}

export function resolvePaneLayout(viewportWidth, preferences = {}) {
  const viewport = Math.max(0, finite(viewportWidth, 0))
  const preferredSidebar = finite(preferences.sidebar, PANE_DEFAULTS.sidebar)
  const preferredInspector = finite(preferences.inspector, PANE_DEFAULTS.inspector)

  let sidebar = clamp(preferredSidebar, LIMITS.sidebar.min, LIMITS.sidebar.max)
  let inspectorMax = dynamicMax('inspector', viewport, sidebar)
  let inspector = clamp(preferredInspector, LIMITS.inspector.min, inspectorMax)
  const sidebarMax = dynamicMax('sidebar', viewport, inspector)
  sidebar = clamp(preferredSidebar, LIMITS.sidebar.min, sidebarMax)
  inspectorMax = dynamicMax('inspector', viewport, sidebar)
  inspector = clamp(preferredInspector, LIMITS.inspector.min, inspectorMax)

  return {
    sidebar: { value: Math.round(sidebar), min: LIMITS.sidebar.min, max: Math.round(sidebarMax) },
    inspector: { value: Math.round(inspector), min: LIMITS.inspector.min, max: Math.round(inspectorMax) },
    center: Math.max(0, Math.round(viewport - sidebar - inspector - LIMITS.fixedChrome)),
  }
}

export function paneValueFromPointer(kind, clientX, viewportWidth) {
  const x = finite(clientX, 0)
  if (kind === 'sidebar') return x
  return finite(viewportWidth, 0) - LIMITS.inspectorEdge - x
}

export function paneKeyValue(kind, key, current, min, max, largeStep = false) {
  const value = finite(current, 0)
  const step = largeStep ? 40 : 16
  if (key === 'Home') return min
  if (key === 'End') return max
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const direction = key === 'ArrowRight' ? 1 : -1
  const signed = kind === 'inspector' ? -direction : direction
  return clamp(value + signed * step, min, max)
}
