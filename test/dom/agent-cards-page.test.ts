// @vitest-environment jsdom
// An agent's page and its card in the Agent cards tab, after the review of step 1: what an added
// agent's page says about checks (it has none), the card's quiet line for a missing copy, the
// built-ins' one-line description while no card text is known, and the agent's name once, in the
// page title. Click-driven only: keys and hashes are in test/dom/agent-cards-keys.test.ts and
// agent-cards-links.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { bootApp, click, freshDb, pollTick, settle, useDomTest } from './harness.js'
import { agent, fakeMesh } from './agent-cards-fake.js'
import { meshRows } from '../../public/mesh-section.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

const NOTE = 'The app does not check added agents. meshctl check echo does.'
const echo = (over: Record<string, unknown> = {}) => agent('echo', {
  kind: 'added', where: 'public', endpoint: 'https://agent.example.com/a2a', state: 'added', checkedAt: null,
  fix: 'Run meshctl check echo to show its card', fixQuiet: true, checkNote: NOTE, ...over,
})
const BLURB = { unslop: 'Copy-edits public text by the unslop rules.', 'request-post': 'Files a post request with your publishing service.' }
const builtIn = (name: 'unslop' | 'request-post', over: Record<string, unknown> = {}) => agent(name, { blurb: BLURB[name], ...over })
const CARD = { name: 'Echo Agent', description: 'Echoes one text.', version: '1.0.0' }

async function enter(agents: Record<string, unknown>[]) {
  db = freshDb()
  const fake = fakeMesh(agents)
  await bootApp(db, { viewer: { mesh: fake.mesh } })
  click(document.querySelector('.tab[data-tab="cards"]'))
  await settle()
  await pollTick()
  return fake
}
const card = (name: string) => [...document.querySelectorAll<HTMLElement>('#cards .ma-card')].find((el) => el.querySelector('.ma-name')?.textContent === name)!
const page = () => document.getElementById('agentPage')!
const visible = (el: Element | null) => Boolean(el) && !(el as HTMLElement).hidden
async function open(name: string) {
  click(card(name))
  await settle()
  await pollTick()
}

describe('an added agent’s page and the grid header', () => {
  it('shows no Refresh and no "checked" text, and the server’s one line instead; the grid header counts built-ins only', async () => {
    const fake = await enter([echo()])
    // only added agents: no "checked" text at all, not "not checked yet"
    const header = document.querySelector<HTMLElement>('#cards .ma-checked')!
    expect(header.hidden || header.textContent === '').toBe(true)
    await open('echo')
    expect(visible(page().querySelector('.map-refresh'))).toBe(false)
    expect(visible(page().querySelector('.map-checked'))).toBe(false)
    expect(page().querySelector('.map-checked')?.textContent).toBe('')
    expect(page().querySelector('.map-note')?.textContent).toBe(NOTE)
    expect(visible(page().querySelector('.map-note'))).toBe(true)
    expect([...page().querySelectorAll('.ma-lines dt')].map((dt) => dt.textContent)).not.toContain('Checked')
    expect(page().textContent).not.toMatch(/not checked yet|Check this agent/)
    expect(fake.s.triggers).toEqual(['open'])
  })

  it('a built-in agent still shows its checked text, Refresh and no note; with both kinds the header counts the built-in only', async () => {
    await enter([echo(), builtIn('unslop')])
    expect(document.querySelector('#cards .ma-checked')?.textContent).toBe('checked 1m ago')
    await open('unslop')
    expect(visible(page().querySelector('.map-refresh'))).toBe(true)
    expect(page().querySelector('.map-checked')?.textContent).toBe('checked 1m ago')
    expect(visible(page().querySelector('.map-note'))).toBe(false)
    expect([...page().querySelectorAll('.ma-lines dt')].map((dt) => dt.textContent)).toContain('Checked')
  })

  it('meshRows: the header text counts built-in agents only, and is empty when there are none', () => {
    const now = Date.now()
    const body = (...agents: Record<string, unknown>[]) => ({ on: true, agents, others: 0 })
    expect(meshRows(body(echo()), now).checked).toBe('')
    expect(meshRows(body(echo(), builtIn('unslop', { checkedAt: null })), now).checked).toBe('not checked yet')
    expect(meshRows(body(echo(), builtIn('unslop')), now).checked).toBe('checked 1m ago')
  })
})

describe('the card line for a missing copy', () => {
  it('is in the ordinary muted style, and a mismatching or refused copy keeps the amber one', async () => {
    const fake = await enter([echo()])
    const fix = () => card('echo').querySelector<HTMLElement>('.ma-fix')!
    expect(fix().textContent).toBe('Run meshctl check echo to show its card')
    expect(fix().classList.contains('ma-quiet')).toBe(true)
    fake.s.body = { on: true, others: 0, agents: [echo({ fix: 'Its card copy does not match; run meshctl check echo', fixQuiet: false })] }
    await pollTick()
    expect(fix().textContent).toBe('Its card copy does not match; run meshctl check echo')
    expect(fix().classList.contains('ma-quiet')).toBe(false)
  })
})

describe('the built-ins’ one-line description', () => {
  it('shows on the card and the page while no card text is known, and gives way to the card’s own or the last seen one', async () => {
    const fake = await enter([builtIn('unslop', { state: 'not-running', reason: 'starts on its first call' }), builtIn('request-post', { state: 'unreachable' })])
    const description = (name: string) => card(name).querySelector<HTMLElement>('.ma-description')!
    expect([description('unslop').textContent, description('unslop').hidden]).toEqual([BLURB.unslop, false])
    expect(description('request-post').textContent).toBe(BLURB['request-post'])
    await open('unslop')
    const lines = () => [...page().querySelectorAll('.ma-lines dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])
    expect(lines()).toContainEqual(['Description', BLURB.unslop])
    click(page().querySelector('.map-back'))
    await settle()
    // a last-seen card is known: its own description, not the line
    fake.s.body = { on: true, others: 0, agents: [
      builtIn('unslop', { state: 'not-running', lastSeen: { at: new Date().toISOString(), card: { ...CARD, name: 'unslop', description: 'Its own words.' } } }),
      builtIn('request-post', { card: { ...CARD, name: 'request-post', description: 'Own card.' } }),
    ] }
    await pollTick()
    expect(description('unslop').textContent).toBe('Its own words.')
    expect(description('request-post').textContent).toBe('Own card.')
    await open('unslop')
    expect(lines()).toContainEqual(['Description', 'Its own words.'])
    expect(page().textContent).not.toContain(BLURB.unslop)
  })

  it('an added agent with no card has no description line of its own', async () => {
    await enter([echo()])
    expect(card('echo').querySelector<HTMLElement>('.ma-description')!.hidden).toBe(true)
  })
})

describe('the agent’s name on its page', () => {
  it('shows once, as the page title; the status row starts with the state and keeps its dot, tag and the rest', async () => {
    await enter([builtIn('unslop', { state: 'not-running', reason: 'starts on its first call' })])
    await open('unslop')
    expect(document.getElementById('pageTitle')?.textContent).toBe('unslop')
    expect(page().querySelector('.map-name')).toBeNull()
    const head = page().querySelector<HTMLElement>('.map-head')!
    expect(head.textContent).not.toContain('unslop')
    expect(head.querySelector('.map-status')?.textContent).toBe('Not running · starts on its first call')
    expect(head.querySelector('.ma-dot')).not.toBeNull()
    expect(head.querySelector('.map-badge')?.textContent).toBe('Built in')
    // no extra heading on the page: the title is the one heading that names the agent
    expect(page().querySelector('h1, h2')).toBeNull()
  })
})
