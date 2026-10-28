import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ReleaseGateError,
  buildThinHandoff,
  buildFinalReleaseEvidence,
  intelRelease,
  parseNotaryReceipt,
  validateCredentialEnvironment,
  validatePublicationInputs,
  transportedAppArchitectures,
  validateProtectedRelease,
  validateReleaseTag,
  validateRemoteDraft,
  validateThinHandoff,
  withMountedDmg,
} from '../scripts/macos-release-gates.mjs'
import { macosKindOf, macosRelease } from '../scripts/macos-release-kind.mjs'
import { loadReleaseInputs } from '../scripts/release-inputs.mjs'
import { treeIdentity } from '../scripts/tree-identity.mjs'
import { scratchDir } from './scratch.js'

const root = resolve(process.cwd())
const signingIdentity = 'Developer ID Application: Release Test (AB12CD34EF)'
const fixtureTaggedAt = '2026-08-25T20:12:51Z'

function taggedAt(repo: string, tag: string) {
  const value = execFileSync(
    'git',
    ['for-each-ref', '--format=%(taggerdate:iso8601-strict)', `refs/tags/${tag}`],
    { cwd: repo, encoding: 'utf8' },
  ).trim()
  return new Date(value).toISOString().replace('.000Z', 'Z')
}

function makeSigningHarness(emptySearchList = false) {
  const temp = scratchDir('release-signing-')
  const state = join(temp, 'signing state')
  const bin = join(temp, 'bin')
  const security = join(bin, 'security')
  const securityLog = join(temp, 'security.log')
  const certificate = join(temp, 'certificate.pem')
  const certificateKey = join(temp, 'certificate-key.pem')
  const githubOutput = join(temp, 'github-output')
  const originalKeychains = emptySearchList
    ? []
    : [
        join(temp, 'Original Login.keychain-db'),
        join(temp, 'Original Build.keychain-db'),
      ]
  mkdirSync(bin)
  execFileSync('/usr/bin/openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-keyout', certificateKey,
    '-out', certificate,
    '-days', '1',
    '-nodes',
    '-subj', '/CN=Release Test/OU=AB12CD34EF',
  ], { stdio: 'ignore' })
  writeFileSync(security, `#!/bin/sh
set -eu
{
  printf '%s' "$1"
  first=1
  for arg do
    if [ "$first" = 1 ]; then
      first=0
    else
      printf '\\t%s' "$arg"
    fi
  done
  printf '\\n'
} >> "$SECURITY_LOG"
case "$1" in
  list-keychains)
    if [ "$#" -eq 3 ]; then
      if [ -n "\${ORIGINAL_KEYCHAIN_ONE:-}" ]; then
        printf '    "%s"\\n' "$ORIGINAL_KEYCHAIN_ONE"
      fi
      if [ -n "\${ORIGINAL_KEYCHAIN_TWO:-}" ]; then
        printf '    "%s"\\n' "$ORIGINAL_KEYCHAIN_TWO"
      fi
    elif [ "$4" = "-s" ]; then
      if [ "\${FAIL_ACTIVATION:-0}" = 1 ] && [ "\${5:-}" = "$EXPECTED_TEMP_KEYCHAIN" ]; then
        exit 9
      fi
      if [ "\${FAIL_RESTORE:-0}" = 1 ] && [ "\${5:-}" != "$EXPECTED_TEMP_KEYCHAIN" ]; then
        exit 10
      fi
    fi
    ;;
  create-keychain)
    for last do :; done
    : > "$last"
    ;;
  find-identity)
    printf '  1) ABCDEF "%s"\\n     1 valid identities found\\n' "$EXPECTED_IDENTITY"
    ;;
  find-certificate)
    cat "$CERTIFICATE_FILE"
    ;;
esac
`)
  chmodSync(security, 0o755)
  const keychain = join(state, 'agent-inbox.keychain-db')
  const env = {
    ...process.env,
    APPLE_SECURITY_BIN: security,
    APPLE_SIGNING_STATE_DIR: state,
    APPLE_DEVELOPER_ID_P12_BASE64: Buffer.from('not-a-real-p12').toString('base64'),
    APPLE_DEVELOPER_ID_P12_PASSWORD: 'p12-password',
    APPLE_DEVELOPER_IDENTITY: signingIdentity,
    APPLE_TEAM_ID: 'AB12CD34EF',
    GITHUB_OUTPUT: githubOutput,
    SECURITY_LOG: securityLog,
    CERTIFICATE_FILE: certificate,
    EXPECTED_IDENTITY: signingIdentity,
    EXPECTED_TEMP_KEYCHAIN: keychain,
    ORIGINAL_KEYCHAIN_ONE: originalKeychains[0] ?? '',
    ORIGINAL_KEYCHAIN_TWO: originalKeychains[1] ?? '',
  }
  return { state, securityLog, githubOutput, originalKeychains, keychain, env }
}

