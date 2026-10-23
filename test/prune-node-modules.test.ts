// Every shipped node_modules copy, the app's and each Setup runtime's, used to
// carry what nothing loads at runtime (#291, from the #281 audit's Q2 and Q3):
// better-sqlite3's compile leftovers and C sources, TypeScript declarations,
// source maps and non-license markdown. The release builders prune each copy
// before anything is tested, manifested or signed; licenses always stay.
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PruneNodeModulesError,
  assertPrunedNodeModules,
  isLicenseFile,
  pruneNodeModules,
} from '../scripts/prune-node-modules.mjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')

afterEach(removeScratchDirs)

function writeTree(root: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

function listFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else out.push(relative(root, path).split(sep).join('/'))
    }
  }
  visit(root)
  return out.sort()
}

const BETTER_SQLITE3_PACKAGE = JSON.stringify({ name: 'better-sqlite3', version: '12.11.1', main: 'lib/index.js' })

// What `npm ci` and a from-source build leave in a runtime, with make (macOS,
// Linux) and MSBuild (Windows) leftovers, and @electron/rebuild's cache.
const BETTER_SQLITE3_BUILD: Record<string, string> = {
  'node_modules/better-sqlite3/package.json': BETTER_SQLITE3_PACKAGE,
  'node_modules/better-sqlite3/LICENSE': 'MIT License\n',
  'node_modules/better-sqlite3/README.md': '# better-sqlite3\n',
  'node_modules/better-sqlite3/binding.gyp': '{}\n',
  'node_modules/better-sqlite3/lib/index.js': "module.exports = require('./database')\n",
  'node_modules/better-sqlite3/lib/database.js': "require('bindings')('better_sqlite3.node')\n",
  'node_modules/better-sqlite3/lib/methods/pragma.js': 'module.exports = {}\n',
  'node_modules/better-sqlite3/src/better_sqlite3.cpp': '// C++\n',
  'node_modules/better-sqlite3/src/objects/statement.hpp': '// C++\n',
  'node_modules/better-sqlite3/deps/sqlite3.gyp': '{}\n',
  'node_modules/better-sqlite3/deps/test_extension.c': '/* C */\n',
  'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c': '/* 9 MB of C */\n',
  'node_modules/better-sqlite3/deps/sqlite3/sqlite3.h': '/* C */\n',
  'node_modules/better-sqlite3/deps/patches/1208.patch': 'diff\n',
  'node_modules/better-sqlite3/build/Makefile': 'all:\n',
  'node_modules/better-sqlite3/build/config.gypi': '{ "variables": { "nodedir": "/Users/builder/node" } }\n',
  'node_modules/better-sqlite3/build/gyp-mac-tool': '#!/usr/bin/env python3\n',
  'node_modules/better-sqlite3/build/better_sqlite3.vcxproj': '<Project/>\n',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'the addon\n',
  'node_modules/better-sqlite3/build/Release/test_extension.node': 'a test addon\n',
  'node_modules/better-sqlite3/build/Release/sqlite3.a': '!<arch>\n',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.pdb': 'symbols\n',
  'node_modules/better-sqlite3/build/Release/.deps/Release/sqlite3.a.d': 'deps\n',
  'node_modules/better-sqlite3/build/Release/obj/gen/sqlite3/sqlite3.c': '/* copy of the C */\n',
  'node_modules/better-sqlite3/build/Release/obj.target/sqlite3/gen/sqlite3/sqlite3.o': 'object\n',
  'node_modules/better-sqlite3/build/Release/obj/better_sqlite3/better_sqlite3.tlog/CL.command.1.tlog': 'log\n',
  'node_modules/better-sqlite3/bin/darwin-arm64-148/better-sqlite3.node': 'rebuild cache\n',
  'node_modules/better-sqlite3/node_modules/bindings/package.json': '{"name":"bindings","main":"bindings.js"}',
  'node_modules/better-sqlite3/node_modules/bindings/bindings.js': 'module.exports = () => {}\n',
  'node_modules/better-sqlite3/node_modules/bindings/README.md': '# bindings\n',
  'node_modules/better-sqlite3/node_modules/bindings/LICENSE.md': 'MIT\n',
}

