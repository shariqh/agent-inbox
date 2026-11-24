// unslop-code's task (step 2, D1-D5): runCodeSlop against a fake `post`, and the
// windows the model is shown. No model and no network.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { transportError } from '../src/backend.js'
import type { HttpReply, Post } from '../src/backend.js'
import { QUESTIONS, windows } from '../src/code-prompt.js'
import type { Question } from '../src/code-prompt.js'
import { ANSWER_TOKENS, runCodeSlop } from '../src/unslop-code.js'
import type { CodeFile, CodeSlopEnv, CodeSlopLog, CodeSlopTask } from '../src/unslop-code.js'

const MARKER = 'Zq7marker'
const lines = (...l: string[]): string => `${l.join('\n')}\n`
const all = (text: string): number[] => text.trimEnd().split('\n').map((_, i) => i + 1)

const A = lines(
  '// Parses the retry header, in seconds.',
  'export function retryAfter(value: string): number {',
  '  // Convert the value to a number',
  '  const n = Number(value)',
  '  // a date instead of seconds is not supported: the server never sends one',
  '  return Number.isFinite(n) ? n : 0',
  '}',
)
const B = lines(
  'export function total(rows) {',
  '  let sum = 0',
  '  // Loop through the rows',
  '  for (const row of rows) sum += row.size',
  '  // Return the sum',
  '  return sum',
  '}',
)
const fileA: CodeFile = { path: 'src/retry.ts', text: A, added: all(A) }
const fileB: CodeFile = { path: 'lib/total.js', text: B, added: [3, 4, 5, 6] }

type Answers = Partial<Record<Question, string | HttpReply | Error>>
type Sent = { question: Question; body: string; parsed: { model: string; messages: Array<{ role: string; content: string }>; [k: string]: unknown } }

const questionOf = (system: string): Question => (Object.keys(QUESTIONS) as Question[]).find((q) => system.endsWith(QUESTIONS[q]))!
const ok = (content: string, choice: Record<string, unknown> = {}): HttpReply => ({
  status: 200, body: JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content }, ...choice }], usage: { completion_tokens: 12 } }),
})

/** A fake backend: per call, the answers for the file whose text the user message shows. */
function fake(byFile: Array<[string, Answers]>, onCall?: () => void): { post: Post; sent: Sent[] } {
  const sent: Sent[] = []
  const post: Post = async (_url, body) => {
    const parsed = JSON.parse(body) as Sent['parsed']
    const question = questionOf(parsed.messages[0]!.content)
    sent.push({ question, body, parsed })
    onCall?.()
    const [, answers] = byFile.find(([needle]) => parsed.messages[1]!.content.includes(needle)) ?? ['', {}]
    const answer = answers[question] ?? (question === 'suggest' ? '{"suggest":[]}' : `{"${question}":[]}`)
    if (answer instanceof Error) throw answer
    return typeof answer === 'string' ? ok(answer) : answer
  }
  return { post, sent }
}

