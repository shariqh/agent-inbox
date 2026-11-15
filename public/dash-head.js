// The Dashboard's page head (dashboard lanes design §3.1): one row of lane
// chips, Needs you, Working and Quiet, and the actions slot New session… sits
// in at its right end. A chip is a button that scrolls to its lane and moves
// focus to its first card (onChip); it never filters. Each lane is counted
// once on the Dashboard, here, and a chip shows 0 when its lane is empty. The
// counts are READ from the frame's own model; nothing here reaches the badge,
// alerts or the attention predicate.
const CHIPS = [['needs', 'Needs you'], ['working', 'Working'], ['quiet', 'Quiet']]

/** @param {import('./dash-head.js').DashHeadDeps} deps (dash-head.d.ts) */
export function installDashHead(deps) {
  const doc = deps.doc ?? globalThis.document
  let mounted = null
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text }
  const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value) }

  function headEl() {
    const head = doc.createElement('div')
    head.className = 'dash-head'
    const chips = doc.createElement('div')
    chips.className = 'dash-chips'
    chips.setAttribute('role', 'group')
    chips.setAttribute('aria-label', 'Lanes')
    for (const [key, label] of CHIPS) {
      const chip = doc.createElement('button')
      chip.type = 'button'
      chip.className = 'dash-chip'
      chip.dataset.dashChip = key
      chip.dataset.dashboardFocusKey = `chip:${key}`
      const name = doc.createElement('span')
      name.className = 'dash-chip-label'
      name.textContent = label
      const count = doc.createElement('b')
      count.className = 'dash-chip-count'
      count.textContent = '0'
      chip.append(name, count)
      chip.addEventListener('click', () => deps.onChip(key))
      chips.append(chip)
    }
    const actions = doc.createElement('div')
    actions.className = 'dash-head-actions'
    head.append(chips, actions)
    return head
  }

  return {
    element: () => (mounted ??= headEl()),
    actions: () => (mounted ??= headEl()).querySelector('.dash-head-actions'),
    /** `null` while the sessions are still being read: "…", never a false 0. */
    paint(counts) {
      if (!mounted) return
      for (const [key, label] of CHIPS) {
        const chip = mounted.querySelector(`[data-dash-chip="${key}"]`)
        const value = counts[key]
        const text = value === null || value === undefined ? '…' : String(value)
        setText(chip.querySelector('.dash-chip-count'), text)
        setAttr(chip, 'aria-label', `${label}: ${text === '…' ? 'reading' : text}`)
        const att = key === 'needs' && Number(value) > 0
        if (chip.classList.contains('att') !== att) chip.classList.toggle('att', att)
      }
    },
  }
}
