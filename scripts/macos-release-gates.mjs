#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadReleaseInputs, sha256File } from './release-inputs.mjs'
import { verifyPackagedUpdateTrust } from './package-update-trust.mjs'
import { verifyPayload } from './runtime-payload.mjs'
import { treeIdentity } from './tree-identity.mjs'

const APP_NAME = 'Agent Inbox'
const TAG_RE = /^v(\d+\.\d+\.\d+)$/
const SHA_RE = /^[0-9a-f]{40}$/
const UTC_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const TEAM_RE = /^[A-Z0-9]{10}$/
const KEY_ID_RE = /^[A-Z0-9]{10}$/
const ISSUER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTITY_RE = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/

export class ReleaseGateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleaseGateError'
  }
}

function git(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim()
  } catch (err) {
    throw new ReleaseGateError(`git ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`)
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ReleaseGateError(`could not read ${label} at ${path}: ${err.message}`)
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new ReleaseGateError(`${label} is missing or invalid`)
  }
  return value
}

function decodeBase64(value, label) {
  requireString(value, label, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new ReleaseGateError(`${label} is not canonical base64`)
  }
  return decoded
}

function annotatedTagTimestamp(repoRoot, tagRef) {
  const value = git(repoRoot, [
    'for-each-ref',
    '--format=%(taggerdate:iso8601-strict)',
    tagRef,
  ])
  const instant = new Date(value)
  if (!value || Number.isNaN(instant.getTime())) {
    throw new ReleaseGateError(`${tagRef} annotated tag timestamp is invalid`)
  }
  return instant.toISOString().replace('.000Z', 'Z')
}

export function validateReleaseTag({ repoRoot, ref, sha }) {
  const match = /^refs\/tags\/(v\d+\.\d+\.\d+)$/.exec(ref ?? '')
  if (!match) throw new ReleaseGateError('release ref must be an exact vX.Y.Z tag')
  const tag = match[1]
  const version = TAG_RE.exec(tag)?.[1]
  if (!version) throw new ReleaseGateError('release tag version is invalid')
  requireString(sha, 'checkout commit', SHA_RE)
  const tagRef = `refs/tags/${tag}`
  if (git(repoRoot, ['cat-file', '-t', tagRef]) !== 'tag') {
    throw new ReleaseGateError(`${tag} must be an annotated tag`)
  }
  const sourceCommit = git(repoRoot, ['rev-parse', `${tagRef}^{commit}`])
  const taggedAt = annotatedTagTimestamp(repoRoot, tagRef)
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  if (sourceCommit !== sha || head !== sha) {
    throw new ReleaseGateError(`annotated tag, checkout commit, and supplied source SHA must match (${sourceCommit}, ${head}, ${sha})`)
  }
  const pkg = readJson(join(repoRoot, 'package.json'), 'package.json')
  const lock = readJson(join(repoRoot, 'package-lock.json'), 'package-lock.json')
  if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new ReleaseGateError(
      `tag/package version mismatch: tag=${version}, package=${pkg.version}, lock=${lock.version}, lockRoot=${lock.packages?.['']?.version}`,
    )
  }
  if (git(repoRoot, ['status', '--porcelain', '--untracked-files=no'])) {
    throw new ReleaseGateError('release checkout has tracked working-tree changes')
  }
  return { schema: 1, tag, version, sourceCommit, taggedAt, annotated: true }
}

export function validateReleaseContext(value) {
  if (
    value?.schema !== 1 ||
    value.annotated !== true ||
    typeof value.tag !== 'string' ||
    !TAG_RE.test(value.tag) ||
    value.version !== TAG_RE.exec(value.tag)?.[1] ||
    typeof value.sourceCommit !== 'string' ||
    !SHA_RE.test(value.sourceCommit) ||
    typeof value.taggedAt !== 'string' ||
    !UTC_SECONDS_RE.test(value.taggedAt) ||
    Number.isNaN(new Date(value.taggedAt).getTime()) ||
    new Date(value.taggedAt).toISOString().replace('.000Z', 'Z') !== value.taggedAt ||
    Object.keys(value).sort().join(',') !== 'annotated,schema,sourceCommit,tag,taggedAt,version'
  ) {
    throw new ReleaseGateError('release context is malformed')
  }
  return value
}

function gitJsonAt(repoRoot, sourceCommit, path, label) {
  try {
    return JSON.parse(git(repoRoot, ['show', `${sourceCommit}:${path}`]))
  } catch (err) {
    throw new ReleaseGateError(`could not read ${label} from ${sourceCommit}: ${err.message}`)
  }
}

