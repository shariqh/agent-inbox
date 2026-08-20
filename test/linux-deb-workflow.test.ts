import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const workflowPath = join(root, '.github', 'workflows', 'linux-x64-deb.yml')
const arm64WorkflowPath = join(root, '.github', 'workflows', 'linux-arm64-deb.yml')

describe('Linux x64 DEB workflow', () => {
  it('is a read-only, fork-safe, exact-action x64 package workflow', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('runs-on: ubuntu-22.04')
    expect(workflow).not.toContain('ubuntu-22.04-arm')
    expect(workflow).not.toContain('linux-arm64')
    expect(workflow).not.toContain('linux/arm64')
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

    // Exactly one upload (own-arch evidence) and one download (rehash job),
    // both action-pinned like checkout/setup-node above.
    expect(workflow.match(/uses: actions\/upload-artifact@/g)).toHaveLength(1)
    expect(workflow.match(/uses: actions\/download-artifact@/g)).toHaveLength(1)
  })

  it('validates package inputs and runs the exact static-gate vitest file list', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('npm run release:linux-inputs')
    expect(workflow).toContain('npm run release:linux-deb-inputs')
    expect(workflow).not.toContain('npm run release:linux-deb-inputs:arm64')
    expect(workflow).toContain('node scripts/linux-release-inputs.mjs --compiler-arch x64')
    for (const file of [
      'test/linux-release-inputs.test.ts',
      'test/linux-native-folder.test.ts',
      'test/linux-release-workflow.test.ts',
      'test/linux-deb-inputs.test.ts',
      'test/linux-deb.test.ts',
      'test/linux-deb-workflow.test.ts',
      'test/native-runtime-adapter.test.ts',
      'test/package-stamp.test.ts',
      'test/setup-runner.test.ts',
    ]) {
      expect(workflow).toContain(file)
    }
  })

  it('builds twice under hostile umasks inside the pinned dpkg-deb 1.21.1 container and verifies the final DEB', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('ubuntu@sha256:79676deb51ebb02885b0b9d33788e78a37cf1045ad79d1bb04c6a222c3556b3d')
    expect(workflow.match(/--platform linux\/amd64/g)?.length).toBeGreaterThanOrEqual(3)
    expect(workflow).toContain('1.21.1 (amd64).')
    expect(workflow).toContain('umask 022')
    expect(workflow).toContain('umask 077')
    expect(workflow).toContain('scripts/build-linux-deb.mjs')
    expect(workflow.match(/scripts\/build-linux-deb\.mjs/g)).toHaveLength(2)
    expect(workflow).toContain('--output-dir build/deb-a')
    expect(workflow).toContain('--output-dir build/deb-b')
    expect(workflow).toContain('mkdir -p build/deb build/reports')
    expect(workflow.match(/cmp --/g)?.length).toBeGreaterThanOrEqual(3)
    expect(workflow).toContain('scripts/verify-linux-deb.mjs')
    expect(workflow).toContain('agent-inbox_${VERSION}_amd64.deb')
    expect(workflow).toContain('.deb.sha256')
    expect(workflow).toContain('.deb.report.json')
    expect(workflow).toContain('if-no-files-found: error')
    // The bundled Electron binary is actually launched (in Node mode) during
    // build/verify's thin-app cross-check, so the GUI runtime deps must be
    // installed inside the pinned build container too, not only at install.
    expect(workflow).toContain('libgtk-3-0')
    expect(workflow).toContain('libnss3')
    expect(workflow).toContain('apt-get install -y --no-install-recommends')
    expect(workflow).toContain('GIT_CONFIG_KEY_0=safe.directory')
    expect(workflow).toContain('GIT_CONFIG_VALUE_0=/repo')
  })

  it('runs a clean pinned Ubuntu x64 install/launch/Setup gate with no system Node and no --no-sandbox', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow.match(
      /if command -v node >\/dev\/null 2>&1; then\n\s+echo "linux-x64-deb: system Node unexpectedly present" >&2\n\s+exit 1\n\s+fi/g,
    )).toHaveLength(1)
    expect(workflow).not.toContain('--no-sandbox')
    expect(workflow).not.toContain('--disable-setuid-sandbox')
    expect(workflow).toContain('/artifacts:ro')
    expect(workflow).toContain('/gate/smoke-linux-deb.sh:ro')
    expect(workflow).toContain('/gate/smoke-linux-deb-setup.cjs:ro')
    expect(workflow).toContain('--security-opt apparmor:unconfined')
    expect(workflow).toContain('--security-opt seccomp=unconfined')
    expect(workflow).toContain('docker run --rm --network none --platform linux/amd64')
    expect(workflow).toContain('offline.Dockerfile')
    expect(workflow).toContain('runuser -u appuser')
    expect(workflow).toContain('chrome-sandbox')
    expect(workflow).toContain('"%a" "$SANDBOX")" = "4755"')
    expect(workflow).toContain('"%u" "$SANDBOX")" = "0"')
    expect(workflow).toContain('agent-inbox.desktop')
    expect(workflow).toContain('hicolor/1024x1024/apps/agent-inbox.png')

    // Both the direct launcher and the desktop-entry launch modes run, plus
    // an offline relaunch; only one of the two claims offline evidence.
    expect(workflow).toContain('--mode launcher')
    expect(workflow).toContain('--mode desktop')
    expect(workflow).toContain('--offline')
    expect(workflow.match(/--offline/g)).toHaveLength(1)

    // The Setup probe runs isolated, against a packaged Electron-as-Node
    // binary, and never spawns a second/redundant fake CLI of its own.
    expect(workflow).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(workflow).toContain('smoke-linux-deb-setup.cjs')
    expect(workflow).toContain('--target copilot')
    expect(workflow).toContain('--arch x64')
    expect(workflow).not.toMatch(/EOF_FAKE|fake-cli\/copilot/)
  })

  it('proves the DB sentinel and copied Setup runtime survive reinstall, remove and purge', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('apt-get remove -y agent-inbox')
    expect(workflow).toContain('apt-get purge -y agent-inbox')
    expect(workflow).toContain('test ! -e /usr/bin/agent-inbox')
    expect(workflow).toContain('test ! -e /usr/lib/agent-inbox')
    // The DB sentinel is asserted right after the initial persistent-home
    // launch (proving it was really created), again right after `remove`,
    // and again after `purge` — three checks across the full lifecycle.
    expect(workflow.match(/test -f \/home\/appuser\/setup-home\/\.agent-inbox\/inbox\.db/g))
      .toHaveLength(3)
    expect(workflow).toContain('.copilot/copilot-instructions.md')
    expect(workflow).toContain('.agent-inbox/runtime')
    expect(workflow).toContain('RUNTIME_DIR="$(find /home/appuser/setup-home/.agent-inbox/runtime')
    expect(workflow).toContain('test -x "$RUNTIME_DIR/bin/node"')
    expect(workflow).toContain('"$RUNTIME_DIR/dist/hook-cli.js" selftest')
    // Reinstall happens between the remove and purge assertions.
    const removeIdx = workflow.indexOf('apt-get remove -y agent-inbox')
    const reinstallIdx = workflow.indexOf('apt-get install -y --no-install-recommends \\\n                "/tmp/reinstall-')
    const purgeIdx = workflow.indexOf('apt-get purge -y agent-inbox')
    expect(removeIdx).toBeGreaterThan(-1)
    expect(reinstallIdx).toBeGreaterThan(removeIdx)
    expect(purgeIdx).toBeGreaterThan(reinstallIdx)
  })

  it('uploads only x64 evidence and independently rehashes/reverifies it in a separate job', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    expect(workflow).toContain('name: linux-x64-deb')
    expect(workflow).toContain('build/deb/*.deb')
    expect(workflow).toContain('build/deb/*.deb.sha256')
    expect(workflow).toContain('build/deb/*.deb.report.json')
    expect(workflow).toContain('needs: deb')
    expect(workflow).toContain('sha256sum -c')
    expect(workflow).toContain('path: build/downloaded')
    expect(workflow).toContain('build/downloaded/deb/$ARTIFACT')
    expect(workflow).toContain('downloaded DEB report mismatch')
    expect(workflow.match(/scripts\/verify-linux-deb\.mjs/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('includes the DEB tests in package smoke without touching macOS workflows', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['package:smoke']).toContain('test/linux-deb-inputs.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/linux-deb.test.ts')
    expect(pkg.scripts['package:smoke']).toContain('test/linux-deb-workflow.test.ts')
    expect(pkg.scripts['test:package']).toBe('npm run package:smoke')

    const macosWorkflows = [
      '.github/workflows/macos-release.yml',
      '.github/workflows/macos-release-protected.yml',
      '.github/workflows/macos-universal.yml',
    ].map((path) => readFileSync(join(root, path), 'utf8'))
    for (const workflow of macosWorkflows) {
      expect(workflow).not.toContain('linux-x64-deb')
      expect(workflow).not.toContain('package:linux-deb')
    }
  })
})

