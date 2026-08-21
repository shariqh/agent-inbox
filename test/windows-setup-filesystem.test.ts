import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createSetupFilesystem } = require('../scripts/setup-filesystem.cjs')

describe.runIf(process.platform === 'win32')('native Win32 Setup filesystem evidence', () => {
  it('publishes and removes an immutable runtime with stable NTFS identity', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agent-inbox-win32-fs-'))
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

  it('refuses a native junction instead of traversing or deleting its target', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agent-inbox-win32-junction-'))
    const outside = mkdtempSync(join(tmpdir(), 'agent-inbox-win32-outside-'))
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
