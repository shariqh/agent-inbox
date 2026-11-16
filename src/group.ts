import type { Item } from './store.js'

export interface ProjectGroup {
  project: string
  items: Item[]
}
export interface Grouped {
  needsYou: ProjectGroup[]
  notes: ProjectGroup[]
  done: Item[]
}

function byProject(items: Item[]): ProjectGroup[] {
  const map = new Map<string, Item[]>()
  for (const it of items) {
    const arr = map.get(it.project) ?? []
    arr.push(it)
    map.set(it.project, arr)
  }
  return [...map.entries()].map(([project, its]) => ({ project, items: its })).sort((a, b) => a.project.localeCompare(b.project))
}

function isHandoff(item: Item): boolean {
  return item.kind === 'done' && item.handoff === 1
}

export function groupItems(items: Item[]): Grouped {
  const open = items.filter((i) => i.status === 'open')
  return {
    // open questions, plus open hand-offs (#612): a done item whose next step asks the human to act
    needsYou: byProject(open.filter((i) => i.kind === 'question' || isHandoff(i))),
    notes: byProject(open.filter((i) => i.kind === 'note')),
    // closed items, plus open kind=done milestones — announcements, not actionable
    // (an open hand-off is an ask, so it is in needsYou instead)
    done: items.filter((i) => i.status !== 'open' || (i.kind === 'done' && !isHandoff(i))),
  }
}