describe('Linux arm64 DEB workflow', () => {
  it('is a read-only, fork-safe, exact-action native arm64 workflow', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('runs-on: ubuntu-22.04-arm')
    expect(workflow).toContain('architecture: arm64')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toMatch(/gh release|release create|release upload/)
    // Architecture isolation: the arm64 workflow never references the x64
    // native runner label, digest, or amd64 artifact/platform strings.
    expect(workflow).not.toContain('ubuntu-22.04-arm-amd64')
    expect(workflow).not.toContain('linux/amd64')
    expect(workflow).not.toContain('_amd64.deb')
    expect(workflow).not.toContain('79676deb51ebb02885b0b9d33788e78a37cf1045ad79d1bb04c6a222c3556b3d')
    expect(workflow).not.toMatch(/runs-on: ubuntu-22\.04\s*$/m)

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

  it('resolves arm64 inputs and calls the arm64-suffixed release gate command', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow).toContain('npm run release:linux-inputs')
    expect(workflow).toContain('npm run release:linux-deb-inputs:arm64')
    expect(workflow).not.toMatch(/npm run release:linux-deb-inputs$/m)
    expect(workflow).toContain('node scripts/linux-release-inputs.mjs --compiler-arch arm64')
  })

  it('builds arm64 twice under hostile umasks inside the pinned dpkg-deb 1.21.1 arm64 container', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow).toContain('ubuntu@sha256:8c71efb5d8170edf0965b2ac5e867cc70d3d8f73d1c9c0573d690d6203fc5866')
    expect(workflow.match(/--platform linux\/arm64/g)?.length).toBeGreaterThanOrEqual(3)
    expect(workflow).toContain('1.21.1 (arm64).')
    expect(workflow).toContain('GIT_CONFIG_KEY_0=safe.directory')
    expect(workflow).toContain('umask 022')
    expect(workflow).toContain('umask 077')
    expect(workflow.match(/scripts\/build-linux-deb\.mjs/g)).toHaveLength(2)
    expect(workflow).toContain('--arch arm64')
    expect(workflow).toContain('--output-dir build/deb-a')
    expect(workflow).toContain('--output-dir build/deb-b')
    expect(workflow).toContain('mkdir -p build/deb build/reports')
    expect(workflow.match(/cmp --/g)?.length).toBeGreaterThanOrEqual(3)
    expect(workflow).toContain('scripts/verify-linux-deb.mjs')
    expect(workflow).toContain('agent-inbox_${VERSION}_arm64.deb')
    expect(workflow).toContain('.deb.sha256')
    expect(workflow).toContain('.deb.report.json')
    expect(workflow).toContain('if-no-files-found: error')
  })

  it('runs a clean pinned native arm64 install/launch/Setup gate with no system Node', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow.match(
      /if command -v node >\/dev\/null 2>&1; then\n\s+echo "linux-arm64-deb: system Node unexpectedly present" >&2\n\s+exit 1\n\s+fi/g,
    )).toHaveLength(1)
    expect(workflow).not.toContain('--no-sandbox')
    expect(workflow).not.toContain('--disable-setuid-sandbox')
    expect(workflow).toContain('/artifacts:ro')
    expect(workflow).toContain('/gate/smoke-linux-deb.sh:ro')
    expect(workflow).toContain('/gate/smoke-linux-deb-setup.cjs:ro')
    expect(workflow).toContain('--security-opt apparmor:unconfined')
    expect(workflow).toContain('--security-opt seccomp=unconfined')
    expect(workflow).toContain('docker run --rm --network none --platform linux/arm64')
    expect(workflow).toContain('offline.Dockerfile')
    expect(workflow).toContain('runuser -u appuser')
    expect(workflow).toContain('--mode launcher')
    expect(workflow).toContain('--mode desktop')
    expect(workflow.match(/--offline/g)).toHaveLength(1)
    expect(workflow).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(workflow).toContain('--target copilot')
    expect(workflow).toContain('--arch arm64')
    expect(workflow).not.toMatch(/EOF_FAKE|fake-cli\/copilot/)
  })

  it('proves the DB sentinel and copied Setup runtime survive reinstall, remove and purge on arm64', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow).toContain('apt-get remove -y agent-inbox')
    expect(workflow).toContain('apt-get purge -y agent-inbox')
    expect(workflow.match(/test -f \/home\/appuser\/setup-home\/\.agent-inbox\/inbox\.db/g))
      .toHaveLength(3)
    expect(workflow).toContain('.copilot/copilot-instructions.md')
    expect(workflow).toContain('test -x "$RUNTIME_DIR/bin/node"')
    expect(workflow).toContain('"$RUNTIME_DIR/dist/hook-cli.js" selftest')
  })

  it('uploads only arm64 evidence and independently rehashes/reverifies it in a separate job', () => {
    const workflow = readFileSync(arm64WorkflowPath, 'utf8')
    expect(workflow).toContain('name: linux-arm64-deb')
    expect(workflow).toContain('needs: deb')
    expect(workflow).toContain('sha256sum -c')
    expect(workflow).toContain('path: build/downloaded')
    expect(workflow).toContain('build/downloaded/deb/$ARTIFACT')
    expect(workflow).toContain('downloaded DEB report mismatch')
    expect(workflow.match(/scripts\/verify-linux-deb\.mjs/g)?.length).toBeGreaterThanOrEqual(2)
    expect(workflow).toContain('--arch arm64')
  })

  it('exposes explicit arm64 package/verify commands while package.json keeps x64 defaults', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['release:linux-deb-inputs']).toBe(
      'node scripts/linux-deb-inputs.mjs',
    )
    expect(pkg.scripts['package:linux-deb']).toBe(
      'node scripts/build-linux-deb.mjs',
    )
    expect(pkg.scripts['verify:linux-deb']).toBe(
      'node scripts/verify-linux-deb.mjs',
    )
    expect(pkg.scripts['release:linux-deb-inputs:arm64']).toBe(
      'node scripts/linux-deb-inputs.mjs',
    )
    expect(pkg.scripts['package:linux-deb:arm64']).toContain('--arch arm64')
    expect(pkg.scripts['verify:linux-deb:arm64']).toContain('--arch arm64')
  })
})