export function validateProtectedRelease({ repoRoot, context, trustedSha, runHeadSha }) {
  const release = validateReleaseContext(context)
  requireString(trustedSha, 'trusted workflow SHA', SHA_RE)
  requireString(runHeadSha, 'triggering workflow head SHA', SHA_RE)
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  if (head !== trustedSha) throw new ReleaseGateError('trusted workflow SHA does not match checkout HEAD')
  if (runHeadSha !== release.sourceCommit) {
    throw new ReleaseGateError('triggering workflow head SHA does not match release source')
  }
  const tagRef = `refs/tags/${release.tag}`
  if (git(repoRoot, ['cat-file', '-t', tagRef]) !== 'tag') {
    throw new ReleaseGateError(`${release.tag} must be an annotated tag`)
  }
  if (git(repoRoot, ['rev-parse', `${tagRef}^{commit}`]) !== release.sourceCommit) {
    throw new ReleaseGateError('peeled annotated-tag commit does not match release source')
  }
  if (annotatedTagTimestamp(repoRoot, tagRef) !== release.taggedAt) {
    throw new ReleaseGateError('annotated-tag timestamp does not match release context')
  }
  const firstParent = new Set(git(repoRoot, ['rev-list', '--first-parent', trustedSha]).split('\n'))
  if (!firstParent.has(release.sourceCommit)) {
    throw new ReleaseGateError('release tag commit is not on the trusted default branch first-parent history')
  }
  const pkg = gitJsonAt(repoRoot, release.sourceCommit, 'package.json', 'package.json')
  const lock = gitJsonAt(repoRoot, release.sourceCommit, 'package-lock.json', 'package-lock.json')
  if (
    pkg.version !== release.version ||
    lock.version !== release.version ||
    lock.packages?.['']?.version !== release.version
  ) {
    throw new ReleaseGateError('protected release tag/package version mismatch')
  }
  return { ...release, trustedSha, runHeadSha, firstParent: true }
}

export function validateCredentialEnvironment(env, scope) {
  if (scope === 'signing') {
    const { identity, teamId } = validateSigningIdentity({
      identity: env.APPLE_DEVELOPER_IDENTITY,
      teamId: env.APPLE_TEAM_ID,
    })
    if (decodeBase64(env.APPLE_DEVELOPER_ID_P12_BASE64, 'APPLE_DEVELOPER_ID_P12_BASE64').length < 8) {
      throw new ReleaseGateError('Developer ID P12 payload is unexpectedly short')
    }
    requireString(env.APPLE_DEVELOPER_ID_P12_PASSWORD, 'APPLE_DEVELOPER_ID_P12_PASSWORD')
    return { scope, identity, teamId }
  }
  if (scope === 'notary') {
    const key = decodeBase64(env.APPLE_NOTARY_PRIVATE_KEY_BASE64, 'APPLE_NOTARY_PRIVATE_KEY_BASE64')
    if (!key.toString('utf8').includes('-----BEGIN PRIVATE KEY-----')) {
      throw new ReleaseGateError('APPLE_NOTARY_PRIVATE_KEY_BASE64 does not contain a PEM private key')
    }
    const keyId = requireString(env.APPLE_NOTARY_KEY_ID, 'APPLE_NOTARY_KEY_ID', KEY_ID_RE)
    const issuerId = requireString(env.APPLE_NOTARY_ISSUER_ID, 'APPLE_NOTARY_ISSUER_ID', ISSUER_RE)
    return { scope, keyId, issuerId }
  }
  throw new ReleaseGateError('credential scope must be signing or notary')
}

export function validateSigningIdentity({ identity, teamId }) {
  requireString(identity, 'Developer ID identity', IDENTITY_RE)
  requireString(teamId, 'Developer ID team', TEAM_RE)
  const identityTeam = IDENTITY_RE.exec(identity)?.[1]
  if (identityTeam !== teamId) throw new ReleaseGateError('Developer ID identity and team ID differ')
  return { schema: 1, identity, teamId }
}

export function parseNotaryReceipt({ kind, submitted, submitJson, logJson }) {
  if (kind !== 'app' && kind !== 'dmg') throw new ReleaseGateError('notary receipt kind must be app or dmg')
  if (!existsSync(submitted)) throw new ReleaseGateError(`submitted artifact does not exist: ${submitted}`)
  const submit = readJson(submitJson, 'notary submit result')
  const log = readJson(logJson, 'notary log')
  const submissionId = requireString(submit.id, 'notary submission id', UUID_RE)
  if (submit.status !== 'Accepted') {
    throw new ReleaseGateError(`${kind} notarization was not Accepted: ${submit.status ?? 'missing status'}`)
  }
  if (log.jobId !== submissionId || log.status !== 'Accepted' || log.statusCode !== 0) {
    throw new ReleaseGateError(`${kind} notary log does not prove the accepted submission`)
  }
  const submittedName = basename(submitted)
  if (log.archiveFilename !== submittedName) {
    throw new ReleaseGateError(`notary log archive mismatch: expected ${submittedName}, found ${log.archiveFilename}`)
  }
  const submittedSha256 = sha256File(submitted)
  if (typeof log.sha256 !== 'string' || log.sha256.toLowerCase() !== submittedSha256) {
    throw new ReleaseGateError(`notary log SHA-256 does not match ${submittedName}`)
  }
  if (Array.isArray(log.issues) && log.issues.length > 0) {
    throw new ReleaseGateError(`${kind} notary log contains issues despite Accepted status`)
  }
  return {
    schema: 1,
    kind,
    submissionId,
    status: 'Accepted',
    submittedName,
    submittedSha256,
    statusCode: 0,
    statusSummary: typeof log.statusSummary === 'string' ? log.statusSummary : null,
    uploadDate: typeof log.uploadDate === 'string' ? log.uploadDate : null,
  }
}

function command(path, args, options = {}) {
  try {
    return execFileSync(path, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 120_000,
      env: options.env ?? process.env,
      cwd: options.cwd,
    }).trim()
  } catch (err) {
    throw new ReleaseGateError(`${basename(path)} ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`)
  }
}

