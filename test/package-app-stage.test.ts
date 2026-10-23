// test/package-app-stage.test.ts — issue #139: the development `npm run package:app`
// path must ship the checked-in lockfile's production graph, not whatever
// package.json's ranges resolve to on the day it runs.
//
// scripts/package-app.sh cannot run end to end here (it rebuilds a native module
// for Electron's ABI and packages a .app). The staging and graph check it
// delegates to scripts/package-app-stage.mjs run FOR REAL below, including a real
// `npm ci` over locally packed tarballs; the shell's own guards run for real
// against a fake checkout whose tools only record their calls; and the order of
// the remaining shell steps is pinned at the source.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { npmCliForCurrentNode } from '../scripts/build-thin-app.mjs'
import {
  DEVELOPMENT_PRODUCT_NAME,
  ELECTRON_MAIN,
  PackageAppStageError,
  stageDevelopmentApp,
  verifyStagedLockGraph,
} from '../scripts/package-app-stage.mjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const root = resolve(process.cwd())
function tmp(prefix: string): string {
  return scratchDir(prefix)
}

afterEach(removeScratchDirs)

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

  // --ignore-scripts and --build-from-source: no cached or downloaded prebuild (#315)
  it('installs with npm ci from the lockfile, never by resolving package.json ranges', () => {
    at('npm ci --prefix "$STAGE" --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund')
    expect(sh).not.toMatch(/npm install\b/)
  })

  it('keeps the Electron rebuild inside the stage and checks the graph before and after packaging', () => {
    const stage = at('"$ROOT/scripts/package-app-stage.mjs" stage')
    const install = at('npm ci --prefix "$STAGE" --omit=dev')
    const enterStage = sh.lastIndexOf('cd "$STAGE"', install)
    const rebuild = at('"$REBUILD" -f -w better-sqlite3 -v "$ELECTRON_VERSION" -m "$STAGE" --build-from-source')
    const prune = at('prune_modules "$STAGE"')
    const stagedCheck = at('verify_graph staged "$STAGE"')
    const leaveStage = at('cd "$ROOT"\n# --no-asar')
    const packager = at('npx --yes @electron/packager "$STAGE"')
    const localePrune = at('prune_locales "$APP"')
    const packagedCheck = at('verify_graph packaged "$APP/Contents/Resources/app"')
    const signing = at('codesign --force --deep --sign - "$APP"')

    expect(stage).toBeLessThan(install)
    expect(enterStage).toBeGreaterThan(stage)
    expect(sh.slice(enterStage, rebuild)).not.toContain('cd "$ROOT"')
    expect(install).toBeLessThan(rebuild)
    // pruned as the release builders prune (#291), then checked: the graph stays exact
    expect(rebuild).toBeLessThan(prune)
    expect(prune).toBeLessThan(stagedCheck)
    expect(stagedCheck).toBeLessThan(leaveStage)
    expect(leaveStage).toBeLessThan(packager)
    // only English, as the release builders keep it, before the ad-hoc seal (#292)
    expect(packager).toBeLessThan(localePrune)
    expect(localePrune).toBeLessThan(packagedCheck)
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

// A step that exits 0 having done nothing: what a skipped entry-point guard looks like.
const SILENT_STAGE_TOOL = ''
// Stages only the manifest pair and confirms its prune, but its graph check
// confirms nothing.
const MANIFEST_ONLY_STAGE_TOOL = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
const [command, first, stage] = process.argv.slice(2)
appendFileSync(process.env.CALLS, \`stage-tool \${process.argv[1]} \${process.argv.slice(2).join(' ')}\\n\`)
if (command === 'stage') {
  mkdirSync(stage, { recursive: true })
  for (const name of ['package.json', 'package-lock.json']) writeFileSync(\`\${stage}/\${name}\`, '{}\\n')
}
if (command === 'prune' && process.env.PRUNE_CONFIRMS !== '0') {
  process.stdout.write(\`package-app: pruned 0 files (0.0 MB) nothing loads from \${first}/node_modules\\n\`)
}
if (command === 'verify' && process.env.VERIFY_CONFIRMS === '1') {
  process.stdout.write(\`package-app: \${process.argv[6]} dependency graph matches package-lock.json: confirmed\\n\`)
}
`

/**
 * A checkout holding the real package-app.sh, a stand-in stage tool, and npm,
 * npx and the pinned electron-rebuild replaced by recorders, so the script's own
 * guards run for real while nothing is installed, rebuilt or packaged.
 */
function fakeCheckout(stageTool: string, { pinnedRebuild = true } = {}) {
  const work = realpathSync(tmp('package-app-sh-'))
  const repo = join(work, 'repo')
  const bin = join(work, 'bin')
  const calls = join(work, 'calls.log')
  for (const dir of [join(repo, 'scripts'), join(repo, 'node_modules', 'electron'), join(repo, 'node_modules', '.bin'), bin]) {
    mkdirSync(dir, { recursive: true })
  }
  copyFileSync(join(root, 'scripts', 'package-app.sh'), join(repo, 'scripts', 'package-app.sh'))
  writeFileSync(join(repo, 'scripts', 'package-app-stage.mjs'), stageTool)
  writeFileSync(join(repo, 'scripts', 'write-setup-info.mjs'), '')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
  writeFileSync(join(repo, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '43.8.0' }))
  const recorders = [join(bin, 'npm'), join(bin, 'npx')]
  if (pinnedRebuild) recorders.push(join(repo, 'node_modules', '.bin', 'electron-rebuild'))
  for (const recorder of recorders) {
    writeFileSync(recorder, '#!/bin/sh\necho "$(basename "$0") cwd=$(pwd -P) $*" >> "$CALLS"\n')
    chmodSync(recorder, 0o755)
  }
  const runtimes: Record<string, string> = {}
  for (const key of ['darwin-arm64', 'darwin-x64']) {
    runtimes[key] = join(work, 'runtime', key)
    mkdirSync(runtimes[key], { recursive: true })
    writeFileSync(join(runtimes[key], 'runtime-manifest.json'), '{}\n')
  }
  return {
    work,
    repo,
    stage: join(repo, 'build', 'stage'),
    portableEnv: {
      AGENT_INBOX_RUNTIME_DARWIN_ARM64: runtimes['darwin-arm64'],
      AGENT_INBOX_RUNTIME_DARWIN_X64: runtimes['darwin-x64'],
    },
    run(env: NodeJS.ProcessEnv = {}, script = join(repo, 'scripts', 'package-app.sh')) {
      return spawnSync('bash', [script], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: work, CALLS: calls, ...env },
      })
    },
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
  }
}

