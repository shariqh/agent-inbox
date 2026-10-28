import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testLinuxSmokeReadiness } from './linux-smoke-readiness.js'
import { testLinuxSmokeCleanup } from './linux-smoke-cleanup.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const root = resolve(process.cwd())
const workflowPath = join(root, '.github', 'workflows', 'linux-x64-appimage.yml')
const arm64WorkflowPath = join(root, '.github', 'workflows', 'linux-arm64-appimage.yml')

testLinuxSmokeReadiness(join(root, 'scripts', 'smoke-linux-appimage.sh'))
testLinuxSmokeCleanup(join(root, 'scripts', 'smoke-linux-appimage.sh'))

afterEach(removeScratchDirs)

// Only US and British English ship (#292). The FUSE gates run the app as a
// French user, which Chromium must fall back to en-US for, and the extraction
// gates as a British one, which must keep en-GB; the renderers say which.
describe('smoke-linux-appimage.sh locale gate (#292)', () => {
  const smoke = readFileSync(join(root, 'scripts', 'smoke-linux-appimage.sh'), 'utf8')

  it('launches under the requested locale, which nothing else overrides, and checks the renderers after the sandbox', () => {
    const launch = smoke.slice(smoke.indexOf('launch=(\n'), smoke.indexOf('\n)\n', smoke.indexOf('launch=(\n')))
    expect(launch).toContain('  env\n  -u LANGUAGE\n  -u LC_ALL\n  -u LC_MESSAGES\n')
    expect(launch).toContain('"LANG=$LOCALE"')
    const sandbox = smoke.lastIndexOf('\nassert_chromium_sandbox\n')
    const locale = smoke.lastIndexOf('\nassert_renderer_locale\n')
    expect(sandbox).toBeGreaterThan(-1)
    expect(locale).toBeGreaterThan(sandbox)
  })

  it('refuses to run without a locale and the --lang it must produce', () => {
    const appImage = join(scratchDir('appimage-args-'), 'Agent-Inbox.AppImage')
    writeFileSync(appImage, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    const run = (...args: string[]) => spawnSync('/bin/bash', [join(root, 'scripts', 'smoke-linux-appimage.sh'),
      '--appimage', appImage, '--mode', 'extract', '--port', '14320', ...args], { encoding: 'utf8', timeout: 5_000 })
    for (const args of [
      [],
      ['--locale', 'en_GB.UTF-8'],
      ['--expect-lang', 'en-GB'],
      ['--locale', 'en_GB', '--expect-lang', 'en-GB'],
      ['--locale', 'en_GB.UTF-8', '--expect-lang', 'en_GB'],
    ]) {
      const result = run(...args)
      expect(result.status, args.join(' ')).toBe(2)
      expect(result.stderr).toContain('--locale <ll_CC.UTF-8> --expect-lang <ll-CC>')
    }
  })

  // The function itself, run against a fake /proc.
  function renderers(processes: Record<string, string[]>, locale = 'fr_FR.UTF-8', expectLang = 'en-US') {
    const fn = smoke.match(/^assert_renderer_locale\(\) \{\n[\s\S]*?^\}$/m)?.[0]
    if (!fn) throw new Error('smoke-linux-appimage.sh defines no assert_renderer_locale')
    const proc = scratchDir('appimage-proc-')
    for (const [pid, argv] of Object.entries(processes)) {
      mkdirSync(join(proc, pid))
      writeFileSync(join(proc, pid, 'cmdline'), `${argv.join('\0')}\0`)
    }
    const result = spawnSync('/bin/bash', ['-s'], {
      encoding: 'utf8',
      timeout: 5_000,
      input: `set -euo pipefail\nLOCALE=${locale}\nEXPECT_LANG=${expectLang}\n${fn.replaceAll('/proc/', `${proc}/`)}\nassert_renderer_locale\n`,
    })
    if (result.error) throw result.error
    return result
  }
  const app = '/tmp/.mount_Agent/usr/lib/agent-inbox/Agent Inbox'

  it('passes when every renderer fell back to en-US for a French user', () => {
    const result = renderers({
      100: [app, '--disable-setuid-sandbox'],
      101: [app, '--type=zygote', '--no-zygote-sandbox'],
      102: [app, '--type=renderer', '--enable-sandbox', '--lang=en-US', '--num-raster-threads=4'],
      103: [app, '--type=gpu-process', '--enable-crash-reporter'],
      104: [app, '--type=renderer', '--lang=en-US'],
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('smoke-linux-appimage: every renderer (2) runs with --lang=en-US under LANG=fr_FR.UTF-8\n')
  })

  it('passes British English kept as en-GB, and refuses it fallen back to en-US', () => {
    const kept = renderers({ 102: [app, '--type=renderer', '--lang=en-GB'] }, 'en_GB.UTF-8', 'en-GB')
    expect(kept.status, kept.stderr).toBe(0)
    expect(kept.stdout).toBe('smoke-linux-appimage: every renderer (1) runs with --lang=en-GB under LANG=en_GB.UTF-8\n')
    const lost = renderers({ 102: [app, '--type=renderer', '--lang=en-US'] }, 'en_GB.UTF-8', 'en-GB')
    expect(lost.status).toBe(1)
    expect(lost.stderr).toContain('smoke-linux-appimage: a renderer runs with --lang=en-US, not --lang=en-GB')
  })

  it('refuses a renderer running in another locale', () => {
    const result = renderers({
      102: [app, '--type=renderer', '--lang=en-US'],
      104: [app, '--type=renderer', '--lang=fr', '--renderer-client-id=5'],
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('smoke-linux-appimage: a renderer runs with --lang=fr, not --lang=en-US')
  })

  it('refuses a renderer that names no locale, and proof without any renderer', () => {
    expect(renderers({ 102: [app, '--type=renderer', '--lang=en-USA'] }).stderr)
      .toContain('smoke-linux-appimage: a renderer runs with --lang=en-USA, not --lang=en-US')
    expect(renderers({ 102: [app, '--type=renderer'] }).stderr)
      .toContain('smoke-linux-appimage: a renderer runs with no --lang, not --lang=en-US')
    const none = renderers({ 100: [app], 101: [app, '--type=utility', '--lang=en-US'] })
    expect(none.status).toBe(1)
    expect(none.stderr).toContain('smoke-linux-appimage: no renderer showed which locale Chromium chose')
  })

  it('runs French in each FUSE gate and British English in each extraction gate', () => {
    for (const path of [workflowPath, arm64WorkflowPath]) {
      const workflow = readFileSync(path, 'utf8')
      expect(workflow, path).toContain('--mode fuse \\\n                --port 14319 \\\n'
        + '                --locale fr_FR.UTF-8 \\\n                --expect-lang en-US\n')
      expect(workflow, path).toContain('--mode extract \\\n                --port 14320 \\\n'
        + '                --locale en_GB.UTF-8 \\\n                --expect-lang en-GB\n')
    }
  })
})

describe('Linux x64 AppImage workflow', () => {
  it('is a read-only, fork-safe, exact-action x64 package workflow', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('workflow_call:')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('runs-on: ubuntu-22.04')
    expect(workflow).toContain('squashfs-tools=1:4.5-3build1')
    expect(workflow).not.toContain('pull_request:')
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

  it('includes the AppImage tests in package smoke and reuses the workflow without duplicating its builder', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['package:smoke']).toContain('test/linux-appimage-inputs.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/linux-appimage.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/linux-appimage-workflow.test.ts')
    expect(pkg.scripts['test:package']).toBe('npm run package:smoke')

    const macosWorkflows = [
      '.github/workflows/macos-release.yml',
      '.github/workflows/macos-release-protected.yml',
      '.github/workflows/macos-package.yml',
    ].map((path) => readFileSync(join(root, path), 'utf8'))
    for (const workflow of macosWorkflows) {
      expect(workflow).not.toContain('package:linux-appimage')
    }
    expect(macosWorkflows[0]).toContain('uses: ./.github/workflows/linux-x64-appimage.yml')
    expect(macosWorkflows[0]).toContain('uses: ./.github/workflows/linux-arm64-appimage.yml')
  })
})

describe('Linux arm64 AppImage workflow', () => {
  it('is a read-only, fork-safe, exact-action native arm64 workflow', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('workflow_call:')
    expect(workflow).not.toContain('pull_request:')
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
