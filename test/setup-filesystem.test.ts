import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import setupFilesystemModule from '../scripts/setup-filesystem.cjs'
import type {
  SetupFilesystemIO,
  SetupPathStat,
} from '../scripts/setup-filesystem.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { createSetupFilesystem } = setupFilesystemModule

function temp(prefix: string): string {
  return scratchDir(prefix)
}

afterEach(removeScratchDirs)

function nodeIo(overrides: Partial<SetupFilesystemIO> = {}): SetupFilesystemIO {
  return {
    lstat(path) {
      return lstatSync(path, { bigint: true })
    },
    realpath(path) {
      return realpathSync.native(path)
    },
    mkdir(path, options) {
      mkdirSync(path, options)
    },
    mkdtemp(prefix) {
      return mkdtempSync(prefix)
    },
    rename(from, to) {
      renameSync(from, to)
    },
    remove(path, options) {
      rmSync(path, options)
    },
    readdir(path) {
      return readdirSync(path)
    },
    ...overrides,
  }
}

function stageEntries(parent: string): string[] {
  return lstatSync(parent).isDirectory()
    ? readdirSync(parent).filter((name) => name.startsWith('.agent-inbox-stage-'))
    : []
}

// Win32 has no POSIX owner; the model supplies one so ownership is injected
// explicitly rather than assumed.
const VIRTUAL_UID = 1000

class VirtualWin32Filesystem {
  readonly path = win32
  readonly entries = new Map<string, { canonical: string; stat: SetupPathStat }>()
  renameFailures = new Set<number>()
  renameCount = 0
  nextInode = 100n
  nextTemp = 1

  key(path: string): string {
    return win32.normalize(path).toLowerCase()
  }

  stat(kind: 'file' | 'directory' | 'link', inode = this.nextInode++): SetupPathStat {
    return {
      dev: 7n,
      ino: inode,
      uid: VIRTUAL_UID,
      isFile: () => kind === 'file',
      isDirectory: () => kind === 'directory',
      isSymbolicLink: () => kind === 'link',
    }
  }

  add(path: string, kind: 'file' | 'directory' | 'link', canonical = win32.normalize(path), inode?: bigint): void {
    this.entries.set(this.key(path), { canonical, stat: this.stat(kind, inode) })
  }

  has(path: string): boolean {
    return this.entries.has(this.key(path))
  }

  removeTree(path: string): void {
    const key = this.key(path)
    for (const entry of [...this.entries.keys()]) {
      if (entry === key || entry.startsWith(`${key}\\`)) this.entries.delete(entry)
    }
  }

  io(): SetupFilesystemIO {
    return {
      lstat: (path) => {
        const entry = this.entries.get(this.key(path))
        if (!entry) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
        return entry.stat
      },
      realpath: (path) => {
        const entry = this.entries.get(this.key(path))
        if (!entry) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
        return entry.canonical
      },
      mkdir: (path, options) => {
        const normalized = win32.normalize(path)
        if (!options.recursive) {
          if (this.has(normalized)) {
            throw Object.assign(new Error(`already exists ${normalized}`), { code: 'EEXIST' })
          }
          if (!this.has(win32.dirname(normalized))) {
            throw Object.assign(new Error(`missing parent ${normalized}`), { code: 'ENOENT' })
          }
          this.add(normalized, 'directory')
          return
        }
        const root = win32.parse(normalized).root
        let current = root
        for (const part of normalized.slice(root.length).split('\\').filter(Boolean)) {
          current = win32.join(current, part)
          if (!this.has(current)) this.add(current, 'directory')
        }
      },
      mkdtemp: (prefix) => {
        const path = `${prefix}${this.nextTemp++}`
        this.add(path, 'directory')
        return path
      },
      rename: (from, to) => {
        this.renameCount += 1
        if (this.renameFailures.has(this.renameCount)) {
          throw Object.assign(new Error(`sharing violation renaming ${from}`), { code: 'EPERM' })
        }
        const fromKey = this.key(from)
        const toKey = this.key(to)
        const moved = [...this.entries.entries()].filter(([key]) => key === fromKey || key.startsWith(`${fromKey}\\`))
        if (moved.length === 0) throw Object.assign(new Error(`missing ${from}`), { code: 'ENOENT' })
        if (this.entries.has(toKey)) throw Object.assign(new Error(`exists ${to}`), { code: 'EEXIST' })
        for (const [key] of moved) this.entries.delete(key)
        for (const [key, value] of moved) {
          const suffix = key.slice(fromKey.length)
          const nextPath = `${win32.normalize(to)}${suffix}`
          this.entries.set(this.key(nextPath), {
            ...value,
            canonical: `${win32.normalize(to)}${suffix}`,
          })
        }
      },
      remove: (path) => {
        if (!this.has(path)) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
        this.removeTree(path)
      },
      readdir: (path) => {
        const key = this.key(path)
        if (!this.has(path)) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
        return [...this.entries.values()]
          .map((entry) => entry.canonical)
          .filter((canonical) => this.key(win32.dirname(canonical)) === key && this.key(canonical) !== key)
          .map((canonical) => win32.basename(canonical))
      },
    }
  }
}

