// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, replyItem, resolveItem, upsertBoard } from '../../src/store.js'
import {
  bootApp, buttonLabelled, click, freshDb, row, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

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
  it('renders item paragraphs/lists/links and preserves collapsed Background state', async () => {
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
    expect(card?.querySelectorAll('.card-tldr .structured-text p')).toHaveLength(1)
    expect(card?.querySelectorAll('.card-tldr .structured-text li')).toHaveLength(2)
    expect(card?.querySelector('.card-tldr')?.textContent).toContain('Check CI')
    expect(card?.querySelector('script')).toBeNull()
    expect(card?.querySelector('.card-context')?.hasAttribute('open')).toBe(false)
    expect(card?.querySelectorAll('.card-context li')).toHaveLength(2)
    expectSafeLink(
      card?.querySelector<HTMLAnchorElement>('.card-next .structured-link') ?? null,
      'https://example.com/decision',
    )
  })

  it('keeps quoted tag URLs inert and separates Unicode/adjacent prose links on cards', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Inspect boundaries',
      detail: [
        '<a title=">" href="https://attribute.example/x">raw</a>',
        'See https://one.example/x… and https://two.example/x,https://three.example/x',
      ].join('\n'),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const detail = row(id)?.querySelector('.card-tldr')
    const hrefs = [...(detail?.querySelectorAll<HTMLAnchorElement>('a') ?? [])].map((link) => link.href)
    expect(hrefs).toEqual([
      'https://one.example/x',
      'https://two.example/x',
      'https://three.example/x',
    ])
    expect(detail?.textContent).toContain('https://attribute.example/x')
    expect(detail?.textContent).toContain('https://one.example/x…')
  })

  it('recovers from comments and compact comparisons on a real card', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Inspect parser recovery',
      detail: [
        '<!-- > https://comment.example/x -->',
        'if (x<y && a === z)',
        'See «https://prose.example/x»',
        '- recovered item',
      ].join('\n'),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const detail = row(id)?.querySelector('.card-tldr')
    const links = [...(detail?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
    expect(links.map((link) => link.href)).toEqual(['https://prose.example/x'])
    expect(detail?.textContent).toContain('https://comment.example/x')
    expect(detail?.textContent).toContain('if (x<y && a === z)')
    expect(detail?.querySelector('li')?.textContent).toBe('recovered item')
  })

  it('protects JSX component attributes and carries paragraph wrappers on a real card', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Inspect framework boundaries',
      detail: [
        '<Component disabled',
        'onClick={() => open("https://attribute.example/x")}',
        'href="https://attribute.example/y">label</Component>',
        '(see',
        'https://prose.example/x?q=)',
      ].join('\n'),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const detail = row(id)?.querySelector('.card-tldr')
    const links = [...(detail?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
    expect(links.map((link) => link.href)).toEqual(['https://prose.example/x?q='])
    expect(detail?.textContent).toContain('https://attribute.example/x')
    expect(detail?.textContent).toContain('https://attribute.example/y')
    expect(detail?.textContent).toContain('https://prose.example/x?q=)')
  })

  it('keeps spread-regex attributes inert without poisoning assignment-like comparisons', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Inspect cohesive scanner state',
      detail: [
        'Markup: (<a ',
        'href="https://attribute.example/x"',
        '>label</a>)',
        'Markup: (<a ',
        'href="https://attribute.example/z" <foo>>)',
        'Markup: (<a ',
        'href="https://attribute.example/w"',
        '= = =>label</a>)',
        '<Component value={[.../}>/.exec(value)]} href="https://attribute.example/y">',
        '<Component render={() => { if (value) /}>/.test(value) }} href="https://attribute.example/control">',
        '<Component render={() => { run()',
        'if (value) /}>/.test(value) }} href="https://attribute.example/asi">',
        '<Component render={() => { switch (value) { case 1: if (value) /}}}>/.test(value) } }} href="https://attribute.example/case">',
        '<Component render={() => { class Runner extends mixin(Base) {} /}}}>/.test(value) }} href="https://attribute.example/class">',
        'if x <a',
        'next = 1',
        'See https://prose.example/x',
        '- recovered item',
      ].join('\n'),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const detail = row(id)?.querySelector('.card-tldr')
    const links = [...(detail?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
    expect(links.map((link) => link.href)).toEqual(['https://prose.example/x'])
    expect(detail?.textContent).toContain('https://attribute.example/x')
    expect(detail?.textContent).toContain('https://attribute.example/y')
    expect(detail?.textContent).toContain('https://attribute.example/z')
    expect(detail?.textContent).toContain('https://attribute.example/w')
    expect(detail?.textContent).toContain('https://attribute.example/control')
    expect(detail?.textContent).toContain('https://attribute.example/asi')
    expect(detail?.textContent).toContain('https://attribute.example/case')
    expect(detail?.textContent).toContain('https://attribute.example/class')
    expect(detail?.querySelector('li')?.textContent).toBe('recovered item')
  })

  it('fails closed on a missing division operand inside switch clauses', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Inspect malformed switch clause',
      detail:
        '<Component render={() => { switch (value) { ' +
        'case one: run() /}}}>/.test(value) } }} ' +
        'href="https://attribute.example/malformed-switch">label</Component>\n' +
        'https://prose.example/x',
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const detail = row(id)?.querySelector('.card-tldr')
    expect(detail?.querySelectorAll('a')).toHaveLength(0)
    expect(detail?.textContent).toContain('https://attribute.example/malformed-switch')
    expect(detail?.textContent).toContain('https://prose.example/x')
  })

  it('protects member components and keeps entity-like query text in one card link', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Inspect final boundaries',
      detail: [
        'before <UI.Component disabled',
        'render={() => `nested ${value > 0 ? "https://attribute.example/x" : ""}`}',
        'href="https://attribute.example/y">label</UI.Component>',
        'See https://prose.example/x?a=1&amp;b=2',
      ].join('\n'),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const detail = row(id)?.querySelector('.card-tldr')
    const links = [...(detail?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
    expect(links.map((link) => link.href)).toEqual(['https://prose.example/x?a=1&amp;b=2'])
    expect(detail?.textContent).toContain('https://attribute.example/x')
    expect(detail?.textContent).toContain('https://attribute.example/y')
  })

  it('protects token-sensitive expressions and broad JSX member names on a real card', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Inspect token boundaries',
      detail: [
        'before <motion.div disabled',
        'render={() => { return /}}/.test(value) ? "https://attribute.example/x" : null }}',
        'href="https://attribute.example/y">label</motion.div>',
        'before <ui.Component<Props> value={count++ / 2}',
        'href="https://attribute.example/z">label</ui.Component>',
        '<Component href="https://attribute.example/a">x</Component><motion.div href="https://attribute.example/b">y</motion.div>',
        'if x<a and',
        'if x<motion.div and',
        'See https://prose.example/x',
        '- recovered item',
      ].join('\n'),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const detail = row(id)?.querySelector('.card-tldr')
    const links = [...(detail?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
    expect(links.map((link) => link.href)).toEqual(['https://prose.example/x'])
    expect(detail?.textContent).toContain('https://attribute.example/x')
    expect(detail?.textContent).toContain('https://attribute.example/z')
    expect(detail?.querySelector('li')?.textContent).toBe('recovered item')
  })

  it('protects statement regexes, template continuations, and Unicode JSX names', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Inspect direct parser boundaries',
      detail: [
        '<Component render={() => { foo(); /}}/.test(value) > 0 }}',
        'text={`line\\',
        '`} href="https://attribute.example/x">label</Component>',
        'before <Component 组件="https://attribute.example/y">label</Component>',
        '<组件 disabled',
        'href="https://attribute.example/z">label</组件>',
        'Markup: (<a',
        'href="https://attribute.example/multiline">label</a>)',
        '<Component value={mask ^ /}>/.test(value)} href="https://attribute.example/xor">label</Component>',
        'if x <𐊧 and',
        'text <div attr https://attribute.example/malformed <foo>>',
        'See https://prose.example/x',
        '- recovered item',
      ].join('\n'),
    })

    await bootApp(d)
    click(row(id))
    await settle()

    const detail = row(id)?.querySelector('.card-tldr')
    const links = [...(detail?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
    expect(links.map((link) => link.href)).toEqual(['https://prose.example/x'])
    expect(detail?.textContent).toContain('https://attribute.example/x')
    expect(detail?.textContent).toContain('https://attribute.example/z')
    expect(detail?.querySelector('li')?.textContent).toBe('recovered item')
  })

  it('leaves human-authored replies and reply context on their existing plain-text path', async () => {
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

  it('uses the same renderer for board row summaries, context, and outcomes', async () => {
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
})

describe('structured agent text on outcome, relay, and mission projections', () => {
  it('renders completed outcomes in both receipts and relay cards', async () => {
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
    expect(relay?.querySelectorAll('.relay-result li')).toHaveLength(2)
    expectSafeLink(
      relay?.querySelector<HTMLAnchorElement>('.relay-result .structured-link') ?? null,
      'https://example.com/release',
    )
  })

  it('renders plan summaries and explicit outcomes in the mission map', async () => {
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
