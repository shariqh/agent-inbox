// VIEWER PROCESS ONLY (#586). Lists Claude Code and Copilot CLI chats from metadata
// alone and serves them to GET /api/chats. Read docs/architecture/chats.md first.
//
// Rules this file keeps:
//  - It never writes to either tool's folders and never spawns a process. The
//    project name comes from git's own files, not `git` (inferProject is always
//    handed its origin, so it never shells out).
//  - It never opens events.jsonl, session.db, sessions-index.json or a lock file's
//    contents, and it reads at most a head and a tail window of a transcript.
//  - Every read goes through openRegular(): no symlink, no FIFO, owned by this user.
//    Any error means skip. Nothing here throws to its caller.
//  - Nothing is read until the first read() call.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { uptime } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { inferProject } from './infer.js'
import {
  hiddenReasons, isChatId, lockPid, parseClaudeLiveFile, parseClaudeWindows, parseGitdirPointer, parseGitOrigin,
  parseWorkspaceYaml, retentionDays, sessionFilePid,
} from './chat-parse.js'
import type { ChatHiddenReason, ChatPr, ChatTool, ClaudeMeta, CopilotMeta } from './chat-parse.js'

export type { ChatHiddenReason, ChatPr, ChatTool }

export interface ChatEntry {
  id: string
  tool: ChatTool
  /** The tool's name for the chat (Copilot's display name, Claude's custom or AI title); null when it has none. */
  title: string | null
  /** true when `title` is Copilot's automatic name (the opening of the first prompt); false for a typed name, a Claude title or no title */
  titleAuto: boolean
  project: string
  /** The folder the chat started in, which `--resume` needs; null when the files do not say. */
  cwd: string | null
  branch: string | null
  createdAt: string | null
  lastActiveAt: string | null
  live: boolean
  pr: ChatPr | null
  hidden: ChatHiddenReason[]
}

export interface ChatIndexRead {
  chats: ChatEntry[]
  /** a scan cap or the fresh-read budget left some chats out of this read */
  truncated: boolean
  work: { filesRead: number; bytesRead: number }
}

export interface ChatIndex {
  read(): ChatIndexRead
  claudeDays(): number
}

export interface ChatIndexLimits {
  /** bytes of uncached transcript and yaml reads per read() */
  freshBytes: number
  claudeDirs: number
  claudeFiles: number
  copilotDirs: number
}

export interface ChatIndexOpts {
  /** the home folder holding .claude and .copilot */
  home: string
  isAlive?: (pid: number) => boolean
  now?: () => number
  bootTimeMs?: () => number
  platform?: string
  limits?: Partial<ChatIndexLimits>
}

export interface ChatsResponse {
  chats: ChatEntry[]
  counts: { total: number; hidden: number; claude: number; copilot: number; live: number }
  truncated: boolean
  retention: { claudeDays: number }
}

export const CHAT_WINDOW_BYTES = 64 * 1024
export const MAX_CHATS = 2000

const DEFAULT_LIMITS: ChatIndexLimits = { freshBytes: 64 * 1024 * 1024, claudeDirs: 2000, claudeFiles: 10000, copilotDirs: 20000 }
const MAX_YAML_BYTES = 64 * 1024
const MAX_POINTER_BYTES = 4 * 1024
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_SESSION_FILE_BYTES = 16 * 1024
const MAX_SETTINGS_BYTES = 1024 * 1024
const MAX_SESSION_FILES = 5000
const ORIGIN_TTL_MS = 60_000
const MAX_WALK = 10
// a lock or a session file written a moment before the boot time we compute still belongs to this boot
const BOOT_SLACK_MS = 5000
const SLUG_DIR = /^[A-Za-z0-9_-][\w.-]*$/
const TRANSCRIPT = /^([0-9a-f-]{36})\.jsonl$/

// ── safe reads ──────────────────────────────────────────────────────────────

interface Opened { fd: number; size: number; mtimeMs: number }

