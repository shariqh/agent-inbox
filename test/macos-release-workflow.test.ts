import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const inputsPath = join(root, '.github', 'workflows', 'macos-release.yml')
const protectedPath = join(root, '.github', 'workflows', 'macos-release-protected.yml')
const sourceCommit = 'a'.repeat(40)

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

function writePublishHandoff(directory: string) {
  const assets = join(directory, 'release-assets')
  mkdirSync(assets, { recursive: true })
  const dmgName = 'Agent-Inbox-v1.2.3-universal.dmg'
  const dmgBytes = 'final post-staple bytes'
  writeFileSync(join(assets, dmgName), dmgBytes)
  const digest = createHash('sha256').update(dmgBytes).digest('hex')
  writeFileSync(join(assets, 'SHA256SUMS.txt'), `${digest}  ${dmgName}\n`)
  writeFileSync(join(directory, 'RELEASE_NOTES.md'), 'Notarized release.\n')
  writeFileSync(join(directory, 'release-context.json'), `${JSON.stringify({
    schema: 1,
    tag: 'v1.2.3',
    version: '1.2.3',
    sourceCommit,
    annotated: true,
  })}\n`)
  const identity = 'Developer ID Application: Example Corp (AB12CD34EF)'
  const teamId = 'AB12CD34EF'
  writeFileSync(join(directory, 'release-evidence.json'), `${JSON.stringify({
    schema: 1,
    tag: 'v1.2.3',
    packageVersion: '1.2.3',
    sourceCommit,
    annotatedTag: true,
    identity,
    teamId,
    finalDmgName: dmgName,
    finalDmgSha256: digest,
    appNotarization: { status: 'Accepted', submissionId: 'app-ticket' },
    dmgNotarization: { status: 'Accepted', submissionId: 'dmg-ticket' },
    transportedApp: {
      schema: 1,
      status: 'passed',
      sourceCommit,
      packageVersion: '1.2.3',
      finalDmgSha256: digest,
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
  })}\n`)
}

function runPublisher(
  remoteSource: string,
  remoteDigestMode: 'match' | 'mismatch',
  remoteSourceAfterUpload = remoteSource,
) {
  const temp = mkdtempSync(join(tmpdir(), 'release-publisher-'))
  const handoff = join(temp, 'handoff')
  const bin = join(temp, 'bin')
  const log = join(temp, 'gh.log')
  mkdirSync(handoff)
  mkdirSync(bin)
  writePublishHandoff(handoff)
  const workflow = readFileSync(protectedPath, 'utf8')
  const script = join(temp, 'publish.sh')
  writeFileSync(script, `#!/bin/bash\n${extractPublisherScript(workflow)}\n`)
  chmodSync(script, 0o755)
  const gh = join(bin, 'gh')
  writeFileSync(gh, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$1 $2" == "run download" ]]; then
  while [[ "$1" != "--dir" ]]; do shift; done
  mkdir -p "$2"
  cp -R "$HANDOFF"/. "$2"/
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
  printf 'HTTP/2 404 Not Found\\n'
  exit 1
elif [[ "$1 $2" == "release view" ]]; then
  if [[ "$*" == *"--json databaseId"* ]]; then
    printf '42\\n'
  else
    if [[ "$REMOTE_DIGEST_MODE" == mismatch ]]; then
      digest="sha256:$(printf '0%.0s' {1..64})"
    else
      dmg="$HANDOFF/release-assets/Agent-Inbox-v1.2.3-universal.dmg"
      digest="sha256:$(shasum -a 256 "$dmg" | awk '{print $1}')"
    fi
    sum="$HANDOFF/release-assets/SHA256SUMS.txt"
    sum_digest="sha256:$(shasum -a 256 "$sum" | awk '{print $1}')"
    printf '{"tagName":"v1.2.3","isDraft":true,"assets":[{"name":"Agent-Inbox-v1.2.3-universal.dmg","size":23,"digest":"%s"},{"name":"SHA256SUMS.txt","size":105,"digest":"%s"}]}\\n' "$digest" "$sum_digest"
  fi
elif [[ "$1 $2" == "release download" ]]; then
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
      GITHUB_RUN_ID: '12345',
      RUNNER_TEMP: temp,
      HANDOFF: handoff,
      GH_LOG: log,
      REMOTE_SOURCE: remoteSource,
      REMOTE_SOURCE_AFTER_UPLOAD: remoteSourceAfterUpload,
      REMOTE_DIGEST_MODE: remoteDigestMode,
      TAG_CHECK_COUNT_FILE: join(temp, 'tag-check-count'),
    },
  })
  return { result, log: readFileSync(log, 'utf8') }
}

