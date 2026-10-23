import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import type { SetupFilesystemIO } from '../scripts/setup-filesystem.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const require = createRequire(import.meta.url)
const { createSetupFilesystem } = require('../scripts/setup-filesystem.cjs')

describe.runIf(process.platform === 'win32')('native Win32 Setup filesystem evidence', () => {
  afterEach(removeScratchDirs)

  it('publishes and removes an immutable runtime with stable NTFS identity', () => {
    const parent = scratchDir('agent-inbox-win32-fs-')
    const destination = join(parent, 'runtime-id')
    const filesystem = createSetupFilesystem()
    const parentIdentity = filesystem.identify(parent, 'directory')
    expect(BigInt(parentIdentity.device)).toBeGreaterThan(0n)
    expect(BigInt(parentIdentity.inode)).toBeGreaterThan(0n)

    const result = filesystem.stageDirectory({
      destination,
      replacement: 'refuse',
      prepare(stage: string) {
        const manifest = join(stage, 'runtime-manifest.json')
        writeFileSync(manifest, '{}\n')
        chmodSync(manifest, 0o444)
        return 'prepared'
      },
      validate(stage: string) {
        expect(existsSync(join(stage, 'runtime-manifest.json'))).toBe(true)
      },
    })
    expect(result).toMatchObject({ path: destination, replaced: false, prepared: 'prepared' })
    const published = filesystem.identify(destination, 'directory')
    expect(filesystem.assertIdentity(published, destination.toUpperCase()).inode).toBe(published.inode)
    expect(readdirSync(parent).some((name) => name.startsWith('.agent-inbox-stage-'))).toBe(false)
    expect(() => filesystem.stageDirectory({
      destination,
      replacement: 'refuse',
      prepare() {},
      validate() {},
    })).toThrow(/already exists/i)

    filesystem.removeDirectory({
      target: destination,
      validate(path: string) {
        expect(existsSync(join(path, 'runtime-manifest.json'))).toBe(true)
      },
    })
    expect(existsSync(destination)).toBe(false)
  })

  // #333: the evidence that a folder with an open file inside is refused with
  // a code the build-time publisher retries, and that the retry then publishes
  it('retries a publication Windows refused while a file in the stage was open', () => {
    const parent = scratchDir('agent-inbox-win32-busy-')
    const destination = join(parent, 'runtime-id')
    const refusals: unknown[] = []
    let held: number | undefined
    const release = () => {
      if (held !== undefined) closeSync(held)
      held = undefined
    }
    // The module's own filesystem calls, except that a refused rename lets go
    // of the held file, as an exiting child's handles close
    const io: SetupFilesystemIO = {
      lstat: (path) => lstatSync(path, { bigint: true }),
      realpath: (path) => realpathSync.native(path),
      mkdir: (path, options) => { mkdirSync(path, options) },
      mkdtemp: (prefix) => mkdtempSync(prefix),
      rename(from, to) {
        try {
          renameSync(from, to)
        } catch (error) {
          refusals.push((error as NodeJS.ErrnoException).code)
          release()
          throw error
        }
      },
      remove: (path, options) => { rmSync(path, options) },
      readdir: (path) => readdirSync(path),
    }

    try {
      createSetupFilesystem({ io }).stageDirectory({
        destination,
        replacement: 'refuse',
        prepare(stage: string) {
          writeFileSync(join(stage, 'held.txt'), 'held\n')
          held = openSync(join(stage, 'held.txt'), 'r')
        },
        validate() {},
        retryBusyRename: true,
      })
    } finally {
      release()
    }

    // Defender scanning the new file may refuse it once more
    expect(refusals.length).toBeGreaterThan(0)
    for (const code of refusals) expect(['EPERM', 'EACCES', 'EBUSY']).toContain(code)
    expect(existsSync(join(destination, 'held.txt'))).toBe(true)
    expect(readdirSync(parent)).toEqual(['runtime-id'])
  })

  it('refuses a native junction instead of traversing or deleting its target', () => {
    const parent = scratchDir('agent-inbox-win32-junction-')
    const outside = scratchDir('agent-inbox-win32-outside-')
    const marker = join(outside, 'keep.txt')
    writeFileSync(marker, 'keep\n')
    const junction = join(parent, 'linked-runtime')
    symlinkSync(outside, junction, 'junction')
    const filesystem = createSetupFilesystem()

    expect(() => filesystem.identify(junction, 'directory')).toThrow(/junction|reparse/i)
    expect(() => filesystem.removeDirectory({ target: junction, validate() {} }))
      .toThrow(/junction|reparse/i)
    expect(existsSync(marker)).toBe(true)
  })
})
