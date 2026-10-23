// Release builders install a staged app's production dependencies and compile
// better-sqlite3 for Electron through installAppDependencies (#315). Neither
// step may take a prebuild from the npm cache: prebuild-install unpacks
// whatever <cache>/_prebuilds holds without checking a digest, so a planted
// archive would ship an addon, and JavaScript, that the build never compiled.
// Every other npm install in the release, build and signing workflows, whose
// addon nothing ships but their scripts and tests load, opts out through
// npm_config_build_from_source, set once for the whole workflow.
//
// The fixture stands in for better-sqlite3 (same name, version, repository and
// install script) with an addon that compiles in seconds, and is installed by
// the real npm, prebuild-install, @electron/rebuild and node-gyp. Nothing
// reaches the network: the packages are local tarballs, node-gyp compiles
// against this Node's own headers, and the prebuild host is a closed port, so
// a cache miss fails instead of downloading.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rebuild } from '@electron/rebuild'
import { installAppDependencies } from '../scripts/app-dependencies.mjs'
import { pruneNativeAddonBuildArtifacts } from '../scripts/build-thin-app.mjs'
import { scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const requireHere = createRequire(import.meta.url)
const PREBUILD_INSTALL_BIN = requireHere.resolve('prebuild-install/bin.js')
const prebuildRequire = createRequire(PREBUILD_INSTALL_BIN)
const prebuildUtil = prebuildRequire('./util.js') as {
  getDownloadUrl(options: Record<string, unknown>): string
  cachedPrebuild(url: string): string
}
const { getAbi } = prebuildRequire('node-abi') as { getAbi(target: string, runtime: string): string }
const detectLibc = prebuildRequire('detect-libc') as {
  GLIBC: string
  isNonGlibcLinuxSync(): boolean
  familySync(): string | null
}

const ELECTRON_VERSION: string = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).devDependencies.electron
const NODE_PREFIX = process.platform === 'win32' ? dirname(process.execPath) : dirname(dirname(process.execPath))
const NPM_CLI = [
  join(NODE_PREFIX, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(NODE_PREFIX, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((path) => existsSync(path))
// An official Windows Node carries no headers, so this runs where the Node
// running the suite has them: the macOS and Linux CI jobs and developer machines.
const HAS_NODE_HEADERS = existsSync(join(NODE_PREFIX, 'include', 'node', 'node_api.h'))

const FIXTURE_PACKAGE = {
  name: 'better-sqlite3',
  version: '12.11.1',
  main: 'lib/index.js',
  repository: { type: 'git', url: 'git+https://github.com/WiseLibs/better-sqlite3.git' },
  gypfile: true,
  scripts: { install: 'prebuild-install || node-gyp rebuild --release' },
}
const GENUINE_JS = "module.exports = 'genuine JavaScript'\n"
const PLANTED_JS = "module.exports = 'planted JavaScript'\n"
const PLANTED_ADDON = 'planted addon bytes\n'
const COMPILED_ORIGIN = 'compiled from the fixture source'
const ADDON_SOURCE = `#include <node_api.h>
static napi_value Init(napi_env env, napi_value exports) {
  napi_value origin;
  napi_create_string_utf8(env, "${COMPILED_ORIGIN}", NAPI_AUTO_LENGTH, &origin);
  napi_set_named_property(env, exports, "origin", origin);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
`

let tarballs: { addon: string }
let cache: string
let mirrorEnv: Record<string, string>

function npm(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(process.execPath, [NPM_CLI!, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
}

function pack(source: string, destination: string): string {
  return join(destination, npm(['pack', '--pack-destination', destination], source).trim().split('\n').at(-1)!)
}

// Exactly where prebuild-install looks first for this host's prebuild
function plantedPrebuildPath(runtime: 'node' | 'electron', abi: string): string {
  const libc = process.platform === 'linux' && detectLibc.isNonGlibcLinuxSync() ? detectLibc.familySync() ?? '' : ''
  return prebuildUtil.cachedPrebuild(prebuildUtil.getDownloadUrl({
    pkg: FIXTURE_PACKAGE,
    runtime,
    abi,
    platform: process.platform,
    arch: process.arch,
    libc: libc === detectLibc.GLIBC ? '' : libc,
    'tag-prefix': 'v',
  }))
}

function plant(archive: string, files: Record<string, string>): void {
  const content = scratchDir('planted-prebuild-')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(content, path)), { recursive: true })
    writeFileSync(join(content, path), text)
  }
  mkdirSync(dirname(archive), { recursive: true })
  const roots = [...new Set(Object.keys(files).map((path) => path.split('/')[0]!))]
  execFileSync('tar', ['-czf', archive, '-C', content, ...roots], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function stage(): string {
  const root = scratchDir('app-stage-')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'app-stage',
    version: '1.0.0',
    private: true,
    dependencies: { 'better-sqlite3': `file:${tarballs.addon}` },
    allowScripts: { 'better-sqlite3@12.11.1': true },
  }, null, 2))
  npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], root)
  return root
}

const moduleFile = (root: string, ...path: string[]): string =>
  join(root, 'node_modules', 'better-sqlite3', ...path)

