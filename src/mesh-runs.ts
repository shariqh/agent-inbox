// Run records (cards view V5 §5.3-§5.6, slice V5a): one JSON line per client run in
// `<mesh dir>/mesh/runs/<agent>-<YYYY-MM-DD>.jsonl`, appended by the meshctl entry that ran
// the client. A closed schema: fixed vocabularies and tight patterns only, so no field can
// carry a draft, brief, title, URL, query, key or token (§5.5). Node core only; meshctl
// imports it, never the stdio MCP server, and no viewer, page or Electron file names it.
// Writing is best effort and silent: it never changes a client's exit, stdout or stderr.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmdirSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export type RunAgent = 'unslop' | 'request-post' | 'web-search'
type Json = Record<string, unknown>

/** What a client run collects for its record (§5.3). Nothing is written until `armed` is set. */
export interface RunCollector {
  /** when the agent's mesh.json key passed its rule (ms since the epoch) */
  armed?: number
  op?: string
  /** the result's data part; only the fields §5.4 names are read from it */
  data?: Json
  task?: string
  bytesIn?: number
  /** request-post: the last phase a `wait` saw, and the caller's own arguments */
  phase?: string
  throughGo?: boolean
  channels?: string[]
  brand?: string
  /** set by the entry's catch: an internal error */
  internal?: boolean
}
export type RunEnd = { exit: number } | { exit: null; signal: NodeJS.Signals }

