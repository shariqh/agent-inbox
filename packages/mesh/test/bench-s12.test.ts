// Bench S12 (unslop-code, step 1): the bar every later version must pass, on the
// recorded answers of the owner's local model, so no model is needed here. Step 2
// adds the change fixtures and the live runner, run here against a fake backend
// on 127.0.0.1 that answers with the recorded and the hand-written answers.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHANGES, FIXTURES, SCOPE } from '../bench/s12/fixtures.js'
import { CHANGE_ANSWERS, RECORDED } from '../bench/s12/recorded.js'
import { main } from '../bench/s12/run.js'
import { apply, comments, score, scoreChange, scoreScope, summarize, summarizeChanges, totalChanges } from '../bench/s12/score.js'
import { QUESTIONS, windows } from '../src/code-prompt.js'
import type { Question } from '../src/code-prompt.js'
import { commentLines, decide } from '../src/code-slop.js'

describe('S12 fixtures', () => {
  it('are sound: every instance is in the given text and not in the original, and every original comment is given', () => {
    expect(FIXTURES).toHaveLength(15)
    expect(FIXTURES.filter((f) => f.seeded)).toHaveLength(10)
    for (const f of FIXTURES) {
      for (const i of f.instances) {
        expect(new RegExp(i.gone).test(f.given), `${f.id}: /${i.gone}/ given`).toBe(true)
        expect(new RegExp(i.gone).test(f.original), `${f.id}: /${i.gone}/ original`).toBe(false)
      }
      for (const comment of comments(f.original)) expect(f.given, `${f.id}: ${comment}`).toContain(comment)
      if (!f.seeded) expect(f.given, f.id).toBe(f.original)
      // the scanner reads every function, so no answer is dropped as unsure
      expect(commentLines(f.given, { jsx: f.ext !== '.ts' }).unsure, f.id).toBe(false)
    }
    expect(FIXTURES.flatMap((f) => f.instances).filter((i) => i.cat === 'comment')).toHaveLength(22)
    expect(FIXTURES.reduce((n, f) => n + comments(f.original).length, 0)).toBe(31)
    expect(Object.keys(RECORDED).sort()).toEqual(FIXTURES.map((f) => f.id).sort())
  })
})

describe('S12 bar on the recorded answers', () => {
  const s = score(FIXTURES, RECORDED)

  it('removes no good comment and at least 20 of the 22 slop comments, leaves the clean functions alone and keeps every program', () => {
    expect(s.good).toEqual({ removed: 0, total: 31 })
    expect(s.slop.total).toBe(22)
    expect(s.slop.removed).toBeGreaterThanOrEqual(20)
    expect(s.clean).toEqual({ identical: 5, total: 5 })
    expect(s.sameProgram).toEqual({ holds: 15, total: 15 })
    expect(summarize(s)).toContain('- Slop comments removed: 22 of 22.')
  })

  it('keeps each scope fixture\'s guarded comment, dropped with the right reason', () => {
    expect(SCOPE.map((f) => f.expect.dropped[0]!.why)).toEqual(['out-of-change', 'above-a-declaration', 'claimed-kept'])
    for (const f of SCOPE) expect(scoreScope(f), f.id).toEqual(f.expect)
  })

  it('counts a slop comment left and a good comment lost, so the bar can fail', () => {
    const bad = { ...RECORDED, 'find-age': { remove: '{"remove":[3]}', keep: '{"keep":[]}' }, stalled: { remove: '{"remove":[5]}', keep: '{"keep":[]}' } }
    const worse = score(FIXTURES, bad)
    expect(worse.slop.removed).toBe(19)
    expect(worse.good.removed).toBe(1)
    expect(worse.clean.identical).toBe(4)
    expect(summarize(worse)).toContain('- Good comments lost in stalled: // a blocked step not yet answered still asks, or waits where the person set it aside')
  })
})

describe('S12 change fixtures', () => {
  it('are sound: planted slop is on added whole-line comments the guards let go, old comments lie outside the change', () => {
    expect(CHANGES).toHaveLength(6)
    expect(CHANGES.reduce((n, f) => n + f.slop.length, 0)).toBe(24)
    expect(CHANGES.reduce((n, f) => n + f.good.length, 0)).toBe(28)
    expect(CHANGES.reduce((n, f) => n + f.old.length, 0)).toBe(12)
    for (const f of CHANGES) {
      const lines = commentLines(f.given, { jsx: f.ext !== '.ts' })
      expect(lines.unsure, f.id).toBe(false)
      for (const n of [...f.slop, ...f.old]) expect(lines.whole.has(n), `${f.id}: ${n}`).toBe(true)
      for (const n of f.slop) expect(f.added, `${f.id}: ${n}`).toContain(n)
      for (const n of f.old) expect(f.added, `${f.id}: ${n}`).not.toContain(n)
      expect(decide({ source: f.given, added: f.added, remove: f.slop, keep: [], jsx: f.ext !== '.ts' }).remove, f.id).toEqual(f.slop)
      // the planted lines are not the file's own: none of their text is anywhere else in it
      const text = f.given.split('\n')
      for (const n of [...f.slop, ...f.old]) expect(text.filter((l) => l === text[n - 1]), `${f.id}: ${n}`).toHaveLength(1)
    }
  })

  it('score apart, and the hand-written answers remove every planted slop comment and nothing else', () => {
    const s = totalChanges(CHANGES.map((f) => scoreChange(f, apply(f.given, f.ext, CHANGE_ANSWERS[f.id]!, f.added).decision)))
    expect(s).toMatchObject({ slop: { removed: 24, total: 24 }, good: { removed: 0, total: 28 }, old: { removed: 0, total: 12 }, sameProgram: { holds: 6, total: 6 } })
    const careless = scoreChange(CHANGES[0]!, { remove: [CHANGES[0]!.good[0]!, ...CHANGES[0]!.old], dropped: [] })
    expect(careless.good.removed).toHaveLength(1)
    expect(careless.old.removed).toEqual(['// Create the set of authorities', '// Add the loopback aliases for port 80'])
    expect(summarizeChanges(totalChanges([careless]))).toContain('- Comments outside the change lost in viewer-network: // Create the set of authorities')
  })
})