function verifySignatureIdentity(path, identity, teamId, { deep = true } = {}) {
  const verifyArgs = ['--verify']
  if (deep) verifyArgs.push('--deep', '--strict')
  verifyArgs.push('--verbose=2', path)
  command('/usr/bin/codesign', verifyArgs)
  const inspected = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  if (inspected.status !== 0) {
    throw new ReleaseGateError(`could not inspect Developer ID signature: ${inspected.stderr.trim()}`)
  }
  const details = `${inspected.stdout}\n${inspected.stderr}`
  const authorities = [...details.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1])
  const actualTeam = /^TeamIdentifier=(.+)$/m.exec(details)?.[1]
  if (!authorities.includes(identity) || actualTeam !== teamId) {
    throw new ReleaseGateError(`Developer ID signature identity/team mismatch for ${path}`)
  }
}

export function verifyDeveloperIdApp({
  app,
  archive,
  reportPath,
  identity,
  teamId,
  sourceCommit,
  version,
  output,
}) {
  const report = readJson(reportPath, 'Developer ID verification report')
  if (
    report.schema !== 1 ||
    report.packageVersion !== version ||
    report.sourceCommit !== sourceCommit ||
    report.sourceDirty !== false ||
    report.buildMode !== 'developer-id' ||
    report.notaryEligible !== true ||
    report.signing !== 'developer-id' ||
    report.runtimeHashesUnchangedAfterOuterSign !== true
  ) {
    throw new ReleaseGateError('Developer ID report does not satisfy release gates')
  }
  const appTreeDigest = treeIdentity(app)
  if (report.appTreeDigest !== appTreeDigest) {
    throw new ReleaseGateError('Developer ID app bytes do not match the finalization report')
  }
  verifySignatureIdentity(app, identity, teamId)
  const bundleVersion = command('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleShortVersionString',
    join(app, 'Contents', 'Info.plist'),
  ])
  if (bundleVersion !== version) throw new ReleaseGateError(`app bundle version mismatch: ${bundleVersion}`)
  const inputs = loadReleaseInputs()
  const runtime = join(app, 'Contents', 'Resources', 'app', 'runtime', 'darwin-x64')
  verifyPayload({
    root: runtime,
    expect: {
      product: 'agent-inbox-runtime',
      packageVersion: version,
      sourceCommit,
      platform: 'darwin',
      arch: 'x64',
      nodeVersion: inputs.node.version,
      nodeModulesAbi: inputs.node.modulesAbi,
    },
  })
  const scratchDb = join(dirname(output), 'intel-selftest.db')
  command(join(runtime, 'bin', 'node'), [join(runtime, 'dist', 'hook-cli.js'), 'selftest'], {
    cwd: runtime,
    env: { ...process.env, AGENT_INBOX_DB: scratchDb },
  })
  const evidence = {
    schema: 1,
    status: 'passed',
    runner: 'native-intel',
    sourceCommit,
    packageVersion: version,
    identity,
    teamId,
    appArchiveSha256: sha256File(archive),
    appTreeDigest,
    verificationReportSha256: sha256File(reportPath),
    codesign: 'passed',
    x64RuntimeManifest: 'passed',
    x64RuntimeSelftest: 'passed',
  }
  writeJson(output, evidence)
  return evidence
}

export function validateIntelEvidence({
  archive,
  reportPath,
  evidencePath,
  identity,
  teamId,
  sourceCommit,
  version,
}) {
  const report = readJson(reportPath, 'Developer ID verification report')
  const evidence = readJson(evidencePath, 'native Intel evidence')
  if (
    evidence.schema !== 1 ||
    evidence.status !== 'passed' ||
    evidence.runner !== 'native-intel' ||
    evidence.sourceCommit !== sourceCommit ||
    evidence.packageVersion !== version ||
    evidence.identity !== identity ||
    evidence.teamId !== teamId ||
    evidence.appArchiveSha256 !== sha256File(archive) ||
    evidence.verificationReportSha256 !== sha256File(reportPath) ||
    evidence.appTreeDigest !== report.appTreeDigest ||
    evidence.codesign !== 'passed' ||
    evidence.x64RuntimeManifest !== 'passed' ||
    evidence.x64RuntimeSelftest !== 'passed'
  ) {
    throw new ReleaseGateError('native Intel evidence is stale or does not match the Developer ID app')
  }
  return evidence
}

export async function buildThinHandoff({
  arm64Archive,
  x64Archive,
  arm64App,
  x64App,
  arm64Report,
  x64Report,
  context,
}) {
  const release = validateReleaseContext(context)
  const { verifyThinReports } = await import('./assemble-macos-release.mjs')
  const reports = verifyThinReports({
    arm64App,
    x64App,
    arm64Report,
    x64Report,
    packageVersion: release.version,
    inputs: loadReleaseInputs(),
    provenance: { sourceCommit: release.sourceCommit, sourceDirty: false },
    mode: 'developer-id',
  })
  return {
    schema: 1,
    sourceCommit: release.sourceCommit,
    packageVersion: release.version,
    archives: {
      'thin-darwin-arm64.tar.gz': sha256File(arm64Archive),
      'thin-darwin-x64.tar.gz': sha256File(x64Archive),
    },
    appTreeDigests: {
      arm64: reports.arm64.appTreeDigest,
      x64: reports.x64.appTreeDigest,
    },
    verifiedByTrustedWorkflow: true,
  }
}

