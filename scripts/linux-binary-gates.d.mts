export type LinuxArch = 'arm64' | 'x64'
export class LinuxBinaryGateError extends Error {}
export function readElfArchitecture(path: string, label?: string): LinuxArch
export function assertBinaryCompatibility(options: {
  path: string
  label: string
  arch: LinuxArch
  maximumGlibcVersion: string
  maximumLibstdcxxVersion: string
}): {
  arch: LinuxArch
  maximumRequiredGlibc: string | null
  maximumRequiredLibstdcxx: string | null
}
export function assertProcessIdentity<T extends Record<string, unknown>>(options: {
  actual: T
  expected: Partial<T>
  label: string
}): T