describe('notarized macOS release workflow', () => {
  it('starts only from the exact tag path and pins every third-party action', () => {
    const inputs = readFileSync(inputsPath, 'utf8')
    const protectedWorkflow = readFileSync(protectedPath, 'utf8')
    expect(inputs).toContain('name: macOS release inputs')
    expect(inputs).toContain('tags:')
    expect(inputs).toContain('- "v*.*.*"')
    expect(inputs).not.toContain('workflow_dispatch')
    expect(inputs).not.toContain('pull_request')
    expect(protectedWorkflow).toContain('workflow_run:')
    expect(protectedWorkflow).toContain('- "macOS release inputs"')
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
    const intel = protectedWorkflow.indexOf('verify-intel:')
    const notarize = protectedWorkflow.indexOf('notarize-and-finalize:')
    const publish = protectedWorkflow.indexOf('publish:')
    expect(gate).toBeGreaterThan(-1)
    expect(runtime).toBeGreaterThan(gate)
    expect(thin).toBeGreaterThan(runtime)
    expect(sign).toBeGreaterThan(-1)
    expect(intel).toBeGreaterThan(sign)
    expect(notarize).toBeGreaterThan(intel)
    expect(publish).toBeGreaterThan(notarize)
    expect(inputs).not.toContain('environment: macos-release')
    expect(protectedWorkflow.match(/environment: macos-release/g)).toHaveLength(3)
    expect(protectedWorkflow).toContain('npm run package:macos --')
    expect(protectedWorkflow).toContain('--mode developer-id')
    expect(`${inputs}\n${protectedWorkflow}`).not.toContain('macos-universal-provisional')
    const intelJob = protectedWorkflow.slice(
      protectedWorkflow.indexOf('  verify-intel:'),
      protectedWorkflow.indexOf('  notarize-and-finalize:'),
    )
    expect(intelJob).not.toContain('vars.APPLE_')
    expect(intelJob).toContain('signing-identity.json')
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
    expect(authorize).toContain("github.event.workflow_run.name == 'macOS release inputs'")
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
      .toBeGreaterThanOrEqual(5)
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
    const intelEvidence = workflow.indexOf('Verify exact Developer ID bytes natively on Intel')
    const appSubmit = workflow.indexOf('Notarize and staple accepted app')
    const finalDmg = workflow.indexOf('Build and sign final DMG from stapled app')
    const dmgSubmit = workflow.indexOf('Notarize and staple accepted DMG')
    const transportedApp = workflow.indexOf('Mount final stapled DMG and verify transported app')
    const checksums = workflow.indexOf('Generate final post-staple evidence and checksums')
    const publish = workflow.indexOf('Publish exact verified handoff through a fail-closed draft')
    expect(appSubmit).toBeGreaterThan(intelEvidence)
    expect(finalDmg).toBeGreaterThan(appSubmit)
    expect(dmgSubmit).toBeGreaterThan(finalDmg)
    expect(transportedApp).toBeGreaterThan(dmgSubmit)
    expect(checksums).toBeGreaterThan(transportedApp)
    expect(publish).toBeGreaterThan(checksums)
    expect(workflow).toContain('scripts/notarize-macos.sh')
    expect(readFileSync(join(root, 'scripts', 'notarize-macos.sh'), 'utf8'))
      .toContain('"$XCRUN_BIN" stapler validate')
    expect(workflow).toContain('spctl --assess')
    expect(workflow).toContain('verify-final-dmg')
    expect(workflow).toContain('--transport-evidence build/transported-app-evidence.json')
    expect(workflow).toContain('SHA256SUMS.txt')
    expect(workflow).toContain('Agent-Inbox-${{ needs.authorize.outputs.tag }}-universal.dmg')
    expect(workflow).toContain('Requires macOS 13.5 (Ventura) or later.')
    expect(workflow).toContain('pinned Node 24 runtime; Electron 43 itself supports macOS 12')
    const docs = readFileSync(join(root, 'docs', 'macos-release.md'), 'utf8')
    expect(docs).toContain('Requires macOS 13.5 (Ventura) or later.')
    expect(docs).toContain('Electron 43 itself supports macOS 12')
    expect(docs).toContain('official Node 24 runtime')
    const inputs = JSON.parse(readFileSync(join(root, 'release', 'macos-inputs.json'), 'utf8'))
    expect(inputs.electron.version).toMatch(/^43\./)
    expect(inputs.node.version).toMatch(/^v24\./)
    expect(inputs.minimumMacosVersion).toBe('13.5')
    expect(workflow).toContain('permissions:')
    expect(workflow).toContain('contents: write')
    expect(workflow).toContain('if: ${{ always() }}')
  })

  it('confines Apple secrets to protected jobs and names no secret in artifact paths', () => {
    const inputs = readFileSync(inputsPath, 'utf8')
    const workflow = readFileSync(protectedPath, 'utf8')
    expect(inputs).not.toContain('secrets.')
    const secretRefs = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1])
    expect(new Set(secretRefs)).toEqual(new Set([
      'APPLE_DEVELOPER_ID_P12_BASE64',
      'APPLE_DEVELOPER_ID_P12_PASSWORD',
      'APPLE_NOTARY_PRIVATE_KEY_BASE64',
    ]))
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
    expect(publishJob).toContain('cmp "$WORK/release-assets/Agent-Inbox-$RELEASE_TAG-universal.dmg"')
    expect(publishJob.indexOf('gh api --method PATCH "repos/$GH_REPO/releases/$RELEASE_ID"'))
      .toBeGreaterThan(publishJob.indexOf('remote asset verification did not produce a valid mode'))
  })

  it('refuses publication when the remote annotated tag moved after authorization', () => {
    const { result, log } = runPublisher('c'.repeat(40), 'match')
    expect(result.status).not.toBe(0)
    expect(log).toContain('git/ref/tags/v1.2.3')
    expect(log).toContain('git/tags/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(log).not.toContain('release create')
  })

  it('deletes the draft when uploaded release asset bytes do not match', () => {
    const { result, log } = runPublisher(sourceCommit, 'mismatch')
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('remote asset digest mismatch')
    expect(log).toContain('release create v1.2.3')
    expect(log).toContain('release upload v1.2.3')
    expect(log).toContain('api --method DELETE repos/example/agent-inbox/releases/42')
    expect(log).not.toContain('api --method PATCH')
  })

  it('deletes the draft when the remote tag moves during upload verification', () => {
    const { result, log } = runPublisher(sourceCommit, 'match', 'c'.repeat(40))
    expect(result.status).not.toBe(0)
    expect(log).toContain('release create v1.2.3')
    expect(log).toContain('release upload v1.2.3')
    expect(log.match(/git\/ref\/tags\/v1\.2\.3/g)).toHaveLength(2)
    expect(log).toContain('api --method DELETE repos/example/agent-inbox/releases/42')
    expect(log).not.toContain('api --method PATCH')
  })
})
