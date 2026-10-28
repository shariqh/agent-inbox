#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  accessSync,
  constants as fsConstants,
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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadReleaseInputs, RUNTIME_KEYS, sha256File } from './release-inputs.mjs'
import { verifyPackagedUpdateTrust } from './package-update-trust.mjs'
import { assertEnglishOnlyElectronLocales } from './prune-electron-locales.mjs'
import { verifyPayload } from './runtime-payload.mjs'
import { treeIdentity } from './tree-identity.mjs'
import { createReleaseDmg } from './macos-dmg.mjs'
import { macosKindOf, macosRelease, measuredMacosKind } from './macos-release-kind.mjs'
import { newestUniversalRelease } from './update-manifest.mjs'

const APP_NAME = 'Agent Inbox'
const TAG_RE = /^v(\d+\.\d+\.\d+)$/
const SHA_RE = /^[0-9a-f]{40}$/
const UTC_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const TEAM_RE = /^[A-Z0-9]{10}$/
const KEY_ID_RE = /^[A-Z0-9]{10}$/
const ISSUER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTITY_RE = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/
const SHA256_RE = /^[0-9a-f]{64}$/

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

// Every stapler call in the Notarize job runs through runStapler(), including the app and
// DMG staple/validate in notarize-macos.sh (via the `stapler` command), so this is the one
// copy of the retry policy. Stapling starts only after Apple accepted the submission and
// only fetches or checks the ticket through Apple's CloudKit ticket service. Retry output
// showing that service dropped the connection or has not published the ticket yet; every
// other failure is final.
const STAPLER_TRANSIENT_MARKERS = [
  'NSURLErrorDomain',
  'network connection',
  "CloudKit's response is inconsistent",
  'Record not found',
]
const STAPLER_RETRY_DELAYS_SECONDS = [15, 30, 60, 120]

function executableFromEnv(name, fallback, label) {
  const path = process.env[name] || fallback
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error(path)
    accessSync(path, fsConstants.X_OK)
  } catch {
    throw new ReleaseGateError(`${label} executable must be an absolute executable path`)
  }
  return path
}

function staplerFailure(message, status) {
  const error = new ReleaseGateError(message)
  error.exitStatus = status
  return error
}

