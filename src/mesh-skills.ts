// The mesh's routing skills (#513; mesh design §6.7, D15). A harness finds a mesh agent through a
// routing SKILL.md that points at the agent's shim, `<mesh dir>/bin/<agent>`. meshctl writes one
// folder per agent, `<mesh dir>/skills/<agent>/SKILL.md`, for each agent that mesh.json turns on
// and whose template ships here (unslop today), and removes the folders of agents that are off.
// `meshctl skills link` makes `~/.claude/skills/<agent>` (Claude Code) and `~/.agents/skills/<agent>`
// (Codex and Copilot CLI) symlinks to them; `unlink`, and turning the agent off, remove only links
// that point into `<mesh dir>/skills/`.
//
// Fixed text only (mesh design §8.5): the templates are the constants below, and the only thing
// substituted is the mesh dir's own path. No card field, mesh.json value or agent output ever
// reaches a skill file. request-post has no template: its routing text is part of a private skill
// that also holds the brief guidance (docs/request-post.md). Agents added with `meshctl add` wait
// for a follow-up. Node core only; nothing in the viewer, the frontend, Electron or the stdio MCP
// server imports this module.
import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loopbackPort } from './mesh-config.js'
import type { MeshDocument } from './mesh-config.js'

// docs/unslop.md quotes this text, and test/mesh-skills.test.ts fails when the two differ.
const UNSLOP_SKILL = `---
name: unslop
description: Remove generic AI-writing patterns from prose for people while keeping its meaning, facts, links and terms. Use when drafting or revising a PR description, an issue, release notes, public documentation, a blog post or an email. Public drafts go to the local unslop agent; email, customer text and private material are edited in-session.
---

<!-- Written by agent-inbox meshctl (#513). Do not edit: meshctl rewrites this file. -->

# unslop

The editing rules are in \`rules.md\`, in the folder that \`skill\` names in
\`<mesh dir>/mesh/wrappers/unslop.json\` (the unslop profile, which the agent reads too).

## Where the text is edited

1. Email, customer text and private material never go to the unslop agent. Edit them
   in-session with \`rules.md\`. When unsure, edit in-session.
2. For a PR description, an issue, release notes, public documentation or a blog post,
   write the draft to a file and run, with a shell timeout of at least 300 seconds:

   <mesh dir>/bin/unslop --kind <pr|issue|release-notes|docs|blog> --report <report file> < <draft file>

   - Exit 0: use stdout as the edited text, and check the report's \`warnings\`.
   - Any other exit, or none within the timeout: ignore stdout and edit the original
     in-session with \`rules.md\`. Do not retry.
3. Anything else: edit in-session with \`rules.md\`.

## Email

Email is edited in-session only, with \`rules.md\`, before the draft goes for approval.
Never change an approved revision in place.
`

const TEMPLATES: Readonly<Record<string, string>> = { unslop: UNSLOP_SKILL }

/** One agent's routing SKILL.md for the mesh dir `dir`, or undefined when no template ships. */
export function routingSkill(agent: string, dir: string): string | undefined {
  return Object.hasOwn(TEMPLATES, agent) ? TEMPLATES[agent]!.replaceAll('<mesh dir>', dir) : undefined
}

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * Pure: the routing skills a mesh.json turns on, agent → SKILL.md text. An agent is on by the rule
 * its client reads (unslop: an `http://127.0.0.1:<port>` endpoint). Nothing else in the document
 * reaches the text.
 */
export function routingSkills(doc: MeshDocument | undefined, dir: string): Map<string, string> {
  const agents = objectOf(doc?.['agents'])
  const on = new Map<string, string>()
  if (loopbackPort(objectOf(agents?.['unslop'])?.['endpoint']) !== undefined) on.set('unslop', routingSkill('unslop', dir)!)
  return on
}

// ── the folders and links ───────────────────────────────────────────────────

