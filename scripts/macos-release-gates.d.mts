import type { MacosRelease, MacosReleaseKind } from './macos-release-kind.mjs'

export class ReleaseGateError extends Error {}

export interface ReleaseContext {
  schema: 1
  tag: string
  version: string
  sourceCommit: string
  taggedAt: string
  annotated: true
}

export function validateReleaseTag(options: {
  repoRoot: string
  ref: string
  sha: string
}): ReleaseContext

export function validateReleaseContext(value: unknown): ReleaseContext

export function validateProtectedRelease(options: {
  repoRoot: string
  context: ReleaseContext
  trustedSha: string
  runHeadSha: string
}): ReleaseContext & {
  trustedSha: string
  runHeadSha: string
  firstParent: true
}

export function validateCredentialEnvironment(
  env: Record<string, string | undefined>,
  scope: 'signing' | 'notary',
): Record<string, string>

export function validateSigningIdentity(options: {
  identity: string
  teamId: string
}): {
  schema: 1
  identity: string
  teamId: string
}

export function parseNotaryReceipt(options: {
  kind: 'app' | 'dmg'
  submitted: string
  submitJson: string
  logJson: string
}): Record<string, unknown>

/** The sorted `lipo -archs` sets of the transported app and the kind they give (#341). */
export interface TransportedAppArchitectures {
  architectures: { executable: string[]; betterSqlite3: string[] }
  kind: MacosReleaseKind
}

export function transportedAppArchitectures(options: {
  executable: string
  betterSqlite3: string
  expected: readonly string[]
}): TransportedAppArchitectures

export function buildFinalReleaseEvidence(options: {
  context: ReleaseContext
  appReceipt: Record<string, unknown>
  dmgReceipt: Record<string, unknown>
  transportEvidence: Record<string, unknown>
  /** The native Intel gate's record; a universal release requires its pass. */
  intelEvidence?: Record<string, unknown>
  finalDmg: string
  identity: string
  teamId: string
  /** Defaults to `macosArchitectures` in release/macos-inputs.json. */
  expected?: readonly string[]
}): Record<string, any>

export function withMountedDmg<T>(options: {
  dmg: string
  mount: string
  runCommand: (path: string, args: string[], options?: { timeout?: number }) => unknown
  verify: () => Promise<T> | T
}): Promise<T>

export function buildThinHandoff(options: {
  arm64Archive: string
  x64Archive: string
  arm64App: string
  x64App: string
  arm64Report: string
  x64Report: string
  context: ReleaseContext
}): Promise<Record<string, any>>

export function validateThinHandoff(options: {
  arm64Archive: string
  x64Archive: string
  evidencePath: string
  context: ReleaseContext
}): Record<string, any>

export function validatePublicationInputs(options: {
  assetsDir: string
  evidencePath: string
  context: ReleaseContext
  /** Defaults to `macosArchitectures` in release/macos-inputs.json. */
  expected?: readonly string[]
}): {
  dmg: string
  checksums: string
  tag: string
  version: string
  macos: MacosRelease & { architectures: TransportedAppArchitectures['architectures'] }
}

export function validateRemoteDraft(options: {
  remotePath: string
  tag: string
  /** Defaults to `macosArchitectures` in release/macos-inputs.json. */
  expected?: readonly string[]
}): Record<string, any>
