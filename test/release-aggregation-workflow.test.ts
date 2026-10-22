import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const producerPath = '.github/workflows/macos-release.yml'
const protectedPath = '.github/workflows/macos-release-protected.yml'
const validationPath = '.github/workflows/release-aggregate.yml'
const reusable = [
  '.github/workflows/macos-universal.yml',
  '.github/workflows/linux-x64-appimage.yml',
  '.github/workflows/linux-arm64-appimage.yml',
  '.github/workflows/linux-x64-deb.yml',
  '.github/workflows/linux-arm64-deb.yml',
]

function stepScript(workflow: string, name: string) {
  const stepStart = workflow.indexOf(`      - name: ${name}`)
  if (stepStart < 0) throw new Error(`workflow step not found: ${name}`)
  const runMarker = '        run: |\n'
  const runStart = workflow.indexOf(runMarker, stepStart)
  if (runStart < 0) throw new Error(`workflow run block not found: ${name}`)
  const contentStart = runStart + runMarker.length
  const nextStep = workflow.indexOf('\n      - ', contentStart)
  const nextJob = workflow.indexOf('\n  publish:', contentStart)
  const candidates = [nextStep, nextJob].filter((value) => value >= 0)
  const end = candidates.length > 0 ? Math.min(...candidates) : workflow.length
  return workflow.slice(contentStart, end)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n')
}

