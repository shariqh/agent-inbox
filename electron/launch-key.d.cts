// Type declarations for electron/launch-key.cjs (issue #412 step 3).
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(bytes: Buffer): string
  getSelectedStorageBackend?(): string
}
export interface Approval {
  item: string
  revision: number
  optionId: string
}
export interface LaunchKeys {
  available(): boolean
  launchKey(launchId: string): Promise<Buffer>
  sign(launchId: string, approval: Approval): Promise<string>
}
export function createLaunchKeys(options: {
  safeStorage: SafeStorageLike
  filePath: string
  platform?: string
  fsImpl?: unknown
  random?: (size: number) => Buffer
}): LaunchKeys
export function deriveLaunchKey(master: Buffer, launchId: string): Buffer
export function signApproval(launchKey: Buffer, approval: Approval): string
