// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { closeProject, closedProjects, insertItem, reopenProject } from '../../src/store.js'
import {
  advanceClock, bootApp, click, expectConsoleError, freshDb, pollTick, rowTitles, searchFor, setViewport,
  settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

function question(d: Database.Database, project: string): void {
  insertItem(d, {
    project,
    stream: 'main',
    agent: 'copilot',
    kind: 'question',
    title: `${project} question`,
  })
}

const projectTab = (project: string): HTMLButtonElement | null =>
  document.querySelector(`#rail .rail-tab[data-project="${project}"]`)

const archiveAction = (project: string): HTMLButtonElement | null =>
  projectTab(project)?.parentElement?.querySelector('.rail-close') ?? null

const archivedTrigger = (): HTMLButtonElement | null =>
  document.getElementById('closedProjectsTrigger') as HTMLButtonElement | null

const archivedPopover = (): HTMLElement | null =>
  document.getElementById('closedProjectsPopover')

function openProjectMenu(): void {
  const toggle = document.getElementById('projectDisclosureToggle') as HTMLButtonElement
  if (toggle.getAttribute('aria-expanded') !== 'true') click(toggle)
}

function pointer(el: Element, type: 'pointerdown' | 'pointerup'): void {
  el.dispatchEvent(new window.PointerEvent(type, { bubbles: true }))
}

function holdNextRequest(method: 'GET' | 'POST'): () => void {
  const fetchNow = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async (input, init) => {
    if ((init?.method ?? 'GET') === method) {
      await gate
      globalThis.fetch = fetchNow
    }
    return await fetchNow(input, init)
  }
  return release
}

function failNextRequest(method: 'GET' | 'POST'): void {
  const fetchNow = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if ((init?.method ?? 'GET') === method) {
      globalThis.fetch = fetchNow
      return new Response('not json', { status: 500 })
    }
    return await fetchNow(input, init)
  }
}

function failNextUrl(url: string): void {
  const fetchNow = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (String(input) === url) {
      globalThis.fetch = fetchNow
      return new Response('boom', { status: 500 })
    }
    return await fetchNow(input, init)
  }
}

function holdUrlFailure(url: string): { started: Promise<void>; release(): void } {
  const fetchNow = globalThis.fetch
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const startedPromise = new Promise<void>((resolve) => { started = resolve })
  globalThis.fetch = async (input, init) => {
    if (String(input) !== url) return await fetchNow(input, init)
    globalThis.fetch = fetchNow
    started()
    await gate
    throw new Error('stale load failure')
  }
  return { started: startedPromise, release }
}

function holdClosedProjectsSnapshot(): { started: Promise<void>; release(): void } {
  const fetchNow = globalThis.fetch
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const startedPromise = new Promise<void>((resolve) => { started = resolve })
  globalThis.fetch = async (input, init) => {
    if ((init?.method ?? 'GET') !== 'GET' || String(input) !== '/api/projects/closed') {
      return await fetchNow(input, init)
    }
    globalThis.fetch = fetchNow
    const snapshot = await fetchNow(input, init)
    started()
    await gate
    return snapshot
  }
  return { started: startedPromise, release }
}

function holdArchivePosts(): { release(index: number): void } {
  const fetchNow = globalThis.fetch
  const releases: Array<() => void> = []
  globalThis.fetch = async (input, init) => {
    if (init?.method !== 'POST' || String(input) !== '/api/projects/close') {
      return await fetchNow(input, init)
    }

    const index = releases.length
    await new Promise<void>((resolve) => { releases.push(resolve) })
    if (index === 0) return new Response('boom', { status: 500 })
    return await fetchNow(input, init)
  }
  return {
    release(index) {
      const release = releases[index]
      if (!release) throw new Error(`archive POST ${index} is not pending`)
      release()
    },
  }
}

function holdProjectPosts(): { count(): number; release(index: number, status?: number): void } {
  const fetchNow = globalThis.fetch
  const pending: Array<{ release(): void; status: number }> = []
  globalThis.fetch = async (input, init) => {
    if (init?.method !== 'POST' || !String(input).startsWith('/api/projects/')) {
      return await fetchNow(input, init)
    }
    const request = { release() {}, status: 200 }
    await new Promise<void>((resolve) => {
      request.release = resolve
      pending.push(request)
    })
    if (request.status !== 200) return new Response('boom', { status: request.status })
    return await fetchNow(input, init)
  }
  return {
    count: () => pending.length,
    release(index, status = 200) {
      const request = pending[index]
      if (!request) throw new Error(`project POST ${index} is not pending`)
      request.status = status
      request.release()
    },
  }
}