const KEPT_DAYS = 30
const FILE_CAP = 256 * 1024
const COUNT_MAX = 320 * 1024
// the record and its newline; the leading newline adds one more byte, so a write is at most 512
const LINE_MAX = 511
const FILE_NAME = /^(unslop|request-post|web-search)-(\d{4}-\d{2}-\d{2})\.jsonl$/
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
const { O_RDONLY, O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = constants

const OUTCOMES: Record<RunAgent, Record<number, string>> = {
  unslop: { 0: 'ok', 10: 'kept-original', 11: 'refused', 12: 'busy', 13: 'failed', 14: 'unavailable' },
  'request-post': { 0: 'ok', 11: 'refused', 12: 'busy', 13: 'unknown', 14: 'unavailable', 15: 'unavailable', 16: 'conflict', 124: 'timed-out' },
  'web-search': { 0: 'ok', 10: 'sources-only', 11: 'refused', 12: 'busy', 13: 'failed', 14: 'unavailable' },
}
const OPS: Record<RunAgent, string[]> = {
  unslop: ['pr', 'issue', 'release-notes', 'docs', 'blog'], 'request-post': ['file', 'status', 'wait'], 'web-search': ['answer', 'sources'],
}
const COMMON = ['v', 'id', 'agent', 'op', 'at', 'ms', 'exit', 'signal', 'outcome', 'reason', 'classes', 'task']
const FIELDS: Record<RunAgent, string[]> = {
  unslop: [...COMMON, 'status', 'bytesIn', 'attempts', 'model', 'rules', 'timing', 'warnings'],
  'request-post': [...COMMON, 'phase', 'created', 'throughGo', 'channels', 'brand', 'fields'],
  'web-search': COMMON,
}
const CLASS = /^[a-z][a-z0-9-]{0,23}$/
const CHANNELS = ['blog', 'x-thread', 'x-standalone', 'linkedin']
const ARGUMENTS = ['brand', 'channels', 'title', 'category', 'slug', 'sourceUrl', 'brief', 'idempotencyKey', 'keyOverride', 'requestKey', 'pageId']
const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT']
const int = (v: unknown, max = Number.MAX_SAFE_INTEGER): boolean => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max
const names = (v: unknown, max: number, ok: (s: string) => boolean): boolean =>
  Array.isArray(v) && v.length <= max && v.every((s) => typeof s === 'string' && ok(s))
const test = (re: RegExp) => (v: unknown): boolean => typeof v === 'string' && re.test(v)

// one rule per field, applied by the builder (a bad value is omitted) and by validRun
const RULES: Record<string, (v: unknown, r: Json) => boolean> = {
  v: (v) => v === 1,
  id: test(/^[a-z2-7]{10}$/),
  agent: (v) => typeof v === 'string' && Object.hasOwn(OUTCOMES, v),
  op: (v, r) => OPS[r['agent'] as RunAgent].includes(v as string),
  at: test(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  ms: (v) => int(v),
  exit: (v, r) => (v === null ? SIGNALS.includes(r['signal'] as string) : typeof v === 'number' && Object.hasOwn(OUTCOMES[r['agent'] as RunAgent], v)),
  signal: (v, r) => r['exit'] === null && SIGNALS.includes(v as string),
  // an internal error is `failed` whatever the agent's own word for its exit (§5.3)
  outcome: (v, r) => v === (r['exit'] === null ? 'interrupted' : OUTCOMES[r['agent'] as RunAgent][r['exit'] as number]) || (r['exit'] === 13 && v === 'failed'),
  reason: test(/^[a-z][a-z0-9-]{0,39}$/),
  classes: (v) => names(v, 8, (s) => CLASS.test(s)),
  task: test(/^[A-Za-z0-9-]{1,64}$/),
  status: (v) => ['rewritten', 'unchanged', 'kept-original', 'rejected', 'busy', 'failed'].includes(v as string),
  bytesIn: (v) => int(v),
  attempts: (v) => int(v, 9),
  model: test(/^[A-Za-z0-9._:/-]{1,64}$/),
  rules: test(/^[0-9a-f]{12}$/),
  timing: (v) => !!v && typeof v === 'object' && Object.keys(v).join() === 'queued,load,model,check' && Object.values(v).every((n) => int(n)),
  warnings: (v) => names(v, 8, (s) => CLASS.test(s)),
  phase: test(/^[a-z][a-z-]{0,23}$/),
  created: (v, r) => typeof v === 'boolean' && r['op'] === 'file',
  throughGo: (v, r) => typeof v === 'boolean' && r['op'] === 'wait',
  channels: (v, r) => r['exit'] === 0 && names(v, 4, (s) => CHANNELS.includes(s)),
  brand: (v, r) => r['exit'] === 0 && test(/^[a-z0-9-]{1,40}$/)(v),
  fields: (v) => names(v, 8, (s) => ARGUMENTS.includes(s)),
}

/** The record as the reader takes it (§5.7): every required field, each field by its rule, unknown fields dropped. */
function validRun(value: unknown): Json | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const r = value as Json
  if (!RULES['agent']!(r['agent'], r)) return undefined
  const out: Json = {}
  for (const key of FIELDS[r['agent'] as RunAgent]) {
    if (r[key] === undefined) {
      if (['v', 'id', 'op', 'at', 'ms', 'exit', 'outcome'].includes(key)) return undefined
      continue
    }
    if (!RULES[key]!(r[key], r)) return undefined
    out[key] = r[key]
  }
  return out
}

const list = (v: unknown, max: number): string[] | undefined => {
  const kept = (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === 'string' && CLASS.test(s)).slice(0, max)
  return kept.length ? kept : undefined
}

/** The record's line, newline included, or undefined when the run was never armed or cannot fit. */
function buildLine(agent: RunAgent, c: RunCollector, end: RunEnd, now: number): string | undefined {
  if (c.armed === undefined) return undefined
  const d = c.data ?? {}
  const ms = d['ms'] && typeof d['ms'] === 'object' ? d['ms'] as Json : {}
  const reason = c.internal ? 'internal' : d['reason']
  const r: Json = {
    v: 1, id: [...randomBytes(10)].map((b) => B32[b & 31]).join(''), agent, op: c.op, at: new Date(now).toISOString(), ms: Math.max(0, Math.round(now - c.armed)),
    exit: end.exit, signal: end.exit === null ? end.signal : undefined, reason,
  }
  r['outcome'] = end.exit === null ? 'interrupted' : reason === 'internal' ? 'failed' : OUTCOMES[agent][end.exit]
  const candidates: Json = agent === 'unslop'
    ? {
        classes: list(d['screen'], 8), task: c.task, status: d['status'], bytesIn: c.bytesIn, attempts: d['attempts'], model: d['model'],
        rules: typeof d['rulesSha256'] === 'string' ? d['rulesSha256'].slice(0, 12) : undefined,
        timing: { queued: ms['queued'], load: ms['load'], model: ms['model'], check: ms['check'] },
        warnings: list((Array.isArray(d['warnings']) ? d['warnings'] : []).map((w) => (w && typeof w === 'object' ? (w as Json)['class'] : undefined)), 8),
      }
    : agent === 'request-post'
      ? {
          classes: list(d['classes'], 8), phase: d['phase'] ?? c.phase, created: d['created'], throughGo: c.throughGo,
          channels: c.channels, brand: c.brand, fields: Array.isArray(d['fields']) ? d['fields'].filter((f) => ARGUMENTS.includes(f as string)).slice(0, 8) : undefined,
        }
      : { task: c.task }
  for (const [key, value] of Object.entries(candidates)) if (value !== undefined && RULES[key]!(value, r)) r[key] = value
  if (r['reason'] !== undefined && !RULES['reason']!(r['reason'], r)) delete r['reason']
  // the builder's last cap (§5.4): shorten the lists, then drop optional fields, until the line fits
  const optional = ['warnings', 'classes', 'fields', 'model', 'task', 'timing', 'rules', 'channels', 'brand']
  for (;;) {
    const record = validRun(r)
    if (!record) return undefined
    const line = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(line) <= LINE_MAX) return line
    const key = optional.find((k) => r[k] !== undefined)
    if (!key) return undefined
    const value = r[key]
    if (Array.isArray(value) && value.length > 1) r[key] = value.slice(0, -1)
    else delete r[key]
  }
}

