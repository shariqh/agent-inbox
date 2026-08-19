export class LinuxAppImageVerificationError extends Error {}
export function verifyLinuxX64AppImage(options: {
  appImage: string
  packageVersion: string
  sourceCommit: string
  inputsPath?: string
  appImageInputsPath?: string
  checksum?: string
}): Record<string, unknown> & { appImageSha256: string }