it('keeps archived projects closed while the workspace search index changes', async () => {
  const d = open()
  question(d, 'alpha')
  advanceClock()
  insertItem(d, {
    project: 'beta',
    stream: 'main',
    agent: 'copilot',
    kind: 'question',
    title: 'first second archived match',
  })
  closeProject(d, 'beta')
  setViewport(900)
  await bootApp(d)

  await searchFor('first')
  expect(document.getElementById('projectDisclosure')?.dataset.open).toBe('false')
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('#searchResults [data-search-target]')?.textContent).toContain('first second archived match')
  expect(archivedPopover()).toBeNull()

  await searchFor('absent')
  expect(document.getElementById('projectDisclosure')?.dataset.open).toBe('false')
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('#searchResults .search-results-empty')?.textContent).toContain('No results')
  expect(archivedPopover()).toBeNull()
})

it('keeps an explicit Escape dismissal coherent through polling after a forced-open peek', async () => {
  const d = open()
  question(d, 'alpha')
  advanceClock()
  question(d, 'beta')
  closeProject(d, 'beta')
  setViewport(900)
  await bootApp(d)

  click(archivedTrigger())
  click(archivedPopover()?.querySelector('[aria-label="View archived project beta"]'))
  await settle()
  expect(archivedPopover()).toBeTruthy()

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
  expect(archivedPopover()).toBeNull()

  await pollTick()
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
  expect(archivedPopover()).toBeNull()

  click(archivedTrigger())
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('true')
  expect(archivedPopover()).toBeTruthy()

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
  expect(archivedPopover()).toBeNull()
})

describe.each([768, 1024])('tablet project management at %ipx', (width) => {
  it('archives through an x-only project action and reopens from the anchored popover', async () => {
    const d = open()
    question(d, 'alpha-project')
    advanceClock()
    question(d, 'beta-project')
    setViewport(width)
    await bootApp(d)
    openProjectMenu()

    const archive = archiveAction('beta-project')!
    expect(archive.querySelector('.rail-action-glyph')?.textContent).toBe('×')
    expect(archive.querySelector('.rail-action-label')?.textContent).toBe('Archive')
    expect(archive.tabIndex).toBe(-1)
    expect(archive.getAttribute('aria-label')).toBe('Archive project beta-project')

    click(archive)
    await settle()

    expect(closedProjects(d)).toEqual(['beta-project'])
    expect(archivedTrigger()?.textContent).toContain('Archived (1)')
    expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('true')
    expect(archivedPopover()).toBeTruthy()
    expect(archivedPopover()?.querySelector('[data-project="beta-project"] .closed-project-name')?.textContent)
      .toBe('beta project')
    expect(archivedPopover()?.querySelector('[data-project="beta-project"] .rail-dot')?.getAttribute('style'))
      .toContain('background')

    const reopen = archivedPopover()?.querySelector<HTMLButtonElement>('[aria-label="Reopen project beta-project"]')
    expect(reopen?.textContent).toBe('Reopen')
    expect(reopen?.tabIndex).toBe(0)
    click(reopen)
    await settle()

    expect(closedProjects(d)).toEqual([])
    expect(projectTab('beta-project')).toBeTruthy()
    expect(archivedTrigger()).toBeNull()
    expect(document.activeElement).toBe(projectTab('beta-project'))
    expect(projectTab('beta-project')?.tabIndex).toBe(0)
  })
})

