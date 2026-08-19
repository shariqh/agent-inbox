export interface LinuxAppImageInputs {
  schema: 1
  target: 'linux-x64'
  artifactArchitecture: 'x86_64'
  compression: 'zstd'
  linuxInputs: { path: string; sha256: string }
  tool: {
    name: 'appimagetool'
    version: string
    sourceCommit: string
    url: string
    size: number
    sha256: string
  }
  runtime: {
    name: 'type2-runtime'
    version: string
    sourceCommit: string
    url: string
    size: number
    sha256: string
  }
  layout: {
    appRun: 'AppRun'
    applicationPath: 'usr/lib/agent-inbox'
    desktopFile: 'agent-inbox.desktop'
    iconFile: 'agent-inbox.png'
  }
  icon: { path: string; sha256: string }
  desktop: {
    type: 'Application'
    name: 'Agent Inbox'
    comment: string
    exec: 'agent-inbox'
    icon: 'agent-inbox'
    categories: ['Utility', 'Development']
    terminal: false
  }
}

export const DEFAULT_LINUX_APPIMAGE_INPUTS: string
export function validateLinuxAppImageInputs(value: unknown): LinuxAppImageInputs
export function loadLinuxAppImageInputs(path?: string): LinuxAppImageInputs
export function sha256File(path: string): string
export function verifyPinnedAppImageTool(
  path: string,
  expected: LinuxAppImageInputs['tool'],
): string
export function verifyPinnedAppImageRuntime(
  path: string,
  expected: LinuxAppImageInputs['runtime'],
): string
export function acquirePinnedAppImageTool(options: {
  destination: string
  expected: LinuxAppImageInputs['tool']
  fetchImpl?: typeof fetch
}): Promise<string>
export function acquirePinnedAppImageRuntime(options: {
  destination: string
  expected: LinuxAppImageInputs['runtime']
  fetchImpl?: typeof fetch
}): Promise<string>
