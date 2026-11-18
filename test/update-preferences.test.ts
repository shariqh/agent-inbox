import { existsSync, lstatSync, lutimesSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import updatePreferences from '../electron/update-preferences.cjs'

const { createLockedFile, createUpdatePreferences, createUpdateTrustState } = updatePreferences
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

  // #617 PR 2b review: open(lock, 'wx') on a dangling symlink is EEXIST while stat (which follows
  // the link) is ENOENT; that case once retried with no deadline and no sleep, forever.
  it('a dangling symlink at the lock path fails within the deadline, and the next mutate works once it is gone', async () => {
    const dir = workDir()
    const filePath = join(dir, 'locked.json')
    const lockPath = `${filePath}.lock`
    symlinkSync(join(dir, 'nowhere'), lockPath)
    const file = createLockedFile(filePath, fsPromises)
    const started = Date.now()
    const outcome = await Promise.race([
      file.mutate(async () => 'ran').then(() => 'ran', (error: Error) => error.message),
      new Promise((resolve) => setTimeout(resolve, 9_000, 'still waiting')),
    ])
    expect(outcome).toMatch(/busy in another process/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900)
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true)
    unlinkSync(lockPath)
    await expect(file.mutate(async () => {
      await file.atomicWrite({ ok: true })
      return 'ran'
    })).resolves.toBe('ran')
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ ok: true })
    expect(existsSync(lockPath)).toBe(false)
  }, 15_000)

  it('removes a dangling symlink at the lock path as a stale lock once it is older than five minutes', async () => {
    const dir = workDir()
    const filePath = join(dir, 'locked.json')
    const lockPath = `${filePath}.lock`
    symlinkSync(join(dir, 'nowhere'), lockPath)
    const old = new Date(Date.now() - 10 * 60_000)
    lutimesSync(lockPath, old, old)
    const file = createLockedFile(filePath, fsPromises)
    const started = Date.now()
    await expect(file.mutate(async () => 'ran')).resolves.toBe('ran')
    expect(Date.now() - started).toBeLessThan(2_000)
    // existsSync follows the link, so ask lstat whether the link itself is gone
    expect(() => lstatSync(lockPath)).toThrow(/ENOENT/)
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
    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: null, highestVerifiedVersionV2: null })

    await expect(trustState.recordVerifiedVersion('2.0.0', 'v1')).resolves.toEqual({ highestVerifiedVersion: '2.0.0', highestVerifiedVersionV2: null })
    expect(readFileSync(filePath, 'utf8')).toBe('{\n  "schema": 1,\n  "highestVerifiedVersion": "2.0.0"\n}\n')
    const written = statSync(filePath).ino
    for (const notHigher of ['1.99.99', '2.0.0']) {
      await expect(trustState.recordVerifiedVersion(notHigher, 'v1')).resolves.toEqual({ highestVerifiedVersion: '2.0.0', highestVerifiedVersionV2: null })
    }
    expect(statSync(filePath).ino).toBe(written)

    await trustState.recordVerifiedVersion('10.0.0', 'v1')
    await trustState.recordVerifiedVersion('9.99.99', 'v1')
    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: '10.0.0', highestVerifiedVersionV2: null })
    await expect(trustState.recordVerifiedVersion('11.0', 'v1')).rejects.toThrow(TypeError)
    expect(existsSync(join(dir, 'update-preferences.json'))).toBe(false)
  })

  it('honors the mark in a newer-schema file but never overwrites it', async () => {
    const filePath = join(workDir(), 'update-trust-state.json')
    const newer = '{"schema":2,"highestVerifiedVersion":"3.0.0","trustedKeyIds":["ed25519-0123456789abcdef"]}'
    writeFileSync(filePath, newer)
    const trustState = createUpdateTrustState({ filePath })

    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: '3.0.0', highestVerifiedVersionV2: null })
    await expect(trustState.recordVerifiedVersion('2.0.0', 'v1')).resolves.toEqual({ highestVerifiedVersion: '3.0.0', highestVerifiedVersionV2: null })
    await expect(trustState.recordVerifiedVersion('3.1.0', 'v1')).resolves.toEqual({ highestVerifiedVersion: '3.0.0', highestVerifiedVersionV2: null })
    expect(readFileSync(filePath, 'utf8')).toBe(newer)
  })

  it('honors the mark beside unknown fields and keeps those fields when raising it', async () => {
    const filePath = join(workDir(), 'update-trust-state.json')
    writeFileSync(filePath, '{"schema":1,"highestVerifiedVersion":"3.0.0","futureField":{"kept":true}}')
    const trustState = createUpdateTrustState({ filePath })

    await expect(trustState.recordVerifiedVersion('2.0.0', 'v1')).resolves.toEqual({ highestVerifiedVersion: '3.0.0', highestVerifiedVersionV2: null })
    await expect(trustState.recordVerifiedVersion('3.1.0', 'v1')).resolves.toEqual({ highestVerifiedVersion: '3.1.0', highestVerifiedVersionV2: null })
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

    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: null, highestVerifiedVersionV2: null })
    await expect(trustState.recordVerifiedVersion('2.0.0', 'v1')).resolves.toEqual({ highestVerifiedVersion: '2.0.0', highestVerifiedVersionV2: null })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ schema: 1, highestVerifiedVersion: '2.0.0' })
  })

  it('serializes records across store instances under its own lock and never lowers the mark', async () => {
    const dir = workDir()
    const filePath = join(dir, 'update-trust-state.json')
    writeFileSync(join(dir, 'update-preferences.json.lock'), '')
    const firstProcess = createUpdateTrustState({ filePath })
    const secondProcess = createUpdateTrustState({ filePath })

    await Promise.all([
      firstProcess.recordVerifiedVersion('2.0.0', 'v1'),
      secondProcess.recordVerifiedVersion('3.0.0', 'v1'),
      firstProcess.recordVerifiedVersion('2.5.0', 'v1'),
    ])

    await expect(secondProcess.read()).resolves.toEqual({ highestVerifiedVersion: '3.0.0', highestVerifiedVersionV2: null })
    expect(existsSync(`${filePath}.lock`)).toBe(false)
  })

  it('keeps one mark per manifest in the same schema-1 file, each raised only by its own manifest (#343)', async () => {
    const filePath = join(workDir(), 'update-trust-state.json')
    const trustState = createUpdateTrustState({ filePath })

    await expect(trustState.recordVerifiedVersion('2.0.1', 'v2')).resolves.toEqual({
      highestVerifiedVersion: null,
      highestVerifiedVersionV2: '2.0.1',
    })
    await expect(trustState.recordVerifiedVersion('1.9.0', 'v1')).resolves.toEqual({
      highestVerifiedVersion: '1.9.0',
      highestVerifiedVersionV2: '2.0.1',
    })
    // A v1 manifest never raises the v2 mark, nor a v2 manifest the v1 mark, and neither falls.
    for (const [version, manifest] of [['1.8.0', 'v1'], ['2.0.0', 'v2'], ['1.9.0', 'v1'], ['2.0.1', 'v2']] as const) {
      await expect(trustState.recordVerifiedVersion(version, manifest)).resolves.toEqual({
        highestVerifiedVersion: '1.9.0',
        highestVerifiedVersionV2: '2.0.1',
      })
    }
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schema: 1,
      highestVerifiedVersion: '1.9.0',
      highestVerifiedVersionV2: '2.0.1',
    })
    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: '1.9.0', highestVerifiedVersionV2: '2.0.1' })
    for (const manifest of [undefined, 'v3', 'V2']) {
      await expect(trustState.recordVerifiedVersion('3.0.0', manifest as 'v1')).rejects.toThrow(TypeError)
    }
  })

  it('keeps the other mark and unknown fields when it raises one, as 1.3 to 1.6 keep the v2 mark', async () => {
    const filePath = join(workDir(), 'update-trust-state.json')
    writeFileSync(filePath, '{"schema":1,"highestVerifiedVersion":"1.6.0","futureField":[1]}')
    const trustState = createUpdateTrustState({ filePath })

    await trustState.recordVerifiedVersion('1.7.0', 'v2')
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schema: 1,
      highestVerifiedVersion: '1.6.0',
      highestVerifiedVersionV2: '1.7.0',
      futureField: [1],
    })
    // A malformed mark counts as none, and only its own manifest replaces it.
    writeFileSync(filePath, '{"schema":1,"highestVerifiedVersion":"1.6","highestVerifiedVersionV2":"2.0.1"}')
    await expect(trustState.read()).resolves.toEqual({ highestVerifiedVersion: null, highestVerifiedVersionV2: '2.0.1' })
    await expect(trustState.recordVerifiedVersion('1.9.0', 'v1')).resolves.toEqual({
      highestVerifiedVersion: '1.9.0',
      highestVerifiedVersionV2: '2.0.1',
    })
  })
})
