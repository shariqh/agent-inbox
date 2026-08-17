export function assertRuntimeSourceCommit(manifest, expectedCommit, label) {
  if (!/^[0-9a-f]{40}$/.test(manifest?.sourceCommit ?? '')) {
    throw new Error(`${label} runtime manifest has no valid source commit`)
  }
  if (manifest.sourceCommit !== expectedCommit) {
    throw new Error(
      `${label} runtime source commit mismatch: expected ${expectedCommit}, found ${manifest.sourceCommit}`,
    )
  }
  return manifest
}