describe('tablet archived-project popover behavior', () => {
  it('updates the archived control when a rail-filter-excluded project closes and reopens', async () => {
    const d = open()
    for (let i = 0; i < 13; i += 1) {
      question(d, `open-${i}`)
      advanceClock()
    }
    insertItem(d, {
      project: 'zero-attention',
      stream: 'main',
      agent: 'copilot',
      kind: 'done',
      title: 'already done',
    })
    setViewport(900)
    await bootApp(d)

    const filter = document.querySelector<HTMLInputElement>('#rail .rail-filter')!
    filter.value = 'open'
    filter.dispatchEvent(new window.Event('input', { bubbles: true }))
    expect(archivedTrigger()).toBeNull()

    closeProject(d, 'zero-attention')
    await pollTick()
    expect(archivedTrigger()?.textContent).toContain('Archived (1)')

    reopenProject(d, 'zero-attention')
    await pollTick()
    expect(archivedTrigger()).toBeNull()
  })

  it('keeps archived disclosure explicit while restoring rail-filter focus', async () => {
    const d = open()
    for (let i = 0; i < 13; i += 1) {
      question(d, `open-${i}`)
      advanceClock()
    }
    insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'global archived needle',
    })
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    let filter = document.querySelector<HTMLInputElement>('#rail .rail-filter')!
    filter.value = 'open'
    filter.dispatchEvent(new window.Event('input', { bubbles: true }))
    await searchFor('needle')
    expect(archivedPopover()).toBeNull()

    filter = document.querySelector<HTMLInputElement>('#rail .rail-filter')!
    filter.focus()
    filter.value = 'beta'
    filter.setSelectionRange(4, 4)
    filter.dispatchEvent(new window.Event('input', { bubbles: true }))

    expect(document.activeElement).toBe(document.querySelector('#rail .rail-filter'))
    expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(archivedPopover()).toBeNull()
    click(archivedTrigger())
    expect(archivedPopover()).toBeTruthy()
  })

  it('restores trigger focus on Escape and closes on outside pointer interaction', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(834)
    await bootApp(d)

    click(archivedTrigger())
    expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('true')
    expect(archivedPopover()).toBeTruthy()

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(archivedPopover()).toBeNull()
    expect(document.activeElement).toBe(archivedTrigger())

    click(archivedTrigger())
    const search = document.getElementById('search')!
    pointer(search, 'pointerdown')
    expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(archivedPopover()).toBeNull()
  })

  it('closes on outside pointerdown without detaching the pending project action', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    click(archivedTrigger())
    const alphaArchive = archiveAction('alpha')!
    pointer(alphaArchive, 'pointerdown')

    expect(archivedPopover()).toBeNull()
    expect(document.contains(alphaArchive)).toBe(true)
    expect(archiveAction('alpha')).toBe(alphaArchive)

    pointer(alphaArchive, 'pointerup')
    click(alphaArchive)
    await settle()
    expect(closedProjects(d).sort()).toEqual(['alpha', 'beta'])
  })

  it('keeps logical focus when opening and when fresh data rebuilds focused project actions', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(1024)
    await bootApp(d)
    openProjectMenu()

    const trigger = archivedTrigger()!
    trigger.focus()
    click(trigger)
    expect(archivedTrigger()).toBe(trigger)
    expect(document.activeElement).toBe(trigger)

    const reopen = archivedPopover()!.querySelector<HTMLButtonElement>('[aria-label="Reopen project beta"]')!
    reopen.focus()
    advanceClock()
    question(d, 'gamma')
    await pollTick()

    const current = archivedPopover()!.querySelector<HTMLButtonElement>('[aria-label="Reopen project beta"]')!
    expect(current).not.toBe(reopen)
    expect(document.activeElement).toBe(current)

    const archive = archiveAction('alpha')!
    archive.focus()
    advanceClock()
    question(d, 'delta')
    await pollTick()

    const currentArchive = archiveAction('alpha')!
    expect(currentArchive).not.toBe(archive)
    expect(document.activeElement).toBe(currentArchive)
  })

  it('promotes a poll-reopened project tab when focus was on its Reopen action', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)
    openProjectMenu()

    click(archivedTrigger())
    archivedPopover()?.querySelector<HTMLButtonElement>('[aria-label="Reopen project beta"]')?.focus()
    reopenProject(d, 'beta')
    await pollTick()

    const beta = projectTab('beta')!
    expect(document.activeElement).toBe(beta)
    expect(beta.tabIndex).toBe(0)
    expect([...document.querySelectorAll<HTMLButtonElement>('#rail .rail-tab')]
      .filter((tab) => tab.tabIndex === 0)).toEqual([beta])
  })

  it('promotes a poll-reopened project tab when focus was on its Peek action', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)
    openProjectMenu()
    click(archivedTrigger())
    archivedPopover()?.querySelector<HTMLButtonElement>('[aria-label="View archived project beta"]')?.focus()
    reopenProject(d, 'beta')
    await pollTick()
    const beta = projectTab('beta')!
    expect(document.activeElement).toBe(beta)
    expect(beta.tabIndex).toBe(0)
  })

  it('promotes the sole poll-reopened project tab when focus was on the archived trigger', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)
    openProjectMenu()

    archivedTrigger()?.focus()
    reopenProject(d, 'beta')
    await pollTick()

    const beta = projectTab('beta')!
    expect(archivedTrigger()).toBeNull()
    expect(document.activeElement).toBe(beta)
    expect(beta.tabIndex).toBe(0)
    expect([...document.querySelectorAll<HTMLButtonElement>('#rail .rail-tab')]
      .filter((tab) => tab.tabIndex === 0)).toEqual([beta])
  })

  it.each([
    [1400, '.closed-fold summary'],
    [560, '#projectDisclosureToggle'],
  ])('falls back to an operable control when tablet archived focus becomes hidden at %ipx', async (width, selector) => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    advanceClock()
    question(d, 'gamma')
    closeProject(d, 'beta')
    closeProject(d, 'gamma')
    setViewport(900)
    await bootApp(d)

    click(archivedTrigger())
    archivedPopover()?.querySelector<HTMLButtonElement>('[aria-label="View archived project beta"]')?.focus()
    setViewport(width)
    window.dispatchEvent(new window.Event('resize'))
    await settle()

    const fallback = document.querySelector<HTMLElement>(selector)!
    expect(document.activeElement).toBe(fallback)
    expect(document.querySelector<HTMLDetailsElement>('.closed-fold')?.open).toBe(false)
    if (width === 1400) {
      const visibleTabs = [...document.querySelectorAll<HTMLButtonElement>('#rail .rail-tab')]
        .filter((tab) => !tab.closest('details:not([open])'))
      expect(visibleTabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1)
    }
  })

  it('restores bookmarked tablet focus after phone CSS hides the archived control', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    click(archivedTrigger())
    const peek = archivedPopover()
      ?.querySelector<HTMLButtonElement>('[aria-label="View archived project beta"]')!
    peek.focus()
    setViewport(560)
    peek.blur()
    expect(document.activeElement).toBe(document.body)
    window.dispatchEvent(new window.Event('resize'))
    await settle()

    expect(document.activeElement).toBe(document.getElementById('projectDisclosureToggle'))
  })

  it('keeps the project focus bookmark when pointerdown lands on a control child', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    const trigger = archivedTrigger()!
    trigger.focus()
    pointer(trigger.querySelector('span')!, 'pointerdown')
    setViewport(560)
    trigger.blur()
    expect(document.activeElement).toBe(document.body)
    window.dispatchEvent(new window.Event('resize'))
    await settle()

    expect(document.activeElement).toBe(document.getElementById('projectDisclosureToggle'))
  })

  it('does not use a stale project bookmark after focus moves elsewhere', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    click(archivedTrigger())
    archivedPopover()?.querySelector<HTMLButtonElement>('[aria-label="View archived project beta"]')?.focus()
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()
    setViewport(560)
    window.dispatchEvent(new window.Event('resize'))
    await settle()

    expect(document.activeElement).toBe(search)
  })

  it('falls back to a visible project tab when the reopened project is rail-filtered away', async () => {
    const d = open()
    for (let i = 0; i < 13; i += 1) {
      question(d, `project-${i}`)
      advanceClock()
    }
    question(d, 'hidden-archived')
    closeProject(d, 'hidden-archived')
    setViewport(900)
    await bootApp(d)
    openProjectMenu()

    const filter = document.querySelector<HTMLInputElement>('#rail .rail-filter')!
    filter.value = 'project-2'
    filter.dispatchEvent(new window.Event('input', { bubbles: true }))
    archivedTrigger()?.focus()
    reopenProject(d, 'hidden-archived')
    await pollTick()

    const visibleTabs = [...document.querySelectorAll<HTMLButtonElement>('#rail .rail-tab')]
      .filter((tab) => !tab.closest('details:not([open])'))
    const tabbable = visibleTabs.filter((tab) => tab.tabIndex === 0)
    expect(projectTab('hidden-archived')).toBeNull()
    expect(tabbable).toHaveLength(1)
    expect(document.activeElement).toBe(tabbable[0])
  })

  it('maps a filtered desktop archived tab to the tablet archived trigger', async () => {
    const d = open()
    for (let i = 0; i < 13; i += 1) {
      question(d, `project-${i}`)
      advanceClock()
    }
    question(d, 'beta-archived')
    advanceClock()
    question(d, 'gamma-archived')
    closeProject(d, 'beta-archived')
    closeProject(d, 'gamma-archived')
    setViewport(1400)
    await bootApp(d)

    const filter = document.querySelector<HTMLInputElement>('#rail .rail-filter')!
    filter.value = 'beta'
    filter.dispatchEvent(new window.Event('input', { bubbles: true }))
    const fold = document.querySelector<HTMLDetailsElement>('.closed-fold')!
    fold.open = true
    fold.dispatchEvent(new window.Event('toggle'))
    fold.querySelector<HTMLButtonElement>('.rail-tab[data-project="beta-archived"]')?.focus()

    setViewport(900)
    await settle()

    expect(document.activeElement).toBe(archivedTrigger())
    expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.rail-tab[data-project="beta-archived"]')).toBeNull()
  })

  it('makes a restored project tab the sole roving tab stop after a poll rebuild', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    await bootApp(d)
    openProjectMenu()

    const beta = projectTab('beta')!
    beta.focus()
    advanceClock()
    question(d, 'gamma')
    await pollTick()

    const restored = projectTab('beta')!
    const tabbable = [...document.querySelectorAll<HTMLButtonElement>('#rail .rail-tab')]
      .filter((tab) => tab.tabIndex === 0)
    expect(document.activeElement).toBe(restored)
    expect(restored.tabIndex).toBe(0)
    expect(tabbable).toEqual([restored])
  })

  it('keeps archived project selection as a separate non-mutating peek beside Reopen', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    click(archivedTrigger())
    const peek = archivedPopover()!.querySelector<HTMLButtonElement>('[aria-label="View archived project beta"]')!
    const reopen = archivedPopover()!.querySelector<HTMLButtonElement>('[aria-label="Reopen project beta"]')!
    expect(peek).toBeTruthy()
    expect(reopen).toBeTruthy()

    peek.focus()
    click(peek)
    await settle()

    expect(closedProjects(d)).toEqual(['beta'])
    expect(rowTitles()).toEqual(['beta question'])
    expect(archivedPopover()?.querySelector('[aria-label="View archived project beta"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(archivedPopover()?.querySelector('[aria-label="View archived project beta"]'))
  })

  it('indexes archived-only search matches without opening either project menu', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    insertItem(d, {
      project: 'beta',
      stream: 'main',
      agent: 'copilot',
      kind: 'question',
      title: 'unique archived needle',
    })
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    await searchFor('needle')

    expect(document.getElementById('projectDisclosure')?.dataset.open).toBe('false')
    expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('#searchResults [data-search-target]')?.textContent).toContain('unique archived needle')
    expect(archivedPopover()).toBeNull()

    openProjectMenu()
    click(archivedTrigger())
    const beta = archivedPopover()?.querySelector('[data-project="beta"]')
    expect(beta).toBeTruthy()
    expect(beta?.querySelector('.rail-match')).toBeNull()
  })

  it('keeps a large archived set in one labelled region with explicit reopen actions', async () => {
    const d = open()
    for (let i = 1; i <= 16; i += 1) {
      const project = `archived-project-${String(i).padStart(2, '0')}`
      question(d, project)
      closeProject(d, project)
      advanceClock()
    }
    setViewport(1180)
    await bootApp(d)

    expect(archivedTrigger()?.textContent).toContain('Archived (16)')
    click(archivedTrigger())

    const popover = archivedPopover()!
    expect(popover.getAttribute('role')).toBe('region')
    expect(popover.getAttribute('aria-label')).toBe('Archived projects')
    expect(popover.querySelectorAll('.closed-project-entry')).toHaveLength(16)
    expect(popover.querySelectorAll('.closed-project-reopen')).toHaveLength(16)
    expect(popover.querySelectorAll('button')).toHaveLength(32)
  })

  it('keeps one project tab keyboard-reachable when a closed project is selected before tablet mode', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(1400)
    await bootApp(d)

    click(document.querySelector('.closed-fold .rail-tab[data-project="beta"]'))
    await settle()
    setViewport(834)

    const tabbable = [...document.querySelectorAll<HTMLButtonElement>('#rail .rail-tab')]
      .filter((tab) => tab.tabIndex === 0)
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]?.dataset.project).toBe('__all__')
  })

  it('lets a higher-priority Settings surface consume Escape before the archived popover', async () => {
    const d = open()
    question(d, 'alpha')
    closeProject(d, 'alpha')
    setViewport(900)
    await bootApp(d)

    click(document.getElementById('gear'))
    expect(document.body.classList.contains('settings-open')).toBe(true)
    click(archivedTrigger())
    expect(archivedPopover()).toBeTruthy()

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.body.classList.contains('settings-open')).toBe(false)
    expect(archivedPopover(), 'restored Settings focus closes the now-background popover').toBeNull()
    expect(document.activeElement, 'focus must stay on the higher-priority surface control').toBe(document.getElementById('gear'))
  })

  it.each([560, 1400])('retains the existing details fold outside tablet mode at %ipx', async (width) => {
    const d = open()
    question(d, 'alpha')
    closeProject(d, 'alpha')
    setViewport(width)
    await bootApp(d)

    expect(document.querySelector('#rail .closed-fold')).toBeTruthy()
    expect(archivedTrigger()).toBeNull()
  })
})

