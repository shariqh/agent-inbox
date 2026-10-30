import { spawnSync } from 'node:child_process'
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ORIGINAL_UPDATE_KEY,
  authorizeReleaseHistory,
  bindSigningEvidence,
  checkReleaseManifest,
  deriveV1,
  generateManifest,
  generateManifestV2,
  planReleaseHistory,
  projectV1,
  signManifest,
} from '../scripts/update-manifest.mjs'
import type { ReleaseLike } from '../scripts/update-manifest.d.mts'
import { treeIdentity } from '../scripts/tree-identity.mjs'
import { scratchDir } from './scratch.js'

const root = resolve(process.cwd())
const inputsPath = join(root, '.github', 'workflows', 'macos-release.yml')
const protectedPath = join(root, '.github', 'workflows', 'macos-release-protected.yml')
const sourceCommit = 'a'.repeat(40)
const sourceTree = 'c'.repeat(40)
const TAG = 'v1.2.3'
const VERSION = '1.2.3'
const DAY_MS = 24 * 60 * 60 * 1000
const isoSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
// The sign job signs at the wall clock, so every release here is a recent one.
const taggedAt = isoSeconds(Date.now() - 60 * 60 * 1000)

function extractPublisherScript(workflow: string) {
  const publish = workflow.slice(workflow.indexOf('  publish:'))
  const marker = '        run: |\n'
  const start = publish.indexOf(marker)
  if (start < 0) throw new Error('publisher run block not found')
  return publish.slice(start + marker.length)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n')
}

// From 2.0.0 the macOS app is for Apple silicon only (#296). README and INSTALL may name
// Intel only in this sentence, which sends Intel Macs to 1.x-last (#384).
const INTEL_STAYS = 'Intel Macs stay on [v1.8.0](https://github.com/shariqh/agent-inbox/releases/tag/v1.8.0), '
  + 'the last version for them.'

/**
 * What README or INSTALL says about Macs that the release being built does not do. The
 * tag-time job runs this on the tagged tree, so the rule follows that tree's version: a
 * universal release (through 1.x-last) supports Intel, and from 2.0.0 nothing but the one
 * sentence above may mention it.
 */
function macDocProblems(text: string, version: string): string[] {
  const flat = text.replace(/\s+/g, ' ')
  if (Number(version.split('.')[0]) < 2) {
    return /Apple silicon and Intel/i.test(flat) ? [] : ['does not say the app supports Apple silicon and Intel']
  }
  const parts = flat.split(INTEL_STAYS)
  const rest = parts.join(' ')
  const problems = parts.length === 2 ? [] : [`has the Intel sentence ${parts.length - 1} times, not once`]
  const forbidden: Array<[RegExp, string]> = [
    [/\bIntel\b/i, 'Intel'],
    [/universal/i, 'the universal DMG'],
    [/darwin-x64/i, 'the darwin-x64 runtime'],
    [/Rosetta/i, 'Rosetta'],
  ]
  for (const [pattern, what] of forbidden) if (pattern.test(rest)) problems.push(`mentions ${what}`)
  if (!rest.includes('`Agent-Inbox-vX.Y.Z-arm64.dmg`')) problems.push('does not name the arm64 DMG')
  if (!/Apple silicon/i.test(rest)) problems.push('does not say the app needs Apple silicon')
  return problems
}

/** One step of a job: from its `- ` line to the next step at the same indentation. */
function stepBlock(job: string, name: string) {
  const named = job.indexOf(`name: ${name}\n`)
  if (named < 0) throw new Error(`step not found: ${name}`)
  const start = job.lastIndexOf('\n      - ', named)
  const end = job.indexOf('\n      - ', named)
  return job.slice(start + 1, end < 0 ? undefined : end + 1)
}

/** A step's `run: |` script, unindented. */
function runScript(step: string) {
  const marker = '        run: |\n'
  const start = step.indexOf(marker)
  if (start < 0) throw new Error('run block not found')
  return step.slice(start + marker.length)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n')
}

/** A step's folded `run: >-` command, on one line as YAML folds it. */
function foldedCommand(step: string) {
  const marker = '        run: >-\n'
  const start = step.indexOf(marker)
  if (start < 0) throw new Error('folded run block not found')
  return step.slice(start + marker.length).split('\n').map((line) => line.trim()).filter(Boolean).join(' ')
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

type Kind = 'universal' | 'arm64'
type ScratchKey = ReturnType<typeof makeScratchKey>

function makeScratchKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const keyId = `ed25519-${sha256(Buffer.from(publicKeySpkiBase64, 'base64')).slice(0, 16)}`
  const registry = {
    schema: 1 as const,
    signingKeyId: keyId,
    keys: [{ keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64 }],
  }
  return {
    keyId,
    publicKeySpkiBase64,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    registry,
    registryBytes: Buffer.from(`${JSON.stringify(registry, null, 2)}\n`),
    // What the release jobs pin as the key apps from 1.2 to 1.6 trust, when a test lets
    // this scratch key stand in for it.
    asOriginal: { keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64 },
  }
}

const MACOS = {
  universal: { architecture: 'universal', target: 'darwin-arm64+darwin-x64', sets: ['arm64', 'x86_64'] },
  arm64: { architecture: 'arm64', target: 'darwin-arm64', sets: ['arm64'] },
} as const

/** One release's five packages, as aggregate evidence and as manifest evidence. */
function releasePackages(kind: Kind, version: string) {
  const tag = `v${version}`
  const macos = MACOS[kind]
  const bytes = (name: string) => Buffer.from(`final bytes for ${name}`)
  const measured = (name: string) => ({ size: bytes(name).length, sha256: sha256(bytes(name)) })
  const dmg = `Agent-Inbox-${tag}-${kind}.dmg`
  const assets = [
    { name: `Agent-Inbox-${tag}-linux-arm64.AppImage`, packageType: 'AppImage', platform: 'linux', architecture: 'aarch64', target: 'linux-arm64' },
    { name: `Agent-Inbox-${tag}-linux-x86_64.AppImage`, packageType: 'AppImage', platform: 'linux', architecture: 'x86_64', target: 'linux-x64' },
    { name: `agent-inbox_${version}_amd64.deb`, packageType: 'DEB', platform: 'linux', architecture: 'amd64', target: 'linux-x64' },
    { name: `agent-inbox_${version}_arm64.deb`, packageType: 'DEB', platform: 'linux', architecture: 'arm64', target: 'linux-arm64' },
  ].map((asset) => ({ ...asset, ...measured(asset.name) }) as Record<string, unknown> & { name: string; size: number; sha256: string })
  assets.push({
    name: dmg,
    packageType: 'DMG',
    platform: 'macos',
    architecture: macos.architecture,
    target: macos.target,
    architectures: { executable: [...macos.sets], betterSqlite3: [...macos.sets] },
    ...(kind === 'universal' ? { nativeIntel: 'passed' } : {}),
    ...measured(dmg),
    notarization: { appStatus: 'Accepted', dmgStatus: 'Accepted' },
  })
  assets.sort((left, right) => (left.name < right.name ? -1 : 1))
  const manifestAssets = assets.map((asset) => (asset.platform === 'macos'
    ? { name: asset.name, packageType: 'dmg' as const, platform: 'darwin' as const, architecture: macos.architecture, size: asset.size, sha256: asset.sha256 }
    : {
        name: asset.name,
        packageType: asset.packageType === 'AppImage' ? 'appimage' as const : 'deb' as const,
        platform: 'linux' as const,
        architecture: asset.target === 'linux-x64' ? 'x64' as const : 'arm64' as const,
        size: asset.size,
        sha256: asset.sha256,
      }))
  return { tag, assets, manifestAssets, bytes, dmg }
}

let nextAssetId = 500

/** An earlier release as GitHub lists it, its manifest pairs signed by `key`. */
function priorRelease(
  version: string,
  key: ScratchKey,
  publishedAt: string,
  options: { v1Only?: boolean; v1?: { bytes: Buffer; signature: Buffer } } = {},
) {
  const files = releasePackages('universal', version)
  const evidence = { tag: files.tag, packageVersion: version, sourceCommit: 'd'.repeat(40), sourceTree: 'e'.repeat(40), assets: files.manifestAssets }
  const sign = (bytes: Buffer) => signManifest({ manifestBytes: bytes, registry: key.registry, privateKeyPem: key.privateKeyPem, now: publishedAt }).bytes
  const v2 = generateManifestV2({ registry: key.registry, evidence, minimumMacosVersion: '13.5', publishedAt, kind: 'universal' })
  const v1Bytes = options.v1Only
    ? generateManifest({ registry: key.registry, evidence, minimumMacosVersion: '13.5', publishedAt }).bytes
    : projectV1(v2.bytes).bytes
  const pairs = {
    v1: options.v1 ?? { bytes: v1Bytes, signature: sign(v1Bytes) },
    ...(options.v1Only ? {} : { v2: { bytes: v2.bytes, signature: sign(v2.bytes) } }),
  } as { v1: { bytes: Buffer; signature: Buffer }; v2?: { bytes: Buffer; signature: Buffer } }
  const assetsById = new Map<number, Buffer>()
  const listed = (name: string, bytes: Buffer) => {
    nextAssetId += 1
    assetsById.set(nextAssetId, bytes)
    return {
      id: nextAssetId,
      name,
      size: bytes.length,
      digest: `sha256:${sha256(bytes)}`,
      browser_download_url: `https://github.com/shariqh/agent-inbox/releases/download/${files.tag}/${name}`,
    }
  }
  const listing: ReleaseLike = {
    tag_name: files.tag,
    draft: false,
    prerelease: false,
    assets: [
      ...files.assets.map((asset) => listed(asset.name, files.bytes(asset.name))),
      listed('SHA256SUMS.txt', Buffer.from('sums\n')),
      listed('update-manifest.json', pairs.v1.bytes),
      listed('update-manifest.json.sig', pairs.v1.signature),
      ...(pairs.v2 ? [listed('update-manifest-v2.json', pairs.v2.bytes), listed('update-manifest-v2.json.sig', pairs.v2.signature)] : []),
    ],
  }
  return { tag: files.tag, pairs, listing, assetsById }
}

type PriorRelease = ReturnType<typeof priorRelease>

/** The releases GitHub lists before this one; the last is the release before. */
function releaseHistory(...releases: PriorRelease[]) {
  return {
    listings: releases.map((release) => release.listing),
    before: releases.at(-1) ?? null,
    assetsById: new Map(releases.flatMap((release) => [...release.assetsById])),
  }
}

type History = ReturnType<typeof releaseHistory>

