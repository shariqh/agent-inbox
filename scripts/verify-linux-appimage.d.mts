export class LinuxAppImageVerificationError extends Error {}
export function assertPinnedUnsquashfsVersion(result: {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}): void
export function verifySquashfsDirectoryModes(listing: string): number
export function verifyNormalizedRuntimePrefix(
  path: string,
  runtime: { size: number; sha256: string },
): {
  rawSha256: string
  normalizedSha256: string
  embeddedDigestMd5: string
  digestSection: { offset: number; size: number }
}
interface LinuxAppImageVerifyOptions {
  appImage: string
  packageVersion: string
  sourceCommit: string
  inputsPath?: string
  appImageInputsPath?: string
  checksum?: string
}
export function verifyLinuxAppImage(options: LinuxAppImageVerifyOptions & {
  arch?: 'x64' | 'arm64'
}): Record<string, unknown> & { appImageSha256: string }
export function verifyLinuxX64AppImage(
  options: LinuxAppImageVerifyOptions,
): Record<string, unknown> & { appImageSha256: string }
export function verifyLinuxArm64AppImage(
  options: LinuxAppImageVerifyOptions,
): Record<string, unknown> & { appImageSha256: string }