describe.each([560, 900, 1400])('roving project fallback at %ipx', (width) => {
  it('keeps exactly one visible project tab tabbable when filtering removes the selection', async () => {
    const d = open()
    for (let i = 0; i < 13; i += 1) {
      question(d, `project-${i}`)
      advanceClock()
    }
    setViewport(width)
    await bootApp(d)

    click(projectTab('project-1'))
    await settle()
    const filter = document.querySelector<HTMLInputElement>('#rail .rail-filter')!
    filter.value = 'project-2'
    filter.dispatchEvent(new window.Event('input', { bubbles: true }))

    const tabbable = [...document.querySelectorAll<HTMLButtonElement>('#rail .rail-tab')]
      .filter((tab) => tab.tabIndex === 0)
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]?.dataset.project).toBe('__all__')
  })
})

describe('async project mutation focus', () => {
  it('promotes the restored project tab when Archive fails', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    const bridge = await bootApp(d)
    openProjectMenu()
    bridge.failPostsWith(500)
    archiveAction('beta')?.focus()
    click(archiveAction('beta'))
    await settle()
    const beta = projectTab('beta')!
    expect(document.activeElement).toBe(beta)
    expect(beta.tabIndex).toBe(0)
  })

  it('does not let an older failed Archive steal focus from a newer Archive', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    advanceClock()
    question(d, 'gamma')
    setViewport(900)
    await bootApp(d)

    const posts = holdArchivePosts()
    click(archiveAction('alpha'))
    await settle()
    click(archiveAction('beta'))
    await settle()

    posts.release(1)
    await settle()
    expect(document.activeElement).toBe(archivedTrigger())

    posts.release(0)
    await settle()

    expect(document.activeElement).toBe(archivedTrigger())
    expect(closedProjects(d)).toEqual(['beta'])
  })

  it('keeps a newer Archive intent painted while an older Reopen completes', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    const posts = holdProjectPosts()
    click(archivedTrigger())
    click(archivedPopover()?.querySelector('[aria-label="Reopen project beta"]'))
    await settle()
    click(archiveAction('beta'))
    await settle()
    expect(posts.count()).toBe(1)

    posts.release(0)
    await settle()
    expect(posts.count()).toBe(2)
    expect(projectTab('beta')).toBeNull()

    posts.release(1)
    await settle()
    expect(closedProjects(d)).toEqual(['beta'])
    expect(projectTab('beta')).toBeNull()
  })

  it('rolls back only the latest failed Reopen after an older Archive succeeds', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    await bootApp(d)

    const posts = holdProjectPosts()
    click(archiveAction('beta'))
    await settle()
    click(archivedPopover()?.querySelector('[aria-label="Reopen project beta"]'))
    await settle()
    expect(posts.count()).toBe(1)

    posts.release(0)
    await settle()
    expect(posts.count()).toBe(2)
    expect(projectTab('beta')).toBeTruthy()

    posts.release(1, 500)
    await settle()
    expect(closedProjects(d)).toEqual(['beta'])
    expect(projectTab('beta')).toBeNull()
  })

  it('keeps another pending Reopen painted through out-of-order success and failure', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    advanceClock()
    question(d, 'gamma')
    closeProject(d, 'beta')
    closeProject(d, 'gamma')
    setViewport(900)
    await bootApp(d)

    const posts = holdProjectPosts()
    click(archivedTrigger())
    click(archivedPopover()?.querySelector('[aria-label="Reopen project beta"]'))
    await settle()
    click(archivedTrigger())
    click(archivedPopover()?.querySelector('[aria-label="Reopen project gamma"]'))
    await settle()

    posts.release(1)
    await settle()
    expect(projectTab('beta')).toBeTruthy()
    expect(projectTab('gamma')).toBeTruthy()

    posts.release(0, 500)
    await settle()
    expect(closedProjects(d)).toEqual(['beta'])
    expect(projectTab('beta')).toBeNull()
    expect(projectTab('gamma')).toBeTruthy()
  })

  it('recomputes from a derived authoritative reopen after successful Archive', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    await bootApp(d)

    const release = holdNextRequest('GET')
    click(archiveAction('beta'))
    await settle()
    advanceClock()
    question(d, 'beta')
    release()
    await settle()

    expect(closedProjects(d)).toEqual([])
    expect(projectTab('beta')).toBeTruthy()
  })

  it('keeps a confirmed Archive intent until a failed authoritative refresh recovers', async () => {
    expectConsoleError(/JSON|Unexpected token/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    await bootApp(d)

    failNextRequest('GET')
    click(archiveAction('beta'))
    await settle()
    expect(projectTab('beta')).toBeNull()

    advanceClock()
    question(d, 'beta')
    await pollTick()

    expect(closedProjects(d)).toEqual([])
    expect(projectTab('beta')).toBeTruthy()
  })

  it('does not retire a confirmed Archive from an older poll snapshot', async () => {
    expectConsoleError(/JSON|Unexpected token/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    await bootApp(d)

    const stale = holdClosedProjectsSnapshot()
    const oldPoll = pollTick()
    await stale.started
    failNextRequest('GET')
    click(archiveAction('beta'))
    await settle()
    expect(projectTab('beta')).toBeNull()

    stale.release()
    await oldPoll
    expect(projectTab('beta')).toBeNull()

    await pollTick()
    expect(closedProjects(d)).toEqual(['beta'])
    expect(projectTab('beta')).toBeNull()
  })

  it('does not install a failed closed-project response as authoritative', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    await bootApp(d)

    failNextUrl('/api/projects/closed')
    click(archiveAction('beta'))
    await settle()

    expect(closedProjects(d)).toEqual(['beta'])
    expect(projectTab('beta')).toBeNull()

    await pollTick()
    expect(projectTab('beta')).toBeNull()
  })

  it('does not block a later Reopen POST while Archive reconciliation waits', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    await bootApp(d)

    const posts = holdProjectPosts()
    failNextUrl('/api/projects/closed')
    click(archiveAction('beta'))
    await settle()
    posts.release(0)
    await settle()

    click(archivedPopover()?.querySelector('[aria-label="Reopen project beta"]'))
    await settle()
    expect(posts.count()).toBe(2)

    posts.release(1, 500)
    await settle()
    expect(projectTab('beta')).toBeNull()

    await pollTick()
    await settle()
    expect(closedProjects(d)).toEqual(['beta'])
    expect(projectTab('beta')).toBeNull()
  })

  it('ignores an older poll failure after a newer load succeeds', async () => {
    const d = open()
    question(d, 'alpha')
    setViewport(900)
    await bootApp(d)

    const stale = holdUrlFailure('/api/items')
    const oldPoll = pollTick()
    await stale.started
    await pollTick()
    expect(document.getElementById('status')?.textContent).toBe('')

    stale.release()
    await oldPoll
    expect(document.getElementById('status')?.textContent).toBe('')
  })

  it('restores confirmed open state when queued Archive and Reopen both fail', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    await bootApp(d)

    const posts = holdProjectPosts()
    click(archiveAction('beta'))
    await settle()
    click(archivedPopover()?.querySelector('[aria-label="Reopen project beta"]'))
    await settle()

    posts.release(0, 500)
    await settle()
    posts.release(1, 500)
    await settle()

    expect(closedProjects(d)).toEqual([])
    expect(projectTab('beta')).toBeTruthy()
  })

  it('restores confirmed closed state when queued Reopen and Archive both fail', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    const posts = holdProjectPosts()
    click(archivedTrigger())
    click(archivedPopover()?.querySelector('[aria-label="Reopen project beta"]'))
    await settle()
    click(archiveAction('beta'))
    await settle()

    posts.release(0, 500)
    await settle()
    posts.release(1, 500)
    await settle()

    expect(closedProjects(d)).toEqual(['beta'])
    expect(projectTab('beta')).toBeNull()
  })

  it('does not steal deliberate Search focus when Archive finishes', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    await bootApp(d)

    const release = holdNextRequest('GET')
    click(archiveAction('beta'))
    await settle()
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()

    release()
    await settle()

    expect(document.activeElement).toBe(search)
    expect(closedProjects(d)).toEqual(['beta'])
  })

  it('does not steal deliberate Search focus when Reopen finishes', async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    await bootApp(d)

    click(archivedTrigger())
    const release = holdNextRequest('GET')
    click(archivedPopover()?.querySelector('[aria-label="Reopen project beta"]'))
    await settle()
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()

    release()
    await settle()

    expect(document.activeElement).toBe(search)
    expect(closedProjects(d)).toEqual([])
  })

  it('does not steal deliberate Search focus when Archive fails', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    setViewport(900)
    const bridge = await bootApp(d)
    bridge.failPostsWith(500)

    const release = holdNextRequest('POST')
    click(archiveAction('beta'))
    await settle()
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()

    release()
    await settle()

    expect(document.activeElement).toBe(search)
    expect(closedProjects(d)).toEqual([])
  })

  it('does not steal deliberate Search focus when Reopen fails', async () => {
    expectConsoleError(/HTTP 500/)
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(900)
    const bridge = await bootApp(d)
    bridge.failPostsWith(500)

    click(archivedTrigger())
    const release = holdNextRequest('POST')
    click(archivedPopover()?.querySelector('[aria-label="Reopen project beta"]'))
    await settle()
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()

    release()
    await settle()

    expect(document.activeElement).toBe(search)
    expect(closedProjects(d)).toEqual(['beta'])
  })
})

