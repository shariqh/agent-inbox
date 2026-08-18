import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import setupCore from '../electron/setup-core.cjs'
import type {
  SetupExecutionAdapter,
  SetupOperation,
  SetupRequest,
  SetupResult,
  SetupSelection,
  VerifiedSetupIdentity,
} from '../electron/setup-core.cjs'

const { runTrustedSetup } = setupCore
const root = resolve(import.meta.dirname, '..')

const releaseKeys = Object.freeze(['darwin-arm64', 'darwin-x64'])
const targets = Object.freeze(['all', 'claude', 'copilot'])
const selections = Object.freeze({
  'darwin-arm64': Object.freeze({
    key: 'darwin-arm64',
    sourceRoot: '/signed/runtime/darwin-arm64',
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    packageVersion: '1.2.3',
  }),
  'darwin-x64': Object.freeze({
    key: 'darwin-x64',
    sourceRoot: '/signed/runtime/darwin-x64',
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    packageVersion: '1.2.3',
  }),
})

type RuntimeKey = keyof typeof selections

function hostFor(key: string) {
  if (key === 'darwin-arm64') return { platform: 'darwin', arch: 'arm64', key }
  if (key === 'darwin-x64') return { platform: 'darwin', arch: 'x64', key }
  throw new Error(`unsupported test runtime key: ${key}`)
}

function verified(selection: SetupSelection): VerifiedSetupIdentity {
  const { platform, arch } = hostFor(selection.key)
  return {
    sourceRoot: selection.sourceRoot,
    manifestDigest: selection.manifestDigest,
    packageVersion: selection.packageVersion,
    product: 'agent-inbox-runtime',
    runtimeId: `agent-inbox-runtime-${selection.packageVersion}-${selection.key}-1234567890abcdef`,
    payloadDigest: 'c'.repeat(64),
    platform,
    arch,
    nodeMajor: 24,
    nodeModulesAbi: '137',
  }
}

function result(overrides: Partial<SetupResult> = {}): SetupResult {
  return {
    ok: true,
    exitCode: 0,
    output: 'installed',
    target: 'all',
    timedOut: false,
    cancelled: false,
    ...overrides,
  }
}

function adapterFor(
  key: RuntimeKey,
  options: {
    verify?: (request: Readonly<SetupRequest>) => VerifiedSetupIdentity
    start?: (
      operation: Readonly<SetupOperation>,
      controls: { onCancel: (cancel: () => void) => void },
    ) => Promise<SetupResult>
  } = {},
): SetupExecutionAdapter {
  const host = hostFor(key)
  return Object.freeze({
    id: 'darwin-shell-v1',
    host: Object.freeze(host),
    releaseKeys,
    targets,
    verify: options.verify ?? ((request: Readonly<SetupRequest>) => verified(request.selection)),
    start: options.start ?? (() => Promise.resolve(result())),
  })
}

function requestFor(key: RuntimeKey, target = 'all') {
  return {
    target,
    selection: selections[key],
  }
}

