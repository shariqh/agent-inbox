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

export function groupItems(items: Item[]): Grouped {
  const open = items.filter((i) => i.status === 'open')
  return {
    needsYou: byProject(open.filter((i) => i.kind === 'question')),
    notes: byProject(open.filter((i) => i.kind === 'note')),
    done: items.filter((i) => i.status !== 'open'),
  }
}
