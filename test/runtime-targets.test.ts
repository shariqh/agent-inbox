import { describe, expect, it } from 'vitest'
import {
  MACOS_RUNTIME_KEYS,
  RUNTIME_TARGETS,
  nodeDistributionIdentity,
  targetFor,
} from '../scripts/runtime-targets.mjs'

describe('portable runtime target contract', () => {
  it('keeps platform keys aligned with process/runtime/npm tokens', () => {
    expect(RUNTIME_TARGETS).toEqual({
      'darwin-arm64': {
        key: 'darwin-arm64',
        platform: 'darwin',
        arch: 'arm64',
        nodeDistPlatform: 'darwin',
        format: 'tar.xz',
        nodeExecRelPath: 'bin/node',
        npmCliRelPath: 'lib/node_modules/npm/bin/npm-cli.js',
      },
      'darwin-x64': {
        key: 'darwin-x64',
        platform: 'darwin',
        arch: 'x64',
        nodeDistPlatform: 'darwin',
        format: 'tar.xz',
        nodeExecRelPath: 'bin/node',
        npmCliRelPath: 'lib/node_modules/npm/bin/npm-cli.js',
      },
      'linux-arm64': {
        key: 'linux-arm64',
        platform: 'linux',
        arch: 'arm64',
        nodeDistPlatform: 'linux',
        format: 'tar.xz',
        nodeExecRelPath: 'bin/node',
        npmCliRelPath: 'lib/node_modules/npm/bin/npm-cli.js',
      },
      'linux-x64': {
        key: 'linux-x64',
        platform: 'linux',
        arch: 'x64',
        nodeDistPlatform: 'linux',
        format: 'tar.xz',
        nodeExecRelPath: 'bin/node',
        npmCliRelPath: 'lib/node_modules/npm/bin/npm-cli.js',
      },
      'win32-x64': {
        key: 'win32-x64',
        platform: 'win32',
        arch: 'x64',
        nodeDistPlatform: 'win',
        format: 'zip',
        nodeExecRelPath: 'node.exe',
        npmCliRelPath: 'node_modules/npm/bin/npm-cli.js',
      },
    })

    for (const [key, target] of Object.entries(RUNTIME_TARGETS)) {
      expect(key).toBe(`${target.platform}-${target.arch}`)
      expect(target.key).toBe(key)
    }

    expect(targetFor('win32-x64')).toMatchObject({
      platform: 'win32',
      nodeDistPlatform: 'win',
      arch: 'x64',
    })
  })

  it('derives official Node artifacts from explicit distribution facts', () => {
    expect(nodeDistributionIdentity('v24.19.0', 'darwin-arm64')).toEqual({
      archive: 'node-v24.19.0-darwin-arm64.tar.xz',
      root: 'node-v24.19.0-darwin-arm64',
      url: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.xz',
    })
    expect(nodeDistributionIdentity('v24.19.0', 'linux-x64')).toEqual({
      archive: 'node-v24.19.0-linux-x64.tar.xz',
      root: 'node-v24.19.0-linux-x64',
      url: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz',
    })
    expect(nodeDistributionIdentity('v24.19.0', 'win32-x64')).toEqual({
      archive: 'node-v24.19.0-win-x64.zip',
      root: 'node-v24.19.0-win-x64',
      url: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip',
    })
  })

  it('pins exact POSIX and Windows executable layouts', () => {
    for (const key of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      expect(targetFor(key)).toMatchObject({
        format: 'tar.xz',
        nodeExecRelPath: 'bin/node',
        npmCliRelPath: 'lib/node_modules/npm/bin/npm-cli.js',
      })
    }
    expect(targetFor('win32-x64')).toMatchObject({
      format: 'zip',
      nodeExecRelPath: 'node.exe',
      npmCliRelPath: 'node_modules/npm/bin/npm-cli.js',
    })
  })

  it('exposes a deeply frozen table and exact macOS release profile', () => {
    expect(Object.isFrozen(RUNTIME_TARGETS)).toBe(true)
    for (const target of Object.values(RUNTIME_TARGETS)) {
      expect(Object.isFrozen(target)).toBe(true)
    }
    expect(Object.isFrozen(MACOS_RUNTIME_KEYS)).toBe(true)
    expect(MACOS_RUNTIME_KEYS).toEqual(['darwin-arm64', 'darwin-x64'])
  })

  it('returns a descriptor or throws for an unknown target', () => {
    expect(targetFor('linux-arm64')).toBe(RUNTIME_TARGETS['linux-arm64'])
    expect(() => targetFor('win32-arm64')).toThrow(/unknown runtime target: win32-arm64/)
  })
})
