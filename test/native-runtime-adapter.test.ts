import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NativeRuntimeAdapterError,
  archiveExtractCommand,
  archiveListCommand,
  assertPlainFile,
  assertSystemTool,
  nativeRuntimeAdapterFor,
  resolveNodeDistributionPaths,
  validateArchiveEntries,
} from '../scripts/native-runtime-adapter.mjs'

describe('native runtime staging adapters', () => {
  it('preserves the exact POSIX archive and distribution layout', () => {
    for (const key of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      const adapter = nativeRuntimeAdapterFor(key)
      expect(adapter).toMatchObject({
        key,
        archiveFormat: 'tar.xz',
        archiveExecutable: '/usr/bin/tar',
        archiveListFlags: ['-tJf'],
        archiveExtractFlags: ['-xJf'],
        nodeExecRelPath: 'bin/node',
        npmCliRelPath: 'lib/node_modules/npm/bin/npm-cli.js',
        payloadNodeExecRelPath: 'bin/node',
        payloadNodeMode: 0o755,
      })
      expect(archiveListCommand(adapter, '/tmp/node.tar.xz')).toEqual({
        executable: '/usr/bin/tar',
        args: ['-tJf', '/tmp/node.tar.xz'],
      })
      expect(archiveExtractCommand(adapter, '/tmp/node.tar.xz', '/tmp/out')).toEqual({
        executable: '/usr/bin/tar',
        args: ['-xJf', '/tmp/node.tar.xz', '-C', '/tmp/out'],
      })
      expect(Object.isFrozen(adapter)).toBe(true)
      expect(Object.isFrozen(adapter.archiveListFlags)).toBe(true)
      expect(Object.isFrozen(adapter.archiveExtractFlags)).toBe(true)
    }
  })

  it('uses the native Windows ZIP tool and root-level Node/npm paths', () => {
    const adapter = nativeRuntimeAdapterFor('win32-x64', { systemRoot: 'D:\\Windows' })
    expect(adapter).toMatchObject({
      key: 'win32-x64',
      archiveFormat: 'zip',
      archiveExecutable: 'D:\\Windows\\System32\\tar.exe',
      archiveListFlags: ['-tf'],
      archiveExtractFlags: ['-xf'],
      nodeExecRelPath: 'node.exe',
      npmCliRelPath: 'node_modules/npm/bin/npm-cli.js',
      payloadNodeExecRelPath: 'node.exe',
      payloadNodeMode: null,
    })
    expect(archiveListCommand(adapter, 'D:\\cache\\node.zip')).toEqual({
      executable: 'D:\\Windows\\System32\\tar.exe',
      args: ['-tf', 'D:\\cache\\node.zip'],
    })
    expect(archiveExtractCommand(adapter, 'D:\\cache\\node.zip', 'D:\\stage')).toEqual({
      executable: 'D:\\Windows\\System32\\tar.exe',
      args: ['-xf', 'D:\\cache\\node.zip', '-C', 'D:\\stage'],
    })
    expect(resolveNodeDistributionPaths('D:\\node', adapter)).toEqual({
      nodeExec: 'D:\\node\\node.exe',
      npmCli: 'D:\\node\\node_modules\\npm\\bin\\npm-cli.js',
      payloadNodeExecRelPath: 'node.exe',
    })
  })

  it('resolves POSIX distribution paths without host-dependent separators', () => {
    const adapter = nativeRuntimeAdapterFor('linux-arm64')
    expect(resolveNodeDistributionPaths('/opt/node', adapter)).toEqual({
      nodeExec: '/opt/node/bin/node',
      npmCli: '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
      payloadNodeExecRelPath: 'bin/node',
    })
  })

  it('fails closed for malformed Windows roots and unknown targets', () => {
    expect(() => nativeRuntimeAdapterFor('win32-x64', { systemRoot: '' }))
      .toThrow(/SystemRoot is required/)
    expect(() => nativeRuntimeAdapterFor('win32-x64', { systemRoot: 'Windows' }))
      .toThrow(/absolute Windows path/)
    expect(() => nativeRuntimeAdapterFor('win32-arm64'))
      .toThrow(/unknown runtime target/)
  })

  it('normalizes safe listings and rejects ambiguous or escaping entries', () => {
    expect(validateArchiveEntries([
      'node-v24.19.0-win-x64/',
      'node-v24.19.0-win-x64/node.exe',
      'node-v24.19.0-win-x64/node_modules/npm/bin/npm-cli.js',
    ], 'node-v24.19.0-win-x64')).toEqual([
      'node-v24.19.0-win-x64',
      'node-v24.19.0-win-x64/node.exe',
      'node-v24.19.0-win-x64/node_modules/npm/bin/npm-cli.js',
    ])

    for (const entry of [
      '/node-v24.19.0-win-x64/node.exe',
      'C:/node-v24.19.0-win-x64/node.exe',
      'node-v24.19.0-win-x64\\..\\evil.exe',
      'node-v24.19.0-win-x64/../evil.exe',
      'node-v24.19.0-win-x64/./node.exe',
      'node-v24.19.0-win-x64//node.exe',
      'node-v24.19.0-win-x64//',
      'node-v24.19.0-win-x64/node_modules//',
      'other-root/node.exe',
      'node-v24.19.0-win-x64/\0evil',
    ]) {
      expect(() => validateArchiveEntries([entry], 'node-v24.19.0-win-x64'), entry)
        .toThrow(NativeRuntimeAdapterError)
    }

    expect(() => validateArchiveEntries([], 'node-v24.19.0-win-x64')).toThrow(/empty/)
    expect(() => validateArchiveEntries([
      'node-v24.19.0-win-x64/node.exe',
      'node-v24.19.0-win-x64/node.exe',
    ], 'node-v24.19.0-win-x64')).toThrow(/duplicate/)
  })

  it('accepts only plain non-symlink files at trusted executable paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-adapter-file-'))
    const file = join(root, 'tar')
    writeFileSync(file, '#!/bin/sh\n')
    chmodSync(file, 0o755)
    expect(assertPlainFile(file, 'archive tool')).toBe(file)

    const directory = join(root, 'directory')
    mkdirSync(directory)
    expect(() => assertPlainFile(directory, 'archive tool')).toThrow(/plain regular file/)
    expect(() => assertSystemTool(directory, 'archive tool')).toThrow(/resolve to a regular file/)

    const link = join(root, 'link')
    symlinkSync(file, link)
    expect(() => assertPlainFile(link, 'archive tool')).toThrow(/plain regular file/)
    expect(assertSystemTool(link, 'archive tool')).toBe(link)
    expect(() => assertPlainFile(join(root, 'missing'), 'archive tool')).toThrow(/missing/)
    expect(() => assertSystemTool(join(root, 'missing'), 'archive tool')).toThrow(/missing/)
  })

  it('keeps both staging entrypoints on the shared adapter boundary', () => {
    const repo = join(import.meta.dirname, '..')
    const nativeStage = readFileSync(join(repo, 'scripts', 'stage-native-runtime.mjs'), 'utf8')
    const runtimeStage = readFileSync(join(repo, 'scripts', 'stage-runtime.mjs'), 'utf8')
    expect(nativeStage).toContain('archiveListCommand(adapter, archive)')
    expect(nativeStage).toContain('archiveExtractCommand(adapter, archive, extractParent)')
    expect(nativeStage).not.toContain("execFileSync('/usr/bin/tar'")
    expect(runtimeStage).toContain('resolveNodeDistributionPaths(nodeRoot, adapter)')
    expect(runtimeStage).not.toContain("join(nodeRoot, 'bin', 'node')")
  })
})