function runStapler(action, target) {
  if (action !== 'staple' && action !== 'validate') {
    throw new ReleaseGateError(`unknown stapler action: ${action ?? '(missing)'}`)
  }
  requireString(target, 'stapler target')
  const xcrun = executableFromEnv('APPLE_XCRUN_BIN', '/usr/bin/xcrun', 'xcrun')
  const sleep = executableFromEnv('STAPLER_RETRY_SLEEP_BIN', '/bin/sleep', 'sleep')
  const step = `stapler ${action} ${target}`
  const attempts = STAPLER_RETRY_DELAYS_SECONDS.length + 1
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(xcrun, ['stapler', action, target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (output) process.stderr.write(output.endsWith('\n') ? output : `${output}\n`)
    if (result.status === 0) return
    const status = result.status ?? 1
    if (!STAPLER_TRANSIENT_MARKERS.some((marker) => output.includes(marker))) {
      const cause = result.error ? ` (${result.error.message})` : ''
      throw staplerFailure(
        `${step} failed (exit ${status}) without a transient Apple network or ticket error; not retrying${cause}`,
        status,
      )
    }
    if (attempt === attempts) {
      throw staplerFailure(`${step} still failing after ${attempts} attempts (exit ${status})`, status)
    }
    const delay = STAPLER_RETRY_DELAYS_SECONDS[attempt - 1]
    process.stderr.write(
      `macos-release-gates: ${step} attempt ${attempt}/${attempts} hit a transient Apple ticket-service ` +
        `error (exit ${status}); retrying in ${delay}s\n`,
    )
    execFileSync(sleep, [String(delay)], { stdio: 'ignore' })
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

export async function buildThinHandoff({
  arm64Archive,
  arm64App,
  arm64Report,
  context,
}) {
  const release = validateReleaseContext(context)
  const { verifyThinReport } = await import('./assemble-macos-release.mjs')
  const report = verifyThinReport({
    arm64App,
    arm64Report,
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
    },
    appTreeDigests: {
      arm64: report.appTreeDigest,
    },
    verifiedByTrustedWorkflow: true,
  }
}

export function validateThinHandoff({ arm64Archive, evidencePath, context }) {
  const release = validateReleaseContext(context)
  const evidence = readJson(evidencePath, 'trusted thin handoff evidence')
  if (
    evidence.schema !== 1 ||
    evidence.sourceCommit !== release.sourceCommit ||
    evidence.packageVersion !== release.version ||
    evidence.verifiedByTrustedWorkflow !== true ||
    JSON.stringify(Object.keys(evidence.archives ?? {})) !== JSON.stringify(['thin-darwin-arm64.tar.gz']) ||
    evidence.archives['thin-darwin-arm64.tar.gz'] !== sha256File(arm64Archive) ||
    typeof evidence.appTreeDigests?.arm64 !== 'string'
  ) {
    throw new ReleaseGateError('thin handoff does not match trusted preflight evidence')
  }
  return evidence
}

export async function buildFinalDmg({ app, version, appReceiptPath, output, icon }) {
  const receipt = readJson(appReceiptPath, 'accepted app receipt')
  if (receipt.kind !== 'app' || receipt.status !== 'Accepted') {
    throw new ReleaseGateError('final DMG requires an accepted app notarization receipt')
  }
  runStapler('validate', app)
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
  const expected = expectedMacosRelease(`v${version}`).dmgName
  if (basename(output) !== expected) throw new ReleaseGateError(`final DMG must be named ${expected}`)
  mkdirSync(dirname(output), { recursive: true })
  await createReleaseDmg({ app, title: `${APP_NAME} v${version}`, icon, output })
  return output
}

// Reading the final ULMO (lzma) DMG is several times slower than zlib (#289):
// attaching verifies every block's checksum and copying the app out decompresses
// all of it. The in-app updater allows the same for the same two steps.
const DMG_ATTACH_TIMEOUT_MS = 5 * 60_000
const DMG_COPY_TIMEOUT_MS = 10 * 60_000

export async function withMountedDmg({ dmg, mount, runCommand, verify }) {
  runCommand('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], {
    timeout: DMG_ATTACH_TIMEOUT_MS,
  })
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

// What `lipo -archs` prints for one Mach-O file.
function lipoArchitectures(path) {
  return command('/usr/bin/lipo', ['-archs', path])
}

function lipoSet(output, label) {
  if (typeof output !== 'string') throw new ReleaseGateError(`lipo -archs printed nothing for ${label}`)
  return output.trim().split(/\s+/).filter(Boolean).sort()
}

/**
 * The CPU types `lipo -archs` printed for the transported app's main executable and its
 * better-sqlite3 addon, sorted, and the release kind they give (#341). Both sets must equal
 * each other and the committed expected set; the DMG name and every label follow the kind.
 */
export function transportedAppArchitectures({ executable, betterSqlite3, expected }) {
  const architectures = {
    executable: lipoSet(executable, 'the app executable'),
    betterSqlite3: lipoSet(betterSqlite3, 'the better-sqlite3 addon'),
  }
  return { architectures, kind: measuredMacosKind({ expected, ...architectures }) }
}

// The release the committed expected set (macosArchitectures) describes for this tag.
function expectedMacosRelease(tag, expected = loadReleaseInputs().macosArchitectures) {
  return macosRelease({ kind: macosKindOf(expected, 'macosArchitectures'), tag })
}

// A universal release also needs the native Intel gate's pass for this source, version and
// signing identity; an arm64 release has no Intel gate. #296 removed that gate and the x64
// runtime it checked, so nothing records a pass any more and a universal kind cannot pass.
function requireNativeIntel(macos, record, { sourceCommit, version, identity, teamId }) {
  if (!macos.needsNativeIntel) {
    if (record !== undefined) throw new ReleaseGateError(`an ${macos.kind} release has no native Intel gate`)
    return
  }
  if (
    record?.schema !== 1 ||
    record.status !== 'passed' ||
    record.runner !== 'native-intel' ||
    record.sourceCommit !== sourceCommit ||
    record.packageVersion !== version ||
    record.identity !== identity ||
    record.teamId !== teamId ||
    !SHA256_RE.test(record.appArchiveSha256 ?? '') ||
    !SHA256_RE.test(record.verificationReportSha256 ?? '') ||
    typeof record.appTreeDigest !== 'string' ||
    record.codesign !== 'passed' ||
    record.x64RuntimeManifest !== 'passed' ||
    record.x64RuntimeSelftest !== 'passed'
  ) {
    throw new ReleaseGateError(
      `a ${macos.kind} release needs the native Intel gate to have passed for this source, version and identity`,
    )
  }
}

// The release a transported-app record describes: the kind recomputed from its measured
// CPU types against the expected set, which must match the kind it records (#341).
function transportedMacosRelease(transported, { tag, expected }) {
  const { executable, betterSqlite3, ...extra } = transported?.architectures ?? {}
  if (Object.keys(extra).length > 0) {
    throw new ReleaseGateError('transported app CPU types must record only executable and betterSqlite3')
  }
  const kind = measuredMacosKind({ expected, executable, betterSqlite3 })
  if (transported.kind !== kind) {
    throw new ReleaseGateError(
      `transported app evidence labels the release ${JSON.stringify(transported.kind)}, but its measured CPU types give ${kind}`,
    )
  }
  return { ...macosRelease({ kind, tag }), architectures: { executable, betterSqlite3 } }
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
        runCommand('/usr/bin/ditto', [join(mount, `${APP_NAME}.app`), copiedApp], { timeout: DMG_COPY_TIMEOUT_MS })
        verifySignatureIdentity(copiedApp, identity, teamId)
        runStapler('validate', copiedApp)
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
        assertEnglishOnlyElectronLocales(copiedApp, 'darwin', 'copied app')

        const measured = transportedAppArchitectures({
          executable: lipoArchitectures(join(contents, 'MacOS', APP_NAME)),
          betterSqlite3: lipoArchitectures(join(appResources, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')),
          expected: inputs.macosArchitectures,
        })
        const setup = JSON.parse(readFileSync(join(appResources, 'setup-info.json'), 'utf8'))
        if (
          setup.schema !== 2 ||
          setup.version !== version ||
          setup.commit !== sourceCommit ||
          'repoRoot' in setup ||
          'nodeBin' in setup ||
          JSON.stringify(Object.keys(setup.runtimePayloads ?? {}).sort()) !== JSON.stringify([...RUNTIME_KEYS].sort())
        ) {
          throw new ReleaseGateError('copied app release setup-info is invalid')
        }
        for (const key of RUNTIME_KEYS) {
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
          requireExactArchitectures(join(runtime, 'bin', 'node'), [distribution.arch === 'x64' ? 'x86_64' : distribution.arch])
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
          ...measured,
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
  intelEvidence,
  finalDmg,
  identity,
  teamId,
  expected = loadReleaseInputs().macosArchitectures,
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
  const macos = transportedMacosRelease(transportEvidence, { tag: context.tag, expected })
  if (basename(finalDmg) !== macos.dmgName) {
    throw new ReleaseGateError(`final DMG must be named ${macos.dmgName}`)
  }
  requireNativeIntel(macos, intelEvidence, {
    sourceCommit: context.sourceCommit,
    version: context.version,
    identity,
    teamId,
  })
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
    ...(macos.needsNativeIntel ? { nativeIntel: intelEvidence } : {}),
    finalDmgName: macos.dmgName,
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

export function validatePublicationInputs({
  assetsDir,
  evidencePath,
  context,
  expected = loadReleaseInputs().macosArchitectures,
}) {
  const evidence = readJson(evidencePath, 'final release evidence')
  const macos = transportedMacosRelease(evidence.transportedApp, { tag: context.tag, expected })
  requireNativeIntel(macos, evidence.nativeIntel, {
    sourceCommit: context.sourceCommit,
    version: context.version,
    identity: evidence.identity,
    teamId: evidence.teamId,
  })
  const dmgName = macos.dmgName
  const allowlist = [dmgName, 'SHA256SUMS.txt'].sort()
  const actual = readdirSync(assetsDir).sort()
  if (JSON.stringify(actual) !== JSON.stringify(allowlist)) {
    throw new ReleaseGateError(`release asset allowlist mismatch: expected ${allowlist.join(', ')}, found ${actual.join(', ')}`)
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
  return { dmg, checksums, tag: context.tag, version: context.version, macos }
}

export function validateRemoteDraft({ remotePath, tag, expected = loadReleaseInputs().macosArchitectures }) {
  const remote = readJson(remotePath, 'remote draft release')
  const names = (remote.assets ?? []).map((asset) => asset.name).sort()
  const allowlist = [expectedMacosRelease(tag, expected).dmgName, 'SHA256SUMS.txt'].sort()
  if (
    remote.tagName !== tag ||
    remote.isDraft !== true ||
    JSON.stringify(names) !== JSON.stringify(allowlist) ||
    remote.assets.some((asset) => !Number.isSafeInteger(asset.size) || asset.size <= 0)
  ) {
    throw new ReleaseGateError('remote draft release does not contain the exact nonempty asset allowlist')
  }
  return remote
}

/**
 * The release Intel Macs stay on (design §4.4): the newest published stable release with a
 * universal DMG, which every arm64 release's update-manifest.json re-stamps (G6). The release
 * notes name it, read from GitHub's listing (`gh api --paginate --slurp`) like the signer's.
 */
export function intelRelease({ pages, tag }) {
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new ReleaseGateError('GitHub release pagination response is malformed')
  }
  // A re-run after publication lists this release too, which is not an earlier one.
  const releases = pages.flat().filter((release) => release?.tag_name !== tag)
  let release
  try {
    release = newestUniversalRelease(releases, tag)
  } catch (err) {
    throw new ReleaseGateError(err.message)
  }
  if (!release) throw new ReleaseGateError('no published release has a universal DMG, so none is the last for Intel Macs')
  return { tag: release.tag_name, version: release.tag_name.slice(1) }
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
      releases: { type: 'string' },
      tag: { type: 'string' },
      input: { type: 'string' },
      'trusted-sha': { type: 'string' },
      'run-head-sha': { type: 'string' },
      'arm64-archive': { type: 'string' },
      'arm64-app': { type: 'string' },
      'arm64-report': { type: 'string' },
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
      arm64App: resolve(values['arm64-app']),
      arm64Report: resolve(values['arm64-report']),
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
  if (commandName === 'stapler') {
    if (positionals.length !== 3) throw new ReleaseGateError('usage: stapler staple|validate TARGET')
    runStapler(positionals[1], positionals[2])
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
    runStapler('validate', app)
    command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
    verifySignatureIdentity(dmg, values.identity, values.team, { deep: false })
    runStapler('validate', dmg)
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
  if (commandName === 'expected-kind') {
    const macos = expectedMacosRelease(requireString(values.tag, 'release tag', TAG_RE))
    appendOutputs({ kind: macos.kind, 'dmg-name': macos.dmgName })
    process.stdout.write(`${JSON.stringify(macos)}\n`)
    return
  }
  if (commandName === 'intel-release') {
    const result = intelRelease({
      pages: readJson(resolve(requireString(values.releases, '--releases')), 'GitHub release listing'),
      tag: requireString(values.tag, 'release tag', TAG_RE),
    })
    appendOutputs({ 'intel-tag': result.tag })
    process.stdout.write(`${JSON.stringify(result)}\n`)
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
    process.exitCode = err.exitStatus ?? 1
  })
}