function makeTaggedRepo(version = '1.2.3', lockRootVersion = version) {
  const repo = scratchDir('release-tag-')
  execFileSync('git', ['init', '--quiet'], { cwd: repo })
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ version })}\n`)
  writeFileSync(
    join(repo, 'package-lock.json'),
    `${JSON.stringify({ version, packages: { '': { version: lockRootVersion } } })}\n`,
  )
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', [
    '-c', 'user.name=Release Test',
    '-c', 'user.email=release@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: repo })
  execFileSync('git', [
    '-c', 'user.name=Release Test',
    '-c', 'user.email=release@example.invalid',
    'tag', '-a', `v${version}`, '-m', `Release v${version}`,
  ], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: fixtureTaggedAt,
    },
  })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  return { repo, sha, tag: `v${version}`, taggedAt: fixtureTaggedAt }
}

type StaplerAction = 'staple' | 'validate'
type StaplerFailure = { output: string, status: number }

const cloudKitTicketLookup =
  'https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup'

// The stapler failure that sank all three Notarize attempts of release run 38783536267.
function staplerConnectionLost(
  action: StaplerAction,
  task = 'FB9BCA30-16D9-4A0D-B99D-F769D2C53AD7',
): StaplerFailure {
  return {
    status: 68,
    output: [
      'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." '
        + 'UserInfo={_kCFStreamErrorCodeKey=-4, NSUnderlyingError=0x6000025f41b0 '
        + '{Error Domain=kCFErrorDomainCFNetwork Code=-1005 "(null)" '
        + 'UserInfo={_kCFStreamErrorCodeKey=-4, _kCFStreamErrorDomainKey=4}}, '
        + `_NSURLErrorFailingURLSessionTaskErrorKey=LocalDataTask <${task}>.<1>, `
        + '_NSURLErrorRelatedURLSessionTaskErrorKey=(',
      `    "LocalDataTask <${task}>.<1>"`,
      '), NSLocalizedDescription=The network connection was lost., '
        + `NSErrorFailingURLStringKey=${cloudKitTicketLookup}, `
        + `NSErrorFailingURLKey=${cloudKitTicketLookup}, _kCFStreamErrorDomainKey=4}`,
      "CloudKit's response is inconsistent with expections: (null)",
      `The ${action === 'staple' ? 'staple and validate' : 'validate'} action failed! Error 68.`,
    ].join('\n'),
  }
}

// Stapler's report when Apple's ticket service has not published an accepted ticket yet.
const staplerTicketNotPublished: StaplerFailure = {
  status: 65,
  output: [
    'CloudKit query for Agent Inbox.app (2/0123456789abcdef0123456789abcdef01234567) '
      + 'failed due to "Record not found".',
    'Could not find base64 encoded ticket in response for 2/0123456789abcdef0123456789abcdef01234567',
    'The staple and validate action failed! Error 65.',
  ].join('\n'),
}

// A real stapler failure that no retry can fix: same exit 65, no transient wording.
const staplerNotStapled: StaplerFailure = {
  status: 65,
  output: 'Agent Inbox.app does not have a ticket stapled to it.\nThe validate action failed! Error 65.',
}

function staplerOutages(action: StaplerAction, count: number) {
  return Array.from({ length: count }, (_, index) =>
    staplerConnectionLost(action, `00000000-0000-4000-8000-00000000000${index + 1}`))
}

// Fake xcrun/sleep for APPLE_XCRUN_BIN/STAPLER_RETRY_SLEEP_BIN. Stapler attempt N replays
// fakes/<action>.N.{out,status} when present and otherwise succeeds.
function makeXcrunFakes(temp: string, failures: Partial<Record<StaplerAction, StaplerFailure[]>>) {
  const fakes = join(temp, 'fakes')
  const xcrun = join(fakes, 'xcrun')
  const sleep = join(fakes, 'sleep')
  const xcrunLog = join(temp, 'xcrun.log')
  const sleepLog = join(temp, 'sleep.log')
  const digest = createHash('sha256').update('zip bytes').digest('hex')
  mkdirSync(fakes)
  for (const action of ['staple', 'validate'] as const) {
    for (const [index, failure] of (failures[action] ?? []).entries()) {
      writeFileSync(join(fakes, `${action}.${index + 1}.out`), `${failure.output}\n`)
      writeFileSync(join(fakes, `${action}.${index + 1}.status`), `${failure.status}\n`)
    }
  }
  writeFileSync(xcrun, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_XCRUN_LOG"
if [ "$1 $2" = "notarytool submit" ]; then
  printf '%s\\n' '{"id":"11111111-2222-3333-4444-555555555555","status":"Accepted"}'
elif [ "$1 $2" = "notarytool log" ]; then
  printf '%s\\n' '{"jobId":"11111111-2222-3333-4444-555555555555","status":"Accepted","statusCode":0,"archiveFilename":"Agent Inbox.zip","sha256":"${digest}","issues":[]}' > "$4"
elif [ "$1" = stapler ]; then
  attempt=1
  [ ! -f "$FAKE_XCRUN_DIR/$2.count" ] || attempt=$(( $(cat "$FAKE_XCRUN_DIR/$2.count") + 1 ))
  printf '%s\\n' "$attempt" > "$FAKE_XCRUN_DIR/$2.count"
  printf 'Processing: %s\\n' "$3"
  if [ -f "$FAKE_XCRUN_DIR/$2.$attempt.status" ]; then
    cat "$FAKE_XCRUN_DIR/$2.$attempt.out" >&2
    exit "$(cat "$FAKE_XCRUN_DIR/$2.$attempt.status")"
  fi
  if [ "$2" = staple ]; then
    echo 'The staple and validate action worked!'
  else
    echo 'The validate action worked!'
  fi
fi
`)
  writeFileSync(sleep, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SLEEP_LOG"
`)
  chmodSync(xcrun, 0o755)
  chmodSync(sleep, 0o755)
  const lines = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [])
  return {
    env: {
      APPLE_XCRUN_BIN: xcrun,
      STAPLER_RETRY_SLEEP_BIN: sleep,
      FAKE_XCRUN_LOG: xcrunLog,
      FAKE_XCRUN_DIR: fakes,
      FAKE_SLEEP_LOG: sleepLog,
    },
    calls: () => lines(xcrunLog).map((call) => call.split(' ').slice(0, 2).join(' ')),
    sleeps: () => lines(sleepLog).map(Number),
  }
}

function runNotarize(failures: Partial<Record<StaplerAction, StaplerFailure[]>> = {}) {
  const temp = scratchDir('notary-process-')
  try {
    const submitted = join(temp, 'Agent Inbox.zip')
    const stapleTarget = join(temp, 'Agent Inbox.app')
    const receipt = join(temp, 'receipt.json')
    writeFileSync(submitted, 'zip bytes')
    mkdirSync(stapleTarget)
    const fakes = makeXcrunFakes(temp, failures)
    const result = spawnSync('/bin/bash', [
      join(root, 'scripts', 'notarize-macos.sh'),
      'app',
      submitted,
      stapleTarget,
      receipt,
    ], {
      cwd: root,
      env: {
        ...process.env,
        ...fakes.env,
        APPLE_NOTARY_PRIVATE_KEY_BASE64: Buffer.from(
          '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n',
        ).toString('base64'),
        APPLE_NOTARY_KEY_ID: 'A1B2C3D4E5',
        APPLE_NOTARY_ISSUER_ID: '12345678-1234-1234-1234-123456789abc',
        RUNNER_TEMP: temp,
      },
      encoding: 'utf8',
    })
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: `${result.stdout}${result.stderr}`,
      receipt: existsSync(receipt) ? readFileSync(receipt, 'utf8') : '',
      calls: fakes.calls(),
      sleeps: fakes.sleeps(),
      notaryWorkDirs: readdirSync(temp).filter((name) => name.startsWith('agent-inbox-notary.')),
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

// Drives the real `build-dmg` gate up to the codesign check that follows its stapler validate.
function runBuildDmg(failures: StaplerFailure[]) {
  const temp = scratchDir('final-dmg-stapler-')
  try {
    const app = join(temp, 'Agent Inbox.app')
    const appReceipt = join(temp, 'app-notary-receipt.json')
    mkdirSync(app)
    writeFileSync(appReceipt, `${JSON.stringify({ kind: 'app', status: 'Accepted' })}\n`)
    const fakes = makeXcrunFakes(temp, { validate: failures })
    const result = spawnSync(process.execPath, [
      join(root, 'scripts', 'macos-release-gates.mjs'),
      'build-dmg',
      '--app', app,
      '--version', '1.2.3',
      '--app-receipt', appReceipt,
      '--icon', join(root, 'electron', 'icon.icns'),
      '--output', join(temp, 'Agent-Inbox-v1.2.3-arm64.dmg'),
    ], {
      cwd: root,
      env: { ...process.env, ...fakes.env },
      encoding: 'utf8',
    })
    return { status: result.status, stderr: result.stderr, calls: fakes.calls(), sleeps: fakes.sleeps() }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const evidenceIdentity = 'Developer ID Application: Example Corp (AB12CD34EF)'
const evidenceTeam = 'AB12CD34EF'
const UNIVERSAL = ['arm64', 'x86_64']
const ARM64_ONLY = ['arm64']

// What the native Intel job recorded, before #296 removed it, for this source and identity.
function nativeIntelRecord(context: { sourceCommit: string; version: string }) {
  return {
    schema: 1,
    status: 'passed',
    runner: 'native-intel',
    sourceCommit: context.sourceCommit,
    packageVersion: context.version,
    identity: evidenceIdentity,
    teamId: evidenceTeam,
    appArchiveSha256: 'b'.repeat(64),
    appTreeDigest: `sha256:${'c'.repeat(64)}`,
    verificationReportSha256: 'd'.repeat(64),
    codesign: 'passed',
    x64RuntimeManifest: 'passed',
    x64RuntimeSelftest: 'passed',
  }
}

// A final stapled DMG and what verify-final-dmg recorded about the app copied out of it: by
// default an Apple silicon release, the kind release/macos-inputs.json expects since #296.
function finalDmgFixture({
  dmgName = 'Agent-Inbox-v1.2.3-arm64.dmg',
  executable = ARM64_ONLY,
  betterSqlite3 = executable,
  kind = 'arm64',
}: { dmgName?: string; executable?: string[]; betterSqlite3?: string[]; kind?: string } = {}) {
  const temp = scratchDir('release-assets-')
  const assets = join(temp, 'assets')
  mkdirSync(assets)
  writeFileSync(join(assets, dmgName), 'final stapled dmg')
  const context = {
    schema: 1,
    tag: 'v1.2.3',
    version: '1.2.3',
    sourceCommit: 'a'.repeat(40),
    taggedAt: fixtureTaggedAt,
    annotated: true,
  } as const
  const transportEvidence = {
    schema: 1,
    status: 'passed',
    sourceCommit: context.sourceCommit,
    packageVersion: context.version,
    finalDmgSha256: createHash('sha256').update('final stapled dmg').digest('hex'),
    identity: evidenceIdentity,
    teamId: evidenceTeam,
    dmgSignatureIdentity: 'passed',
    copiedAppCodesign: 'passed',
    copiedAppStapler: 'passed',
    copiedAppGatekeeper: 'passed',
    architectures: { executable, betterSqlite3 },
    kind,
    runtimeManifests: 'passed',
    releaseSetupInfo: 'passed',
    loopbackLaunch: 'passed',
    portableRuntimeLifecycle: 'passed',
  }
  return { temp, assets, context, transportEvidence, finalDmg: join(assets, dmgName) }
}

// A universal release, which nothing builds since #296 but the kind table still describes.
function universalFixture(overrides: Parameters<typeof finalDmgFixture>[0] = {}) {
  return finalDmgFixture({ dmgName: 'Agent-Inbox-v1.2.3-universal.dmg', executable: UNIVERSAL, kind: 'universal', ...overrides })
}

function finalEvidence(
  fixture: ReturnType<typeof finalDmgFixture>,
  overrides: Partial<Parameters<typeof buildFinalReleaseEvidence>[0]> = {},
) {
  return buildFinalReleaseEvidence({
    context: fixture.context,
    appReceipt: {
      kind: 'app',
      submissionId: '11111111-2222-3333-4444-555555555555',
      status: 'Accepted',
    },
    dmgReceipt: {
      kind: 'dmg',
      submissionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      status: 'Accepted',
    },
    transportEvidence: fixture.transportEvidence,
    finalDmg: fixture.finalDmg,
    identity: evidenceIdentity,
    teamId: evidenceTeam,
    ...overrides,
  })
}

// The notarize job's hand-off to aggregation: the evidence beside the DMG and its checksum.
function writePublicationInputs(fixture: ReturnType<typeof finalDmgFixture>, evidence: Record<string, any>) {
  const evidencePath = join(fixture.temp, 'release-evidence.json')
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  writeFileSync(join(fixture.assets, 'SHA256SUMS.txt'), `${evidence.finalDmgSha256}  ${evidence.finalDmgName}\n`)
  return evidencePath
}

describe('macOS release gates', () => {
  it('accepts v1.0.1 only when every package version field matches', () => {
    const fixture = makeTaggedRepo('1.0.1')
    expect(validateReleaseTag({
      repoRoot: fixture.repo,
      ref: 'refs/tags/v1.0.1',
      sha: fixture.sha,
    })).toMatchObject({
      tag: 'v1.0.1',
      version: '1.0.1',
      sourceCommit: fixture.sha,
      taggedAt: fixtureTaggedAt,
      annotated: true,
    })

    const mismatch = makeTaggedRepo('1.0.1', '1.0.0')
    expect(() => validateReleaseTag({
      repoRoot: mismatch.repo,
      ref: 'refs/tags/v1.0.1',
      sha: mismatch.sha,
    })).toThrow(/tag\/package version mismatch/)
  })

  it('accepts only an annotated exact-version tag at checkout HEAD', () => {
    const fixture = makeTaggedRepo()
    expect(validateReleaseTag({
      repoRoot: fixture.repo,
      ref: `refs/tags/${fixture.tag}`,
      sha: fixture.sha,
    })).toMatchObject({
      tag: 'v1.2.3',
      version: '1.2.3',
      sourceCommit: fixture.sha,
      taggedAt: fixtureTaggedAt,
      annotated: true,
    })

    execFileSync('git', ['tag', 'v1.2.4'], { cwd: fixture.repo })
    expect(() => validateReleaseTag({
      repoRoot: fixture.repo,
      ref: 'refs/tags/v1.2.4',
      sha: fixture.sha,
    })).toThrow(/annotated tag/)
    expect(() => validateReleaseTag({
      repoRoot: fixture.repo,
      ref: 'refs/tags/v1.2.3',
      sha: 'b'.repeat(40),
    })).toThrow(/checkout commit/)
  })

  it('accepts a tag on trusted first-parent history after the default branch advances', () => {
    const fixture = makeTaggedRepo()
    writeFileSync(join(fixture.repo, 'later'), 'trusted follow-up\n')
    execFileSync('git', ['add', 'later'], { cwd: fixture.repo })
    execFileSync('git', [
      '-c', 'user.name=Release Test',
      '-c', 'user.email=release@example.invalid',
      'commit', '--quiet', '-m', 'trusted follow-up',
    ], { cwd: fixture.repo })
    const trustedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.repo,
      encoding: 'utf8',
    }).trim()
    expect(validateProtectedRelease({
      repoRoot: fixture.repo,
      context: {
        schema: 1,
        tag: fixture.tag,
        version: '1.2.3',
        sourceCommit: fixture.sha,
        taggedAt: fixture.taggedAt,
        annotated: true,
      },
      trustedSha,
      runHeadSha: fixture.sha,
    })).toMatchObject({ sourceCommit: fixture.sha, trustedSha, firstParent: true })
    expect(() => validateProtectedRelease({
      repoRoot: fixture.repo,
      context: {
        schema: 1,
        tag: fixture.tag,
        version: '1.2.3',
        sourceCommit: fixture.sha,
        taggedAt: '2026-08-25T20:12:52Z',
        annotated: true,
      },
      trustedSha,
      runHeadSha: fixture.sha,
    })).toThrow(/tag timestamp/)
    expect(() => validateProtectedRelease({
      repoRoot: fixture.repo,
      context: {
        schema: 1,
        tag: fixture.tag,
        version: '1.2.3',
        sourceCommit: fixture.sha,
        taggedAt: fixture.taggedAt,
        annotated: true,
      },
      trustedSha,
      runHeadSha: 'b'.repeat(40),
    })).toThrow(/workflow head SHA/)
    expect(() => validateProtectedRelease({
      repoRoot: fixture.repo,
      context: {
        schema: 1,
        tag: fixture.tag,
        version: '1.2.3',
        sourceCommit: fixture.sha,
        taggedAt: fixture.taggedAt,
        annotated: true,
      },
      trustedSha: fixture.sha,
      runHeadSha: fixture.sha,
    })).toThrow(/trusted workflow SHA/)
  })

  it('carries an older first-parent source through real thin handoff verification', async () => {
    const fixture = makeTaggedRepo()
    writeFileSync(join(fixture.repo, 'later'), 'trusted follow-up\n')
    execFileSync('git', ['add', 'later'], { cwd: fixture.repo })
    execFileSync('git', [
      '-c', 'user.name=Release Test',
      '-c', 'user.email=release@example.invalid',
      'commit', '--quiet', '-m', 'trusted follow-up',
    ], { cwd: fixture.repo })
    const trustedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.repo,
      encoding: 'utf8',
    }).trim()
    const context = {
      schema: 1,
      tag: fixture.tag,
      version: '1.2.3',
      sourceCommit: fixture.sha,
      taggedAt: fixture.taggedAt,
      annotated: true,
    } as const
    validateProtectedRelease({
      repoRoot: fixture.repo,
      context,
      trustedSha,
      runHeadSha: fixture.sha,
    })

    const temp = scratchDir('release-thin-handoff-')
    const runtimeManifestDigests = { 'darwin-arm64': 'a'.repeat(64) }
    const app = join(temp, 'arm64.app')
    const resources = join(app, 'Contents', 'Resources', 'app')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'setup-info.json'), `${JSON.stringify({
      runtimePayloads: { 'darwin-arm64': { digest: runtimeManifestDigests['darwin-arm64'] } },
    })}\n`)
    writeFileSync(join(resources, 'arch.txt'), 'arm64\n')
    const report = join(temp, 'arm64.json')
    writeFileSync(report, `${JSON.stringify({
      schema: 1,
      product: 'Agent Inbox',
      arch: 'arm64',
      packageVersion: context.version,
      electronVersion: loadReleaseInputs().electron.version,
      nodeVersion: loadReleaseInputs().node.version,
      nodeModulesAbi: '137',
      sourceCommit: context.sourceCommit,
      sourceDirty: false,
      runtimeSourceCommit: context.sourceCommit,
      nativeRuntimeSelftest: 'passed',
      electronSqliteCheck: 'passed',
      runtimeKeys: ['darwin-arm64'],
      nativeAddonArchitectures: ['arm64'],
      appTreeDigest: treeIdentity(app),
      runtimeManifestDigests,
    })}\n`)
    const arm64Archive = join(temp, 'thin-darwin-arm64.tar.gz')
    writeFileSync(arm64Archive, 'arm64 archive bytes')
    const handoff = await buildThinHandoff({ arm64Archive, arm64App: app, arm64Report: report, context })
    expect(Object.keys(handoff.archives)).toEqual(['thin-darwin-arm64.tar.gz'])
    const handoffPath = join(temp, 'thin-handoff.json')
    writeFileSync(handoffPath, `${JSON.stringify(handoff)}\n`)
    expect(validateThinHandoff({
      arm64Archive,
      evidencePath: handoffPath,
      context,
    })).toMatchObject({
      sourceCommit: fixture.sha,
      packageVersion: '1.2.3',
      verifiedByTrustedWorkflow: true,
    })
    // The macOS release is built from the Apple silicon thin app alone (#296).
    writeFileSync(handoffPath, `${JSON.stringify({
      ...handoff,
      archives: { ...handoff.archives, 'thin-darwin-x64.tar.gz': 'b'.repeat(64) },
    })}\n`)
    expect(() => validateThinHandoff({ arm64Archive, evidencePath: handoffPath, context }))
      .toThrow(/does not match trusted preflight evidence/)
  })

  it('rejects a tag reachable only through a merged second parent', () => {
    const repo = scratchDir('release-side-parent-')
    execFileSync('git', ['init', '--quiet'], { cwd: repo })
    writeFileSync(join(repo, 'package.json'), '{"version":"1.2.3"}\n')
    writeFileSync(join(repo, 'package-lock.json'), '{"version":"1.2.3","packages":{"":{"version":"1.2.3"}}}\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', [
      '-c', 'user.name=Release Test',
      '-c', 'user.email=release@example.invalid',
      'commit', '--quiet', '-m', 'base',
    ], { cwd: repo })
    execFileSync('git', ['branch', '-M', 'main'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: repo })
    writeFileSync(join(repo, 'side'), 'side release\n')
    execFileSync('git', ['add', 'side'], { cwd: repo })
    execFileSync('git', [
      '-c', 'user.name=Release Test',
      '-c', 'user.email=release@example.invalid',
      'commit', '--quiet', '-m', 'side release',
    ], { cwd: repo })
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    execFileSync('git', [
      '-c', 'user.name=Release Test',
      '-c', 'user.email=release@example.invalid',
      'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3',
    ], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    writeFileSync(join(repo, 'main'), 'main work\n')
    execFileSync('git', ['add', 'main'], { cwd: repo })
    execFileSync('git', [
      '-c', 'user.name=Release Test',
      '-c', 'user.email=release@example.invalid',
      'commit', '--quiet', '-m', 'main work',
    ], { cwd: repo })
    execFileSync('git', [
      '-c', 'user.name=Release Test',
      '-c', 'user.email=release@example.invalid',
      'merge', '--quiet', '--no-ff', 'side', '-m', 'merge side',
    ], { cwd: repo })
    const trustedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(() => validateProtectedRelease({
      repoRoot: repo,
      context: {
        schema: 1,
        tag: 'v1.2.3',
        version: '1.2.3',
        sourceCommit,
        taggedAt: taggedAt(repo, 'v1.2.3'),
        annotated: true,
      },
      trustedSha,
      runHeadSha: sourceCommit,
    })).toThrow(/first-parent/)
  })

  it('validates credential formats without returning secret material', () => {
    const signing = validateCredentialEnvironment({
      APPLE_DEVELOPER_ID_P12_BASE64: Buffer.from('fake-p12-bytes').toString('base64'),
      APPLE_DEVELOPER_ID_P12_PASSWORD: 'password',
      APPLE_DEVELOPER_IDENTITY: 'Developer ID Application: Example Corp (AB12CD34EF)',
      APPLE_TEAM_ID: 'AB12CD34EF',
    }, 'signing')
    expect(signing).toEqual({
      scope: 'signing',
      identity: 'Developer ID Application: Example Corp (AB12CD34EF)',
      teamId: 'AB12CD34EF',
    })
    expect(JSON.stringify(signing)).not.toContain('fake-p12')
    expect(() => validateCredentialEnvironment({
      APPLE_DEVELOPER_ID_P12_BASE64: 'not-base64',
      APPLE_DEVELOPER_ID_P12_PASSWORD: 'password',
      APPLE_DEVELOPER_IDENTITY: 'Developer ID Application: Example Corp (AB12CD34EF)',
      APPLE_TEAM_ID: 'ZZ12CD34EF',
    }, 'signing')).toThrow(ReleaseGateError)

    const notary = validateCredentialEnvironment({
      APPLE_NOTARY_PRIVATE_KEY_BASE64: Buffer.from(
        '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n',
      ).toString('base64'),
      APPLE_NOTARY_KEY_ID: 'A1B2C3D4E5',
      APPLE_NOTARY_ISSUER_ID: '12345678-1234-1234-1234-123456789abc',
    }, 'notary')
    expect(notary).toEqual({
      scope: 'notary',
      keyId: 'A1B2C3D4E5',
      issuerId: '12345678-1234-1234-1234-123456789abc',
    })
  })

  it('requires an Accepted notary submission and matching safe log metadata', () => {
    const temp = scratchDir('notary-receipt-')
    const submitted = join(temp, 'Agent Inbox.zip')
    const submitJson = join(temp, 'submit.json')
    const logJson = join(temp, 'log.json')
    writeFileSync(submitted, 'submitted bytes')
    writeFileSync(submitJson, JSON.stringify({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'Accepted',
      message: 'Processing complete',
    }))
    writeFileSync(logJson, JSON.stringify({
      jobId: '11111111-2222-3333-4444-555555555555',
      status: 'Accepted',
      statusCode: 0,
      statusSummary: 'Ready for distribution',
      archiveFilename: 'Agent Inbox.zip',
      sha256: createHash('sha256').update('submitted bytes').digest('hex'),
      issues: null,
      ticketContents: [{ path: 'Agent Inbox.app' }],
      uploadDate: '2026-08-16T00:00:00.000Z',
    }))
    expect(parseNotaryReceipt({
      kind: 'app',
      submitted,
      submitJson,
      logJson,
    })).toMatchObject({
      kind: 'app',
      submissionId: '11111111-2222-3333-4444-555555555555',
      status: 'Accepted',
      submittedName: 'Agent Inbox.zip',
    })
    const sanitized = JSON.stringify(parseNotaryReceipt({ kind: 'app', submitted, submitJson, logJson }))
    expect(sanitized).not.toContain('ticketContents')
    writeFileSync(submitJson, JSON.stringify({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'Invalid',
    }))
    expect(() => parseNotaryReceipt({ kind: 'app', submitted, submitJson, logJson }))
      .toThrow(/not Accepted/)
    writeFileSync(submitJson, JSON.stringify({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'Accepted',
    }))
    writeFileSync(logJson, JSON.stringify({
      jobId: '11111111-2222-3333-4444-555555555555',
      status: 'Accepted',
      statusCode: 0,
      archiveFilename: 'Agent Inbox.zip',
    }))
    expect(() => parseNotaryReceipt({ kind: 'app', submitted, submitJson, logJson }))
      .toThrow(/SHA-256/)
  })

  it('allows publication only for exact post-staple assets and distinct accepted tickets', () => {
    const fixture = finalDmgFixture()
    const evidence = finalEvidence(fixture)
    const evidencePath = writePublicationInputs(fixture, evidence)
    const { assets, context } = fixture
    const dmgName = 'Agent-Inbox-v1.2.3-arm64.dmg'
    expect(validatePublicationInputs({ assetsDir: assets, evidencePath, context })).toEqual({
      dmg: join(assets, dmgName),
      checksums: join(assets, 'SHA256SUMS.txt'),
      tag: 'v1.2.3',
      version: '1.2.3',
      macos: {
        kind: 'arm64',
        dmgName,
        architecture: 'arm64',
        target: 'darwin-arm64',
        needsNativeIntel: false,
        v1Manifest: 'restamp',
        architectures: { executable: ['arm64'], betterSqlite3: ['arm64'] },
      },
    })

    writeFileSync(join(assets, 'unexpected.zip'), 'no')
    expect(() => validatePublicationInputs({ assetsDir: assets, evidencePath, context }))
      .toThrow(/allowlist/)
    rmSync(join(assets, 'unexpected.zip'))
    writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, verification: {} }, null, 2)}\n`)
    expect(() => validatePublicationInputs({
      assetsDir: assets,
      evidencePath,
      context,
    })).toThrow(/does not authorize/)
    expect(() => finalEvidence(fixture, {
      appReceipt: { kind: 'app', submissionId: 'same', status: 'Accepted' },
      dmgReceipt: { kind: 'dmg', submissionId: 'same', status: 'Accepted' },
    })).toThrow(/distinct/)
  })

  it('always detaches a mounted final DMG when copied-app verification fails', async () => {
    const calls: string[] = []
    await expect(withMountedDmg({
      dmg: '/tmp/final.dmg',
      mount: '/tmp/final-mount',
      runCommand: (path, args) => {
        calls.push(`${path} ${args.join(' ')}`)
      },
      verify: () => {
        throw new Error('copied app validation failed')
      },
    })).rejects.toThrow(/copied app validation failed/)
    expect(calls).toEqual([
      '/usr/bin/hdiutil attach -nobrowse -readonly -mountpoint /tmp/final-mount /tmp/final.dmg',
      '/usr/bin/hdiutil detach /tmp/final-mount',
    ])
  })

  // #289: the final DMG is lzma-compressed (ULMO), which reads several times slower
  // than zlib: attaching verifies every block's checksum, and copying the app out
  // decompresses all of it. Neither may run into the gate's two-minute default.
  it('gives attaching the final DMG and copying its app out longer than the default two minutes', async () => {
    const timeouts = new Map<string, number | undefined>()
    await withMountedDmg({
      dmg: '/tmp/final.dmg',
      mount: '/tmp/final-mount',
      runCommand: (path, args, options) => {
        timeouts.set(`${path} ${args[0]}`, options?.timeout)
      },
      verify: () => undefined,
    })
    expect(timeouts.get('/usr/bin/hdiutil attach')).toBeGreaterThan(120_000)
    const source = readFileSync(join(root, 'scripts', 'macos-release-gates.mjs'), 'utf8')
    expect(source).toContain(
      "runCommand('/usr/bin/ditto', [join(mount, `${APP_NAME}.app`), copiedApp], { timeout: DMG_COPY_TIMEOUT_MS })",
    )
    expect(source).toMatch(/^const DMG_COPY_TIMEOUT_MS = 10 \* 60_000$/m)
  })

  it('activates the temporary keychain and exactly restores the original user search list', () => {
    const harness = makeSigningHarness()
    const imported = spawnSync('bash', [join(root, 'scripts', 'import-apple-signing.sh'), 'import'], {
      env: harness.env,
      encoding: 'utf8',
    })
    expect(imported.status, imported.stderr).toBe(0)
    expect(readFileSync(harness.githubOutput, 'utf8')).toContain(`keychain=${harness.keychain}`)
    const importCalls = readFileSync(harness.securityLog, 'utf8').trim().split('\n')
    const activated = [
      'list-keychains', '-d', 'user', '-s',
      harness.keychain,
      ...harness.originalKeychains,
    ].join('\t')
    expect(importCalls).toContain(activated)
    expect(importCalls.indexOf(activated)).toBeLessThan(
      importCalls.findIndex((call) => call.startsWith('find-identity\t')),
    )

    const cleanup = spawnSync('bash', [join(root, 'scripts', 'import-apple-signing.sh'), 'cleanup'], {
      env: harness.env,
      encoding: 'utf8',
    })
    expect(cleanup.status).toBe(0)
    expect(existsSync(harness.state)).toBe(false)
    const cleanupCalls = readFileSync(harness.securityLog, 'utf8').trim().split('\n')
    const restored = [
      'list-keychains', '-d', 'user', '-s', ...harness.originalKeychains,
    ].join('\t')
    expect(cleanupCalls).toContain(restored)
    expect(cleanupCalls.indexOf(restored)).toBeLessThan(
      cleanupCalls.findIndex((call) => call === `delete-keychain\t${harness.keychain}`),
    )
  })

  it('supports an empty original search list under Bash noun-set mode', () => {
    const harness = makeSigningHarness(true)
    const imported = spawnSync('/bin/bash', [join(root, 'scripts', 'import-apple-signing.sh'), 'import'], {
      env: harness.env,
      encoding: 'utf8',
    })
    expect(imported.status, imported.stderr).toBe(0)
    expect(readFileSync(harness.securityLog, 'utf8').trim().split('\n')).toContain(
      ['list-keychains', '-d', 'user', '-s', harness.keychain].join('\t'),
    )

    const cleanup = spawnSync('/bin/bash', [join(root, 'scripts', 'import-apple-signing.sh'), 'cleanup'], {
      env: harness.env,
      encoding: 'utf8',
    })
    expect(cleanup.status, cleanup.stderr).toBe(0)
    expect(existsSync(harness.state)).toBe(false)
    expect(readFileSync(harness.securityLog, 'utf8').trim().split('\n')).toContain(
      ['list-keychains', '-d', 'user', '-s'].join('\t'),
    )
  })

  it('restores and destroys signing state when search-list activation fails', () => {
    const harness = makeSigningHarness()
    const imported = spawnSync('bash', [join(root, 'scripts', 'import-apple-signing.sh'), 'import'], {
      env: { ...harness.env, FAIL_ACTIVATION: '1' },
      encoding: 'utf8',
    })
    expect(imported.status).not.toBe(0)
    expect(existsSync(harness.state)).toBe(false)
    const calls = readFileSync(harness.securityLog, 'utf8').trim().split('\n')
    expect(calls).toContain([
      'list-keychains', '-d', 'user', '-s', ...harness.originalKeychains,
    ].join('\t'))
    expect(calls.at(-1)).toBe(`delete-keychain\t${harness.keychain}`)
  })

  it('fails closed but still destroys signing state when restoration fails', () => {
    const harness = makeSigningHarness()
    const imported = spawnSync('bash', [join(root, 'scripts', 'import-apple-signing.sh'), 'import'], {
      env: harness.env,
      encoding: 'utf8',
    })
    expect(imported.status, imported.stderr).toBe(0)
    const cleanup = spawnSync('bash', [join(root, 'scripts', 'import-apple-signing.sh'), 'cleanup'], {
      env: { ...harness.env, FAIL_RESTORE: '1' },
      encoding: 'utf8',
    })
    expect(cleanup.status).not.toBe(0)
    expect(existsSync(harness.state)).toBe(false)
    expect(readFileSync(harness.securityLog, 'utf8').trim().split('\n').at(-1))
      .toBe(`delete-keychain\t${harness.keychain}`)
  })

  it('keeps notary key bytes temporary and staples only after an accepted receipt', () => {
    const run = runNotarize()
    expect(run.status, run.stderr).toBe(0)
    expect(run.receipt).toContain('"status": "Accepted"')
    expect(run.calls).toEqual(['notarytool submit', 'notarytool log', 'stapler staple', 'stapler validate'])
    expect(run.sleeps).toEqual([])
    expect(run.notaryWorkDirs).toEqual([])
  })

  it('retries a dropped Apple ticket connection or unpublished ticket with bounded backoff', () => {
    const run = runNotarize({
      staple: [staplerConnectionLost('staple'), staplerTicketNotPublished],
      validate: [staplerConnectionLost('validate')],
    })
    expect(run.status, run.output).toBe(0)
    expect(run.calls).toEqual([
      'notarytool submit',
      'notarytool log',
      'stapler staple',
      'stapler staple',
      'stapler staple',
      'stapler validate',
      'stapler validate',
    ])
    expect(run.sleeps).toEqual([15, 30, 15])
    expect(run.output).toContain(staplerConnectionLost('staple').output)
    expect(run.output).toContain(staplerTicketNotPublished.output)
    expect(run.output).toContain(staplerConnectionLost('validate').output)
    expect(run.output).toContain('The staple and validate action worked!')
    expect(run.output).toContain('The validate action worked!')
    expect(run.notaryWorkDirs).toEqual([])
  })

  it.each([
    {
      action: 'validate' as const,
      failure: staplerNotStapled,
      staplerCalls: ['stapler staple', 'stapler validate'],
    },
    {
      action: 'staple' as const,
      failure: { status: 68, output: 'The staple and validate action failed! Error 68.' },
      staplerCalls: ['stapler staple'],
    },
  ])('stops at once with stapler output and status for a non-transient $action failure', (
    { action, failure, staplerCalls },
  ) => {
    const run = runNotarize({ [action]: [failure, failure] })
    expect(run.status).toBe(failure.status)
    expect(run.calls).toEqual(['notarytool submit', 'notarytool log', ...staplerCalls])
    expect(run.sleeps).toEqual([])
    expect(run.output).toContain(failure.output)
  })

  it('gives up after five transient stapler failures with the last output and status', () => {
    const failures = staplerOutages('staple', 6)
    const run = runNotarize({ staple: failures })
    expect(run.status).toBe(68)
    expect(run.calls).toEqual(['notarytool submit', 'notarytool log', ...Array(5).fill('stapler staple')])
    expect(run.sleeps).toEqual([15, 30, 60, 120])
    expect(run.stderr).toContain(failures[4]!.output)
    expect(run.notaryWorkDirs).toEqual([])
  })

  it.each([
    {
      outcome: 'retries transient failures, then reaches the signature gate',
      failures: [staplerConnectionLost('validate'), staplerTicketNotPublished],
      status: 1,
      attempts: 3,
      sleeps: [15, 30],
      logged: [
        staplerConnectionLost('validate').output,
        staplerTicketNotPublished.output,
        'The validate action worked!',
        'codesign --verify',
      ],
    },
    {
      outcome: 'gives up after five transient failures with the last output and status',
      failures: staplerOutages('validate', 6),
      status: 68,
      attempts: 5,
      sleeps: [15, 30, 60, 120],
      logged: [staplerOutages('validate', 5)[4]!.output],
    },
    {
      outcome: 'stops at once with stapler output and status on a non-transient failure',
      failures: [staplerNotStapled, staplerNotStapled],
      status: 65,
      attempts: 1,
      sleeps: [],
      logged: [staplerNotStapled.output],
    },
  ])('build-dmg stapler validate $outcome', ({ failures, status, attempts, sleeps, logged }) => {
    const run = runBuildDmg(failures)
    expect(run.status, run.stderr).toBe(status)
    expect(run.calls).toEqual(Array(attempts).fill('stapler validate'))
    expect(run.sleeps).toEqual(sleeps)
    for (const text of logged) expect(run.stderr).toContain(text)
  })

  it('sends every stapler call in the release gates through the one retry helper', () => {
    // verify-final-dmg and final-evidence check real Developer ID signatures before their
    // stapler validate, so tests cannot drive those calls; pin that they use the helper.
    const gates = readFileSync(join(root, 'scripts', 'macos-release-gates.mjs'), 'utf8')
    expect(gates.match(/\[\s*'stapler'/g)).toHaveLength(1)
    expect(gates.match(/runStapler\('validate', \w+\)/g)).toEqual([
      "runStapler('validate', app)",
      "runStapler('validate', copiedApp)",
      "runStapler('validate', app)",
      "runStapler('validate', dmg)",
    ])
  })
})

