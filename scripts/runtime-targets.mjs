const POSIX_LAYOUT = {
  format: 'tar.xz',
  nodeExecRelPath: 'bin/node',
  npmCliRelPath: 'lib/node_modules/npm/bin/npm-cli.js',
}

const WINDOWS_LAYOUT = {
  format: 'zip',
  nodeExecRelPath: 'node.exe',
  npmCliRelPath: 'node_modules/npm/bin/npm-cli.js',
}

function defineTarget(key, platform, arch, nodeDistPlatform, layout) {
  if (key !== `${platform}-${arch}`) {
    throw new Error(`runtime target ${key} does not match ${platform}-${arch}`)
  }
  return Object.freeze({
    key,
    platform,
    arch,
    nodeDistPlatform,
    ...layout,
  })
}

export const RUNTIME_TARGETS = Object.freeze({
  'darwin-arm64': defineTarget('darwin-arm64', 'darwin', 'arm64', 'darwin', POSIX_LAYOUT),
  'darwin-x64': defineTarget('darwin-x64', 'darwin', 'x64', 'darwin', POSIX_LAYOUT),
  'linux-arm64': defineTarget('linux-arm64', 'linux', 'arm64', 'linux', POSIX_LAYOUT),
  'linux-x64': defineTarget('linux-x64', 'linux', 'x64', 'linux', POSIX_LAYOUT),
  'win32-x64': defineTarget('win32-x64', 'win32', 'x64', 'win', WINDOWS_LAYOUT),
})

export const MACOS_RUNTIME_KEYS = Object.freeze(['darwin-arm64', 'darwin-x64'])

export function targetFor(key) {
  if (typeof key !== 'string' || !Object.hasOwn(RUNTIME_TARGETS, key)) {
    throw new Error(`unknown runtime target: ${String(key)}`)
  }
  return RUNTIME_TARGETS[key]
}

export function nodeDistributionIdentity(nodeVersion, key) {
  const target = targetFor(key)
  const root = `node-${nodeVersion}-${target.nodeDistPlatform}-${target.arch}`
  const archive = `${root}.${target.format}`
  return {
    archive,
    root,
    url: `https://nodejs.org/dist/${nodeVersion}/${archive}`,
  }
}