export function validateThinHandoff({ arm64Archive, x64Archive, evidencePath, context }) {
  const release = validateReleaseContext(context)
  const evidence = readJson(evidencePath, 'trusted thin handoff evidence')
  if (
    evidence.schema !== 1 ||
    evidence.sourceCommit !== release.sourceCommit ||
    evidence.packageVersion !== release.version ||
    evidence.verifiedByTrustedWorkflow !== true ||
    evidence.archives?.['thin-darwin-arm64.tar.gz'] !== sha256File(arm64Archive) ||
    evidence.archives?.['thin-darwin-x64.tar.gz'] !== sha256File(x64Archive) ||
    typeof evidence.appTreeDigests?.arm64 !== 'string' ||
    typeof evidence.appTreeDigests?.x64 !== 'string'
  ) {
    throw new ReleaseGateError('thin handoff does not match trusted preflight evidence')
  }
  return evidence
}

export async function buildFinalDmg({ app, version, appReceiptPath, output, icon }) {
  const { createDMG } = await import('electron-installer-dmg')
  const receipt = readJson(appReceiptPath, 'accepted app receipt')
  if (receipt.kind !== 'app' || receipt.status !== 'Accepted') {
    throw new ReleaseGateError('final DMG requires an accepted app notarization receipt')
  }
  command('/usr/bin/xcrun', ['stapler', 'validate', app])
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
  const expected = `Agent-Inbox-v${version}-universal.dmg`
  if (basename(output) !== expected) throw new ReleaseGateError(`final DMG must be named ${expected}`)
  mkdirSync(dirname(output), { recursive: true })
  await createDMG({
    appPath: app,
    name: APP_NAME,
    title: `${APP_NAME} v${version}`,
    icon,
    iconSize: 96,
    format: 'UDZO',
    overwrite: false,
    dmgPath: output,
    contents: [
      { x: 180, y: 220, type: 'file', path: app },
      { x: 480, y: 220, type: 'link', path: '/Applications' },
    ],
  })
  return output
}

export async function withMountedDmg({ dmg, mount, runCommand, verify }) {
  runCommand('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg])
  let result
  let failure
  try {
    result = await verify()
  } catch (err) {
    failure = err
  }
  try {
    runCommand('/usr/bin/hdiutil', ['detach', mount])
  } catch (err) {
    if (!failure) failure = err
  }
  if (failure) throw failure
  return result
}

function requireExactArchitectures(path, expected) {
  const actual = command('/usr/bin/lipo', ['-archs', path]).split(/\s+/).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new ReleaseGateError(`architecture mismatch for ${path}: ${actual.join(', ')}`)
  }
  return actual
}

function requireNonemptyFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new ReleaseGateError(`${label} is missing or empty: ${path}`)
  }
}

function requireMissingPlistKey(plist, key) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status === 0) throw new ReleaseGateError(`copied app carries stale Info.plist key ${key}`)
  if (result.status !== 1 || !/Does Not Exist/.test(result.stderr)) {
    throw new ReleaseGateError(`could not prove copied app Info.plist key ${key} is absent`)
  }
}

async function verifyCopiedAppLaunch({ app, scratch, runtime }) {
  const port = 20_000 + (process.pid % 20_000)
  mkdirSync(join(scratch, 'home'), { recursive: true })
  const appProcess = spawn(join(app, 'Contents', 'MacOS', APP_NAME), [], {
    env: {
      ...process.env,
      HOME: join(scratch, 'home'),
      AGENT_INBOX_DB: join(scratch, 'home', '.agent-inbox', 'inbox.db'),
      AGENT_INBOX_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let launched = false
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (appProcess.exitCode !== null) break
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })
        if (response.ok && response.headers.get('x-agent-inbox-local-boundary') === 'loopback-v1') {
          launched = true
          break
        }
      } catch {
        // The app may still be starting.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
    }
    if (!launched) throw new ReleaseGateError('copied app did not expose the hardened loopback boundary')
  } finally {
    if (appProcess.exitCode === null) {
      appProcess.kill('SIGTERM')
      await Promise.race([
        once(appProcess, 'exit'),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
      ])
      if (appProcess.exitCode === null) appProcess.kill('SIGKILL')
    }
  }

  const runtimeRoot = join(scratch, 'installed-runtimes')
  const installed = JSON.parse(command(join(runtime, 'bin', 'node'), [
    join(runtime, 'scripts', 'runtime-payload.mjs'),
    'install',
    '--payload-root', runtime,
    '--runtime-root', runtimeRoot,
  ]))
  requireString(installed.runtimeId, 'installed runtime ID')
  command(join(runtime, 'bin', 'node'), [
    join(runtime, 'scripts', 'runtime-payload.mjs'),
    'prune',
    '--runtime-root', runtimeRoot,
    '--runtime-id', installed.runtimeId,
  ])
  if (existsSync(join(runtimeRoot, installed.runtimeId))) {
    throw new ReleaseGateError('portable runtime prune left the installed runtime behind')
  }
}