describe('the macOS release kind comes from the measured CPU types (#341)', () => {
  it('records both lipo sets, sorted, and the kind they give', () => {
    expect(transportedAppArchitectures({
      executable: 'x86_64 arm64',
      betterSqlite3: 'arm64 x86_64',
      expected: UNIVERSAL,
    })).toEqual({
      architectures: { executable: ['arm64', 'x86_64'], betterSqlite3: ['arm64', 'x86_64'] },
      kind: 'universal',
    })
    expect(transportedAppArchitectures({ executable: 'arm64', betterSqlite3: 'arm64', expected: ARM64_ONLY }))
      .toEqual({ architectures: { executable: ['arm64'], betterSqlite3: ['arm64'] }, kind: 'arm64' })
  })

  it.each([
    ['the executable and the addon differ', 'x86_64 arm64', 'arm64', UNIVERSAL,
      /executable's CPU types \["arm64","x86_64"\] differ from the better-sqlite3 addon's \["arm64"\]/],
    ['they hold x86_64 alone', 'x86_64', 'x86_64', UNIVERSAL, /\["x86_64"\] give no macOS release kind/],
    ['they hold arm64 alone where universal is expected', 'arm64', 'arm64', UNIVERSAL,
      /\["arm64"\] differ from the expected \["arm64","x86_64"\]/],
    ['they are universal where arm64 is expected', 'arm64 x86_64', 'x86_64 arm64', ARM64_ONLY,
      /\["arm64","x86_64"\] differ from the expected \["arm64"\]/],
    ['a CPU type is unknown', 'arm64e x86_64', 'arm64e x86_64', UNIVERSAL, /give no macOS release kind/],
    ['lipo printed nothing', '', '', UNIVERSAL, /\[\] give no macOS release kind/],
  ])('refuses measured sets when %s', (_, executable, betterSqlite3, expected, error) => {
    expect(() => transportedAppArchitectures({ executable, betterSqlite3, expected })).toThrow(error)
  })

  it('derives the DMG name, architecture and target from the kind alone', () => {
    expect(macosRelease({ kind: macosKindOf(UNIVERSAL), tag: 'v1.7.0' })).toMatchObject({
      kind: 'universal',
      dmgName: 'Agent-Inbox-v1.7.0-universal.dmg',
      architecture: 'universal',
      target: 'darwin-arm64+darwin-x64',
      needsNativeIntel: true,
    })
    expect(macosRelease({ kind: macosKindOf(ARM64_ONLY), tag: 'v2.0.0' })).toMatchObject({
      kind: 'arm64',
      dmgName: 'Agent-Inbox-v2.0.0-arm64.dmg',
      architecture: 'arm64',
      target: 'darwin-arm64',
      needsNativeIntel: false,
    })
    expect(() => macosKindOf(['x86_64', 'arm64'])).toThrow(/give no macOS release kind/)
  })

  it('names the final DMG from the kind and carries a universal release\'s Intel gate', () => {
    const arm64 = finalDmgFixture()
    const arm64Evidence = finalEvidence(arm64)
    expect(arm64Evidence.finalDmgName).toBe('Agent-Inbox-v1.2.3-arm64.dmg')
    expect(arm64Evidence.transportedApp).toMatchObject({
      architectures: { executable: ARM64_ONLY, betterSqlite3: ARM64_ONLY },
      kind: 'arm64',
    })
    expect(arm64Evidence.transportedApp).not.toHaveProperty('universalEnvelope')
    expect(arm64Evidence).not.toHaveProperty('nativeIntel')

    const universal = universalFixture()
    const evidence = finalEvidence(universal, { expected: UNIVERSAL, intelEvidence: nativeIntelRecord(universal.context) })
    expect(evidence.finalDmgName).toBe('Agent-Inbox-v1.2.3-universal.dmg')
    expect(evidence.nativeIntel).toEqual(nativeIntelRecord(universal.context))
  })

  const intelRecord = nativeIntelRecord({ sourceCommit: 'a'.repeat(40), version: '1.2.3' })
  it.each([
    {
      refused: 'arm64-only sets with the universal DMG name',
      fixture: { dmgName: 'Agent-Inbox-v1.2.3-universal.dmg' },
      overrides: {},
      error: /final DMG must be named Agent-Inbox-v1\.2\.3-arm64\.dmg/,
    },
    {
      refused: 'arm64-only sets with the universal label',
      fixture: { kind: 'universal' },
      overrides: {},
      error: /labels the release "universal", but its measured CPU types give arm64/,
    },
    {
      refused: 'universal sets, now that the committed expected set is arm64 alone (#296)',
      fixture: { dmgName: 'Agent-Inbox-v1.2.3-universal.dmg', executable: UNIVERSAL, kind: 'universal' },
      overrides: { intelEvidence: intelRecord },
      error: /\["arm64","x86_64"\] differ from the expected \["arm64"\] in release\/macos-inputs\.json/,
    },
    {
      refused: 'x86_64 alone',
      fixture: { executable: ['x86_64'] },
      overrides: {},
      error: /\["x86_64"\] give no macOS release kind/,
    },
    {
      refused: 'an Intel slice in the better-sqlite3 addon alone',
      fixture: { betterSqlite3: UNIVERSAL },
      overrides: {},
      error: /\["arm64"\] differ from the better-sqlite3 addon's \["arm64","x86_64"\]/,
    },
    {
      refused: 'arm64-only sets where universal is expected',
      fixture: {},
      overrides: { expected: UNIVERSAL },
      error: /differ from the expected \["arm64","x86_64"\]/,
    },
    {
      refused: 'a universal kind without the native Intel gate',
      fixture: { dmgName: 'Agent-Inbox-v1.2.3-universal.dmg', executable: UNIVERSAL, kind: 'universal' },
      overrides: { expected: UNIVERSAL },
      error: /native Intel gate/,
    },
    {
      refused: 'a universal kind whose Intel gate did not pass',
      fixture: { dmgName: 'Agent-Inbox-v1.2.3-universal.dmg', executable: UNIVERSAL, kind: 'universal' },
      overrides: { expected: UNIVERSAL, intelEvidence: { ...intelRecord, status: 'failed' } },
      error: /native Intel gate/,
    },
    {
      refused: 'a universal kind whose Intel gate checked another source',
      fixture: { dmgName: 'Agent-Inbox-v1.2.3-universal.dmg', executable: UNIVERSAL, kind: 'universal' },
      overrides: { expected: UNIVERSAL, intelEvidence: { ...intelRecord, sourceCommit: 'e'.repeat(40) } },
      error: /native Intel gate/,
    },
    {
      refused: 'an arm64 kind that claims an Intel gate',
      fixture: {},
      overrides: { intelEvidence: intelRecord },
      error: /an arm64 release has no native Intel gate/,
    },
  ])('refuses $refused in the final evidence', ({ fixture, overrides, error }) => {
    expect(() => finalEvidence(finalDmgFixture(fixture), overrides)).toThrow(error)
  })

  it('publishes an arm64 release under the committed expected set, and a universal one only under its own', () => {
    const fixture = finalDmgFixture()
    const evidencePath = writePublicationInputs(fixture, finalEvidence(fixture))
    expect(validatePublicationInputs({
      assetsDir: fixture.assets,
      evidencePath,
      context: fixture.context,
    }).macos).toMatchObject({
      kind: 'arm64',
      dmgName: 'Agent-Inbox-v1.2.3-arm64.dmg',
      architecture: 'arm64',
      target: 'darwin-arm64',
      architectures: { executable: ARM64_ONLY, betterSqlite3: ARM64_ONLY },
    })
    expect(() => validatePublicationInputs({ assetsDir: fixture.assets, evidencePath, context: fixture.context, expected: UNIVERSAL }))
      .toThrow(/differ from the expected \["arm64","x86_64"\]/)

    // A universal release, which only a universal expected set could publish (#296 committed arm64).
    const universal = universalFixture()
    const universalPath = writePublicationInputs(universal, finalEvidence(universal, {
      expected: UNIVERSAL,
      intelEvidence: nativeIntelRecord(universal.context),
    }))
    expect(validatePublicationInputs({
      assetsDir: universal.assets,
      evidencePath: universalPath,
      context: universal.context,
      expected: UNIVERSAL,
    }).macos).toMatchObject({ kind: 'universal', dmgName: 'Agent-Inbox-v1.2.3-universal.dmg' })
    expect(() => validatePublicationInputs({ assetsDir: universal.assets, evidencePath: universalPath, context: universal.context }))
      .toThrow(/\["arm64","x86_64"\] differ from the expected \["arm64"\]/)
  })

  it.each([
    {
      refused: 'arm64-only sets under the universal DMG name',
      tamper: (evidence: Record<string, any>) => {
        evidence.transportedApp.architectures = { executable: ARM64_ONLY, betterSqlite3: ARM64_ONLY }
        evidence.transportedApp.kind = 'arm64'
        delete evidence.nativeIntel
      },
      expected: ARM64_ONLY,
      error: /allowlist mismatch: expected Agent-Inbox-v1\.2\.3-arm64\.dmg/,
    },
    {
      refused: 'arm64-only sets with the universal label',
      tamper: (evidence: Record<string, any>) => {
        evidence.transportedApp.architectures = { executable: ARM64_ONLY, betterSqlite3: ARM64_ONLY }
        delete evidence.nativeIntel
      },
      expected: ARM64_ONLY,
      error: /labels the release "universal", but its measured CPU types give arm64/,
    },
    {
      refused: 'universal sets under the committed arm64 set (#296)',
      tamper: () => {},
      expected: undefined,
      error: /\["arm64","x86_64"\] differ from the expected \["arm64"\]/,
    },
    {
      refused: 'sets that differ between the executable and the addon',
      tamper: (evidence: Record<string, any>) => {
        evidence.transportedApp.architectures.betterSqlite3 = ARM64_ONLY
      },
      expected: UNIVERSAL,
      error: /differ from the better-sqlite3 addon's/,
    },
    {
      refused: 'sets that differ from the expected set',
      tamper: (evidence: Record<string, any>) => {
        evidence.transportedApp.architectures = { executable: ARM64_ONLY, betterSqlite3: ARM64_ONLY }
        evidence.transportedApp.kind = 'arm64'
      },
      expected: UNIVERSAL,
      error: /differ from the expected \["arm64","x86_64"\]/,
    },
    {
      refused: 'the old universal flag instead of measured sets',
      tamper: (evidence: Record<string, any>) => {
        delete evidence.transportedApp.architectures
        delete evidence.transportedApp.kind
        evidence.transportedApp.universalEnvelope = 'passed'
      },
      expected: UNIVERSAL,
      error: /give no macOS release kind/,
    },
    {
      refused: 'a third measured file',
      tamper: (evidence: Record<string, any>) => {
        evidence.transportedApp.architectures.helper = ARM64_ONLY
      },
      expected: UNIVERSAL,
      error: /must record only executable and betterSqlite3/,
    },
    {
      refused: 'a universal kind without the native Intel gate',
      tamper: (evidence: Record<string, any>) => {
        delete evidence.nativeIntel
      },
      expected: UNIVERSAL,
      error: /native Intel gate/,
    },
    {
      refused: 'a universal kind whose Intel gate signed as someone else',
      tamper: (evidence: Record<string, any>) => {
        evidence.nativeIntel.identity = 'Developer ID Application: Someone Else (ZZ12CD34EF)'
      },
      expected: UNIVERSAL,
      error: /native Intel gate/,
    },
  ])('refuses publication evidence with $refused', ({ tamper, expected, error }) => {
    const fixture = universalFixture()
    const evidence = structuredClone(finalEvidence(fixture, { expected: UNIVERSAL, intelEvidence: nativeIntelRecord(fixture.context) }))
    tamper(evidence)
    const evidencePath = writePublicationInputs(fixture, { ...evidence, finalDmgName: 'Agent-Inbox-v1.2.3-universal.dmg' })
    expect(() => validatePublicationInputs({
      assetsDir: fixture.assets,
      evidencePath,
      context: fixture.context,
      ...(expected ? { expected } : {}),
    })).toThrow(error)
  })

  it('hands the notarize job the DMG name of the committed expected kind', () => {
    const outputs = join(scratchDir('expected-kind-'), 'github-output')
    const run = spawnSync(process.execPath, [
      join(root, 'scripts', 'macos-release-gates.mjs'),
      'expected-kind',
      '--tag', 'v1.2.3',
    ], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: outputs }, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(readFileSync(outputs, 'utf8')).toBe('kind=arm64\ndmg-name=Agent-Inbox-v1.2.3-arm64.dmg\n')
    expect(JSON.parse(run.stdout)).toMatchObject({ kind: 'arm64', dmgName: 'Agent-Inbox-v1.2.3-arm64.dmg' })
  })

  it('expects the remote draft to hold the DMG named from the expected kind', () => {
    const remotePath = join(scratchDir('remote-draft-'), 'remote-draft.json')
    const draft = (dmgName: string) => writeFileSync(remotePath, JSON.stringify({
      tagName: 'v1.2.3',
      isDraft: true,
      assets: [{ name: dmgName, size: 1 }, { name: 'SHA256SUMS.txt', size: 1 }],
    }))
    draft('Agent-Inbox-v1.2.3-arm64.dmg')
    expect(validateRemoteDraft({ remotePath, tag: 'v1.2.3' }).tagName).toBe('v1.2.3')
    expect(() => validateRemoteDraft({ remotePath, tag: 'v1.2.3', expected: UNIVERSAL })).toThrow(/allowlist/)
    draft('Agent-Inbox-v1.2.3-universal.dmg')
    expect(() => validateRemoteDraft({ remotePath, tag: 'v1.2.3' })).toThrow(/allowlist/)
    expect(validateRemoteDraft({ remotePath, tag: 'v1.2.3', expected: UNIVERSAL }).tagName).toBe('v1.2.3')
  })

  it('measures the copied app with lipo and names, labels and targets the DMG only through the mapping', () => {
    const gates = readFileSync(join(root, 'scripts', 'macos-release-gates.mjs'), 'utf8')
    const verify = gates.slice(
      gates.indexOf('export async function verifyFinalDmg({'),
      gates.indexOf('export function buildFinalReleaseEvidence({'),
    )
    expect(verify).toContain("lipoArchitectures(join(contents, 'MacOS', APP_NAME))")
    expect(verify).toContain(
      "lipoArchitectures(join(appResources, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))",
    )
    expect(verify).toContain('expected: inputs.macosArchitectures')
    expect(verify).toContain('...measured,')
    expect(verify).not.toContain('universalEnvelope')
    for (const file of ['macos-release-gates.mjs', 'release-aggregation.mjs']) {
      const source = readFileSync(join(root, 'scripts', file), 'utf8')
      expect(source, file).toContain("from './macos-release-kind.mjs'")
      expect(source, file).not.toContain('-universal.dmg')
      expect(source, file).not.toContain('darwin-arm64+darwin-x64')
      expect(source, file).not.toMatch(/['"`]universal['"`]/)
      expect(source, file).not.toMatch(/\[\s*'arm64',\s*'x86_64'\s*\]/)
    }
  })
})

// An arm64 release's notes name the release Intel Macs stay on (#296): the newest published
// release with a universal DMG, the one its update-manifest.json re-stamps (G6).
describe('the release Intel Macs stay on', () => {
  let nextAssetId = 900
  const listed = (tag: string, names: string[], draft = false) => ({
    tag_name: tag,
    draft,
    prerelease: false,
    assets: names.map((name) => ({
      id: (nextAssetId += 1),
      name,
      size: 10,
      browser_download_url: `https://github.com/shariqh/agent-inbox/releases/download/${tag}/${name}`,
    })),
  })
  const universal = (tag: string, draft = false) => listed(tag, [`Agent-Inbox-${tag}-universal.dmg`, 'update-manifest.json'], draft)
  const arm64 = (tag: string) => listed(tag, [`Agent-Inbox-${tag}-arm64.dmg`, 'update-manifest.json', 'update-manifest-v2.json'])

  it('is the newest published release with a universal DMG, read from every page of the listing', () => {
    const pages = [[arm64('v2.0.1'), arm64('v2.0.0')], [universal('v1.9.0', true), universal('v1.8.0'), universal('v1.7.0')]]
    expect(intelRelease({ pages, tag: 'v2.0.2' })).toEqual({ tag: 'v1.8.0', version: '1.8.0' })
    // A re-run after publication lists this release too, which is not an earlier one.
    expect(intelRelease({ pages: [[arm64('v2.0.2'), ...pages[0]!], pages[1]!], tag: 'v2.0.2' }))
      .toEqual({ tag: 'v1.8.0', version: '1.8.0' })
    expect(() => intelRelease({ pages: [[arm64('v2.0.0')]], tag: 'v2.0.1' })).toThrow(/no published release has a universal DMG/)
    expect(() => intelRelease({ pages: [[universal('v1.8.0'), arm64('v2.1.0')]], tag: 'v2.0.1' }))
      .toThrow(/prior stable release v2\.1\.0 is not older than the new release v2\.0\.1/)
    expect(() => intelRelease({ pages: [universal('v1.8.0')], tag: 'v2.0.1' })).toThrow(/pagination response is malformed/)
  })

  it('hands the release notes its tag as a step output', () => {
    const temp = scratchDir('intel-release-')
    const releases = join(temp, 'release-pages.json')
    const outputs = join(temp, 'github-output')
    writeFileSync(releases, JSON.stringify([[arm64('v2.0.0'), universal('v1.8.0')]]))
    const run = spawnSync(process.execPath, [
      join(root, 'scripts', 'macos-release-gates.mjs'),
      'intel-release',
      '--releases', releases,
      '--tag', 'v2.0.1',
    ], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: outputs }, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(readFileSync(outputs, 'utf8')).toBe('intel-tag=v1.8.0\n')
  })
})