const uid = (): number | undefined => process.getuid?.()

/** The runs folder, when it is a real directory this user owns that no one else can write. */
function checkedRuns(dir: string): string | undefined {
  const runs = join(dir, 'mesh', 'runs')
  try {
    const s = lstatSync(runs)
    return s.isDirectory() && (uid() === undefined || s.uid === uid()) && !(s.mode & 0o022) ? runs : undefined
  } catch {
    return undefined
  }
}

/** YYYY-MM-DD in local time, as packages/mesh dates its own files. */
function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The day files in a checked runs folder: regular files this user owns, for the agents asked. */
function dayFiles(runs: string, agents: RunAgent[]): Array<{ path: string; date: string }> {
  const found: Array<{ path: string; date: string }> = []
  for (const name of readdirSync(runs).sort()) {
    const m = FILE_NAME.exec(name)
    if (!m || !agents.includes(m[1] as RunAgent)) continue
    const path = join(runs, name)
    try {
      const s = lstatSync(path)
      if (s.isFile() && (uid() === undefined || s.uid === uid())) found.push({ path, date: m[2]! })
    } catch { /* gone */ }
  }
  return found
}

/**
 * Deletes the agents' day files dated before the kept period: the 30 local dates ending today
 * (§5.6). Symlinks, other owners and other names stay; a concurrent deletion is ignored. With
 * `apply` false it deletes nothing and only returns what it would delete.
 */
export function pruneRuns(dir: string, now: number, agents: RunAgent[] = ['unslop', 'request-post', 'web-search'], apply = true): string[] {
  const runs = checkedRuns(dir)
  if (!runs) return []
  const today = new Date(now)
  const oldest = localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (KEPT_DAYS - 1)).getTime())
  try {
    const expired = dayFiles(runs, agents).filter((file) => file.date < oldest).map((file) => file.path)
    if (apply) for (const path of expired) try { unlinkSync(path) } catch { /* ENOENT: another process deleted it */ }
    return expired
  } catch {
    return []
  }
}

/** One agent's day files with their line counts, for `forget-runs` and `--purge` (§5.9). */
export function runFiles(dir: string, agent: RunAgent): Array<{ path: string; runs: number }> {
  const runs = checkedRuns(dir)
  if (!runs) return []
  try {
    return dayFiles(runs, [agent]).map(({ path }) => {
      let count = 0
      try {
        const fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        try {
          const buf = Buffer.alloc(COUNT_MAX)
          const text = buf.toString('utf8', 0, readSync(fd, buf, 0, COUNT_MAX, 0))
          count = text.split('\n').slice(0, -1).filter((line) => line.trim()).length
        } finally { closeSync(fd) }
      } catch { /* counted as none */ }
      return { path, runs: count }
    })
  } catch {
    return []
  }
}

/** Removes the runs folder when it is empty. */
export function tidyRuns(dir: string): void {
  try { rmdirSync(join(dir, 'mesh', 'runs')) } catch { /* not empty, or not there */ }
}

/**
 * Appends one run's record (§5.6): only once armed, only into an existing `<dir>/mesh`, through
 * a 0700 folder and a 0600 day file that are real, this user's and not group or other writable;
 * one checked write, never retried, of at most 512 bytes; nothing once the file would pass
 * 256 KiB. Synchronous, so a signal handler can call it. Never throws.
 *
 * Every write is `\n<record>\n`: the leading newline seals a line an earlier writer left torn,
 * so the next record always parses, and the reader ignores the empty lines it leaves. It is
 * written unconditionally because checking the file's last byte first races: on Linux a
 * concurrent append grows the size page by page while it copies, and neither fstat nor a
 * positioned read waits for it, so a writer could see another's record half-written and add a
 * newline that record never needed.
 */
export function appendRun(dir: string, agent: RunAgent, run: RunCollector, end: RunEnd, now = Date.now()): void {
  try {
    const line = buildLine(agent, run, end, now)
    if (!line) return
    const runs = join(dir, 'mesh', 'runs')
    try {
      mkdirSync(runs, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return
    }
    if (!checkedRuns(dir)) return
    const path = join(runs, `${agent}-${localDate(now)}.jsonl`)
    const fd = openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
    let size: number
    try {
      const s = fstatSync(fd)
      if (!s.isFile() || (uid() !== undefined && s.uid !== uid()) || s.mode & 0o022) return
      size = s.size
      const bytes = Buffer.from(`\n${line}`)
      if (size + bytes.length > FILE_CAP) return
      // one write, never retried: a second could land after another writer's line
      if (writeSync(fd, bytes) !== bytes.length) return
    } finally {
      closeSync(fd)
    }
    if (size === 0) pruneRuns(dir, now, [agent])
  } catch { /* best effort: a record is never worth a changed exit or a word on stderr */ }
}
