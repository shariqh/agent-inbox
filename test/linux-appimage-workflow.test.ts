import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const workflowPath = join(root, '.github', 'workflows', 'linux-x64-appimage.yml')
const arm64WorkflowPath = join(root, '.github', 'workflows', 'linux-arm64-appimage.yml')

describe('Linux x64 AppImage workflow', () => {
  it('is a read-only, fork-safe, exact-action x64 package workflow', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('runs-on: ubuntu-22.04')
    expect(workflow).toContain('squashfs-tools=1:4.5-3build1')
    expect(workflow).toContain('pull_request:\n\npermissions:')
    expect(workflow).not.toContain('ubuntu-22.04-arm')
    expect(workflow).not.toContain('linux-arm64')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toMatch(/gh release|release create|release upload/)

    const refs = [...workflow.matchAll(
      /^\s*-\s+uses:\s+([^@\s]+)@([^\s#]+)(?:\s+#\s+(.+))?$/gm,
    )]
    expect(refs.length).toBeGreaterThan(0)
    for (const [, action, ref, comment] of refs) {
      expect(action).toMatch(/^actions\//)
      expect(ref).toMatch(/^[0-9a-f]{40}$/)
      expect(comment).toMatch(/^v\d+\.\d+\.\d+$/)
    }
    const checkoutCount = workflow.match(/^\s{6}- uses: actions\/checkout@/gm)?.length ?? 0
    expect(checkoutCount).toBeGreaterThan(0)
    expect(workflow.match(/^\s{10}persist-credentials: false$/gm)).toHaveLength(checkoutCount)
  })

  it('builds twice, compares exact bytes, verifies the final image, and uploads checksum evidence', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('npm run package:linux-appimage --')
    expect(workflow.match(/npm run package:linux-appimage --/g)).toHaveLength(2)
    expect(workflow).toContain('cmp --')
    expect(workflow).toContain('scripts/verify-linux-appimage.mjs')
    expect(workflow).toContain('Agent-Inbox-v${VERSION}-linux-x86_64.AppImage')
    expect(workflow).toContain('.AppImage.sha256')
    expect(workflow).toContain('.AppImage.report.json')
    expect(workflow).toContain('if-no-files-found: error')
  })

  it('runs clean pinned Ubuntu x64 FUSE and no-FUSE gates with no checkout or system Node', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('ubuntu@sha256:79676deb51ebb02885b0b9d33788e78a37cf1045ad79d1bb04c6a222c3556b3d')
    expect(workflow).toContain('--device /dev/fuse')
    expect(workflow).toContain('--mode fuse')
    expect(workflow).toContain('--mode extract')
    expect(workflow.match(/--security-opt apparmor:unconfined/g)).toHaveLength(2)
    expect(workflow.match(/--security-opt seccomp=unconfined/g)).toHaveLength(2)
    expect(workflow.match(
      /if command -v node >\/dev\/null 2>&1; then\n\s+echo "linux-x64-appimage: system Node unexpectedly present" >&2\n\s+exit 1\n\s+fi/g,
    )).toHaveLength(2)
    expect(workflow).not.toContain('! command -v node')
    expect(workflow).toContain('runuser -u appuser')
    expect(workflow).not.toContain('--no-sandbox')
    expect(workflow).toContain('/artifacts:ro')
    expect(workflow).toContain('/gate/smoke-linux-appimage.sh:ro')
  })

  it('includes the AppImage tests in package smoke without changing macOS workflows', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['package:smoke']).toContain('test/linux-appimage-inputs.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/linux-appimage.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/linux-appimage-workflow.test.ts')
    expect(pkg.scripts['test:package']).toBe('npm run package:smoke')

    const macosWorkflows = [
      '.github/workflows/macos-release.yml',
      '.github/workflows/macos-release-protected.yml',
      '.github/workflows/macos-universal.yml',
    ].map((path) => readFileSync(join(root, path), 'utf8'))
    for (const workflow of macosWorkflows) {
      expect(workflow).not.toContain('linux-x64-appimage')
      expect(workflow).not.toContain('package:linux-appimage')
    }
  })
})

describe('Linux arm64 AppImage workflow', () => {
  it('is a read-only, fork-safe, exact-action native arm64 workflow', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('runs-on: ubuntu-22.04-arm')
    expect(workflow).toContain('architecture: arm64')
    expect(workflow).toContain('squashfs-tools=1:4.5-3build1')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toMatch(/gh release|release create|release upload/)

    const refs = [...workflow.matchAll(
      /^\s*-\s+uses:\s+([^@\s]+)@([^\s#]+)(?:\s+#\s+(.+))?$/gm,
    )]
    expect(refs.length).toBeGreaterThan(0)
    for (const [, action, ref, comment] of refs) {
      expect(action).toMatch(/^actions\//)
      expect(ref).toMatch(/^[0-9a-f]{40}$/)
      expect(comment).toMatch(/^v\d+\.\d+\.\d+$/)
    }
    const checkoutCount = workflow.match(/^\s{6}- uses: actions\/checkout@/gm)?.length ?? 0
    expect(checkoutCount).toBeGreaterThan(0)
    expect(workflow.match(/^\s{10}persist-credentials: false$/gm)).toHaveLength(checkoutCount)
  })

  it('builds arm64 twice under hostile umask and verifies exact final evidence', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow.match(/npm run package:linux-appimage:arm64 --/g)).toHaveLength(2)
    expect(workflow).toContain('umask 077')
    expect(workflow).toContain('cmp --')
    expect(workflow).toContain('npm run --silent verify:linux-appimage:arm64 --')
    expect(workflow).toContain('Agent-Inbox-v${VERSION}-linux-arm64.AppImage')
    expect(workflow).toContain('.AppImage.sha256')
    expect(workflow).toContain('.AppImage.report.json')
    expect(workflow).toContain('if-no-files-found: error')
  })

  it('runs clean pinned native arm64 FUSE and no-FUSE gates without system Node', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow).toContain('ubuntu@sha256:8c71efb5d8170edf0965b2ac5e867cc70d3d8f73d1c9c0573d690d6203fc5866')
    expect(workflow.match(/--platform linux\/arm64/g)).toHaveLength(2)
    expect(workflow).toContain('--device /dev/fuse')
    expect(workflow).toContain('--mode fuse')
    expect(workflow).toContain('--mode extract')
    expect(workflow.match(
      /if command -v node >\/dev\/null 2>&1; then\n\s+echo "linux-arm64-appimage: system Node unexpectedly present" >&2\n\s+exit 1\n\s+fi/g,
    )).toHaveLength(2)
    expect(workflow).not.toContain('! command -v node')
    expect(workflow).not.toContain('--no-sandbox')
    expect(workflow).toContain('/artifacts:ro')
    expect(workflow).toContain('/gate/smoke-linux-appimage.sh:ro')
  })

  it('exposes explicit arm64 package commands while preserving x64 defaults', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['release:linux-appimage-inputs']).toBe(
      'node scripts/linux-appimage-inputs.mjs',
    )
    expect(pkg.scripts['package:linux-appimage']).toBe(
      'node scripts/build-linux-appimage.mjs',
    )
    expect(pkg.scripts['verify:linux-appimage']).toBe(
      'node scripts/verify-linux-appimage.mjs',
    )
    expect(pkg.scripts['release:linux-appimage-inputs:arm64']).toContain(
      'release/linux-appimage-arm64.json',
    )
    expect(pkg.scripts['package:linux-appimage:arm64']).toContain('--arch arm64')
    expect(pkg.scripts['verify:linux-appimage:arm64']).toContain('--arch arm64')
  })
})
