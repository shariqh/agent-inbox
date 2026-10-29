// ⌘K actions (#307, Dashboard 2.0 phase 5): "answer…", "open plan…" and "jump
// to session…" in the workspace search. Pure: the caller hands in the targets
// (the attention set in rail order, active plans, working sessions) and the
// fuzzy engine; activation routes through the app's existing paths.
//
// A command is its name followed by a space, so a plain search for "plan"
// stays a search. A prefix of a name (two letters or more) only suggests the
// command, which fills the box with it.
import { createBoundedMatcher } from './search.js'

const COMMANDS = [
  { id: 'answer', label: 'Answer…', kind: 'Answer', targets: 'asks', phrases: ['answer'] },
  { id: 'plan', label: 'Open plan…', kind: 'Open plan', targets: 'plans', phrases: ['open plan', 'plan'] },
  { id: 'session', label: 'Jump to session…', kind: 'Jump to session', targets: 'sessions', phrases: ['jump to session', 'jump to', 'jump', 'session'] },
]
const SECTION = { section: 'actions', sectionLabel: 'Actions' }
const LIMIT = 8

function parse(query) {
  const text = String(query ?? '').replace(/^\s+/, '').toLowerCase()
  for (const command of COMMANDS) {
    for (const phrase of command.phrases) {
      if (text.startsWith(`${phrase} `)) return { command, rest: text.slice(phrase.length).trim() }
    }
  }
  return { text: text.trim() }
}

function matched(targets, rest, searchFn) {
  if (!rest) return targets.slice(0, LIMIT)
  return (createBoundedMatcher(searchFn)(targets.map((target) => target.haystack), rest) ?? [])
    .map((match) => targets[match?.index])
    .filter(Boolean)
    .slice(0, LIMIT)
}

const result = (key, kind, title, context, action) =>
  ({ key, targetId: '', ...SECTION, kind, title, titleRanges: [], match: null, source: null, context, action })

/**
 * @param {string} query the raw search text
 * @param {{asks: any[], plans: any[], sessions: any[]}} targets each `{ key, title, context, haystack, action }`
 */
export function paletteResults(query, targets, searchFn) {
  const parsed = parse(query)
  if (parsed.command) {
    const { command, rest } = parsed
    return matched(targets?.[command.targets] ?? [], rest, searchFn)
      .map((target) => result(`${command.id}:${target.key}`, command.kind, target.title, target.context, target.action))
  }
  if (parsed.text.length < 2) return []
  return COMMANDS.filter((command) => command.phrases.some((phrase) => phrase.startsWith(parsed.text)))
    .map((command) => result(`command:${command.id}`, 'Action', command.label, 'Type to choose',
      { type: 'command', fill: `${command.phrases[0]} ` }))
}