describe('multi-platform release workflow', () => {
  it('keeps every package workflow manually runnable and read-only while centralizing PR orchestration', () => {
    for (const path of reusable) {
      const workflow = read(path)
      expect(workflow).toContain('workflow_call:')
      expect(workflow).toContain('workflow_dispatch:')
      expect(workflow).not.toContain('pull_request:')
      expect(workflow).toContain('permissions:\n  contents: read')
      expect(workflow).not.toContain('contents: write')
      expect(workflow).not.toContain('secrets.')
      expect(workflow).not.toMatch(/gh release|release create|release upload/)
    }
  })

  it('runs a secret-free PR, fork, and manual aggregate dry run without release mutation', () => {
    const workflow = read(validationPath)
    expect(workflow).toContain('name: Multi-platform release validation')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('push:')
    expect(workflow).toContain('permissions:\n  contents: read')
    for (const path of reusable) {
      expect(workflow).toContain(`uses: ./${path}`)
    }
    expect(workflow).toContain('needs:')
    expect(workflow).toContain('node scripts/release-aggregation.mjs dry-run')
    expect(workflow).toContain('publishable')
    expect(workflow).toContain('false')
    expect(workflow).not.toContain('environment:')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toMatch(/gh release|release create|release upload/)
  })

  it('makes one annotated-tag producer run require every native package workflow', () => {
    const workflow = read(producerPath)
    expect(workflow).toContain('name: Multi-platform release inputs')
    expect(workflow).toContain('push:\n    tags:\n      - "v*.*.*"')
    expect(workflow).not.toContain('pull_request:')
    expect(workflow).not.toContain('workflow_dispatch:')
    for (const path of reusable.slice(1)) {
      expect(workflow).toContain(`uses: ./${path}`)
    }
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain('contents: write')
  })

  it('authorizes exact-run Linux evidence before any protected credentialed stage', () => {
    const workflow = read(protectedPath)
    expect(workflow).toContain('- "Multi-platform release inputs"')
    expect(workflow).toContain("github.event.workflow_run.name == 'Multi-platform release inputs'")
    for (const name of [
      'linux-x64-appimage',
      'linux-arm64-appimage',
      'linux-x64-deb',
      'linux-arm64-deb',
    ]) {
      expect(workflow).toContain(`name: ${name}`)
    }
    expect(workflow.match(/run-id: \$\{\{ needs\.authorize\.outputs\.run-id \}\}/g)?.length)
      .toBeGreaterThanOrEqual(6)
    const handoff = workflow.slice(
      workflow.indexOf('  verify-handoff:'),
      workflow.indexOf('  sign-developer-id:'),
    )
    expect(handoff).toContain('node scripts/release-aggregation.mjs linux-handoff')
    expect(handoff).toContain('git rev-parse')
    expect(handoff).toContain('^{tree}')
    expect(handoff).toContain('name: protected-linux-handoff')
    expect(handoff).not.toContain('environment: macos-release')
  })

  it('assembles the exact final inventory before the write-scoped publisher', () => {
    const workflow = read(protectedPath)
    const verify = workflow.slice(
      workflow.indexOf('  verify-publication:'),
      workflow.indexOf('  sign-update-manifest:'),
    )
    expect(verify).toContain('name: final-notarized-release')
    expect(verify).toContain('name: protected-linux-handoff')
    expect(verify).toContain('node scripts/release-aggregation.mjs aggregate')
    expect(verify).toContain('release-aggregation-evidence.json')
    expect(verify).toContain('test "$(find build/verified-publish-handoff/release-assets')
    expect(verify).toContain('= 7')

    const sign = workflow.slice(
      workflow.indexOf('  sign-update-manifest:'),
      workflow.indexOf('  publish:'),
    )
    expect(sign).toContain('name: Sign update manifest')
    expect(sign).toContain('environment: macos-release')
    expect(sign).toContain('contents: read')
    expect(sign).toContain('actions: read')
    expect(sign).toContain('ref: ${{ github.workflow_sha }}')
    expect(sign).toContain('node scripts/update-manifest.mjs inspect-history')
    expect(sign).toContain('node scripts/update-manifest.mjs authorize-history')
    expect(sign).toContain('node scripts/update-manifest.mjs sign')
    expect(sign).toContain('gh api --paginate --slurp')
    expect(sign.indexOf('node scripts/update-manifest.mjs inspect-history'))
      .toBeLessThan(sign.indexOf('AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64'))
    expect(sign).toContain('AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64')
    expect(sign).toContain('name: signed-publish-handoff')
    expect(sign).not.toContain('contents: write')

    const publish = workflow.slice(workflow.indexOf('  publish:'))
    expect(publish).toContain('contents: write')
    expect(publish).not.toContain('uses:')
    for (const name of [
      'Agent-Inbox-$RELEASE_TAG-universal.dmg',
      'Agent-Inbox-$RELEASE_TAG-linux-x86_64.AppImage',
      'Agent-Inbox-$RELEASE_TAG-linux-arm64.AppImage',
      'agent-inbox_${RELEASE_VERSION}_amd64.deb',
      'agent-inbox_${RELEASE_VERSION}_arm64.deb',
      'SHA256SUMS.txt',
      'update-manifest.json',
      'update-manifest.json.sig',
    ]) {
      expect(publish).toContain(name)
    }
    expect(publish).toContain('gh release download "$RELEASE_TAG"')
    expect(publish).not.toContain("process.stdout.write('digest')")
    expect(publish).toContain('shasum -a 256 -c SHA256SUMS.txt')
    expect(publish).toContain('update manifest signature verification failed')
    expect(publish).toContain('draft: false')
    expect(publish).toContain('--input "$WORK/final-release.json"')
    expect(publish).toContain('final release metadata')
    expect(publish).toContain('already public and matches the exact verified handoff')
    expect(publish).toContain('retained private draft')
  })

  it('pins all third-party actions and includes aggregation tests in package smoke', () => {
    const workflows = [
      producerPath,
      protectedPath,
      validationPath,
      ...reusable,
    ].map(read).join('\n')
    const refs = [...workflows.matchAll(
      /^\s*-\s+uses:\s+([^@\s.][^@\s]*)@([^\s#]+)(?:\s+#\s+(.+))?$/gm,
    )]
    expect(refs.length).toBeGreaterThan(0)
    for (const [, action, ref, comment] of refs) {
      expect(action).toMatch(/^actions\//)
      expect(ref).toMatch(/^[0-9a-f]{40}$/)
      expect(comment).toMatch(/^v\d+\.\d+\.\d+$/)
    }
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['package:smoke']).toContain('test/update-manifest.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/release-aggregation.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/release-aggregation-workflow.test.ts')
  })

  it('keeps every protected update-signing shell block syntactically valid', () => {
    const workflow = read(protectedPath)
    for (const name of [
      'Authorize exact update-signing history with trusted code',
      'Sign exact deterministic update manifest',
      'Bind exact signed publication handoff',
    ]) {
      const script = stepScript(workflow, name).replace(/\$\{\{.*?\}\}/gs, 'fixture')
      const result = spawnSync('bash', ['-n'], {
        input: script,
        encoding: 'utf8',
      })
      expect(result.status, `${name}: ${result.stderr}`).toBe(0)
    }
  })
})
