import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LINUX_DEB_INPUTS,
  loadLinuxDebInputs,
  resolveLinuxDebTarget,
  sha256File,
  validateLinuxDebInputs,
} from '../scripts/linux-deb-inputs.mjs'

const DEPENDENCIES = [
  'ca-certificates',
  'libasound2',
  'libatk-bridge2.0-0',
  'libatk1.0-0',
  'libatspi2.0-0',
  'libc6 (>= 2.34)',
  'libcairo2',
  'libcups2',
  'libdbus-1-3',
  'libdrm2',
  'libexpat1',
  'libgbm1',
  'libglib2.0-0',
  'libgtk-3-0',
  'libnspr4',
  'libnss3',
  'libpango-1.0-0',
  'libstdc++6 (>= 11)',
  'libuuid1',
  'libx11-6',
  'libxcb1',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxkbcommon0',
  'libxrandr2',
  'libxss1',
  'xdg-utils',
]

describe('Linux DEB inputs', () => {
  it('pins the exact shared package metadata, tool, digests, layout, desktop, and dependency contract', () => {
    const inputs = loadLinuxDebInputs()
    expect(inputs).toEqual({
      schema: 1,
      package: {
        name: 'agent-inbox',
        maintainer: 'Shariq Hirani <shariqh@users.noreply.github.com>',
        homepage: 'https://github.com/shariqh/agent-inbox',
        section: 'utils',
        priority: 'optional',
        shortDescription: 'Local, cross-project attention inbox for coding agents',
        longDescription:
          'Agent Inbox is a local command center for questions, plans, and live status from ' +
          'coding agents. It gives GitHub Copilot CLI and Claude Code one shared place to surface ' +
          'decisions, handoffs, notes, milestones, and multi-step plans, backed by a single local ' +
          'SQLite database with no model calls, hosted service, or telemetry.',
      },
      dpkgDeb: {
        version: '1.21.1',
        compression: 'xz',
        level: 9,
      },
      linuxInputs: {
        path: 'release/linux-inputs.json',
        sha256: '5061c8d9bf03e5f2515b2f928405ef0dfb3fd6f984ac3120b1257cbc5e4717c1',
      },
      icon: {
        path: 'assets/icon-1024.png',
        sha256: '7d87b311310d69ab600bceba4228af6c06c30085778cf72fe7b41fd04884cc57',
      },
      architectures: {
        'linux-x64': {
          processArch: 'x64',
          debArchitecture: 'amd64',
          containerPlatform: 'linux/amd64',
          image: 'ubuntu@sha256:79676deb51ebb02885b0b9d33788e78a37cf1045ad79d1bb04c6a222c3556b3d',
        },
        'linux-arm64': {
          processArch: 'arm64',
          debArchitecture: 'arm64',
          containerPlatform: 'linux/arm64',
          image: 'ubuntu@sha256:8c71efb5d8170edf0965b2ac5e867cc70d3d8f73d1c9c0573d690d6203fc5866',
        },
      },
      layout: {
        binary: 'usr/bin/agent-inbox',
        applicationDirectory: 'usr/lib/agent-inbox',
        desktopFile: 'usr/share/applications/agent-inbox.desktop',
        icon: 'usr/share/icons/hicolor/1024x1024/apps/agent-inbox.png',
        copyright: 'usr/share/doc/agent-inbox/copyright',
        electronLicense: 'usr/share/doc/agent-inbox/LICENSE.electron',
        chromiumLicenses: 'usr/share/doc/agent-inbox/LICENSES.chromium.html',
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
      dependencies: DEPENDENCIES,
    })
    expect(sha256File(resolve(inputs.linuxInputs.path))).toBe(inputs.linuxInputs.sha256)
    expect(sha256File(resolve(inputs.icon.path))).toBe(inputs.icon.sha256)
  })

  it('resolves both targets to exact, non-overlapping architecture profiles with no fallback', () => {
    expect(resolveLinuxDebTarget('linux-x64')).toEqual({
      target: 'linux-x64',
      processArch: 'x64',
      debArchitecture: 'amd64',
      containerPlatform: 'linux/amd64',
      image: 'ubuntu@sha256:79676deb51ebb02885b0b9d33788e78a37cf1045ad79d1bb04c6a222c3556b3d',
    })
    expect(resolveLinuxDebTarget('linux-arm64')).toEqual({
      target: 'linux-arm64',
      processArch: 'arm64',
      debArchitecture: 'arm64',
      containerPlatform: 'linux/arm64',
      image: 'ubuntu@sha256:8c71efb5d8170edf0965b2ac5e867cc70d3d8f73d1c9c0573d690d6203fc5866',
    })
    for (const bad of ['linux-x86', 'darwin-arm64', '']) {
      expect(() => resolveLinuxDebTarget(bad)).toThrow(/target must be linux-x64 or linux-arm64/)
    }
    expect(() => resolveLinuxDebTarget(undefined)).toThrow(/target must be linux-x64 or linux-arm64/)
  })

  it('rejects unknown, missing, or malformed fields at every level', () => {
    const extra = { ...structuredClone(loadLinuxDebInputs()), surprise: true }
    expect(() => validateLinuxDebInputs(extra)).toThrow(/exactly/)

    const { dependencies: _droppedDependencies, ...missingTop } = structuredClone(
      loadLinuxDebInputs(),
    )
    expect(() => validateLinuxDebInputs(missingTop)).toThrow(/exactly/)

    const wrongSchema = { ...structuredClone(loadLinuxDebInputs()), schema: 2 }
    expect(() => validateLinuxDebInputs(wrongSchema)).toThrow(/unsupported Linux DEB input schema/)

    const extraPackageKey = structuredClone(loadLinuxDebInputs())
    Object.assign(extraPackageKey.package, { extra: 'nope' })
    expect(() => validateLinuxDebInputs(extraPackageKey)).toThrow(/exactly/)

    const wrongMaintainer = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongMaintainer.package, { maintainer: 'Someone Else <someone@example.com>' })
    expect(() => validateLinuxDebInputs(wrongMaintainer)).toThrow(/package\.maintainer/)

    const wrongHomepage = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongHomepage.package, { homepage: 'https://example.com/agent-inbox' })
    expect(() => validateLinuxDebInputs(wrongHomepage)).toThrow(/package\.homepage/)

    const wrongSection = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongSection.package, { section: 'devel' })
    expect(() => validateLinuxDebInputs(wrongSection)).toThrow(/package\.section/)

    const wrongPriority = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongPriority.package, { priority: 'extra' })
    expect(() => validateLinuxDebInputs(wrongPriority)).toThrow(/package\.priority/)

    const wrongToolVersion = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongToolVersion.dpkgDeb, { version: '1.20.0' })
    expect(() => validateLinuxDebInputs(wrongToolVersion)).toThrow(/dpkgDeb\.version/)

    const wrongCompression = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongCompression.dpkgDeb, { compression: 'gzip' })
    expect(() => validateLinuxDebInputs(wrongCompression)).toThrow(/dpkgDeb\.compression/)

    const wrongLevel = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongLevel.dpkgDeb, { level: 6 })
    expect(() => validateLinuxDebInputs(wrongLevel)).toThrow(/dpkgDeb\.level/)

    const malformedLinuxInputsHash = structuredClone(loadLinuxDebInputs())
    Object.assign(malformedLinuxInputsHash.linuxInputs, { sha256: 'not-a-digest' })
    expect(() => validateLinuxDebInputs(malformedLinuxInputsHash)).toThrow(/linuxInputs\.sha256/)

    const malformedIconHash = structuredClone(loadLinuxDebInputs())
    Object.assign(malformedIconHash.icon, { sha256: 'not-a-digest' })
    expect(() => validateLinuxDebInputs(malformedIconHash)).toThrow(/icon\.sha256/)

    const inputsForMissingArch = structuredClone(loadLinuxDebInputs())
    const { 'linux-arm64': _droppedArch, ...remainingArchitectures } =
      inputsForMissingArch.architectures
    const missingArchitecture = {
      ...inputsForMissingArch,
      architectures: remainingArchitectures,
    }
    expect(() => validateLinuxDebInputs(missingArchitecture)).toThrow(/exactly/)

    const inputsForExtraArch = structuredClone(loadLinuxDebInputs())
    const extraArchitecture = {
      ...inputsForExtraArch,
      architectures: {
        ...inputsForExtraArch.architectures,
        'linux-x86': inputsForExtraArch.architectures['linux-x64'],
      },
    }
    expect(() => validateLinuxDebInputs(extraArchitecture)).toThrow(/exactly/)

    const wrongProcessArch = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongProcessArch.architectures['linux-x64'], { processArch: 'arm64' })
    expect(() => validateLinuxDebInputs(wrongProcessArch)).toThrow(
      /architectures\.linux-x64\.processArch/,
    )

    const swappedDebArchitecture = structuredClone(loadLinuxDebInputs())
    Object.assign(swappedDebArchitecture.architectures['linux-x64'], { debArchitecture: 'arm64' })
    expect(() => validateLinuxDebInputs(swappedDebArchitecture)).toThrow(
      /architectures\.linux-x64\.debArchitecture/,
    )

    const swappedContainerPlatform = structuredClone(loadLinuxDebInputs())
    Object.assign(swappedContainerPlatform.architectures['linux-x64'], {
      containerPlatform: 'linux/arm64',
    })
    expect(() => validateLinuxDebInputs(swappedContainerPlatform)).toThrow(
      /architectures\.linux-x64\.containerPlatform/,
    )

    const swappedImage = structuredClone(loadLinuxDebInputs())
    Object.assign(swappedImage.architectures['linux-x64'], {
      image: swappedImage.architectures['linux-arm64'].image,
    })
    expect(() => validateLinuxDebInputs(swappedImage)).toThrow(
      /architectures\.linux-x64\.image must be the exact pinned digest/,
    )

    const malformedImage = structuredClone(loadLinuxDebInputs())
    Object.assign(malformedImage.architectures['linux-x64'], { image: 'ubuntu:latest' })
    expect(() => validateLinuxDebInputs(malformedImage)).toThrow(
      /architectures\.linux-x64\.image/,
    )

    const wrongLayoutBinary = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongLayoutBinary.layout, { binary: 'usr/bin/agent-inbox-cli' })
    expect(() => validateLinuxDebInputs(wrongLayoutBinary)).toThrow(/layout\.binary/)

    const wrongLayoutIcon = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongLayoutIcon.layout, { icon: 'usr/share/pixmaps/agent-inbox.png' })
    expect(() => validateLinuxDebInputs(wrongLayoutIcon)).toThrow(/layout\.icon/)

    const wrongLayoutLicense = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongLayoutLicense.layout, { electronLicense: 'LICENSE.electron' })
    expect(() => validateLinuxDebInputs(wrongLayoutLicense)).toThrow(/layout\.electronLicense/)

    const extraLayoutKey = structuredClone(loadLinuxDebInputs())
    Object.assign(extraLayoutKey.layout, { extra: 'nope' })
    expect(() => validateLinuxDebInputs(extraLayoutKey)).toThrow(/exactly/)

    const wrongDesktopExec = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongDesktopExec.desktop, { exec: 'agent-inbox-launcher' })
    expect(() => validateLinuxDebInputs(wrongDesktopExec)).toThrow(/desktop\.exec/)

    const wrongCategories = structuredClone(loadLinuxDebInputs())
    Object.assign(wrongCategories.desktop, { categories: ['Development', 'Utility'] })
    expect(() => validateLinuxDebInputs(wrongCategories)).toThrow(/categories/)

    const terminalTrue = structuredClone(loadLinuxDebInputs())
    Object.assign(terminalTrue.desktop, { terminal: true })
    expect(() => validateLinuxDebInputs(terminalTrue)).toThrow(/terminal must be false/)

    const shuffledDependencies = structuredClone(loadLinuxDebInputs())
    shuffledDependencies.dependencies = [...shuffledDependencies.dependencies].reverse()
    expect(() => validateLinuxDebInputs(shuffledDependencies)).toThrow(
      /dependencies must be exactly the pinned, sorted dependency list/,
    )

    const missingDependency = structuredClone(loadLinuxDebInputs())
    missingDependency.dependencies = missingDependency.dependencies.filter(
      (dep) => dep !== 'xdg-utils',
    )
    expect(() => validateLinuxDebInputs(missingDependency)).toThrow(
      /dependencies must be exactly the pinned, sorted dependency list/,
    )

    const extraDependency = structuredClone(loadLinuxDebInputs())
    extraDependency.dependencies = [...extraDependency.dependencies, 'libpulse0']
    expect(() => validateLinuxDebInputs(extraDependency)).toThrow(
      /dependencies must be exactly the pinned, sorted dependency list/,
    )
  })

  it('does not fall back to a default profile when the on-disk file is malformed', () => {
    expect(() => validateLinuxDebInputs(null)).toThrow(/must be an object/)
    expect(() => validateLinuxDebInputs({})).toThrow(/exactly/)
  })

  it('reflects the source-controlled release/linux-deb.json path', () => {
    expect(DEFAULT_LINUX_DEB_INPUTS.endsWith('release/linux-deb.json')).toBe(true)
    expect(() => readFileSync(DEFAULT_LINUX_DEB_INPUTS, 'utf8')).not.toThrow()
  })
})
