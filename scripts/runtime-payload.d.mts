export type RuntimeManifest = {
  schema: number
  product: string
  packageVersion: string
  sourceCommit: string | null
  platform: string
  arch: string
  nodeVersion: string
  nodeModulesAbi: string
  entrypoints: string[]
  files: Array<{ path: string; size: number; mode: number; sha256: string }>
  payloadDigest: string
  runtimeId: string
}
export function buildManifest(options: {
  root: string
  product: string
  packageVersion: string
  sourceCommit?: string
  platform: string
  arch: string
  nodeVersion: string
  nodeModulesAbi: string
  entrypoints: string[]
  manifestFileName?: string
}): RuntimeManifest
export function writeManifestFile(
  root: string,
  manifest: RuntimeManifest,
  manifestFileName?: string,
): void
export function copyTreePreservingMode(
  sourceRoot: string,
  destinationRoot: string,
  options?: { allowExistingEmpty?: boolean },
): string[]
export function verifyPayload(options: {
  root: string
  manifestFileName?: string
  expect?: Partial<RuntimeManifest>
}): RuntimeManifest
