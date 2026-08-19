export class LinuxAppImageVerificationError extends Error {}
export function verifyNormalizedRuntimePrefix(
  path: string,
  runtime: { size: number; sha256: string },
): {
  rawSha256: string
  normalizedSha256: string
  embeddedDigestMd5: string
  digestSection: { offset: number; size: number }
}
export function verifyLinuxX64AppImage(options: {
  appImage: string
  packageVersion: string
  sourceCommit: string
  inputsPath?: string
  appImageInputsPath?: string
  checksum?: string
}): Record<string, unknown> & { appImageSha256: string }
