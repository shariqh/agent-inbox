import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  aggregateReleaseAssets,
  validateDryRunReleaseArtifacts,
  validateLinuxReleaseArtifacts,
} from '../scripts/release-aggregation.mjs'

const root = resolve(process.cwd())
const sourceCommit = 'a'.repeat(40)
const sourceTree = 'b'.repeat(40)
const taggedAt = '2026-08-25T20:12:51Z'
const context = {
  schema: 1,
  tag: 'v1.0.1',
  version: '1.0.1',
  sourceCommit,
  taggedAt,
  annotated: true,
} as const
const work: string[] = []

function tempDir() {
  const path = mkdtempSync(join(tmpdir(), 'release-aggregation-'))
  work.push(path)
  return path
}

function sha256Bytes(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path: string) {
  return sha256Bytes(readFileSync(path))
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

type LinuxFixture = {
  root: string
  paths: {
    x64AppImage: string
    arm64AppImage: string
    x64Deb: string
    arm64Deb: string
  }
}

function writePackageArtifact(
  fixtureRoot: string,
  {
    artifactName,
    artifactDir,
    artifactKey,
    target,
    artifactArchitecture,
    debArchitecture,
    appImageInputs,
  }: {
    artifactName: string
    artifactDir: 'appimage' | 'deb'
    artifactKey: string
    target: 'linux-x64' | 'linux-arm64'
    artifactArchitecture?: 'x86_64' | 'aarch64'
    debArchitecture?: 'amd64' | 'arm64'
    appImageInputs?: 'release/linux-appimage-x64.json' | 'release/linux-appimage-arm64.json'
  },
) {
  const artifactRoot = join(fixtureRoot, artifactKey)
  const packageDir = join(artifactRoot, artifactDir)
  const reportsDir = join(artifactRoot, 'reports')
  const thinDir = join(artifactRoot, 'thin', target)
  mkdirSync(packageDir, { recursive: true })
  mkdirSync(reportsDir, { recursive: true })
  mkdirSync(thinDir, { recursive: true })

  const artifact = join(packageDir, artifactName)
  const bytes = `${artifactKey} final bytes`
  writeFileSync(artifact, bytes)
  const digest = sha256Bytes(bytes)
  writeFileSync(`${artifact}.sha256`, `${digest}  ${artifactName}\n`)

  const linuxInputsSha256 = sha256File(join(root, 'release/linux-inputs.json'))
  const common = {
    schema: 1,
    product: 'Agent Inbox',
    packageVersion: context.version,
    artifactFile: artifactName,
    sourceCommit,
    sourceDirty: false,
    linuxInputsSha256,
    setupRuntimeKeys: [target],
    electronVersion: '43.1.1',
    nodeVersion: 'v24.19.0',
    exactHostSetupSelection: 'passed',
    chromeSandboxMode: 0o4755,
  }
  const report = artifactDir === 'appimage'
    ? {
        ...common,
        artifactArchitecture,
        appImageSize: Buffer.byteLength(bytes),
        appImageSha256: digest,
        appImageInputsSha256: sha256File(join(root, appImageInputs!)),
      }
    : {
        ...common,
        arch: target === 'linux-x64' ? 'x64' : 'arm64',
        debArchitecture,
        debSize: Buffer.byteLength(bytes),
        debSha256: digest,
        debInputsSha256: sha256File(join(root, 'release/linux-deb.json')),
      }
  writeJson(`${artifact}.report.json`, report)

  const verifyName = artifactDir === 'appimage'
    ? `${target}-appimage-verify.json`
    : `${target}-deb-verify.json`
  const verification = artifactDir === 'appimage'
    ? {
        schema: 1,
        product: 'Agent Inbox',
        packageVersion: context.version,
        artifactFile: artifactName,
        artifactArchitecture,
        linuxInputsSha256,
        appImageSize: Buffer.byteLength(bytes),
        appImageSha256: digest,
        chromeSandboxMode: 0o4755,
        setupRuntimeKeys: [target],
        electronVersion: '43.1.1',
        nodeVersion: 'v24.19.0',
        exactHostSetupSelection: 'passed',
      }
    : {
        schema: 1,
        product: 'Agent Inbox',
        packageVersion: context.version,
        artifactFile: artifactName,
        arch: target === 'linux-x64' ? 'x64' : 'arm64',
        debArchitecture,
        debSize: Buffer.byteLength(bytes),
        debSha256: digest,
        chromeSandboxMode: 0o4755,
        setupRuntimeKeys: [target],
        electronVersion: '43.1.1',
        nodeVersion: 'v24.19.0',
        exactHostSetupSelection: 'passed',
      }
  writeJson(join(reportsDir, verifyName), verification)
  writeJson(join(reportsDir, `${target}-runtime.json`), {
    key: target,
    archiveSha256: target === 'linux-x64'
      ? '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647'
      : '01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc',
  })
  writeJson(join(reportsDir, `${target}-runtime-verify.json`), {
    schema: 1,
    packageVersion: context.version,
    sourceCommit,
    platform: 'linux',
    arch: target === 'linux-x64' ? 'x64' : 'arm64',
  })
  writeJson(join(thinDir, 'Agent Inbox.thin-report.json'), {
    schema: 1,
    packageVersion: context.version,
    sourceCommit,
    target,
  })
  return {
    artifact,
    checksum: `${artifact}.sha256`,
    report: `${artifact}.report.json`,
  }
}

function makeLinuxFixture(): LinuxFixture {
  const fixtureRoot = tempDir()
  const paths = {
    x64AppImage: writePackageArtifact(fixtureRoot, {
      artifactName: 'Agent-Inbox-v1.0.1-linux-x86_64.AppImage',
      artifactDir: 'appimage',
      artifactKey: 'linux-x64-appimage',
      target: 'linux-x64',
      artifactArchitecture: 'x86_64',
      appImageInputs: 'release/linux-appimage-x64.json',
    }).artifact,
    arm64AppImage: writePackageArtifact(fixtureRoot, {
      artifactName: 'Agent-Inbox-v1.0.1-linux-arm64.AppImage',
      artifactDir: 'appimage',
      artifactKey: 'linux-arm64-appimage',
      target: 'linux-arm64',
      artifactArchitecture: 'aarch64',
      appImageInputs: 'release/linux-appimage-arm64.json',
    }).artifact,
    x64Deb: writePackageArtifact(fixtureRoot, {
      artifactName: 'agent-inbox_1.0.1_amd64.deb',
      artifactDir: 'deb',
      artifactKey: 'linux-x64-deb',
      target: 'linux-x64',
      debArchitecture: 'amd64',
    }).artifact,
    arm64Deb: writePackageArtifact(fixtureRoot, {
      artifactName: 'agent-inbox_1.0.1_arm64.deb',
      artifactDir: 'deb',
      artifactKey: 'linux-arm64-deb',
      target: 'linux-arm64',
      debArchitecture: 'arm64',
    }).artifact,
  }
  return { root: fixtureRoot, paths }
}

function makeMacFixture() {
  const macRoot = tempDir()
  const assets = join(macRoot, 'release-assets')
  mkdirSync(assets)
  const dmgName = 'Agent-Inbox-v1.0.1-universal.dmg'
  const dmg = join(assets, dmgName)
  writeFileSync(dmg, 'notarized dmg bytes')
  const digest = sha256File(dmg)
  writeFileSync(join(assets, 'SHA256SUMS.txt'), `${digest}  ${dmgName}\n`)
  const evidence = join(macRoot, 'release-evidence.json')
  writeJson(evidence, {
    schema: 1,
    tag: context.tag,
    packageVersion: context.version,
    sourceCommit,
    annotatedTag: true,
    identity: 'Developer ID Application: Release Test (AB12CD34EF)',
    teamId: 'AB12CD34EF',
    finalDmgName: dmgName,
    finalDmgSha256: digest,
    appNotarization: { status: 'Accepted', submissionId: 'app-ticket' },
    dmgNotarization: { status: 'Accepted', submissionId: 'dmg-ticket' },
    transportedApp: {
      schema: 1,
      status: 'passed',
      sourceCommit,
      packageVersion: context.version,
      finalDmgSha256: digest,
      identity: 'Developer ID Application: Release Test (AB12CD34EF)',
      teamId: 'AB12CD34EF',
      dmgSignatureIdentity: 'passed',
      copiedAppCodesign: 'passed',
      copiedAppStapler: 'passed',
      copiedAppGatekeeper: 'passed',
      universalEnvelope: 'passed',
      runtimeManifests: 'passed',
      releaseSetupInfo: 'passed',
      loopbackLaunch: 'passed',
      portableRuntimeLifecycle: 'passed',
    },
    verification: {
      appCodesign: 'passed',
      appGatekeeper: 'passed',
      appStapler: 'passed',
      checksumAfterStaple: true,
      dmgCodesign: 'passed',
      dmgGatekeeper: 'passed',
      dmgIdentity: 'passed',
      dmgStapler: 'passed',
      transportedApp: 'passed',
    },
  })
  return { assets, evidence, dmg }
}

function makeMacDryRunFixture() {
  const directory = tempDir()
  const base = 'Agent-Inbox-1.0.1-macos-universal-adhoc'
  const files = new Map<string, string>([
    [`${base}.tar.gz`, 'ad-hoc app archive'],
    [`${base}-provisional.dmg`, 'provisional dmg'],
    [`${base}-verification.json`, `${JSON.stringify({
      schema: 1,
      packageVersion: context.version,
      sourceCommit,
      sourceDirty: false,
      buildMode: 'adhoc',
      provisional: true,
      notarized: false,
      notaryEligible: false,
      validationEvidenceOnly: true,
    }, null, 2)}\n`],
    [`${base}-metadata.json`, `${JSON.stringify({
      schema: 1,
      packageVersion: context.version,
      sourceCommit,
      sourceDirty: false,
      buildMode: 'adhoc',
      provisional: true,
      notarized: false,
    }, null, 2)}\n`],
    ['macos-inputs.json', readFileSync(join(root, 'release/macos-inputs.json'), 'utf8')],
  ])
  for (const [name, content] of files) writeFileSync(join(directory, name), content)
  const checksums = Object.fromEntries(
    [...files.keys()].map((name) => [name, sha256File(join(directory, name))]),
  )
  writeJson(join(directory, 'SHA256SUMS.json'), checksums)
  writeFileSync(
    join(directory, 'SHA256SUMS'),
    `${Object.entries(checksums).map(([name, digest]) => `${digest}  ${name}`).join('\n')}\n`,
  )
  return directory
}

afterEach(() => {
  while (work.length) rmSync(work.pop()!, { recursive: true, force: true })
})

describe('multi-platform release aggregation', () => {
  it('binds the exact Linux inventory to source, version, architecture, and input manifests', () => {
    const fixture = makeLinuxFixture()
    const evidence = validateLinuxReleaseArtifacts({
      artifactsRoot: fixture.root,
      context,
      repoRoot: root,
      sourceTree,
    })

    expect(evidence).toMatchObject({
      schema: 1,
      tag: 'v1.0.1',
      packageVersion: '1.0.1',
      sourceCommit,
      sourceTree,
      publishable: true,
    })
    expect(evidence.assets.map((asset) => asset.name)).toEqual([
      'Agent-Inbox-v1.0.1-linux-arm64.AppImage',
      'Agent-Inbox-v1.0.1-linux-x86_64.AppImage',
      'agent-inbox_1.0.1_amd64.deb',
      'agent-inbox_1.0.1_arm64.deb',
    ])
    expect(JSON.stringify(evidence)).not.toContain(fixture.root)
    expect(evidence.manifests).toEqual({
      linuxInputsSha256: sha256File(join(root, 'release/linux-inputs.json')),
      linuxAppImageArm64Sha256: sha256File(join(root, 'release/linux-appimage-arm64.json')),
      linuxAppImageX64Sha256: sha256File(join(root, 'release/linux-appimage-x64.json')),
      linuxDebSha256: sha256File(join(root, 'release/linux-deb.json')),
      macosInputsSha256: sha256File(join(root, 'release/macos-inputs.json')),
    })
  })

  it('rejects source mismatch, missing artifacts, unexpected files, and checksum corruption', () => {
    const sourceMismatch = makeLinuxFixture()
    const reportPath = `${sourceMismatch.paths.x64AppImage}.report.json`
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    report.sourceCommit = 'c'.repeat(40)
    writeJson(reportPath, report)
    expect(() => validateLinuxReleaseArtifacts({
      artifactsRoot: sourceMismatch.root,
      context,
      repoRoot: root,
      sourceTree,
    })).toThrow(/source commit/i)

    const missing = makeLinuxFixture()
    rmSync(missing.paths.arm64Deb)
    expect(() => validateLinuxReleaseArtifacts({
      artifactsRoot: missing.root,
      context,
      repoRoot: root,
      sourceTree,
    })).toThrow(/allowlist|missing/i)

    const unexpected = makeLinuxFixture()
    writeFileSync(join(unexpected.root, 'linux-x64-appimage', 'unexpected'), 'stale')
    expect(() => validateLinuxReleaseArtifacts({
      artifactsRoot: unexpected.root,
      context,
      repoRoot: root,
      sourceTree,
    })).toThrow(/allowlist|unexpected/i)

    const corrupt = makeLinuxFixture()
    writeFileSync(corrupt.paths.x64Deb, 'changed bytes')
    expect(() => validateLinuxReleaseArtifacts({
      artifactsRoot: corrupt.root,
      context,
      repoRoot: root,
      sourceTree,
    })).toThrow(/checksum|sha-256|digest/i)
  })

  it('assembles five packages, the exact checksum file, and a deterministic update manifest', () => {
    const linux = makeLinuxFixture()
    const mac = makeMacFixture()
    const output = tempDir()
    const result = aggregateReleaseAssets({
      artifactsRoot: linux.root,
      macAssetsDir: mac.assets,
      macEvidencePath: mac.evidence,
      context,
      repoRoot: root,
      sourceTree,
      outputDir: output,
    })

    expect(result.assetNames).toEqual([
      'Agent-Inbox-v1.0.1-linux-arm64.AppImage',
      'Agent-Inbox-v1.0.1-linux-x86_64.AppImage',
      'Agent-Inbox-v1.0.1-universal.dmg',
      'agent-inbox_1.0.1_amd64.deb',
      'agent-inbox_1.0.1_arm64.deb',
      'SHA256SUMS.txt',
      'update-manifest.json',
    ])
    const checksums = readFileSync(join(output, 'release-assets', 'SHA256SUMS.txt'), 'utf8')
    const lines = checksums.trimEnd().split('\n')
    expect(lines).toHaveLength(5)
    expect(lines.map((line) => line.slice(66))).toEqual([
      'Agent-Inbox-v1.0.1-linux-arm64.AppImage',
      'Agent-Inbox-v1.0.1-linux-x86_64.AppImage',
      'Agent-Inbox-v1.0.1-universal.dmg',
      'agent-inbox_1.0.1_amd64.deb',
      'agent-inbox_1.0.1_arm64.deb',
    ])
    for (const line of lines) {
      const [, , name] = /^([0-9a-f]{64})  ([^\n]+)$/.exec(line) ?? []
      expect(name).toBeTruthy()
      expect(line.startsWith(sha256File(join(output, 'release-assets', name!)))).toBe(true)
    }
    const updateManifestPath = join(output, 'release-assets', 'update-manifest.json')
    const updateManifestBytes = readFileSync(updateManifestPath, 'utf8')
    expect(updateManifestBytes.endsWith('\n')).toBe(true)
    const updateManifest = JSON.parse(updateManifestBytes)
    expect(updateManifest).toMatchObject({
      schema: 1,
      kind: 'agent-inbox-update-manifest',
      repository: 'shariqh/agent-inbox',
      version: '1.0.1',
      tag: 'v1.0.1',
      source: {
        commit: sourceCommit,
        tree: sourceTree,
      },
      publishedAt: taggedAt,
      signingKeyId: 'ed25519-99927ba2f6af6482',
      trustedKeyIds: ['ed25519-99927ba2f6af6482'],
    })
    expect(updateManifest.targets).toHaveLength(5)
    expect(updateManifest.targets.map((target: {
      platform: string
      architecture: string
      packageType: string
    }) => `${target.platform}/${target.architecture}/${target.packageType}`)).toEqual([
      'darwin/universal/dmg',
      'linux/arm64/appimage',
      'linux/arm64/deb',
      'linux/x64/appimage',
      'linux/x64/deb',
    ])
    expect(updateManifest.targets.map((target: { filename: string }) => target.filename).sort())
      .toEqual(lines.map((line) => line.slice(66)).sort())
    for (const target of updateManifest.targets) {
      const checksum = lines.find((line) => line.endsWith(`  ${target.filename}`))
      expect(checksum?.slice(0, 64)).toBe(target.sha256)
      expect(target.byteLength).toBe(
        readFileSync(join(output, 'release-assets', target.filename)).byteLength,
      )
    }
    const aggregateEvidence = readFileSync(result.evidencePath, 'utf8')
    expect(aggregateEvidence).not.toContain(output)
    expect(aggregateEvidence).not.toContain(basename(mac.evidence))
    expect(JSON.parse(aggregateEvidence).updateManifest).toEqual({
      name: 'update-manifest.json',
      size: Buffer.byteLength(updateManifestBytes),
      sha256: sha256Bytes(updateManifestBytes),
      keyRegistrySha256: sha256File(join(root, 'release/update-keys.json')),
    })
  })

  it('marks PR/manual aggregation evidence non-publishable while proving the complete inventory', () => {
    const linux = makeLinuxFixture()
    const mac = makeMacDryRunFixture()
    const evidence = validateDryRunReleaseArtifacts({
      artifactsRoot: linux.root,
      macArtifactsRoot: mac,
      context: {
        schema: 1,
        tag: null,
        version: context.version,
        sourceCommit,
        annotated: false,
      },
      repoRoot: root,
      sourceTree,
    })

    expect(evidence).toMatchObject({
      annotatedTag: false,
      publishable: false,
      verification: {
        releaseMutation: 'disabled',
      },
    })
    expect(evidence.expectedPublicInventory).toEqual([
      'Agent-Inbox-v1.0.1-linux-arm64.AppImage',
      'Agent-Inbox-v1.0.1-linux-x86_64.AppImage',
      'Agent-Inbox-v1.0.1-universal.dmg',
      'agent-inbox_1.0.1_amd64.deb',
      'agent-inbox_1.0.1_arm64.deb',
      'SHA256SUMS.txt',
      'update-manifest.json',
      'update-manifest.json.sig',
    ])
    expect(evidence.assets.find((asset) => asset.platform === 'macos')).toMatchObject({
      provisional: true,
      notarized: false,
    })
  })
})
