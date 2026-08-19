import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const workflowPath = join(root, '.github', 'workflows', 'linux-native-folders.yml')

describe('native Linux folder workflow', () => {
  it('uses exact native x64 and arm64 GitHub-hosted runners with read-only fork-safe permissions', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('runner: ubuntu-22.04')
    expect(workflow).toContain('runner: ubuntu-22.04-arm')
    expect(workflow).toContain('key: linux-x64')
    expect(workflow).toContain('key: linux-arm64')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toMatch(/gh release|release create|release upload/)
  })

  it('pins actions, disables checkout credentials, and builds only native folder inputs', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
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
    expect(workflow).toContain('scripts/linux-release-inputs.mjs --node-version')
    expect(workflow).toContain('stage:runtime:native --')
    expect(workflow).toContain('--inputs release/linux-inputs.json')
    expect(workflow).toContain('archiveSha256')
    expect(workflow).toContain('runtime-payload.mjs" verify')
    expect(workflow).toContain('npm run package:linux-thin --')
    expect(workflow).toContain('scripts/verify-linux-thin-app.mjs')
    expect(workflow).not.toMatch(/AppImage|\.deb\b|electron-builder|electron-forge/i)
  })

  it('includes all Linux release foundation tests in package smoke', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['package:smoke']).toContain('test/linux-release-inputs.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/linux-native-folder.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/linux-release-workflow.test.ts')
  })
})