it('clears stale tablet archived state when the last archived project disappears', async () => {
  const d = open()
  question(d, 'alpha')
  advanceClock()
  question(d, 'beta')
  advanceClock()
  question(d, 'gamma')
  closeProject(d, 'beta')
  setViewport(900)
  await bootApp(d)

  expect(archivedPopover()).toBeNull()
  openProjectMenu()
  click(archivedTrigger())
  expect(archivedPopover()).toBeTruthy()

  reopenProject(d, 'beta')
  await pollTick()
  expect(archivedTrigger()).toBeNull()
  expect(archivedPopover()).toBeNull()
  const escape = new window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  })
  let propagated = false
  document.addEventListener('keydown', () => { propagated = true }, { once: true })
  document.dispatchEvent(escape)
  expect(propagated).toBe(true)

  closeProject(d, 'gamma')
  await pollTick()
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
  expect(archivedPopover()).toBeNull()
})

it('does not persist an open compact project menu through a desktop round-trip', async () => {
  const d = open()
  question(d, 'alpha')
  setViewport(560)
  await bootApp(d)
  click(document.getElementById('projectDisclosureToggle'))
  expect(document.getElementById('projectDisclosure')?.dataset.open).toBe('true')
  setViewport(1400)
  await settle()
  expect(document.getElementById('projectDisclosure')?.dataset.open).toBe('false')
  setViewport(560)
  await settle()
  expect(document.getElementById('projectDisclosure')?.dataset.open).toBe('false')
})