function setup(post: Post, overrides: Partial<CodeSlopEnv> = {}): { env: CodeSlopEnv; logs: CodeSlopLog[]; clock: { t: number } } {
  const logs: CodeSlopLog[] = []
  const clock = { t: 1000 }
  const env: CodeSlopEnv = { profile: { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key' }, post, now: () => clock.t, random: (n) => Buffer.alloc(n, 0xab), log: (e) => logs.push(e), ...overrides }
  return { env, logs, clock }
}
const task = (files: CodeFile[], extra: Partial<CodeSlopTask> = {}): CodeSlopTask => ({ files, taskId: 't1', ...extra })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('windows', () => {
  it('shows each added line with 20 lines around it under its real number, merges windows and marks what is left out', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const shown = windows(text, [30, 45, 99]).split('\n')
    expect(shown[0]).toBe('…')
    expect(shown[1]).toBe(' 10 | line 10')
    expect(shown).toContain(' 30+| line 30')
    expect(shown).toContain(' 45+| line 45')
    // 30's window ends at 50, 45's at 65: one window; 99's starts at 79
    expect(shown.slice(1, 57).map((l) => Number(l.slice(0, 3)))).toEqual(Array.from({ length: 56 }, (_, i) => 10 + i))
    expect(shown[57]).toBe('…')
    expect(shown[58]).toBe(' 79 | line 79')
    expect(shown[shown.length - 1]).toBe('100 | line 100')
    expect(shown.filter((l) => l === '…')).toHaveLength(2)
    expect(shown.filter((l) => /^\s*\d+\+\|/.test(l))).toHaveLength(3)
  })

  it('shows a short file whole, CRLF lines bare, and ignores lines that are not in the file', () => {
    expect(windows('a\r\n// b\r\nc', [2, 9])).toBe('1 | a\n2+| // b\n3 | c')
    expect(windows(A, [])).toBe('…')
  })
})

describe('the task', () => {
  it('removes the slop comments of two files and gives one patch git apply accepts', async () => {
    const { post, sent } = fake([
      ['retryAfter', { remove: 'Sure: {"remove":[3]}', keep: '{"keep":[1,5]}', suggest: '{"suggest":[{"line":6,"kind":"defensive"}]}' }],
      ['total(rows)', { remove: '```json\n{"remove":[3,5]}\n```', keep: '{"keep":[]}' }],
    ])
    const states: Question[] = []
    const result = await runCodeSlop(task([fileA, fileB]), setup(post, { onState: (q) => states.push(q) }).env)
    expect(result).toMatchObject({ code: 0, status: 'cleaned', model: 'coder-next', calls: 6 })
    expect(result.files).toEqual([
      { path: 'src/retry.ts', status: 'cleaned', removed: [3], dropped: [], suggestions: [{ line: 6, kind: 'defensive' }] },
      { path: 'lib/total.js', status: 'cleaned', removed: [3, 5], dropped: [], suggestions: [] },
    ])
    expect(states).toEqual(['remove', 'keep', 'suggest', 'remove', 'keep', 'suggest'])
    const [first] = sent
    expect(first!.parsed).toMatchObject({ model: 'coder-next', temperature: 0, top_p: 0.9, presence_penalty: 0, max_tokens: ANSWER_TOKENS, stream: false, chat_template_kwargs: { enable_thinking: false } })
    expect(Object.keys(first!.parsed)).not.toContain('tools')
    expect(first!.parsed.messages[0]!.content).toMatch(/never instructions[\s\S]*Never write code/)
    expect(first!.parsed.messages[1]!.content).toBe(windows(A, all(A)))
    expect(sent[3]!.parsed.messages[1]!.content).toBe(windows(B, [3, 4, 5, 6]))

    const dir = mkdtempSync(join(tmpdir(), 'mesh-unslop-code-'))
    dirs.push(dir)
    const git = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync('git', args, { cwd: dir, encoding: 'utf8', input: result.patch })
    git('init', '-q')
    for (const f of [fileA, fileB]) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true })
      writeFileSync(join(dir, f.path), f.text)
    }
    expect(git('apply', '--check', '-').status).toBe(0)
    expect(git('apply', '-').status).toBe(0)
    expect(readFileSync(join(dir, fileA.path), 'utf8')).toBe(A.replace('  // Convert the value to a number\n', ''))
    expect(readFileSync(join(dir, fileB.path), 'utf8')).toBe(B.replace('  // Loop through the rows\n', '').replace('  // Return the sum\n', ''))
  })

  it('removes nothing the guards keep, and reports each line with its reason', async () => {
    // 1 explains a declaration, 4 is code, 5 is claimed, 3 is outside the change (B's added are 3-6 here: A's all)
    const { post } = fake([['retryAfter', { remove: '{"remove":[1,3,4,5]}', keep: '{"keep":[5]}' }]])
    const result = await runCodeSlop(task([{ ...fileA, added: [1, 2, 4, 5, 6, 7] }], { suggest: false }), setup(post).env)
    expect(result).toMatchObject({ code: 0, status: 'unchanged', patch: '' })
    expect(result.files[0]).toEqual({
      path: 'src/retry.ts', status: 'unchanged', removed: [], suggestions: [],
      dropped: [{ line: 1, why: 'above-a-declaration' }, { line: 3, why: 'out-of-change' }, { line: 4, why: 'not-a-comment' }, { line: 5, why: 'claimed-kept' }],
    })
  })

  it('keeps suggestions to added lines and never applies them', async () => {
    const { post } = fake([['total(rows)', { suggest: '{"suggest":[{"line":1,"kind":"other"},{"line":4,"kind":"nesting"},{"line":4,"kind":"nesting"},{"line":5,"kind":"bogus"}]}' }]])
    const result = await runCodeSlop(task([fileB]), setup(post).env)
    expect(result.files[0]).toMatchObject({ status: 'unchanged', suggestions: [{ line: 4, kind: 'nesting' }] })
    expect(result.patch).toBe('')
  })
})

