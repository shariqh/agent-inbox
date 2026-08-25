export type WindowsArch = 'x64'
export class WindowsBinaryGateError extends Error {}
export function readPeArchitecture(path: string, label?: string): WindowsArch
export function listPlainWindowsBinaryFiles(root: string): Array<{
  path: string
  relativePath: string
}>
export function assertPeTreeCompatibility(options: {
  root: string
  arch: WindowsArch
}): Array<{
  path: string
  arch: WindowsArch
  format: 'PE32+'
}>
export function assertProcessIdentity<T extends Record<string, unknown>>(options: {
  actual: T
  expected: Partial<T>
  label: string
}): T