describe('Setup filesystem identity', () => {
  it('distinguishes files and directories and rejects a linked leaf', () => {
    const root = temp('setup-fs-identity-')
    const directory = join(root, 'directory')
    const file = join(root, 'file.txt')
    const link = join(root, 'linked-file')
    mkdirSync(directory)
    writeFileSync(file, 'one\n')
    symlinkSync(file, link)
    const filesystem = createSetupFilesystem()

    expect(filesystem.identify(directory, 'directory')).toMatchObject({ kind: 'directory' })
    expect(filesystem.identify(file, 'file')).toMatchObject({ kind: 'file' })
    expect(() => filesystem.identify(file, 'directory')).toThrow(/directory/)
    expect(() => filesystem.identify(link, 'file')).toThrow(/link/i)
  })

  it('allows a canonicalized ancestor alias but detects replacement of the named entry', () => {
    const realParent = temp('setup-fs-real-')
    const aliasParent = temp('setup-fs-alias-')
    const alias = join(aliasParent, 'alias')
    symlinkSync(realParent, alias)
    const file = join(alias, 'payload.txt')
    writeFileSync(file, 'original\n')
    const filesystem = createSetupFilesystem()
    const identity = filesystem.identify(file, 'file')

    expect(identity.canonicalPath).toBe(realpathSync.native(file))
    const retained = join(realParent, 'retained.txt')
    renameSync(file, retained)
    writeFileSync(file, 'replacement\n')

    expect(() => filesystem.assertIdentity(identity)).toThrow(/identity changed/i)
  })
})