export async function verifyFinalDmg({
  dmg,
  identity,
  teamId,
  sourceCommit,
  version,
  output,
  runCommand = command,
}) {
  if (process.platform !== 'darwin') throw new ReleaseGateError('final DMG verification requires macOS')
  verifySignatureIdentity(dmg, identity, teamId, { deep: false })
  const scratch = mkdtempSync(join(tmpdir(), 'agent-inbox-final-dmg-'))
  const mount = join(scratch, 'mount')
  const copiedApp = join(scratch, `${APP_NAME}.app`)
  mkdirSync(mount)
  try {
    const evidence = await withMountedDmg({
      dmg,
      mount,
      runCommand,
      verify: async () => {
        const visible = readdirSync(mount).filter((name) => !name.startsWith('.')).sort()
        if (JSON.stringify(visible) !== JSON.stringify([APP_NAME + '.app', 'Applications'].sort())) {
          throw new ReleaseGateError(`final DMG visible payload is invalid: ${visible.join(', ')}`)
        }
        const applications = join(mount, 'Applications')
        if (!lstatSync(applications).isSymbolicLink() || readlinkSync(applications) !== '/Applications') {
          throw new ReleaseGateError('final DMG Applications entry is not the expected /Applications link')
        }
        runCommand('/usr/bin/ditto', [join(mount, `${APP_NAME}.app`), copiedApp])
        verifySignatureIdentity(copiedApp, identity, teamId)
        runCommand('/usr/bin/xcrun', ['stapler', 'validate', copiedApp])
        runCommand('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', copiedApp])

        const contents = join(copiedApp, 'Contents')
        const resources = join(contents, 'Resources')
        const appResources = join(resources, 'app')
        const inputs = loadReleaseInputs()
        if (command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(contents, 'Info.plist')]) !== inputs.bundleId) {
          throw new ReleaseGateError('copied app bundle identifier mismatch')
        }
        if (command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(contents, 'Info.plist')]) !== version) {
          throw new ReleaseGateError('copied app version mismatch')
        }
        if (command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', join(contents, 'Info.plist')]) !== 'icon.icns') {
          throw new ReleaseGateError('copied app icon declaration mismatch')
        }
        if (
          command('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', join(contents, 'Info.plist')]) !==
          inputs.minimumMacosVersion
        ) {
          throw new ReleaseGateError('copied app minimum macOS version mismatch')
        }
        requireMissingPlistKey(join(contents, 'Info.plist'), 'AgentInboxNotarized')
        for (const [path, label] of [
          [join(resources, 'icon.icns'), 'application icon'],
          [join(resources, 'LICENSE.electron'), 'Electron license'],
          [join(resources, 'LICENSES.chromium.html'), 'Chromium notices'],
          [join(appResources, 'LICENSE.agent-inbox'), 'Agent Inbox license'],
        ]) requireNonemptyFile(path, label)
        verifyPackagedUpdateTrust(appResources)

        requireExactArchitectures(join(contents, 'MacOS', APP_NAME), ['arm64', 'x86_64'])
        requireExactArchitectures(
          join(appResources, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
          ['arm64', 'x86_64'],
        )
        const setup = JSON.parse(readFileSync(join(appResources, 'setup-info.json'), 'utf8'))
        if (
          setup.schema !== 2 ||
          setup.version !== version ||
          setup.commit !== sourceCommit ||
          'repoRoot' in setup ||
          'nodeBin' in setup ||
          JSON.stringify(Object.keys(setup.runtimePayloads ?? {}).sort()) !== JSON.stringify(['darwin-arm64', 'darwin-x64'])
        ) {
          throw new ReleaseGateError('copied app release setup-info is invalid')
        }
        for (const key of ['darwin-arm64', 'darwin-x64']) {
          const distribution = inputs.node.distributions[key]
          const runtime = join(appResources, 'runtime', key)
          verifyPayload({
            root: runtime,
            expect: {
              product: 'agent-inbox-runtime',
              packageVersion: version,
              sourceCommit,
              platform: distribution.platform,
              arch: distribution.arch,
              nodeVersion: inputs.node.version,
              nodeModulesAbi: inputs.node.modulesAbi,
            },
          })
          if (setup.runtimePayloads[key]?.digest !== `sha256:${sha256File(join(runtime, 'runtime-manifest.json'))}`) {
            throw new ReleaseGateError(`copied app setup-info digest is stale for ${key}`)
          }
          requireExactArchitectures(join(runtime, 'bin', 'node'), key === 'darwin-arm64' ? ['arm64'] : ['x86_64'])
        }

        const nativeRuntime = join(appResources, 'runtime', `darwin-${process.arch}`)
        await verifyCopiedAppLaunch({ app: copiedApp, scratch, runtime: nativeRuntime })
        return {
          schema: 1,
          status: 'passed',
          sourceCommit,
          packageVersion: version,
          identity,
          teamId,
          finalDmgSha256: sha256File(dmg),
          copiedAppTreeDigest: treeIdentity(copiedApp),
          dmgSignatureIdentity: 'passed',
          copiedAppCodesign: 'passed',
          copiedAppStapler: 'passed',
          copiedAppGatekeeper: 'passed',
          universalEnvelope: 'passed',
          runtimeManifests: 'passed',
          releaseSetupInfo: 'passed',
          loopbackLaunch: 'passed',
          portableRuntimeLifecycle: 'passed',
        }
      },
    })
    writeJson(output, evidence)
    return evidence
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function buildFinalReleaseEvidence({
  context,
  appReceipt,
  dmgReceipt,
  transportEvidence,
  finalDmg,
  identity,
  teamId,
}) {
  if (
    appReceipt?.kind !== 'app' ||
    dmgReceipt?.kind !== 'dmg' ||
    appReceipt.status !== 'Accepted' ||
    dmgReceipt.status !== 'Accepted'
  ) {
    throw new ReleaseGateError('final evidence requires accepted app and DMG receipts')
  }
  if (!appReceipt.submissionId || appReceipt.submissionId === dmgReceipt.submissionId) {
    throw new ReleaseGateError('app and DMG notarization tickets must be distinct')
  }
  requireString(context?.tag, 'release context tag', /^v\d+\.\d+\.\d+$/)
  requireString(context?.version, 'release context version', /^\d+\.\d+\.\d+$/)
  requireString(context?.sourceCommit, 'release context source commit', SHA_RE)
  requireString(identity, 'Developer ID identity', IDENTITY_RE)
  requireString(teamId, 'Developer ID team', TEAM_RE)
  const expectedName = `Agent-Inbox-${context.tag}-universal.dmg`
  if (basename(finalDmg) !== expectedName) {
    throw new ReleaseGateError(`final DMG must be named ${expectedName}`)
  }
  const finalDmgSha256 = sha256File(finalDmg)
  if (
    transportEvidence?.schema !== 1 ||
    transportEvidence.status !== 'passed' ||
    transportEvidence.sourceCommit !== context.sourceCommit ||
    transportEvidence.packageVersion !== context.version ||
    transportEvidence.identity !== identity ||
    transportEvidence.teamId !== teamId ||
    transportEvidence.finalDmgSha256 !== finalDmgSha256 ||
    transportEvidence.dmgSignatureIdentity !== 'passed' ||
    transportEvidence.copiedAppCodesign !== 'passed' ||
    transportEvidence.copiedAppStapler !== 'passed' ||
    transportEvidence.copiedAppGatekeeper !== 'passed' ||
    transportEvidence.universalEnvelope !== 'passed' ||
    transportEvidence.runtimeManifests !== 'passed' ||
    transportEvidence.releaseSetupInfo !== 'passed' ||
    transportEvidence.loopbackLaunch !== 'passed' ||
    transportEvidence.portableRuntimeLifecycle !== 'passed'
  ) {
    throw new ReleaseGateError('transported app evidence does not match the final stapled DMG')
  }
  return {
    schema: 1,
    product: APP_NAME,
    tag: context.tag,
    packageVersion: context.version,
    sourceCommit: context.sourceCommit,
    annotatedTag: context.annotated === true,
    identity,
    teamId,
    appNotarization: appReceipt,
    dmgNotarization: dmgReceipt,
    transportedApp: transportEvidence,
    finalDmgName: expectedName,
    finalDmgSha256,
    verification: {
      appCodesign: 'passed',
      appStapler: 'passed',
      appGatekeeper: 'passed',
      dmgCodesign: 'passed',
      dmgIdentity: 'passed',
      dmgStapler: 'passed',
      dmgGatekeeper: 'passed',
      transportedApp: 'passed',
      checksumAfterStaple: true,
    },
  }
}

