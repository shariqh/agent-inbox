#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  ReleaseInputError,
  requireExactKeys,
  requireString,
} from './release-inputs.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA256_RE = /^[0-9a-f]{64}$/
const IMAGE_DIGEST_RE = /^ubuntu@sha256:[0-9a-f]{64}$/
export const DEFAULT_LINUX_DEB_INPUTS = resolve(REPO_ROOT, 'release', 'linux-deb.json')

const DEPENDENCIES = Object.freeze([
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
])

const TARGET_PROFILES = Object.freeze({
  'linux-x64': Object.freeze({
    target: 'linux-x64',
    processArch: 'x64',
    debArchitecture: 'amd64',
    containerPlatform: 'linux/amd64',
    image: 'ubuntu@sha256:79676deb51ebb02885b0b9d33788e78a37cf1045ad79d1bb04c6a222c3556b3d',
  }),
  'linux-arm64': Object.freeze({
    target: 'linux-arm64',
    processArch: 'arm64',
    debArchitecture: 'arm64',
    containerPlatform: 'linux/arm64',
    image: 'ubuntu@sha256:8c71efb5d8170edf0965b2ac5e867cc70d3d8f73d1c9c0573d690d6203fc5866',
  }),
})

export function resolveLinuxDebTarget(target) {
  const profile = TARGET_PROFILES[target]
  if (!profile) {
    throw new ReleaseInputError(`target must be linux-x64 or linux-arm64, got ${String(target)}`)
  }
  return profile
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new ReleaseInputError(`${field} is invalid`)
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReleaseInputError(`${field} is invalid`)
  }
}

