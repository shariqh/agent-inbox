export class PackagedUpdateTrustError extends Error {}

export function verifyPackagedUpdateTrust(appResources: string): {
  signingKeyId: string
  trustedKeyIds: string[]
}