/** Open one regular file this user owns, never through a symlink and never blocking on a FIFO. */
function openRegular(path: string, follow = false): Opened | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (follow ? 0 : (constants.O_NOFOLLOW ?? 0)) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return null
  }
  try {
    const s = fstatSync(fd)
    if (s.isFile() && !(process.getuid && s.uid !== process.getuid())) return { fd, size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    // fall through to close
  }
  try { closeSync(fd) } catch { /* nothing to do */ }
  return null
}

/** Reads up to `length` bytes at `position`; `count.n` gains the bytes readSync really returned. */
function readRange(fd: number, position: number, length: number, count?: { n: number }): string {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got)
    if (n === 0) break
    got += n
  }
  if (count) count.n += got
  return buf.toString('utf8', 0, got)
}

const stamp = (s: { mtimeMs: number; size: number }) => `${s.mtimeMs}:${s.size}`
const iso = (ms: number) => new Date(ms).toISOString()
const ms = (s: string | null) => (s === null ? Number.NaN : Date.parse(s))

/** The later of two ISO timestamps; either may be null. */
function later(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return ms(b) > ms(a) ? b : a
}

interface Raw {
  entry: Omit<ChatEntry, 'project' | 'live'>
  /** the folder the project name comes from */
  folder: string | null
  /** owner/name when the files give one */
  slug: string | null
  /** use the slug only when the folder is gone: a PR's repository must not rename a chat in an existing non-git folder */
  slugIfGone?: boolean
  live: boolean
}

interface CopilotDir { name: string; dir: string; meta: CopilotMeta; hasEvents: boolean; eventsMs: number | null; locks: Array<{ pid: number; mtimeMs: number }> }

