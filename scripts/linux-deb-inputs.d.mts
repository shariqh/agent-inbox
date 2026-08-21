export interface LinuxDebArchitectureProfile {
  processArch: 'x64' | 'arm64'
  debArchitecture: 'amd64' | 'arm64'
  containerPlatform: 'linux/amd64' | 'linux/arm64'
  image: string
}

export interface LinuxDebInputs {
  schema: 1
  package: {
    name: 'agent-inbox'
    maintainer: 'Shariq Hirani <shariqh@users.noreply.github.com>'
    homepage: 'https://github.com/shariqh/agent-inbox'
    section: 'utils'
    priority: 'optional'
    shortDescription: string
    longDescription: string
  }
  dpkgDeb: {
    version: '1.21.1'
    compression: 'xz'
    level: 9
  }
  linuxInputs: { path: string; sha256: string }
  icon: { path: string; sha256: string }
  architectures: {
    'linux-x64': LinuxDebArchitectureProfile
    'linux-arm64': LinuxDebArchitectureProfile
  }
  layout: {
    binary: 'usr/bin/agent-inbox'
    applicationDirectory: 'usr/lib/agent-inbox'
    desktopFile: 'usr/share/applications/agent-inbox.desktop'
    icon: 'usr/share/icons/hicolor/1024x1024/apps/agent-inbox.png'
    copyright: 'usr/share/doc/agent-inbox/copyright'
    electronLicense: 'usr/share/doc/agent-inbox/LICENSE.electron'
    chromiumLicenses: 'usr/share/doc/agent-inbox/LICENSES.chromium.html'
  }
  desktop: {
    type: 'Application'
    name: 'Agent Inbox'
    comment: string
    exec: 'agent-inbox'
    icon: 'agent-inbox'
    categories: ['Utility', 'Development']
    terminal: false
  }
  dependencies: string[]
}

export const DEFAULT_LINUX_DEB_INPUTS: string
export function resolveLinuxDebTarget(target: unknown): {
  target: 'linux-x64' | 'linux-arm64'
} & LinuxDebArchitectureProfile
export function validateLinuxDebInputs(value: unknown): LinuxDebInputs
export function loadLinuxDebInputs(path?: string): LinuxDebInputs
export function sha256File(path: string): string
