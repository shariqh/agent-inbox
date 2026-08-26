import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  UPDATE_TRUST_DISABLED_MESSAGE,
  loadUpdateRegistry,
} = require('../electron/update-trust.cjs')

const root = resolve(process.cwd())

describe('optional Electron update trust initialization', () => {
  it('returns the validated bundled registry without logging', () => {
    const logger = { error: vi.fn() }
    const registry = loadUpdateRegistry({
      registryPath: join(root, 'release', 'update-keys.json'),
      logger,
    })

    expect(registry).toMatchObject({
      schema: 1,
      signingKeyId: 'ed25519-99927ba2f6af6482',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('safe-disables update checks when the registry file is missing', () => {
    const logger = { error: vi.fn() }
    const registry = loadUpdateRegistry({
      registryPath: join(mkdtempSync(join(tmpdir(), 'update-trust-missing-')), 'missing.json'),
      logger,
    })

    expect(registry).toBeNull()
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(UPDATE_TRUST_DISABLED_MESSAGE)
  })

  it('safe-disables malformed registry data without logging file contents', () => {
    const temp = mkdtempSync(join(tmpdir(), 'update-trust-malformed-'))
    const registryPath = join(temp, 'update-keys.json')
    const sensitiveFixture = 'must-not-appear-in-log'
    writeFileSync(registryPath, `{"schema":1,"unexpected":"${sensitiveFixture}"}\n`)
    const logger = { error: vi.fn() }

    expect(loadUpdateRegistry({ registryPath, logger })).toBeNull()
    expect(logger.error).toHaveBeenCalledOnce()
    const logged = JSON.stringify(logger.error.mock.calls)
    expect(logged).toContain(UPDATE_TRUST_DISABLED_MESSAGE)
    expect(logged).not.toContain(sensitiveFixture)
    expect(logged).not.toContain(registryPath)
  })
})
