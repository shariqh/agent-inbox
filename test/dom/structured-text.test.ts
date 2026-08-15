// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, replyItem, resolveItem, upsertBoard } from '../../src/store.js'
import {
  bootApp, buttonLabelled, click, freshDb, row, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'execCommand')
  Reflect.deleteProperty(navigator, 'clipboard')
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

function expectSafeLink(link: HTMLAnchorElement | null, href: string): void {
  expect(link?.href).toBe(href)
  expect(link?.target).toBe('_blank')
  expect(link?.rel).toBe('noopener noreferrer')
}

describe('structured agent text on cards and plans', () => {
  it('renders structure and preserves collapsed Background state', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Review rollout',
      detail: 'Ready for review.\n\n- Check CI\n- Read https://example.com/review.',
      next_step: 'Choose a path at https://example.com/decision.',
      context: 'History:\n\n1. Drafted\n2. Reviewed\n\n<script>alert(1)</script>',
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const card = row(id)?.querySelector('.nrow-card')
    expect(card?.querySelectorAll('.card-tldr .structured-text li')).toHaveLength(2)
    expect(card?.querySelector('script')).toBeNull()
    expect(card?.querySelector('.card-context')?.hasAttribute('open')).toBe(false)
    expect(card?.querySelectorAll('.card-context li')).toHaveLength(2)
    expectSafeLink(
      card?.querySelector<HTMLAnchorElement>('.card-next .structured-link') ?? null,
      'https://example.com/decision',
    )
  })

  it('quarantines a card paragraph monotonically and resets on the next block', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Inspect quarantine',
      detail: [
        'Before https://prose.example/before',
        '<UI.Component disabled',
        'href="https://attribute.example/x">label</UI.Component>',
        'After https://prose.example/inert',
        '',
        'Recovered https://prose.example/recovered',
        '',
        '- <custom-widget href="https://attribute.example/list"> https://prose.example/item-inert',
        '- https://prose.example/next-item',
      ].join('\n'),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const detail = row(id)?.querySelector('.card-tldr')
    const hrefs = [...(detail?.querySelectorAll<HTMLAnchorElement>('a') ?? [])].map((link) => link.href)
    expect(hrefs).toEqual([
      'https://prose.example/before',
      'https://prose.example/recovered',
      'https://prose.example/next-item',
    ])
    expect(detail?.textContent).toContain('https://attribute.example/x')
    expect(detail?.textContent).toContain('https://prose.example/inert')
    expect(detail?.querySelectorAll('li')).toHaveLength(2)
  })

  it('leaves human-authored replies and reply context on the plain-text path', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Choose?',
      detail: 'Agent-authored https://example.com/agent',
    })
    replyItem(
      d,
      id,
      'Human reply:\n- not a list\nhttps://example.com/human',
      'Human context: https://example.com/context',
    )

    await bootApp(d)
    click(row(id))
    await settle()

    const reply = row(id)?.querySelector('.reply-block')
    expect(reply?.textContent).toContain('- not a list')
    expect(reply?.querySelector('.structured-text')).toBeNull()
    expect(reply?.querySelector('a')).toBeNull()
    expect(reply?.querySelector('li')).toBeNull()
  })

  it('uses the same renderer for board summaries, context, and outcomes', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch plan',
      rows: [{
        label: 'Publish',
        status: 'tracked',
        note: 'Release notes:\n\n- API\n- UI',
        context: 'Evidence at https://example.com/evidence.\n\nSecond paragraph.',
        outcome: 'Published safely.\n\n1. Canary\n2. Production',
      }],
    })

    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .board-row'))
    await settle()

    const panel = document.querySelector('#boards .row-panel')
    expect(panel?.querySelectorAll('.card-tldr li')).toHaveLength(2)
    expect(panel?.querySelectorAll('.outcome-block li')).toHaveLength(2)
    expect(panel?.querySelector('.card-context')?.hasAttribute('open')).toBe(false)
    expectSafeLink(
      panel?.querySelector<HTMLAnchorElement>('.card-context .structured-link') ?? null,
      'https://example.com/evidence',
    )
  })

  it('copies exact fenced source from a native button without moving focus', async () => {
    const d = open()
    const source = 'printf \'%s\\n\' "<tag>& $HOME"\ncurl https://example.com/x'
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Run locally',
      detail: ['Command:', '', '```sh', source, '```'].join('\n'),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const card = row(id)?.querySelector('.nrow-card')
    const button = card?.querySelector<HTMLButtonElement>('.structured-code-copy')
    expect(button?.tagName).toBe('BUTTON')
    expect(button?.type).toBe('button')
    expect(card?.querySelector('.structured-code code')?.textContent).toBe(source)
    expect(Reflect.get(document, Symbol.for('agent-inbox.structured-text-copy'))).toBeTruthy()
    await vi.advanceTimersByTimeAsync(2800)
    button?.focus()
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
    await settle()

    expect(writeText).toHaveBeenCalledWith(source)
    expect(document.activeElement).toBe(button)
    expect(card?.querySelector('.structured-code-status')?.textContent).toBe('Copied')
    expect(document.getElementById('structured-copy-announcer')?.textContent).toBe('Copied')

    await vi.advanceTimersByTimeAsync(300)
    expect(document.getElementById('structured-copy-announcer')?.textContent).toBe('Copied')
  })

  it('falls back after Clipboard API denial and never reports false success', async () => {
    const d = open()
    const writeText = vi.fn(async () => { throw new DOMException('Denied', 'NotAllowedError') })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Fallback',
      detail: '```\necho "$HOME"\n```',
    })

    await bootApp(d)
    click(row(id))
    await settle()
    click(row(id)?.querySelector('.structured-code-copy'))
    await settle()

    expect(writeText).toHaveBeenCalledOnce()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(row(id)?.querySelector('.structured-code-status')?.textContent).toBe('Copied')

    execCommand.mockReturnValue(false)
    click(row(id)?.querySelector('.structured-code-copy'))
    await settle()
    expect(row(id)?.querySelector('.structured-code-status')?.textContent).toBe('Copy failed')
  })

  it('renders fenced blocks through card context, board context, and outcome projections', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Card command',
      detail: '```\necho card\n```',
      context: '```sh\necho card-context\n```',
    })
    upsertBoard(d, {
      ...AGENT,
      title: 'Command plan',
      rows: [{
        label: 'Publish',
        status: 'tracked',
        context: '```sh\necho board-context\n```',
        outcome: '```text\nrelease complete\n```',
      }],
    })

    await bootApp(d)
    click(row(id))
    await settle()
    const card = row(id)?.querySelector('.nrow-card')
    expect(card?.querySelectorAll('.structured-code')).toHaveLength(2)

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .board-row'))
    await settle()
    const panel = document.querySelector('#boards .row-panel')
    expect(panel?.querySelector('.card-context .structured-code code')?.textContent).toBe('echo board-context')
    expect(panel?.querySelector('.outcome-block .structured-code code')?.textContent).toBe('release complete')
  })
})