describe('Setup filesystem directory transactions', () => {
  it('publishes a complete new directory from a same-parent scratch and removes the scratch', () => {
    const parent = temp('setup-fs-publish-')
    const destination = join(parent, 'runtime-id')
    const filesystem = createSetupFilesystem()
    const result = filesystem.stageDirectory({
      destination,
      replacement: 'refuse',
      prepare(stage) {
        mkdirSync(stage, { recursive: true })
        writeFileSync(join(stage, 'ready.txt'), 'ready\n')
        return 'prepared'
      },
      validate(stage, prepared) {
        expect(prepared).toBe('prepared')
        expect(readFileSync(join(stage, 'ready.txt'), 'utf8')).toBe('ready\n')
      },
    })

    expect(result).toMatchObject({ path: destination, prepared: 'prepared', replaced: false })
    expect(readFileSync(join(destination, 'ready.txt'), 'utf8')).toBe('ready\n')
    expect(stageEntries(parent)).toEqual([])
  })

  it('refuses an existing immutable destination before prepare runs', () => {
    const parent = temp('setup-fs-refuse-')
    const destination = join(parent, 'runtime-id')
    mkdirSync(destination)
    let prepared = false
    const filesystem = createSetupFilesystem()

    expect(() => filesystem.stageDirectory({
      destination,
      replacement: 'refuse',
      prepare(stage) {
        prepared = true
        mkdirSync(stage, { recursive: true })
      },
      validate() {},
    })).toThrow(/already exists/i)
    expect(prepared).toBe(false)
    expect(stageEntries(parent)).toEqual([])
  })

  it.each(['prepare', 'validate'] as const)('cleans the scratch when %s fails before publication', (phase) => {
    const parent = temp(`setup-fs-${phase}-`)
    const destination = join(parent, 'runtime-id')
    const filesystem = createSetupFilesystem()

    expect(() => filesystem.stageDirectory({
      destination,
      replacement: 'refuse',
      prepare(stage) {
        mkdirSync(stage, { recursive: true })
        writeFileSync(join(stage, 'partial.txt'), 'partial\n')
        if (phase === 'prepare') throw new Error('prepare failed')
        return 'prepared'
      },
      validate() {
        if (phase === 'validate') throw new Error('validate failed')
      },
    })).toThrow(new RegExp(`${phase} failed`))
    expect(stageEntries(parent)).toEqual([])
    expect(() => lstatSync(destination)).toThrow()
  })

  it('swaps a build output through a backup and removes all transaction paths on success', () => {
    const parent = temp('setup-fs-swap-')
    const destination = join(parent, 'runtime')
    mkdirSync(destination)
    writeFileSync(join(destination, 'version.txt'), 'old\n')
    const filesystem = createSetupFilesystem()

    const result = filesystem.stageDirectory({
      destination,
      replacement: 'swap',
      prepare(stage) {
        mkdirSync(stage, { recursive: true })
        writeFileSync(join(stage, 'version.txt'), 'new\n')
        return 2
      },
      validate() {},
    })

    expect(result).toMatchObject({ path: destination, prepared: 2, replaced: true })
    expect(readFileSync(join(destination, 'version.txt'), 'utf8')).toBe('new\n')
    expect(stageEntries(parent)).toEqual([])
  })

  it('restores the exact previous output when the publishing rename fails', () => {
    const parent = temp('setup-fs-restore-')
    const destination = join(parent, 'runtime')
    mkdirSync(destination)
    writeFileSync(join(destination, 'version.txt'), 'old\n')
    let renameCall = 0
    const filesystem = createSetupFilesystem({
      io: nodeIo({
        rename(from, to) {
          renameCall += 1
          if (renameCall === 2) throw Object.assign(new Error('publish failed'), { code: 'EPERM' })
          renameSync(from, to)
        },
      }),
    })

    expect(() => filesystem.stageDirectory({
      destination,
      replacement: 'swap',
      prepare(stage) {
        mkdirSync(stage, { recursive: true })
        writeFileSync(join(stage, 'version.txt'), 'new\n')
      },
      validate() {},
    })).toThrow(/publish failed/)
    expect(readFileSync(join(destination, 'version.txt'), 'utf8')).toBe('old\n')
    expect(stageEntries(parent)).toEqual([])
  })

  it('never restores a backup path after its prior-tree identity is replaced', () => {
    const parent = temp('setup-fs-unsafe-restore-')
    const destination = join(parent, 'runtime')
    const retainedOriginal = join(parent, 'retained-original')
    mkdirSync(destination)
    writeFileSync(join(destination, 'version.txt'), 'old\n')
    let renameCall = 0
    const filesystem = createSetupFilesystem({
      io: nodeIo({
        rename(from, to) {
          renameSync(from, to)
          renameCall += 1
          if (renameCall !== 1) return
          renameSync(to, retainedOriginal)
          mkdirSync(to)
          writeFileSync(join(to, 'malicious.txt'), 'not the prior tree\n')
        },
      }),
    })

    expect(() => filesystem.stageDirectory({
      destination,
      replacement: 'swap',
      prepare(stage) {
        mkdirSync(stage, { recursive: true })
        writeFileSync(join(stage, 'version.txt'), 'new\n')
      },
      validate() {},
    })).toThrow(/restoration|recovery/i)
    expect(existsSync(destination)).toBe(false)
    expect(readFileSync(join(retainedOriginal, 'version.txt'), 'utf8')).toBe('old\n')
    const scratch = stageEntries(parent)
    expect(scratch).toHaveLength(1)
    expect(readFileSync(join(parent, scratch[0]!, 'previous', 'malicious.txt'), 'utf8'))
      .toBe('not the prior tree\n')
  })

  it('retains and reports recovery data when both publication and restoration fail', () => {
    const parent = temp('setup-fs-recovery-')
    const destination = join(parent, 'runtime')
    mkdirSync(destination)
    writeFileSync(join(destination, 'version.txt'), 'old\n')
    let renameCall = 0
    const filesystem = createSetupFilesystem({
      io: nodeIo({
        rename(from, to) {
          renameCall += 1
          if (renameCall >= 2) throw Object.assign(new Error(`rename ${renameCall} failed`), { code: 'EPERM' })
          renameSync(from, to)
        },
      }),
    })

    expect(() => filesystem.stageDirectory({
      destination,
      replacement: 'swap',
      prepare(stage) {
        mkdirSync(stage, { recursive: true })
        writeFileSync(join(stage, 'version.txt'), 'new\n')
      },
      validate() {},
    })).toThrow(/recovery/i)
    const scratch = stageEntries(parent)
    expect(scratch).toHaveLength(1)
    expect(readFileSync(join(parent, scratch[0]!, 'previous', 'version.txt'), 'utf8')).toBe('old\n')
  })

  it('reports post-commit backup cleanup as incomplete without claiming recovery is intact', () => {
    const parent = temp('setup-fs-committed-cleanup-')
    const destination = join(parent, 'runtime')
    mkdirSync(destination)
    writeFileSync(join(destination, 'version.txt'), 'old\n')
    const filesystem = createSetupFilesystem({
      io: nodeIo({
        remove(path, options) {
          if (path.endsWith('previous')) {
            throw Object.assign(new Error('backup is busy'), { code: 'EPERM' })
          }
          rmSync(path, options)
        },
      }),
    })

    let failure: unknown
    try {
      filesystem.stageDirectory({
        destination,
        replacement: 'swap',
        prepare(stage) {
          mkdirSync(stage, { recursive: true })
          writeFileSync(join(stage, 'version.txt'), 'new\n')
        },
        validate() {},
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('expected a committed cleanup error')
    expect(failure.message).toMatch(/cleanup was incomplete/i)
    expect(failure).toMatchObject({ committed: true })
    expect(readFileSync(join(destination, 'version.txt'), 'utf8')).toBe('new\n')
    expect(stageEntries(parent)).toHaveLength(1)
  })

  it('never recursively cleans a substituted backup path after publication', () => {
    const parent = temp('setup-fs-substituted-backup-')
    const destination = join(parent, 'runtime')
    const retainedOriginal = join(parent, 'retained-original')
    mkdirSync(destination)
    writeFileSync(join(destination, 'version.txt'), 'old\n')
    let backup = ''
    let renameCall = 0
    const filesystem = createSetupFilesystem({
      io: nodeIo({
        rename(from, to) {
          renameSync(from, to)
          renameCall += 1
          if (renameCall === 1) {
            backup = to
          } else if (renameCall === 2) {
            renameSync(backup, retainedOriginal)
            mkdirSync(backup)
            writeFileSync(join(backup, 'unrelated.txt'), 'do not delete\n')
          }
        },
      }),
    })

    expect(() => filesystem.stageDirectory({
      destination,
      replacement: 'swap',
      prepare(stage) {
        mkdirSync(stage, { recursive: true })
        writeFileSync(join(stage, 'version.txt'), 'new\n')
      },
      validate() {},
    })).toThrow(/cleanup|recovery identity/i)
    expect(readFileSync(join(destination, 'version.txt'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(retainedOriginal, 'version.txt'), 'utf8')).toBe('old\n')
    expect(readFileSync(join(backup, 'unrelated.txt'), 'utf8')).toBe('do not delete\n')
  })

  it('never cleans a backup path recreated after its successful deletion', () => {
    const parent = temp('setup-fs-recreated-backup-')
    const destination = join(parent, 'runtime')
    mkdirSync(destination)
    writeFileSync(join(destination, 'version.txt'), 'old\n')
    let recreatedBackup = ''
    const filesystem = createSetupFilesystem({
      io: nodeIo({
        remove(path, options) {
          rmSync(path, options)
          if (!path.endsWith('previous')) return
          recreatedBackup = path
          mkdirSync(path)
          writeFileSync(join(path, 'unrelated.txt'), 'do not delete\n')
        },
      }),
    })

    expect(() => filesystem.stageDirectory({
      destination,
      replacement: 'swap',
      prepare(stage) {
        mkdirSync(stage, { recursive: true })
        writeFileSync(join(stage, 'version.txt'), 'new\n')
      },
      validate() {},
    })).toThrow(/cleanup|untrusted/i)
    expect(readFileSync(join(destination, 'version.txt'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(recreatedBackup, 'unrelated.txt'), 'utf8')).toBe('do not delete\n')
  })

  it('removes only the identity that passed validation and refuses a symlink target', () => {
    const parent = temp('setup-fs-remove-')
    const target = join(parent, 'runtime')
    mkdirSync(target)
    writeFileSync(join(target, 'manifest.json'), '{}\n')
    const filesystem = createSetupFilesystem()
    let validated = false

    expect(filesystem.removeDirectory({
      target,
      validate(path) {
        validated = readFileSync(join(path, 'manifest.json'), 'utf8') === '{}\n'
      },
    })).toMatchObject({ path: target })
    expect(validated).toBe(true)
    expect(() => lstatSync(target)).toThrow()

    const elsewhere = temp('setup-fs-remove-elsewhere-')
    const link = join(parent, 'linked-runtime')
    symlinkSync(elsewhere, link)
    expect(() => filesystem.removeDirectory({ target: link, validate() {} })).toThrow(/link/i)
    expect(lstatSync(elsewhere).isDirectory()).toBe(true)
  })
})

// #211: removal moves the tree under a reserved trash name first, so an
// interruption never leaves a half-deleted tree under the name it had.
describe('Setup filesystem removal through trash', () => {
  function runtimeTree(parent: string, name = 'runtime-1'): string {
    const target = join(parent, name)
    mkdirSync(join(target, 'bin'), { recursive: true })
    writeFileSync(join(target, 'bin', 'node'), 'node\n')
    return target
  }

  function trashEntries(parent: string): string[] {
    return readdirSync(parent).filter((name) => name.startsWith('.trash-'))
  }

  it('renames the directory into a trash folder beside it before deleting anything', () => {
    const parent = realpathSync(temp('setup-fs-trash-'))
    const target = runtimeTree(parent)
    const operations: string[] = []
    const filesystem = createSetupFilesystem({
      io: nodeIo({
        rename(from, to) {
          operations.push(`rename ${relative(parent, from)} -> ${relative(parent, to)}`)
          renameSync(from, to)
        },
        remove(path, options) {
          operations.push(`remove ${relative(parent, path)}`)
          rmSync(path, options)
        },
      }),
    })

    filesystem.removeDirectory({ target, validate() {} })

    expect(operations).toHaveLength(2)
    expect(operations[0]).toMatch(/^rename runtime-1 -> \.trash-runtime-1-[^/]+\/runtime-1$/)
    expect(operations[1]).toBe(`remove ${operations[0]!.split(' -> ')[1]!.split('/')[0]}`)
    expect(readdirSync(parent)).toEqual([])
  })

  it('frees the name even when deleting the renamed tree fails, leaving it as trash', () => {
    const parent = realpathSync(temp('setup-fs-trash-fail-'))
    const target = runtimeTree(parent)
    const filesystem = createSetupFilesystem({
      io: nodeIo({
        remove() {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        },
      }),
    })

    let failure: unknown
    try {
      filesystem.removeDirectory({ target, validate() {} })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'trash-cleanup-failed', committed: true })
    expect(existsSync(target)).toBe(false)
    const trash = trashEntries(parent)
    expect(trash).toHaveLength(1)
    expect((failure as { recoveryPath?: string }).recoveryPath).toBe(join(parent, trash[0]!))
    expect(readFileSync(join(parent, trash[0]!, 'runtime-1', 'bin', 'node'), 'utf8')).toBe('node\n')
  })

  it('keeps for recovery a tree that changed identity while it was being moved aside', () => {
    const parent = realpathSync(temp('setup-fs-trash-swap-'))
    const target = runtimeTree(parent)
    const filesystem = createSetupFilesystem({
      io: nodeIo({
        rename(from, to) {
          renameSync(from, to)
          // Something else now sits where the validated tree was moved. The
          // tree itself is moved away, not deleted, so its inode stays in use
          // and the replacement cannot reuse it (ext4 would).
          renameSync(to, join(parent, 'validated-tree'))
          mkdirSync(to)
          writeFileSync(join(to, 'unrelated.txt'), 'do not delete\n')
        },
      }),
    })

    expect(() => filesystem.removeDirectory({ target, validate() {} })).toThrow(/identity changed/i)
    const trash = trashEntries(parent)
    expect(trash).toHaveLength(1)
    expect(readFileSync(join(parent, trash[0]!, 'runtime-1', 'unrelated.txt'), 'utf8')).toBe('do not delete\n')

    // A later cleanup leaves it alone too.
    filesystem.removeLeftoverTrash(parent)
    expect(readFileSync(join(parent, trash[0]!, 'runtime-1', 'unrelated.txt'), 'utf8')).toBe('do not delete\n')
  })

  it('refuses to remove an entry that already carries a trash name', () => {
    const parent = temp('setup-fs-trash-name-')
    const target = runtimeTree(parent, '.trash-runtime-1-abc')

    expect(() => createSetupFilesystem().removeDirectory({ target, validate() {} })).toThrow(/trash/i)
    expect(existsSync(join(target, 'bin', 'node'))).toBe(true)
  })

  it('removes leftover trash it owns a bounded batch at a time, unlinking links without following them', () => {
    const parent = temp('setup-fs-leftover-')
    const outside = temp('setup-fs-leftover-outside-')
    writeFileSync(join(outside, 'keep.txt'), 'keep\n')
    symlinkSync(outside, join(parent, '.trash-link'))
    for (let index = 0; index < 18; index += 1) {
      const trash = join(parent, `.trash-runtime-${String(index).padStart(2, '0')}`)
      mkdirSync(join(trash, 'runtime', 'bin'), { recursive: true })
      // A link inside a trash tree is removed as a link too.
      symlinkSync(outside, join(trash, 'runtime', 'bin', 'linked'))
    }
    runtimeTree(parent)
    const filesystem = createSetupFilesystem()

    const first = filesystem.removeLeftoverTrash(parent)
    expect(first.removed).toHaveLength(16)
    expect(first.retained).toEqual([])
    expect(trashEntries(parent)).toHaveLength(3)
    filesystem.removeLeftoverTrash(parent)

    expect(readdirSync(parent)).toEqual(['runtime-1'])
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep\n')
  })

  it('counts only trash it may remove against its bound, so trash it keeps never holds back newer trash (#214)', () => {
    const parent = temp('setup-fs-leftover-kept-')
    const uid = process.getuid!()
    const names = (stem: string, length: number) =>
      Array.from({ length }, (_, index) => `.trash-${stem}-${String(index).padStart(2, '0')}`)
    // Sorted ahead of what it may remove: seventeen entries it keeps (twelve
    // marked for recovery, five someone else's), then two it may remove but
    // cannot, then eighteen it can.
    const keptNames = names('kept', 17)
    const lockedNames = names('locked', 2)
    const kept = keptNames.map((name) => join(parent, name))
    const locked = lockedNames.map((name) => join(parent, name))
    const foreign = new Set(kept.slice(12))
    kept.forEach((path, index) => mkdirSync(index < 12 ? join(path, '.retained') : path, { recursive: true }))
    for (const name of [...lockedNames, ...names('runtime', 18)]) mkdirSync(join(parent, name, 'runtime'), { recursive: true })
    const filesystem = createSetupFilesystem({
      uid,
      io: nodeIo({
        lstat(path) {
          const stat = lstatSync(path, { bigint: true })
          if (!foreign.has(path)) return stat
          return {
            dev: stat.dev,
            ino: stat.ino,
            uid: stat.uid + 1n,
            isFile: () => stat.isFile(),
            isDirectory: () => stat.isDirectory(),
            isSymbolicLink: () => stat.isSymbolicLink(),
          }
        },
        remove(path, options) {
          if (locked.includes(path)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
          rmSync(path, options)
        },
      }),
    })

    // A removal that fails still counts toward the bound of 16.
    const first = filesystem.removeLeftoverTrash(parent)
    expect(first.removed).toHaveLength(14)
    expect(first.retained).toEqual([...kept, ...locked])
    expect(filesystem.removeLeftoverTrash(parent).removed).toHaveLength(4)
    expect(trashEntries(parent).sort()).toEqual([...keptNames, ...lockedNames])
  })

  it('retains leftover trash it does not own or whose identity changes before removal', () => {
    const parent = temp('setup-fs-leftover-retain-')
    mkdirSync(join(parent, '.trash-foreign'))
    mkdirSync(join(parent, '.trash-swapped'))
    const uid = process.getuid!()

    const foreign = createSetupFilesystem({ uid: uid + 1 }).removeLeftoverTrash(parent)
    expect(foreign.removed).toEqual([])
    expect(trashEntries(parent)).toEqual(['.trash-foreign', '.trash-swapped'])

    let swappedReads = 0
    const swapping = createSetupFilesystem({
      uid,
      io: nodeIo({
        lstat(path) {
          const stat = lstatSync(path, { bigint: true })
          if (!path.endsWith('.trash-swapped') || ++swappedReads < 2) return stat
          return {
            dev: stat.dev,
            ino: stat.ino + 1n,
            uid: stat.uid,
            isFile: () => stat.isFile(),
            isDirectory: () => stat.isDirectory(),
            isSymbolicLink: () => stat.isSymbolicLink(),
          }
        },
      }),
    })
    const swapped = swapping.removeLeftoverTrash(parent)
    expect(swapped.removed).toEqual([join(parent, '.trash-foreign')])
    expect(swapped.retained).toEqual([join(parent, '.trash-swapped')])
    expect(trashEntries(parent)).toEqual(['.trash-swapped'])
  })
})

describe('modeled Win32 filesystem policy', () => {
  it('normalizes fully qualified drive and UNC paths but rejects drive-relative and drive-less roots', () => {
    const virtual = new VirtualWin32Filesystem()
    virtual.add('C:\\', 'directory')
    virtual.add('C:\\Users', 'directory')
    virtual.add('C:\\Users\\Agent', 'directory', 'C:\\Users\\Agent')
    virtual.add('\\\\server\\share\\', 'directory')
    virtual.add('\\\\server\\share\\runtime', 'directory')
    const filesystem = createSetupFilesystem({ platform: 'win32', io: virtual.io() })

    expect(filesystem.identify('C:/Users/Agent', 'directory').path).toBe('C:\\Users\\Agent')
    expect(filesystem.identify('\\\\server\\share\\runtime', 'directory').path)
      .toBe('\\\\server\\share\\runtime')
    expect(() => filesystem.identify('C:relative', 'directory')).toThrow(/fully qualified/i)
    expect(() => filesystem.identify('\\root-relative', 'directory')).toThrow(/fully qualified/i)
    expect(() => filesystem.identify('\\\\?\\C:\\Users\\Agent', 'directory')).toThrow(/namespace/i)
    expect(() => filesystem.identify('\\\\.\\PhysicalDrive0', 'directory')).toThrow(/namespace/i)
    expect(() => filesystem.identify('C:\\Users\\Agent:stream', 'directory')).toThrow(/alternate data stream/i)
    expect(() => filesystem.identify('\\\\server\\share\\runtime:stream', 'directory'))
      .toThrow(/alternate data stream/i)
  })

  it('uses filesystem identity rather than path case and rejects modeled junction/reparse entries', () => {
    const virtual = new VirtualWin32Filesystem()
    virtual.add('C:\\Runtime', 'directory', 'C:\\Runtime', 501n)
    virtual.add('C:\\Junction', 'link')
    const filesystem = createSetupFilesystem({ platform: 'win32', io: virtual.io() })
    const identity = filesystem.identify('C:\\RUNTIME', 'directory')

    expect(filesystem.assertIdentity(identity, 'c:\\runtime').inode).toBe('501')
    virtual.add('C:\\Runtime', 'directory', 'C:\\Runtime', 777n)
    expect(() => filesystem.assertIdentity(identity, 'C:\\runtime')).toThrow(/identity changed/i)
    expect(() => filesystem.identify('C:\\Junction', 'directory')).toThrow(/junction|reparse/i)
  })

  it('fails closed when Win32 device or inode identity is zero or unusable', () => {
    const virtual = new VirtualWin32Filesystem()
    virtual.add('C:\\ZeroInode', 'directory', 'C:\\ZeroInode', 0n)
    virtual.add('C:\\ZeroDevice', 'directory')
    const zeroDevice = virtual.entries.get(virtual.key('C:\\ZeroDevice'))
    if (!zeroDevice) throw new Error('expected virtual zero-device fixture')
    zeroDevice.stat = { ...zeroDevice.stat, dev: 0n }
    const filesystem = createSetupFilesystem({ platform: 'win32', io: virtual.io() })

    expect(() => filesystem.identify('C:\\ZeroInode', 'directory')).toThrow(/stable filesystem identity/i)
    expect(() => filesystem.identify('C:\\ZeroDevice', 'directory')).toThrow(/stable filesystem identity/i)
  })

  it('fails closed and cleans modeled staging when a Windows sharing error blocks publication', () => {
    const virtual = new VirtualWin32Filesystem()
    virtual.add('C:\\', 'directory')
    virtual.add('C:\\AgentInbox', 'directory')
    virtual.renameFailures.add(1)
    const filesystem = createSetupFilesystem({ platform: 'win32', io: virtual.io() })

    expect(() => filesystem.stageDirectory({
      destination: 'C:\\AgentInbox\\runtime',
      replacement: 'refuse',
      prepare(stage) {
        if (!virtual.has(stage)) virtual.add(stage, 'directory')
      },
      validate() {},
    })).toThrow(/sharing violation/i)
    expect(virtual.has('C:\\AgentInbox\\runtime')).toBe(false)
    expect([...virtual.entries.keys()].some((path) => path.includes('.agent-inbox-stage-'))).toBe(false)
  })

  it('detects replacement of the private scratch directory before publication', () => {
    const virtual = new VirtualWin32Filesystem()
    virtual.add('C:\\', 'directory')
    virtual.add('C:\\AgentInbox', 'directory')
    const filesystem = createSetupFilesystem({ platform: 'win32', io: virtual.io() })
    let replacementSentinel = ''

    expect(() => filesystem.stageDirectory({
      destination: 'C:\\AgentInbox\\runtime',
      replacement: 'refuse',
      prepare(stage) {
        const scratch = win32.dirname(stage)
        virtual.removeTree(scratch)
        virtual.add(scratch, 'directory')
        virtual.add(stage, 'directory')
        replacementSentinel = win32.join(scratch, 'unrelated.txt')
        virtual.add(replacementSentinel, 'file')
      },
      validate() {},
    })).toThrow(/identity changed|cleanup was refused/i)
    expect(virtual.has('C:\\AgentInbox\\runtime')).toBe(false)
    expect(virtual.has(replacementSentinel)).toBe(true)
  })

  it('refuses a preexisting stage entry inside a newly allocated scratch directory', () => {
    const virtual = new VirtualWin32Filesystem()
    virtual.add('C:\\', 'directory')
    virtual.add('C:\\AgentInbox', 'directory')
    const io = virtual.io()
    const allocateScratch = io.mkdtemp
    let replacementSentinel = ''
    io.mkdtemp = (prefix) => {
      const scratch = allocateScratch(prefix)
      const stage = win32.join(scratch, 'tree')
      virtual.add(stage, 'directory')
      replacementSentinel = win32.join(stage, 'unrelated.txt')
      virtual.add(replacementSentinel, 'file')
      return scratch
    }
    const filesystem = createSetupFilesystem({ platform: 'win32', io })

    expect(() => filesystem.stageDirectory({
      destination: 'C:\\AgentInbox\\runtime',
      replacement: 'refuse',
      prepare() {},
      validate() {},
    })).toThrow(/already exists/i)
    expect(virtual.has('C:\\AgentInbox\\runtime')).toBe(false)
    expect(virtual.has(replacementSentinel)).toBe(true)
  })

  it('moves a modeled runtime aside before deleting it, and unlinks a modeled junction left as trash', () => {
    const virtual = new VirtualWin32Filesystem()
    virtual.add('C:\\', 'directory')
    virtual.add('C:\\AgentInbox', 'directory')
    virtual.add('C:\\AgentInbox\\runtime', 'directory')
    virtual.add('C:\\AgentInbox\\runtime\\rt-1', 'directory')
    virtual.add('C:\\AgentInbox\\runtime\\rt-1\\node.exe', 'file')
    virtual.add('C:\\Elsewhere', 'directory')
    virtual.add('C:\\Elsewhere\\keep.txt', 'file')
    virtual.add('C:\\AgentInbox\\runtime\\.trash-junction', 'link')
    const io = virtual.io()
    const renames: string[] = []
    const rename = io.rename
    io.rename = (from, to) => {
      renames.push(`${from} -> ${to}`)
      rename(from, to)
    }
    const filesystem = createSetupFilesystem({ platform: 'win32', io, uid: VIRTUAL_UID })

    filesystem.removeDirectory({ target: 'C:/AgentInbox/runtime/rt-1', validate() {} })
    expect(renames).toEqual([
      expect.stringMatching(/^C:\\AgentInbox\\runtime\\rt-1 -> C:\\AgentInbox\\runtime\\\.trash-rt-1-[^\\]+\\rt-1$/),
    ])
    expect(virtual.has('C:\\AgentInbox\\runtime\\rt-1')).toBe(false)

    expect(filesystem.removeLeftoverTrash('C:\\AgentInbox\\runtime').removed)
      .toEqual(['C:\\AgentInbox\\runtime\\.trash-junction'])
    expect([...virtual.entries.keys()].some((path) => path.includes('.trash-'))).toBe(false)
    expect(virtual.has('C:\\Elsewhere\\keep.txt')).toBe(true)
  })

  it('retains modeled trash when the platform reports no owner to compare', () => {
    const virtual = new VirtualWin32Filesystem()
    virtual.add('C:\\', 'directory')
    virtual.add('C:\\AgentInbox', 'directory')
    virtual.add('C:\\AgentInbox\\.trash-rt-1-1', 'directory')
    const filesystem = createSetupFilesystem({ platform: 'win32', io: virtual.io() })

    expect(filesystem.removeLeftoverTrash('C:\\AgentInbox').retained).toEqual(['C:\\AgentInbox\\.trash-rt-1-1'])
    expect(virtual.has('C:\\AgentInbox\\.trash-rt-1-1')).toBe(true)
  })

  it('never recursively cleans a staging tree whose captured identity was replaced', () => {
    const virtual = new VirtualWin32Filesystem()
    virtual.add('C:\\', 'directory')
    virtual.add('C:\\AgentInbox', 'directory')
    const filesystem = createSetupFilesystem({ platform: 'win32', io: virtual.io() })
    let replacementSentinel = ''

    expect(() => filesystem.stageDirectory({
      destination: 'C:\\AgentInbox\\runtime',
      replacement: 'refuse',
      prepare(stage) {
        if (!virtual.has(stage)) virtual.add(stage, 'directory')
      },
      validate(stage) {
        virtual.removeTree(stage)
        virtual.add(stage, 'directory')
        replacementSentinel = win32.join(stage, 'unrelated.txt')
        virtual.add(replacementSentinel, 'file')
      },
    })).toThrow(/identity changed|cleanup was refused/i)
    expect(virtual.has('C:\\AgentInbox\\runtime')).toBe(false)
    expect(virtual.has(replacementSentinel)).toBe(true)
  })
})