export function validatePublicationInputs({ assetsDir, evidencePath, context }) {
  const evidence = readJson(evidencePath, 'final release evidence')
  const dmgName = `Agent-Inbox-${context.tag}-universal.dmg`
  const expected = [dmgName, 'SHA256SUMS.txt'].sort()
  const actual = readdirSync(assetsDir).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ReleaseGateError(`release asset allowlist mismatch: expected ${expected.join(', ')}, found ${actual.join(', ')}`)
  }
  const dmg = join(assetsDir, dmgName)
  const checksums = join(assetsDir, 'SHA256SUMS.txt')
  const checksumText = readFileSync(checksums, 'utf8')
  const digest = sha256File(dmg)
  if (checksumText !== `${digest}  ${dmgName}\n`) throw new ReleaseGateError('SHA256SUMS.txt is stale or malformed')
  const verificationPassed =
    evidence.verification?.appCodesign === 'passed' &&
    evidence.verification?.appStapler === 'passed' &&
    evidence.verification?.appGatekeeper === 'passed' &&
    evidence.verification?.dmgCodesign === 'passed' &&
    evidence.verification?.dmgIdentity === 'passed' &&
    evidence.verification?.dmgStapler === 'passed' &&
    evidence.verification?.dmgGatekeeper === 'passed' &&
    evidence.verification?.transportedApp === 'passed' &&
    evidence.verification?.checksumAfterStaple === true &&
    Object.keys(evidence.verification).sort().join(',') === [
      'appCodesign',
      'appGatekeeper',
      'appStapler',
      'checksumAfterStaple',
      'dmgCodesign',
      'dmgGatekeeper',
      'dmgIdentity',
      'dmgStapler',
      'transportedApp',
    ].join(',')
  const transportedAppPassed =
    evidence.transportedApp?.schema === 1 &&
    evidence.transportedApp?.status === 'passed' &&
    evidence.transportedApp?.sourceCommit === context.sourceCommit &&
    evidence.transportedApp?.packageVersion === context.version &&
    evidence.transportedApp?.finalDmgSha256 === digest &&
    evidence.transportedApp?.identity === evidence.identity &&
    evidence.transportedApp?.teamId === evidence.teamId &&
    evidence.transportedApp?.dmgSignatureIdentity === 'passed' &&
    evidence.transportedApp?.copiedAppCodesign === 'passed' &&
    evidence.transportedApp?.copiedAppStapler === 'passed' &&
    evidence.transportedApp?.copiedAppGatekeeper === 'passed' &&
    evidence.transportedApp?.universalEnvelope === 'passed' &&
    evidence.transportedApp?.runtimeManifests === 'passed' &&
    evidence.transportedApp?.releaseSetupInfo === 'passed' &&
    evidence.transportedApp?.loopbackLaunch === 'passed' &&
    evidence.transportedApp?.portableRuntimeLifecycle === 'passed'
  if (
    evidence.schema !== 1 ||
    evidence.tag !== context.tag ||
    evidence.packageVersion !== context.version ||
    evidence.sourceCommit !== context.sourceCommit ||
    evidence.annotatedTag !== true ||
    evidence.finalDmgName !== dmgName ||
    evidence.finalDmgSha256 !== digest ||
    evidence.appNotarization?.status !== 'Accepted' ||
    evidence.dmgNotarization?.status !== 'Accepted' ||
    evidence.appNotarization?.submissionId === evidence.dmgNotarization?.submissionId ||
    !transportedAppPassed ||
    !verificationPassed
  ) {
    throw new ReleaseGateError('final release evidence does not authorize publication')
  }
  return { dmg, checksums, tag: context.tag, version: context.version }
}

