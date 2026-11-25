// A fake claude program for the tests (Claude Code as a model server): a Node script named
// `claude` in a scratch folder that records its argv, cwd, environment, stdin and pid, then
// behaves as `<folder>/behaviour.json` says. The real claude is never run. Its environment is the
// agent's allow-list, so it reads its behaviour from that file, never from a variable.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Behaviour = {
  /** what it prints on stdout (a string as is, anything else as JSON) */
  stdout?: unknown
  code?: number
  /** wait this long before answering */
  delayMs?: number
  /** never answer */
  hang?: boolean
  /** answer this many calls, then never answer */
  hangAfter?: number
  /** ignore SIGTERM */
  stubborn?: boolean
  /** answer without reading stdin */
  skipStdin?: boolean
  /** print this many bytes of x */
  flood?: number
}
export type Seen = { argv: string[]; cwd: string; env: Record<string, string>; stdin: string; pid: number }

const SCRIPT = `
const fs = require('node:fs'), path = require('node:path')
const dir = path.dirname(fs.realpathSync(process.argv[1]))
const b = JSON.parse(fs.readFileSync(path.join(dir, 'behaviour.json'), 'utf8'))
let before = 0
const record = (stdin) => {
  const seenFile = path.join(dir, 'seen.json')
  const seen = fs.existsSync(seenFile) ? JSON.parse(fs.readFileSync(seenFile, 'utf8')) : []
  before = seen.length
  seen.push({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdin, pid: process.pid })
  // written whole, then renamed, so a test never reads half of it
  fs.writeFileSync(seenFile + '.tmp', JSON.stringify(seen))
  fs.renameSync(seenFile + '.tmp', seenFile)
}
if (b.stubborn) process.on('SIGTERM', () => {})
const answer = () => {
  if (b.hang || (b.hangAfter !== undefined && before >= b.hangAfter)) return setInterval(() => {}, 1000)
  if (b.flood) process.stdout.write('x'.repeat(b.flood))
  else if (b.stdout !== undefined) process.stdout.write(typeof b.stdout === 'string' ? b.stdout : JSON.stringify(b.stdout))
  process.exitCode = b.code ?? 0
}
const go = (stdin) => { record(stdin); b.delayMs ? setTimeout(answer, b.delayMs) : answer() }
if (b.skipStdin) go('')
else { let text = ''; process.stdin.setEncoding('utf8').on('data', (c) => { text += c }).on('end', () => go(text)) }
`

/** A folder holding a fake `claude` (0755) behaving as `behaviour` says. */
export function fakeClaude(behaviour: Behaviour, dir = mkdtempSync(join(tmpdir(), 'claude-fake-'))): { dir: string; program: string; set: (b: Behaviour) => void; seen: () => Seen[] } {
  const program = join(dir, 'claude')
  writeFileSync(program, `#!${process.execPath}\n${SCRIPT}`)
  chmodSync(program, 0o755)
  const set = (b: Behaviour): void => writeFileSync(join(dir, 'behaviour.json'), JSON.stringify(b))
  set(behaviour)
  const seen = (): Seen[] => (existsSync(join(dir, 'seen.json')) ? JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')) as Seen[] : [])
  return { dir, program, set, seen }
}

/** The JSON claude -p --output-format json prints for an answer. */
export const answered = (result: string, usage: Record<string, number> = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 7 }, durationApiMs: number | null = 900): Record<string, unknown> => ({
  type: 'result', subtype: 'success', is_error: false, result, api_error_status: null,
  ...(durationApiMs === null ? {} : { duration_api_ms: durationApiMs }), duration_ms: (durationApiMs ?? 0) + 1000, usage,
})
/** The JSON it prints for an error (exit 1). */
export const failed = (status: number | null, sentence: string): Record<string, unknown> => ({ type: 'result', subtype: 'success', is_error: true, result: sentence, api_error_status: status, duration_api_ms: 0, usage: { input_tokens: 0, output_tokens: 0 } })