describe('package-app.sh refuses to continue past a step that did nothing', () => {
  it.each([['portable', true], ['development', false]])(
    'never runs npm ci when staging left no package.json + package-lock.json (%s package)',
    (_mode, portable) => {
      const checkout = fakeCheckout(SILENT_STAGE_TOOL)
      const result = checkout.run(portable ? checkout.portableEnv : {})

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        `package-app: ${checkout.stage} is missing its staged package.json or package-lock.json; refusing to run npm ci`,
      )
      expect(checkout.calls()).toEqual([
        `npm cwd=${checkout.repo} run generate:icons -- --check`,
        `npm cwd=${checkout.repo} run build`,
      ])
    },
  )

  it('resolves a symlinked checkout, rebuilds with the pinned tool in the stage, and requires the graph check to confirm', () => {
    const checkout = fakeCheckout(MANIFEST_ONLY_STAGE_TOOL)
    const linked = join(checkout.work, 'linked-checkout')
    symlinkSync(checkout.repo, linked, 'dir')
    const result = checkout.run({}, join(linked, 'scripts', 'package-app.sh'))
    const tool = join(checkout.repo, 'scripts', 'package-app-stage.mjs')
    const { repo, stage } = checkout

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`package-app: the staged dependency graph check did not confirm ${stage}`)
    expect(checkout.calls()).toEqual([
      `npm cwd=${repo} run generate:icons -- --check`,
      `npm cwd=${repo} run build`,
      `stage-tool ${tool} stage ${repo} ${stage}`,
      `npm cwd=${stage} ci --prefix ${stage} --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund`,
      `electron-rebuild cwd=${stage} -f -w better-sqlite3 -v 43.8.0 -m ${stage} --build-from-source`,
      `stage-tool ${tool} prune ${stage}`,
      `stage-tool ${tool} verify ${join(repo, 'package-lock.json')} ${stage} --label staged`,
    ])
  })

  it('stops before the graph check when the prune does not confirm (#291)', () => {
    const checkout = fakeCheckout(MANIFEST_ONLY_STAGE_TOOL)
    const result = checkout.run({ PRUNE_CONFIRMS: '0' })
    const tool = join(checkout.repo, 'scripts', 'package-app-stage.mjs')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`package-app: pruning did not confirm ${checkout.stage}`)
    expect(checkout.calls().slice(-2)).toEqual([
      `electron-rebuild cwd=${checkout.stage} -f -w better-sqlite3 -v 43.8.0 -m ${checkout.stage} --build-from-source`,
      `stage-tool ${tool} prune ${checkout.stage}`,
    ])
  })

  it('stops before the packaged graph check and signing when the locale prune does not confirm (#292)', () => {
    const checkout = fakeCheckout(MANIFEST_ONLY_STAGE_TOOL)
    const result = checkout.run({ VERIFY_CONFIRMS: '1' })
    const tool = join(checkout.repo, 'scripts', 'package-app-stage.mjs')
    const app = join(checkout.repo, 'out', 'Agent Inbox-darwin-arm64', 'Agent Inbox.app')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`package-app: locale pruning did not confirm ${app}`)
    expect(checkout.calls().slice(-3)).toEqual([
      `stage-tool ${tool} verify ${join(checkout.repo, 'package-lock.json')} ${checkout.stage} --label staged`,
      `npx cwd=${checkout.repo} --yes @electron/packager ${checkout.stage} Agent Inbox --platform=darwin --arch=arm64 `
        + `--out=${join(checkout.repo, 'out')} --overwrite --no-asar --no-junk --no-prune `
        + `--icon=${join(checkout.repo, 'electron', 'icon.icns')} --app-bundle-id=io.github.shariqh.agent-inbox`,
      `stage-tool ${tool} locales ${app}`,
    ])
  })

  it('stops before staging when the checkout has no lockfile-pinned electron-rebuild', () => {
    const checkout = fakeCheckout(MANIFEST_ONLY_STAGE_TOOL, { pinnedRebuild: false })
    const result = checkout.run()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      `package-app: ${join(checkout.repo, 'node_modules', '.bin', 'electron-rebuild')} is missing; run npm ci in the checkout first`,
    )
    expect(checkout.calls()).toEqual([])
  })
})

