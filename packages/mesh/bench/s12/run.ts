// Bench S12, live (unslop-code, step 2): runs runCodeSlop in this process against
// a real OpenAI-compatible backend, one task per fixture (the fifteen functions,
// every line added, and the six change fixtures), and scores the results with the
// step 1 scorer. The model's raw answers, each task's result and the scores go to
// the --out folder (0700, files 0600, never inside this checkout). The key is read
// from --key-file and goes only into the Authorization header. It reads no profile
// and nothing under the mesh folder, and never runs in CI.
//   npm run bench:s12 -- --base-url <url> --out <dir> [--model <name>] [--key-file <path>] [--only <id,...>] [--no-suggest]
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { post as httpPost } from '../../src/backend.js'
import type { Post } from '../../src/backend.js'
import type { Question } from '../../src/code-prompt.js'
import { removeLines } from '../../src/code-slop.js'
import { readPrivate, writePrivate } from '../../src/files.js'
import { runCodeSlop } from '../../src/unslop-code.js'
import type { CodeFile, CodeSlopResult } from '../../src/unslop-code.js'
import { checkoutRoot } from '../s11/run.js'
import { CHANGES, FIXTURES } from './fixtures.js'
import { scoreChange, scoreOutput, summarize, summarizeChanges, total, totalChanges } from './score.js'

const USAGE = 'usage: npm run bench:s12 -- --base-url <url> --out <dir> [--model <name>] [--key-file <path>] [--only <id,...>] [--no-suggest]'

type Item = { id: string; set: 'functions' | 'changes'; file: CodeFile }
type Raw = { question: Question | undefined; status: number; content: string }

const allLines = (text: string): number[] => text.trimEnd().split('\n').map((_, i) => i + 1)
const ITEMS: Item[] = [
  ...FIXTURES.map((f): Item => ({ id: f.id, set: 'functions', file: { path: `functions/${f.id}${f.ext}`, text: f.given, added: allLines(f.given) } })),
  ...CHANGES.map((f): Item => ({ id: f.id, set: 'changes', file: { path: f.from, text: f.given, added: f.added } })),
]

/** The answer's message text when the body is the usual JSON, else the body. */
function contentOf(body: string): string {
  try {
    const content = (JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
    if (typeof content === 'string') return content
  } catch { /* not JSON */ }
  return body
}

export async function main(argv: string[], print: (text: string) => void = (t) => process.stdout.write(t), post: Post = httpPost): Promise<number> {
  const opts = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!
    if (name === '--no-suggest') opts.set(name, '')
    else if (['--base-url', '--model', '--key-file', '--out', '--only'].includes(name) && argv[i + 1] !== undefined) opts.set(name, argv[++i]!)
    else return (process.stderr.write(`${USAGE}\n`), 4)
  }
  const baseUrl = opts.get('--base-url')
  const out = opts.get('--out')
  if (!baseUrl || !out) return (process.stderr.write(`${USAGE}\n`), 4)
  const inside = relative(checkoutRoot(), resolve(out))
  if (inside.split(sep)[0] !== '..' && !isAbsolute(inside)) throw new Error(`${out} is inside the checkout: the out folder stays outside the repository`)
  const only = opts.get('--only')?.split(',')
  const unknown = only?.filter((id) => !ITEMS.some((item) => item.id === id))
  if (unknown?.length) throw new Error(`no fixture named ${unknown.join(', ')}`)
  // readPrivate: a regular file of this user's, mode 0600; its errors name the path, never the content
  const apiKey = opts.has('--key-file') ? readPrivate(opts.get('--key-file')!).trim() : undefined
  mkdirSync(out, { recursive: true, mode: 0o700 })

  const results = new Map<string, CodeSlopResult>()
  for (const item of ITEMS.filter((i) => !only || only.includes(i.id))) {
    const raw: Raw[] = []
    let question: Question | undefined
    const recording: Post = async (url, body, headers, options) => {
      const reply = await post(url, body, headers, options)
      raw.push({ question, status: reply.status, content: contentOf(reply.body) })
      return reply
    }
    const started = performance.now()
    const result = await runCodeSlop({ files: [item.file], suggest: !opts.has('--no-suggest'), taskId: item.id }, {
      profile: { baseUrl, apiKey, model: opts.get('--model') }, post: recording, onState: (q) => { question = q },
    })
    results.set(item.id, result)
    writePrivate(join(out, `${item.id}.answers.json`), `${JSON.stringify({ id: item.id, set: item.set, raw, result }, null, 1)}\n`)
    process.stderr.write(`s12: ${item.id} exit ${result.code}${result.reason ? ` (${result.reason})` : ''} in ${Math.round(performance.now() - started)} ms\n`)
  }

  const decision = (id: string): { remove: number[]; dropped: CodeSlopResult['files'][number]['dropped'] } => {
    const file = results.get(id)?.files[0]
    return { remove: file?.status === 'cleaned' ? file.removed : [], dropped: file?.dropped ?? [] }
  }
  const functions = total(FIXTURES.filter((f) => results.has(f.id)).map((f) => scoreOutput(f, removeLines(f.given, decision(f.id).remove), decision(f.id))))
  const changes = totalChanges(CHANGES.filter((f) => results.has(f.id)).map((f) => scoreChange(f, decision(f.id))))
  const suggestions = [...results.values()].reduce((n, r) => n + (r.files[0]?.suggestions.length ?? 0), 0)
  const unfinished = [...results].filter(([, r]) => r.code !== 0 || r.files[0]?.reason).map(([id, r]) => `${id} (${r.reason ?? r.files[0]?.reason})`)
  const summary = [
    summarize(functions), summarizeChanges(changes),
    `# S12 run\n\n- Model: ${[...results.values()][0]?.model ?? opts.get('--model') ?? 'none'}.\n- Suggestions made: ${suggestions}.\n`
      + `- Calls: ${[...results.values()].reduce((n, r) => n + r.calls, 0)}.\n`
      + (unfinished.length ? `- With a reason: ${unfinished.join(', ')}.\n` : ''),
  ].join('\n')
  writePrivate(join(out, 'scores.json'), `${JSON.stringify({ functions, changes, suggestions }, null, 1)}\n`)
  writePrivate(join(out, 'summary.md'), summary)
  print(summary)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error: Error) => {
    process.stderr.write(`s12: ${error.message}\n`)
    process.exitCode = 1
  })
}