const ORDINARY_PACKAGES: Record<string, string> = {
  'node_modules/.package-lock.json': '{}\n',
  'node_modules/zod/package.json': '{"name":"zod"}',
  'node_modules/zod/LICENSE': 'MIT\n',
  'node_modules/zod/README.md': '# zod\n',
  'node_modules/zod/index.js': 'export {}\n',
  'node_modules/zod/index.cjs': 'module.exports = {}\n',
  'node_modules/zod/index.d.ts': 'export {}\n',
  'node_modules/zod/index.d.cts': 'export {}\n',
  'node_modules/zod/v4/core/index.d.mts': 'export {}\n',
  'node_modules/zod/index.js.map': '{"version":3}\n',
  'node_modules/zod/index.d.ts.map': '{"version":3}\n',
  'node_modules/zod/v4/core/core.cjs.map': '{"version":3}\n',
  'node_modules/zod/src/index.ts': 'export {}\n',
  'node_modules/zod/data/regions.map': 'not a source map\n',
  'node_modules/@scope/pkg/package.json': '{"name":"@scope/pkg"}',
  'node_modules/@scope/pkg/index.js': 'module.exports = 1\n',
  'node_modules/@scope/pkg/CHANGELOG.md': '# changes\n',
  'node_modules/@scope/pkg/docs/guide.markdown': 'guide\n',
  'node_modules/@scope/pkg/docs/index.md': 'docs\n',
  'node_modules/@scope/pkg/LICENSE-MIT': 'MIT\n',
  'node_modules/@scope/pkg/LICENSE.APACHE2': 'Apache\n',
  'node_modules/@scope/pkg/NOTICE.md': 'Apache NOTICE\n',
  'node_modules/@scope/pkg/AUTHORS.md': 'the authors\n',
  'node_modules/@scope/pkg/ThirdPartyNotices.txt': 'notices\n',
  'node_modules/@scope/pkg/vendor/COPYING.md': 'GPL-compatible notice\n',
  'node_modules/@scope/pkg/vendor/license.md': 'vendored license\n',
  'node_modules/@scope/pkg/LICENSES/MIT.md': 'MIT\n',
  'node_modules/unlicensed/package.json': '{"name":"unlicensed","license":"MIT"}',
  'node_modules/unlicensed/README.md': 'Copyright (c) someone. MIT License: ...\n',
  'node_modules/unlicensed/docs/api.md': 'api\n',
  'node_modules/unlicensed/index.js': 'module.exports = 1\n',
}

// Outside node_modules nothing is touched, markdown included.
const OUTSIDE: Record<string, string> = {
  'docs/reporting-snippet.md': 'snippet\n',
  'dist/store.js': 'export {}\n',
  'dist/store.d.ts': 'export {}\n',
  'README.md': 'stage readme\n',
}