export function validateRemoteDraft({ remotePath, tag }) {
  const remote = readJson(remotePath, 'remote draft release')
  const names = (remote.assets ?? []).map((asset) => asset.name).sort()
  const expected = [`Agent-Inbox-${tag}-universal.dmg`, 'SHA256SUMS.txt'].sort()
  if (
    remote.tagName !== tag ||
    remote.isDraft !== true ||
    JSON.stringify(names) !== JSON.stringify(expected) ||
    remote.assets.some((asset) => !Number.isSafeInteger(asset.size) || asset.size <= 0)
  ) {
    throw new ReleaseGateError('remote draft release does not contain the exact nonempty asset allowlist')
  }
  return remote
}

function appendOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')
  writeFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`, { flag: 'a' })
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'repo-root': { type: 'string' },
      ref: { type: 'string' },
      sha: { type: 'string' },
      output: { type: 'string' },
      scope: { type: 'string' },
      kind: { type: 'string' },
      submitted: { type: 'string' },
      'submit-json': { type: 'string' },
      'log-json': { type: 'string' },
      app: { type: 'string' },
      archive: { type: 'string' },
      report: { type: 'string' },
      evidence: { type: 'string' },
      identity: { type: 'string' },
      team: { type: 'string' },
      source: { type: 'string' },
      version: { type: 'string' },
      context: { type: 'string' },
      'app-receipt': { type: 'string' },
      'dmg-receipt': { type: 'string' },
      'transport-evidence': { type: 'string' },
      dmg: { type: 'string' },
      icon: { type: 'string' },
      'assets-dir': { type: 'string' },
      remote: { type: 'string' },
      tag: { type: 'string' },
      input: { type: 'string' },
      'trusted-sha': { type: 'string' },
      'run-head-sha': { type: 'string' },
      'arm64-archive': { type: 'string' },
      'x64-archive': { type: 'string' },
      'arm64-app': { type: 'string' },
      'x64-app': { type: 'string' },
      'arm64-report': { type: 'string' },
      'x64-report': { type: 'string' },
      handoff: { type: 'string' },
    },
  })
  const commandName = positionals[0]
  if (commandName === 'tag') {
    const result = validateReleaseTag({
      repoRoot: resolve(values['repo-root'] ?? '.'),
      ref: values.ref,
      sha: values.sha,
    })
    if (values.output) writeJson(resolve(values.output), result)
    appendOutputs({ tag: result.tag, version: result.version, 'source-commit': result.sourceCommit })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (commandName === 'context') {
    if (!values.input) throw new ReleaseGateError('--input is required')
    const result = validateReleaseContext(readJson(resolve(values.input), 'release context'))
    appendOutputs({ tag: result.tag, version: result.version, 'source-commit': result.sourceCommit })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (commandName === 'authorize') {
    if (!values.input || !values['trusted-sha'] || !values['run-head-sha']) {
      throw new ReleaseGateError('--input, --trusted-sha, and --run-head-sha are required')
    }
    const result = validateProtectedRelease({
      repoRoot: resolve(values['repo-root'] ?? '.'),
      context: readJson(resolve(values.input), 'release context'),
      trustedSha: values['trusted-sha'],
      runHeadSha: values['run-head-sha'],
    })
    if (values.output) writeJson(resolve(values.output), result)
    appendOutputs({ tag: result.tag, version: result.version, 'source-commit': result.sourceCommit })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (commandName === 'thin-handoff') {
    const context = validateReleaseContext(readJson(resolve(values.context), 'release context'))
    const result = await buildThinHandoff({
      arm64Archive: resolve(values['arm64-archive']),
      x64Archive: resolve(values['x64-archive']),
      arm64App: resolve(values['arm64-app']),
      x64App: resolve(values['x64-app']),
      arm64Report: resolve(values['arm64-report']),
      x64Report: resolve(values['x64-report']),
      context,
    })
    if (!values.output) throw new ReleaseGateError('--output is required')
    writeJson(resolve(values.output), result)
    process.stdout.write('{"ok":true}\n')
    return
  }
  if (commandName === 'verify-handoff') {
    const context = validateReleaseContext(readJson(resolve(values.context), 'release context'))
    validateThinHandoff({
      arm64Archive: resolve(values['arm64-archive']),
      x64Archive: resolve(values['x64-archive']),
      evidencePath: resolve(values.handoff),
      context,
    })
    process.stdout.write('{"ok":true}\n')
    return
  }
  if (commandName === 'credentials') {
    const result = validateCredentialEnvironment(process.env, values.scope)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (commandName === 'identity') {
    const source = values.input
      ? readJson(resolve(values.input), 'signing identity')
      : { identity: process.env.APPLE_DEVELOPER_IDENTITY, teamId: process.env.APPLE_TEAM_ID }
    const result = validateSigningIdentity(source)
    if (values.output) writeJson(resolve(values.output), result)
    appendOutputs({ identity: result.identity, team: result.teamId })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (commandName === 'receipt') {
    const result = parseNotaryReceipt({
      kind: values.kind,
      submitted: resolve(values.submitted),
      submitJson: resolve(values['submit-json']),
      logJson: resolve(values['log-json']),
    })
    if (!values.output) throw new ReleaseGateError('--output is required')
    writeJson(resolve(values.output), result)
    process.stdout.write(`${JSON.stringify({ ok: true, submissionId: result.submissionId })}\n`)
    return
  }
  if (commandName === 'submission-id') {
    const submit = readJson(resolve(values['submit-json']), 'notary submit result')
    process.stdout.write(`${requireString(submit.id, 'notary submission id', UUID_RE)}\n`)
    return
  }
  if (commandName === 'intel-evidence') {
    const result = verifyDeveloperIdApp({
      app: resolve(values.app),
      archive: resolve(values.archive),
      reportPath: resolve(values.report),
      identity: values.identity,
      teamId: values.team,
      sourceCommit: values.source,
      version: values.version,
      output: resolve(values.output),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, appArchiveSha256: result.appArchiveSha256 })}\n`)
    return
  }
  if (commandName === 'verify-intel-evidence') {
    validateIntelEvidence({
      archive: resolve(values.archive),
      reportPath: resolve(values.report),
      evidencePath: resolve(values.evidence),
      identity: values.identity,
      teamId: values.team,
      sourceCommit: values.source,
      version: values.version,
    })
    process.stdout.write('{"ok":true}\n')
    return
  }
  if (commandName === 'build-dmg') {
    await buildFinalDmg({
      app: resolve(values.app),
      version: values.version,
      appReceiptPath: resolve(values['app-receipt']),
      output: resolve(values.output),
      icon: resolve(values.icon),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, dmg: resolve(values.output) })}\n`)
    return
  }
  if (commandName === 'verify-final-dmg') {
    const result = await verifyFinalDmg({
      dmg: resolve(values.dmg),
      identity: values.identity,
      teamId: values.team,
      sourceCommit: values.source,
      version: values.version,
      output: resolve(values.output),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, copiedAppTreeDigest: result.copiedAppTreeDigest })}\n`)
    return
  }
  if (commandName === 'final-evidence') {
    const context = readJson(resolve(values.context), 'release context')
    const appReceipt = readJson(resolve(values['app-receipt']), 'app receipt')
    const dmgReceipt = readJson(resolve(values['dmg-receipt']), 'DMG receipt')
    const transportEvidence = readJson(resolve(values['transport-evidence']), 'transported app evidence')
    const app = resolve(values.app)
    const dmg = resolve(values.dmg)
    verifySignatureIdentity(app, values.identity, values.team)
    command('/usr/bin/xcrun', ['stapler', 'validate', app])
    command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
    verifySignatureIdentity(dmg, values.identity, values.team, { deep: false })
    command('/usr/bin/xcrun', ['stapler', 'validate', dmg])
    command('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg])
    const evidence = buildFinalReleaseEvidence({
      context,
      appReceipt,
      dmgReceipt,
      transportEvidence,
      finalDmg: dmg,
      identity: values.identity,
      teamId: values.team,
    })
    if (!values.output || !values['assets-dir']) throw new ReleaseGateError('--output and --assets-dir are required')
    const assetsDir = resolve(values['assets-dir'])
    mkdirSync(assetsDir, { recursive: true })
    const publishedDmg = join(assetsDir, evidence.finalDmgName)
    copyFileSync(dmg, publishedDmg)
    evidence.finalDmgSha256 = sha256File(publishedDmg)
    writeFileSync(
      join(assetsDir, 'SHA256SUMS.txt'),
      `${evidence.finalDmgSha256}  ${evidence.finalDmgName}\n`,
    )
    writeJson(resolve(values.output), evidence)
    process.stdout.write(`${JSON.stringify({ ok: true, finalDmgSha256: evidence.finalDmgSha256 })}\n`)
    return
  }
  if (commandName === 'publication') {
    const context = readJson(resolve(values.context), 'release context')
    const result = validatePublicationInputs({
      assetsDir: resolve(values['assets-dir']),
      evidencePath: resolve(values.evidence),
      context,
    })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
    return
  }
  if (commandName === 'remote-draft') {
    validateRemoteDraft({ remotePath: resolve(values.remote), tag: values.tag })
    process.stdout.write('{"ok":true}\n')
    return
  }
  throw new ReleaseGateError(`unknown release gate command: ${commandName ?? '(missing)'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`macos-release-gates: ${err.message}\n`)
    process.exitCode = 1
  })
}
