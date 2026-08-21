import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const workflowPath = join(root, '.github', 'workflows', 'windows-native-folder.yml')

describe('native Windows folder workflow', () => {
  it('uses one exact native x64 runner with read-only fork-safe permissions', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('runs-on: windows-2022')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toMatch(/gh release|release create|release upload/)
  })

  it('pins actions and proves the runtime, restored folder, PE identities, and launch', () => {
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
    expect(workflow).toContain('scripts/windows-release-inputs.mjs --node-version')
    expect(workflow).toContain('stage:runtime:native --')
    expect(workflow).toContain('--inputs release/windows-inputs.json')
    expect(workflow).toContain('runtime-payload.mjs')
    expect(workflow).toContain('package:windows-thin')
    expect(workflow).toContain('archive-tree.mjs create')
    expect(workflow).toContain('archive-tree.mjs extract')
    expect(workflow).toContain('verify-windows-thin-app.mjs')
    expect(workflow).toContain('PATH')
    expect(workflow).toContain('x-agent-inbox-local-boundary')
    expect(workflow).toContain('setupAvailable')
    const pwshBlocks = workflow.match(/^\s{8}shell: pwsh$/gm)?.length ?? 0
    expect(pwshBlocks).toBeGreaterThan(0)
    expect(workflow.match(/\$PSNativeCommandUseErrorActionPreference = \$true/g))
      .toHaveLength(pwshBlocks)
    expect(workflow).toContain('clVersion=$($cl.VersionInfo.ProductVersion)')
    expect(workflow).not.toContain('/Bv')
    expect(workflow).not.toMatch(/signtool|Authenticode|Azure|SignPath|WiX|Squirrel/i)
  })

  it('runs native NTFS identity and fail-closed Setup evidence', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('test/windows-setup-filesystem.test.ts')
    expect(workflow).toContain('test/setup-runner.test.ts')
    expect(workflow).toContain('test/setup-process.test.ts')
    expect(workflow).toContain('win32-x64')
    expect(workflow).toContain('retention-days: 7')
  })
})
