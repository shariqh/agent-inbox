// Motion foundation (#302, Dashboard 2.0 proposal §10). The stylesheet does the
// animating; this module only publishes the two root attributes it keys on and
// the one JS-driven motion the app has, scrolling.
//
//   data-motion="full|calm"  the Settings choice (Full by default). Calm turns
//                            every infinite animation off and keeps one-shots.
//   data-page-hidden         present while document.hidden, so CSS pauses
//                            animations. A visible but unfocused window keeps them.
//
// The OS reduced-motion setting is honoured by CSS on its own (`@media
// (prefers-reduced-motion: reduce)`), whatever the choice says. Motion is layout
// only: nothing here reaches attention, a badge, a count or the dock.

const MOTION_STORAGE_KEY = 'agent-inbox-motion'
const MOTION_LEVELS = Object.freeze(['full', 'calm'])

function readMotionLevel(storage) {
  try {
    const value = storage?.getItem?.(MOTION_STORAGE_KEY)
    return MOTION_LEVELS.includes(value) ? value : 'full'
  } catch {
    return 'full'
  }
}

export function createMotionController({ storage, root, media, doc }) {
  let level = readMotionLevel(storage)
  const applyLevel = () => { root.dataset.motion = level }
  const applyVisibility = () => {
    if (doc.hidden) root.dataset.pageHidden = ''
    else delete root.dataset.pageHidden
  }
  doc.addEventListener('visibilitychange', applyVisibility)
  applyLevel()
  applyVisibility()

  return {
    get level() { return level },
    // A smooth scroll is a one-shot: instant under the OS setting, kept by Calm.
    scrollBehavior() { return media.matches ? 'auto' : 'smooth' },
    setLevel(next) {
      if (!MOTION_LEVELS.includes(next)) throw new TypeError(`Invalid motion level: ${String(next)}`)
      storage.setItem(MOTION_STORAGE_KEY, next)
      level = next
      applyLevel()
      return level
    },
  }
}
