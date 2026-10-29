#!/usr/bin/env node
// agent-inbox-meshctl (Mesh M1, #397; design §2.1 and §2.5): the only writer of
// `mesh.json`, the mesh's root switch. It follows install-agents.sh's habits:
// a dry run by default, `--apply` to write, a timestamped backup and an atomic
// rename, and nothing touched that it does not own (keys it does not know stay
// as they are). Node core only: it never opens the hub, so it imports nothing
// from store.ts.
//
//   meshctl enable --agents-view [--apply]   turn the Agents view on
//   meshctl disable [--apply]                turn every mesh piece off
//   meshctl status                           say what mesh.json turns on
//
// Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 usage.
import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MESH_FILE_MAX, MESH_REASONS, MESH_SCHEMA, meshDir, meshFile, parseMesh } from './mesh-config.js'
import type { MeshDocument } from './mesh-config.js'

const USAGE = `usage: agent-inbox-meshctl enable --agents-view [--apply]
       agent-inbox-meshctl disable [--apply]
       agent-inbox-meshctl status

Without --apply, enable and disable are dry runs: they print what they would do.
mesh.json lives in AGENT_INBOX_MESH_DIR, else beside AGENT_INBOX_DB, else ~/.agent-inbox.
`

export interface MeshctlIo {
  env?: NodeJS.ProcessEnv
  home?: string
  now?: () => Date
  out?: (text: string) => void
  err?: (text: string) => void
}

type Existing =
  | { kind: 'missing' }
  | { kind: 'refused'; reason: string }
  | { kind: 'present'; doc: MeshDocument }

function readExisting(file: string): Existing {
  let stat
  try {
    stat = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'refused', reason: MESH_REASONS.unreadable }
  }
  if (!stat.isFile()) return { kind: 'refused', reason: MESH_REASONS['not-regular'] }
  if (stat.size > MESH_FILE_MAX) return { kind: 'refused', reason: MESH_REASONS['too-large'] }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { kind: 'refused', reason: MESH_REASONS.unreadable }
  }
  const parsed = parseMesh(text)
  return parsed.ok ? { kind: 'present', doc: parsed.doc } : { kind: 'refused', reason: MESH_REASONS[parsed.reason] }
}

