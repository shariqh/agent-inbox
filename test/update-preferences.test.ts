import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import updatePreferences from '../electron/update-preferences.cjs'

const { createUpdatePreferences } = updatePreferences
const root = resolve(import.meta.dirname, '..')
const workDirs: string[] = []

function workDir() {
  const dir = join(root, `.test-update-preferences-${process.pid}-${workDirs.length}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  workDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('update preferences', () => {
  it('defaults missing and corrupt files to automatic checks off', async () => {
    const dir = workDir()
    const filePath = join(dir, 'updates.json')
    const preferences = createUpdatePreferences({ filePath })
    await expect(preferences.read()).resolves.toEqual({
      schema: 1,
      automaticChecks: false,
      lastNotifiedVersion: null,
    })

    writeFileSync(filePath, '{"schema":1,"automaticChecks":true,"extra":1}')
    await expect(preferences.read()).resolves.toEqual({
      schema: 1,
      automaticChecks: false,
      lastNotifiedVersion: null,
    })
  })

  it('surfaces storage failures instead of treating them as preference corruption', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const preferences = createUpdatePreferences({
      filePath: join(workDir(), 'updates.json'),
      fsImpl: {
        async readFile() { throw failure },
        async writeFile() { throw new Error('not reached') },
        async rename() { throw new Error('not reached') },
        async unlink() {},
        async mkdir() {},
      },
    })

    await expect(preferences.read()).rejects.toBe(failure)
  })

  it('writes canonically through a same-parent temporary file and rename', async () => {
    const dir = workDir()
    const filePath = join(dir, 'updates.json')
    const writes: string[] = []
    const renames: Array<[string, string]> = []
    const fsImpl = {
      async readFile(path: string) {
        return await import('node:fs/promises').then((fs) => fs.readFile(path))
      },
      async writeFile(
        path: string,
        data: string,
        options: { encoding: 'utf8'; mode: number; flag: 'wx' },
      ) {
        writes.push(path)
        return await import('node:fs/promises').then((fs) => fs.writeFile(path, data, options))
      },
      async rename(from: string, to: string) {
        renames.push([from, to])
        return await import('node:fs/promises').then((fs) => fs.rename(from, to))
      },
      async unlink(path: string) {
        return await import('node:fs/promises').then((fs) => fs.unlink(path))
      },
      async mkdir(path: string, options: { recursive: true }) {
        return await import('node:fs/promises').then((fs) => fs.mkdir(path, options))
      },
    }
    const preferences = createUpdatePreferences({ filePath, fsImpl })
    await preferences.setAutomatic(true)

    expect(writes).toHaveLength(1)
    expect(resolve(writes[0]!)).not.toBe(resolve(filePath))
    expect(resolve(writes[0]!, '..')).toBe(resolve(filePath, '..'))
    expect(renames).toEqual([[writes[0], filePath]])
    expect(readFileSync(filePath, 'utf8')).toBe(
      '{\n  "schema": 1,\n  "automaticChecks": true,\n  "lastNotifiedVersion": null\n}\n',
    )
  })

  it('serializes concurrent live read-modify-write operations without preference loss', async () => {
    const dir = workDir()
    const filePath = join(dir, 'updates.json')
    const preferences = createUpdatePreferences({ filePath })

    await Promise.all([
      preferences.setAutomatic(true),
      preferences.setLastNotifiedVersion('2.0.0'),
    ])

    await expect(preferences.read()).resolves.toEqual({
      schema: 1,
      automaticChecks: true,
      lastNotifiedVersion: '2.0.0',
    })

  })

  it('serializes live read-modify-write operations across store instances', async () => {
    const filePath = join(workDir(), 'updates.json')
    const firstProcess = createUpdatePreferences({ filePath })
    const secondProcess = createUpdatePreferences({ filePath })

    await Promise.all([
      firstProcess.setAutomatic(true),
      secondProcess.setLastNotifiedVersion('2.0.0'),
    ])

    await expect(firstProcess.read()).resolves.toEqual({
      schema: 1,
      automaticChecks: true,
      lastNotifiedVersion: '2.0.0',
    })
  })

  it('re-reads the live file for each mutation instead of using a startup snapshot', async () => {
    const dir = workDir()
    const filePath = join(dir, 'updates.json')
    const preferences = createUpdatePreferences({ filePath })
    await preferences.setAutomatic(true)
    writeFileSync(filePath, JSON.stringify({
      schema: 1,
      automaticChecks: false,
      lastNotifiedVersion: '1.9.0',
    }))

    await preferences.setLastNotifiedVersion('2.0.0')
    await expect(preferences.read()).resolves.toEqual({
      schema: 1,
      automaticChecks: false,
      lastNotifiedVersion: '2.0.0',
    })
  })

  it('can derive its path from an app userData adapter', async () => {
    const dir = workDir()
    const getPath = vi.fn(() => dir)
    const preferences = createUpdatePreferences({ app: { getPath }, filename: 'updates.json' })
    await preferences.setAutomatic(true)
    expect(getPath).toHaveBeenCalledWith('userData')
    expect(JSON.parse(readFileSync(join(dir, 'updates.json'), 'utf8')).automaticChecks).toBe(true)
  })
})
