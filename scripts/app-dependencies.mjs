// Install a staged Electron app's production dependencies and compile
// better-sqlite3 for Electron from the lockfile-pinned source (#315), against
// Electron headers this build verified itself (#369).
//
// better-sqlite3's install script is `prebuild-install || node-gyp rebuild`, and
// @electron/rebuild runs prebuild-install before compiling unless told
// otherwise. prebuild-install unpacks <npm cache>/_prebuilds/<asset> when it
// exists, else downloads the release asset, and checks no digest either way.
// Every entry of that archive lands in the package, JavaScript included, so a
// cached or downloaded prebuild could put an addon, or code, into a signed app
// that this build never compiled, and no later gate would notice.
//
// `npm ci --ignore-scripts` keeps the install script from running
// (better-sqlite3 is the only production package with one), and
// `buildFromSource` sends @electron/rebuild straight to node-gyp.
//
// node-gyp would then download Electron's headers tarball (and, on Windows,
// node.lib) from www.electronjs.org/headers and check them only against the
// SHASUMS256.txt served beside them. Those headers are compiled into the addon
// every packaged app loads in its main process, so the release inputs pin their
// SHA-256 per Electron version (`electronHeaders`), and this module downloads them
// once, verifies them, unpacks them into a private folder and hands node-gyp that
// folder as its nodedir. node-gyp then never runs its own header install, and its
// dist-url points at a name that cannot resolve, so a nodedir that stopped
// reaching it would fail the build rather than fetch unverified headers.
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { rebuild } from '@electron/rebuild'
import { assertSystemTool, validateArchiveEntries } from './native-runtime-adapter.mjs'
import { downloadArchive, validateElectronHeaders } from './release-inputs.mjs'

// RFC 6761 reserves .invalid: no resolver answers for it.
export const UNREACHABLE_HEADER_URL = 'https://electron-headers.invalid'

// Files better-sqlite3's build reads from the headers, and the config node-gyp
// takes its base variables from: without it node-gyp falls back to the build
// Node's own config, silently.
const REQUIRED_HEADER_FILES = ['common.gypi', 'config.gypi', 'node_version.h', 'node.h', 'node_api.h', 'v8.h']

// Everything node-gyp reads from the environment that could choose other headers,
// or fetch them: it applies npm_config_<key> and npm_package_config_node_gyp_<key>
// over its own arguments, so any of these would override the nodedir set here.
const NODE_GYP_HEADER_OVERRIDE_RE =
  /^(?:npm_package_config_node_gyp_.*|npm_config_(?:nodedir|dist[-_]url|disturl|tarball|devdir|target|runtime|ensure|force[-_]process[-_]config))$/i

export class AppDependenciesError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AppDependenciesError'
  }
}

function tarExecutable(platform, systemRoot) {
  if (platform !== 'win32') return '/usr/bin/tar'
  if (typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot)) {
    throw new AppDependenciesError('SystemRoot must be an absolute Windows path to find tar.exe')
  }
  return win32.join(systemRoot, 'System32', 'tar.exe')
}

function runTar(tar, args, options) {
  try {
    assertSystemTool(tar, 'archive tool')
    return execFileSync(tar, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, ...options })
  } catch (err) {
    throw new AppDependenciesError(`Electron headers: ${tar} failed: ${err.message}`)
  }
}

// Every path under root, as archive-relative posix paths, refusing anything
// that is neither a plain file nor a directory.
function walkPlainTree(parent, root) {
  const found = []
  const visit = (relative) => {
    const path = join(parent, ...relative.split('/'))
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      found.push(relative)
      for (const name of readdirSync(path).sort()) visit(posix.join(relative, name))
    } else if (stat.isFile()) {
      found.push(relative)
    } else {
      throw new AppDependenciesError(`Electron headers contain something other than a file or folder: ${relative}`)
    }
  }
  visit(root)
  return found
}

export function importLibraryKey(platform, arch) {
  return platform === 'win32' ? `${platform}-${arch}` : null
}

/**
 * Download the pinned Electron headers tarball (and, on Windows, node.lib), check
 * each against its pinned SHA-256, and unpack it into `parent`. Returns the
 * folder to give node-gyp as its nodedir. Anything that does not match the pin,
 * or does not look like Electron's headers, stops the build.
 */