it('closes archived project UI coherently across desktop and tablet transitions', async () => {
  const d = open()
  question(d, 'alpha')
  advanceClock()
  question(d, 'beta')
  closeProject(d, 'beta')
  setViewport(1400)
  await bootApp(d)

  click(document.querySelector('.closed-fold summary'))
  expect(document.querySelector<HTMLDetailsElement>('.closed-fold')?.open).toBe(true)

  setViewport(900)
  await settle()
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
  expect(archivedPopover()).toBeNull()

  click(archivedTrigger())
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('true')
  expect(archivedPopover()).toBeTruthy()

  setViewport(1400)
  await settle()
  expect(archivedPopover()).toBeNull()
  expect(document.querySelector<HTMLDetailsElement>('.closed-fold')?.open).toBe(false)
})

it('keeps a forced archived project dismissed after desktop-to-tablet transition polling', async () => {
  const d = open()
  question(d, 'alpha')
  advanceClock()
  question(d, 'beta')
  closeProject(d, 'beta')
  setViewport(1400)
  await bootApp(d)

  click(document.querySelector('.closed-fold .rail-tab[data-project="beta"]'))
  await settle()
  setViewport(900)
  await settle()
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
  expect(archivedPopover()).toBeNull()

  advanceClock()
  question(d, 'gamma')
  await pollTick()
  expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
  expect(archivedPopover()).toBeNull()
})

describe.each([
  [621, false],
  [640, false],
  [652, false],
  [653, true],
] as const)('project disclosure boundary at %ipx', (width, tablet) => {
  it(`uses ${tablet ? 'tablet' : 'phone'} project controls`, async () => {
    const d = open()
    question(d, 'alpha')
    advanceClock()
    question(d, 'beta')
    closeProject(d, 'beta')
    setViewport(width)
    await bootApp(d)

    expect(document.getElementById('projectDisclosure')?.classList.contains('tablet-projects')).toBe(tablet)
    expect(archiveAction('alpha')?.tabIndex).toBe(-1)
    expect(archivedTrigger() !== null).toBe(tablet)
    expect(document.querySelector('.closed-fold') !== null).toBe(!tablet)
  })
})
