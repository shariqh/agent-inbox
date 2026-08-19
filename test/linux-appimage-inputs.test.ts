import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LINUX_APPIMAGE_INPUTS,
  loadLinuxAppImageInputs,
  sha256File,
  validateLinuxAppImageInputs,
  verifyPinnedAppImageTool,
} from '../scripts/linux-appimage-inputs.mjs'

describe('Linux x64 AppImage inputs', () => {
  it('pins the exact thin profile, tagged packaging tool, icon, and desktop contract', () => {
    const inputs = loadLinuxAppImageInputs()
    expect(inputs).toEqual({
      schema: 1,
      target: 'linux-x64',
      artifactArchitecture: 'x86_64',
      linuxInputs: {
        path: 'release/linux-inputs.json',
        sha256: '5061c8d9bf03e5f2515b2f928405ef0dfb3fd6f984ac3120b1257cbc5e4717c1',
      },
      tool: {
        name: 'appimagetool',
        version: '1.9.1',
        sourceCommit: '8c8c91f762b412a19f4e8d2c4b35afb98f2d7c81',
        url: 'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage',
        size: 15092216,
        sha256: 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0',
      },
      runtime: {
        name: 'type2-runtime',
        version: '20251108',
        sourceCommit: 'dd6cebedcbddde9c82f89b011e8e1d40b6e43868',
        url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64',
        size: 944632,
        sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
      },
      layout: {
        appRun: 'AppRun',
        applicationPath: 'usr/lib/agent-inbox',
        desktopFile: 'agent-inbox.desktop',
        iconFile: 'agent-inbox.png',
      },
      icon: {
        path: 'assets/icon-1024.png',
        sha256: '7d87b311310d69ab600bceba4228af6c06c30085778cf72fe7b41fd04884cc57',
      },
      desktop: {
        type: 'Application',
        name: 'Agent Inbox',
        comment: 'Local, cross-project attention inbox for coding agents',
        exec: 'agent-inbox',
        icon: 'agent-inbox',
        categories: ['Utility', 'Development'],
        terminal: false,
      },
    })
    expect(readFileSync(DEFAULT_LINUX_APPIMAGE_INPUTS, 'utf8')).not.toContain('continuous')
    expect(sha256File(resolve(inputs.linuxInputs.path))).toBe(inputs.linuxInputs.sha256)
    expect(sha256File(resolve(inputs.icon.path))).toBe(inputs.icon.sha256)
  })

  it('rejects extra keys, mutable tool URLs, architecture substitutions, and malformed hashes', () => {
    const extra = { ...structuredClone(loadLinuxAppImageInputs()), surprise: true }
    expect(() => validateLinuxAppImageInputs(extra)).toThrow(/exactly/)

    const mutable = structuredClone(loadLinuxAppImageInputs())
    mutable.tool.url = 'https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage'
    expect(() => validateLinuxAppImageInputs(mutable)).toThrow(/tagged appimagetool release/)

    const mutableRuntime = structuredClone(loadLinuxAppImageInputs())
    mutableRuntime.runtime.url = 'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64'
    expect(() => validateLinuxAppImageInputs(mutableRuntime)).toThrow(/tagged type2 runtime/)

    const wrongArchitecture = structuredClone(loadLinuxAppImageInputs())
    Object.assign(wrongArchitecture, { artifactArchitecture: 'aarch64' })
    expect(() => validateLinuxAppImageInputs(wrongArchitecture)).toThrow(/artifactArchitecture/)

    const malformedHash = structuredClone(loadLinuxAppImageInputs())
    malformedHash.tool.sha256 = 'not-a-digest'
    expect(() => validateLinuxAppImageInputs(malformedHash)).toThrow(/tool\.sha256/)
  })

  it('verifies the pinned tool bytes, size, plain-file identity, and execute bit before use', () => {
    const root = mkdtempSync(join(tmpdir(), 'appimagetool-input-'))
    const tool = join(root, 'appimagetool')
    writeFileSync(tool, 'pinned tool bytes')
    chmodSync(tool, 0o755)
    const expected = {
      ...loadLinuxAppImageInputs().tool,
      size: Buffer.byteLength('pinned tool bytes'),
      sha256: sha256File(tool),
    }
    expect(verifyPinnedAppImageTool(tool, expected)).toBe(tool)

    writeFileSync(tool, 'substituted bytes')
    expect(() => verifyPinnedAppImageTool(tool, expected)).toThrow(/size|SHA-256/)
  })
})
