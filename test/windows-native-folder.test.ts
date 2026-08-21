import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildWindowsThinApp } from '../scripts/build-windows-thin-app.mjs'

const root = resolve(process.cwd())

function icoEntries(path: string): Array<{ width: number; height: number; size: number; offset: number }> {
  const bytes = readFileSync(path)
  expect(bytes.readUInt16LE(0)).toBe(0)
  expect(bytes.readUInt16LE(2)).toBe(1)
  const count = bytes.readUInt16LE(4)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16
    entries.push({
      width: bytes[offset] === 0 ? 256 : bytes[offset]!,
      height: bytes[offset + 1] === 0 ? 256 : bytes[offset + 1]!,
      size: bytes.readUInt32LE(offset + 8),
      offset: bytes.readUInt32LE(offset + 12),
    })
  }
  return entries
}

describe('native Windows x64 folder foundation', () => {
  it.runIf(process.platform !== 'win32' || process.arch !== 'x64')(
    'refuses non-native builds before reading runtime or repository paths',
    async () => {
      const unreachable = join(root, 'build', 'must-not-be-read')
      await expect(buildWindowsThinApp({
        runtime: join(unreachable, 'runtime'),
        output: join(unreachable, 'output'),
        repoRoot: join(unreachable, 'repo'),
      })).rejects.toThrow(/must be built natively on win32\/x64/)
    },
  )

  it('keeps the Windows folder builder installer-free and Setup disabled', () => {
    const build = readFileSync(join(root, 'scripts', 'build-windows-thin-app.mjs'), 'utf8')
    const verify = readFileSync(join(root, 'scripts', 'verify-windows-thin-app.mjs'), 'utf8')
    const targets = readFileSync(join(root, 'electron', 'runtime-targets.cjs'), 'utf8')
    const runner = readFileSync(join(root, 'electron', 'setup-runner.cjs'), 'utf8')
    const processAdapter = readFileSync(join(root, 'electron', 'setup-process.cjs'), 'utf8')

    expect(build).toContain("platform: 'win32'")
    expect(build).toContain("'--runtime-key', key")
    expect(build).toContain("icon: join(repoRoot, 'electron', 'icon.ico')")
    expect(build).not.toMatch(/WiX|Squirrel|electron-forge|portable\.zip/i)
    expect(verify).toContain("reason !== 'unsupported-platform'")
    expect(verify).toContain('setupAvailable: false')
    expect(targets).toContain("'win32-x64'")
    expect(targets).toContain('const POSIX_SETUP_RUNTIME_KEYS')
    expect(runner).toContain('const RUNTIME_KEYS = new Set(POSIX_SETUP_RUNTIME_KEYS)')
    expect(processAdapter).toContain("const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])")
  })

  it('ships a deterministic Windows icon with required PNG representations', () => {
    const entries = icoEntries(join(root, 'electron', 'icon.ico'))
    expect(entries.map(({ width, height }) => [width, height])).toEqual([
      [16, 16],
      [32, 32],
      [256, 256],
    ])
    const bytes = readFileSync(join(root, 'electron', 'icon.ico'))
    for (const entry of entries) {
      expect(entry.size).toBeGreaterThan(0)
      expect(entry.offset + entry.size).toBeLessThanOrEqual(bytes.length)
      expect([...bytes.subarray(entry.offset, entry.offset + 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ])
    }
  })

  it('keeps the Windows package foundation in package smoke', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    for (const test of [
      'test/windows-release-inputs.test.ts',
      'test/windows-binary-gates.test.ts',
      'test/windows-native-folder.test.ts',
      'test/windows-release-workflow.test.ts',
    ]) {
      expect(pkg.scripts['package:smoke']).toContain(test)
    }
  })
})
