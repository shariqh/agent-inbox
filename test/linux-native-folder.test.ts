import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LinuxBinaryGateError,
  assertBinaryCompatibility,
  assertProcessIdentity,
  readElfArchitecture,
} from '../scripts/linux-binary-gates.mjs'
import { buildLinuxThinApp } from '../scripts/build-linux-thin-app.mjs'
import { resolveLinuxCompilerEnvironment } from '../scripts/linux-release-inputs.mjs'
import { PROCESS_PROBE } from '../scripts/verify-linux-thin-app.mjs'

function elfFixture(arch: 'x64' | 'arm64', symbols: string[] = []): string {
  const bytes = Buffer.alloc(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
  const path = join(mkdtempSync(join(tmpdir(), 'linux-elf-')), 'binary')
  writeFileSync(path, Buffer.concat([bytes, Buffer.from(`\0${symbols.join('\0')}\0`)]))
  return path
}

describe('native Linux folder gates', () => {
  it('reads exact ELF machine identities and rejects cross-architecture substitutions', () => {
    const x64 = elfFixture('x64')
    const arm64 = elfFixture('arm64')
    expect(readElfArchitecture(x64)).toBe('x64')
    expect(readElfArchitecture(arm64)).toBe('arm64')
    expect(() => assertBinaryCompatibility({
      path: arm64,
      label: 'Electron executable',
      arch: 'x64',
      maximumGlibcVersion: '2.28',
      maximumLibstdcxxVersion: '3.4.25',
    })).toThrow(/Electron executable.*arm64.*x64/)
  })

  it('rejects binaries or native addons that raise the pinned libc floor', () => {
    const compatible = elfFixture('x64', ['GLIBC_2.28', 'GLIBCXX_3.4.25'])
    expect(assertBinaryCompatibility({
      path: compatible,
      label: 'runtime Node',
      arch: 'x64',
      maximumGlibcVersion: '2.28',
      maximumLibstdcxxVersion: '3.4.25',
    })).toMatchObject({ arch: 'x64', maximumRequiredGlibc: '2.28' })

    const newerGlibc = elfFixture('x64', ['GLIBC_2.34'])
    expect(() => assertBinaryCompatibility({
      path: newerGlibc,
      label: 'Node-ABI addon',
      arch: 'x64',
      maximumGlibcVersion: '2.28',
      maximumLibstdcxxVersion: '3.4.25',
    })).toThrow(/requires GLIBC_2\.34/)

    const newerLibstdcxx = elfFixture('x64', ['GLIBCXX_3.4.30'])
    expect(() => assertBinaryCompatibility({
      path: newerLibstdcxx,
      label: 'Electron-ABI addon',
      arch: 'x64',
      maximumGlibcVersion: '2.28',
      maximumLibstdcxxVersion: '3.4.25',
    })).toThrow(/requires GLIBCXX_3\.4\.30/)
  })

  it('requires exact platform, architecture, version, and ABI process probes', () => {
    expect(typeof PROCESS_PROBE).toBe('string')
    expect(() => new Function('require', 'process', PROCESS_PROBE)).not.toThrow()

    expect(assertProcessIdentity({
      actual: {
        platform: 'linux',
        arch: 'arm64',
        version: 'v24.19.0',
        modulesAbi: '137',
      },
      expected: {
        platform: 'linux',
        arch: 'arm64',
        version: 'v24.19.0',
        modulesAbi: '137',
      },
      label: 'runtime Node',
    })).toMatchObject({ arch: 'arm64', modulesAbi: '137' })

    expect(() => assertProcessIdentity({
      actual: {
        platform: 'linux',
        arch: 'x64',
        version: '43.1.1',
        modulesAbi: '146',
      },
      expected: {
        platform: 'linux',
        arch: 'x64',
        version: '43.1.1',
        modulesAbi: '148',
      },
      label: 'packaged Electron',
    })).toThrow(/packaged Electron modules ABI mismatch/)

    expect(() => readElfArchitecture(join(tmpdir(), 'missing-elf')))
      .toThrow(LinuxBinaryGateError)
  })

  it('rejects non-native thin builds before reading runtime or repository paths', async () => {
    const arch = process.arch === 'arm64' ? 'x64' : 'arm64'
    const unreachable = join(tmpdir(), 'must-not-be-read', String(process.pid))
    await expect(buildLinuxThinApp({
      arch,
      runtime: join(unreachable, 'runtime'),
      output: join(unreachable, 'output'),
      repoRoot: join(unreachable, 'repo'),
    })).rejects.toThrow(/must be built natively/)
  })

  it('requires the pinned native Clang identity for Electron addon rebuilds', () => {
    const inputs = {
      compiler: {
        family: 'clang' as const,
        version: '15.0.7',
        cc: 'clang-15',
        cxx: 'clang++-15',
      },
    }
    const run = (command: string, args: string[]) => {
      if (args[0] === '-dumpmachine') return 'aarch64-unknown-linux-gnu\n'
      return `Ubuntu clang version 15.0.7 (${command})\n`
    }
    expect(resolveLinuxCompilerEnvironment(inputs, 'arm64', run)).toEqual({
      CC: 'clang-15',
      CXX: 'clang++-15',
    })

    const wrongVersion = (command: string, args: string[]) => {
      if (args[0] === '-dumpmachine') return 'aarch64-unknown-linux-gnu\n'
      return `Ubuntu clang version 14.0.0 (${command})\n`
    }
    expect(() => resolveLinuxCompilerEnvironment(inputs, 'arm64', wrongVersion))
      .toThrow(/compiler version mismatch.*15\.0\.7.*14\.0\.0/)

    const crossCompiler = (_command: string, args: string[]) => {
      if (args[0] === '-dumpmachine') return 'x86_64-pc-linux-gnu\n'
      return 'Ubuntu clang version 15.0.7\n'
    }
    expect(() => resolveLinuxCompilerEnvironment(inputs, 'arm64', crossCompiler))
      .toThrow(/compiler target mismatch.*arm64.*x86_64/)
  })

  it('keeps Linux packaging folder-only and delegates Setup metadata to schema 2', () => {
    const repo = resolve(process.cwd())
    const build = readFileSync(join(repo, 'scripts', 'build-linux-thin-app.mjs'), 'utf8')
    expect(build).toContain("platform: 'linux'")
    expect(build).toContain('write-setup-info.mjs')
    expect(build).toContain("'--runtime-key', key")
    expect(build).not.toMatch(/AppImage|\.deb\b|electron-builder|electron-forge/i)
  })
})
