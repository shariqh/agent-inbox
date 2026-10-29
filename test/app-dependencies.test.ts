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
// a cache miss fails instead of downloading. installAppDependencies gets those
// headers as a pinned "Electron headers" tarball (#369), served by a fetch that
// knows only its URL, and points node-gyp's dist-url at a name that cannot
// resolve, so a build that ignored the pin would fail rather than download.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rebuild } from '@electron/rebuild'
import {
  UNREACHABLE_HEADER_URL,
  assertNoNodeGypHeaderOverrides,
  configuredNodedir,
  installAppDependencies,
  provisionElectronHeaders,
} from '../scripts/app-dependencies.mjs'
import { downloadArchive, electronHeadersIdentity, electronImportLibraryUrl } from '../scripts/release-inputs.mjs'
import type { ElectronHeaders } from '../scripts/release-inputs.mjs'
import { pruneAppNodeModules } from '../scripts/build-thin-app.mjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

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
let headersPin: ElectronHeaders
let headersTarball: Buffer

// This Node's headers, packed the way Electron's are (a node_headers/ root and a
// config.gypi that says built_with_electron), so the addon still loads here.
function packHeaders(root: string): void {
  const tree = join(root, 'headers', 'node_headers', 'include', 'node')
  mkdirSync(dirname(tree), { recursive: true })
  cpSync(join(NODE_PREFIX, 'include', 'node'), tree, { recursive: true, dereference: true })
  const config = join(tree, 'config.gypi')
  const text = readFileSync(config, 'utf8')
  const marked = text.replace(/(["']variables["']\s*:\s*\{)/, `$1\n    "built_with_electron": 1,`)
  if (marked === text) throw new Error(`no variables in ${config}`)
  writeFileSync(config, marked)
  const archive = join(root, 'headers.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', join(root, 'headers'), 'node_headers'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  headersTarball = readFileSync(archive)
  headersPin = {
    ...electronHeadersIdentity(ELECTRON_VERSION),
    sha256: createHash('sha256').update(headersTarball).digest('hex'),
  }
}

// The real downloader and digest check, over a fetch that serves only the pinned URL.
const offlineDownload = (options: Parameters<typeof downloadArchive>[0]) => downloadArchive({
  ...options,
  fetchImpl: (async (url: string) => {
    if (url !== headersPin.url) throw new Error(`unexpected fetch: ${url}`)
    return new Response(new Uint8Array(headersTarball))
  }) as typeof fetch,
})

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
    writeFileSync(join(addon, 'LICENSE'), 'MIT License\n')
    writeFileSync(join(addon, 'README.md'), '# better-sqlite3\n')
    writeFileSync(join(addon, 'binding.gyp'), JSON.stringify({
      targets: [{ target_name: 'better_sqlite3', sources: ['src/addon.c'] }],
    }))
    writeFileSync(join(addon, 'src', 'addon.c'), ADDON_SOURCE)
    tarballs = { addon: pack(addon, root) }
    packHeaders(root)

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
    pruneAppNodeModules(root)
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

  it('compiles the addon from source against the pinned headers and keeps none of the planted files', async () => {
    // installAppDependencies sets the nodedir itself and refuses one already set.
    vi.stubEnv('npm_config_nodedir', undefined)
    const root = stage()
    const lines: string[] = []
    await installAppDependencies({
      stageRoot: root,
      npmCli: NPM_CLI!,
      electronVersion: ELECTRON_VERSION,
      arch: process.arch,
      electronHeaders: headersPin,
      download: offlineDownload,
      log: (line) => lines.push(line),
    })
    // node-gyp configured against the unpacked pin, which is gone again afterwards
    const nodedir = configuredNodedir(root)
    expect(nodedir).toMatch(/[\\/]\.electron-headers-[^\\/]+[\\/]extracted[\\/]node_headers$/)
    expect(dirname(dirname(dirname(nodedir)))).toBe(dirname(root))
    expect(existsSync(nodedir)).toBe(false)
    expect(lines.join('\n')).toContain(`at nodedir ${nodedir}`)
    expect(lines.join('\n')).toContain(headersPin.sha256)
    expect(process.env.npm_config_nodedir).toBeUndefined()
    pruneAppNodeModules(root)

    expect(readFileSync(moduleFile(root, 'lib', 'index.js'), 'utf8')).toBe(GENUINE_JS)
    expect(existsSync(moduleFile(root, 'lib', 'planted.js'))).toBe(false)
    // only what it loads, and its license (#291)
    expect(readdirSync(moduleFile(root)).sort()).toEqual(['LICENSE', 'build', 'lib', 'package.json'])
    expect(readdirSync(moduleFile(root, 'build'))).toEqual(['Release'])
    expect(readdirSync(moduleFile(root, 'build', 'Release'))).toEqual(['better_sqlite3.node'])
    const addon = moduleFile(root, 'build', 'Release', 'better_sqlite3.node')
    expect(readFileSync(addon, 'utf8')).not.toBe(PLANTED_ADDON)
    // Built against this Node's headers here, so this process can load it.
    expect(requireHere(addon).origin).toBe(COMPILED_ORIGIN)
  }, 120_000)
})

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const ELECTRON_CONFIG = "# Do not edit.\n{ 'variables': {\n    'built_with_electron': 1,\n    'node_module_version': 148,\n} }\n"
const HEADER_FILES = ['common.gypi', 'node_version.h', 'node.h', 'node_api.h', 'v8.h']

type Entry = string | { symlink: string }
function headerTree(overrides: Record<string, Entry | null> = {}): Record<string, Entry> {
  const files: Record<string, Entry | null> = {
    'node_headers/include/node/config.gypi': ELECTRON_CONFIG,
    ...Object.fromEntries(HEADER_FILES.map((name) => [`node_headers/include/node/${name}`, `// ${name}\n`])),
    ...overrides,
  }
  return Object.fromEntries(Object.entries(files).filter((entry): entry is [string, Entry] => entry[1] !== null))
}

function tarball(files: Record<string, Entry>): Buffer {
  const root = scratchDir('electron-headers-src-')
  const content = join(root, 'content')
  for (const [path, entry] of Object.entries(files)) {
    mkdirSync(dirname(join(content, path)), { recursive: true })
    if (typeof entry === 'string') writeFileSync(join(content, path), entry)
    else symlinkSync(entry.symlink, join(content, path))
  }
  const archive = join(root, 'headers.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', content, ...new Set(Object.keys(files).map((path) => path.split('/')[0]!))], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return readFileSync(archive)
}

const VERSION = '43.8.4'
function pinFor(bytes: Buffer, version = VERSION) {
  return { ...electronHeadersIdentity(version), sha256: sha256(bytes) }
}

// downloadArchive itself, over a fetch that serves exactly these URLs
function servedBy(files: Record<string, Buffer>, requests: Array<{ url: string, redirect?: string }> = []) {
  return (options: Parameters<typeof downloadArchive>[0]) => downloadArchive({
    ...options,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      requests.push({ url, redirect: init?.redirect })
      const body = files[url]
      if (!body) throw new Error(`unexpected fetch: ${url}`)
      return new Response(new Uint8Array(body))
    }) as typeof fetch,
  })
}

