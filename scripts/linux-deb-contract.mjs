import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLinuxDebTarget } from './linux-deb-inputs.mjs'
import { renderLinuxDesktopEntry } from './linux-package-common.mjs'

const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+$/

export class LinuxDebContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxDebContractError'
  }
}

export function debArtifactName(packageVersion, arch = 'x64') {
  if (!PACKAGE_VERSION_RE.test(packageVersion)) {
    throw new LinuxDebContractError(`invalid package version for DEB: ${String(packageVersion)}`)
  }
  const profile = resolveLinuxDebTarget(`linux-${arch}`)
  return `agent-inbox_${packageVersion}_${profile.debArchitecture}.deb`
}

export function renderDebLauncher(inputs) {
  return [
    '#!/bin/sh',
    'set -eu',
    `exec "/${inputs.layout.applicationDirectory}/Agent Inbox" "$@"`,
    '',
  ].join('\n')
}

export function renderDebDesktopEntry(inputs) {
  return renderLinuxDesktopEntry(inputs.desktop)
}

export function renderDebControl(inputs, profile, packageVersion, installedSize) {
  debArtifactName(packageVersion, profile.processArch)
  if (!Number.isSafeInteger(installedSize) || installedSize <= 0) {
    throw new LinuxDebContractError(`invalid Installed-Size: ${String(installedSize)}`)
  }
  return [
    `Package: ${inputs.package.name}`,
    `Version: ${packageVersion}`,
    `Section: ${inputs.package.section}`,
    `Priority: ${inputs.package.priority}`,
    `Architecture: ${profile.debArchitecture}`,
    `Maintainer: ${inputs.package.maintainer}`,
    `Installed-Size: ${installedSize}`,
    `Depends: ${inputs.dependencies.join(', ')}`,
    `Homepage: ${inputs.package.homepage}`,
    `Description: ${inputs.package.shortDescription}`,
    ` ${inputs.package.longDescription}`,
    '',
  ].join('\n')
}

export function installedSizeKiB(root) {
  let bytes = 0
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) bytes += stat.size
      else if (!stat.isSymbolicLink()) {
        throw new LinuxDebContractError(`package tree has unsupported entry: ${path}`)
      }
    }
  }
  visit(root)
  return Math.max(1, Math.ceil(bytes / 1024))
}

export function assertPinnedDpkgDeb(profile, inputs, run = execFileSync) {
  let output
  try {
    output = String(run('/usr/bin/dpkg-deb', ['--version'], {
      encoding: 'utf8',
      env: { LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }))
  } catch (err) {
    throw new LinuxDebContractError(`could not run pinned dpkg-deb: ${err.message}`)
  }
  const firstLine = output.split('\n')[0]
  const expected =
    `Debian 'dpkg-deb' package archive backend version ${inputs.dpkgDeb.version} ` +
    `(${profile.debArchitecture}).`
  if (firstLine !== expected) {
    throw new LinuxDebContractError(`dpkg-deb version mismatch: expected ${expected}, got ${firstLine}`)
  }
  return firstLine
}
