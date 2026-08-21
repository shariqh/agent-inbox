#!/usr/bin/env node
'use strict'

// Setup probe for an INSTALLED Linux DEB package (issue #86). Run this file
// through the packaged Electron binary in Node mode
// (`ELECTRON_RUN_AS_NODE=1 <installed-launcher-binary> smoke-linux-deb-setup.cjs ...`)
// so it loads the exact `electron/setup-runner.cjs` bundled inside the
// installed app tree — the same module the running app itself uses for its
// in-app Setup button — rather than anything from this source checkout.
//
// Everything the installer touches is isolated under `--home`: HOME, the
// XDG_*_HOME family, and PATH (which carries a throwaway fake `copilot` CLI
// and otherwise only base system directories, deliberately no system Node).
// The real host's ~/.copilot, ~/.claude, and ~/.agent-inbox are never opened.

const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')

function fail(message) {
  process.stderr.write(`smoke-linux-deb-setup: ${message}\n`)
}

function usage() {
  process.stderr.write(
    'usage: smoke-linux-deb-setup.cjs --app-root <installed-app-dir> --home <isolated-home> ' +
    '[--target copilot|claude|all] [--arch x64|arm64]\n',
  )
  process.exit(2)
}

const { values } = parseArgs({
  options: {
    'app-root': { type: 'string' },
    home: { type: 'string' },
    target: { type: 'string', default: 'copilot' },
    arch: { type: 'string', default: process.arch === 'arm64' ? 'arm64' : 'x64' },
  },
})

if (!values['app-root'] || !values.home) usage()

const appRoot = path.resolve(values['app-root'])
// electron-packager's Linux output places the bundled project tree at
// `<installed-app-root>/resources/app` (see build-thin-app.mjs / APP_NAME and
// verify-linux-thin-app.mjs, which resolves the same `resources/app` path).
const resourcesApp = path.join(appRoot, 'resources', 'app')
const setupRunnerPath = path.join(resourcesApp, 'electron', 'setup-runner.cjs')

if (!existsSync(setupRunnerPath)) {
  fail(`packaged electron/setup-runner.cjs is missing at ${setupRunnerPath}`)
  process.exit(1)
}

const {
  readSetupInfo,
  runAgentInstall,
  selectRuntimePayload,
} = require(setupRunnerPath)

const home = path.resolve(values.home)
const fakeBin = path.join(home, 'fakebin')
const state = path.join(home, 'state')
for (const dir of [fakeBin, state, path.join(home, 'config'), path.join(home, 'cache'),
  path.join(home, 'data'), path.join(home, 'tmp')]) {
  mkdirSync(dir, { recursive: true })
}

// A minimal fake `copilot` CLI answering only the `mcp get/add/remove`
// subcommands scripts/install-agents.sh actually invokes (its
// `mcp_commands()`/`has_user_registration()`): "not yet registered" until
// `mcp add` runs, then a `"source":"user"` JSON reply so the installer's own
// scope check passes. It never shells out to a real Copilot CLI.
const registeredMarker = path.join(state, 'copilot-registered')
const addArgs = path.join(state, 'copilot-add-args')
const fakeCopilotSource = [
  '#!/bin/sh',
  'case "$1:$2" in',
  '  mcp:get)',
  `    test -f "${registeredMarker}" || exit 1`,
  '    echo \'{"agent-inbox":{"source":"user"}}\'',
  '    ;;',
  '  mcp:add)',
  `    printf '%s\\n' "$@" > "${addArgs}"`,
  `    touch "${registeredMarker}"`,
  '    ;;',
  '  mcp:remove)',
  `    rm -f "${registeredMarker}"`,
  '    ;;',
  '  *) exit 2 ;;',
  'esac',
  '',
].join('\n')
const fakeCopilotPath = path.join(fakeBin, 'copilot')
writeFileSync(fakeCopilotPath, fakeCopilotSource)
chmodSync(fakeCopilotPath, 0o755)

const isolatedEnv = {
  PATH: `${fakeBin}:/usr/bin:/bin`,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_CACHE_HOME: path.join(home, 'cache'),
  XDG_DATA_HOME: path.join(home, 'data'),
  XDG_STATE_HOME: state,
  TMPDIR: path.join(home, 'tmp'),
}

async function main() {
  const info = readSetupInfo(resourcesApp)
  if (!info) throw new Error(`setup-info.json is missing or unreadable at ${resourcesApp}`)

  const arch = values.arch
  const payload = selectRuntimePayload({ appRoot: resourcesApp, platform: 'linux', arch, info })
  if (!payload.ok) {
    throw new Error(`selectRuntimePayload failed: ${payload.reason} (key=${payload.key})`)
  }

  const result = await runAgentInstall({
    repoRoot: payload.path,
    target: values.target,
    runtimePayload: {
      key: payload.key,
      path: payload.path,
      digest: payload.digest,
      packageVersion: payload.packageVersion,
    },
    env: isolatedEnv,
    timeoutMs: 120_000,
  })

  if (!result.ok) {
    throw new Error(`runAgentInstall failed (exit ${result.exitCode}):\n${result.output}`)
  }
  if (!existsSync(registeredMarker)) {
    throw new Error('fake Copilot CLI was never invoked with mcp add — installer did not run to completion')
  }

  const instructionsPath = path.join(home, '.copilot', 'copilot-instructions.md')
  if (!existsSync(instructionsPath)) {
    throw new Error(`Copilot instructions were not written at ${instructionsPath}`)
  }
  const instructions = readFileSync(instructionsPath, 'utf8')
  if (!instructions.includes('<!-- agent-inbox:begin -->')) {
    throw new Error('Copilot instructions are missing the managed agent-inbox block')
  }

  const runtimeRoot = path.join(home, '.agent-inbox', 'runtime')
  if (!existsSync(runtimeRoot)) {
    throw new Error(`Setup did not copy a runtime under ${runtimeRoot}`)
  }
  const copiedNode = readdirSync(runtimeRoot)
    .map((id) => path.join(runtimeRoot, id, 'bin', 'node'))
    .find((candidate) => existsSync(candidate))
  if (!copiedNode) {
    throw new Error(`Setup did not copy a usable Node binary under ${runtimeRoot}`)
  }
  const copiedRuntime = path.dirname(path.dirname(copiedNode))
  const copiedEntry = path.join(copiedRuntime, 'dist', 'mcp-server.js')
  const registrationArgs = readFileSync(addArgs, 'utf8').trim().split('\n')
  if (!registrationArgs.includes(copiedNode) || !registrationArgs.includes(copiedEntry)) {
    throw new Error('Copilot registration did not use the copied runtime Node and MCP entry')
  }
  if (registrationArgs.some((arg) => arg.startsWith(appRoot))) {
    throw new Error('Copilot registration still points into the removable DEB application tree')
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: values.target,
    runtimeKey: payload.key,
    copiedNode,
    copiedEntry,
    instructionsPath,
  })}\n`)
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err))
  process.exitCode = 1
})