describe('smoke-linux-deb.sh safety contract', () => {
  const scriptPath = join(root, 'scripts', 'smoke-linux-deb.sh')

  it('runs in bash strict mode and documents the flags it never passes through', () => {
    const script = readFileSync(scriptPath, 'utf8')
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true)
    expect(script).toContain('set -euo pipefail')
    // Neither flag ever appears as an argv token passed to the launched app
    // (LAUNCH_ARGV / launch); the script only names them in its own comment
    // documenting what it deliberately never does.
    expect(script).not.toMatch(/LAUNCH_ARGV.*--no-sandbox/)
    expect(script).not.toMatch(/LAUNCH_ARGV.*--disable-setuid-sandbox/)
  })

  it('asserts the root-owned 4755 chrome-sandbox and the installed desktop/icon entry', () => {
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain('assert_chrome_sandbox')
    expect(script).toContain('4755')
    expect(script).toContain('assert_desktop_entry')
    expect(script).toContain('Icon=')
    expect(script).toContain('Exec=')
  })

  it('proves Chromium sandboxing via /proc evidence: NoNewPrivs, Seccomp and a distinct user namespace', () => {
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain('NoNewPrivs')
    expect(script).toContain('Seccomp')
    expect(script).toContain('ns/user')
    expect(script).toContain('assert_chromium_sandbox')
  })

  it('isolates HOME/XDG/TMPDIR and checks the loopback boundary marker over curl', () => {
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain('XDG_CONFIG_HOME')
    expect(script).toContain('XDG_CACHE_HOME')
    expect(script).toContain('XDG_DATA_HOME')
    expect(script).toContain('XDG_STATE_HOME')
    expect(script).toContain('TMPDIR')
    expect(script).toContain('x-agent-inbox-local-boundary: loopback-v1')
  })

  it('supports an optional persistent --home for proving state survives package removal', () => {
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain('--home')
    expect(script).toContain('HOME_ARG')
    expect(script).toContain('PERSISTENT_HOME')
    // A persistent home is never rm -rf'd on exit.
    expect(script).toMatch(/if \[\[ "\$PERSISTENT_HOME" == 0 \]\]; then\n\s+rm -rf "\$SCRATCH"/)
  })

  it('proves offline relaunch only when the caller has removed external networking', () => {
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain('--offline')
    expect(script).toContain('external network unexpectedly reachable during offline gate')
    expect(script).toContain('mkdir -p "$OFFLINE_HOME/.tmp"')
    expect(script).not.toContain('unshare --user --map-current-user --net')
  })
})

