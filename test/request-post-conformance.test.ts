// request-post conformance fixtures (#500, design 2026-11-07 §10 R1). The private service
// vendors test/fixtures/a2a-request-post/ at a pinned commit and runs the same checks; R3's
// client runs the key vectors. These tests prove every fixture conforms, that the validator
// catches a broken one, and that MANIFEST.json matches the files.
import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FINAL_PHASES, PHASES, checkCard, checkExchange, checkManifest, checkStatus, keyPreimage, normaliseTitle, requestKey,
} from './fixtures/a2a-request-post/conformance.js'
import type { KeyInput } from './fixtures/a2a-request-post/conformance.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(() => removeScratchDirs())

type Json = Record<string, any>
const DIR = new URL('./fixtures/a2a-request-post/', import.meta.url).pathname
const read = (rel: string): Json => JSON.parse(readFileSync(join(DIR, rel), 'utf8'))
const folder = (name: string): Array<[string, Json]> => readdirSync(join(DIR, name)).sort().map((f) => [f, read(`${name}/${f}`)])
const clone = (v: Json): Json => structuredClone(v)
const card = read('card.json')
const exchanges = folder('file')
const statuses = folder('status')
const byRow = (row: string): Json => clone(exchanges.find(([, x]) => x.row === row)![1])
const byPhase = (phase: string): Json => clone(statuses.find(([, x]) => x.phase === phase)![1])
const dataOf = (x: Json): Json => {
  const task = x.response.result.task
  return (task.artifacts?.[0] ?? task.status.message).parts[1].data
}
const metaOf = (x: Json): Json => x.request.params.message.metadata['urn:agent-inbox:ext:request-post:v1']

describe('request-post card (#500 §3.1)', () => {
  it('conforms', () => expect(checkCard(card)).toEqual([]))

  it('fails without the status skill, with api 2 or with streaming on', () => {
    const noStatus = clone(card)
    noStatus.skills = noStatus.skills.filter((s: Json) => s.id !== 'request-post-status')
    expect(checkCard(noStatus)).toEqual(['skills'])
    const api2 = clone(card)
    api2.capabilities.extensions[0].params.api = 2
    expect(checkCard(api2)).toEqual(['extension api'])
    const streaming = clone(card)
    streaming.capabilities.streaming = true
    expect(checkCard(streaming)).toEqual(['capabilities'])
  })
})

describe('request-post exchanges (#500 §3.3)', () => {
  it('cover every row of the exit table', () => {
    expect(exchanges.map(([, x]) => x.exit).sort((a, b) => a - b)).toEqual([0, 0, 0, 4, 11, 11, 12, 13, 14, 15, 16])
    expect(exchanges.filter(([, x]) => x.clientOnly).map(([, x]) => x.exit).sort()).toEqual([14, 15, 4])
  })

  for (const [file, x] of exchanges) it(`${file} conforms`, () => expect(checkExchange(x, card)).toEqual([]))

  it('fails a busy refusal without retryAfterMs', () => {
    const x = byRow('busy')
    delete dataOf(x).retryAfterMs
    expect(checkExchange(x, card)).toEqual(['data: busy reason and retryAfterMs'])
  })

  it('fails a refusal that echoes a matched value', () => {
    const x = byRow('refused-screen')
    x.response.result.task.status.message.parts[0].text = 'rejected: screen private-address (10.20.30.40)'
    expect(checkExchange(x, card)).toEqual(['response: echoes a value from the request'])
  })

  it('fails a validation refusal whose fields differ from the request', () => {
    const x = byRow('refused-invalid')
    dataOf(x).fields = ['category']
    expect(checkExchange(x, card)).toEqual(['data: fields'])
  })

  it('fails a conflict reported as a plain refusal', () => {
    const x = byRow('conflict')
    dataOf(x).reason = 'invalid'
    expect(checkExchange(x, card)).toContain('exit: 11 is not 16')
  })

  it('fails a request whose key is not derived from its identity', () => {
    const x = byRow('created-social')
    metaOf(x).title = 'Another title'
    expect(checkExchange(x, card)).toEqual(['request: idempotencyKey is not the derived key'])
  })

  it('fails a blog request carrying a source URL or a pull request link', () => {
    const x = byRow('created-blog')
    metaOf(x).sourceUrl = 'https://example.com/source-page'
    expect(checkExchange(x, card)).toEqual(['request: invalid sourceUrl'])
    const y = byRow('created-social')
    y.request.params.message.parts[0].text += '\nSee https://github.com/example-owner/example-site/pull/9'
    expect(checkExchange(y, card)).toEqual(['request: invalid brief'])
  })

  it('fails a created blog row that does not wait for the go', () => {
    const x = byRow('created-blog')
    dataOf(x).phase = 'queued'
    expect(checkExchange(x, card)).toEqual(['data: phase'])
  })
})

