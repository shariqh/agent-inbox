// scripts/macos-release-kind.mjs — what a release's macOS package is, measured rather
// than labelled (#341; update manifest v2 design §7.1).
//
// The release gates run `lipo -archs` on the app copied out of the final DMG: its main
// executable and its better-sqlite3 addon. Both sets must equal each other and the
// committed expected set, `macosArchitectures` in release/macos-inputs.json, and the kind
// they give decides everything below: the DMG name, the labels, whether the native Intel
// gate must have passed and how the release's v1 update manifest is made. The release
// gates, aggregation and the trusted signer all use this table (the publish job, which has
// no checkout, carries a copy of its two rows), so changing the expected set is the only
// way to change a release's kind.

const KINDS = Object.freeze([
  Object.freeze({
    kind: 'universal',
    architectures: Object.freeze(['arm64', 'x86_64']),
    dmgName: (tag) => `Agent-Inbox-${tag}-universal.dmg`,
    architecture: 'universal',
    target: 'darwin-arm64+darwin-x64',
    // Only a universal app runs on an Intel Mac, so only it needs the Intel gate's pass.
    needsNativeIntel: true,
    // The v1 manifest describes this release itself: its v2 manifest with schema 1 (#343).
    v1Manifest: 'projection',
  }),
  Object.freeze({
    kind: 'arm64',
    architectures: Object.freeze(['arm64']),
    dmgName: (tag) => `Agent-Inbox-${tag}-arm64.dmg`,
    architecture: 'arm64',
    target: 'darwin-arm64',
    needsNativeIntel: false,
    // update-manifest.json can name only a universal DMG, so the v1 manifest re-stamps the
    // newest universal release's instead (#343).
    v1Manifest: 'restamp',
  }),
])

const TAG_RE = /^v\d+\.\d+\.\d+$/

export class MacosReleaseKindError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MacosReleaseKindError'
  }
}

function fail(message) {
  throw new MacosReleaseKindError(message)
}

function show(value) {
  return value === undefined ? 'nothing' : JSON.stringify(value)
}

/**
 * The kind an exact, sorted set of CPU types gives: ["arm64", "x86_64"] is universal and
 * ["arm64"] is arm64. Any other set, ["x86_64"] alone included, fails the release.
 */
export function macosKindOf(architectures, label = 'macOS CPU types') {
  const entry = Array.isArray(architectures)
    ? KINDS.find(({ architectures: set }) => (
      set.length === architectures.length && set.every((arch, index) => architectures[index] === arch)
    ))
    : undefined
  if (!entry) {
    fail(`${label} ${show(architectures)} give no macOS release kind: only ["arm64","x86_64"] (universal) or ["arm64"] (arm64)`)
  }
  return entry.kind
}

/**
 * The kind of a shipped app, from the sorted `lipo -archs` sets of its main executable and
 * its better-sqlite3 addon. Both must equal each other and the expected set.
 */
export function measuredMacosKind({ expected, executable, betterSqlite3 }) {
  const kind = macosKindOf(expected, 'the expected CPU types (macosArchitectures)')
  const executableKind = macosKindOf(executable, "the app executable's CPU types")
  if (macosKindOf(betterSqlite3, "the better-sqlite3 addon's CPU types") !== executableKind) {
    fail(`the app executable's CPU types ${show(executable)} differ from the better-sqlite3 addon's ${show(betterSqlite3)}`)
  }
  if (executableKind !== kind) {
    fail(`the shipped app's CPU types ${show(executable)} differ from the expected ${show(expected)} in release/macos-inputs.json`)
  }
  return kind
}

/** The DMG name, labels and rules a release of this kind and tag carries. */
export function macosRelease({ kind, tag }) {
  const entry = KINDS.find((candidate) => candidate.kind === kind)
  if (!entry) fail(`${show(kind)} is not a macOS release kind`)
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) fail(`${show(tag)} is not an exact vX.Y.Z release tag`)
  return Object.freeze({
    kind: entry.kind,
    dmgName: entry.dmgName(tag),
    architecture: entry.architecture,
    target: entry.target,
    needsNativeIntel: entry.needsNativeIntel,
    v1Manifest: entry.v1Manifest,
  })
}