export async function provisionElectronHeaders({
  headers,
  electronVersion,
  platform = process.platform,
  arch,
  parent,
  download = downloadArchive,
  systemRoot = process.env.SystemRoot,
  tar = tarExecutable(platform, systemRoot),
}) {
  if (!headers) {
    throw new AppDependenciesError(`no pinned Electron headers (electronHeaders) for Electron ${electronVersion}`)
  }
  const libraryKey = importLibraryKey(platform, arch)
  try {
    validateElectronHeaders(headers, electronVersion, libraryKey ? [libraryKey] : [])
  } catch (err) {
    throw new AppDependenciesError(err.message)
  }

  const archive = join(parent, headers.archive)
  await download({ url: headers.url, destination: archive, expectedSha256: headers.sha256, followRedirects: true })
  const listed = runTar(tar, ['-tzf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
  let entries
  try {
    entries = validateArchiveEntries(listed, headers.root)
  } catch (err) {
    throw new AppDependenciesError(`Electron headers archive: ${err.message}`)
  }

  const extracted = join(parent, 'extracted')
  mkdirSync(extracted)
  runTar(tar, ['-xzf', archive, '-C', extracted])
  const roots = readdirSync(extracted)
  if (roots.length !== 1 || roots[0] !== headers.root) {
    throw new AppDependenciesError(`Electron headers archive root mismatch: expected only ${headers.root}`)
  }
  const unpacked = walkPlainTree(extracted, headers.root)
  if (JSON.stringify([...unpacked].sort()) !== JSON.stringify([...entries].sort())) {
    throw new AppDependenciesError('Electron headers unpacked to something other than the archive lists')
  }
  const nodedir = join(extracted, headers.root)
  for (const name of REQUIRED_HEADER_FILES) {
    const path = join(nodedir, 'include', 'node', name)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      throw new AppDependenciesError(`Electron headers lack include/node/${name}`)
    }
    if (!stat.isFile()) throw new AppDependenciesError(`Electron headers include/node/${name} is not a plain file`)
  }
  const config = readFileSync(join(nodedir, 'include', 'node', 'config.gypi'), 'utf8')
  if (!/^\s*['"]built_with_electron['"]\s*:\s*1\s*,?\s*$/m.test(config)) {
    throw new AppDependenciesError('Electron headers config.gypi does not say built_with_electron: these are not Electron headers')
  }

  if (libraryKey) {
    // node-gyp links a --nodedir build against <nodedir>/$(Configuration)/node.lib,
    // and better-sqlite3 builds Release.
    const library = headers.importLibraries[libraryKey]
    mkdirSync(join(nodedir, 'Release'))
    await download({
      url: library.url,
      destination: join(nodedir, 'Release', 'node.lib'),
      expectedSha256: library.sha256,
      followRedirects: true,
    })
  }
  return nodedir
}

export function assertNoNodeGypHeaderOverrides(env = process.env) {
  const overrides = Object.keys(env).filter((name) => NODE_GYP_HEADER_OVERRIDE_RE.test(name)).sort()
  if (overrides.length) {
    throw new AppDependenciesError(
      `refusing to compile while ${overrides.join(', ')} ${overrides.length === 1 ? 'is' : 'are'} set: `
        + 'node-gyp would let it choose the headers better-sqlite3 is compiled against',
    )
  }
}

// node-gyp records the nodedir it configured against in build/config.gypi.
export function configuredNodedir(stageRoot) {
  const path = join(stageRoot, 'node_modules', 'better-sqlite3', 'build', 'config.gypi')
  let config
  try {
    const text = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => !line.startsWith('#')).join('\n')
    config = JSON.parse(text)
  } catch (err) {
    throw new AppDependenciesError(`could not read better-sqlite3's build/config.gypi: ${err.message}`)
  }
  const nodedir = config?.variables?.nodedir
  if (typeof nodedir !== 'string' || !nodedir) {
    throw new AppDependenciesError("better-sqlite3's build/config.gypi names no nodedir")
  }
  return nodedir
}

export async function installAppDependencies({
  stageRoot,
  npmCli,
  electronVersion,
  arch,
  electronHeaders,
  env = process.env,
  download = downloadArchive,
  rebuildImpl = rebuild,
  // stderr, so a builder's stdout stays its one JSON result line
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  // @electron/rebuild hands node-gyp this process's environment, not `env`.
  assertNoNodeGypHeaderOverrides(process.env)
  execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: stageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
  })
  const parent = mkdtempSync(join(dirname(resolve(stageRoot)), '.electron-headers-'))
  try {
    const nodedir = await provisionElectronHeaders({
      headers: electronHeaders,
      electronVersion,
      arch,
      parent,
      download,
    })
    log(`app-dependencies: compiling better-sqlite3 for Electron ${electronVersion} against pinned headers `
      + `${electronHeaders.archive} (sha256 ${electronHeaders.sha256}) at nodedir ${nodedir}; `
      + `node-gyp dist-url ${UNREACHABLE_HEADER_URL}`)
    process.env.npm_config_nodedir = nodedir
    try {
      await rebuildImpl({
        buildPath: stageRoot,
        electronVersion,
        arch,
        force: true,
        onlyModules: ['better-sqlite3'],
        buildFromSource: true,
        headerURL: UNREACHABLE_HEADER_URL,
      })
    } finally {
      delete process.env.npm_config_nodedir
    }
    const configured = configuredNodedir(stageRoot)
    if (resolve(configured) !== resolve(nodedir)) {
      throw new AppDependenciesError(`better-sqlite3 was configured against ${configured}, not the pinned headers at ${nodedir}`)
    }
    log(`app-dependencies: node-gyp configured better-sqlite3 against nodedir ${configured}`)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}
