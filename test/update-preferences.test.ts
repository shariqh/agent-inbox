import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import updatePreferences from '../electron/update-preferences.cjs'

const { createUpdatePreferences, createUpdateTrustState } = updatePreferences
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

describe('update trust state (rollback high-water mark, #148)', () => {
  it('keeps only the highest verified version in its own userData file', async () => {
    const dir = workDir()
    const trustState = createUpdateTrustState({ app: { getPath: () => dir } })
    const filePath = join(dir, 'update-trust-state.json')
    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: null })

    await expect(trustState.recordVerifiedVersion('2.0.0')).resolves.toEqual({ highestVerifiedVersion: '2.0.0' })
    expect(readFileSync(filePath, 'utf8')).toBe('{\n  "schema": 1,\n  "highestVerifiedVersion": "2.0.0"\n}\n')
    const written = statSync(filePath).ino
    for (const notHigher of ['1.99.99', '2.0.0']) {
      await expect(trustState.recordVerifiedVersion(notHigher)).resolves.toEqual({ highestVerifiedVersion: '2.0.0' })
    }
    expect(statSync(filePath).ino).toBe(written)

    await trustState.recordVerifiedVersion('10.0.0')
    await trustState.recordVerifiedVersion('9.99.99')
    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: '10.0.0' })
    await expect(trustState.recordVerifiedVersion('11.0')).rejects.toThrow(TypeError)
    expect(existsSync(join(dir, 'update-preferences.json'))).toBe(false)
  })

  it('honors the mark in a newer-schema file but never overwrites it', async () => {
    const filePath = join(workDir(), 'update-trust-state.json')
    const newer = '{"schema":2,"highestVerifiedVersion":"3.0.0","trustedKeyIds":["ed25519-0123456789abcdef"]}'
    writeFileSync(filePath, newer)
    const trustState = createUpdateTrustState({ filePath })

    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: '3.0.0' })
    await expect(trustState.recordVerifiedVersion('2.0.0')).resolves.toEqual({ highestVerifiedVersion: '3.0.0' })
    await expect(trustState.recordVerifiedVersion('3.1.0')).resolves.toEqual({ highestVerifiedVersion: '3.0.0' })
    expect(readFileSync(filePath, 'utf8')).toBe(newer)
  })

  it('honors the mark beside unknown fields and keeps those fields when raising it', async () => {
    const filePath = join(workDir(), 'update-trust-state.json')
    writeFileSync(filePath, '{"schema":1,"highestVerifiedVersion":"3.0.0","futureField":{"kept":true}}')
    const trustState = createUpdateTrustState({ filePath })

    await expect(trustState.recordVerifiedVersion('2.0.0')).resolves.toEqual({ highestVerifiedVersion: '3.0.0' })
    await expect(trustState.recordVerifiedVersion('3.1.0')).resolves.toEqual({ highestVerifiedVersion: '3.1.0' })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schema: 1,
      highestVerifiedVersion: '3.1.0',
      futureField: { kept: true },
    })
  })

  it.each([
    '{"schema":1,"highestVerifiedVersion":"9.0',
    '["9.0.0"]',
    '{"highestVerifiedVersion":"9.0.0"}',
    '{"schema":1,"highestVerifiedVersion":"9.0"}',
  ])('treats a corrupt trust file as no mark and replaces it on the next verified version: %s', async (bytes) => {
    const filePath = join(workDir(), 'update-trust-state.json')
    writeFileSync(filePath, bytes)
    const trustState = createUpdateTrustState({ filePath })

    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: null })
    await expect(trustState.recordVerifiedVersion('2.0.0')).resolves.toEqual({ highestVerifiedVersion: '2.0.0' })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ schema: 1, highestVerifiedVersion: '2.0.0' })
  })

  it('serializes records across store instances under its own lock and never lowers the mark', async () => {
    const dir = workDir()
    const filePath = join(dir, 'update-trust-state.json')
    writeFileSync(join(dir, 'update-preferences.json.lock'), '')
    const firstProcess = createUpdateTrustState({ filePath })
    const secondProcess = createUpdateTrustState({ filePath })

    await Promise.all([
      firstProcess.recordVerifiedVersion('2.0.0'),
      secondProcess.recordVerifiedVersion('3.0.0'),
      firstProcess.recordVerifiedVersion('2.5.0'),
    ])

    await expect(secondProcess.read()).resolves.toEqual({ highestVerifiedVersion: '3.0.0' })
    expect(existsSync(`${filePath}.lock`)).toBe(false)
  })
})
