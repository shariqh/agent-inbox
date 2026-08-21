import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validatePublicationInputs,
  validateReleaseContext,
} from './macos-release-gates.mjs'

const SHA_RE = /^[0-9a-f]{40}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const APPIMAGE_MODE = 0o755
const DATA_MODE = 0o644

const PROFILES = [
  {
    key: 'linux-x64-appimage',
    kind: 'appimage',
    target: 'linux-x64',
    processArch: 'x64',
    packageArch: 'x86_64',
    inputManifest: 'release/linux-appimage-x64.json',
    artifactName: (version) => `Agent-Inbox-v${version}-linux-x86_64.AppImage`,
    verifyName: 'linux-x64-appimage-verify.json',
  },
  {
    key: 'linux-arm64-appimage',
    kind: 'appimage',
    target: 'linux-arm64',
    processArch: 'arm64',
    packageArch: 'aarch64',
    inputManifest: 'release/linux-appimage-arm64.json',
    artifactName: (version) => `Agent-Inbox-v${version}-linux-arm64.AppImage`,
    verifyName: 'linux-arm64-appimage-verify.json',
  },
  {
    key: 'linux-x64-deb',
    kind: 'deb',
    target: 'linux-x64',
    processArch: 'x64',
    packageArch: 'amd64',
    inputManifest: 'release/linux-deb.json',
    artifactName: (version) => `agent-inbox_${version}_amd64.deb`,
    verifyName: 'linux-x64-deb-verify.json',
  },
  {
    key: 'linux-arm64-deb',
    kind: 'deb',
    target: 'linux-arm64',
    processArch: 'arm64',
    packageArch: 'arm64',
    inputManifest: 'release/linux-deb.json',
    artifactName: (version) => `agent-inbox_${version}_arm64.deb`,
    verifyName: 'linux-arm64-deb-verify.json',
  },
]

export class ReleaseAggregationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleaseAggregationError'
  }
}

function fail(message) {
  throw new ReleaseAggregationError(message)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readJson(path, label) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object`)
  }
  return value
}

function assertPlainFile(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a plain regular file`)
  if (stat.size <= 0) fail(`${label} must be nonempty`)
  return stat
}

