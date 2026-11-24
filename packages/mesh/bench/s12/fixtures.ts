// Bench S12's fixtures (unslop-code, step 1). Fifteen small, unit-tested functions
// of this repository at v2.20.0, frozen as text in functions/: `<id>.original.txt`
// is the function as it was, `<id>.given.txt` what a model is given. Ten have
// typical AI slop added on purpose so that a right answer is known, each added
// piece listed below as an instance: a category and a pattern that must be gone
// from a cleaned version (only `comment` instances are this module's to remove).
// Five are left as they were, and the right answer for them is "unchanged". Every
// given text holds all of its original's comments.
//
// The three scope fixtures are written here: only some of their lines are added,
// and their recorded answer also lists a comment the guards must keep.
import { readFileSync } from 'node:fs'
import type { DropReason } from '../../src/code-slop.js'

export type Category = 'comment' | 'defensive' | 'trycatch' | 'nesting' | 'any' | 'other'
export type Instance = { cat: Category; gone: string }
export type CodeFixture = { id: string; from: string; ext: '.js' | '.ts'; seeded: boolean; given: string; original: string; instances: Instance[] }
export type Answer = { remove: string; keep: string }
export type ScopeFixture = {
  id: string
  ext: '.js' | '.ts'
  source: string
  added: number[]
  answer: Answer
  expect: { remove: number[]; dropped: { line: number; why: DropReason }[] }
}

const c = (gone: string): Instance => ({ cat: 'comment', gone })
const LIST: Array<Omit<CodeFixture, 'given' | 'original'>> = [
  { id: 'find-age', from: 'public/find.js', ext: '.js', seeded: true,
    instances: [c('Convert the age from milliseconds'), c('Check if the age is less than'), c('Calculate the hours'), c('Finally, return the age')] },
  { id: 'keep-in-place', from: 'public/find.js', ext: '.js', seeded: true,
    instances: [{ cat: 'defensive', gone: '!Array\\.isArray\\(rows\\)' }, { cat: 'trycatch', gone: 'Error placing kept rows' }, c('Return the combined list'), { cat: 'other', gone: '=== true' }] },
  { id: 'chat-rows', from: 'public/find.js', ext: '.js', seeded: true,
    instances: [{ cat: 'nesting', gone: 'let result = \\[\\]' }, c('Initialize the result array'), c('Get the home directory')] },
  { id: 'plan-segments', from: 'public/lanes.js', ext: '.js', seeded: true,
    instances: [{ cat: 'defensive', gone: 'states === null \\|\\| states === undefined' }, c('Validate the input'), c('Loop through each state'), c('Return the result')] },
  { id: 'plan-bar-label', from: 'public/lanes.js', ext: '.js', seeded: true,
    instances: [{ cat: 'trycatch', gone: 'Failed to build plan bar label' }, c('Build the parts of the label')] },
  { id: 'plan-sections', from: 'public/boards.js', ext: '.js', seeded: true,
    instances: [c('Iterate over all the plans'), c('Check if the plan has any rows'), c('Determine which section'), { cat: 'nesting', gone: 'else \\{\\s*if \\(' }] },
  { id: 'filter-chats', from: 'public/chats.js', ext: '.js', seeded: true,
    instances: [c('Normalize the query string'), c('Filter by tool'), c('Filter by project'), { cat: 'any', gone: '@type \\{any\\}' }] },
  { id: 'clean-title', from: 'src/chat-parse.ts', ext: '.ts', seeded: true,
    instances: [{ cat: 'trycatch', gone: 'Error cleaning title' }, { cat: 'any', gone: 's as any' }, c('Convert the string to an array')] },
  { id: 'is-public-address', from: 'src/public-address.ts', ext: '.ts', seeded: true,
    instances: [{ cat: 'defensive', gone: "typeof address !== 'string'" }, c('Make sure the address is a valid string'), { cat: 'nesting', gone: 'else \\{\\s*if \\(' }] },
  { id: 'claim', from: 'src/agent-card.ts', ext: '.ts', seeded: true,
    instances: [c('Step 1:'), c('Step 2:'), c('Step 3:'), { cat: 'any', gone: 'v as any' }, { cat: 'any', gone: 'as any\\[\\]' }, { cat: 'any', gone: 'ch: any' }] },
  // left as they are: good code with comments that explain why
  { id: 'find-row', from: 'public/find.js', ext: '.js', seeded: false, instances: [] },
  { id: 'plan-step-states', from: 'public/lanes.js', ext: '.js', seeded: false, instances: [] },
  { id: 'read-chat', from: 'public/chats.js', ext: '.js', seeded: false, instances: [] },
  { id: 'clean-copilot-name', from: 'src/chat-parse.ts', ext: '.ts', seeded: false, instances: [] },
  { id: 'stalled', from: 'public/boards.js', ext: '.js', seeded: false, instances: [] },
]

const text = (name: string): string => readFileSync(new URL(`./functions/${name}`, import.meta.url), 'utf8')
export const FIXTURES: CodeFixture[] = LIST.map((f) => ({ ...f, given: text(`${f.id}.given.txt`), original: text(`${f.id}.original.txt`) }))

const lines = (...l: string[]): string => `${l.join('\n')}\n`
export const SCOPE: ScopeFixture[] = [
  {
    id: 'scope-outside', ext: '.js',
    source: lines(
      "// Sums the visible rows' heights, for the scroll position.",
      'export function height(rows) {',
      '  let total = 0',
      '  // Loop through the rows',
      '  for (const row of rows) {',
      "    // Add the row's height",
      '    if (!row.hidden) total += row.height',
      '  }',
      '  return total',
      '}',
    ),
    // the change added the inner two lines; line 4 was already there
    added: [6, 7],
    answer: { remove: '{"remove":[4,6]}', keep: '{"keep":[1]}' },
    expect: { remove: [6], dropped: [{ line: 4, why: 'out-of-change' }] },
  },
  {
    id: 'scope-declaration', ext: '.js',
    source: lines(
      'export function parse(text) {',
      '  // Split the text and trim each line',
      '  return text.split(EOL).map(line)',
      '}',
      '',
      '// Trim the line',
      'function line(raw) {',
      '  return raw.trim()',
      '}',
    ),
    added: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    answer: { remove: '{"remove":[2,6]}', keep: '{"keep":[]}' },
    expect: { remove: [2], dropped: [{ line: 6, why: 'above-a-declaration' }] },
  },
  {
    id: 'scope-claimed', ext: '.ts',
    source: lines(
      'export function retryDelay(attempt: number): number {',
      '  // Calculate the delay',
      '  const base = 250 * 2 ** attempt',
      '  // at most 30 s: the server drops a socket idle for 60 s',
      '  return Math.min(base, 30_000)',
      '}',
    ),
    added: [1, 2, 3, 4, 5, 6],
    answer: { remove: '{"remove":[2,4]}', keep: '{"keep":[4]}' },
    expect: { remove: [2], dropped: [{ line: 4, why: 'claimed-kept' }] },
  },
]