describe('trusted Setup core', () => {
  it('passes only a deeply frozen, mechanically consumed operation after synchronous verification', async () => {
    const calls: string[] = []
    const expected = result()
    const received: Readonly<SetupOperation>[] = []
    const adapter = adapterFor('darwin-arm64', {
      verify(request) {
        calls.push('verify')
        return verified(request.selection)
      },
      start(operation) {
        calls.push('start')
        received.push(operation)
        return Promise.resolve(expected)
      },
    })

    const actual = await runTrustedSetup({
      request: requestFor('darwin-arm64'),
      adapter,
      onCancel() {},
    })

    expect(actual).toBe(expected)
    expect(calls).toEqual(['verify', 'start'])
    const operation = received[0]
    expect(operation).toBeDefined()
    if (!operation) throw new Error('expected the adapter to receive an operation')
    expect(Object.keys(operation).sort()).toEqual([
      'host',
      'manifestDigest',
      'packageVersion',
      'sourceRoot',
      'target',
    ])
    expect(Object.isFrozen(operation)).toBe(true)
    expect(Object.isFrozen(operation.host)).toBe(true)
  })

  it.each([
    ['darwin-arm64', 'darwin-x64'],
    ['darwin-x64', 'darwin-arm64'],
  ] as const)(
    'refuses valid cross-architecture payload %s on exact host %s even when both universal payloads verify',
    async (selectionKey, hostKey) => {
      const calls: string[] = []
      const adapter = adapterFor(hostKey, {
        verify(request) {
          calls.push(`verified:${request.selection.key}`)
          return verified(request.selection)
        },
        start() {
          calls.push('started')
          return Promise.resolve(result())
        },
      })

      const actual = await runTrustedSetup({
        request: requestFor(selectionKey),
        adapter,
        onCancel() {},
      })

      expect(Object.keys(selections).sort()).toEqual(['darwin-arm64', 'darwin-x64'])
      expect(calls).toEqual([`verified:${selectionKey}`])
      expect(actual).toMatchObject({
        ok: false,
        exitCode: null,
        timedOut: false,
        cancelled: false,
      })
      expect(actual.output).toMatch(/integrity verification/i)
    },
  )

  const identityChanges: Array<[string, (value: VerifiedSetupIdentity) => VerifiedSetupIdentity]> = [
    ['manifest key', (value: ReturnType<typeof verified>) => ({ ...value, arch: 'x64' })],
    ['source root', (value: ReturnType<typeof verified>) => ({ ...value, sourceRoot: '/other/runtime' })],
    ['manifest digest', (value: ReturnType<typeof verified>) => ({ ...value, manifestDigest: `sha256:${'d'.repeat(64)}` })],
    ['package version', (value: ReturnType<typeof verified>) => ({ ...value, packageVersion: '9.9.9' })],
    ['product', (value: ReturnType<typeof verified>) => ({ ...value, product: 'other-runtime' })],
    ['runtime id', (value: ReturnType<typeof verified>) => ({ ...value, runtimeId: '' })],
    ['payload digest', (value: ReturnType<typeof verified>) => ({ ...value, payloadDigest: 'not-a-digest' })],
    ['Node major', (value: ReturnType<typeof verified>) => ({ ...value, nodeMajor: 23 })],
    ['Node ABI', (value: ReturnType<typeof verified>) => ({ ...value, nodeModulesAbi: '999' })],
  ]

  it.each(identityChanges)('rejects a verified identity with mismatched %s before start', async (_label, change) => {
    let started = false
    const adapter = adapterFor('darwin-arm64', {
      verify(request) {
        return change(verified(request.selection))
      },
      start() {
        started = true
        return Promise.resolve(result())
      },
    })

    const actual = await runTrustedSetup({
      request: requestFor('darwin-arm64'),
      adapter,
      onCancel() {},
    })

    expect(started).toBe(false)
    expect(actual.ok).toBe(false)
    expect(actual.output).toMatch(/integrity verification/i)
  })

  it('rejects invalid targets before verification', async () => {
    let verifiedPayload = false
    const adapter = adapterFor('darwin-arm64', {
      verify(request) {
        verifiedPayload = true
        return verified(request.selection)
      },
    })

    const actual = await runTrustedSetup({
      request: requestFor('darwin-arm64', '../anything'),
      adapter,
      onCancel() {},
    })

    expect(verifiedPayload).toBe(false)
    expect(actual).toEqual({
      ok: false,
      exitCode: null,
      output: 'Invalid setup target: ../anything',
      target: '../anything',
      timedOut: false,
      cancelled: false,
    })
  })

  it('rejects an asynchronous verifier without starting', async () => {
    let started = false
    const valid = adapterFor('darwin-arm64')
    const adapter: SetupExecutionAdapter = Object.freeze({
      ...valid,
      verify: (request: Readonly<SetupRequest>) =>
        Promise.resolve(verified(request.selection)) as unknown as VerifiedSetupIdentity,
      start() {
        started = true
        return Promise.resolve(result())
      },
    })

    const actual = await runTrustedSetup({
      request: requestFor('darwin-arm64'),
      adapter,
      onCancel() {},
    })

    expect(started).toBe(false)
    expect(actual.ok).toBe(false)
    expect(actual.output).toMatch(/integrity verification/i)
  })

  it('passes the adapter result through without changing current cancellation or ok semantics', async () => {
    const currentRaceResult = result({ ok: true, cancelled: true })
    const adapter = adapterFor('darwin-arm64', {
      start() {
        return Promise.resolve(currentRaceResult)
      },
    })

    const actual = await runTrustedSetup({
      request: requestFor('darwin-arm64'),
      adapter,
      onCancel() {},
    })

    expect(actual).toBe(currentRaceResult)
    expect(actual).toEqual({
      ok: true,
      exitCode: 0,
      output: 'installed',
      target: 'all',
      timedOut: false,
      cancelled: true,
    })
  })

  it('ships one production export and no platform or process implementation', () => {
    const source = readFileSync(join(root, 'electron', 'setup-core.cjs'), 'utf8')
    const declaration = readFileSync(join(root, 'electron', 'setup-core.d.cts'), 'utf8')

    expect(Object.keys(setupCore).sort()).toEqual(['runTrustedSetup'])
    expect(declaration.match(/^export function /gm)).toHaveLength(1)
    expect(declaration).toContain('export function runTrustedSetup')
    for (const forbidden of [
      "require('electron')",
      "require('node:child_process')",
      "require('node:fs')",
      "require('node:path')",
      'process.platform',
      'process.arch',
      '/bin/bash',
      'SIGTERM',
      'SIGKILL',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })
})
