#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { nativeRuntimeAdapterFor } from './native-runtime-adapter.mjs'

export class ArchiveTreeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArchiveTreeError'
  }
}

export function validateArchiveEntries(entries, expectedRoot) {
  if (typeof expectedRoot !== 'string' || !expectedRoot || /[\\/\0]/.test(expectedRoot) || expectedRoot === '.' || expectedRoot === '..') {
    throw new ArchiveTreeError('expected archive root must be one safe path component')
  }
  if (!Array.isArray(entries) || entries.length === 0) throw new ArchiveTreeError('archive is empty')
  const rootPrefix = `${expectedRoot}/`
  const seen = new Set()
  for (const rawEntry of entries) {
    if (typeof rawEntry !== 'string' || !rawEntry || rawEntry.includes('\\') ||
        rawEntry.includes('\0') || /^[A-Za-z]:/.test(rawEntry) || rawEntry.endsWith('//')) {
      throw new ArchiveTreeError(`archive contains an unsafe path: ${String(rawEntry)}`)
    }
    const entry = rawEntry.replace(/\/$/, '')
    if (!entry || entry.startsWith('/') ||
        entry.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new ArchiveTreeError(`archive contains an unsafe path: ${rawEntry}`)
    }
    if (entry !== expectedRoot && !entry.startsWith(rootPrefix)) {
      throw new ArchiveTreeError(`archive entry is outside expected root ${expectedRoot}: ${rawEntry}`)
    }
    if (seen.has(entry)) throw new ArchiveTreeError(`archive contains a duplicate path: ${entry}`)
    seen.add(entry)
  }
  return entries
}

function archiveExecutable() {
  return process.platform === 'win32'
    ? nativeRuntimeAdapterFor('win32-x64').archiveExecutable
    : '/usr/bin/tar'
}

function archiveEntries(archive) {
  return execFileSync(archiveExecutable(), ['-tzf', resolve(archive)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  }).split('\n').filter(Boolean)
}

function rejectArchiveHardlinks(archive) {
  const verbose = execFileSync(archiveExecutable(), ['-tvzf', resolve(archive)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  if (verbose.split('\n').some((line) => line.startsWith('h'))) {
    throw new ArchiveTreeError('archive hardlinks are not permitted')
  }
}

function assertContainedSymlinks(directory, root = realpathSync(directory)) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      let target
      try {
        target = realpathSync(path)
      } catch {
        throw new ArchiveTreeError(`archive contains a broken symlink: ${path}`)
      }
      const fromRoot = relative(root, target)
      if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
        throw new ArchiveTreeError(`archive symlink escapes expected root: ${path}`)
      }
    } else if (entry.isDirectory()) {
      assertContainedSymlinks(path, root)
    }
  }
}

export function createTreeArchive({ source, archive }) {
  const sourcePath = resolve(source)
  if (!existsSync(sourcePath)) throw new ArchiveTreeError(`archive source does not exist: ${sourcePath}`)
  mkdirSync(dirname(resolve(archive)), { recursive: true })
  execFileSync(archiveExecutable(), ['-czf', resolve(archive), '-C', dirname(sourcePath), basename(sourcePath)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
  })
  return resolve(archive)
}

export function extractTreeArchive({ archive, destination, expectedRoot }) {
  const archivePath = resolve(archive)
  if (!existsSync(archivePath)) throw new ArchiveTreeError(`archive does not exist: ${archivePath}`)
  validateArchiveEntries(archiveEntries(archivePath), expectedRoot)
  rejectArchiveHardlinks(archivePath)
  const destinationPath = resolve(destination)
  mkdirSync(dirname(destinationPath), { recursive: true })
  const stage = mkdtempSync(join(dirname(destinationPath), `.${basename(destinationPath)}-extract-`))
  try {
    // bsdtar rejects path and symlink traversal while writing; the isolated stage
    // is additionally inspected before its sole expected root is atomically published.
    execFileSync(archiveExecutable(), ['-xzf', archivePath, '-C', stage, '--no-same-owner'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    })
    const extractedRoot = join(stage, expectedRoot)
    if (!existsSync(extractedRoot) || !lstatSync(extractedRoot).isDirectory()) {
      throw new ArchiveTreeError(`archive root is not a directory: ${expectedRoot}`)
    }
    assertContainedSymlinks(extractedRoot)
    mkdirSync(destinationPath, { recursive: true })
    const publishedRoot = join(destinationPath, expectedRoot)
    if (existsSync(publishedRoot)) throw new ArchiveTreeError(`archive destination already exists: ${publishedRoot}`)
    renameSync(extractedRoot, publishedRoot)
    return publishedRoot
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

function main(argv) {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: {
      source: { type: 'string' },
      archive: { type: 'string' },
      destination: { type: 'string' },
      'expected-root': { type: 'string' },
    },
  })
  if (command === 'create' && values.source && values.archive) {
    createTreeArchive({ source: values.source, archive: values.archive })
    return
  }
  if (command === 'extract' && values.archive && values.destination && values['expected-root']) {
    extractTreeArchive({
      archive: values.archive,
      destination: values.destination,
      expectedRoot: values['expected-root'],
    })
    return
  }
  throw new ArchiveTreeError(
    'usage: archive-tree.mjs create --source <path> --archive <tar.gz> | ' +
      'extract --archive <tar.gz> --destination <dir> --expected-root <name>',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`archive-tree: ${err.message}\n`)
    process.exitCode = 1
  }
}