describe('smoke-linux-deb-setup.cjs safety contract', () => {
  const scriptPath = join(root, 'scripts', 'smoke-linux-deb-setup.cjs')

  it('loads the packaged electron/setup-runner.cjs rather than any source-checkout copy', () => {
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain("path.join(appRoot, 'resources', 'app')")
    expect(script).toContain("'electron', 'setup-runner.cjs'")
  })

  it('never touches the real host config and rejects a missing --app-root/--home', () => {
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain("if (!values['app-root'] || !values.home) usage()")
    expect(script).toContain('HOME: home')
  })

  it('drives an isolated fake copilot CLI and asserts registration, instructions and copied runtime', () => {
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain('mcp:get')
    expect(script).toContain('mcp:add')
    expect(script).toContain('mcp:remove')
    expect(script).toContain('registeredMarker')
    expect(script).toContain('copilot-add-args')
    expect(script).toContain('repoRoot: payload.path')
    expect(script).toContain('registrationArgs.includes(copiedNode)')
    expect(script).toContain('registrationArgs.includes(copiedEntry)')
    expect(script).toContain('registration still points into the removable DEB')
    expect(script).toContain('<!-- agent-inbox:begin -->')
    expect(script).toContain("path.join(home, '.agent-inbox', 'runtime')")
  })
})