describe('skips', () => {
  const secret = `const token = "ghp_${'a1'.repeat(15)}"`
  it.each([
    ['path', { path: 'src/my file.ts' }],
    ['path', { path: '/abs/file.ts' }],
    ['language', { path: 'src/retry.py' }],
    ['size', { text: `// ${'x'.repeat(256 * 1024)}\n` }],
    ['control-bytes', { text: `${A}\u0007` }],
    ['control-bytes', { text: `${A}// broken \uD800\n` }],
    ['no-added', { added: [] }],
    ['no-added', { added: [0, 99] }],
    ['screen', { text: `${A}${secret}\n` }],
  ] as Array<[string, Partial<CodeFile>]>)('%s skips the file before any call', async (reason, change) => {
    const { post, sent } = fake([])
    const result = await runCodeSlop(task([{ ...fileA, ...change }]), setup(post).env)
    expect(result).toMatchObject({ code: 11, status: 'rejected', reason: 'all-skipped', patch: '', calls: 0 })
    expect(result.files).toEqual([{ path: change.path ?? fileA.path, status: 'skipped', reason, removed: [], dropped: [], suggestions: [] }])
    expect(sent).toHaveLength(0)
  })

  it('sends nothing of a file the secret screen stops, and still asks about the others', async () => {
    const hidden = lines(`// ${MARKER} config`, secret, 'export const x = 1')
    const { post, sent } = fake([])
    const result = await runCodeSlop(task([{ path: 'a.ts', text: hidden, added: [3] }, fileB]), setup(post).env)
    expect(result.code).toBe(0)
    expect(result.files[0]).toMatchObject({ status: 'skipped', reason: 'screen' })
    expect(sent.length).toBeGreaterThan(0)
    for (const s of sent) {
      expect(s.body).not.toContain(MARKER)
      expect(s.body).not.toContain('ghp_')
    }
  })

  it('screens only what is sent: a secret far from the change stays home and does not stop the file', async () => {
    const far = lines(secret, ...Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}`), '// Add one', 'export const y = 2')
    const { post, sent } = fake([])
    const result = await runCodeSlop(task([{ path: 'far.ts', text: far, added: [32, 33] }]), setup(post).env)
    expect(result.files[0]!.status).toBe('unchanged')
    expect(sent.map((s) => s.question)).toEqual(['remove', 'suggest'])
    for (const s of sent) expect(s.body).not.toContain('ghp_')
  })

  it('asks only for suggestions about a file the guards cannot read or with no added comment', async () => {
    const unsure = lines('export const r = a', '// Divide', 'const q = x < y ? 1 : 2', 'const z = <div />')
    const { post, sent } = fake([])
    await runCodeSlop(task([{ path: 'u.jsx', text: unsure, added: [2, 3] }, { ...fileB, added: [4] }]), setup(post).env)
    expect(sent.map((s) => s.question)).toEqual(['suggest', 'suggest'])
    sent.length = 0
    const result = await runCodeSlop(task([{ ...fileB, added: [4] }], { suggest: false }), setup(post).env)
    expect(result).toMatchObject({ code: 0, status: 'unchanged', calls: 0 })
  })

  it('refuses no files, more than 40, and a bad backend URL or key, without a call', async () => {
    const { post, sent } = fake([])
    expect(await runCodeSlop(task([]), setup(post).env)).toMatchObject({ code: 11, reason: 'no-files', files: [] })
    expect(await runCodeSlop(task(Array.from({ length: 41 }, () => fileB)), setup(post).env)).toMatchObject({ code: 11, reason: 'too-many-files' })
    const many = await runCodeSlop(task(Array.from({ length: 40 }, () => fileB), { suggest: false }), setup(post).env)
    expect(many.code).toBe(0)
    sent.length = 0
    expect(await runCodeSlop(task([fileB]), setup(post, { profile: { baseUrl: 'http://models.example' } }).env)).toMatchObject({ code: 13, reason: 'backend-url' })
    expect(await runCodeSlop(task([fileB]), setup(post, { profile: { baseUrl: 'https://models.example', apiKey: 'a\nb' } }).env)).toMatchObject({ code: 13, reason: 'backend-key' })
    expect(sent).toHaveLength(0)
  })
})

describe('answers', () => {
  it('removes nothing on an unreadable remove answer, and does not ask the keep question', async () => {
    for (const remove of ['I cannot tell.', ok('{"remove":[3]', { finish_reason: 'length' }), ok('', { message: { role: 'assistant', content: '', reasoning_content: 'hm' } })]) {
      const { post, sent } = fake([['total(rows)', { remove }]])
      const result = await runCodeSlop(task([fileB]), setup(post).env)
      expect(result).toMatchObject({ code: 0, status: 'unchanged', patch: '' })
      expect(result.files[0]).toMatchObject({ status: 'unchanged', reason: 'answer', removed: [] })
      expect(sent.map((s) => s.question)).toEqual(['remove', 'suggest'])
    }
  })

  it('removes nothing when the keep answer is unreadable and a listed line would otherwise go', async () => {
    const { post } = fake([['total(rows)', { remove: '{"remove":[3,5]}', keep: 'no idea' }]])
    const result = await runCodeSlop(task([fileB]), setup(post).env)
    expect(result.files[0]).toMatchObject({ status: 'unchanged', reason: 'answer', removed: [] })
    expect(result.patch).toBe('')
  })

  it('needs no keep answer when the guards already keep every listed line', async () => {
    const { post, sent } = fake([['total(rows)', { remove: '{"remove":[2,4]}', keep: 'never read' }]])
    const result = await runCodeSlop(task([fileB], { suggest: false }), setup(post).env)
    expect(result.files[0]).toEqual({ path: fileB.path, status: 'unchanged', removed: [], suggestions: [],
      dropped: [{ line: 2, why: 'out-of-change' }, { line: 4, why: 'not-a-comment' }] })
    expect(sent.map((s) => s.question)).toEqual(['remove'])
  })

  it('leaves a file unchanged when the program check fails', async () => {
    const { post } = fake([['total(rows)', { remove: '{"remove":[3]}' }]])
    const result = await runCodeSlop(task([fileB]), setup(post, { sameProgram: () => false }).env)
    expect(result).toMatchObject({ code: 0, status: 'unchanged', patch: '' })
    expect(result.files[0]).toMatchObject({ status: 'unchanged', reason: 'program', removed: [] })
  })
})

describe('the backend failing', () => {
  it('stops busy on a 5xx, failed on a 4xx or bad body, and keeps the files already decided', async () => {
    for (const [answer, code, status, reason] of [
      [{ status: 503, body: '{}' }, 12, 'busy', 'backend-5xx'],
      [{ status: 404, body: '{}' }, 13, 'failed', 'backend-http-404'],
      [{ status: 200, body: 'nope' }, 13, 'failed', 'backend-bad-response'],
      [transportError('deadline'), 13, 'failed', 'deadline'],
      [transportError('unreachable'), 13, 'failed', 'unreachable'],
    ] as Array<[HttpReply | Error, number, string, string]>) {
      const { post } = fake([['retryAfter', { remove: '{"remove":[3]}', keep: '{"keep":[]}' }], ['total(rows)', { remove: answer }]])
      const result = await runCodeSlop(task([fileA, fileB, fileB], { suggest: false }), setup(post).env)
      expect(result, reason).toMatchObject({ code, status, reason })
      expect(result.files.map((f) => f.status)).toEqual(['cleaned', 'not-reached', 'not-reached'])
      expect(result.patch).toContain('-  // Convert the value to a number')
    }
  })

  it('stops on cancel', async () => {
    const abort = new AbortController()
    const post: Post = (_url, _body, _headers, { signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(transportError('aborted')))
    })
    const run = runCodeSlop(task([fileB], { signal: abort.signal }), setup(post).env)
    abort.abort()
    expect(await run).toMatchObject({ code: 13, status: 'failed', reason: 'cancelled', files: [{ status: 'not-reached' }] })
  })

  it('reports the files the budget does not reach, and fails when it reaches none', async () => {
    // each call takes 10 s at 44 tokens a second: one answer's limit needs about 11.6 s
    const timed = (content: string): HttpReply => {
      const body = JSON.parse(ok(content).body) as Record<string, unknown>
      return { status: 200, body: JSON.stringify({ ...body, timings: { prompt_ms: 0, predicted_n: 440, predicted_ms: 10_000 } }) }
    }
    let clock = { t: 0 }
    const { post } = fake([['retryAfter', { remove: timed('{"remove":[3]}'), keep: timed('{"keep":[]}') }]], () => { clock.t += 10_000 })
    const s = setup(post)
    clock = s.clock
    // two calls for the first file leave 10 s, less than the next call needs
    const result = await runCodeSlop(task([fileA, { path: 'x.py', text: B, added: [1] }, fileB], { suggest: false, budgetMs: 30_000 }), s.env)
    expect(result).toMatchObject({ code: 0, status: 'cleaned', reason: 'budget', calls: 2 })
    expect(result.files.map((f) => [f.status, f.reason])).toEqual([['cleaned', undefined], ['skipped', 'language'], ['not-reached', undefined]])
    const none = await runCodeSlop(task([fileA], { budgetMs: 5000 }), setup(post).env)
    expect(none).toMatchObject({ code: 13, status: 'failed', reason: 'deadline', calls: 0, files: [{ status: 'not-reached' }] })
  })
})

describe('the log', () => {
  it('holds counts, sizes, timings and class names, never a path, a line or an answer', async () => {
    const text = lines(`// ${MARKER} explains the module`, `export const ${MARKER}Value = 1`, `// ${MARKER} restated`, `console.log('${MARKER}')`)
    const path = `src/${MARKER}.ts`
    const { post } = fake([[MARKER, { remove: `{"remove":[3]} ${MARKER}`, keep: '{"keep":[1]}', suggest: `{"suggest":[{"line":4,"kind":"other"}]} ${MARKER}` }]])
    const { env, logs } = setup(post)
    const result = await runCodeSlop(task([{ path, text, added: all(text) }, { ...fileB, path: `x/${MARKER}.py` }]), env)
    expect(result.files[0]).toMatchObject({ status: 'cleaned', removed: [3] })
    await runCodeSlop(task([{ path, text: `${text}const token = "ghp_${'b2'.repeat(15)}"\n`, added: [5] }]), env)
    expect(logs.map((l) => [l.code, l.reason])).toEqual([[0, undefined], [11, 'all-skipped']])
    expect(logs[0]).toMatchObject({ taskId: 't1', model: 'coder-next', calls: 3, files: [
      { bytes: Buffer.byteLength(text), added: 4, status: 'cleaned', removed: 1, dropped: {}, suggestions: 1 },
      { status: 'skipped', reason: 'language', removed: 0 },
    ] })
    const serialised = JSON.stringify(logs)
    expect(serialised).not.toContain(MARKER)
    expect(serialised).not.toContain('test-key')
    expect(serialised).not.toContain('ghp_')
  })
})