function assertPlainDirectory(path, label) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a plain directory`)
}

function listFiles(root) {
  assertPlainDirectory(root, 'artifact root')
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) fail(`artifact tree contains a symlink: ${entry.name}`)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
      else fail(`artifact tree contains an unsupported entry: ${entry.name}`)
    }
  }
  visit(root)
  return files.sort()
}

function exact(actual, expected, label) {
  const left = [...actual].sort()
  const right = [...expected].sort()
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`${label} allowlist mismatch: expected ${right.join(', ')}, found ${left.join(', ')}`)
  }
}

function expectedArtifactPaths(profile, version) {
  const name = profile.artifactName(version)
  const directory = profile.kind === 'appimage' ? 'appimage' : 'deb'
  return [
    `${directory}/${name}`,
    `${directory}/${name}.sha256`,
    `${directory}/${name}.report.json`,
    `reports/${profile.verifyName}`,
    `reports/${profile.target}-runtime.json`,
    `reports/${profile.target}-runtime-verify.json`,
    `thin/${profile.target}/Agent Inbox.thin-report.json`,
  ]
}

function manifestDigests(repoRoot) {
  return {
    linuxInputsSha256: sha256File(join(repoRoot, 'release/linux-inputs.json')),
    linuxAppImageArm64Sha256: sha256File(join(repoRoot, 'release/linux-appimage-arm64.json')),
    linuxAppImageX64Sha256: sha256File(join(repoRoot, 'release/linux-appimage-x64.json')),
    linuxDebSha256: sha256File(join(repoRoot, 'release/linux-deb.json')),
    macosInputsSha256: sha256File(join(repoRoot, 'release/macos-inputs.json')),
  }
}

function assertReportSubset(report, verification, label) {
  for (const [key, value] of Object.entries(verification)) {
    if (JSON.stringify(report[key]) !== JSON.stringify(value)) {
      fail(`${label} verification report mismatch for ${key}`)
    }
  }
}

function validateAuxiliaryReports({ artifactRoot, profile, context, linuxInputs }) {
  const runtime = readJson(
    join(artifactRoot, 'reports', `${profile.target}-runtime.json`),
    `${profile.key} runtime report`,
  )
  const expectedDistribution = linuxInputs.node?.distributions?.[profile.target]
  if (
    runtime.key !== profile.target ||
    runtime.archiveSha256 !== expectedDistribution?.sha256
  ) {
    fail(`${profile.key} runtime archive identity mismatch`)
  }

  const runtimeVerify = readJson(
    join(artifactRoot, 'reports', `${profile.target}-runtime-verify.json`),
    `${profile.key} runtime verification`,
  )
  if (
    runtimeVerify.packageVersion !== context.version ||
    runtimeVerify.sourceCommit !== context.sourceCommit ||
    runtimeVerify.platform !== 'linux' ||
    runtimeVerify.arch !== profile.processArch
  ) {
    fail(`${profile.key} runtime verification source/version/architecture mismatch`)
  }

  const thin = readJson(
    join(artifactRoot, 'thin', profile.target, 'Agent Inbox.thin-report.json'),
    `${profile.key} thin report`,
  )
  if (
    thin.packageVersion !== context.version ||
    thin.sourceCommit !== context.sourceCommit
  ) {
    fail(`${profile.key} thin report source/version mismatch`)
  }
  if (thin.target !== undefined && thin.target !== profile.target) {
    fail(`${profile.key} thin report target mismatch`)
  }
}

function validateProfile({
  artifactsRoot,
  context,
  repoRoot,
  manifests,
  linuxInputs,
  profile,
}) {
  const artifactRoot = join(artifactsRoot, profile.key)
  assertPlainDirectory(artifactRoot, `${profile.key} root`)
  exact(
    listFiles(artifactRoot),
    expectedArtifactPaths(profile, context.version),
    `${profile.key} artifact`,
  )
  const name = profile.artifactName(context.version)
  const packageDirectory = profile.kind === 'appimage' ? 'appimage' : 'deb'
  const artifact = join(artifactRoot, packageDirectory, name)
  const checksum = `${artifact}.sha256`
  const reportPath = `${artifact}.report.json`
  const verificationPath = join(artifactRoot, 'reports', profile.verifyName)
  const stat = assertPlainFile(artifact, `${profile.key} package`)
  assertPlainFile(checksum, `${profile.key} checksum`)
  assertPlainFile(reportPath, `${profile.key} build report`)
  assertPlainFile(verificationPath, `${profile.key} verification report`)
  const digest = sha256File(artifact)
  if (readFileSync(checksum, 'utf8') !== `${digest}  ${name}\n`) {
    fail(`${profile.key} checksum is stale or malformed`)
  }

  const report = readJson(reportPath, `${profile.key} build report`)
  const verification = readJson(verificationPath, `${profile.key} verification report`)
  assertReportSubset(report, verification, profile.key)
  if (report.schema !== 1 || verification.schema !== 1) {
    fail(`${profile.key} report schema mismatch`)
  }
  if (report.packageVersion !== context.version) {
    fail(`${profile.key} package version mismatch`)
  }
  if (report.sourceCommit !== context.sourceCommit) {
    fail(`${profile.key} source commit mismatch`)
  }
  if (report.sourceDirty !== false) fail(`${profile.key} source must be clean`)
  if (report.artifactFile !== name) fail(`${profile.key} artifact name mismatch`)
  if (report.linuxInputsSha256 !== manifests.linuxInputsSha256) {
    fail(`${profile.key} Linux input manifest mismatch`)
  }
  if (
    JSON.stringify(report.setupRuntimeKeys) !== JSON.stringify([profile.target]) ||
    report.exactHostSetupSelection !== 'passed'
  ) {
    fail(`${profile.key} Setup runtime selection mismatch`)
  }
  if (
    report.electronVersion !== linuxInputs.electron?.version ||
    report.nodeVersion !== linuxInputs.node?.version
  ) {
    fail(`${profile.key} bundled runtime version mismatch`)
  }
  if (report.chromeSandboxMode !== 0o4755) {
    fail(`${profile.key} Chromium sandbox mode mismatch`)
  }

  let reportDigest
  if (profile.kind === 'appimage') {
    reportDigest = report.appImageSha256
    if (
      report.artifactArchitecture !== profile.packageArch ||
      report.appImageSize !== stat.size ||
      report.appImageInputsSha256 !== sha256File(join(repoRoot, profile.inputManifest))
    ) {
      fail(`${profile.key} AppImage architecture/size/input identity mismatch`)
    }
  } else {
    reportDigest = report.debSha256
    if (
      report.arch !== profile.processArch ||
      report.debArchitecture !== profile.packageArch ||
      report.debSize !== stat.size ||
      report.debInputsSha256 !== manifests.linuxDebSha256
    ) {
      fail(`${profile.key} DEB architecture/size/input identity mismatch`)
    }
  }
  if (reportDigest !== digest) fail(`${profile.key} package SHA-256 mismatch`)
  validateAuxiliaryReports({ artifactRoot, profile, context, linuxInputs })

  return {
    source: artifact,
    evidence: {
      name,
      packageType: profile.kind === 'appimage' ? 'AppImage' : 'DEB',
      platform: 'linux',
      architecture: profile.packageArch,
      target: profile.target,
      size: stat.size,
      sha256: digest,
      reportSha256: sha256File(reportPath),
      verificationReportSha256: sha256File(verificationPath),
      inputManifestSha256: sha256File(join(repoRoot, profile.inputManifest)),
    },
  }
}

function validateAggregationContext(context, publishable) {
  if (publishable) return validateReleaseContext(context)
  if (
    context?.schema !== 1 ||
    context.tag !== null ||
    !VERSION_RE.test(context.version ?? '') ||
    !SHA_RE.test(context.sourceCommit ?? '') ||
    context.annotated !== false ||
    Object.keys(context).sort().join(',') !== 'annotated,schema,sourceCommit,tag,version'
  ) {
    fail('dry-run release context is malformed')
  }
  return context
}

function validateLinux({
  artifactsRoot,
  context,
  repoRoot,
  sourceTree,
  publishable = true,
}) {
  const release = validateAggregationContext(context, publishable)
  if (!SHA_RE.test(sourceTree)) fail('source tree must be a full lowercase Git SHA')
  const resolvedRoot = resolve(artifactsRoot)
  assertPlainDirectory(resolvedRoot, 'Linux handoff root')
  exact(readdirSync(resolvedRoot), PROFILES.map((profile) => profile.key), 'Linux handoff')
  const resolvedRepo = resolve(repoRoot)
  const manifests = manifestDigests(resolvedRepo)
  const linuxInputs = readJson(join(resolvedRepo, 'release/linux-inputs.json'), 'Linux inputs')
  const validated = PROFILES.map((profile) => validateProfile({
    artifactsRoot: resolvedRoot,
    context: release,
    repoRoot: resolvedRepo,
    manifests,
    linuxInputs,
    profile,
  }))
  validated.sort((left, right) => left.evidence.name < right.evidence.name ? -1 : 1)
  const assets = validated.map(({ evidence }) => evidence)
  return {
    sources: new Map(validated.map(({ evidence, source }) => [evidence.name, source])),
    evidence: {
      schema: 1,
      product: 'Agent Inbox',
      tag: release.tag,
      packageVersion: release.version,
      sourceCommit: release.sourceCommit,
      sourceTree,
      annotatedTag: publishable,
      publishable,
      manifests,
      assets,
      verification: {
        exactArtifactAllowlist: 'passed',
        packageChecksums: 'passed',
        packageReports: 'passed',
        nativeWorkflowEvidence: 'passed',
      },
    },
  }
}

export function validateLinuxReleaseArtifacts(options) {
  return validateLinux(options).evidence
}

function validateDryRunMac({ macArtifactsRoot, context, repoRoot }) {
  const base = `Agent-Inbox-${context.version}-macos-universal-adhoc`
  const names = [
    `${base}.tar.gz`,
    `${base}-provisional.dmg`,
    `${base}-verification.json`,
    `${base}-metadata.json`,
    'macos-inputs.json',
  ]
  const expected = [...names, 'SHA256SUMS', 'SHA256SUMS.json']
  const root = resolve(macArtifactsRoot)
  assertPlainDirectory(root, 'macOS dry-run root')
  exact(listFiles(root), expected, 'macOS dry-run artifact')
  for (const name of expected) assertPlainFile(join(root, name), `macOS dry-run ${name}`)

  const checksumJson = readJson(join(root, 'SHA256SUMS.json'), 'macOS dry-run checksums')
  exact(Object.keys(checksumJson), names, 'macOS dry-run checksum')
  const expectedText = `${names.map((name) => {
    const digest = sha256File(join(root, name))
    if (checksumJson[name] !== digest) fail(`macOS dry-run checksum mismatch for ${name}`)
    return `${digest}  ${name}`
  }).join('\n')}\n`
  if (readFileSync(join(root, 'SHA256SUMS'), 'utf8') !== expectedText) {
    fail('macOS dry-run SHA256SUMS is stale or malformed')
  }

  const report = readJson(join(root, `${base}-verification.json`), 'macOS dry-run report')
  const metadata = readJson(join(root, `${base}-metadata.json`), 'macOS dry-run metadata')
  for (const value of [report, metadata]) {
    if (
      value.schema !== 1 ||
      value.packageVersion !== context.version ||
      value.sourceCommit !== context.sourceCommit ||
      value.sourceDirty !== false ||
      value.buildMode !== 'adhoc' ||
      value.provisional !== true ||
      value.notarized !== false
    ) {
      fail('macOS dry-run source/version/disposition mismatch')
    }
  }
  if (
    report.notaryEligible !== false ||
    report.validationEvidenceOnly !== true ||
    sha256File(join(root, 'macos-inputs.json')) !== sha256File(join(repoRoot, 'release/macos-inputs.json'))
  ) {
    fail('macOS dry-run evidence must be non-publishable and use exact inputs')
  }
  return {
    name: `${base}-provisional.dmg`,
    expectedPublicName: `Agent-Inbox-v${context.version}-universal.dmg`,
    packageType: 'DMG',
    platform: 'macos',
    architecture: 'universal',
    size: lstatSync(join(root, `${base}-provisional.dmg`)).size,
    sha256: sha256File(join(root, `${base}-provisional.dmg`)),
    provisional: true,
    notarized: false,
  }
}

export function validateDryRunReleaseArtifacts({
  artifactsRoot,
  macArtifactsRoot,
  context,
  repoRoot,
  sourceTree,
}) {
  const release = validateAggregationContext(context, false)
  const linux = validateLinux({
    artifactsRoot,
    context: release,
    repoRoot,
    sourceTree,
    publishable: false,
  })
  const mac = validateDryRunMac({
    macArtifactsRoot,
    context: release,
    repoRoot: resolve(repoRoot),
  })
  return {
    schema: 1,
    product: 'Agent Inbox',
    tag: null,
    packageVersion: release.version,
    sourceCommit: release.sourceCommit,
    sourceTree,
    annotatedTag: false,
    publishable: false,
    manifests: linux.evidence.manifests,
    assets: [...linux.evidence.assets, mac]
      .sort((left, right) => left.name < right.name ? -1 : 1),
    expectedPublicInventory: [
      `Agent-Inbox-v${release.version}-linux-arm64.AppImage`,
      `Agent-Inbox-v${release.version}-linux-x86_64.AppImage`,
      `Agent-Inbox-v${release.version}-universal.dmg`,
      `agent-inbox_${release.version}_amd64.deb`,
      `agent-inbox_${release.version}_arm64.deb`,
      'SHA256SUMS.txt',
    ],
    verification: {
      linuxNativePackages: 'passed',
      macosAdhocPackage: 'passed',
      exactDryRunAllowlist: 'passed',
      releaseMutation: 'disabled',
    },
  }
}

function prepareOutput(outputDir) {
  const output = resolve(outputDir)
  assertPlainDirectory(output, 'release aggregation output')
  if (readdirSync(output).length !== 0) fail('release aggregation output directory must be empty')
  const assets = join(output, 'release-assets')
  mkdirSync(assets)
  return { output, assets }
}

function copyPackage(source, destination) {
  const mode = lstatSync(source).mode & 0o777
  copyFileSync(source, destination)
  chmodSync(destination, mode)
}

export function aggregateReleaseAssets({
  artifactsRoot,
  macAssetsDir,
  macEvidencePath,
  context,
  repoRoot,
  sourceTree,
  outputDir,
}) {
  const release = validateReleaseContext(context)
  const linux = validateLinux({ artifactsRoot, context: release, repoRoot, sourceTree })
  const mac = validatePublicationInputs({
    assetsDir: resolve(macAssetsDir),
    evidencePath: resolve(macEvidencePath),
    context: release,
  })
  const { output, assets } = prepareOutput(outputDir)
  const sources = new Map(linux.sources)
  const dmgName = `Agent-Inbox-${release.tag}-universal.dmg`
  sources.set(dmgName, mac.dmg)
  const packageNames = [...sources.keys()].sort()
  for (const name of packageNames) copyPackage(sources.get(name), join(assets, name))

  const checksumText = packageNames
    .map((name) => `${sha256File(join(assets, name))}  ${name}\n`)
    .join('')
  const checksumPath = join(assets, 'SHA256SUMS.txt')
  writeFileSync(checksumPath, checksumText, { mode: DATA_MODE })
  chmodSync(checksumPath, DATA_MODE)
  for (const name of packageNames.filter((name) => name.endsWith('.AppImage'))) {
    chmodSync(join(assets, name), APPIMAGE_MODE)
  }

  const macStat = assertPlainFile(mac.dmg, 'final notarized DMG')
  const macEvidence = readJson(resolve(macEvidencePath), 'macOS release evidence')
  const evidence = {
    schema: 1,
    product: 'Agent Inbox',
    tag: release.tag,
    packageVersion: release.version,
    sourceCommit: release.sourceCommit,
    sourceTree,
    annotatedTag: true,
    publishable: true,
    manifests: linux.evidence.manifests,
    assets: [
      ...linux.evidence.assets,
      {
        name: dmgName,
        packageType: 'DMG',
        platform: 'macos',
        architecture: 'universal',
        target: 'darwin-arm64+darwin-x64',
        size: macStat.size,
        sha256: sha256File(mac.dmg),
        notarization: {
          appStatus: macEvidence.appNotarization.status,
          dmgStatus: macEvidence.dmgNotarization.status,
        },
      },
    ].sort((left, right) => left.name < right.name ? -1 : 1),
    checksumManifest: {
      name: basename(checksumPath),
      entries: packageNames,
      sha256: sha256File(checksumPath),
      size: lstatSync(checksumPath).size,
    },
    verification: {
      linuxHandoff: 'passed',
      macosNotarization: 'passed',
      exactReleaseAllowlist: 'passed',
      deterministicChecksums: 'passed',
    },
  }
  const evidencePath = join(output, 'release-aggregation-evidence.json')
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: DATA_MODE })
  return {
    assetNames: [...packageNames, 'SHA256SUMS.txt'],
    assetsDir: assets,
    evidencePath,
  }
}

function writeJson(path, value) {
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { mode: DATA_MODE })
}

function main(argv) {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: {
      'artifacts-root': { type: 'string' },
      'mac-assets': { type: 'string' },
      'mac-evidence': { type: 'string' },
      context: { type: 'string' },
      'repo-root': { type: 'string', default: process.cwd() },
      'source-tree': { type: 'string' },
      'mac-artifacts': { type: 'string' },
      version: { type: 'string' },
      'source-commit': { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
  })
  if (!values['artifacts-root'] || !values['source-tree'] || !values.output) {
    fail('release aggregation requires --artifacts-root, --source-tree, and --output')
  }
  if (command === 'dry-run') {
    if (!values['mac-artifacts'] || !values.version || !values['source-commit']) {
      fail('dry-run requires --mac-artifacts, --version, and --source-commit')
    }
    writeJson(values.output, validateDryRunReleaseArtifacts({
      artifactsRoot: values['artifacts-root'],
      macArtifactsRoot: values['mac-artifacts'],
      context: {
        schema: 1,
        tag: null,
        version: values.version,
        sourceCommit: values['source-commit'],
        annotated: false,
      },
      repoRoot: values['repo-root'],
      sourceTree: values['source-tree'],
    }))
    return
  }
  if (!values.context) fail(`${command ?? 'command'} requires --context`)
  const releaseContext = readJson(resolve(values.context), 'release context')
  if (command === 'linux-handoff') {
    writeJson(values.output, validateLinuxReleaseArtifacts({
      artifactsRoot: values['artifacts-root'],
      context: releaseContext,
      repoRoot: values['repo-root'],
      sourceTree: values['source-tree'],
    }))
    return
  }
  if (command === 'aggregate') {
    if (!values['mac-assets'] || !values['mac-evidence']) {
      fail('aggregate requires --mac-assets and --mac-evidence')
    }
    const result = aggregateReleaseAssets({
      artifactsRoot: values['artifacts-root'],
      macAssetsDir: values['mac-assets'],
      macEvidencePath: values['mac-evidence'],
      context: releaseContext,
      repoRoot: values['repo-root'],
      sourceTree: values['source-tree'],
      outputDir: values.output,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  fail(`unknown release aggregation command: ${command ?? '(missing)'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`release-aggregation: ${error.message}\n`)
    process.exitCode = 1
  }
}