describe('structured agent text on outcome, relay, and mission projections', () => {
  it('renders completed outcomes in receipts and relay cards', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Ship?',
      detail: 'Canary report:\n\n- healthy\n- stable',
      action_owner: 'approval',
    })
    resolveItem(d, id, 'Shipped.\n\n- Notes: https://example.com/release.\n- No rollback.')

    await bootApp(d)
    click(document.querySelector('.tab[data-tab="done"]'))
    await settle()
    click(document.querySelector(`[data-card-id="${id}"]`))
    await settle()

    const doneCard = document.querySelector(`[data-card-id="${id}"] .card`)
    expect(doneCard?.querySelectorAll('.outcome-block li')).toHaveLength(2)
    expect(doneCard?.querySelectorAll('.lifecycle-step li')).toHaveLength(2)

    click(document.querySelector('.relay-btn'))
    await settle()
    const relay = document.querySelector('[data-relay-lane="outcome"] .relay-card')
    expectSafeLink(
      relay?.querySelector<HTMLAnchorElement>('.relay-result .structured-link') ?? null,
      'https://example.com/release',
    )
  })

  it('renders plan summaries and outcomes in the mission map', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Mission',
      rows: [{
        label: 'Deploy',
        status: 'tracked',
        note: 'Checklist:\n\n- stage\n- verify',
        impact: 'Evidence: https://example.com/checks.',
        outcome: 'Complete.\n\n1. Stage\n2. Verify',
      }],
    })
    const board = listBoards(d)[0]!

    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(buttonLabelled('Plan flow', document.querySelector(`[data-card-id="${board.id}"]`)!))
    await settle()

    const mission = document.getElementById('missionbox')
    expect(mission?.querySelectorAll('.mission-node li')).toHaveLength(2)
    expect(mission?.querySelectorAll('.mission-result li')).toHaveLength(2)
    expectSafeLink(
      mission?.querySelector<HTMLAnchorElement>('.mission-node .structured-link') ?? null,
      'https://example.com/checks',
    )
  })
})