// `~/…` for the home directory, so the output reads like the docs
function shown(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const pad = (n: number): string => String(n).padStart(2, '0')
function backupName(file: string, now: Date): string {
  const t = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${file}.bak-${t}`
}

/** Copies the current file aside without ever replacing another backup. */
function writeBackup(file: string, now: Date): string {
  const base = backupName(file, now)
  for (let n = 0; n < 100; n++) {
    const target = n ? `${base}-${n}` : base
    try {
      copyFileSync(file, target, constants.COPYFILE_EXCL)
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('no free backup name')
}

/** Temp file beside the target, fsynced, then one rename over it. */
function writeAtomic(file: string, text: string): void {
  const temp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, file)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* already gone */ }
    throw error
  }
}

// schema first, then every key this build does not own exactly as it was
function enabledDoc(doc: MeshDocument | null): MeshDocument {
  const { schema: _schema, agentsView: _agentsView, ...rest } = doc ?? { schema: MESH_SCHEMA }
  return { schema: MESH_SCHEMA, agentsView: true, ...rest }
}

const render = (doc: MeshDocument): string => `${JSON.stringify(doc, null, 2)}\n`

const PIECES = ['agentsView'] as const
function onPieces(doc: MeshDocument): string[] {
  return PIECES.filter((key) => doc[key] === true)
}

export function runMeshctl(argv: string[], io: MeshctlIo = {}): number {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const now = io.now ?? (() => new Date())
  const out = io.out ?? ((text: string) => { process.stdout.write(text) })
  const err = io.err ?? ((text: string) => { process.stderr.write(text) })

  const [command, ...rest] = argv
  const flags = new Set(rest)
  const apply = flags.delete('--apply')
  const usage = (): number => { err(USAGE); return 2 }
  if (command === 'help' || command === '--help' || command === '-h') { out(USAGE); return 0 }
  if (rest.length !== new Set(rest).size) return usage()

  const dir = meshDir(env, home)
  const file = meshFile(dir)
  const name = shown(file, home)

  if (command === 'status') {
    if (flags.size || apply) return usage()
    const existing = readExisting(file)
    if (existing.kind === 'missing') {
      out(`Mesh: off. No ${name}.\n`)
      return 0
    }
    if (existing.kind === 'refused') {
      out(`Mesh: off. ${name} ${existing.reason}, so the viewer reads it as off.\n`)
      return 1
    }
    const on = onPieces(existing.doc)
    out(`Mesh: ${on.length ? 'on' : 'off'}. ${name}\n`)
    out(`Pieces       agentsView ${existing.doc['agentsView'] === true ? 'on' : 'off'}\n`)
    return 0
  }

  if (command === 'enable') {
    if (!flags.delete('--agents-view') || flags.size) return usage()
    const existing = readExisting(file)
    if (existing.kind === 'refused') {
      err(`Refused: ${name} ${existing.reason}. Nothing written. Fix or remove it by hand, then run this again.\n`)
      return 1
    }
    const before = existing.kind === 'present' ? existing.doc : null
    if (before?.['agentsView'] === true && before.schema === MESH_SCHEMA) {
      out(`The Agents view is already on in ${name}. Nothing to do.\n`)
      return 0
    }
    const text = render(enabledDoc(before))
    if (!apply) {
      out(`Dry run. Would ${before ? 'update' : 'create'} ${name}:\n${text}Nothing written. Re-run with --apply.\n`)
      return 0
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const backup = before ? writeBackup(file, now()) : null
      writeAtomic(file, text)
      out(`Wrote ${name}${backup ? ` (backup: ${shown(backup, home)})` : ' (new file)'}. Reload the Agent Inbox window to show the Agents view.\n`)
      return 0
    } catch {
      err(`Failed: could not write ${name}. Nothing else was changed.\n`)
      return 1
    }
  }

  if (command === 'disable') {
    if (flags.size) return usage()
    const existing = readExisting(file)
    if (existing.kind === 'missing') {
      out(`The mesh is already off: no ${name}. Nothing to do.\n`)
      return 0
    }
    if (existing.kind === 'refused') {
      err(`Refused: ${name} ${existing.reason}. Nothing changed. Remove it by hand if you are sure.\n`)
      return 1
    }
    // M1 has one step. Later phases put theirs before it (§2.5): pause the
    // registry, archive every active @mesh plan, then delete the file.
    const steps: Array<{ dry: string; run: () => string }> = [
      {
        dry: `Would delete ${name} (keeping a backup beside it).`,
        run: () => {
          const backup = writeBackup(file, now())
          unlinkSync(file)
          return `Deleted ${name} (backup: ${shown(backup, home)}).`
        },
      },
    ]
    if (!apply) {
      out(`Dry run.\n${steps.map((step, i) => `${i + 1}/${steps.length} ${step.dry}`).join('\n')}\nNothing changed. Re-run with --apply.\n`)
      return 0
    }
    for (const [i, step] of steps.entries()) {
      try {
        out(`${i + 1}/${steps.length} ${step.run()}\n`)
      } catch {
        err(`Failed at step ${i + 1}/${steps.length}. ${name} was not removed.\n`)
        return 1
      }
    }
    out('The viewer stops its mesh work at its next check, within a minute. Reload the Agent Inbox window to hide the Agents view.\n')
    return 0
  }

  return usage()
}

const entry = process.argv[1]
let isMain = false
try {
  isMain = Boolean(entry) && realpathSync(entry!) === realpathSync(fileURLToPath(import.meta.url))
} catch { /* not run directly */ }
if (isMain) process.exitCode = runMeshctl(process.argv.slice(2))
