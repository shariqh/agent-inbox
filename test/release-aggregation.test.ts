import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  aggregateReleaseAssets,
  validateDryRunReleaseArtifacts,
  validateLinuxReleaseArtifacts,
} from '../scripts/release-aggregation.mjs'
import { loadLinuxReleaseInputs } from '../scripts/linux-release-inputs.mjs'
import { generateManifest, parseRegistry } from '../scripts/update-manifest.mjs'
import { scratchDir } from './scratch.js'

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
  const path = scratchDir('release-aggregation-')
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

  const linuxInputsPath = join(root, 'release/linux-inputs.json')
  const linuxInputs = loadLinuxReleaseInputs(linuxInputsPath)
  const linuxInputsSha256 = sha256File(linuxInputsPath)
  const common = {
    schema: 1,
    product: 'Agent Inbox',
    packageVersion: context.version,
    artifactFile: artifactName,
    sourceCommit,
    sourceDirty: false,
    linuxInputsSha256,
    setupRuntimeKeys: [target],
    electronVersion: linuxInputs.electron.version,
    nodeVersion: linuxInputs.node.version,
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
        electronVersion: linuxInputs.electron.version,
        nodeVersion: linuxInputs.node.version,
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
        electronVersion: linuxInputs.electron.version,
        nodeVersion: linuxInputs.node.version,
        exactHostSetupSelection: 'passed',
      }
  writeJson(join(reportsDir, verifyName), verification)
  writeJson(join(reportsDir, `${target}-runtime.json`), {
    key: target,
    archiveSha256: linuxInputs.node.distributions[target].sha256,
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
    electronSqliteCheck: 'passed',
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

const identity = 'Developer ID Application: Release Test (AB12CD34EF)'
const UNIVERSAL = ['arm64', 'x86_64']

// The notarize job's output: the final DMG, its checksum and release-evidence.json, with
// the CPU types verify-final-dmg measured in the app copied out of it (#341).
function makeMacFixture({
  dmgName = 'Agent-Inbox-v1.0.1-universal.dmg',
  architectures = UNIVERSAL,
  kind = 'universal',
}: { dmgName?: string; architectures?: string[]; kind?: string } = {}) {
  const macRoot = tempDir()
  const assets = join(macRoot, 'release-assets')
  mkdirSync(assets)
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
    identity,
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
      identity,
      teamId: 'AB12CD34EF',
      dmgSignatureIdentity: 'passed',
      copiedAppCodesign: 'passed',
      copiedAppStapler: 'passed',
      copiedAppGatekeeper: 'passed',
      architectures: { executable: architectures, betterSqlite3: architectures },
      kind,
      runtimeManifests: 'passed',
      releaseSetupInfo: 'passed',
      loopbackLaunch: 'passed',
      portableRuntimeLifecycle: 'passed',
    },
    ...(kind === 'universal'
      ? {
          nativeIntel: {
            schema: 1,
            status: 'passed',
            runner: 'native-intel',
            sourceCommit,
            packageVersion: context.version,
            identity,
            teamId: 'AB12CD34EF',
            appArchiveSha256: 'c'.repeat(64),
            appTreeDigest: `sha256:${'d'.repeat(64)}`,
            verificationReportSha256: 'e'.repeat(64),
            codesign: 'passed',
            x64RuntimeManifest: 'passed',
            x64RuntimeSelftest: 'passed',
          },
        }
      : {}),
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

// A copy of the repository's release inputs whose committed expected set is arm64 alone,
// which only a deliberate change to release/macos-inputs.json can make (#341).
function arm64Repo() {
  const repo = tempDir()
  cpSync(join(root, 'release'), join(repo, 'release'), { recursive: true })
  const inputsPath = join(repo, 'release', 'macos-inputs.json')
  writeJson(inputsPath, { ...JSON.parse(readFileSync(inputsPath, 'utf8')), macosArchitectures: ['arm64'] })
  return repo
}

function makeMacDryRunFixture(repo = root) {
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
    ['macos-inputs.json', readFileSync(join(repo, 'release/macos-inputs.json'), 'utf8')],
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

  it('requires Electron-embedded SQLite check evidence from every native thin folder (#135)', () => {
    const fixture = makeLinuxFixture()
    const thinReport = join(fixture.root, 'linux-arm64-deb', 'thin', 'linux-arm64', 'Agent Inbox.thin-report.json')
    const thin = JSON.parse(readFileSync(thinReport, 'utf8')) as Record<string, unknown>
    delete thin.electronSqliteCheck
    writeJson(thinReport, thin)
    expect(() => validateLinuxReleaseArtifacts({
      artifactsRoot: fixture.root,
      context,
      repoRoot: root,
      sourceTree,
    })).toThrow(/linux-arm64-deb thin report lacks the Electron-embedded SQLite check \(#135\)/)
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

  it('keeps a universal release byte for byte, deriving its labels from the measured CPU types (#341)', () => {
    const linux = makeLinuxFixture()
    const mac = makeMacFixture()
    const output = tempDir()
    aggregateReleaseAssets({
      artifactsRoot: linux.root,
      macAssetsDir: mac.assets,
      macEvidencePath: mac.evidence,
      context,
      repoRoot: root,
      sourceTree,
      outputDir: output,
    })
    const assets = join(output, 'release-assets')
    const packages = [
      mac.dmg,
      linux.paths.arm64AppImage,
      linux.paths.arm64Deb,
      linux.paths.x64AppImage,
      linux.paths.x64Deb,
    ]
    for (const source of packages) {
      expect(readFileSync(join(assets, basename(source))).equals(readFileSync(source)), basename(source)).toBe(true)
    }
    // What aggregation wrote before #341, with the macOS labels as constants.
    const before = generateManifest({
      registry: parseRegistry(readFileSync(join(root, 'release', 'update-keys.json'))),
      evidence: {
        tag: context.tag,
        packageVersion: context.version,
        sourceCommit,
        sourceTree,
        assets: [
          { name: 'Agent-Inbox-v1.0.1-universal.dmg', packageType: 'dmg', platform: 'darwin', architecture: 'universal' },
          { name: basename(linux.paths.arm64AppImage), packageType: 'appimage', platform: 'linux', architecture: 'arm64' },
          { name: basename(linux.paths.arm64Deb), packageType: 'deb', platform: 'linux', architecture: 'arm64' },
          { name: basename(linux.paths.x64AppImage), packageType: 'appimage', platform: 'linux', architecture: 'x64' },
          { name: basename(linux.paths.x64Deb), packageType: 'deb', platform: 'linux', architecture: 'x64' },
        ].map((asset, index) => ({
          ...asset,
          size: readFileSync(packages[index]!).byteLength,
          sha256: sha256File(packages[index]!),
        })) as Parameters<typeof generateManifest>[0]['evidence']['assets'],
      },
      minimumMacosVersion: '13.5',
      publishedAt: taggedAt,
    })
    expect(readFileSync(join(assets, 'update-manifest.json')).equals(before.bytes)).toBe(true)
    expect(readFileSync(join(assets, 'SHA256SUMS.txt'), 'utf8')).toBe(
      [...packages]
        .map((path) => basename(path))
        .sort()
        .map((name) => `${sha256File(join(assets, name))}  ${name}\n`)
        .join(''),
    )

    const evidence = JSON.parse(readFileSync(join(output, 'release-aggregation-evidence.json'), 'utf8'))
    expect(evidence.assets.find((asset: { platform: string }) => asset.platform === 'macos')).toEqual({
      name: 'Agent-Inbox-v1.0.1-universal.dmg',
      packageType: 'DMG',
      platform: 'macos',
      architecture: 'universal',
      target: 'darwin-arm64+darwin-x64',
      architectures: { executable: UNIVERSAL, betterSqlite3: UNIVERSAL },
      nativeIntel: 'passed',
      size: readFileSync(mac.dmg).byteLength,
      sha256: sha256File(mac.dmg),
      notarization: { appStatus: 'Accepted', dmgStatus: 'Accepted' },
    })
  })

  it('refuses macOS evidence whose measured CPU types differ from the committed expected set (#341)', () => {
    const mac = makeMacFixture({ architectures: ['arm64'], kind: 'arm64' })
    const output = tempDir()
    expect(() => aggregateReleaseAssets({
      artifactsRoot: makeLinuxFixture().root,
      macAssetsDir: mac.assets,
      macEvidencePath: mac.evidence,
      context,
      repoRoot: root,
      sourceTree,
      outputDir: output,
    })).toThrow(/\["arm64"\] differ from the expected \["arm64","x86_64"\]/)
    expect(readdirSync(output)).toEqual([])
  })

  it('refuses an arm64 release until the v2 manifest can describe it (#343)', () => {
    const mac = makeMacFixture({ dmgName: 'Agent-Inbox-v1.0.1-arm64.dmg', architectures: ['arm64'], kind: 'arm64' })
    const output = tempDir()
    expect(() => aggregateReleaseAssets({
      artifactsRoot: makeLinuxFixture().root,
      macAssetsDir: mac.assets,
      macEvidencePath: mac.evidence,
      context,
      repoRoot: arm64Repo(),
      sourceTree,
      outputDir: output,
    })).toThrow(/an arm64 macOS release needs the v2 update manifest \(#343\)/)
    expect(readdirSync(output)).toEqual([])
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
      expectedPublicName: 'Agent-Inbox-v1.0.1-universal.dmg',
      architecture: 'universal',
      provisional: true,
      notarized: false,
    })
  })

  it('derives the dry run\'s public macOS name from the committed expected set (#341)', () => {
    const repo = arm64Repo()
    const evidence = validateDryRunReleaseArtifacts({
      artifactsRoot: makeLinuxFixture().root,
      macArtifactsRoot: makeMacDryRunFixture(repo),
      context: {
        schema: 1,
        tag: null,
        version: context.version,
        sourceCommit,
        annotated: false,
      },
      repoRoot: repo,
      sourceTree,
    })
    expect(evidence.assets.find((asset) => asset.platform === 'macos')).toMatchObject({
      expectedPublicName: 'Agent-Inbox-v1.0.1-arm64.dmg',
      architecture: 'arm64',
    })
    expect(evidence.expectedPublicInventory).toEqual([
      'Agent-Inbox-v1.0.1-arm64.dmg',
      'Agent-Inbox-v1.0.1-linux-arm64.AppImage',
      'Agent-Inbox-v1.0.1-linux-x86_64.AppImage',
      'agent-inbox_1.0.1_amd64.deb',
      'agent-inbox_1.0.1_arm64.deb',
      'SHA256SUMS.txt',
      'update-manifest.json',
      'update-manifest.json.sig',
    ])
  })
})
