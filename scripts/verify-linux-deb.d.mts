interface LinuxDebVerifyOptions {
  deb: string
  app?: string
  packageVersion: string
  sourceCommit: string
  sourceDateEpoch?: number
  inputsPath?: string
  debInputsPath?: string
  checksum?: string
}
export class LinuxDebVerificationError extends Error {}
export function verifyDataEntries(options: {
  entries: Array<Record<string, unknown>>
  headers: Array<Record<string, unknown>>
  inputs: import('./linux-deb-inputs.mjs').LinuxDebInputs
  sourceDateEpoch: number
}): Map<string, Record<string, unknown>>
export function verifyLinuxDeb(options: LinuxDebVerifyOptions & {
  arch?: 'x64' | 'arm64'
}): Record<string, unknown> & {
  debSha256: string
  innerAppTreeDigest: string
}
export function verifyLinuxX64Deb(options: LinuxDebVerifyOptions): ReturnType<typeof verifyLinuxDeb>
export function verifyLinuxArm64Deb(options: LinuxDebVerifyOptions): ReturnType<typeof verifyLinuxDeb>
