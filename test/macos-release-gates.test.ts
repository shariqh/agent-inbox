import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ReleaseGateError,
  buildThinHandoff,
  buildFinalReleaseEvidence,
  parseNotaryReceipt,
  validateCredentialEnvironment,
  validatePublicationInputs,
  validateProtectedRelease,
  validateReleaseTag,
  validateThinHandoff,
  withMountedDmg,
} from '../scripts/macos-release-gates.mjs'
import { treeIdentity } from '../scripts/tree-identity.mjs'

const root = resolve(process.cwd())
const signingIdentity = 'Developer ID Application: Release Test (AB12CD34EF)'

function makeSigningHarness(emptySearchList = false) {
  const temp = mkdtempSync(join(tmpdir(), 'release-signing-'))
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
  const repo = mkdtempSync(join(tmpdir(), 'release-tag-'))
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
  ], { cwd: repo })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  return { repo, sha, tag: `v${version}` }
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
      annotated: true,
    } as const
    validateProtectedRelease({
      repoRoot: fixture.repo,
      context,
      trustedSha,
      runHeadSha: fixture.sha,
    })

    const temp = mkdtempSync(join(tmpdir(), 'release-thin-handoff-'))
    const runtimeManifestDigests = {
      'darwin-arm64': 'a'.repeat(64),
      'darwin-x64': 'b'.repeat(64),
    }
    const reports: Record<string, string> = {}
    const apps: Record<string, string> = {}
    for (const arch of ['arm64', 'x64'] as const) {
      const app = join(temp, `${arch}.app`)
      const resources = join(app, 'Contents', 'Resources', 'app')
      mkdirSync(resources, { recursive: true })
      writeFileSync(join(resources, 'setup-info.json'), `${JSON.stringify({
        runtimePayloads: {
          'darwin-arm64': { digest: runtimeManifestDigests['darwin-arm64'] },
          'darwin-x64': { digest: runtimeManifestDigests['darwin-x64'] },
        },
      })}\n`)
      writeFileSync(join(resources, 'arch.txt'), `${arch}\n`)
      const report = join(temp, `${arch}.json`)
      writeFileSync(report, `${JSON.stringify({
        schema: 1,
        product: 'Agent Inbox',
        arch,
        packageVersion: context.version,
        electronVersion: '43.1.1',
        nodeVersion: 'v24.19.0',
        nodeModulesAbi: '137',
        sourceCommit: context.sourceCommit,
        sourceDirty: false,
        runtimeSourceCommit: context.sourceCommit,
        nativeRuntimeSelftest: 'passed',
        runtimeKeys: ['darwin-arm64', 'darwin-x64'],
        nativeAddonArchitectures: arch === 'arm64' ? ['arm64'] : ['x86_64'],
        appTreeDigest: treeIdentity(app),
        runtimeManifestDigests,
      })}\n`)
      apps[arch] = app
      reports[arch] = report
    }
    const arm64Archive = join(temp, 'thin-darwin-arm64.tar.gz')
    const x64Archive = join(temp, 'thin-darwin-x64.tar.gz')
    writeFileSync(arm64Archive, 'arm64 archive bytes')
    writeFileSync(x64Archive, 'x64 archive bytes')
    const handoff = await buildThinHandoff({
      arm64Archive,
      x64Archive,
      arm64App: apps.arm64!,
      x64App: apps.x64!,
      arm64Report: reports.arm64!,
      x64Report: reports.x64!,
      context,
    })
    const handoffPath = join(temp, 'thin-handoff.json')
    writeFileSync(handoffPath, `${JSON.stringify(handoff)}\n`)
    expect(validateThinHandoff({
      arm64Archive,
      x64Archive,
      evidencePath: handoffPath,
      context,
    })).toMatchObject({
      sourceCommit: fixture.sha,
      packageVersion: '1.2.3',
      verifiedByTrustedWorkflow: true,
    })
  })

  it('rejects a tag reachable only through a merged second parent', () => {
    const repo = mkdtempSync(join(tmpdir(), 'release-side-parent-'))
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
    const temp = mkdtempSync(join(tmpdir(), 'notary-receipt-'))
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
    const temp = mkdtempSync(join(tmpdir(), 'release-assets-'))
    const assets = join(temp, 'assets')
    mkdirSync(assets)
    const dmgName = 'Agent-Inbox-v1.2.3-universal.dmg'
    writeFileSync(join(assets, dmgName), 'final stapled dmg')
    const context = {
      schema: 1,
      tag: 'v1.2.3',
      version: '1.2.3',
      sourceCommit: 'a'.repeat(40),
      annotated: true,
    } as const
    const identity = 'Developer ID Application: Example Corp (AB12CD34EF)'
    const teamId = 'AB12CD34EF'
    const transportEvidence = {
      schema: 1,
      status: 'passed',
      sourceCommit: context.sourceCommit,
      packageVersion: context.version,
      finalDmgSha256: createHash('sha256').update('final stapled dmg').digest('hex'),
      identity,
      teamId,
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
    const evidence = buildFinalReleaseEvidence({
      context,
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
      transportEvidence,
      finalDmg: join(assets, dmgName),
      identity,
      teamId,
    })
    const evidencePath = join(temp, 'release-evidence.json')
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    writeFileSync(join(assets, 'SHA256SUMS.txt'), `${evidence.finalDmgSha256}  ${dmgName}\n`)
    expect(validatePublicationInputs({ assetsDir: assets, evidencePath, context })).toEqual({
      dmg: join(assets, dmgName),
      checksums: join(assets, 'SHA256SUMS.txt'),
      tag: 'v1.2.3',
      version: '1.2.3',
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
    expect(() => buildFinalReleaseEvidence({
      context,
      appReceipt: { kind: 'app', submissionId: 'same', status: 'Accepted' },
      dmgReceipt: { kind: 'dmg', submissionId: 'same', status: 'Accepted' },
      transportEvidence,
      finalDmg: join(assets, dmgName),
      identity: 'Developer ID Application: Example Corp (AB12CD34EF)',
      teamId: 'AB12CD34EF',
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
    const temp = mkdtempSync(join(tmpdir(), 'notary-process-'))
    const submitted = join(temp, 'Agent Inbox.zip')
    const stapleTarget = join(temp, 'Agent Inbox.app')
    const receipt = join(temp, 'receipt.json')
    const xcrun = join(temp, 'xcrun')
    const xcrunLog = join(temp, 'xcrun.log')
    const digest = createHash('sha256').update('zip bytes').digest('hex')
    writeFileSync(submitted, 'zip bytes')
    mkdirSync(stapleTarget)
    writeFileSync(xcrun, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${xcrunLog}"
if [ "$1 $2" = "notarytool submit" ]; then
  printf '%s\\n' '{"id":"11111111-2222-3333-4444-555555555555","status":"Accepted"}'
elif [ "$1 $2" = "notarytool log" ]; then
  printf '%s\\n' '{"jobId":"11111111-2222-3333-4444-555555555555","status":"Accepted","statusCode":0,"archiveFilename":"Agent Inbox.zip","sha256":"${digest}","issues":[]}' > "$4"
fi
`)
    chmodSync(xcrun, 0o755)
    const result = spawnSync('bash', [
      join(root, 'scripts', 'notarize-macos.sh'),
      'app',
      submitted,
      stapleTarget,
      receipt,
    ], {
      cwd: root,
      env: {
        ...process.env,
        APPLE_XCRUN_BIN: xcrun,
        APPLE_NOTARY_PRIVATE_KEY_BASE64: Buffer.from(
          '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n',
        ).toString('base64'),
        APPLE_NOTARY_KEY_ID: 'A1B2C3D4E5',
        APPLE_NOTARY_ISSUER_ID: '12345678-1234-1234-1234-123456789abc',
        RUNNER_TEMP: temp,
      },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(receipt, 'utf8')).toContain('"status": "Accepted"')
    const calls = readFileSync(xcrunLog, 'utf8')
    expect(calls.indexOf('notarytool submit')).toBeLessThan(calls.indexOf('notarytool log'))
    expect(calls.indexOf('notarytool log')).toBeLessThan(calls.indexOf('stapler staple'))
    expect(calls.indexOf('stapler staple')).toBeLessThan(calls.indexOf('stapler validate'))
    expect(readdirSync(temp).filter((name) => name.startsWith('agent-inbox-notary.'))).toEqual([])
  })
})