export type SkillTarget = 'claude' | 'agents'
export const SKILL_TARGETS: readonly SkillTarget[] = ['claude', 'agents']
const TARGET_DIRS: Record<SkillTarget, string> = { claude: '.claude/skills', agents: '.agents/skills' }
// Copilot CLI also reads ~/.copilot/skills: meshctl never links there, but a folder of the same
// name there would compete with ours (a hand-made one wins today), so it blocks the link too.
const COPILOT_DIR = '.copilot/skills'
const HOST_NAMES: Record<SkillTarget, string> = { claude: 'Claude Code', agents: 'Codex and Copilot CLI' }

export type SkillStep = { dry: string; run: () => string; lock?: true }

export interface SkillContext {
  dir: string
  home: string
  now: Date
  show: (path: string) => string
}

// the mesh dir goes into a shell command in the skill, so it must be one plain word
const PLAIN_PATH = /^[A-Za-z0-9._/@+-]+$/

type Entry = { kind: 'missing' } | { kind: 'dir' } | { kind: 'link'; to: string } | { kind: 'other' }
function entry(path: string): Entry {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return { kind: 'missing' }
  }
  if (stat.isSymbolicLink()) {
    try {
      return { kind: 'link', to: resolve(dirname(path), readlinkSync(path)) }
    } catch {
      return { kind: 'other' }
    }
  }
  return stat.isDirectory() ? { kind: 'dir' } : { kind: 'other' }
}

// a harness's skills folder may itself be a link (to a dotfiles folder), so this one follows it
const list = (dir: string): string[] => {
  try {
    return statSync(dir).isDirectory() ? readdirSync(dir).sort() : []
  } catch {
    return []
  }
}

/** A regular file's text (never through a symlink), undefined when missing, null when something else. */
function readRegular(path: string): string | undefined | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null
  }
  try {
    const stat = fstatSync(fd)
    return stat.isFile() && stat.size <= 64 * 1024 ? readFileSync(fd, 'utf8') : null
  } finally {
    closeSync(fd)
  }
}

function writeFile(path: string, text: string, mode: number, exclusive: boolean): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (exclusive ? constants.O_EXCL : constants.O_TRUNC), mode)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (t: Date): string => `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}T${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`