describe('request-post-status snapshots (#500 §3.3, §4.3)', () => {
  it('cover every phase', () => expect(statuses.map(([, x]) => x.phase).sort()).toEqual([...PHASES].sort()))

  for (const [file, x] of statuses) {
    it(`${file} conforms`, () => {
      expect(checkStatus(x, card)).toEqual([])
      expect(dataOf(x).phase).toBe(x.phase)
    })
  }

  it('fails awaiting-go marked not final, or carrying a status', () => {
    const x = byPhase('awaiting-go')
    dataOf(x).final = false
    expect(checkStatus(x, card)).toEqual(['final'])
    const y = byPhase('awaiting-go')
    dataOf(y).status = 'Request'
    expect(checkStatus(y, card)).toEqual(['status'])
    expect(FINAL_PHASES).toContain('awaiting-go')
  })

  it('fails an untrimmed or unmarked error and a ready row without a human action', () => {
    const x = byPhase('needs-fix')
    dataOf(x).error.text = 'x'.repeat(501)
    expect(checkStatus(x, card)).toEqual(['error'])
    delete dataOf(x).error.untrusted
    dataOf(x).error.text = 'short'
    expect(checkStatus(x, card)).toEqual(['error'])
    const y = byPhase('ready-for-human')
    delete dataOf(y).humanAction
    expect(checkStatus(y, card)).toEqual(['humanAction'])
  })
})

describe('request-post key vectors (#500 §5)', () => {
  const keys = read('keys.json') as { titles: Array<{ name: string; input: string; normalised: string }>; vectors: Array<Json & { name: string; input: KeyInput & { brief?: string }; key: string }> }
  const named = new Map(keys.vectors.map((v) => [v.name, v]))

  for (const t of keys.titles) it(`normalises: ${t.name}`, () => expect(normaliseTitle(t.input)).toBe(t.normalised))

  for (const v of keys.vectors) {
    it(`derives: ${v.name}`, () => {
      expect(keyPreimage(v.input)).toBe(v.preimage)
      expect(requestKey(v.input)).toBe(v.key)
      expect(v.key).toMatch(/^[a-z2-7]{26}$/)
      if (v.sameKeyAs) expect(v.key).toBe(named.get(v.sameKeyAs)!.key)
      if (v.differsFrom) expect(v.key).not.toBe(named.get(v.differsFrom)!.key)
    })
  }

  it('never reads the brief', () => {
    const briefs = keys.vectors.filter((v) => v.input.brief !== undefined)
    expect(briefs.length).toBeGreaterThan(1)
    for (const v of briefs) expect(v.preimage).not.toContain(v.input.brief)
  })
})

describe('request-post MANIFEST.json (#500 §10)', () => {
  it('matches every file in the folder', () => {
    expect(checkManifest(DIR)).toEqual([])
    expect(Object.keys(read('MANIFEST.json').files)).toContain('conformance.ts')
  })

  it('names a changed, an added and a removed file', () => {
    const copy = scratchDir('request-post-fixtures-')
    cpSync(DIR, copy, { recursive: true })
    writeFileSync(join(copy, 'card.json'), readFileSync(join(copy, 'card.json'), 'utf8').replace('"api": 1', '"api": 2'))
    writeFileSync(join(copy, 'extra.json'), '{}\n')
    const manifest = JSON.parse(readFileSync(join(copy, 'MANIFEST.json'), 'utf8'))
    delete manifest.files['keys.json']
    writeFileSync(join(copy, 'MANIFEST.json'), JSON.stringify(manifest))
    expect(checkManifest(copy)).toEqual(['card.json', 'extra.json', 'keys.json'])
  })
})