describe('S12 live runner, against a fake backend', () => {
  let server: Server
  const dirs: string[] = []
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-s12-'))
    dirs.push(dir)
    return dir
  }
  afterEach(async () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  /** A backend that knows each fixture by the windows it is shown and answers as recorded. */
  async function backend(): Promise<{ base: string; asked: Question[]; auth: Array<string | undefined> }> {
    const shown = new Map<string, Record<string, string>>()
    for (const f of FIXTURES) shown.set(windows(f.given, f.given.trimEnd().split('\n').map((_, i) => i + 1)), { ...RECORDED[f.id]! })
    for (const f of CHANGES) shown.set(windows(f.given, f.added), { ...CHANGE_ANSWERS[f.id]! })
    const asked: Question[] = []
    const auth: Array<string | undefined> = []
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> }
        const question = (Object.keys(QUESTIONS) as Question[]).find((q) => body.messages[0]!.content.endsWith(QUESTIONS[q]))!
        asked.push(question)
        auth.push(req.headers.authorization)
        const content = shown.get(body.messages[1]!.content)?.[question] ?? `{"${question}":[]}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, auth }
  }

  it('runs every fixture through the task and prints the bar\'s numbers, with private files and the key nowhere', async () => {
    const { base, auth } = await backend()
    const dir = scratch()
    const out = join(dir, 'out')
    const keyFile = join(dir, 'key')
    writeFileSync(keyFile, 'Zq7secretkey\n', { mode: 0o600 })
    let printed = ''
    expect(await main(['--base-url', base, '--out', out, '--key-file', keyFile], (t) => { printed += t })).toBe(0)
    expect(printed).toContain('- Slop comments removed: 22 of 22.')
    expect(printed).toContain('- Good comments removed: 0 of 31.')
    expect(printed).toContain('- Clean functions byte-identical: 5 of 5.')
    expect(printed).toContain('- sameProgram: 15 of 15.')
    expect(printed).toContain('# S12 changes\n\n- Slop comments removed: 24 of 24.\n- Good comments removed: 0 of 28.\n- Comments outside the change removed: 0 of 12.\n- sameProgram: 6 of 6.\n')
    expect(auth.every((a) => a === 'Bearer Zq7secretkey')).toBe(true)
    expect(statSync(out).mode & 0o777).toBe(0o700)
    const files = readdirSync(out)
    expect(files).toHaveLength(21 + 2)
    for (const name of files) {
      expect(statSync(join(out, name)).mode & 0o777, name).toBe(0o600)
      expect(readFileSync(join(out, name), 'utf8'), name).not.toContain('Zq7secretkey')
    }
    expect(printed).not.toContain('Zq7secretkey')
    const answers = JSON.parse(readFileSync(join(out, 'find-age.answers.json'), 'utf8')) as { raw: Array<{ question: string; content: string }> }
    expect(answers.raw.map((r) => r.question)).toEqual(['remove', 'keep', 'suggest'])
    expect(answers.raw[0]!.content).toBe(RECORDED['find-age']!.remove)
  })

  it('runs only the fixtures named, without the suggestion question when asked', async () => {
    const { base, asked } = await backend()
    let printed = ''
    expect(await main(['--base-url', base, '--out', scratch(), '--only', 'find-age,files', '--no-suggest'], (t) => { printed += t })).toBe(0)
    expect(asked).toEqual(['remove', 'keep', 'remove', 'keep'])
    expect(printed).toContain('- Slop comments removed: 4 of 4.')
    expect(printed).toContain('# S12 changes\n\n- Slop comments removed: 4 of 4.')
  })

  it('refuses an out folder inside the checkout, a missing flag and an unknown fixture, before any call', async () => {
    const { base, asked } = await backend()
    await expect(main(['--base-url', base, '--out', join(import.meta.dirname, 'never')])).rejects.toThrow(/inside the checkout/)
    await expect(main(['--base-url', base, '--out', scratch(), '--only', 'nope'])).rejects.toThrow(/no fixture named nope/)
    expect(await main(['--out', scratch()])).toBe(4)
    expect(asked).toEqual([])
  })
})
