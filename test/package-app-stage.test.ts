// test/package-app-stage.test.ts — issue #139: the development `npm run package:app`
// path must ship the checked-in lockfile's production graph, not whatever
// package.json's ranges resolve to on the day it runs.
//
// scripts/package-app.sh itself cannot run here (it rebuilds a native module for
// Electron's ABI and packages a .app), so its contract is split in two: the
// staging and graph check it delegates to scripts/package-app-stage.mjs run FOR
// REAL below, including a real `npm ci` over locally packed tarballs, and the
// order of the shell steps around them is pinned at the source.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { npmCliForCurrentNode } from '../scripts/build-thin-app.mjs'
import {
  DEVELOPMENT_PRODUCT_NAME,
  ELECTRON_MAIN,
  PackageAppStageError,
  stageDevelopmentApp,
  verifyStagedLockGraph,
} from '../scripts/package-app-stage.mjs'

const root = resolve(process.cwd())
const temps: string[] = []

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function caught(run: () => unknown): PackageAppStageError {
  try {
    run()
  } catch (err) {
    expect(err).toBeInstanceOf(PackageAppStageError)
    return err as PackageAppStageError
  }
  throw new Error('expected a PackageAppStageError')
}

describe('package-app.sh installs and verifies the checked-in lockfile graph (#139)', () => {
  const sh = readFileSync(join(root, 'scripts', 'package-app.sh'), 'utf8')
  const at = (needle: string) => {
    const index = sh.indexOf(needle)
    expect(index, `package-app.sh is missing ${needle}`).toBeGreaterThan(-1)
    return index
  }

  it('stages through the shared release staging instead of writing its own manifest', () => {
    at('"$ROOT/scripts/package-app-stage.mjs" stage "$ROOT" "$STAGE"')
    expect(readFileSync(join(root, 'scripts', 'package-app-stage.mjs'), 'utf8'))
      .toContain('copyRequiredTree(repoRoot, stageRoot)')
    expect(sh).not.toMatch(/writeFileSync\('\$STAGE\/package\.json'/)
  })

  it('installs with npm ci from the lockfile, never by resolving package.json ranges', () => {
    at('npm ci --omit=dev --prefer-offline --no-audit --no-fund')
    expect(sh).not.toMatch(/npm install\b/)
  })

  it('keeps the Electron rebuild inside the stage and checks the graph before and after packaging', () => {
    const stage = at('"$ROOT/scripts/package-app-stage.mjs" stage')
    const install = at('npm ci --omit=dev')
    const enterStage = sh.lastIndexOf('cd "$STAGE"', install)
    const rebuild = at('npx --yes @electron/rebuild -f -w better-sqlite3 -v "$ELECTRON_VERSION" -m "$STAGE"')
    const stagedCheck = at('verify "$ROOT/package-lock.json" "$STAGE" --label staged')
    const leaveStage = at('cd "$ROOT"\n# --no-asar')
    const packager = at('npx --yes @electron/packager "$STAGE"')
    const packagedCheck = at('verify "$ROOT/package-lock.json" "$APP/Contents/Resources/app" --label packaged')
    const signing = at('codesign --force --deep --sign - "$APP"')

    expect(stage).toBeLessThan(install)
    expect(enterStage).toBeGreaterThan(stage)
    expect(sh.slice(enterStage, rebuild)).not.toContain('cd "$ROOT"')
    expect(install).toBeLessThan(rebuild)
    expect(rebuild).toBeLessThan(stagedCheck)
    expect(stagedCheck).toBeLessThan(leaveStage)
    expect(leaveStage).toBeLessThan(packager)
    expect(packager).toBeLessThan(packagedCheck)
    expect(packagedCheck).toBeLessThan(signing)
  })

  it('packages the installed tree as-is, because npm ci never installed the listed devDependencies', () => {
    const packager = sh.slice(sh.indexOf('npx --yes @electron/packager'), sh.indexOf('--app-bundle-id'))
    expect(packager).toContain('--no-prune')
    expect(packager).toContain('--no-asar')
    expect(packager).toContain('--no-junk')
  })

  it('keeps the development and portable signing boundaries unchanged', () => {
    expect(sh).toContain('echo "Portable package staged unsigned; Layer 2 owns nested and outer signing."')
    expect(sh).toContain('echo "Packaged (development, ad-hoc signed): $APP"')
    expect(sh.match(/codesign/g)).toHaveLength(1)
    expect(sh).not.toMatch(/notarytool|stapler/)
  })
})

type LockEntry = {
  version?: string
  resolved?: string
  integrity?: string
  dev?: boolean
  optional?: boolean
  devOptional?: boolean
  inBundle?: boolean
  link?: boolean
}

function nameOf(key: string): string {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

function locked(key: string, version: string, flags: LockEntry = {}): LockEntry {
  const name = nameOf(key)
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`,
    integrity: `sha512-${Buffer.from(`${name}@${version}`).toString('base64')}`,
    ...flags,
  }
}

const SOURCE: Record<string, LockEntry> = {
  'node_modules/@hono/node-server': locked('node_modules/@hono/node-server', '2.1.5'),
  'node_modules/body-parser/node_modules/content-type': locked('node_modules/body-parser/node_modules/content-type', '2.0.0'),
  'node_modules/body-parser': locked('node_modules/body-parser', '2.2.2'),
  'node_modules/express': locked('node_modules/express', '5.2.1'),
  'node_modules/hono': locked('node_modules/hono', '4.13.13'),
  'node_modules/zod': locked('node_modules/zod', '4.4.3'),
  'node_modules/native-optional': locked('node_modules/native-optional', '1.0.0', { optional: true }),
  'node_modules/vitest': locked('node_modules/vitest', '4.1.12', { dev: true }),
  'node_modules/@esbuild/linux-x64': locked('node_modules/@esbuild/linux-x64', '0.28.1', { dev: true, optional: true }),
}

// What `npm ci --omit=dev` leaves on a platform that skips the optional package.
const PRODUCTION = Object.fromEntries(
  Object.entries(SOURCE).filter(([key, entry]) => !entry.dev && key !== 'node_modules/native-optional'),
)

function lockfile(packages: Record<string, LockEntry>, lockfileVersion = 3) {
  return { name: 'fixture', version: '1.0.0', lockfileVersion, requires: true, packages }
}

function writeSourceLock(dir: string, packages: Record<string, LockEntry> = SOURCE): string {
  const path = join(dir, 'package-lock.json')
  writeFileSync(path, JSON.stringify(lockfile({ '': { version: '1.0.0' }, ...packages }), null, 2))
  return path
}

/** Lay out packages on disk and record them the way npm's reify does. */
function install(
  appRoot: string,
  packages: Record<string, LockEntry>,
  recorded: Record<string, LockEntry> = packages,
): string {
  for (const [key, entry] of Object.entries(packages)) {
    mkdirSync(join(appRoot, key), { recursive: true })
    writeFileSync(join(appRoot, key, 'package.json'), JSON.stringify({ name: nameOf(key), version: entry.version }))
  }
  mkdirSync(join(appRoot, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(appRoot, 'node_modules', '.package-lock.json'), JSON.stringify(lockfile(recorded), null, 2))
  return appRoot
}

describe('verifyStagedLockGraph', () => {
  it('accepts exactly the lockfile production graph, omitting dev-only and skipped optional packages', () => {
    const dir = tmp('stage-graph-ok-')
    const lockPath = writeSourceLock(dir)
    const appRoot = install(join(dir, 'app'), PRODUCTION)

    expect(verifyStagedLockGraph({ lockPath, appRoot })).toEqual({
      packages: 6,
      omittedDev: 2,
      optionalAbsent: ['node_modules/native-optional'],
    })
    install(appRoot, { ...PRODUCTION, 'node_modules/native-optional': SOURCE['node_modules/native-optional']! })
    expect(verifyStagedLockGraph({ lockPath, appRoot }).optionalAbsent).toEqual([])
  })

  it('reports the range-resolved drift #139 observed: newer versions and unlocked nested packages', () => {
    const dir = tmp('stage-graph-drift-')
    const lockPath = writeSourceLock(dir)
    const drifted = {
      ...PRODUCTION,
      'node_modules/zod': locked('node_modules/zod', '4.6.7'),
      'node_modules/express': locked('node_modules/express', '5.3.0'),
      'node_modules/express/node_modules/content-type': locked('node_modules/express/node_modules/content-type', '2.1.0'),
    }
    const error = caught(() => verifyStagedLockGraph({ lockPath, appRoot: install(join(dir, 'app'), drifted) }))

    expect(error.problems).toEqual([
      'node_modules/express: installed 5.3.0; the lockfile has 5.2.1; integrity differs from the lockfile',
      'node_modules/express/node_modules/content-type: 2.1.0 is installed but the lockfile has no such package',
      'node_modules/zod: installed 4.6.7; the lockfile has 4.4.3; integrity differs from the lockfile',
    ])
    expect(error.message).toMatch(/does not hold the production graph of .*package-lock\.json \(3 differences\)/)
  })

  it('rejects a same-version package whose recorded integrity is not the lockfile tarball', () => {
    const dir = tmp('stage-graph-integrity-')
    const lockPath = writeSourceLock(dir)
    const recorded = {
      ...PRODUCTION,
      'node_modules/hono': { ...PRODUCTION['node_modules/hono'], integrity: 'sha512-other-bytes' },
    }
    const error = caught(() => verifyStagedLockGraph({ lockPath, appRoot: install(join(dir, 'app'), PRODUCTION, recorded) }))

    expect(error.problems).toEqual(['node_modules/hono: integrity differs from the lockfile'])
  })

  it('rejects dev-only packages and missing production packages', () => {
    const dir = tmp('stage-graph-membership-')
    const lockPath = writeSourceLock(dir)
    const { 'node_modules/hono': _hono, ...withoutHono } = PRODUCTION
    const installed = { ...withoutHono, 'node_modules/vitest': SOURCE['node_modules/vitest']! }
    const error = caught(() => verifyStagedLockGraph({ lockPath, appRoot: install(join(dir, 'app'), installed) }))

    expect(error.problems).toEqual([
      'node_modules/hono: missing; the lockfile has 4.13.13',
      'node_modules/vitest: dev-only package 4.1.12 is installed',
    ])
  })

  it('checks the files on disk, not only npm\'s record of them', () => {
    const dir = tmp('stage-graph-disk-')
    const lockPath = writeSourceLock(dir)
    const appRoot = install(join(dir, 'app'), PRODUCTION)
    writeFileSync(join(appRoot, 'node_modules', 'hono', 'package.json'), JSON.stringify({ name: 'hono', version: '4.13.14' }))
    rmSync(join(appRoot, 'node_modules', 'zod'), { recursive: true })
    mkdirSync(join(appRoot, 'node_modules', 'stray'))

    expect(caught(() => verifyStagedLockGraph({ lockPath, appRoot })).problems).toEqual([
      'node_modules/hono: installed 4.13.14; the lockfile has 4.13.13; node_modules/.package-lock.json records 4.13.13',
      'node_modules/stray: has no readable package.json version',
      'node_modules/zod: recorded in node_modules/.package-lock.json but not installed',
    ])
  })

  it('refuses an install npm did not record and lockfiles it cannot verify', () => {
    const dir = tmp('stage-graph-shapes-')
    const appRoot = join(dir, 'app')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    expect(caught(() => verifyStagedLockGraph({ lockPath: writeSourceLock(dir), appRoot })).message)
      .toMatch(/\.package-lock\.json is missing; npm did not record this install/)

    install(appRoot, PRODUCTION)
    const v1 = join(dir, 'v1.json')
    writeFileSync(v1, JSON.stringify({ lockfileVersion: 1, dependencies: {} }))
    expect(caught(() => verifyStagedLockGraph({ lockPath: v1, appRoot })).message)
      .toMatch(/not a lockfileVersion 2\+ npm lockfile/)

    const linked = writeSourceLock(dir, { ...SOURCE, 'node_modules/local': { resolved: 'packages/local', link: true } })
    expect(caught(() => verifyStagedLockGraph({ lockPath: linked, appRoot })).message)
      .toMatch(/node_modules\/local is a linked or workspace package/)

    const unhashed = writeSourceLock(dir, {
      ...SOURCE,
      'node_modules/hono': { version: '4.13.13', resolved: 'git+ssh://git@github.com/honojs/hono.git#abc' },
    })
    expect(caught(() => verifyStagedLockGraph({ lockPath: unhashed, appRoot })).message)
      .toMatch(/node_modules\/hono has no integrity/)
  })
})

/** A repo root carrying the real checked-in package metadata and stub app trees. */
function fixtureRepo(
  edit: (pkg: Record<string, unknown>) => void = () => {},
  repo: string = tmp('stage-repo-'),
): string {
  mkdirSync(repo, { recursive: true })
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  edit(pkg)
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(join(repo, 'package-lock.json'), readFileSync(join(root, 'package-lock.json')))
  for (const [path, text] of [
    ['dist/viewer-server.js', 'export {}\n'],
    ['public/index.html', '<!doctype html>\n'],
    [ELECTRON_MAIN, "'use strict'\n"],
    ['release/update-keys.json', '{}\n'],
    ['docs/reporting-snippet.md', '# snippet\n'],
    ['LICENSE', 'MIT\n'],
  ] as const) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  return repo
}

describe('stageDevelopmentApp', () => {
  it('stages the checked-in manifest and lockfile coherently, with ESM mode and the Electron entry point', () => {
    const repo = fixtureRepo()
    const stage = join(tmp('stage-out-'), 'stage')
    stageDevelopmentApp(repo, stage)

    const checkedIn = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, Record<string, unknown>>
    }
    const staged = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')) as Record<string, unknown>

    expect(readFileSync(join(stage, 'package-lock.json')).equals(readFileSync(join(root, 'package-lock.json')))).toBe(true)
    expect(staged).toEqual({ ...checkedIn, productName: DEVELOPMENT_PRODUCT_NAME })
    expect(Object.keys(staged).slice(0, 3)).toEqual(['name', 'productName', 'version'])
    expect(staged['type']).toBe('module')
    expect(staged['main']).toBe(ELECTRON_MAIN)
    expect(staged['dependencies']).toEqual(lock.packages['']?.['dependencies'])
    expect(staged['devDependencies']).toEqual(lock.packages['']?.['devDependencies'])
    for (const path of [ELECTRON_MAIN, 'public/index.html', 'dist/viewer-server.js', 'release/update-keys.json',
      'docs/reporting-snippet.md', 'LICENSE.agent-inbox']) {
      expect(existsSync(join(stage, path)), path).toBe(true)
    }
  })

  it('refuses metadata that would not stage a coherent ESM Electron app', () => {
    const cases: Array<[(pkg: Record<string, unknown>) => void, RegExp]> = [
      [(pkg) => { delete pkg['type'] }, /must declare "type": "module"/],
      [(pkg) => { pkg['main'] = 'dist/viewer-server.js' }, /"main" must be the Electron entry point electron\/main\.cjs/],
      [(pkg) => { pkg['version'] = '0.0.0-unlocked' }, /describe different packages/],
    ]
    for (const [edit, message] of cases) {
      expect(caught(() => stageDevelopmentApp(fixtureRepo(edit), join(tmp('stage-out-'), 'stage'))).message)
        .toMatch(message)
    }

    const occupied = tmp('stage-occupied-')
    writeFileSync(join(occupied, 'leftover'), '')
    expect(caught(() => stageDevelopmentApp(fixtureRepo(), occupied)).message).toMatch(/stage directory must be empty/)
  })
})

function resolveNpmCli(): string | undefined {
  try {
    return npmCliForCurrentNode()
  } catch {
    return undefined
  }
}

const NPM_CLI = resolveNpmCli()

describe.skipIf(!NPM_CLI)('a real npm ci over the staged pair', () => {
  const npm = (cwd: string, ...args: string[]) => execFileSync(process.execPath, [NPM_CLI as string, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  })

  it('installs only the locked production graph, which the check then accepts', () => {
    const work = tmp('stage-npm-')
    const tarballs = join(work, 'tgz')
    mkdirSync(tarballs)
    for (const name of ['prod-dep', 'dev-dep']) {
      const source = join(work, 'src', name)
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
      npm(source, 'pack', '--pack-destination', tarballs)
    }
    const repo = fixtureRepo((pkg) => {
      pkg['version'] = '1.0.0'
      pkg['dependencies'] = { 'prod-dep': `file:${join(tarballs, 'prod-dep-1.0.0.tgz')}` }
      pkg['devDependencies'] = { 'dev-dep': `file:${join(tarballs, 'dev-dep-1.0.0.tgz')}` }
      delete pkg['allowScripts']
    }, join(work, 'repo'))
    rmSync(join(repo, 'package-lock.json'))
    npm(repo, 'install', '--package-lock-only', '--offline', '--no-audit', '--no-fund')
    // The lockfile records file: tarballs relative to itself, so stage at the same depth.
    const stage = join(work, 'stage')
    stageDevelopmentApp(repo, stage)

    npm(stage, 'ci', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund', '--offline')

    expect(existsSync(join(stage, 'node_modules', 'prod-dep', 'package.json'))).toBe(true)
    expect(existsSync(join(stage, 'node_modules', 'dev-dep'))).toBe(false)
    expect(verifyStagedLockGraph({ lockPath: join(repo, 'package-lock.json'), appRoot: stage })).toEqual({
      packages: 1,
      omittedDev: 1,
      optionalAbsent: [],
    })
  }, 60_000)
})
