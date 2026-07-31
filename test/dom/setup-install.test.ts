// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  delete (window as unknown as Record<string, unknown>).agentInboxSetup
})

function open(): Database.Database {
  db = freshDb()
  return db
}

function targetSelect(): HTMLSelectElement {
  return document.querySelector('.setup-target') as HTMLSelectElement
}

async function bootSetup(): Promise<void> {
  await bootApp(open(), {
    viewer: {
      setupInfoPath: '/nonexistent/setup-info.json',
      stamp: async () => null as never,
    },
  })
  await settle()
}

describe('one-click agent setup menu', () => {
  it('offers both hosts, Claude only, and Copilot only while retaining handoff choices', async () => {
    await bootSetup()

    expect([...targetSelect().options].map((o) => [o.value, o.textContent])).toEqual([
      ['all', 'Claude Code + Copilot CLI (recommended)'],
      ['claude', 'Claude Code only'],
      ['copilot', 'Copilot CLI only'],
    ])
    expect(document.querySelector('.setup-run-btn')).toBeNull()
    expect(document.querySelector('.setup-agent-btn')?.textContent).toBe('Copy prompt for agent')
    expect(document.querySelector('.setup-command-btn')?.textContent).toBe('Copy terminal command')
    expect(document.querySelector('.setup-app-note')?.textContent).toMatch(/Electron app/i)
  })

  it('runs the selected fixed target through the Electron bridge and paints its result', async () => {
    const install = vi.fn(async (target: string) => ({
      ok: true,
      exitCode: 0,
      target,
      timedOut: false,
      output: `${target} installed`,
    }))
    Object.defineProperty(window, 'agentInboxSetup', {
      configurable: true,
      value: { available: async () => true, install },
    })
    await bootSetup()

    const select = targetSelect()
    select.value = 'copilot'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    const run = document.querySelector('.setup-run-btn') as HTMLButtonElement
    expect(run.textContent).toBe('Install Copilot CLI now')
    run.click()
    await settle()

    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith('copilot')
    expect(document.querySelector('.setup-result')?.textContent).toContain('copilot installed')
    expect(document.querySelector('.setup-result')?.classList.contains('success')).toBe(true)
  })

  it('copies an agent-ready prompt for the selected target', async () => {
    const copied: string[] = []
    const writeText = vi.fn(async (text: string) => { copied.push(text) })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    await bootSetup()

    const select = targetSelect()
    select.value = 'claude'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    ;(document.querySelector('.setup-agent-btn') as HTMLButtonElement).click()
    await settle()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(copied[0]).toContain('--target claude')
    expect(copied[0]).toMatch(/run this setup/i)
  })
})