describe('pruneNodeModules (#291)', () => {
  it('prunes better-sqlite3 to what it loads and drops typings, source maps and non-license markdown', () => {
    const root = writeTree(scratchDir('prune-fixture-'), { ...BETTER_SQLITE3_BUILD, ...ORDINARY_PACKAGES, ...OUTSIDE })
    mkdirSync(join(root, 'node_modules', 'zod', 'empty'))

    const result = pruneNodeModules(root)

    expect(listFiles(root)).toEqual([
      'README.md',
      'dist/store.d.ts',
      'dist/store.js',
      'docs/reporting-snippet.md',
      'node_modules/.package-lock.json',
      'node_modules/@scope/pkg/AUTHORS.md',
      'node_modules/@scope/pkg/LICENSE-MIT',
      'node_modules/@scope/pkg/LICENSE.APACHE2',
      'node_modules/@scope/pkg/LICENSES/MIT.md',
      'node_modules/@scope/pkg/NOTICE.md',
      'node_modules/@scope/pkg/ThirdPartyNotices.txt',
      'node_modules/@scope/pkg/index.js',
      'node_modules/@scope/pkg/package.json',
      'node_modules/@scope/pkg/vendor/COPYING.md',
      'node_modules/@scope/pkg/vendor/license.md',
      'node_modules/better-sqlite3/LICENSE',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'node_modules/better-sqlite3/lib/database.js',
      'node_modules/better-sqlite3/lib/index.js',
      'node_modules/better-sqlite3/lib/methods/pragma.js',
      'node_modules/better-sqlite3/node_modules/bindings/LICENSE.md',
      'node_modules/better-sqlite3/node_modules/bindings/bindings.js',
      'node_modules/better-sqlite3/node_modules/bindings/package.json',
      'node_modules/better-sqlite3/package.json',
      'node_modules/unlicensed/README.md',
      'node_modules/unlicensed/index.js',
      'node_modules/unlicensed/package.json',
      'node_modules/zod/LICENSE',
      'node_modules/zod/data/regions.map',
      'node_modules/zod/index.cjs',
      'node_modules/zod/index.js',
      'node_modules/zod/package.json',
      'node_modules/zod/src/index.ts',
    ])
    const betterSqlite3 = join(root, 'node_modules', 'better-sqlite3')
    // directories the prune emptied go too; one it found empty stays
    expect(readdirSync(betterSqlite3).sort()).toEqual(['LICENSE', 'build', 'lib', 'node_modules', 'package.json'])
    expect(readdirSync(join(betterSqlite3, 'build'))).toEqual(['Release'])
    expect(readdirSync(join(betterSqlite3, 'build', 'Release'))).toEqual(['better_sqlite3.node'])
    expect(existsSync(join(root, 'node_modules', '@scope', 'pkg', 'docs'))).toBe(false)
    expect(existsSync(join(root, 'node_modules', 'unlicensed', 'docs'))).toBe(false)
    expect(existsSync(join(root, 'node_modules', 'zod', 'v4'))).toBe(false)
    expect(lstatSync(join(root, 'node_modules', 'zod', 'empty')).isDirectory()).toBe(true)

    const removed = Object.keys({ ...BETTER_SQLITE3_BUILD, ...ORDINARY_PACKAGES }).filter((path) => !listFiles(root).includes(path))
    expect(result.removedFiles).toBe(removed.length)
    expect(result.removedBytes).toBe(removed.reduce((sum, path) => sum + Buffer.byteLength(
      ({ ...BETTER_SQLITE3_BUILD, ...ORDINARY_PACKAGES })[path]!,
    ), 0))
    expect(pruneNodeModules(root)).toEqual({ removedFiles: 0, removedBytes: 0 })
  })

  it('recognizes license, notice and copying files under every common name', () => {
    for (const name of [
      'LICENSE', 'license', 'LICENSE.md', 'license.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE.BSD', 'LICENCE',
      'UNLICENSE', 'NOTICE', 'NOTICE.md', 'COPYING', 'COPYING.LESSER', 'COPYRIGHT', 'AUTHORS', 'AUTHORS.md',
      'CONTRIBUTORS.md', 'PATENTS', 'ThirdPartyNotices.txt', 'THIRD-PARTY-NOTICES.md', 'LICENSES.chromium.html',
      'MIT-LICENSE.txt',
    ]) {
      expect(isLicenseFile(name), name).toBe(true)
    }
    for (const name of ['README.md', 'CHANGELOG.md', 'HISTORY.md', 'index.d.ts', 'authorship.md', 'SECURITY.md']) {
      expect(isLicenseFile(name), name).toBe(false)
    }
  })

  it('leaves links and entries beside the packages alone', () => {
    const root = writeTree(scratchDir('prune-links-'), {
      'node_modules/zod/package.json': '{"name":"zod"}',
      'node_modules/zod/LICENSE': 'MIT\n',
      'node_modules/zod/README.md': '# zod\n',
      'node_modules/stray.md': 'not inside a package\n',
      'node_modules/.bin/README.md': 'not a package\n',
      'outside/README.md': 'linked\n',
    })
    symlinkSync(join(root, 'outside'), join(root, 'node_modules', 'zod', 'linked'), 'dir')
    symlinkSync(join(root, 'outside', 'README.md'), join(root, 'node_modules', 'zod', 'HISTORY.md'))

    expect(pruneNodeModules(root)).toEqual({ removedFiles: 1, removedBytes: 6 })
    expect(existsSync(join(root, 'node_modules', 'zod', 'README.md'))).toBe(false)
    expect(lstatSync(join(root, 'node_modules', 'zod', 'HISTORY.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(root, 'outside', 'README.md'), 'utf8')).toBe('linked\n')
    expect(existsSync(join(root, 'node_modules', 'stray.md'))).toBe(true)
    expect(existsSync(join(root, 'node_modules', '.bin', 'README.md'))).toBe(true)
  })

  it('refuses a better-sqlite3 it cannot prove still loads', () => {
    // null deletes the file
    const cases: Array<[Record<string, string | null>, RegExp]> = [
      [{ 'build/Release/better_sqlite3.node': null }, /no compiled build\/Release\/better_sqlite3\.node/],
      [{ 'package.json': JSON.stringify({ name: 'better-sqlite3', main: 'src/index.js' }) }, /loads src\/index\.js, outside lib\//],
      [{ 'package.json': JSON.stringify({ name: 'better-sqlite3', main: 'lib/index.js', exports: { '.': './dist/index.js' } }) },
        /loads dist\/index\.js, outside lib\//],
      [{ 'lib/index.js': null }, /entry point lib\/index\.js is missing/],
    ]
    for (const [edit, message] of cases) {
      const files: Record<string, string> = { ...BETTER_SQLITE3_BUILD }
      for (const [path, text] of Object.entries(edit)) {
        const key = `node_modules/better-sqlite3/${path}`
        if (text === null) delete files[key]
        else files[key] = text
      }
      const root = writeTree(scratchDir('prune-refuse-'), files)
      expect(() => pruneNodeModules(root)).toThrow(PruneNodeModulesError)
      expect(() => pruneNodeModules(root)).toThrow(message)
      // nothing is removed from a package it refuses
      expect(existsSync(join(root, 'node_modules', 'better-sqlite3', 'deps', 'sqlite3', 'sqlite3.c'))).toBe(true)
    }
  })

  it('is a no-op for a tree without node_modules', () => {
    const root = writeTree(scratchDir('prune-empty-'), OUTSIDE)
    expect(pruneNodeModules(root)).toEqual({ removedFiles: 0, removedBytes: 0 })
    expect(listFiles(root)).toEqual(Object.keys(OUTSIDE).sort())
  })
})

describe('assertPrunedNodeModules (#291)', () => {
  it('names what a shipped tree still carries, then passes once it is pruned', () => {
    const root = writeTree(scratchDir('prune-gate-'), { ...BETTER_SQLITE3_BUILD, ...ORDINARY_PACKAGES })
    let message = ''
    try {
      assertPrunedNodeModules(root, 'packaged app')
    } catch (err) {
      expect(err).toBeInstanceOf(PruneNodeModulesError)
      message = (err as Error).message
    }
    const count = Number(/^packaged app ships (\d+) node_modules files nothing loads \(#291\): /.exec(message)?.[1])
    // sorted, so the first is predictable; the rest are counted
    expect(message).toContain(': node_modules/@scope/pkg/CHANGELOG.md, ')
    expect(message).toMatch(/, and \d+ more$/)

    expect(pruneNodeModules(root).removedFiles).toBe(count)
    expect(() => assertPrunedNodeModules(root, 'packaged app')).not.toThrow()
  })

  it('refuses a pruned tree whose better-sqlite3 lost its addon', () => {
    const root = writeTree(scratchDir('prune-gate-addon-'), BETTER_SQLITE3_BUILD)
    pruneNodeModules(root)
    expect(() => assertPrunedNodeModules(root, 'runtime')).not.toThrow()
    rmSync(join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))
    expect(() => assertPrunedNodeModules(root, 'runtime')).toThrow(/no compiled build\/Release\/better_sqlite3\.node/)
  })
})

// The checkout's own install holds the production graph the app and each
// runtime ship, at the same lockfile paths `npm ci --omit=dev` uses, with a
// better-sqlite3 addon built for this Node. Prune a copy of it.
function copyProductionGraph(destination: string): string[] {
  const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dev?: boolean }>
  }
  const keys = Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && existsSync(join(REPO, key)))
    .map(([key]) => key)
  for (const key of keys) {
    const source = join(REPO, key)
    cpSync(source, join(destination, key), {
      recursive: true,
      // nested packages are lockfile keys of their own
      filter: (path) => !relative(source, path).split(sep).includes('node_modules'),
    })
  }
  return keys
}

function licenseInventory(root: string): Map<string, string> {
  return new Map(listFiles(root)
    .filter((path) => isLicenseFile(path.slice(path.lastIndexOf('/') + 1)))
    .map((path) => [path, readFileSync(join(root, path), 'utf8')]))
}

// Every bare module the shipped code imports: dist/ is built from src/.
function importedPackages(): string[] {
  const specifiers = new Set<string>()
  const patterns = [
    /^\s*(?:import|export)\b[^'"]*?\bfrom\s*(['"])([^'"]+)\1/gm,
    /^\s*import\s*(['"])([^'"]+)\1/gm,
    /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g,
  ]
  for (const name of readdirSync(join(REPO, 'src')).filter((file) => file.endsWith('.ts'))) {
    const source = readFileSync(join(REPO, 'src', name), 'utf8')
    for (const pattern of patterns) {
      for (const [, , specifier] of source.matchAll(pattern)) {
        if (!/^(?:\.|\/|node:)/.test(specifier!)) specifiers.add(specifier!)
      }
    }
  }
  return [...specifiers].sort()
}

describe('the real production graph (#291)', () => {
  it('loses no license and keeps every module the shipped code imports', () => {
    const root = scratchDir('prune-production-')
    writeFileSync(join(root, 'package.json'), '{"type":"module","private":true}\n')
    const packages = copyProductionGraph(root)
    expect(packages).toContain('node_modules/better-sqlite3')
    const licenses = licenseInventory(root)
    const before = listFiles(root)

    const result = pruneNodeModules(root)
    const after = listFiles(root)

    expect(result.removedFiles).toBe(before.length - after.length)
    expect(licenseInventory(root)).toEqual(licenses)
    // every package still has the license it shipped with
    for (const key of packages) {
      expect(readdirSync(join(root, key)).some(isLicenseFile), key).toBe(true)
    }
    expect(after.filter((path) => /\.d\.[cm]?ts$|\.[cm]?[jt]sx?\.map$/i.test(path))).toEqual([])
    expect(after.filter((path) => /\.(md|markdown)$/i.test(path) && !isLicenseFile(path.slice(path.lastIndexOf('/') + 1))))
      .toEqual([])
    expect(after.filter((path) => path.startsWith('node_modules/better-sqlite3/')).filter((path) =>
      !path.startsWith('node_modules/better-sqlite3/lib/'))).toEqual([
      'node_modules/better-sqlite3/LICENSE',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'node_modules/better-sqlite3/package.json',
    ])
    expect(() => assertPrunedNodeModules(root, 'pruned production graph')).not.toThrow()

    // What the app and the runtimes load, loaded from the pruned copy alone.
    const imports = importedPackages()
    expect(imports).toEqual(expect.arrayContaining(['better-sqlite3', 'hono', 'zod', '@modelcontextprotocol/sdk/server/mcp.js']))
    const probe = [
      ...imports.map((specifier) => `await import(${JSON.stringify(specifier)})`),
      "const { default: Database } = await import('better-sqlite3')",
      "const db = new Database(':memory:')",
      "process.stdout.write(String(db.prepare('select 41 + 1 as answer').get().answer))",
      'db.close()',
    ].join('\n')
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
      timeout: 30_000,
    })).toBe('42')
  }, 60_000)
})