export function validateLinuxDebInputs(value) {
  requireExactKeys(
    value,
    [
      'schema',
      'package',
      'dpkgDeb',
      'linuxInputs',
      'icon',
      'architectures',
      'layout',
      'desktop',
      'dependencies',
    ],
    'Linux DEB inputs',
  )
  if (value.schema !== 1) {
    throw new ReleaseInputError(`unsupported Linux DEB input schema: ${value.schema}`)
  }

  requireExactKeys(
    value.package,
    [
      'name',
      'maintainer',
      'homepage',
      'section',
      'priority',
      'shortDescription',
      'longDescription',
    ],
    'package',
  )
  const expectedPackage = {
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
  }
  for (const [field, expected] of Object.entries(expectedPackage)) {
    if (value.package[field] !== expected) {
      throw new ReleaseInputError(`package.${field} must be ${expected}`)
    }
  }

  requireExactKeys(value.dpkgDeb, ['version', 'compression', 'level'], 'dpkgDeb')
  if (value.dpkgDeb.version !== '1.21.1') {
    throw new ReleaseInputError(`dpkgDeb.version must be 1.21.1, got ${String(value.dpkgDeb.version)}`)
  }
  if (value.dpkgDeb.compression !== 'xz') {
    throw new ReleaseInputError(`dpkgDeb.compression must be xz, got ${String(value.dpkgDeb.compression)}`)
  }
  if (value.dpkgDeb.level !== 9) {
    throw new ReleaseInputError(`dpkgDeb.level must be 9, got ${String(value.dpkgDeb.level)}`)
  }

  requireExactKeys(value.linuxInputs, ['path', 'sha256'], 'linuxInputs')
  if (value.linuxInputs.path !== 'release/linux-inputs.json') {
    throw new ReleaseInputError('linuxInputs.path must be release/linux-inputs.json')
  }
  requireString(value.linuxInputs.sha256, 'linuxInputs.sha256', SHA256_RE)

  requireExactKeys(value.icon, ['path', 'sha256'], 'icon')
  if (value.icon.path !== 'assets/icon-1024.png') {
    throw new ReleaseInputError('icon.path must be assets/icon-1024.png')
  }
  requireString(value.icon.sha256, 'icon.sha256', SHA256_RE)

  requireExactKeys(value.architectures, Object.keys(TARGET_PROFILES), 'architectures')
  for (const target of Object.keys(TARGET_PROFILES)) {
    const expected = resolveLinuxDebTarget(target)
    const actual = value.architectures[target]
    requireExactKeys(
      actual,
      ['processArch', 'debArchitecture', 'containerPlatform', 'image'],
      `architectures.${target}`,
    )
    if (actual.processArch !== expected.processArch) {
      throw new ReleaseInputError(
        `architectures.${target}.processArch must be ${expected.processArch}`,
      )
    }
    if (actual.debArchitecture !== expected.debArchitecture) {
      throw new ReleaseInputError(
        `architectures.${target}.debArchitecture must be ${expected.debArchitecture}`,
      )
    }
    if (actual.containerPlatform !== expected.containerPlatform) {
      throw new ReleaseInputError(
        `architectures.${target}.containerPlatform must be ${expected.containerPlatform}`,
      )
    }
    requireString(actual.image, `architectures.${target}.image`, IMAGE_DIGEST_RE)
    if (actual.image !== expected.image) {
      throw new ReleaseInputError(
        `architectures.${target}.image must be the exact pinned digest ${expected.image}`,
      )
    }
  }

  requireExactKeys(
    value.layout,
    [
      'binary',
      'applicationDirectory',
      'desktopFile',
      'icon',
      'copyright',
      'electronLicense',
      'chromiumLicenses',
    ],
    'layout',
  )
  const expectedLayout = {
    binary: 'usr/bin/agent-inbox',
    applicationDirectory: 'usr/lib/agent-inbox',
    desktopFile: 'usr/share/applications/agent-inbox.desktop',
    icon: 'usr/share/icons/hicolor/1024x1024/apps/agent-inbox.png',
    copyright: 'usr/share/doc/agent-inbox/copyright',
    electronLicense: 'usr/share/doc/agent-inbox/LICENSE.electron',
    chromiumLicenses: 'usr/share/doc/agent-inbox/LICENSES.chromium.html',
  }
  for (const [field, expected] of Object.entries(expectedLayout)) {
    if (value.layout[field] !== expected) {
      throw new ReleaseInputError(`layout.${field} must be ${expected}`)
    }
  }

  requireExactKeys(
    value.desktop,
    ['type', 'name', 'comment', 'exec', 'icon', 'categories', 'terminal'],
    'desktop',
  )
  const expectedDesktop = {
    type: 'Application',
    name: 'Agent Inbox',
    comment: 'Local, cross-project attention inbox for coding agents',
    exec: 'agent-inbox',
    icon: 'agent-inbox',
  }
  for (const [field, expected] of Object.entries(expectedDesktop)) {
    if (value.desktop[field] !== expected) {
      throw new ReleaseInputError(`desktop.${field} must be ${expected}`)
    }
  }
  if (
    !Array.isArray(value.desktop.categories) ||
    JSON.stringify(value.desktop.categories) !== JSON.stringify(['Utility', 'Development'])
  ) {
    throw new ReleaseInputError('desktop.categories must be exactly Utility, Development')
  }
  requireBoolean(value.desktop.terminal, 'desktop.terminal')
  if (value.desktop.terminal) throw new ReleaseInputError('desktop.terminal must be false')

  if (
    !Array.isArray(value.dependencies) ||
    JSON.stringify(value.dependencies) !== JSON.stringify(DEPENDENCIES)
  ) {
    throw new ReleaseInputError('dependencies must be exactly the pinned, sorted dependency list')
  }

  return value
}

export function loadLinuxDebInputs(path = DEFAULT_LINUX_DEB_INPUTS) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ReleaseInputError(`could not read Linux DEB inputs at ${path}: ${err.message}`)
  }
  return validateLinuxDebInputs(parsed)
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      inputs: { type: 'string' },
    },
  })
  const inputs = loadLinuxDebInputs(values.inputs && resolve(values.inputs))
  requirePositiveInteger(inputs.dpkgDeb.level, 'dpkgDeb.level')
  process.stdout.write(`${JSON.stringify({
    ok: true,
    package: inputs.package.name,
    dpkgDebVersion: inputs.dpkgDeb.version,
    compression: inputs.dpkgDeb.compression,
    level: inputs.dpkgDeb.level,
    architectures: Object.fromEntries(
      Object.entries(inputs.architectures).map(([target, profile]) => [
        target,
        { debArchitecture: profile.debArchitecture, image: profile.image },
      ]),
    ),
    dependencyCount: inputs.dependencies.length,
  })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`linux-deb-inputs: ${err.message}\n`)
    process.exitCode = 1
  }
}
