// VIEWER PROCESS ONLY (#586). Pure parsers for the chat index: strings in, plain
// values out. No import, no clock, no process, no disk, so every rule here tests
// on a string, and the stdio MCP server can never reach it by accident.
//
// Privacy rule: a record is parsed, the few named fields are copied and the
// record is dropped. Nothing here keeps message text. The only free text that
// leaves is a title a tool chose (Claude's ai-title and custom-title) or the
// user typed (Copilot's name when `user_named` is true).

export type ChatTool = 'claude' | 'copilot'
/** Why a chat is hidden from the default list. A chat can have several. */
export type ChatHiddenReason = 'temp' | 'non-interactive' | 'empty'

export interface ChatPr { number: number; repo: string; url: string }

export interface ClaudeMeta {
  cwd: string | null
  branch: string | null
  createdAt: string | null
  lastActiveAt: string | null
  entrypoint: string | null
  title: string | null
  pr: ChatPr | null
}

export interface CopilotMeta {
  id: string
  cwd: string | null
  gitRoot: string | null
  branch: string | null
  /** `owner/name` */
  repository: string | null
  /** Only a name the user typed. Copilot's automatic name is the start of the first prompt, so it is dropped. */
  title: string | null
  createdAt: string | null
  updatedAt: string | null
  clientName: string | null
}

export const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function isChatId(s: string): boolean {
  return CHAT_ID.test(s)
}

// kill(0) and kill(-1) signal whole groups and pid 1 is always alive, so a pid
// outside 2..2^31-1 is never a session.
const MAX_PID = 2 ** 31 - 1
function pidOf(digits: string | undefined): number | null {
  if (digits === undefined) return null
  const n = Number(digits)
  return Number.isInteger(n) && n >= 2 && n <= MAX_PID ? n : null
}
/** `inuse.<pid>.lock` */
export function lockPid(name: string): number | null {
  return pidOf(/^inuse\.(\d{1,10})\.lock$/.exec(name)?.[1])
}
/** `<pid>.json` (Claude's `<pid>.<hex>.key` files do not match) */
export function sessionFilePid(name: string): number | null {
  return pidOf(/^(\d{1,10})\.json$/.exec(name)?.[1])
}

// ── strings from other people's files ───────────────────────────────────────

const MAX_TITLE = 200
const MAX_PATH = 4096
// C0, DEL, C1, and the bidi / line-separator controls that can reorder or hide text
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu

/** One line, no control characters, at most 200 characters; null when nothing is left. */
export function cleanTitle(s: unknown): string | null {
  if (typeof s !== 'string') return null
  // whitespace controls become one space; every other control is dropped
  const one = s.slice(0, MAX_TITLE * 10).replace(/[\t\n\r\u{2028}\u{2029}]+/gu, ' ').replace(CONTROLS, '').replace(/ {2,}/g, ' ').trim()
  if (!one) return null
  const chars = Array.from(one)
  return chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE).join('') : one
}

/** An absolute POSIX path with no control character. The index is POSIX-only for now (docs/architecture/chats.md). */
export function cleanPath(s: unknown): string | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_PATH || !s.startsWith('/')) return null
  return s.search(CONTROLS) === -1 ? s : null
}

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
export function isTempFolder(path: string): boolean {
  return TEMP_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
function stamp(v: unknown): string | null {
  return typeof v === 'string' && STAMP.test(v) && Number.isFinite(Date.parse(v)) ? v : null
}

const SLUG = /^[\w.-]+\/[\w.-]+$/
function slug(v: unknown): string | null {
  return typeof v === 'string' && SLUG.test(v) ? v : null
}

function branchName(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 255 && v.search(CONTROLS) === -1 ? v : null
}

// ── a strict YAML subset (Copilot's workspace.yaml) ─────────────────────────

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*?))?[ \t]*$/
const BLOCK = /^([|>])(-?)$/

function singleQuoted(v: string): string | null {
  if (v.length < 2 || !v.endsWith("'")) return null
  const inner = v.slice(1, -1).replace(/''/g, '\0')
  // a quote left over once the '' escapes are out means the scalar ended early
  return inner.includes("'") ? null : inner.replace(/\0/g, "'")
}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', '/': '/' }
function doubleQuoted(v: string): string | null {
  if (v.length < 2 || !v.endsWith('"')) return null
  const inner = v.slice(1, -1)
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (ch === '"') return null
    if (ch !== '\\') { out += ch; continue }
    const mapped = ESCAPES[inner[++i] ?? '']
    if (mapped === undefined) return null
    out += mapped
  }
  return out
}