// A backup never goes in a skills folder: Copilot CLI reads every folder there, so a copy would
// compete with the real skill. It goes under <mesh dir>/backups/skills/ instead.
function backup(ctx: SkillContext, agent: string, text: string): string {
  const folder = join(ctx.dir, 'backups', 'skills')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const base = join(folder, `${agent}-SKILL.md.bak-${stamp(ctx.now)}`)
  for (let n = 0; n < 100; n++) {
    const path = n ? `${base}-${n}` : base
    try {
      writeFile(path, text, 0o600, true)
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('no free backup name')
}

function writeSkill(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}`
  writeFile(temp, text, 0o644, true)
  try {
    renameSync(temp, file)
  } catch (error) {
    unlinkSync(temp)
    throw error
  }
}

const removeIfEmpty = (dir: string): boolean => {
  try {
    rmdirSync(dir)
    return true
  } catch {
    return false
  }
}

export interface SkillPlan {
  steps: SkillStep[]
  /** Fixed words for each agent or target meshctl leaves alone, and why. */
  refused: string[]
  /** The agents whose folder is (or will be) generated. */
  agents: string[]
}

/**
 * The steps that make `<mesh dir>/skills/` match `doc` (the mesh.json that will be in place), and
 * the link steps: every link of ours in a target for an agent that is off, or in an `unlink` target,
 * is removed; with `link`, each generated agent gets a link in each `link` target unless a folder
 * or link that isn't ours already holds its name in ~/.claude/skills, ~/.agents/skills or
 * ~/.copilot/skills, in which case it gets none. Plans only: nothing changes until a step runs.
 */
export function skillPlan(ctx: SkillContext, doc: MeshDocument | undefined, mode: { link?: readonly SkillTarget[]; unlink?: readonly SkillTarget[] } = {}): SkillPlan {
  const { dir, home, show } = ctx
  const skills = join(dir, 'skills')
  const steps: SkillStep[] = []
  const refused: string[] = []
  const all = routingSkills(doc, dir)
  const wanted = PLAIN_PATH.test(dir) ? all : new Map<string, string>()
  if (wanted.size < all.size) refused.push(`${show(dir)} holds a character other than letters, digits and . _ / @ + -, so it cannot be written into a skill's command: no routing skill is written`)

  // write the folders of agents that are on
  for (const [agent, text] of [...wanted]) {
    const folder = join(skills, agent)
    const file = join(folder, 'SKILL.md')
    const at = entry(folder)
    const current = at.kind === 'missing' ? undefined : at.kind === 'dir' ? readRegular(file) : null
    if (current === null || entry(skills).kind === 'other' || entry(skills).kind === 'link') {
      refused.push(`${show(folder)} is not a folder holding a SKILL.md meshctl wrote, so the ${agent} routing skill is not written`)
      wanted.delete(agent)
      continue
    }
    if (current === text) continue
    steps.push({
      dry: `Would ${current === undefined ? 'write' : 'rewrite'} the ${agent} routing skill ${show(file)} (fixed text${current === undefined ? '' : `; the old one is kept under ${show(join(dir, 'backups', 'skills'))}`}).`,
      run: () => {
        const kept = current === undefined ? '' : ` (backup: ${show(backup(ctx, agent, current))})`
        mkdirSync(skills, { recursive: true, mode: 0o700 })
        writeSkill(file, text)
        return `Wrote ${show(file)}${kept}.`
      },
    })
  }

  // remove the folders of agents that are off
  if (entry(skills).kind === 'dir') {
    for (const agent of list(skills)) {
      if (wanted.has(agent)) continue
      const folder = join(skills, agent)
      if (entry(folder).kind !== 'dir') continue
      const file = join(folder, 'SKILL.md')
      steps.push({
        dry: `Would remove the ${agent} routing skill ${show(folder)} (the agent is off).`,
        run: () => {
          const current = readRegular(file)
          let kept = ''
          if (typeof current === 'string') {
            // a file this build would not write (an older template, or a hand edit) is kept aside
            if (current !== routingSkill(agent, dir)) kept = ` (backup: ${show(backup(ctx, agent, current))})`
            unlinkSync(file)
          }
          const gone = removeIfEmpty(folder)
          removeIfEmpty(skills)
          return gone ? `Removed ${show(folder)}${kept}.` : `Removed ${show(file)}${kept}; ${show(folder)} holds files meshctl did not write, so it stays.`
        },
      })
    }
  }

  // the links: ours point into <mesh dir>/skills/
  const ours = (to: string): string | undefined => to.startsWith(`${skills}/`) ? to.slice(skills.length + 1) : undefined
  const unlinkTargets = new Set(mode.unlink ?? [])
  const removeLink = (path: string, why: string): SkillStep => ({
    dry: `Would remove the link ${show(path)} (${why}).`,
    lock: true,
    run: () => {
      const now = entry(path)
      if (now.kind !== 'link' || ours(now.to) === undefined) return `Left ${show(path)}: it is no longer meshctl's link.`
      unlinkSync(path)
      return `Removed the link ${show(path)}.`
    },
  })
  for (const target of SKILL_TARGETS) {
    const parent = join(home, TARGET_DIRS[target])
    for (const name of list(parent)) {
      const path = join(parent, name)
      const at = entry(path)
      const agent = at.kind === 'link' ? ours(at.to) : undefined
      if (agent === undefined) continue
      if (unlinkTargets.has(target)) steps.push(removeLink(path, 'meshctl skills unlink'))
      else if (!wanted.has(agent) || agent !== name) steps.push(removeLink(path, 'its agent is off'))
    }
  }

  if (mode.link) {
    const seen = new Set<string>()
    for (const agent of wanted.keys()) {
      const folder = join(skills, agent)
      const blocking = [...SKILL_TARGETS.map((t) => TARGET_DIRS[t]), COPILOT_DIR].map((rel) => join(home, rel, agent)).filter((path) => {
        const at = entry(path)
        return at.kind !== 'missing' && !(at.kind === 'link' && at.to === folder)
      })
      if (blocking.length) {
        refused.push(`${blocking.map(show).join(' and ')} ${blocking.length === 1 ? 'is a skill' : 'are skills'} meshctl did not make, so it links nothing for ${agent}: two ${agent} skills would compete. Move ${blocking.length === 1 ? 'it' : 'them'} out of every skills folder (for example under ${show(join(dir, 'backups'))}), then run meshctl skills link again`)
        continue
      }
      for (const target of mode.link) {
        const parent = join(home, TARGET_DIRS[target])
        const path = join(parent, agent)
        if (entry(path).kind === 'link') continue
        const kind = entry(parent).kind
        if (kind === 'other') {
          refused.push(`${show(parent)} is not a folder, so ${agent} is not linked for ${HOST_NAMES[target]}`)
          continue
        }
        // one folder reached two ways (~/.claude/skills linked to ~/.agents/skills) gets one link
        let real = parent
        try {
          real = realpathSync(parent)
        } catch { /* made by the step */ }
        if (seen.has(join(real, agent))) continue
        seen.add(join(real, agent))
        steps.push({
          dry: `Would link ${show(path)} to ${show(folder)} (${HOST_NAMES[target]}).`,
          lock: true,
          run: () => {
            mkdirSync(parent, { recursive: true })
            symlinkSync(folder, path, 'dir')
            return `Linked ${show(path)} to ${show(folder)}.`
          },
        })
      }
    }
  }
  return { steps, refused, agents: [...wanted.keys()] }
}

// ── the setup lock (scripts/setup-lock.sh) ──────────────────────────────────

/**
 * Takes the shared setup lease the installers hold (scripts/setup-lock.sh): the same file
 * (AGENT_INBOX_INSTALL_LOCK_DIR, else ~/.agent-inbox/install-agents.lock), locked the same way:
 * `lockf -s -t 0 9` on macOS (else `flock -E 75 -n 9`) on a descriptor this process keeps open,
 * so the lock lasts until `release()` or exit. Never waits: a held lock is a refusal.
 */
export function holdSetupLock(env: NodeJS.ProcessEnv, home: string): { release: () => void } | { refused: string } {
  const file = env['AGENT_INBOX_INSTALL_LOCK_DIR'] || join(home, '.agent-inbox', 'install-agents.lock')
  const at = entry(file)
  if (at.kind !== 'missing' && (at.kind !== 'other' || !lstatSync(file).isFile())) return { refused: `the setup lock ${file} is not a regular file` }
  let fd: number
  try {
    mkdirSync(dirname(file), { recursive: true })
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644)
    if (!fstatSync(fd).isFile()) {
      closeSync(fd)
      return { refused: `the setup lock ${file} is not a regular file` }
    }
  } catch {
    return { refused: `the setup lock ${file} cannot be opened` }
  }
  const lockf = process.platform === 'darwin' && entry('/usr/bin/lockf').kind === 'other'
  const [tool, args] = lockf ? ['/usr/bin/lockf', ['-s', '-t', '0', '9']] : ['flock', ['-E', '75', '-n', '9']]
  const r = spawnSync(tool, args, { stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', fd], timeout: 10_000 })
  if (r.status === 0) return { release: () => closeSync(fd) }
  closeSync(fd)
  if (r.status === 75) return { refused: 'another setup is running (it holds the setup lock): try again when it ends' }
  return { refused: r.error ? 'setup locking needs lockf or flock' : `the setup lock utility failed (exit ${r.status ?? r.signal})` }
}
