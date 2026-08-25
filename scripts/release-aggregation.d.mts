export class ReleaseAggregationError extends Error {}

export type ReleaseContext = {
  schema: 1
  tag: string
  version: string
  sourceCommit: string
  taggedAt: string
  annotated: true
}

export type ReleaseAssetEvidence = {
  name: string
  packageType: string
  platform: string
  architecture: string
  target: string
  size: number
  sha256: string
  reportSha256: string
  verificationReportSha256: string
  inputManifestSha256: string
}

export type LinuxReleaseEvidence = {
  schema: 1
  product: 'Agent Inbox'
  tag: string
  packageVersion: string
  sourceCommit: string
  sourceTree: string
  annotatedTag: true
  publishable: true
  manifests: Record<string, string>
  assets: ReleaseAssetEvidence[]
  verification: Record<string, 'passed'>
}

export function validateLinuxReleaseArtifacts(options: {
  artifactsRoot: string
  context: ReleaseContext
  repoRoot: string
  sourceTree: string
}): LinuxReleaseEvidence

export function validateDryRunReleaseArtifacts(options: {
  artifactsRoot: string
  macArtifactsRoot: string
  context: {
    schema: 1
    tag: null
    version: string
    sourceCommit: string
    annotated: false
  }
  repoRoot: string
  sourceTree: string
}): {
  schema: 1
  product: 'Agent Inbox'
  tag: null
  packageVersion: string
  sourceCommit: string
  sourceTree: string
  annotatedTag: false
  publishable: false
  manifests: Record<string, string>
  assets: Array<Record<string, unknown>>
  expectedPublicInventory: string[]
  verification: Record<string, string>
}

export function aggregateReleaseAssets(options: {
  artifactsRoot: string
  macAssetsDir: string
  macEvidencePath: string
  context: ReleaseContext
  repoRoot: string
  sourceTree: string
  outputDir: string
}): {
  assetNames: string[]
  assetsDir: string
  evidencePath: string
}