describe.skipIf(!NPM_CLI || !HAS_NODE_HEADERS)('staged app dependencies never take a cached prebuild (#315)', () => {
  beforeAll(() => {
    const root = scratchDir('app-dependency-fixture-')
    cache = join(root, 'npm-cache')
    mirrorEnv = {
      npm_config_cache: cache,
      npm_config_better_sqlite3_binary_host: 'http://127.0.0.1:9',
      npm_config_nodedir: NODE_PREFIX,
      npm_config_update_notifier: 'false',
      // The release workflows set this for every step; inherited, it would make the
      // first case compile and the hardened one pass whatever its own flags. Empty is
      // unset to npm and to prebuild-install alike.
      npm_config_build_from_source: '',
    }
    for (const [name, value] of Object.entries(mirrorEnv)) vi.stubEnv(name, value)

    // The fixture's prebuild-install runs this checkout's real prebuild-install,
    // so it needs none of that package's dependencies from the registry.
    const shim = join(root, 'prebuild-install')
    mkdirSync(shim)
    writeFileSync(join(shim, 'package.json'), JSON.stringify({
      name: 'prebuild-install',
      version: '7.1.3',
      bin: { 'prebuild-install': 'bin.js' },
    }))
    writeFileSync(join(shim, 'bin.js'), `#!/usr/bin/env node\nrequire(${JSON.stringify(PREBUILD_INSTALL_BIN)})\n`)
    const shimTarball = pack(shim, root)

    const addon = join(root, 'better-sqlite3')
    mkdirSync(join(addon, 'lib'), { recursive: true })
    mkdirSync(join(addon, 'src'))
    writeFileSync(join(addon, 'package.json'), JSON.stringify({
      ...FIXTURE_PACKAGE,
      dependencies: { 'prebuild-install': `file:${shimTarball}` },
    }, null, 2))
    writeFileSync(join(addon, 'lib', 'index.js'), GENUINE_JS)
    writeFileSync(join(addon, 'binding.gyp'), JSON.stringify({
      targets: [{ target_name: 'better_sqlite3', sources: ['src/addon.c'] }],
    }))
    writeFileSync(join(addon, 'src', 'addon.c'), ADDON_SOURCE)
    tarballs = { addon: pack(addon, root) }

    // What npm's install script would fetch for this Node, and what
    // @electron/rebuild would fetch for the pinned Electron.
    plant(plantedPrebuildPath('node', process.versions.modules), {
      'lib/index.js': PLANTED_JS,
      'lib/planted.js': PLANTED_JS,
    })
    plant(plantedPrebuildPath('electron', getAbi(ELECTRON_VERSION, 'electron')), {
      'build/Release/better_sqlite3.node': PLANTED_ADDON,
      'lib/index.js': PLANTED_JS,
      'lib/planted.js': PLANTED_JS,
    })
    vi.unstubAllEnvs()
  }, 120_000)

  beforeEach(() => {
    for (const [name, value] of Object.entries(mirrorEnv)) vi.stubEnv(name, value)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('takes the planted prebuilds when install scripts run and rebuild tries prebuilds first', async () => {
    const root = stage()
    npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], root)
    expect(readFileSync(moduleFile(root, 'lib', 'index.js'), 'utf8')).toBe(PLANTED_JS)

    await rebuild({
      buildPath: root,
      electronVersion: ELECTRON_VERSION,
      arch: process.arch,
      force: true,
      onlyModules: ['better-sqlite3'],
    })
    pruneNativeAddonBuildArtifacts(root)
    expect(readFileSync(moduleFile(root, 'build', 'Release', 'better_sqlite3.node'), 'utf8')).toBe(PLANTED_ADDON)
    expect(existsSync(moduleFile(root, 'lib', 'planted.js'))).toBe(true)
  }, 120_000)

  it('compiles the addon from source when an install sets npm_config_build_from_source', () => {
    // How every npm install in the release, build and signing workflows runs (they run
    // this file too); npm 11 only warns about the unknown config and passes it on.
    const root = stage()
    npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], root, { ...process.env, npm_config_build_from_source: 'true' })

    expect(readFileSync(moduleFile(root, 'lib', 'index.js'), 'utf8')).toBe(GENUINE_JS)
    expect(existsSync(moduleFile(root, 'lib', 'planted.js'))).toBe(false)
    expect(existsSync(moduleFile(root, 'build', 'config.gypi'))).toBe(true)
    expect(requireHere(moduleFile(root, 'build', 'Release', 'better_sqlite3.node')).origin).toBe(COMPILED_ORIGIN)
  }, 120_000)

  it('compiles the addon from source and keeps none of the planted files', async () => {
    const root = stage()
    await installAppDependencies({
      stageRoot: root,
      npmCli: NPM_CLI!,
      electronVersion: ELECTRON_VERSION,
      arch: process.arch,
    })
    pruneNativeAddonBuildArtifacts(root)

    expect(readFileSync(moduleFile(root, 'lib', 'index.js'), 'utf8')).toBe(GENUINE_JS)
    expect(existsSync(moduleFile(root, 'lib', 'planted.js'))).toBe(false)
    expect(readdirSync(moduleFile(root, 'build'))).toEqual(['Release'])
    expect(readdirSync(moduleFile(root, 'build', 'Release'))).toEqual(['better_sqlite3.node'])
    const addon = moduleFile(root, 'build', 'Release', 'better_sqlite3.node')
    expect(readFileSync(addon, 'utf8')).not.toBe(PLANTED_ADDON)
    // Built against this Node's headers here, so this process can load it.
    expect(requireHere(addon).origin).toBe(COMPILED_ORIGIN)
  }, 120_000)
})
