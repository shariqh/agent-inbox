import {
  chmodSync,
  copyFileSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export class LinuxPackageTreeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxPackageTreeError'
  }
}

export function normalizeTreeTimes(path, seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new LinuxPackageTreeError('SOURCE_DATE_EPOCH must be a positive integer')
  }
  const stat = lstatSync(path)
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) normalizeTreeTimes(join(path, name), seconds)
    utimesSync(path, seconds, seconds)
  } else if (stat.isSymbolicLink()) {
    lutimesSync(path, seconds, seconds)
  } else if (stat.isFile()) {
    utimesSync(path, seconds, seconds)
  } else {
    throw new LinuxPackageTreeError(`package tree contains unsupported filesystem entry: ${path}`)
  }
}

export function normalizeDirectoryModes(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LinuxPackageTreeError(`package tree root must be a plain directory: ${path}`)
  }
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name)
    const childStat = lstatSync(child)
    if (childStat.isDirectory() && !childStat.isSymbolicLink()) normalizeDirectoryModes(child)
  }
  chmodSync(path, 0o755)
}

export function copyPlainTreeWithDeterministicModes(
  source,
  destination,
  sourceRoot = realpathSync(source),
) {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(source)
    const resolvedTarget = realpathSync(source)
    const fromRoot = relative(sourceRoot, resolvedTarget)
    if (
      isAbsolute(target) ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new LinuxPackageTreeError(`package input symlink escapes its root: ${source}`)
    }
    symlinkSync(target, destination)
    return
  }
  if (stat.isDirectory()) {
    if ((stat.mode & 0o7000) !== 0) {
      throw new LinuxPackageTreeError(`package input directory has privileged mode bits: ${source}`)
    }
    mkdirSync(destination, { mode: 0o755 })
    for (const name of readdirSync(source).sort()) {
      copyPlainTreeWithDeterministicModes(join(source, name), join(destination, name), sourceRoot)
    }
    chmodSync(destination, 0o755)
    return
  }
  if (!stat.isFile()) {
    throw new LinuxPackageTreeError(`package input contains an unsupported entry: ${source}`)
  }
  if ((stat.mode & 0o7000) !== 0) {
    throw new LinuxPackageTreeError(`package input file has privileged mode bits: ${source}`)
  }
  copyFileSync(source, destination)
  chmodSync(destination, stat.mode & 0o777)
}

export function assertChromeSandboxInput(app) {
  const sandbox = join(app, 'chrome-sandbox')
  const stat = lstatSync(sandbox)
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== 0o755) {
    throw new LinuxPackageTreeError(
      'source thin application chrome-sandbox must be a plain executable with mode 0755',
    )
  }
}

export function renderLinuxDesktopEntry(desktop, extraFields = []) {
  const fields = [
    ['Type', desktop.type],
    ['Name', desktop.name],
    ['Comment', desktop.comment],
    ['Exec', desktop.exec],
    ['Icon', desktop.icon],
    ['Categories', `${desktop.categories.join(';')};`],
    ['Terminal', String(desktop.terminal)],
    ...extraFields,
  ]
  return [
    '[Desktop Entry]',
    ...fields.map(([name, value]) => `${name}=${value}`),
    '',
  ].join('\n')
}