function plain(v: string): string | null {
  if (/^[\[\]{}&*!%@`|>#:?'",-]/.test(v) && !/^-[^\s]/.test(v)) return null
  const cut = v.search(/\s#/)
  const text = (cut === -1 ? v : v.slice(0, cut)).trimEnd()
  return text && !/:(\s|$)/.test(text) ? text : null
}

/**
 * Top-level `key: value` lines at column 0, for the named keys only. A value is a
 * plain, 'single' or "double" scalar, or a `|`, `|-`, `>`, `>-` block. Anything
 * else (flow collections, anchors, tags, nested maps, a duplicate key, an
 * unknown escape, an unterminated quote) leaves that key out and the others read.
 */
export function readYamlScalars(text: string, keys: readonly string[]): Map<string, string> {
  const want = new Set(keys)
  const out = new Map<string, string>()
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_LINE.exec(lines[i]!)
    if (!m || !want.has(m[1]!)) continue
    const key = m[1]!
    if (seen.has(key)) { out.delete(key); continue }
    seen.add(key)
    const raw = m[2] ?? ''
    const block = BLOCK.exec(raw)
    let value: string | null
    if (raw === '') {
      value = null
    } else if (block) {
      const body: string[] = []
      let j = i + 1
      for (; j < lines.length && (/^[ \t]/.test(lines[j]!) || lines[j]!.trim() === ''); j++) body.push(lines[j]!)
      while (body.length && body[body.length - 1]!.trim() === '') body.pop()
      const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length))
      const rows = body.map((l) => l.slice(Math.min(indent, l.length)).trimEnd())
      value = body.length ? rows.join(block[1] === '|' ? '\n' : ' ') : null
    } else if (raw.startsWith("'")) {
      value = singleQuoted(raw)
    } else if (raw.startsWith('"')) {
      value = doubleQuoted(raw)
    } else {
      value = plain(raw)
    }
    if (value !== null) out.set(key, value)
  }
  return out
}

const WORKSPACE_KEYS = ['id', 'cwd', 'git_root', 'branch', 'repository', 'name', 'user_named', 'client_name', 'created_at', 'updated_at'] as const

/** Copilot's workspace.yaml; null unless it names a valid chat id. */
export function parseWorkspaceYaml(text: string): CopilotMeta | null {
  const y = readYamlScalars(text, WORKSPACE_KEYS)
  const id = y.get('id')
  if (id === undefined || !isChatId(id)) return null
  const client = y.get('client_name')
  return {
    id,
    cwd: cleanPath(y.get('cwd')),
    gitRoot: cleanPath(y.get('git_root')),
    branch: branchName(y.get('branch')),
    repository: slug(y.get('repository')),
    // Copilot fills `name` with the start of the first prompt unless the user named the chat, so
    // only a user-typed name is a title (#586). Reading it any other way would return prompt text.
    title: y.get('user_named') === 'true' ? cleanTitle(y.get('name')) : null,
    createdAt: stamp(y.get('created_at')),
    updatedAt: stamp(y.get('updated_at')),
    clientName: client !== undefined && /^[\w./-]{1,64}$/.test(client) ? client : null,
  }
}

// ── Claude Code transcripts ─────────────────────────────────────────────────

function prLink(rec: Record<string, unknown>): ChatPr | null {
  const number = rec['prNumber']
  const repo = slug(rec['prRepository'])
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || repo === null) return null
  const url = `https://github.com/${repo}/pull/${number}`
  return rec['prUrl'] === url ? { number, repo, url } : null
}

/**
 * Metadata from the head and tail windows of one transcript. The head's last line
 * is dropped unless the whole file fits in it (it may be cut), and the tail's first
 * line is always dropped (it starts mid-line). `cwd` and `entrypoint` are the first
 * seen, `gitBranch` and the timestamps the last, the title the last custom-title,
 * else the last ai-title, and the PR the last valid pr-link.
 */
export function parseClaudeWindows(head: string, tail: string | null, wholeFile: boolean): ClaudeMeta {
  const headLines = head.split('\n')
  if (!wholeFile) headLines.pop()
  const tailLines = tail === null ? [] : tail.split('\n').slice(1)
  const meta: ClaudeMeta = { cwd: null, branch: null, createdAt: null, lastActiveAt: null, entrypoint: null, title: null, pr: null }
  let aiTitle: string | null = null
  let customTitle: string | null = null
  for (const line of [...headLines, ...tailLines]) {
    if (!line.startsWith('{')) continue
    let rec: unknown
    try { rec = JSON.parse(line) } catch { continue }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue
    const r = rec as Record<string, unknown>
    meta.cwd ??= cleanPath(r['cwd'])
    meta.branch = branchName(r['gitBranch']) ?? meta.branch
    const at = stamp(r['timestamp'])
    if (at) { meta.createdAt ??= at; meta.lastActiveAt = at }
    const entry = r['entrypoint']
    if (meta.entrypoint === null && typeof entry === 'string' && /^[\w.-]{1,40}$/.test(entry)) meta.entrypoint = entry
    switch (r['type']) {
      case 'ai-title': aiTitle = cleanTitle(r['aiTitle']) ?? aiTitle; break
      case 'custom-title': customTitle = cleanTitle(r['customTitle']) ?? customTitle; break
      case 'pr-link': meta.pr = prLink(r) ?? meta.pr; break
    }
  }
  meta.title = customTitle ?? aiTitle
  return meta
}

/** `~/.claude/sessions/<pid>.json`: the session id and start time, only when the file's own pid is the name's. */
export function parseClaudeLiveFile(text: string, pid: number): { sessionId: string; startedAt: number | null } | null {
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return null }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  const d = doc as Record<string, unknown>
  const sessionId = d['sessionId']
  if (d['pid'] !== pid || typeof sessionId !== 'string' || !isChatId(sessionId)) return null
  const started = d['startedAt']
  return { sessionId, startedAt: typeof started === 'number' && Number.isFinite(started) ? started : null }
}

// ── hidden by default ───────────────────────────────────────────────────────

export function hiddenReasons(input: {
  tool: ChatTool
  folder: string | null
  entrypoint?: string | null
  clientName?: string | null
  hasEvents?: boolean
}): ChatHiddenReason[] {
  const out: ChatHiddenReason[] = []
  if (input.folder !== null && isTempFolder(input.folder)) out.push('temp')
  // Claude: `sdk-cli` (print mode) and the other `sdk-*` entrypoints; claude-vscode and cli are interactive.
  // Copilot: github/cli and github/autopilot are interactive; a client such as agent-inbox-driver is not.
  // A missing client_name counts as interactive. github/cli also marks about 1,150 one-shot runs that
  // no workspace.yaml key tells apart, so they stay listed (docs/architecture/chats.md).
  const nonInteractive = input.tool === 'claude'
    ? typeof input.entrypoint === 'string' && input.entrypoint.startsWith('sdk-')
    : typeof input.clientName === 'string' && input.clientName !== 'github/cli' && input.clientName !== 'github/autopilot'
  if (nonInteractive) out.push('non-interactive')
  // Copilot made the folder and never wrote an event: nothing was said in it
  if (input.tool === 'copilot' && input.hasEvents === false) out.push('empty')
  return out
}

// ── git's own files (so the index never spawns git) ─────────────────────────

/** A `.git` file's `gitdir: <path>` line. */
export function parseGitdirPointer(text: string): string | null {
  const m = /^gitdir:[ \t]*(.+?)[ \t]*(?:\r?\n|$)/.exec(text)
  const path = m?.[1]
  return path !== undefined && path.length <= MAX_PATH && !path.includes('\0') ? path : null
}

/** The `url` under `[remote "origin"]` in a git config. */
export function parseGitOrigin(configText: string): string | null {
  let inOrigin = false
  for (const line of configText.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inOrigin = /^\s*\[remote\s+"origin"\]\s*$/.test(line)
      continue
    }
    if (!inOrigin) continue
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1]
    if (url) return url
  }
  return null
}

const DEFAULT_RETENTION_DAYS = 30
/** `cleanupPeriodDays` from ~/.claude/settings.json when it is a positive number, else 30. */
export function retentionDays(settingsText: string | null): number {
  if (settingsText === null) return DEFAULT_RETENTION_DAYS
  try {
    const days = (JSON.parse(settingsText) as { cleanupPeriodDays?: unknown } | null)?.cleanupPeriodDays
    return typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS
  } catch {
    return DEFAULT_RETENTION_DAYS
  }
}