describe('package-app-stage.mjs as a command', () => {
  it('still runs through a symlinked path, failing loudly on a bad tree instead of exiting 0', () => {
    const dir = realpathSync(tmp('stage-cli-link-'))
    const linked = join(dir, 'scripts')
    symlinkSync(join(root, 'scripts'), linked, 'dir')
    const bad = join(dir, 'bad')
    mkdirSync(bad)
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(linked, 'package-app-stage.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 30_000,
    })

    const staged = cli('stage', bad, join(dir, 'stage'))
    expect(staged.status).toBe(1)
    expect(staged.stderr).toContain(`package-app: missing required package input: ${join(bad, 'dist')}`)

    const verified = cli('verify', join(root, 'package-lock.json'), bad)
    expect(verified.status).toBe(1)
    expect(verified.stderr).toContain(`package-app: ${join(bad, 'node_modules', '.package-lock.json')} is missing`)

    const pruned = cli('prune', bad)
    expect(pruned.status).toBe(1)
    expect(pruned.stderr).toContain(`package-app: ${join(bad, 'node_modules')} is missing; nothing was installed to prune`)
    expect(pruned.stdout).toBe('')

    const locales = cli('locales', bad)
    expect(locales.status).toBe(1)
    expect(locales.stderr).toContain(
      'package-app: packaged darwin app has no Contents/Resources/en.lproj, the US English locale Chromium falls back to',
    )
    expect(locales.stdout).toBe('')
  })

  it('keeps only the US and British English Electron locales in a packaged bundle and says how much went (#292)', () => {
    const app = join(realpathSync(tmp('stage-cli-locales-')), 'Agent Inbox.app')
    const framework = join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
    for (const locale of ['en', 'en_GB', 'fr', 'zh_TW']) {
      mkdirSync(join(app, 'Contents', 'Resources', `${locale}.lproj`), { recursive: true })
      mkdirSync(join(framework, `${locale}.lproj`), { recursive: true })
      writeFileSync(join(framework, `${locale}.lproj`, 'locale.pak'), 'x'.repeat(250_000))
    }
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'package-app-stage.mjs'), 'locales', app], {
      encoding: 'utf8',
      timeout: 30_000,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(
      `package-app: kept only the US and British English Electron locales in ${app}; removed 4 locales (0.5 MB)\n`,
    )
    expect(readdirSync(framework)).toEqual(['en.lproj', 'en_GB.lproj'])
    expect(readdirSync(join(app, 'Contents', 'Resources'))).toEqual(['en.lproj', 'en_GB.lproj'])
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
    // Physical paths, as package-app.sh's `pwd -P` root provides: npm treats a
    // --prefix whose real path differs (macOS /var -> /private/var) as a linked root.
    const work = realpathSync(tmp('stage-npm-'))
    const tarballs = join(work, 'tgz')
    mkdirSync(tarballs)
    for (const name of ['prod-dep', 'dev-dep']) {
      const source = join(work, 'src', name)
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
      writeFileSync(join(source, 'index.d.ts'), 'export {}\n')
      writeFileSync(join(source, 'README.md'), `# ${name}\n`)
      writeFileSync(join(source, 'LICENSE'), 'MIT\n')
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

    npm(stage, 'ci', '--prefix', stage, '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund', '--offline')

    expect(existsSync(join(stage, 'node_modules', 'prod-dep', 'package.json'))).toBe(true)
    expect(existsSync(join(stage, 'node_modules', 'dev-dep'))).toBe(false)
    // pruned as package-app.sh prunes it (#291), and still exactly the locked graph
    const pruned = spawnSync(process.execPath, [join(root, 'scripts', 'package-app-stage.mjs'), 'prune', stage], {
      encoding: 'utf8', timeout: 30_000,
    })
    expect(pruned.status, pruned.stderr).toBe(0)
    expect(pruned.stdout).toBe(`package-app: pruned 2 files (0.0 MB) nothing loads from ${join(stage, 'node_modules')}\n`)
    expect(readdirSync(join(stage, 'node_modules', 'prod-dep')).sort()).toEqual(['LICENSE', 'package.json'])
    expect(verifyStagedLockGraph({ lockPath: join(repo, 'package-lock.json'), appRoot: stage })).toEqual({
      packages: 1,
      omittedDev: 1,
      optionalAbsent: [],
    })
    const command = spawnSync(process.execPath, [
      join(root, 'scripts', 'package-app-stage.mjs'), 'verify', join(repo, 'package-lock.json'), stage, '--label', 'staged',
    ], { encoding: 'utf8', timeout: 30_000 })
    expect(command.status).toBe(0)
    // package-app.sh will not continue without exactly this confirmation.
    expect(command.stdout).toMatch(/^package-app: staged dependency graph matches package-lock\.json: /)
  }, 60_000)
})