export function createChatIndex(opts: ChatIndexOpts): ChatIndex {
  const limits: ChatIndexLimits = { ...DEFAULT_LIMITS, ...opts.limits }
  const now = opts.now ?? Date.now
  const bootTimeMs = opts.bootTimeMs ?? (() => Date.now() - uptime() * 1000)
  const platform = opts.platform ?? process.platform
  const claudeRoot = join(opts.home, '.claude', 'projects')
  const sessionsDir = join(opts.home, '.claude', 'sessions')
  const copilotRoot = join(opts.home, '.copilot', 'session-state')
  const settingsFile = join(opts.home, '.claude', 'settings.json')

  // kill(pid, 0) sends nothing: EPERM means the process exists under another user, ESRCH that it is gone
  const isAlive = opts.isAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  })

  // one Map per kind, keyed by absolute path; keys a pass did not see are dropped
  const transcripts = new Map<string, { stamp: string; size: number; mtimeMs: number; whole: boolean; meta: ClaudeMeta }>()
  const workspaces = new Map<string, { stamp: string; meta: CopilotMeta | null }>()
  const folderLocks = new Map<string, { mtimeMs: number; locks: Array<{ pid: number; mtimeMs: number }> }>()
  const sessionFiles = new Map<string, { stamp: string; doc: { sessionId: string; startedAt: number | null } | null }>()
  // per folder, for ORIGIN_TTL_MS: whether it exists (one stat) and, once asked for, its git origin
  const origins = new Map<string, { at: number; exists: boolean; origin?: string | null }>()
  let settings: { stamp: string; days: number } | null = null
  let work = { filesRead: 0, bytesRead: 0 }

  function readText(path: string, max: number, follow = false): { text: string; size: number; mtimeMs: number } | null {
    const o = openRegular(path, follow)
    if (!o) return null
    const bytes = { n: 0 }
    try {
      if (o.size > max) return null
      work.filesRead++
      const text = readRange(o.fd, 0, o.size, bytes)
      return { text, size: o.size, mtimeMs: o.mtimeMs }
    } catch {
      return null
    } finally {
      closeSync(o.fd)
      work.bytesRead += bytes.n
    }
  }

  /** Head and tail windows of one transcript; the whole file when it fits in the head window. */
  function readWindows(path: string): { head: string; tail: string | null; whole: boolean; size: number; mtimeMs: number } | null {
    const o = openRegular(path)
    if (!o) return null
    const bytes = { n: 0 }
    try {
      const W = CHAT_WINDOW_BYTES
      const whole = o.size <= W
      const head = readRange(o.fd, 0, Math.min(o.size, W), bytes)
      const tail = whole ? null : readRange(o.fd, o.size - W, W, bytes)
      work.filesRead++
      return { head, tail, whole, size: o.size, mtimeMs: o.mtimeMs }
    } catch {
      return null
    } finally {
      closeSync(o.fd)
      work.bytesRead += bytes.n
    }
  }

  function listDir(path: string): Dirent[] {
    try {
      return readdirSync(path, { withFileTypes: true })
    } catch {
      return []
    }
  }

  // the tools' root folders are the user's own setup and may be symlinks; everything inside is never followed
  function isRealRoot(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  // ── liveness ──────────────────────────────────────────────────────────────

  function liveClaudeIds(alive: (pid: number) => boolean, boot: number): Set<string> {
    const live = new Set<string>()
    if (!isRealRoot(sessionsDir)) return live
    const seen = new Set<string>()
    for (const d of listDir(sessionsDir).slice(0, MAX_SESSION_FILES)) {
      const pid = sessionFilePid(d.name)
      if (pid === null || !d.isFile()) continue
      const path = join(sessionsDir, d.name)
      seen.add(path)
      let s
      try { s = lstatSync(path) } catch { continue }
      if (!s.isFile() || s.size > MAX_SESSION_FILE_BYTES) continue
      let cached = sessionFiles.get(path)
      if (!cached || cached.stamp !== stamp(s)) {
        const file = readText(path, MAX_SESSION_FILE_BYTES)
        cached = { stamp: stamp(s), doc: file ? parseClaudeLiveFile(file.text, pid) : null }
        sessionFiles.set(path, cached)
      }
      // a pid from before this boot, or a file whose start predates it, is a reused pid
      if (cached.doc && alive(pid) && (cached.doc.startedAt === null || cached.doc.startedAt >= boot - BOOT_SLACK_MS)) live.add(cached.doc.sessionId)
    }
    for (const key of sessionFiles.keys()) if (!seen.has(key)) sessionFiles.delete(key)
    return live
  }

  // ── project names, from git's own files ───────────────────────────────────

  function originOfConfig(path: string): string | null {
    const file = readText(path, MAX_CONFIG_BYTES)
    return file ? parseGitOrigin(file.text) : null
  }

  // a worktree's `.git` file points at its gitdir, whose `commondir` points at the shared config
  function originOfPointer(gitFile: string, base: string): string | null {
    const pointer = readText(gitFile, MAX_POINTER_BYTES)
    const target = pointer ? parseGitdirPointer(pointer.text) : null
    if (target === null) return null
    const gitdir = resolve(base, target)
    const common = readText(join(gitdir, 'commondir'), MAX_POINTER_BYTES)?.text.trim()
    return originOfConfig(join(common ? resolve(gitdir, common) : gitdir, 'config'))
  }

  // Only a folder that is not there (ENOENT, or a path through a file) is gone. A folder that exists but cannot
  // be read or searched still exists: the chat can be resumed once permissions are fixed (#586).
  function folderExists(folder: string): boolean {
    try {
      return statSync(folder).isDirectory()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      return code !== 'ENOENT' && code !== 'ENOTDIR'
    }
  }

  // callers walk only a folder that still exists: walking up from a deleted one could land on an unrelated repository
  function findOrigin(folder: string): string | null {
    try {
      let dir = folder
      for (let i = 0; i <= MAX_WALK; i++) {
        const git = join(dir, '.git')
        const s = lstatSync(git, { throwIfNoEntry: false })
        if (s) return s.isDirectory() ? originOfConfig(join(git, 'config')) : s.isFile() ? originOfPointer(git, dir) : null
        const up = dirname(dir)
        if (up === dir) break
        dir = up
      }
    } catch {
      // unreadable: no origin
    }
    return null
  }

  function folderInfo(folder: string, at: number): { at: number; exists: boolean; origin?: string | null } {
    const hit = origins.get(folder)
    if (hit && at - hit.at < ORIGIN_TTL_MS) return hit
    const next = { at, exists: folderExists(folder) }
    origins.set(folder, next)
    return next
  }

  function originOf(folder: string, info: { exists: boolean; origin?: string | null }): string | null {
    info.origin ??= info.exists ? findOrigin(folder) : null
    return info.origin
  }

  // ── Claude Code ───────────────────────────────────────────────────────────

  function scanClaude(budget: { left: number }, live: Set<string>): { raws: Raw[]; truncated: boolean } {
    const raws: Raw[] = []
    let truncated = false
    if (!isRealRoot(claudeRoot)) { transcripts.clear(); return { raws, truncated } }
    const files: Array<{ path: string; id: string; mtimeMs: number; size: number; stamp: string }> = []
    const dirs = listDir(claudeRoot).filter((d) => d.isDirectory() && SLUG_DIR.test(d.name))
    if (dirs.length > limits.claudeDirs) truncated = true
    for (const dir of dirs.slice(0, limits.claudeDirs)) {
      for (const f of listDir(join(claudeRoot, dir.name))) {
        const id = TRANSCRIPT.exec(f.name)?.[1]
        if (id === undefined || !isChatId(id) || !f.isFile()) continue
        if (files.length >= limits.claudeFiles) { truncated = true; break }
        const path = join(claudeRoot, dir.name, f.name)
        let s
        try { s = lstatSync(path) } catch { continue }
        if (s.isFile()) files.push({ path, id, mtimeMs: s.mtimeMs, size: s.size, stamp: stamp(s) })
      }
    }
    // newest first, so the fresh-read budget goes to recent chats
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1))
    const seen = new Set<string>()
    for (const f of files) {
      seen.add(f.path)
      let cached = transcripts.get(f.path)
      if (!cached || cached.stamp !== f.stamp) {
        const cost = f.size <= CHAT_WINDOW_BYTES ? f.size : 2 * CHAT_WINDOW_BYTES
        if (cost > budget.left) {
          // out of budget: keep showing the older read when there is one, else leave the chat out of this read
          if (!cached) truncated = true
        } else {
          const w = readWindows(f.path)
          if (w) {
            budget.left -= cost
            const meta = parseClaudeWindows(w.head, w.tail, w.whole)
            // A live chat's title scrolls out of the tail window as it grows, so a file that only grew keeps what an
            // earlier read found unless the new tail has its own. Only windowed reads on both sides qualify: a whole
            // read (the file fit in one window) is complete, and a file whose first record changed was replaced.
            const sameHead = cached !== undefined && !cached.whole && w.tail !== null && w.size >= cached.size &&
              (meta.cwd === null || cached.meta.cwd === null || meta.cwd === cached.meta.cwd) &&
              (meta.createdAt === null || cached.meta.createdAt === null || meta.createdAt === cached.meta.createdAt)
            if (cached && sameHead) {
              const fresh = parseClaudeWindows('', w.tail, false)
              if (fresh.title == null) meta.title = cached.meta.title ?? meta.title
              if (fresh.pr == null) meta.pr = cached.meta.pr ?? meta.pr
              meta.createdAt ??= cached.meta.createdAt
              meta.entrypoint ??= cached.meta.entrypoint
            }
            cached = { stamp: `${w.mtimeMs}:${w.size}`, size: w.size, mtimeMs: w.mtimeMs, whole: w.whole, meta }
            transcripts.set(f.path, cached)
          }
        }
      }
      if (!cached) continue
      const { meta } = cached
      // a transcript with no record in either window (empty, or only cut lines) says nothing about a chat
      if (meta.cwd === null && meta.createdAt === null && meta.title === null) continue
      raws.push({
        entry: {
          id: f.id,
          tool: 'claude',
          title: meta.title,
          titleAuto: false,
          cwd: meta.cwd,
          branch: meta.branch,
          createdAt: meta.createdAt,
          // the file's mtime covers a last window that held no complete record (one huge tool result still being written)
          lastActiveAt: later(meta.lastActiveAt, iso(cached.mtimeMs)),
          pr: meta.pr,
          hidden: hiddenReasons({ tool: 'claude', folder: meta.cwd, entrypoint: meta.entrypoint }),
        },
        folder: meta.cwd,
        slug: meta.pr?.repo ?? null,
        slugIfGone: true,
        live: live.has(f.id),
      })
    }
    for (const key of transcripts.keys()) if (!seen.has(key)) transcripts.delete(key)
    return { raws, truncated }
  }

  // ── Copilot CLI ───────────────────────────────────────────────────────────

  function scanCopilot(budget: { left: number }, alive: (pid: number) => boolean, boot: number): { raws: Raw[]; truncated: boolean } {
    const raws: Raw[] = []
    let truncated = false
    if (!isRealRoot(copilotRoot)) { workspaces.clear(); folderLocks.clear(); return { raws, truncated } }
    const names = listDir(copilotRoot).filter((d) => d.isDirectory() && isChatId(d.name))
    if (names.length > limits.copilotDirs) truncated = true
    const seenYaml = new Set<string>()
    const seenDir = new Set<string>()
    const dirs: CopilotDir[] = []
    for (const d of names.slice(0, limits.copilotDirs)) {
      const dir = join(copilotRoot, d.name)
      const yamlPath = join(dir, 'workspace.yaml')
      let ys
      let ds
      try {
        ys = lstatSync(yamlPath, { throwIfNoEntry: false })
        ds = lstatSync(dir)
      } catch { continue }
      if (!ys || !ys.isFile() || ys.size > MAX_YAML_BYTES || !ds.isDirectory()) continue
      seenYaml.add(yamlPath)
      let ws = workspaces.get(yamlPath)
      if (!ws || ws.stamp !== stamp(ys)) {
        if (ys.size > budget.left) { if (!ws) truncated = true } else {
          const file = readText(yamlPath, MAX_YAML_BYTES)
          if (file) {
            budget.left -= file.size
            ws = { stamp: stamp(ys), meta: parseWorkspaceYaml(file.text) }
            workspaces.set(yamlPath, ws)
          }
        }
      }
      // a folder whose workspace.yaml names another id is not this chat
      if (!ws?.meta || ws.meta.id !== d.name) continue
      // lock files change the folder's mtime, so its listing is read again only then
      seenDir.add(dir)
      let ls = folderLocks.get(dir)
      if (!ls || ls.mtimeMs !== ds.mtimeMs) {
        const locks: Array<{ pid: number; mtimeMs: number }> = []
        for (const f of listDir(dir)) {
          const pid = lockPid(f.name)
          if (pid === null || !f.isFile()) continue
          try { locks.push({ pid, mtimeMs: lstatSync(join(dir, f.name)).mtimeMs }) } catch { /* gone */ }
        }
        ls = { mtimeMs: ds.mtimeMs, locks }
        folderLocks.set(dir, ls)
      }
      // an append to events.jsonl does not change the folder's mtime, so it is checked on every pass
      let es
      try { es = lstatSync(join(dir, 'events.jsonl'), { throwIfNoEntry: false }) } catch { es = undefined }
      const hasEvents = es?.isFile() === true
      dirs.push({ name: d.name, dir, meta: ws.meta, hasEvents, eventsMs: hasEvents ? es!.mtimeMs : null, locks: ls.locks })
    }
    for (const key of workspaces.keys()) if (!seenYaml.has(key)) workspaces.delete(key)
    for (const key of folderLocks.keys()) if (!seenDir.has(key)) folderLocks.delete(key)

    // one pid in several folders is one session: only the newest lock counts
    const newest = new Map<number, { name: string; mtimeMs: number }>()
    for (const d of dirs) {
      for (const l of d.locks) {
        const cur = newest.get(l.pid)
        if (!cur || l.mtimeMs > cur.mtimeMs) newest.set(l.pid, { name: d.name, mtimeMs: l.mtimeMs })
      }
    }
    for (const d of dirs) {
      const { meta } = d
      const folder = meta.cwd
      raws.push({
        entry: {
          id: d.name,
          tool: 'copilot',
          title: meta.title,
          titleAuto: meta.titleAuto,
          cwd: folder,
          branch: meta.branch,
          createdAt: meta.createdAt,
          // updated_at lags a resumed chat: events.jsonl is appended to without touching workspace.yaml
          lastActiveAt: later(meta.updatedAt, d.eventsMs === null ? null : iso(d.eventsMs)),
          pr: null,
          hidden: hiddenReasons({ tool: 'copilot', folder, clientName: meta.clientName, hasEvents: d.hasEvents }),
        },
        folder: meta.gitRoot ?? folder,
        slug: meta.repository,
        live: d.locks.some((l) => newest.get(l.pid)?.name === d.name && l.mtimeMs >= boot - BOOT_SLACK_MS && alive(l.pid)),
      })
    }
    return { raws, truncated }
  }

  return {
    read() {
      work = { filesRead: 0, bytesRead: 0 }
      if (platform === 'win32') return { chats: [], truncated: false, work }
      const at = now()
      const boot = bootTimeMs()
      const aliveMemo = new Map<number, boolean>()
      const alive = (pid: number) => {
        let v = aliveMemo.get(pid)
        if (v === undefined) { v = isAlive(pid); aliveMemo.set(pid, v) }
        return v
      }
      const budget = { left: limits.freshBytes }
      const claude = scanClaude(budget, liveClaudeIds(alive, boot))
      const copilot = scanCopilot(budget, alive, boot)
      const byKey = new Map<string, ChatEntry>()
      for (const raw of [...claude.raws, ...copilot.raws]) {
        const found = raw.folder === null ? null : folderInfo(raw.folder, at)
        const origin = found === null ? null : originOf(raw.folder!, found)
        const slug = raw.slugIfGone && found?.exists ? null : raw.slug
        // the chat's own folder decides `folder-gone`, reusing the stat above when it is the same folder
        const cwd = raw.entry.cwd
        const cwdInfo = cwd === null ? null : cwd === raw.folder ? found : folderInfo(cwd, at)
        const entry: ChatEntry = {
          ...raw.entry,
          hidden: cwdInfo?.exists ? raw.entry.hidden : [...raw.entry.hidden, 'folder-gone'],
          // inferProject is always given its origin (a string or null), so it never runs git
          project: inferProject(raw.folder ?? '', origin ?? slug ?? null),
          live: raw.live,
        }
        const key = `${entry.tool}:${entry.id}`
        const prev = byKey.get(key)
        if (!prev || later(prev.lastActiveAt, entry.lastActiveAt) === entry.lastActiveAt) byKey.set(key, entry)
      }
      for (const [folder, o] of origins) if (at - o.at >= ORIGIN_TTL_MS) origins.delete(folder)
      return { chats: [...byKey.values()], truncated: claude.truncated || copilot.truncated, work }
    },

    claudeDays() {
      let s
      // the user's own config, often a link into a dotfiles repo, and Claude Code follows it too: still a regular, size-capped file
      try { s = statSync(settingsFile) } catch { return retentionDays(null) }
      if (settings?.stamp === stamp(s)) return settings.days
      const file = s.isFile() ? readText(settingsFile, MAX_SETTINGS_BYTES, true) : null
      const days = retentionDays(file?.text ?? null)
      settings = { stamp: stamp(s), days }
      return days
    },
  }
}

/** The /api/chats body: sorted by last activity, hidden chats out unless `all`, at most `maxChats`. Counts are over the full index. */
export function chatsResponse(read: ChatIndexRead, opts: { all: boolean; claudeDays: number; maxChats?: number }): ChatsResponse {
  const max = opts.maxChats ?? MAX_CHATS
  const sorted = [...read.chats].sort((a, b) => {
    const x = ms(a.lastActiveAt)
    const y = ms(b.lastActiveAt)
    if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1
    return (Number.isNaN(x) ? 0 : y - x) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
  const shown = opts.all ? sorted : sorted.filter((c) => c.hidden.length === 0)
  return {
    chats: shown.slice(0, max),
    counts: {
      total: sorted.length,
      hidden: sorted.filter((c) => c.hidden.length > 0).length,
      claude: sorted.filter((c) => c.tool === 'claude').length,
      copilot: sorted.filter((c) => c.tool === 'copilot').length,
      live: sorted.filter((c) => c.live).length,
    },
    truncated: read.truncated || shown.length > max,
    retention: { claudeDays: opts.claudeDays },
  }
}