/** The handoff verify-publication passes the signer: seven release files and the evidence. */
function writeUnsignedHandoff(directory: string, kind: Kind, key: ScratchKey) {
  const files = releasePackages(kind, VERSION)
  const assets = join(directory, 'release-assets')
  mkdirSync(assets, { recursive: true })
  for (const asset of files.assets) writeFileSync(join(assets, asset.name), files.bytes(asset.name))
  const packageNames = files.assets.map((asset) => asset.name)
  const checksumText = packageNames.map((name) => `${sha256(files.bytes(name))}  ${name}\n`).join('')
  writeFileSync(join(assets, 'SHA256SUMS.txt'), checksumText)
  const { bytes: manifestBytes } = generateManifestV2({
    registry: key.registry,
    evidence: { tag: TAG, packageVersion: VERSION, sourceCommit, sourceTree, assets: files.manifestAssets },
    minimumMacosVersion: '13.5',
    publishedAt: taggedAt,
    kind,
  })
  writeFileSync(join(assets, 'update-manifest-v2.json'), manifestBytes)
  writeFileSync(join(directory, 'RELEASE_NOTES.md'), 'Notarized release.\n')
  const context = { schema: 1, tag: TAG, version: VERSION, sourceCommit, taggedAt, annotated: true } as const
  writeFileSync(join(directory, 'release-context.json'), `${JSON.stringify(context)}\n`)
  const aggregate = {
    schema: 1,
    product: 'Agent Inbox',
    tag: TAG,
    packageVersion: VERSION,
    sourceCommit,
    sourceTree,
    annotatedTag: true,
    publishable: true,
    assets: files.assets,
    checksumManifest: {
      name: 'SHA256SUMS.txt',
      entries: packageNames,
      sha256: sha256(checksumText),
      size: Buffer.byteLength(checksumText),
    },
    verification: {
      linuxHandoff: 'passed',
      macosNotarization: 'passed',
      exactReleaseAllowlist: 'passed',
      deterministicChecksums: 'passed',
    },
    updateManifest: {
      name: 'update-manifest-v2.json',
      size: manifestBytes.length,
      sha256: sha256(manifestBytes),
      keyRegistrySha256: sha256(key.registryBytes),
    },
  }
  writeFileSync(join(directory, 'release-aggregation-evidence.json'), `${JSON.stringify(aggregate)}\n`)
  return { files, context, aggregate, manifestBytes }
}

type PublishFixture = {
  kind: Kind
  handoff: string
  key: ScratchKey
  history: History
  /** Whether the publish job's pinned original key is swapped for the scratch key. */
  pin: 'scratch' | 'production'
  override: string
}

/**
 * A signed handoff, made in process by the same functions the sign job's subcommands call.
 * With `waive`, the scratch key does not stand in for the original key, so G10 holds only
 * through the recorded override, as in an emergency rotation.
 */
