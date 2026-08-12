// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { closeProject, closedProjects, insertItem } from '../../src/store.js'
import {
  advanceClock, bootApp, click, freshDb, pollTick, rowTitles, searchFor, setViewport, settle, useDomTest,
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

function pointer(el: Element, type: 'pointerdown' | 'pointerup'): void {
  el.dispatchEvent(new window.PointerEvent(type, { bubbles: true }))
}

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
  it('archives through an explicit focusable action and reopens from the anchored popover', async () => {
    const d = open()
    question(d, 'alpha-project')
    advanceClock()
    question(d, 'beta-project')
    setViewport(width)
    await bootApp(d)

    const archive = archiveAction('beta-project')!
    expect(archive.textContent).toBe('Archive')
    expect(archive.tabIndex).toBe(0)
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
  })
})

describe('tablet archived-project popover behavior', () => {
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

  it('auto-opens and marks archived-only search matches', async () => {
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

    expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('true')
    expect(archivedTrigger()?.textContent).toContain('1 match')
    const beta = archivedPopover()?.querySelector('[data-project="beta"]')
    expect(beta?.classList.contains('search-match')).toBe(true)
    expect(beta?.querySelector('.rail-match')?.textContent).toBe('1')
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
    expect(archiveAction('alpha')?.tabIndex).toBe(tablet ? 0 : -1)
    expect(archivedTrigger() !== null).toBe(tablet)
    expect(document.querySelector('.closed-fold') !== null).toBe(!tablet)
  })
})