describe('pinned Electron headers (#369)', () => {
  afterEach(() => removeScratchDirs())

  it('downloads the pinned tarball, checks its SHA-256 and unpacks it as the nodedir', async () => {
    const bytes = tarball(headerTree())
    const headers = pinFor(bytes)
    const requests: Array<{ url: string, redirect?: string }> = []
    const parent = scratchDir('electron-headers-')
    const nodedir = await provisionElectronHeaders({
      headers,
      electronVersion: VERSION,
      platform: 'darwin',
      arch: 'arm64',
      parent,
      download: servedBy({ [headers.url]: bytes }, requests),
    })
    expect(nodedir).toBe(join(parent, 'extracted', 'node_headers'))
    expect(readFileSync(join(nodedir, 'include', 'node', 'config.gypi'), 'utf8')).toBe(ELECTRON_CONFIG)
    expect(existsSync(join(nodedir, 'Release'))).toBe(false)
    // www.electronjs.org redirects to its artifact host; the digest vouches for the bytes
    expect(requests).toEqual([{ url: `https://www.electronjs.org/headers/v${VERSION}/node-v${VERSION}-headers.tar.gz`, redirect: 'follow' }])
  })

  it('refuses a tarball whose SHA-256 is not the pinned one, before unpacking anything', async () => {
    const headers = pinFor(tarball(headerTree()))
    const replaced = tarball(headerTree({ 'node_headers/include/node/v8.h': '// replaced\n' }))
    const parent = scratchDir('electron-headers-')
    await expect(provisionElectronHeaders({
      headers,
      electronVersion: VERSION,
      platform: 'linux',
      arch: 'x64',
      parent,
      download: servedBy({ [headers.url]: replaced }),
    })).rejects.toThrow(/SHA-256 mismatch/)
    expect(readdirSync(parent)).toEqual([])
  })

  it('refuses to build without a pin, or with a pin left behind by an Electron bump', async () => {
    const bytes = tarball(headerTree())
    const parent = scratchDir('electron-headers-')
    const download = servedBy({})
    await expect(provisionElectronHeaders({ headers: undefined, electronVersion: VERSION, platform: 'darwin', arch: 'arm64', parent, download }))
      .rejects.toThrow(`no pinned Electron headers (electronHeaders) for Electron ${VERSION}`)
    await expect(provisionElectronHeaders({ headers: pinFor(bytes, '43.8.3'), electronVersion: VERSION, platform: 'darwin', arch: 'arm64', parent, download }))
      .rejects.toThrow(/electronHeaders\.archive must be node-v43\.8\.4-headers\.tar\.gz/)
    const url = { ...pinFor(bytes), url: `https://artifacts.electronjs.org/headers/dist/v${VERSION}/node-v${VERSION}-headers.tar.gz` }
    await expect(provisionElectronHeaders({ headers: url, electronVersion: VERSION, platform: 'darwin', arch: 'arm64', parent, download }))
      .rejects.toThrow(/official Electron headers URL/)
    expect(readdirSync(parent)).toEqual([])
  })

  it.each([
    ['a second root', { 'extra/file.h': 'x' }, /outside node_headers/],
    ['a symbolic link', { 'node_headers/include/node/link.h': { symlink: '/etc/hosts' } }, /other than a file or folder/],
    ['no config.gypi', { 'node_headers/include/node/config.gypi': null }, /lack include\/node\/config\.gypi/],
    ['no node.h', { 'node_headers/include/node/node.h': null }, /lack include\/node\/node\.h/],
    ["Node's own config.gypi", { 'node_headers/include/node/config.gypi': "{ 'variables': { 'node_module_version': 137 } }\n" }, /not Electron headers/],
  ] as const)('refuses a correctly pinned tarball with %s', async (_label, overrides, error) => {
    const bytes = tarball(headerTree(overrides as Record<string, Entry | null>))
    const headers = pinFor(bytes)
    await expect(provisionElectronHeaders({
      headers,
      electronVersion: VERSION,
      platform: 'darwin',
      arch: 'arm64',
      parent: scratchDir('electron-headers-'),
      download: servedBy({ [headers.url]: bytes }),
    })).rejects.toThrow(error)
  })

  it('puts the pinned Windows import library where node-gyp links a --nodedir Release build', async () => {
    const bytes = tarball(headerTree())
    const library = Buffer.from('electron node.lib')
    const libraryUrl = electronImportLibraryUrl(VERSION, 'win32-x64')
    expect(libraryUrl).toBe(`https://www.electronjs.org/headers/v${VERSION}/win-x64/node.lib`)
    const headers = { ...pinFor(bytes), importLibraries: { 'win32-x64': { url: libraryUrl, sha256: sha256(library) } } }
    const options = { electronVersion: VERSION, platform: 'win32', arch: 'x64', tar: '/usr/bin/tar' }
    const nodedir = await provisionElectronHeaders({
      ...options,
      headers,
      parent: scratchDir('electron-headers-'),
      download: servedBy({ [headers.url]: bytes, [libraryUrl]: library }),
    })
    expect(readFileSync(join(nodedir, 'Release', 'node.lib'), 'utf8')).toBe('electron node.lib')

    await expect(provisionElectronHeaders({
      ...options,
      headers,
      parent: scratchDir('electron-headers-'),
      download: servedBy({ [headers.url]: bytes, [libraryUrl]: Buffer.from('another node.lib') }),
    })).rejects.toThrow(/SHA-256 mismatch/)
    const { importLibraries: _, ...withoutLibrary } = headers
    await expect(provisionElectronHeaders({
      ...options,
      headers: withoutLibrary,
      parent: scratchDir('electron-headers-'),
      download: servedBy({}),
    })).rejects.toThrow(/electronHeaders keys must be exactly: .*importLibraries/)
  })

  it('refuses every environment variable node-gyp would read as another nodedir, dist-url or header source', () => {
    for (const name of [
      'npm_config_nodedir',
      'NPM_CONFIG_NODEDIR',
      'npm_config_dist_url',
      'npm_config_dist-url',
      'npm_config_disturl',
      'npm_config_tarball',
      'npm_config_devdir',
      'npm_config_target',
      'npm_config_runtime',
      'npm_package_config_node_gyp_nodedir',
      'npm_package_config_node_gyp_anything',
    ]) {
      expect(() => assertNoNodeGypHeaderOverrides({ [name]: '' }), name).toThrow(`refusing to compile while ${name} is set`)
    }
    expect(() => assertNoNodeGypHeaderOverrides({
      npm_config_build_from_source: 'true',
      npm_config_node_gyp: '/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js',
      npm_config_cache: '/cache',
    })).not.toThrow()
  })

  describe.skipIf(!NPM_CLI)('installAppDependencies', () => {
    function emptyStage(): string {
      const root = scratchDir('app-stage-empty-')
      const pkg = { name: 'app-stage', version: '1.0.0', private: true }
      writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
        ...pkg, lockfileVersion: 3, requires: true, packages: { '': pkg },
      }))
      return root
    }
    const configure = (root: string, nodedir: string): void => {
      const build = join(root, 'node_modules', 'better-sqlite3', 'build')
      mkdirSync(build, { recursive: true })
      writeFileSync(join(build, 'config.gypi'), `# Do not edit.\n${JSON.stringify({ variables: { nodedir } }, null, 2)}\n`)
    }

    afterEach(() => vi.unstubAllEnvs())

    it('hands node-gyp the pinned nodedir and an unreachable dist-url, and checks what it configured against', async () => {
      const bytes = tarball(headerTree())
      const headers = pinFor(bytes)
      const root = emptyStage()
      let seen: { options: Record<string, unknown>, nodedir: string | undefined } | undefined
      await installAppDependencies({
        stageRoot: root,
        npmCli: NPM_CLI!,
        electronVersion: VERSION,
        arch: process.arch,
        electronHeaders: headers,
        download: servedBy({ [headers.url]: bytes }),
        log: () => {},
        rebuildImpl: async (options) => {
          seen = { options, nodedir: process.env.npm_config_nodedir }
          configure(root, process.env.npm_config_nodedir!)
        },
      })
      expect(seen!.options).toMatchObject({ buildFromSource: true, headerURL: UNREACHABLE_HEADER_URL, electronVersion: VERSION })
      expect(UNREACHABLE_HEADER_URL).toMatch(/^https:\/\/[a-z-]+\.invalid$/)
      expect(seen!.nodedir).toMatch(/[\\/]extracted[\\/]node_headers$/)
      expect(process.env.npm_config_nodedir).toBeUndefined()

      await expect(installAppDependencies({
        stageRoot: root,
        npmCli: NPM_CLI!,
        electronVersion: VERSION,
        arch: process.arch,
        electronHeaders: headers,
        download: servedBy({ [headers.url]: bytes }),
        log: () => {},
        rebuildImpl: async () => configure(root, join(homedir(), '.electron-gyp', VERSION)),
      })).rejects.toThrow(/configured against .*\.electron-gyp.*, not the pinned headers/)
      expect(process.env.npm_config_nodedir).toBeUndefined()
    })

    it('refuses a header override in the environment before installing anything', async () => {
      vi.stubEnv('npm_package_config_node_gyp_nodedir', '/elsewhere')
      const root = emptyStage()
      await expect(installAppDependencies({
        stageRoot: root,
        npmCli: NPM_CLI!,
        electronVersion: VERSION,
        arch: process.arch,
        electronHeaders: pinFor(Buffer.from('unused')),
        download: servedBy({}),
        rebuildImpl: async () => { throw new Error('rebuild must not run') },
      })).rejects.toThrow(/npm_package_config_node_gyp_nodedir is set/)
      expect(existsSync(join(root, 'node_modules'))).toBe(false)
    })
  })
})
