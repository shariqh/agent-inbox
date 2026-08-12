// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { closeProject, closedProjects, insertItem } from '../../src/store.js'
import {
  advanceClock, bootApp, click, freshDb, setViewport, settle, useDomTest,
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
    document.getElementById('search')?.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
    expect(archivedTrigger()?.getAttribute('aria-expanded')).toBe('false')
    expect(archivedPopover()).toBeNull()
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
    expect(popover.querySelectorAll('button')).toHaveLength(16)
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