function publishFixture(kind: Kind = 'universal', options: { waive?: boolean; history?: History; key?: ScratchKey } = {}): PublishFixture {
  const key = options.key ?? makeScratchKey()
  const history = options.history ?? (kind === 'universal'
    ? releaseHistory()
    : releaseHistory(priorRelease('1.2.2', key, isoSeconds(Date.now() - 7 * DAY_MS))))
  const handoff = join(scratchDir('release-handoff-'), 'handoff')
  const unsigned = writeUnsignedHandoff(handoff, kind, key)
  const assets = join(handoff, 'release-assets')
  const release = checkReleaseManifest({
    manifestBytes: unsigned.manifestBytes,
    aggregate: unsigned.aggregate,
    context: unsigned.context,
    registryBytes: key.registryBytes,
    macosInputs: { macosArchitectures: [...MACOS[kind].sets], minimumMacosVersion: '13.5' },
    packages: Object.fromEntries(unsigned.files.assets.map((asset) => [asset.name, { size: asset.size, sha256: asset.sha256 }])),
    tag: TAG,
    sourceCommit,
  })
  const plan = planReleaseHistory({ releases: history.listings, newTag: TAG, kind })
  const authorized = (manifest: 'v1' | 'v2') => {
    const pair = history.before?.pairs[manifest]
    const { priorManifest: _prior, ...record } = authorizeReleaseHistory({
      plan: plan[manifest],
      priorManifestBytes: pair?.bytes,
      priorSignatureBytes: pair?.signature,
      registry: key.registry,
      newTag: TAG,
    }) as ReturnType<typeof authorizeReleaseHistory> & { priorManifest?: unknown }
    return record
  }
  const derived = deriveV1({
    release,
    v2ManifestBytes: unsigned.manifestBytes,
    registry: key.registry,
    releases: history.listings,
    ...(kind === 'arm64'
      ? { earlierManifestBytes: history.before!.pairs.v1.bytes, earlierSignatureBytes: history.before!.pairs.v1.signature }
      : {}),
  })
  const sign = (bytes: Buffer) => signManifest({ manifestBytes: bytes, registry: key.registry, privateKeyPem: key.privateKeyPem, now: taggedAt }).bytes
  const v2Signature = sign(unsigned.manifestBytes)
  const v1Signature = sign(derived.bytes)
  writeFileSync(join(assets, 'update-manifest-v2.json.sig'), v2Signature)
  writeFileSync(join(assets, 'update-manifest.json'), derived.bytes)
  writeFileSync(join(assets, 'update-manifest.json.sig'), v1Signature)
  writeFileSync(join(handoff, 'update-keys.json'), key.registryBytes)
  const { bytes: _bytes, manifest: _manifest, ...derivation } = derived as typeof derived & { manifest: unknown }
  const override = `ALLOW-UPDATE-KEY-ROTATION:${TAG}:${key.keyId}`
  const evidence = bindSigningEvidence({
    registryBytes: key.registryBytes,
    aggregate: unsigned.aggregate,
    tag: TAG,
    sourceCommit,
    release: { kind: release.kind, macos: release.macos, manifestSha256: release.manifestSha256 },
    history: { v1: authorized('v1'), v2: authorized('v2') },
    derivation: { ...derivation, sha256: sha256(derived.bytes) },
    v2: { manifestBytes: unsigned.manifestBytes, signatureBytes: v2Signature },
    v1: { manifestBytes: derived.bytes, signatureBytes: v1Signature },
    now: isoSeconds(Date.now()),
    ...(options.waive ? { rotationOverride: override } : { originalKey: key.asOriginal }),
  })
  writeFileSync(join(handoff, 'update-signing-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return { kind, handoff, key, history, pin: options.waive ? 'production' : 'scratch', override }
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const writeJsonFile = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

/** Edits one of the handoff's JSON files in place. */
function patchHandoff(fixture: PublishFixture, file: string, patch: (value: Record<string, any>) => void) {
  const path = join(fixture.handoff, file)
  const value = readJson(path)
  patch(value)
  writeJsonFile(path, value)
}

/**
 * Replaces a manifest with `bytes`, signed by the scratch key, and keeps every record of it
 * consistent, so that only the check under test can refuse it.
 */
function replaceManifest(fixture: PublishFixture, name: 'update-manifest.json' | 'update-manifest-v2.json', bytes: Buffer) {
  const assets = join(fixture.handoff, 'release-assets')
  const signature = Buffer.from(`${JSON.stringify({
    schema: 1,
    manifestSha256: sha256(bytes),
    signatures: [{ algorithm: 'ed25519', keyId: fixture.key.keyId, signature: signBytes(null, bytes, fixture.key.privateKeyPem).toString('base64') }],
  }, null, 2)}\n`)
  writeFileSync(join(assets, name), bytes)
  writeFileSync(join(assets, `${name}.sig`), signature)
  const slot = name === 'update-manifest.json' ? 'v1' : 'v2'
  patchHandoff(fixture, 'update-signing-evidence.json', (evidence) => {
    const record = evidence.manifests[slot]
    Object.assign(record, { size: bytes.length, sha256: sha256(bytes) })
    record.signature = { name: `${name}.sig`, size: signature.length, sha256: sha256(signature) }
  })
  if (slot === 'v2') {
    patchHandoff(fixture, 'release-aggregation-evidence.json', (aggregate) => {
      Object.assign(aggregate.updateManifest, { size: bytes.length, sha256: sha256(bytes) })
    })
  }
}

/** A manifest of the handoff, edited as JSON and serialized as the publisher writes it. */
function editedManifest(fixture: PublishFixture, name: 'update-manifest.json' | 'update-manifest-v2.json', edit: (manifest: Record<string, any>) => void) {
  const manifest = readJson(join(fixture.handoff, 'release-assets', name))
  edit(manifest)
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
}

function runPublisher(
  remoteSource: string,
  remoteDigestMode: 'match' | 'mismatch',
  remoteSourceAfterUpload = remoteSource,
  behavior: {
    existing?: 'absent' | 'public' | 'draft'
    failUpload?: boolean
    failDownload?: boolean
    failDelete?: boolean
    patchTransportFailure?: boolean
    cleanupOwnership?: 'owned' | 'replacement' | 'source-mismatch'
    publicMarkerMismatch?: boolean
    createResponseMismatch?: boolean
    fixture?: PublishFixture
    /** The job's `macos-release` environment variable, as the publish step receives it. */
    rotationOverride?: string
  } = {},
) {
  const temp = scratchDir('release-publisher-')
  const fixture = behavior.fixture ?? publishFixture()
  const handoff = fixture.handoff
  const bin = join(temp, 'bin')
  const log = join(temp, 'gh.log')
  const assetDir = join(temp, 'release-assets-by-id')
  mkdirSync(bin)
  mkdirSync(assetDir)
  for (const [id, bytes] of fixture.history.assetsById) writeFileSync(join(assetDir, String(id)), bytes)
  const releasePages = join(temp, 'release-pages.json')
  writeFileSync(releasePages, `${JSON.stringify([fixture.history.listings])}\n`)
  const workflow = readFileSync(protectedPath, 'utf8')
  let publisher = extractPublisherScript(workflow)
  if (fixture.pin === 'scratch') {
    // The scratch key stands in for the original key, which never signs in tests.
    publisher = publisher
      .replaceAll(ORIGINAL_UPDATE_KEY.keyId, fixture.key.keyId)
      .replaceAll(ORIGINAL_UPDATE_KEY.publicKeySpkiBase64, fixture.key.publicKeySpkiBase64)
  }
  const script = join(temp, 'publish.sh')
  writeFileSync(script, `#!/bin/bash\n${publisher}\n`)
  chmodSync(script, 0o755)
  const patchInput = join(temp, 'final-release-request.json')
  const gh = join(bin, 'gh')
  writeFileSync(gh, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$1 $2" == "run download" ]]; then
  while [[ "$1" != "--dir" ]]; do shift; done
  mkdir -p "$2"
  cp -R "$HANDOFF"/. "$2"/
elif [[ "$1 $2 \${3:-}" == "api --paginate --slurp" && "\${4:-}" == repos/*/releases?per_page=100 ]]; then
  cat "$RELEASE_PAGES"
elif [[ "$1" == api && "$2" == repos/*/releases/assets/* && "$3 $4" == "-H Accept: application/octet-stream" ]]; then
  cat "$ASSET_DIR/\${2##*/}"
elif [[ "$1" == api && "$2" == repos/*/git/ref/tags/* ]]; then
  printf '{"object":{"type":"tag","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}\\n'
elif [[ "$1" == api && "$2" == repos/*/git/tags/* ]]; then
  count=0
  [[ -f "$TAG_CHECK_COUNT_FILE" ]] && count="$(cat "$TAG_CHECK_COUNT_FILE")"
  count=$((count + 1))
  printf '%s\\n' "$count" > "$TAG_CHECK_COUNT_FILE"
  source="$REMOTE_SOURCE"
  [[ "$count" -gt 1 ]] && source="$REMOTE_SOURCE_AFTER_UPLOAD"
  printf '{"object":{"type":"commit","sha":"%s"}}\\n' "$source"
elif [[ "$1 $2" == "api --include" ]]; then
  if [[ "$EXISTING_MODE" == absent ]]; then
    printf 'HTTP/2 404 Not Found\\n'
    exit 1
  fi
  printf 'HTTP/2 200 OK\\n'
elif [[ "$1 $2 \${3:-}" == "api --method POST" && "\${4:-}" == repos/*/releases ]]; then
  while [[ "$1" != "--input" ]]; do shift; done
  REQUEST="$2" OWNED_RELEASE_STATE="$OWNED_RELEASE_STATE" CREATE_RESPONSE_MISMATCH="$CREATE_RESPONSE_MISMATCH" node <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const request = JSON.parse(readFileSync(process.env.REQUEST, 'utf8'))
const release = {
  id: 42,
  tag_name: request.tag_name,
  draft: request.draft,
  prerelease: request.prerelease,
  name: request.name,
  body: request.body,
  assets: [],
}
writeFileSync(process.env.OWNED_RELEASE_STATE, JSON.stringify(release))
const response = { ...release }
if (process.env.CREATE_RESPONSE_MISMATCH === '1') response.name = 'mismatched response title'
process.stdout.write(JSON.stringify(response) + '\\n')
NODE
elif [[ "$1" == api && "$2" == repos/*/releases/42 ]]; then
  if [[ "$CLEANUP_OWNERSHIP" == replacement ]]; then exit 44; fi
  OWNED_RELEASE_STATE="$OWNED_RELEASE_STATE" CLEANUP_OWNERSHIP="$CLEANUP_OWNERSHIP" node <<'NODE'
const { readFileSync } = require('node:fs')
const release = JSON.parse(readFileSync(process.env.OWNED_RELEASE_STATE, 'utf8'))
if (process.env.CLEANUP_OWNERSHIP === 'source-mismatch') {
  const marker = JSON.parse(release.body)
  marker.sourceCommit = 'd'.repeat(40)
  release.body = JSON.stringify(marker)
}
process.stdout.write(JSON.stringify(release) + '\\n')
NODE
elif [[ "$1 $2 \${3:-}" == "api --method PATCH" ]]; then
  while [[ "$1" != "--input" ]]; do shift; done
  cp "$2" "$PATCH_INPUT"
  if [[ "$PATCH_TRANSPORT_FAILURE" == 1 ]]; then
    : > "$PUBLISHED_STATE_FILE"
    exit 12
  fi
  printf '{"tag_name":"v1.2.3","draft":false}\\n'
elif [[ "$1 $2 \${3:-}" == "api --method DELETE" ]]; then
  if [[ "$FAIL_DELETE" == 1 ]]; then exit 11; fi
  exit 0
elif [[ "$1 $2" == "release view" ]]; then
  HANDOFF="$HANDOFF" REMOTE_DIGEST_MODE="$REMOTE_DIGEST_MODE" EXISTING_MODE="$EXISTING_MODE" OWNED_RELEASE_STATE="$OWNED_RELEASE_STATE" PUBLIC_MARKER_MISMATCH="$PUBLIC_MARKER_MISMATCH" node <<'NODE'
const { createHash } = require('node:crypto')
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')
const root = join(process.env.HANDOFF, 'release-assets')
const assets = readdirSync(root).map((name, index) => ({
  name,
  size: statSync(join(root, name)).size,
  digest: process.env.REMOTE_DIGEST_MODE === 'mismatch' && index === 0
    ? \`sha256:\${'0'.repeat(64)}\`
    : \`sha256:\${createHash('sha256').update(readFileSync(join(root, name))).digest('hex')}\`,
}))
const isPublic = process.env.EXISTING_MODE === 'public'
const owned = existsSync(process.env.OWNED_RELEASE_STATE)
  ? JSON.parse(readFileSync(process.env.OWNED_RELEASE_STATE, 'utf8'))
  : null
const publicBody = readFileSync(process.env.FINAL_NOTES, 'utf8') +
  (process.env.PUBLIC_MARKER_MISMATCH === '1' ? 'tampered' : '')
process.stdout.write(JSON.stringify({
  tagName: 'v1.2.3',
  isDraft: !isPublic,
  isPrerelease: false,
  name: isPublic ? 'Agent Inbox v1.2.3' : (owned?.name ?? 'unowned draft'),
  body: isPublic
    ? publicBody
    : (owned?.body ?? 'unowned draft'),
  assets,
}) + '\\n')
NODE
elif [[ "$1 $2" == "release upload" ]]; then
  if [[ "$FAIL_UPLOAD" == 1 ]]; then exit 9; fi
elif [[ "$1 $2" == "release download" ]]; then
  if [[ "$FAIL_DOWNLOAD" == 1 ]]; then exit 10; fi
  while [[ "$1" != "--dir" ]]; do shift; done
  mkdir -p "$2"
  cp -R "$HANDOFF/release-assets"/. "$2"/
fi
`)
  chmodSync(gh, 0o755)
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: 'test-token',
      GH_REPO: 'example/agent-inbox',
      RELEASE_TAG: 'v1.2.3',
      RELEASE_VERSION: '1.2.3',
      RELEASE_SOURCE: sourceCommit,
      PRODUCER_RUN_ID: '777',
      PRODUCER_RUN_ATTEMPT: '3',
      GITHUB_RUN_ID: '12345',
      RUNNER_TEMP: temp,
      HANDOFF: handoff,
      GH_LOG: log,
      REMOTE_SOURCE: remoteSource,
      REMOTE_SOURCE_AFTER_UPLOAD: remoteSourceAfterUpload,
      REMOTE_DIGEST_MODE: remoteDigestMode,
      TAG_CHECK_COUNT_FILE: join(temp, 'tag-check-count'),
      PUBLISHED_STATE_FILE: join(temp, 'published-state'),
      OWNED_RELEASE_STATE: join(temp, 'owned-release-state'),
      EXISTING_MODE: behavior.existing ?? 'absent',
      FAIL_UPLOAD: behavior.failUpload ? '1' : '0',
      FAIL_DOWNLOAD: behavior.failDownload ? '1' : '0',
      FAIL_DELETE: behavior.failDelete ? '1' : '0',
      PATCH_TRANSPORT_FAILURE: behavior.patchTransportFailure ? '1' : '0',
      CLEANUP_OWNERSHIP: behavior.cleanupOwnership ?? 'owned',
      PUBLIC_MARKER_MISMATCH: behavior.publicMarkerMismatch ? '1' : '0',
      CREATE_RESPONSE_MISMATCH: behavior.createResponseMismatch ? '1' : '0',
      RELEASE_PAGES: releasePages,
      ASSET_DIR: assetDir,
      PATCH_INPUT: patchInput,
      UPDATE_KEY_ROTATION_OVERRIDE: behavior.rotationOverride ?? '',
    },
  })
  return {
    result,
    log: readFileSync(log, 'utf8'),
    finalRequest: existsSync(patchInput) ? readJson(patchInput) : null,
  }
}

describe('notarized macOS release workflow', () => {
  it('starts only from the exact tag path and pins every third-party action', () => {
    const inputs = readFileSync(inputsPath, 'utf8')
    const protectedWorkflow = readFileSync(protectedPath, 'utf8')
    expect(inputs).toContain('name: Multi-platform release inputs')
    expect(inputs).toContain('tags:')
    expect(inputs).toContain('- "v*.*.*"')
    expect(inputs).not.toContain('workflow_dispatch')
    expect(inputs).not.toContain('pull_request')
    expect(protectedWorkflow).toContain('workflow_run:')
    expect(protectedWorkflow).toContain('- "Multi-platform release inputs"')
    expect(protectedWorkflow).not.toContain('workflow_dispatch')
    const refs = [...`${inputs}\n${protectedWorkflow}`.matchAll(
      /^\s*-\s+uses:\s+([^@\s]+)@([^\s#]+)(?:\s+#\s+(.+))?$/gm,
    )]
    expect(refs.length).toBeGreaterThan(0)
    for (const [, action, ref, comment] of refs) {
      expect(action).toMatch(/^actions\//)
      expect(ref).toMatch(/^[0-9a-f]{40}$/)
      expect(comment).toMatch(/^v\d+\.\d+\.\d+$/)
    }
    expect(`${inputs}\n${protectedWorkflow}`).not.toMatch(/uses:\s+[^@\s]+@v\d+/)
  })

  it('rebuilds exact native inputs before protected credentialed stages', () => {
    const inputs = readFileSync(inputsPath, 'utf8')
    const protectedWorkflow = readFileSync(protectedPath, 'utf8')
    const gate = inputs.indexOf('validate-tag:')
    const runtime = inputs.indexOf('runtime:')
    const thin = inputs.indexOf('thin:')
    const sign = protectedWorkflow.indexOf('sign-developer-id:')
    const notarize = protectedWorkflow.indexOf('notarize-and-finalize:')
    const publish = protectedWorkflow.indexOf('publish:')
    expect(gate).toBeGreaterThan(-1)
    expect(runtime).toBeGreaterThan(gate)
    expect(thin).toBeGreaterThan(runtime)
    expect(sign).toBeGreaterThan(-1)
    expect(notarize).toBeGreaterThan(sign)
    expect(publish).toBeGreaterThan(notarize)
    expect(inputs).not.toContain('environment: macos-release')
    expect(protectedWorkflow.match(/environment: macos-release/g)).toHaveLength(4)
    expect(protectedWorkflow).toContain('npm run package:macos --')
    expect(protectedWorkflow).toContain('--mode developer-id')
    expect(`${inputs}\n${protectedWorkflow}`).not.toContain('macos-provisional')
  })

  // #296: one native Apple silicon runtime and thin app, signed and notarized once; no Intel
  // runner, x64 runtime or native Intel gate anywhere in the release.
  it('builds, signs and notarizes the Apple silicon app alone', () => {
    const inputs = readFileSync(inputsPath, 'utf8')
    const protectedWorkflow = readFileSync(protectedPath, 'utf8')
    // The build and its gates; the signer and publisher still know both kinds (#343).
    const building = protectedWorkflow.slice(0, protectedWorkflow.indexOf('  verify-publication:'))
    const macosPackage = readFileSync(join(root, '.github', 'workflows', 'macos-package.yml'), 'utf8')
    for (const [name, workflow] of [['inputs', inputs], ['protected', building], ['package', macosPackage]] as const) {
      expect(workflow, name).not.toMatch(/macos-1\d-intel|darwin-x64|--x64-|verify-intel|intel-evidence|native Intel/i)
      expect(workflow, name).not.toContain('matrix.')
    }
    for (const workflow of [inputs, macosPackage]) {
      expect(workflow).toContain('--key darwin-arm64')
      expect(workflow).toContain('--runtime-arm64 build/runtimes/darwin-arm64')
    }
    expect(protectedWorkflow.match(/npm run package:macos --/g)).toHaveLength(1)
    expect(protectedWorkflow.match(/scripts\/notarize-macos\.sh app/g)).toHaveLength(1)
    expect(protectedWorkflow.match(/scripts\/notarize-macos\.sh dmg/g)).toHaveLength(1)
  })

  it('pivots to trusted default-branch code before exposing credentials', () => {
    const protectedWorkflow = readFileSync(protectedPath, 'utf8')
    const authorize = protectedWorkflow.slice(
      protectedWorkflow.indexOf('  authorize:'),
      protectedWorkflow.indexOf('  verify-handoff:'),
    )
    const sourceDependent = protectedWorkflow.slice(protectedWorkflow.indexOf('  verify-handoff:'))
    expect(authorize).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(authorize).toContain("github.event.workflow_run.event == 'push'")
    expect(authorize).toContain("github.event.workflow_run.name == 'Multi-platform release inputs'")
    expect(authorize).toContain('github.event.workflow_run.head_repository.full_name == github.repository')
    expect(authorize).toContain('ref: ${{ github.workflow_sha }}')
    expect(authorize).toContain('github.event.workflow_run.workflow_id')
    expect(authorize).toContain('run-id: ${{ github.event.workflow_run.id }}')
    expect(authorize).toContain('scripts/macos-release-gates.mjs authorize')
    expect(authorize).toContain('--trusted-sha "${{ github.workflow_sha }}"')
    expect(authorize).toContain('--run-head-sha "${{ github.event.workflow_run.head_sha }}"')
    expect(authorize).not.toContain('scripts/macos-release-gates.mjs thin-handoff')
    expect(sourceDependent).toContain('name: protected-thin-handoff')
    expect(sourceDependent).toContain('scripts/macos-release-gates.mjs thin-handoff')
    expect(sourceDependent.match(/ref: \$\{\{ needs\.authorize\.outputs\.source-commit \}\}/g)?.length)
      .toBeGreaterThanOrEqual(4)
    expect(sourceDependent).not.toContain('ref: ${{ needs.authorize.outputs.trusted-sha }}')
    expect(sourceDependent).toContain(
      'AGENT_INBOX_RELEASE_SOURCE_SHA: ${{ needs.authorize.outputs.source-commit }}',
    )
    const allReleaseWorkflows = `${readFileSync(inputsPath, 'utf8')}\n${protectedWorkflow}`
    const checkoutCount = allReleaseWorkflows.match(/^\s{6}- uses: actions\/checkout@/gm)?.length ?? 0
    expect(checkoutCount).toBeGreaterThan(0)
    expect(allReleaseWorkflows.match(/^\s{10}persist-credentials: false$/gm)).toHaveLength(checkoutCount)
    for (const block of allReleaseWorkflows.split(/(?=^\s{6}- uses: actions\/checkout@)/m).slice(1)) {
      expect(block.slice(0, 300)).toContain('persist-credentials: false')
    }
  })

  it('keeps app and DMG notarization ordered and publication fail closed', () => {
    const workflow = readFileSync(protectedPath, 'utf8')
    const appSubmit = workflow.indexOf('Notarize and staple accepted app')
    const finalDmg = workflow.indexOf('Build and sign final DMG from stapled app')
    const dmgSubmit = workflow.indexOf('Notarize and staple accepted DMG')
    const transportedApp = workflow.indexOf('Mount final stapled DMG and verify transported app')
    const checksums = workflow.indexOf('Generate final post-staple evidence and checksums')
    const publish = workflow.indexOf('Publish exact verified handoff through a fail-closed draft')
    expect(appSubmit).toBeGreaterThan(workflow.indexOf('Restore exact Developer ID app bytes'))
    expect(finalDmg).toBeGreaterThan(appSubmit)
    expect(dmgSubmit).toBeGreaterThan(finalDmg)
    expect(transportedApp).toBeGreaterThan(dmgSubmit)
    expect(checksums).toBeGreaterThan(transportedApp)
    expect(publish).toBeGreaterThan(checksums)
    expect(workflow).toContain('scripts/notarize-macos.sh')
    expect(readFileSync(join(root, 'scripts', 'notarize-macos.sh'), 'utf8'))
      .toContain('node scripts/macos-release-gates.mjs stapler validate "$STAPLE_TARGET"')
    expect(workflow).toContain('spctl --assess')
    expect(workflow).toContain('verify-final-dmg')
    expect(workflow).toContain('--transport-evidence build/transported-app-evidence.json')
    expect(workflow).toContain('SHA256SUMS.txt')
    expect(workflow).toContain('DMG: build/${{ steps.kind.outputs.dmg-name }}')
    expect(workflow).toContain('macOS 13.5 or later')
    expect(workflow).toContain('Linux x86_64 AppImage')
    const docs = readFileSync(join(root, 'docs', 'macos-release.md'), 'utf8')
    expect(docs).toContain('Requires macOS 13.5 (Ventura) or later.')
    expect(docs).toContain('Electron 43 itself supports macOS 12')
    expect(docs).toContain('official Node 24 runtime')
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const install = readFileSync(join(root, 'docs', 'INSTALL.md'), 'utf8')
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    for (const publicDoc of [readme, install]) {
      expect(publicDoc).toContain('https://github.com/shariqh/agent-inbox/releases')
      expect(publicDoc).toContain('When a public release is available')
      expect(publicDoc).toContain('macOS 13.5')
      expect(macDocProblems(publicDoc, version)).toEqual([])
      expect(publicDoc).not.toContain('v0.1 distribution')
    }
    expect(install).not.toContain('is distributed through')
    expect(readme).not.toContain('There are no downloadable Electron binaries yet')
    expect(readme).not.toContain('Downloadable, signed Electron release artifacts')
    const inputs = JSON.parse(readFileSync(join(root, 'release', 'macos-inputs.json'), 'utf8'))
    expect(inputs.electron.version).toMatch(/^43\./)
    expect(inputs.node.version).toMatch(/^v24\./)
    expect(inputs.minimumMacosVersion).toBe('13.5')
    expect(workflow).toContain('permissions:')
    expect(workflow).toContain('contents: write')
    expect(workflow).toContain('if: ${{ always() }}')
  })

  // #384: a 2.0.0 tag must not pass while README or INSTALL still describe the universal app.
  it('checks the public docs against the release they ship with (#384)', () => {
    const universalReadme = [
      '- macOS 13.5 (Ventura) or later on Apple silicon or Intel for the notarized desktop app',
      'On macOS, download the universal DMG from GitHub Releases, drag **Agent Inbox**',
      'to `/Applications`, and launch it. The universal app supports Apple silicon and Intel',
      'Release packages carry separate `darwin-arm64` and `darwin-x64` Node 24 agent runtimes;',
    ].join('\n')
    const universalInstall = [
      '| Notarized desktop app | macOS 13.5+ on Apple silicon and Intel |',
      'ASSET=Agent-Inbox-vX.Y.Z-universal.dmg',
    ].join('\n')
    for (const old of [universalReadme, universalInstall]) {
      expect(macDocProblems(old, '1.8.0')).toEqual([])
      expect(macDocProblems(old, '2.0.0')).toEqual(expect.arrayContaining([
        'has the Intel sentence 0 times, not once',
        'mentions Intel',
        'mentions the universal DMG',
        'does not name the arm64 DMG',
      ]))
    }
    expect(macDocProblems(universalReadme, '2.0.0')).toContain('mentions the darwin-x64 runtime')

    const arm64 = 'download `Agent-Inbox-vX.Y.Z-arm64.dmg`. The app requires a Mac with Apple silicon.\n'
      + 'Intel Macs stay on [v1.8.0](https://github.com/shariqh/agent-inbox/releases/tag/v1.8.0),\nthe last version for them.'
    expect(macDocProblems(arm64, '2.0.0')).toEqual([])
    expect(macDocProblems(arm64, '2.1.0')).toEqual([])
    expect(macDocProblems(`${arm64}\n${INTEL_STAYS}`, '2.0.0')).toEqual(['has the Intel sentence 2 times, not once'])
    expect(macDocProblems(`${arm64} Run it under Rosetta on an Intel Mac.`, '2.0.0'))
      .toEqual(['mentions Intel', 'mentions Rosetta'])
    expect(macDocProblems(arm64, '1.8.0')).toEqual(['does not say the app supports Apple silicon and Intel'])
  })

  // #383: the native Intel job re-checked the sign job's Developer ID report until #296, so
  // the notarize job now does, between restoring the app and zipping it for notarization.
  it('re-checks the Developer ID report against the restored app before notarizing it (#383)', () => {
    const workflow = readFileSync(protectedPath, 'utf8')
    const sign = workflow.slice(workflow.indexOf('  sign-developer-id:'), workflow.indexOf('  notarize-and-finalize:'))
    const notarize = workflow.slice(workflow.indexOf('  notarize-and-finalize:'), workflow.indexOf('  verify-publication:'))
    expect(stepBlock(sign, 'Stage exact Developer ID app and evidence'))
      .toContain('cp "out/developer-id/$BASE-verification.json" build/signed-transfer/')
    expect(notarize).toContain('APPLE_DEVELOPER_IDENTITY: ${{ vars.APPLE_DEVELOPER_IDENTITY }}')
    expect(notarize).toContain('APPLE_TEAM_ID: ${{ vars.APPLE_TEAM_ID }}')
    const check = stepBlock(notarize, 'Re-check the Developer ID report before notarizing')
    expect(notarize.indexOf(check)).toBeGreaterThan(notarize.indexOf(stepBlock(notarize, 'Restore exact Developer ID app bytes')))
    expect(notarize.indexOf(check)).toBeLessThan(notarize.indexOf(stepBlock(notarize, 'Package app for notarization')))
    const command = foldedCommand(check)
    expect(command).toBe([
      'node scripts/macos-release-gates.mjs verify-developer-id',
      '--app "build/final-app/Agent Inbox.app"',
      '--report "build/signed/Agent-Inbox-${{ needs.authorize.outputs.version }}-macos-developer-id-verification.json"',
      '--identity "$APPLE_DEVELOPER_IDENTITY"',
      '--team "$APPLE_TEAM_ID"',
      '--source "${{ needs.authorize.outputs.source-commit }}"',
      '--version "${{ needs.authorize.outputs.version }}"',
    ].join(' '))

    // The step itself, on a restored app and the report bound to it, then tampered.
    const script = command
      .replace('node scripts/macos-release-gates.mjs', `'${process.execPath}' '${join(root, 'scripts', 'macos-release-gates.mjs')}'`)
      .replaceAll('${{ needs.authorize.outputs.version }}', VERSION)
      .replaceAll('${{ needs.authorize.outputs.source-commit }}', sourceCommit)
    expect(script).not.toContain('${{')
    const temp = scratchDir('developer-id-recheck-')
    const app = join(temp, 'build', 'final-app', 'Agent Inbox.app')
    const executable = join(app, 'Contents', 'MacOS', 'Agent Inbox')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(executable, 'Developer ID app bytes')
    const reportPath = join(temp, 'build', 'signed', `Agent-Inbox-${VERSION}-macos-developer-id-verification.json`)
    mkdirSync(join(temp, 'build', 'signed'))
    const report = {
      schema: 1,
      packageVersion: VERSION,
      sourceCommit,
      sourceDirty: false,
      buildMode: 'developer-id',
      notaryEligible: true,
      signing: 'developer-id',
      runtimeHashesUnchangedAfterOuterSign: true,
      appTreeDigest: treeIdentity(app),
    }
    const run = (value: Record<string, unknown>) => {
      writeFileSync(reportPath, `${JSON.stringify(value)}\n`)
      return spawnSync('/bin/bash', ['-c', script], {
        cwd: temp,
        env: {
          PATH: process.env.PATH,
          APPLE_DEVELOPER_IDENTITY: 'Developer ID Application: Example Corp (AB12CD34EF)',
          APPLE_TEAM_ID: 'AB12CD34EF',
        },
        encoding: 'utf8',
      })
    }
    const refusal = /Developer ID report does not satisfy|do not match the finalization report/
    // Bound and eligible, so the step goes on to the bundle version and signature, which
    // this unsigned fixture cannot pass.
    const bound = run(report)
    expect(bound.status).toBe(1)
    expect(bound.stderr).toMatch(/^macos-release-gates: /m)
    expect(bound.stderr).not.toMatch(refusal)
    for (const tampered of [{ notaryEligible: false }, { buildMode: 'adhoc' }, { sourceDirty: true }, { sourceCommit: 'b'.repeat(40) }]) {
      const result = run({ ...report, ...tampered })
      expect(result.status, JSON.stringify(tampered)).toBe(1)
      expect(result.stderr).toContain('Developer ID report does not satisfy release gates')
    }
    writeFileSync(executable, 'other app bytes')
    const swapped = run(report)
    expect(swapped.status).toBe(1)
    expect(swapped.stderr).toContain('Developer ID app bytes do not match the finalization report')
  })

  it('builds, notarizes, verifies and names the DMG from the expected macOS kind (#341)', () => {
    const workflow = readFileSync(protectedPath, 'utf8')
    const notarize = workflow.slice(
      workflow.indexOf('  notarize-and-finalize:'),
      workflow.indexOf('  verify-publication:'),
    )
    expect(notarize).not.toContain('-universal.dmg')
    expect(notarize).not.toContain('darwin-arm64+darwin-x64')
    const kind = stepBlock(notarize, 'Derive the DMG name from the expected macOS CPU types')
    expect(kind).toContain('- id: kind')
    expect(kind).toContain('node scripts/macos-release-gates.mjs expected-kind')
    expect(kind).toContain('--tag "${{ needs.authorize.outputs.tag }}"')
    expect(notarize.indexOf(kind)).toBeGreaterThan(notarize.indexOf('      - run: npm ci'))
    for (const step of [
      'Build and sign final DMG from stapled app',
      'Notarize and staple accepted DMG',
      'Mount final stapled DMG and verify transported app',
      'Generate final post-staple evidence and checksums',
    ]) {
      const block = stepBlock(notarize, step)
      expect(block, step).toContain('DMG: build/${{ steps.kind.outputs.dmg-name }}')
      expect(block, step).toContain('"$DMG"')
      expect(block, step).not.toContain('needs.authorize.outputs.tag }}.dmg')
    }
    // A universal release needed the native Intel gate's record; #296 removed that gate.
    expect(stepBlock(notarize, 'Generate final post-staple evidence and checksums')).not.toContain('--intel-evidence')
  })

  // #296: the notes name the release Intel Macs stay on, found in GitHub's listing like the
  // release the re-stamped update-manifest.json describes (G6), never a constant.
  it('names the last release for Intel Macs in the release notes, from the release listing', () => {
    const workflow = readFileSync(protectedPath, 'utf8')
    const handoff = workflow.slice(workflow.indexOf('  verify-handoff:'), workflow.indexOf('  sign-developer-id:'))
    expect(handoff).toContain('      intel-tag: ${{ steps.intel.outputs.intel-tag }}\n')
    const find = stepBlock(handoff, 'Find the release Intel Macs stay on')
    expect(find).toContain('- id: intel')
    expect(find).toContain('GH_TOKEN: ${{ github.token }}')
    expect(find).toContain('gh api --paginate --slurp "repos/$GH_REPO/releases?per_page=100" > build/release-pages.json')
    expect(find).toContain('node scripts/macos-release-gates.mjs intel-release')
    expect(handoff.indexOf(find)).toBeLessThan(handoff.indexOf('Revalidate source context and bind exact thin artifacts'))

    const notarize = workflow.slice(workflow.indexOf('  notarize-and-finalize:'), workflow.indexOf('  verify-publication:'))
    const notes = stepBlock(notarize, 'Write release notes')
    expect(notes).toContain('DMG_NAME: ${{ steps.kind.outputs.dmg-name }}')
    expect(notes).toContain('INTEL_TAG: ${{ needs.verify-handoff.outputs.intel-tag }}')
    expect(notes).not.toMatch(/v1\.\d+\.\d+/)
    const script = runScript(notes)
      .replaceAll('${{ needs.authorize.outputs.tag }}', 'v2.0.0')
      .replaceAll('${{ needs.authorize.outputs.version }}', '2.0.0')
    expect(script).not.toContain('${{')
    const render = (intelTag: string) => {
      const temp = scratchDir('release-notes-')
      mkdirSync(join(temp, 'build'))
      const written = spawnSync('bash', ['-c', script], {
        cwd: temp,
        env: { PATH: process.env.PATH, DMG_NAME: 'Agent-Inbox-v2.0.0-arm64.dmg', INTEL_TAG: intelTag },
        encoding: 'utf8',
      })
      return { status: written.status, notes: existsSync(join(temp, 'build', 'RELEASE_NOTES.md')) ? readFileSync(join(temp, 'build', 'RELEASE_NOTES.md'), 'utf8') : '' }
    }
    const { status, notes: rendered } = render('v1.8.0')
    expect(status).toBe(0)
    expect(rendered).toContain('- macOS 13.5 or later on Apple silicon: `Agent-Inbox-v2.0.0-arm64.dmg`\n')
    expect(rendered).toContain(
      'This release needs a Mac with Apple silicon. Agent Inbox v1.8.0 is the last version for Intel Macs, and it keeps working. '
        + 'On an Intel Mac, the in-app updater of an older version offers v1.8.0 instead.\n',
    )
    expect(rendered).not.toMatch(/Apple silicon or Intel|universal/)
    expect(rendered).toContain(
      'spctl --assess --type open --context context:primary-signature --verbose=4 Agent-Inbox-v2.0.0-arm64.dmg\n',
    )
    expect(rendered).not.toMatch(/DMG_NAME|INTEL_TAG/)
    // No release for Intel Macs, no notes.
    expect(render('').status).not.toBe(0)
  })

  it('confines Apple secrets to protected jobs and names no secret in artifact paths', () => {
    const inputs = readFileSync(inputsPath, 'utf8')
    const workflow = readFileSync(protectedPath, 'utf8')
    expect(inputs).not.toContain('secrets.')
    const secretRefs = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1])
    expect(new Set(secretRefs)).toEqual(new Set([
      'AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64',
      'APPLE_DEVELOPER_ID_P12_BASE64',
      'APPLE_DEVELOPER_ID_P12_PASSWORD',
      'APPLE_NOTARY_PRIVATE_KEY_BASE64',
    ]))
    expect(secretRefs.filter((name) => name === 'AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64'))
      .toHaveLength(1)
    expect(workflow).not.toMatch(/echo\s+.*\$\{\{\s*secrets\./)
    const artifactPaths = [...workflow.matchAll(/^\s+path:\s*(.+)$/gm)].map((match) => match[1])
    expect(artifactPaths.join('\n')).not.toMatch(/p12|p8|keychain/i)
    expect(workflow).toContain('scripts/import-apple-signing.sh cleanup')
    const publishJob = workflow.slice(workflow.indexOf('  publish:'))
    const beforePublish = workflow.slice(0, workflow.indexOf('  publish:'))
    expect(beforePublish).not.toContain('contents: write')
    expect(workflow.match(/contents: write/g)).toHaveLength(1)
    expect(publishJob).not.toContain('uses:')
    expect(publishJob).not.toContain('npm ci')
    expect(publishJob.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g)).toHaveLength(1)
    expect(publishJob.match(/^\s{6}- name:/gm)).toHaveLength(1)
    expect(publishJob).toContain('gh api "repos/$GH_REPO/git/ref/tags/$RELEASE_TAG"')
    expect(publishJob).toContain('test "$tag_object_type" = tag')
    expect(publishJob).toContain('test "$peeled_sha" = "$RELEASE_SOURCE"')
    expect(publishJob.match(/^\s{10}check_remote_tag$/gm)).toHaveLength(2)
    expect(publishJob).toContain('remote asset digest mismatch')
    expect(publishJob).toContain('gh release download "$RELEASE_TAG"')
    expect(publishJob).toContain('for name in "${ASSET_NAMES[@]}"; do')
    expect(publishJob).toContain('cmp "$WORK/release-assets/$name" "$WORK/remote-assets/$name"')
    expect(publishJob).toContain('gh api --method POST "repos/$GH_REPO/releases"')
    // The draft names only the existing tag: target_commitish would make GitHub check ref
    // creation at the source commit, which needs workflow write permission once main's
    // workflow files differ from the tagged commit's (v2.1.0's publish 403). The tag must be
    // proven at the source commit just before the POST, and again before publication.
    const createRequest = publishJob.slice(
      publishJob.indexOf('writeFileSync(requestPath'),
      publishJob.indexOf('})}\\n`)', publishJob.indexOf('writeFileSync(requestPath')),
    )
    expect(createRequest).toContain('tag_name: tag,')
    expect(createRequest).toContain('draft: true,')
    expect(createRequest).not.toMatch(/^\s*target_commitish:/m)
    const createAt = publishJob.indexOf('gh api --method POST "repos/$GH_REPO/releases"')
    expect(publishJob.lastIndexOf('\n          check_remote_tag\n', createAt)).toBeGreaterThan(
      publishJob.indexOf('could not prove release $RELEASE_TAG is absent'),
    )
    expect(publishJob.indexOf('\n          check_remote_tag\n', createAt))
      .toBeLessThan(publishJob.indexOf('PUBLICATION_ATTEMPTED=true'))
    expect(publishJob).toContain('producerRunAttempt')
    expect(publishJob).toContain('inventorySha256')
    expect(publishJob).toContain('agent-inbox-release-public')
    expect(publishJob).toContain('<!-- agent-inbox-release:')
    expect(publishJob).toContain('verify_remote_release false "Agent Inbox $RELEASE_TAG" "$FINAL_NOTES"')
    expect(publishJob).toContain('node - "$FINAL_NOTES" "$WORK/final-release.json"')
    expect(publishJob).toContain('validate_owned_draft "$WORK/cleanup-release.json"')
    expect(publishJob).toContain("release.body !== markerText")
    expect(publishJob.indexOf('CREATED=true'))
      .toBeGreaterThan(publishJob.indexOf('gh api --method POST "repos/$GH_REPO/releases"'))
    expect(publishJob.indexOf('release creation response does not match the owned staging draft'))
      .toBeGreaterThan(publishJob.indexOf('CREATED=true'))
    expect(publishJob).toContain('PUBLICATION_ATTEMPTED=true')
    expect(publishJob).toContain('publication may have been attempted; retained release id')
    expect(publishJob.indexOf('gh api --method PATCH "repos/$GH_REPO/releases/$RELEASE_ID"'))
      .toBeGreaterThan(publishJob.indexOf('PUBLICATION_ATTEMPTED=true'))
  })

  it('refuses publication when the remote annotated tag moved after authorization', () => {
    const { result, log } = runPublisher('c'.repeat(40), 'match')
    expect(result.status).not.toBe(0)
    expect(log).toContain('git/ref/tags/v1.2.3')
    expect(log).toContain('git/tags/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(log).not.toContain('api --method POST repos/example/agent-inbox/releases')
  })

  it('deletes the draft when uploaded release asset bytes do not match', () => {
    const { result, log } = runPublisher(sourceCommit, 'mismatch')
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('remote asset digest mismatch')
    expect(log).toContain('api --method POST repos/example/agent-inbox/releases')
    expect(log).toContain('release upload v1.2.3')
    expect(log).toContain('api --method DELETE repos/example/agent-inbox/releases/42')
    expect(log).not.toContain('api --method PATCH')
  })

  it('tracks and safely cleans a created draft when response validation fails', () => {
    const { result, log } = runPublisher(sourceCommit, 'match', sourceCommit, {
      createResponseMismatch: true,
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'release creation response does not match the owned staging draft',
    )
    expect(log).toContain('api --method POST repos/example/agent-inbox/releases')
    expect(log).toContain('api repos/example/agent-inbox/releases/42')
    expect(log).toContain('api --method DELETE repos/example/agent-inbox/releases/42')
    expect(log).not.toContain('release upload')
    expect(log).not.toContain('api --method PATCH')
  })

  it('retains the owned draft when the remote tag moves before cleanup', () => {
    const { result, log } = runPublisher(sourceCommit, 'match', 'c'.repeat(40))
    expect(result.status).not.toBe(0)
    expect(log).toContain('api --method POST repos/example/agent-inbox/releases')
    expect(log).toContain('release upload v1.2.3')
    expect(log.match(/git\/ref\/tags\/v1\.2\.3/g)).toHaveLength(3)
    expect(`${result.stdout}\n${result.stderr}`).toContain('release tag/source changed before cleanup')
    expect(log).not.toContain('api --method DELETE repos/example/agent-inbox/releases/42')
    expect(log).not.toContain('api --method PATCH')
  })

  it('publishes only after every remote asset is downloaded and rehashed', () => {
    const { result, log } = runPublisher(sourceCommit, 'match')
    expect(result.status).toBe(0)
    expect(log).toContain('api --method POST repos/example/agent-inbox/releases')
    expect(log).toContain('release upload v1.2.3')
    expect(log).toContain('release download v1.2.3')
    expect(log).toContain('api --method PATCH repos/example/agent-inbox/releases/42')
    expect(log.indexOf('release download v1.2.3'))
      .toBeLessThan(log.indexOf('api --method PATCH repos/example/agent-inbox/releases/42'))
  })

  it('treats an exact already-public release as a verified no-op', () => {
    const { result, log } = runPublisher(sourceCommit, 'match', sourceCommit, {
      existing: 'public',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already public and matches the exact verified handoff')
    expect(log).toContain('release download v1.2.3')
    expect(log).not.toContain('api --method POST repos/example/agent-inbox/releases')
    expect(log).not.toContain('release upload')
    expect(log).not.toContain('api --method PATCH')
    expect(log).not.toContain('api --method DELETE')
  })

  it('refuses an already-public release whose ownership marker does not match', () => {
    const { result, log } = runPublisher(sourceCommit, 'match', sourceCommit, {
      existing: 'public',
      publicMarkerMismatch: true,
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('remote release metadata')
    expect(log).toContain('release view v1.2.3')
    expect(log).not.toContain('api --method POST repos/example/agent-inbox/releases')
    expect(log).not.toContain('release upload')
    expect(log).not.toContain('api --method PATCH')
    expect(log).not.toContain('api --method DELETE')
  })

  it('refuses an existing draft without mutating or deleting it', () => {
    const { result, log } = runPublisher(sourceCommit, 'match', sourceCommit, {
      existing: 'draft',
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('remote release metadata')
    expect(log).not.toContain('api --method POST repos/example/agent-inbox/releases')
    expect(log).not.toContain('release upload')
    expect(log).not.toContain('api --method PATCH')
    expect(log).not.toContain('api --method DELETE')
  })

  it('deletes only its private draft when upload or remote download fails', () => {
    for (const behavior of [{ failUpload: true }, { failDownload: true }]) {
      const { result, log } = runPublisher(sourceCommit, 'match', sourceCommit, behavior)
      expect(result.status).not.toBe(0)
      expect(log).toContain('api --method POST repos/example/agent-inbox/releases')
      expect(log).toContain('api repos/example/agent-inbox/releases/42')
      expect(log).toContain('api --method DELETE repos/example/agent-inbox/releases/42')
      expect(log).not.toContain('api --method PATCH')
    }
  })

  it('retains a possibly published release when the final PATCH response is ambiguous', () => {
    const { result, log } = runPublisher(sourceCommit, 'match', sourceCommit, {
      patchTransportFailure: true,
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('publication may have been attempted; retained release id 42')
    expect(log).toContain('api --method PATCH repos/example/agent-inbox/releases/42')
    expect(log.match(/api repos\/example\/agent-inbox\/releases\/42/g)).toHaveLength(1)
    expect(log).not.toContain('api --method DELETE')
  })

  it('surfaces failed private-draft cleanup and retains recovery evidence', () => {
    const { result, log } = runPublisher(sourceCommit, 'mismatch', sourceCommit, {
      failDelete: true,
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('retained private draft release id 42')
    expect(log).toContain('api --method DELETE repos/example/agent-inbox/releases/42')
  })

  it('never deletes a replacement draft that appears under the same tag', () => {
    const { result, log } = runPublisher(sourceCommit, 'match', sourceCommit, {
      failUpload: true,
      cleanupOwnership: 'replacement',
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "no longer matches this run's owned private draft marker/source",
    )
    expect(log).toContain('api repos/example/agent-inbox/releases/42')
    expect(log).not.toContain('api --method DELETE')
  })

  it('never deletes a draft whose marker source no longer matches this run', () => {
    const { result, log } = runPublisher(sourceCommit, 'match', sourceCommit, {
      failUpload: true,
      cleanupOwnership: 'source-mismatch',
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "no longer matches this run's owned private draft marker/source",
    )
    expect(log).toContain('api repos/example/agent-inbox/releases/42')
    expect(log).not.toContain('api --method DELETE')
  })
})

// Update manifest v2 (#343, design §7.4 and §8.4): the publish job's own checks of both
// manifests, run through the real publish script.
describe('publishing both update manifests', () => {
  function published(fixture: PublishFixture, behavior: Parameters<typeof runPublisher>[3] = {}) {
    return runPublisher(sourceCommit, 'match', sourceCommit, { fixture, ...behavior })
  }

  function refused(fixture: PublishFixture, message: string | RegExp, behavior: Parameters<typeof runPublisher>[3] = {}) {
    const { result, log } = published(fixture, behavior)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(message)
    expect(log).not.toContain('api --method POST')
    return log
  }

  it('publishes a universal release as latest, reading no release listing', () => {
    const { result, log, finalRequest } = published(publishFixture('universal'))
    expect(result.status, result.stderr).toBe(0)
    expect(log).not.toContain('--paginate')
    expect(log).not.toContain('releases/assets/')
    for (const name of ['update-manifest.json', 'update-manifest.json.sig', 'update-manifest-v2.json', 'update-manifest-v2.json.sig']) {
      expect(log).toContain(`--pattern ${name}`)
    }
    expect(finalRequest).toEqual({ name: 'Agent Inbox v1.2.3', body: expect.any(String), draft: false, make_latest: 'true' })
  })

  it('publishes an arm64 release after re-checking its re-stamp against what GitHub lists', () => {
    const fixture = publishFixture('arm64')
    const { result, log, finalRequest } = published(fixture)
    expect(result.status, result.stderr).toBe(0)
    expect(log).toContain('api --paginate --slurp repos/example/agent-inbox/releases?per_page=100')
    const listed = (name: string) => fixture.history.before!.listing.assets.find((asset) => asset.name === name)!.id
    expect(log).toContain(`api repos/example/agent-inbox/releases/assets/${listed('update-manifest.json')} -H Accept: application/octet-stream`)
    expect(log).toContain(`api repos/example/agent-inbox/releases/assets/${listed('update-manifest.json.sig')} -H Accept: application/octet-stream`)
    expect(log).not.toContain(`releases/assets/${listed('update-manifest-v2.json')}`)
    expect(log).toContain('--pattern Agent-Inbox-v1.2.3-arm64.dmg')
    expect(finalRequest).toMatchObject({ draft: false, make_latest: 'true' })
  })

  // #342: from 1.7.0 the registry also trusts the backup key, which never signs here. It is
  // found by its id: after an emergency switch, the key that doesn't sign is the original.
  it.each(['universal', 'arm64'] as const)('%s: publishes a release whose registry also trusts the backup key, after one that trusted the original alone', (kind) => {
    const BACKUP_KEY_ID = 'ed25519-c8adddea0de080d6'
    const original = makeScratchKey()
    const production = readJson(join(root, 'release', 'update-keys.json')) as typeof original.registry
    const backupKeys = production.keys.filter((entry) => entry.keyId === BACKUP_KEY_ID)
    expect(backupKeys.map((entry) => entry.keyId)).toEqual([BACKUP_KEY_ID])
    const registry = { ...original.registry, keys: [...original.registry.keys, ...backupKeys] }
    const key = { ...original, registry, registryBytes: Buffer.from(`${JSON.stringify(registry, null, 2)}\n`) }
    const history = releaseHistory(priorRelease('1.2.2', original, isoSeconds(Date.now() - 7 * DAY_MS), { v1Only: kind === 'universal' }))
    const fixture = publishFixture(kind, { key, history })
    const { result } = published(fixture)
    expect(result.status, result.stderr).toBe(0)
    const ids = registry.keys.map((entry) => entry.keyId).sort()
    for (const name of ['update-manifest.json', 'update-manifest-v2.json']) {
      expect(readJson(join(fixture.handoff, 'release-assets', name)).trustedKeyIds, name).toEqual(ids)
      expect(readJson(join(fixture.handoff, 'release-assets', `${name}.sig`)).signatures.map((signed: { keyId: string }) => signed.keyId), name)
        .toEqual([original.keyId])
    }
    expect(readJson(join(fixture.handoff, 'update-signing-evidence.json')))
      .toMatchObject({ signingKeyId: original.keyId, trustedKeyIds: ids, originalKeySignature: 'passed' })
  })

  describe('the macOS kind, from the CPU types the shipped app measured (G9)', () => {
    it('refuses arm64-only CPU types under the universal DMG name', () => {
      const fixture = publishFixture('universal')
      patchHandoff(fixture, 'release-aggregation-evidence.json', (aggregate) => {
        const mac = aggregate.assets.find((asset: { platform: string }) => asset.platform === 'macos')
        mac.architectures = { executable: ['arm64'], betterSqlite3: ['arm64'] }
      })
      patchHandoff(fixture, 'update-signing-evidence.json', (evidence) => {
        evidence.macos = { kind: 'arm64', architectures: { executable: ['arm64'], betterSqlite3: ['arm64'] }, expected: ['arm64'] }
      })
      refused(fixture, 'give Agent-Inbox-v1.2.3-arm64.dmg labelled arm64, not Agent-Inbox-v1.2.3-universal.dmg labelled universal')
    })

    it('refuses an arm64 DMG labelled universal', () => {
      const fixture = publishFixture('arm64')
      patchHandoff(fixture, 'release-aggregation-evidence.json', (aggregate) => {
        aggregate.assets.find((asset: { platform: string }) => asset.platform === 'macos').architecture = 'universal'
      })
      refused(fixture, 'not Agent-Inbox-v1.2.3-arm64.dmg labelled universal')
    })

    it('refuses CPU types that differ from the expected set the signer recorded', () => {
      const fixture = publishFixture('universal')
      patchHandoff(fixture, 'update-signing-evidence.json', (evidence) => {
        evidence.macos.expected = ['arm64']
      })
      refused(fixture, 'the measured macOS CPU types differ from the expected set the signer recorded')
    })

    it('refuses a universal release without the native Intel pass, and a v1 made the other way', () => {
      const noIntel = publishFixture('universal')
      patchHandoff(noIntel, 'release-aggregation-evidence.json', (aggregate) => {
        delete aggregate.assets.find((asset: { platform: string }) => asset.platform === 'macos').nativeIntel
      })
      refused(noIntel, 'the native Intel evidence does not fit a universal macOS release')
      const restamped = publishFixture('universal')
      patchHandoff(restamped, 'update-signing-evidence.json', (evidence) => {
        evidence.manifests.v1.made = 'restamp'
      })
      refused(restamped, 'a universal release makes its v1 manifest by projection')
    })
  })

  it('refuses a missing pair and an extra file', () => {
    const missing = publishFixture('universal')
    for (const name of ['update-manifest-v2.json', 'update-manifest-v2.json.sig']) rmSync(join(missing.handoff, 'release-assets', name))
    refused(missing, 'release asset allowlist mismatch')
    const extra = publishFixture('universal')
    writeFileSync(join(extra.handoff, 'release-assets', 'update-manifest-v3.json'), '{}\n')
    refused(extra, 'release asset allowlist mismatch')
  })

  it('refuses a v2 manifest for another release', () => {
    const fixture = publishFixture('universal')
    replaceManifest(fixture, 'update-manifest-v2.json', editedManifest(fixture, 'update-manifest-v2.json', (manifest) => {
      manifest.version = '1.2.4'
      manifest.tag = 'v1.2.4'
    }))
    refused(fixture, 'update-manifest-v2.json release identity is malformed')
  })

  it('refuses, in a universal release, a v1 manifest that is not this release or not its v2 data (G8)', () => {
    const other = publishFixture('universal')
    replaceManifest(other, 'update-manifest.json', editedManifest(other, 'update-manifest.json', (manifest) => {
      manifest.version = '1.2.2'
    }))
    refused(other, 'update-manifest.json release identity is malformed')
    const differs = publishFixture('universal')
    replaceManifest(differs, 'update-manifest.json', editedManifest(differs, 'update-manifest.json', (manifest) => {
      manifest.targets[0].minimumSystemVersion = '14.0'
    }))
    refused(differs, "a universal release's update-manifest.json must carry the data of its update-manifest-v2.json")
  })

  describe('the re-stamp of an arm64 release, checked by this job alone', () => {
    it('refuses a v1 manifest that differs from the earlier one in more than the four re-stamped fields', () => {
      const fixture = publishFixture('arm64')
      replaceManifest(fixture, 'update-manifest.json', editedManifest(fixture, 'update-manifest.json', (manifest) => {
        manifest.targets[0].minimumSystemVersion = '14.0'
      }))
      refused(fixture, /may differ from the earlier one only in publishedAt, expiresAt, signingKeyId and trustedKeyIds, not in .*targets/)
    })

    it('refuses copied targets that are not the files GitHub lists for the release they describe', () => {
      const fixture = publishFixture('arm64')
      const dmg = fixture.history.before!.listing.assets.find((asset) => asset.name === 'Agent-Inbox-v1.2.2-universal.dmg')!
      ;(dmg as { size: number }).size += 1
      refused(fixture, 'Agent-Inbox-v1.2.2-universal.dmg is not the file release v1.2.2 lists')
    })

    it('refuses an earlier v1 pair that is not the one GitHub lists for the release before', () => {
      const fixture = publishFixture('arm64')
      const listed = fixture.history.before!.listing.assets.find((asset) => asset.name === 'update-manifest.json')!
      fixture.history.assetsById.set(listed.id, Buffer.concat([fixture.history.assetsById.get(listed.id)!, Buffer.from(' ')]))
      refused(fixture, 'the earlier update-manifest.json pair is not the one GitHub lists for v1.2.2')
    })

    it('refuses a re-stamp of anything but the newest release with a universal DMG (G6)', () => {
      const key = makeScratchKey()
      const fixture = publishFixture('arm64', { key })
      // The release before lists, as its own v1 manifest, one that describes an older release.
      const v121 = priorRelease('1.2.1', key, isoSeconds(Date.now() - 14 * DAY_MS))
      const v122 = priorRelease('1.2.2', key, isoSeconds(Date.now() - 7 * DAY_MS), { v1: v121.pairs.v1 })
      fixture.history = releaseHistory(v121, v122)
      const earlier = JSON.parse(v121.pairs.v1.bytes.toString('utf8'))
      replaceManifest(fixture, 'update-manifest.json', Buffer.from(`${JSON.stringify({
        ...earlier,
        publishedAt: taggedAt,
        expiresAt: isoSeconds(Date.parse(taggedAt) + 180 * DAY_MS),
        signingKeyId: key.keyId,
        trustedKeyIds: [key.keyId],
      }, null, 2)}\n`))
      refused(fixture, 'must describe the newest release with a universal DMG (v1.2.2), not v1.2.1')
    })
  })

  describe('the original key on update-manifest.json (G10)', () => {
    it('refuses a v1 manifest without its signature unless the waiver is recorded and the variable holds the exact override', () => {
      const fixture = publishFixture('universal', { waive: true })
      const message = 'update-manifest.json has no valid signature from ed25519-99927ba2f6af6482'
      refused(fixture, message)
      refused(fixture, message, { rotationOverride: `ALLOW-UPDATE-KEY-ROTATION:v1.2.4:${fixture.key.keyId}` })
      refused(fixture, message, { rotationOverride: `${fixture.override} ` })
      const { result } = published(fixture, { rotationOverride: fixture.override })
      expect(result.status, result.stderr).toBe(0)
    })

    it('refuses evidence that says the original key signed when it did not, or waives it when it did', () => {
      const unsigned = publishFixture('universal')
      unsigned.pin = 'production'
      refused(unsigned, 'update-manifest.json has no valid signature from ed25519-99927ba2f6af6482')
      const signed = publishFixture('universal')
      patchHandoff(signed, 'update-signing-evidence.json', (evidence) => {
        evidence.originalKeySignature = 'waived'
        evidence.rotationOverride = signed.override
      })
      refused(signed, 'the signing evidence must record that the original key signed update-manifest.json', { rotationOverride: signed.override })
    })
  })

  it('refuses signing evidence of another schema', () => {
    const fixture = publishFixture('universal')
    patchHandoff(fixture, 'update-signing-evidence.json', (evidence) => {
      evidence.schema = 1
    })
    refused(fixture, 'update signing evidence is malformed')
  })

  it('keeps the key in one step that runs one command, and adds no job, secret, permission or action', () => {
    const workflow = readFileSync(protectedPath, 'utf8')
    const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
    expect([...jobs.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((match) => match[1])).toEqual([
      'authorize', 'verify-handoff', 'sign-developer-id', 'notarize-and-finalize', 'verify-publication', 'sign-update-manifest', 'publish',
    ])
    const sign = workflow.slice(workflow.indexOf('  sign-update-manifest:'), workflow.indexOf('  publish:'))
    const publish = workflow.slice(workflow.indexOf('  publish:'))
    expect(sign).toContain('    permissions:\n      actions: read\n      contents: read\n    steps:')
    expect(publish).toContain('    permissions:\n      actions: read\n      contents: write\n    steps:')
    const keyStep = stepBlock(sign, 'Sign exact deterministic update manifest')
    expect(keyStep).toContain('AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64: ${{ secrets.AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64 }}')
    const commands = runScript(keyStep).split('\n').map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('--'))
    expect(commands).toEqual(['set -euo pipefail', 'node scripts/update-manifest.mjs sign \\'])
    expect(keyStep.match(/ --manifest /g)).toHaveLength(2)
    expect(sign.split('AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64').length - 1).toBe(2)
    for (const job of [sign, publish]) {
      expect(new Set([...job.matchAll(/vars\.([A-Z0-9_]+)/g)].map((match) => match[1]))).toEqual(new Set(['AGENT_INBOX_UPDATE_KEY_ROTATION_OVERRIDE']))
      expect(job).not.toContain('secrets.APPLE')
    }
    // G10 before the key: the history step, which authorizes the original key, comes first.
    expect(sign.indexOf('node scripts/update-manifest.mjs authorize-history')).toBeLessThan(sign.indexOf('AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64'))
    expect(sign.indexOf('node scripts/update-manifest.mjs check-release')).toBeLessThan(sign.indexOf('node scripts/update-manifest.mjs authorize-history'))
  })

  it('pins in the publish job the original key the signer and the production registry pin', () => {
    const publish = readFileSync(protectedPath, 'utf8').slice(readFileSync(protectedPath, 'utf8').indexOf('  publish:'))
    expect(publish).toContain(`const ORIGINAL_KEY_ID = '${ORIGINAL_UPDATE_KEY.keyId}'`)
    expect(publish).toContain(`const ORIGINAL_KEY_SPKI = '${ORIGINAL_UPDATE_KEY.publicKeySpkiBase64}'`)
    // Exactly once each, so the tests' scratch-key swap covers every use.
    expect(publish.split(ORIGINAL_UPDATE_KEY.keyId).length - 1).toBe(1)
    expect(publish.split(ORIGINAL_UPDATE_KEY.publicKeySpkiBase64).length - 1).toBe(1)
    expect(JSON.parse(readFileSync(join(root, 'release', 'update-keys.json'), 'utf8')).keys).toContainEqual(ORIGINAL_UPDATE_KEY)
    expect(publish).toContain('UPDATE_KEY_ROTATION_OVERRIDE: ${{ vars.AGENT_INBOX_UPDATE_KEY_ROTATION_OVERRIDE }}')
    expect(publish).toContain("make_latest: 'true',")
  })
})

// The sign job's three steps, run as written against a fake `git` and `gh`, into the real
// publish script: the YAML only moves files between the trusted subcommands.
describe('the sign job, step by step, into the publish job', () => {
  function runSignJob(
    kind: Kind,
    history: History,
    key: ScratchKey,
    options: { rotationOverride?: string; tamper?: (handoff: string) => void; source?: string; macosInputs?: string } = {},
  ) {
    const work = scratchDir('release-sign-job-')
    // The trusted checkout's code, copied so nothing is written into this repository.
    for (const file of ['scripts/update-manifest.mjs', 'scripts/macos-release-kind.mjs', 'electron/update-manifest.cjs']) {
      cpSync(join(root, file), join(work, file))
    }
    const unsigned = join(work, 'build', 'unsigned-publish-handoff')
    writeUnsignedHandoff(unsigned, kind, key)
    options.tamper?.(unsigned)
    const releaseCommit = join(work, 'release-commit')
    mkdirSync(releaseCommit)
    writeFileSync(join(releaseCommit, 'update-keys.json'), key.registryBytes)
    writeFileSync(join(releaseCommit, 'macos-inputs.json'), options.macosInputs
      ?? `${JSON.stringify({ macosArchitectures: [...MACOS[kind].sets], minimumMacosVersion: '13.5' }, null, 2)}\n`)
    const assetDir = join(work, 'assets-by-id')
    mkdirSync(assetDir)
    for (const [id, bytes] of history.assetsById) writeFileSync(join(assetDir, String(id)), bytes)
    const releasePages = join(work, 'release-pages.json')
    writeFileSync(releasePages, `${JSON.stringify([history.listings])}\n`)
    const bin = join(work, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), `#!/bin/bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  "show $RELEASE_SOURCE:release/update-keys.json") cat "$RELEASE_COMMIT/update-keys.json" ;;
  "show $RELEASE_SOURCE:release/macos-inputs.json") cat "$RELEASE_COMMIT/macos-inputs.json" ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 })
    writeFileSync(join(bin, 'gh'), `#!/bin/bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
if [[ "$1 $2 $3 $4" == "api --paginate --slurp repos/example/agent-inbox/releases?per_page=100" ]]; then
  cat "$RELEASE_PAGES"
elif [[ "$1" == api && "$2" == repos/example/agent-inbox/releases/assets/* && "$3 $4" == "-H Accept: application/octet-stream" ]]; then
  cat "$ASSET_DIR/\${2##*/}"
else
  exit 64
fi
`, { mode: 0o755 })
    const callLog = join(work, 'calls.log')
    writeFileSync(callLog, '')
    const plumbing = { PATH: `${bin}:${process.env.PATH}`, HOME: work, CALL_LOG: callLog, RELEASE_COMMIT: releaseCommit, RELEASE_PAGES: releasePages, ASSET_DIR: assetDir }
    const release = { RELEASE_TAG: TAG, RELEASE_SOURCE: options.source ?? sourceCommit, UPDATE_KEY_ROTATION_OVERRIDE: options.rotationOverride ?? '' }
    const workflow = readFileSync(protectedPath, 'utf8')
    const job = workflow.slice(workflow.indexOf('  sign-update-manifest:'), workflow.indexOf('  publish:'))
    const steps: Array<[string, Record<string, string>]> = [
      ['Authorize exact update-signing history with trusted code', { ...release, GH_TOKEN: 'test-token', GH_REPO: 'example/agent-inbox' }],
      ['Sign exact deterministic update manifest', { AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64: Buffer.from(key.privateKeyPem).toString('base64') }],
      ['Bind exact signed publication handoff', release],
    ]
    const results: Array<{ name: string; status: number | null; output: string }> = []
    for (const [name, env] of steps) {
      const result = spawnSync('bash', ['-c', runScript(stepBlock(job, name))], { cwd: work, encoding: 'utf8', env: { ...plumbing, ...env } })
      results.push({ name, status: result.status, output: `${result.stdout}\n${result.stderr}` })
      if (result.status !== 0) break
    }
    return { results, handoff: join(work, 'build', 'signed-publish-handoff'), calls: readFileSync(callLog, 'utf8') }
  }

  const statuses = (run: ReturnType<typeof runSignJob>) => run.results.map(({ name, status, output }) => ({ name, status, ...(status === 0 ? {} : { output }) }))

  it('signs a universal release after a release that published only v1, and the publish job accepts it', () => {
    const key = makeScratchKey()
    const history = releaseHistory(priorRelease('1.2.2', key, isoSeconds(Date.now() - 30 * DAY_MS), { v1Only: true }))
    const override = `ALLOW-UPDATE-KEY-ROTATION:${TAG}:${key.keyId}`
    const run = runSignJob('universal', history, key, { rotationOverride: override })
    expect(statuses(run)).toEqual([
      { name: 'Authorize exact update-signing history with trusted code', status: 0 },
      { name: 'Sign exact deterministic update manifest', status: 0 },
      { name: 'Bind exact signed publication handoff', status: 0 },
    ])
    expect(run.calls).toContain(`git show ${sourceCommit}:release/macos-inputs.json`)
    expect(run.calls.match(/releases\/assets\//g)).toHaveLength(2)
    const evidence = readJson(join(run.handoff, 'update-signing-evidence.json'))
    expect(evidence).toMatchObject({
      schema: 2,
      macos: { kind: 'universal', expected: ['arm64', 'x86_64'] },
      originalKeySignature: 'waived',
      rotationOverride: override,
      manifests: {
        v2: { made: 'release', history: { mode: 'bootstrap', priorTag: null } },
        v1: { made: 'projection', tag: TAG, history: { mode: 'continuity', priorTag: 'v1.2.2', describes: 'v1.2.2' } },
      },
    })
    const fixture: PublishFixture = { kind: 'universal', handoff: run.handoff, key, history, pin: 'production', override }
    const { result, finalRequest } = runPublisher(sourceCommit, 'match', sourceCommit, { fixture, rotationOverride: override })
    expect(result.status, result.stderr).toBe(0)
    expect(finalRequest).toMatchObject({ make_latest: 'true' })
  })

  it('signs an arm64 release, re-stamping the release before, and the publish job accepts it', () => {
    const key = makeScratchKey()
    const history = releaseHistory(priorRelease('1.2.2', key, isoSeconds(Date.now() - 7 * DAY_MS)))
    const override = `ALLOW-UPDATE-KEY-ROTATION:${TAG}:${key.keyId}`
    const run = runSignJob('arm64', history, key, { rotationOverride: override })
    expect(statuses(run).every(({ status }) => status === 0), JSON.stringify(statuses(run))).toBe(true)
    expect(run.calls.match(/releases\/assets\//g)).toHaveLength(4)
    const evidence = readJson(join(run.handoff, 'update-signing-evidence.json'))
    expect(evidence.manifests.v1).toMatchObject({
      made: 'restamp',
      tag: 'v1.2.2',
      restamp: { earlierManifestSha256: sha256(history.before!.pairs.v1.bytes) },
    })
    const fixture: PublishFixture = { kind: 'arm64', handoff: run.handoff, key, history, pin: 'production', override }
    const { result, finalRequest } = runPublisher(sourceCommit, 'match', sourceCommit, { fixture, rotationOverride: override })
    expect(result.status, result.stderr).toBe(0)
    expect(finalRequest).toMatchObject({ make_latest: 'true' })
  })

  // #296: the expected set committed in release/macos-inputs.json, read at the release commit as
  // the signer reads it, makes an Apple silicon release whose update-manifest.json freezes to
  // the newest universal release, and refuses a universal app before the key is touched.
  describe('under the committed release/macos-inputs.json', () => {
    const committed = readFileSync(join(root, 'release', 'macos-inputs.json'), 'utf8')

    it('signs an arm64 release that re-stamps 1.x-last, and the publish job accepts it', () => {
      const key = makeScratchKey()
      const history = releaseHistory(
        priorRelease('1.2.1', key, isoSeconds(Date.now() - 14 * DAY_MS)),
        priorRelease('1.2.2', key, isoSeconds(Date.now() - 7 * DAY_MS)),
      )
      const override = `ALLOW-UPDATE-KEY-ROTATION:${TAG}:${key.keyId}`
      const run = runSignJob('arm64', history, key, { rotationOverride: override, macosInputs: committed })
      expect(statuses(run).every(({ status }) => status === 0), JSON.stringify(statuses(run))).toBe(true)
      const evidence = readJson(join(run.handoff, 'update-signing-evidence.json'))
      expect(evidence.macos).toEqual({
        kind: 'arm64',
        architectures: { executable: ['arm64'], betterSqlite3: ['arm64'] },
        expected: ['arm64'],
      })
      expect(evidence.manifests.v1).toMatchObject({ made: 'restamp', tag: 'v1.2.2', history: { priorTag: 'v1.2.2', describes: 'v1.2.2' } })
      const assets = join(run.handoff, 'release-assets')
      const v2 = readJson(join(assets, 'update-manifest-v2.json'))
      expect(v2.targets.filter((target: { platform: string }) => target.platform === 'darwin')).toEqual([
        expect.objectContaining({ architecture: 'arm64', filename: 'Agent-Inbox-v1.2.3-arm64.dmg' }),
      ])
      // The frozen v1: 1.2.2's own manifest, re-stamped. Its keys are this release's, the same
      // here, so only its lifetime moves to this release's tag time.
      const earlier = JSON.parse(history.before!.pairs.v1.bytes.toString('utf8'))
      const v1 = readJson(join(assets, 'update-manifest.json'))
      expect(Object.keys(v1).filter((field) => JSON.stringify(v1[field]) !== JSON.stringify(earlier[field])).sort())
        .toEqual(['expiresAt', 'publishedAt'])
      expect(v1).toMatchObject({ version: '1.2.2', publishedAt: taggedAt })
      expect(v1.targets.find((target: { platform: string }) => target.platform === 'darwin').filename)
        .toBe('Agent-Inbox-v1.2.2-universal.dmg')
      const fixture: PublishFixture = { kind: 'arm64', handoff: run.handoff, key, history, pin: 'production', override }
      const { result, finalRequest } = runPublisher(sourceCommit, 'match', sourceCommit, { fixture, rotationOverride: override })
      expect(result.status, result.stderr).toBe(0)
      expect(finalRequest).toMatchObject({ make_latest: 'true' })
    })

    it('refuses a universal app before anything is downloaded or signed', () => {
      const key = makeScratchKey()
      const run = runSignJob('universal', releaseHistory(), key, {
        rotationOverride: `ALLOW-UPDATE-KEY-ROTATION:${TAG}:${key.keyId}`,
        macosInputs: committed,
      })
      expect(run.results).toHaveLength(1)
      expect(run.results[0]!.output)
        .toContain('the shipped app\'s CPU types ["arm64","x86_64"] differ from the expected ["arm64"] in release/macos-inputs.json')
      expect(run.calls).not.toContain('gh ')
      expect(existsSync(run.handoff)).toBe(false)
    })
  })

  it('stops before the key when the original key would not sign v1 and no exact override is set (G10)', () => {
    const key = makeScratchKey()
    const run = runSignJob('universal', releaseHistory(), key)
    expect(run.results).toHaveLength(1)
    expect(run.results[0]).toMatchObject({ status: 1 })
    expect(run.results[0]!.output).toContain(`ALLOW-UPDATE-KEY-ROTATION:${TAG}:${key.keyId}`)
    expect(existsSync(run.handoff)).toBe(false)
  })

  it('re-hashes the packages and binds the authorized tag and commit before anything else', () => {
    const key = makeScratchKey()
    const override = `ALLOW-UPDATE-KEY-ROTATION:${TAG}:${key.keyId}`
    const changed = runSignJob('universal', releaseHistory(), key, {
      rotationOverride: override,
      // The same size, other bytes: only the digest can tell.
      tamper: (handoff) => writeFileSync(join(handoff, 'release-assets', 'agent-inbox_1.2.3_amd64.deb'), 'final bytes for agent-inbox_1.2.3_amd64.deX'),
    })
    expect(changed.results).toHaveLength(1)
    expect(changed.results[0]!.output).toMatch(/agent-inbox_1\.2\.3_amd64\.deb is not the file the aggregate evidence describes/)
    expect(changed.calls).not.toContain('gh ')
    const moved = runSignJob('universal', releaseHistory(), key, { rotationOverride: override, source: 'b'.repeat(40) })
    expect(moved.results).toHaveLength(1)
    expect(moved.results[0]!.output).toContain('the release context is not the authorized tag and source commit')
  })
})

