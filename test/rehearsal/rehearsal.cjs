'use strict'

// Rehearses 1.x-last's Intel and Rosetta update path before 2.0.0 is tagged (#344; update
// manifest v2 design §8.5 and §4.3, step 6). After 2.0.0 that path can't be patched, so this
// runs 1.x-last's own updater code, loaded from the installed app, under the app's own
// Electron in Node mode, against scratch-signed manifests. It adds nothing to the app.
// docs/macos-release.md has the instructions; in short, from a checkout of this repository:
//
//   ELECTRON_RUN_AS_NODE=1 "/Applications/Agent Inbox.app/Contents/MacOS/Agent Inbox" \
//     test/rehearsal/rehearsal.cjs --run 2,3 --work ~/Rehearsal/work
//
// with `arch -x86_64` before the app's path on an Apple silicon Mac, to run it under Rosetta.

const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseArgs } = require('node:util')

const { MAIN_PINS, pinFailures } = require('./main-pins.cjs')
const { RESTAMPED_FIELDS, nextPatch, prepareManifests, restampDifferences } = require('./manifests.cjs')
const {
  EXPECTED_BUNDLE_ID,
  RELEASE_DOWNLOADS,
  TEAM_ID,
  codesignVerifies,
  createLatest,
  createReport,
  infoPlist,
  runBadV1,
  runInstall,
  runOnLast,
  verifyInstall,
} = require('./runs.cjs')

// 1.x-last, the last release for Intel Macs, and where it is installed.
const DEFAULT_LAST = '1.8.0'
const DEFAULT_APP = '/Applications/Agent Inbox.app'

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const LATEST_DOWNLOADS = 'https://github.com/shariqh/agent-inbox/releases/latest/download'
const RELEASES_API = 'https://api.github.com/repos/shariqh/agent-inbox/releases'
const VIEWER_ORIGIN = 'http://127.0.0.1:4319/'
const MANIFEST_MAX_BYTES = 256 * 1024
const SIGNATURE_MAX_BYTES = 16 * 1024
const PIN_GROUPS = Object.freeze([
  ['rosetta', 'passes `translated` and `hostArch`, hides Review release for "apple-silicon" and has the Rosetta notification'],
  ['macInstaller', 'registers the macOS installer with the options run 1 uses'],
  ['recorder', 'records each verified manifest in its own rollback mark'],
  ['downloads', 'hands the signed artifact to a downloader under userData'],
])
const UPDATER_FILES = Object.freeze([
  'update-controller',
  'update-download',
  'update-fetch',
  'update-install',
  'update-install-macos',
  'update-manifest',
  'update-preferences',
])

const USAGE = `Usage (docs/macos-release.md has the full instructions):
  ELECTRON_RUN_AS_NODE=1 [arch -x86_64] "<app>/Contents/MacOS/Agent Inbox" test/rehearsal/rehearsal.cjs --run <run> --work <folder> [options]

Runs:
  --run 2 | 3 | 2,3     2: the app is 1.x-last itself; 3: a bad or stale update-manifest.json
  --run 1 --older-app <app> --test-account
                        install 1.x-last over a scratch copy of an older app; then the app reopens
  --run 1 --verify      after run 1: check the swapped app and the app that opened

Options:
  --work <folder>       scratch userData, downloads and reports (created if missing)
  --app <path>          the installed 1.x-last app (default: ${DEFAULT_APP})
  --last <X.Y.Z>        1.x-last's version (default: ${DEFAULT_LAST})
  --next <X.Y.Z>        the arm64-only release the scratch manifests describe (default: the next major)
  --from <X.Y.Z>        the older version run 3 runs as (default: one step below --last)`

class Refusal extends Error {}

function refuse(message) {
  throw new Refusal(message)
}

function versionParts(version) {
  const match = VERSION_RE.exec(version ?? '')
  return match ? match.slice(1).map(BigInt) : null
}

function compareVersions(left, right) {
  const [a, b] = [versionParts(left), versionParts(right)]
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

function versionOption(values, name, fallback) {
  const value = values[name] ?? fallback
  if (versionParts(value) === null) refuse(`--${name} must be an X.Y.Z version, not ${JSON.stringify(value)}`)
  return value
}

// One release step below `last`: 1.8.0 gives 1.7.0, 1.8.2 gives 1.8.1.
function stepBelow(last) {
  const [major, minor, patch] = versionParts(last)
  if (patch > 0n) return `${major}.${minor}.${patch - 1n}`
  if (minor > 0n) return `${major}.${minor - 1n}.0`
  if (major > 0n) return `${major - 1n}.0.0`
  return refuse(`there is no version below ${last}: pass --from`)
}

function parseOptions(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        run: { type: 'string' },
        work: { type: 'string' },
        app: { type: 'string' },
        last: { type: 'string' },
        next: { type: 'string' },
        from: { type: 'string' },
        'older-app': { type: 'string' },
        'test-account': { type: 'boolean' },
        verify: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    return refuse(error.message)
  }
  const { values } = parsed
  if (values.help) return { help: true }
  const runs = [...new Set((values.run ?? '').split(','))].map(Number).sort()
  if (runs.length === 0 || !runs.every((run) => run === 1 || run === 2 || run === 3)) refuse('--run must be 1, 2, 3 or 2,3')
  if (runs.includes(1) && runs.length > 1) refuse('run 1 ends with the app reopening, so it runs on its own: --run 1')
  if (!values.work) refuse('--work is required: a folder for scratch userData, downloads and reports')
  if (values.verify && runs[0] !== 1) refuse('--verify belongs to run 1')
  const last = versionOption(values, 'last', DEFAULT_LAST)
  const [major] = versionParts(last)
  const next = versionOption(values, 'next', `${major + 1n}.0.0`)
  if (compareVersions(next, last) <= 0) refuse(`--next ${next} must be newer than --last ${last}`)
  const from = versionOption(values, 'from', stepBelow(last))
  if (compareVersions(from, last) >= 0) refuse(`--from ${from} must be older than --last ${last}`)
  return {
    runs,
    work: path.resolve(values.work),
    app: path.resolve(values.app ?? DEFAULT_APP),
    last,
    next,
    from,
    olderApp: values['older-app'],
    testAccount: values['test-account'] === true,
    verify: values.verify === true,
  }
}

function capture(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout.trim() : null
}

// What main.cjs reads from Electron's `app` and `process.getSystemVersion()`, which Node
// mode lacks: whether this process is translated (app.runningUnderARM64Translation) and
// the macOS version.
function hostFacts() {
  const sysctl = (name) => capture('/usr/sbin/sysctl', ['-n', name])
  const translated = sysctl('sysctl.proc_translated') === '1'
  const arm64 = process.arch === 'arm64'
  if (!arm64 && process.arch !== 'x64') refuse(`this process runs as ${process.arch}, which no Mac app build updates`)
  if (arm64 && translated) refuse('an arm64 process reports Rosetta translation; check `sysctl sysctl.proc_translated`')
  const macos = capture('/usr/bin/sw_vers', ['-productVersion'])
  if (macos === null) refuse('`sw_vers -productVersion` did not answer')
  const kind = arm64 ? 'native' : translated ? 'rosetta' : 'intel'
  return Object.freeze({
    arm64,
    translated,
    macos,
    kind,
    label: {
      intel: 'an Intel Mac, x64 process',
      rosetta: 'an Apple silicon Mac under Rosetta, x64 process',
      native: 'an Apple silicon Mac, native arm64 process (a control, not a gate host)',
    }[kind],
    model: sysctl('hw.model'),
    cpu: sysctl('machdep.cpu.brand_string'),
  })
}

// The installed app, and proof that this process is its own Electron in Node mode.
function inspectApp(options) {
  if (process.platform !== 'darwin') refuse('the rehearsal runs on macOS only')
  if (typeof process.versions.electron !== 'string' || process.env.ELECTRON_RUN_AS_NODE !== '1') {
    refuse(`run this with the installed app's own Electron in Node mode:\n  ELECTRON_RUN_AS_NODE=1 "${options.app}/Contents/MacOS/Agent Inbox" ${path.relative(process.cwd(), __filename)} ...`)
  }
  const info = infoPlist(options.app)
  if (info === null) refuse(`no app at ${options.app}: pass --app`)
  if (info.CFBundleIdentifier !== EXPECTED_BUNDLE_ID) refuse(`${options.app} is ${info.CFBundleIdentifier}, not Agent Inbox`)
  if (info.CFBundleShortVersionString !== options.last) {
    refuse(`${options.app} is ${info.CFBundleShortVersionString}, not 1.x-last ${options.last}: install ${options.last}, or pass --last`)
  }
  const executable = path.join(options.app, 'Contents', 'MacOS', info.CFBundleExecutable)
  let same = false
  try {
    same = fs.realpathSync(process.execPath) === fs.realpathSync(executable)
  } catch {
    same = false
  }
  if (!same) refuse(`this process is ${process.execPath}, not ${executable}: run the harness with the app's own Electron`)
  return Object.freeze({ path: fs.realpathSync(options.app), version: info.CFBundleShortVersionString })
}

function loadModules(appPath) {
  const directory = path.join(appPath, 'Contents', 'Resources', 'app', 'electron')
  const load = (name) => require(path.join(directory, `${name}.cjs`))
  return Object.freeze({
    directory,
    controller: load('update-controller'),
    download: load('update-download'),
    fetch: load('update-fetch'),
    install: load('update-install'),
    installMacos: load('update-install-macos'),
    manifest: load('update-manifest'),
    preferences: load('update-preferences'),
  })
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// The checkout's commit, read without running git (on a Mac without the Command Line Tools,
// /usr/bin/git only offers to install them).
function checkoutCommit() {
  try {
    let gitDir = path.join(REPO_ROOT, '.git')
    if (fs.statSync(gitDir).isFile()) {
      gitDir = path.resolve(REPO_ROOT, /^gitdir: (.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'))[1].trim())
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/.test(head)) return head
    const ref = /^ref: (\S+)$/.exec(head)?.[1]
    if (!ref) return null
    const commonFile = path.join(gitDir, 'commondir')
    const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir
    for (const directory of [gitDir, common]) {
      const file = path.join(directory, ref)
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
    }
    const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8')
    return packed.split('\n').find((line) => line.endsWith(` ${ref}`))?.slice(0, 40) ?? null
  } catch {
    return null
  }
}

async function download(url, cap) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > cap) throw new Error(`${url} is larger than ${cap} bytes`)
  return bytes
}

// GitHub's release listing, trimmed to what restampV1 reads.
async function releaseListing() {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agent-inbox-rehearsal' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const releases = []
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`${RELEASES_API}?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`GitHub's release listing answered HTTP ${response.status}`)
    const batch = await response.json()
    for (const release of batch) {
      releases.push({
        tag_name: release.tag_name,
        draft: release.draft,
        prerelease: release.prerelease,
        assets: Array.isArray(release.assets)
          ? release.assets.map(({ id, name, size, digest, browser_download_url }) => ({ id, name, size, digest, browser_download_url }))
          : release.assets,
      })
    }
    if (batch.length < 100) return releases
  }
  throw new Error('GitHub lists more than 1000 releases')
}

function preflight(report, { app, modules }) {
  report.heading('Preflight')
  const signature = codesignVerifies(app.path)
  report.check(`the installed ${app.version} app's signature verifies for team ${TEAM_ID}, so its updater files are the release's`, signature.ok, signature.output)
  for (const name of UPDATER_FILES) {
    report.note(`loaded ${name}.cjs  sha256 ${sha256(fs.readFileSync(path.join(modules.directory, `${name}.cjs`))).slice(0, 16)}`)
  }
  const main = fs.readFileSync(path.join(modules.directory, 'main.cjs'), 'utf8')
  for (const [group, description] of PIN_GROUPS) {
    const failures = pinFailures(main, MAIN_PINS[group])
    report.check(`its main.cjs ${description}`, failures.length === 0, failures.join('\n        '))
  }
  const urls = {
    manifest: modules.fetch.MANIFEST_URL,
    signature: modules.fetch.SIGNATURE_URL,
    manifestV2: modules.fetch.MANIFEST_V2_URL,
    signatureV2: modules.fetch.SIGNATURE_V2_URL,
  }
  report.same(
    'it reads the four manifest files from the latest release',
    urls,
    {
      manifest: `${LATEST_DOWNLOADS}/update-manifest.json`,
      signature: `${LATEST_DOWNLOADS}/update-manifest.json.sig`,
      manifestV2: `${LATEST_DOWNLOADS}/update-manifest-v2.json`,
      signatureV2: `${LATEST_DOWNLOADS}/update-manifest-v2.json.sig`,
    },
  )
  return urls
}

async function scratchManifests(report, { app, options, modules }) {
  report.heading('Manifests')
  const releases = await releaseListing()
  const tag = `v${options.last}`
  const listed = releases.find((release) => release.tag_name === tag)
  const published = {
    manifest: await download(`${RELEASE_DOWNLOADS}/${tag}/update-manifest.json`, MANIFEST_MAX_BYTES),
    signature: await download(`${RELEASE_DOWNLOADS}/${tag}/update-manifest.json.sig`, SIGNATURE_MAX_BYTES),
  }
  const asListed = (name, bytes) => {
    const asset = listed?.assets?.find((candidate) => candidate.name === name)
    return asset?.size === bytes.length && (!asset.digest || asset.digest === `sha256:${sha256(bytes)}`)
  }
  report.check(
    `${tag}'s published update-manifest.json and its signature are the files GitHub lists`,
    asListed('update-manifest.json', published.manifest) && asListed('update-manifest.json.sig', published.signature),
    listed ? 'size or SHA-256 differs from the release listing' : `GitHub lists no ${tag} release`,
  )
  const bundledKeys = modules.manifest.parseRegistry(fs.readFileSync(path.join(app.path, 'Contents', 'Resources', 'app', 'release', 'update-keys.json')))
  let lastRelease = null
  try {
    lastRelease = modules.manifest.verifyManifest({ manifestBytes: published.manifest, envelope: published.signature, registry: bundledKeys })
  } catch (error) {
    report.note(error.message)
  }
  report.check(`they verify under the installed app's own keys, as ${tag}`, lastRelease?.tag === tag)
  if (lastRelease === null) return null

  const productionRegistry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'release', 'update-keys.json'), 'utf8'))
  const manifests = await prepareManifests({ published, releases, productionRegistry, next: options.next })
  report.note(`scratch key ${manifests.registry.signingKeyId}, made for this run; both manifests published at ${manifests.publishedAt}`)
  const now = new Date()
  let v2 = null
  let v1 = null
  try {
    v2 = modules.manifest.verifyManifestV2({ manifestBytes: manifests.v2.bytes, envelope: manifests.v2.signature, registry: manifests.registry, now })
    v1 = modules.manifest.verifyManifest({ manifestBytes: manifests.v1.bytes, envelope: manifests.v1.signature, registry: manifests.registry, now })
  } catch (error) {
    report.note(error.message)
  }
  report.same(
    `update-manifest-v2.json verifies with the scratch key and lists v${options.next}'s arm64 DMG and the four Linux packages, nothing else`,
    v2 && v2.targets.map(({ platform, architecture, packageType }) => `${platform}/${architecture}/${packageType}`),
    ['darwin/arm64/dmg', 'linux/arm64/appimage', 'linux/arm64/deb', 'linux/x64/appimage', 'linux/x64/deb'],
  )
  report.same(
    `update-manifest.json re-stamps ${tag}'s, changing only ${RESTAMPED_FIELDS.join(', ')}`,
    restampDifferences(published.manifest, manifests.v1.bytes),
    [...RESTAMPED_FIELDS],
  )
  const lastDmg = lastRelease.targets.find((target) => target.platform === 'darwin')
  report.same(
    `it verifies with the scratch key and names the real, notarized ${lastDmg.filename}`,
    v1?.targets.find((target) => target.platform === 'darwin'),
    lastDmg,
  )
  return { manifests, lastDmg }
}

async function viewerAnswers() {
  try {
    await fetch(VIEWER_ORIGIN, { redirect: 'manual', signal: AbortSignal.timeout(1_500) })
    return true
  } catch (error) {
    return error?.name === 'TimeoutError'
  }
}

// Run 1 replaces --older-app and opens it in this account, so it must be a scratch copy of
// an older Agent Inbox in this user's home folder, never an installed app.
async function olderAppFor(options, app, host) {
  if (host.arm64) {
    refuse('run 1 installs through the Intel path, which needs an x64 process: run it on an Intel Mac, or with arch -x86_64 on Apple silicon')
  }
  if (!options.testAccount) {
    refuse('run 1 installs 1.x-last and opens it in this user account, which then uses its ~/.agent-inbox: run it in a test account and pass --test-account')
  }
  if (!options.olderApp) refuse('run 1 needs --older-app: a scratch copy of an older Agent Inbox.app (docs/macos-release.md)')
  const input = path.resolve(options.olderApp)
  let stat
  try {
    stat = fs.lstatSync(input)
  } catch {
    return refuse(`--older-app ${input} does not exist`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !input.endsWith('.app')) refuse(`--older-app must be an app folder, not a link: ${input}`)
  const olderApp = fs.realpathSync(input)
  const home = fs.realpathSync(os.userInfo().homedir)
  if (!olderApp.startsWith(`${home}/`)) refuse(`--older-app must be inside your home folder, ${home}: run 1 replaces it`)
  if (olderApp === app.path || olderApp.startsWith('/Applications/')) refuse('--older-app must be a scratch copy, never an installed app')
  if (stat.uid !== process.getuid()) refuse('--older-app must belong to this user')
  const info = infoPlist(olderApp)
  if (info?.CFBundleIdentifier !== EXPECTED_BUNDLE_ID) refuse(`--older-app ${olderApp} is not Agent Inbox`)
  const olderVersion = info.CFBundleShortVersionString
  if (versionParts(olderVersion) === null || compareVersions(olderVersion, options.last) >= 0) {
    refuse(`--older-app is ${olderVersion}, which is not older than ${options.last}: make a fresh copy of an older release`)
  }
  if (await viewerAnswers()) {
    refuse(`an Agent Inbox viewer already answers on ${VIEWER_ORIGIN}: quit Agent Inbox in every account on this Mac, because the reopened app would use it`)
  }
  return { olderApp, olderVersion }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

async function main(argv) {
  const lines = []
  const write = (line) => {
    lines.push(line)
    process.stdout.write(`${line}\n`)
  }
  const report = createReport(write)
  let options
  let host
  let reportPath = null
  let exitCode = 0
  try {
    options = parseOptions(argv)
    if (options.help) {
      write(USAGE)
      return 0
    }
    const app = inspectApp(options)
    host = hostFacts()
    if (options.work === app.path || options.work.startsWith(`${app.path}/`)) refuse('--work must be outside the installed app')
    fs.mkdirSync(options.work, { recursive: true, mode: 0o700 })
    const stamp = timestamp()
    reportPath = path.join(options.work, `report-${stamp}.txt`)
    const modules = loadModules(app.path)
    const commit = checkoutCommit()
    write(`Rehearsal of 1.x-last's update path (#344), ${new Date().toISOString()}`)
    write(`1.x-last: ${app.version}, ${app.path} (Electron ${process.versions.electron}, Node ${process.version})`)
    write(`Host: ${host.label}; ${host.model ?? 'unknown model'}, ${host.cpu ?? 'unknown CPU'}, macOS ${host.macos}`)
    write(`Harness: ${commit ?? 'unknown commit'}; work folder ${options.work}`)
    const handoffPath = path.join(options.work, 'run-1.json')

    if (options.runs[0] === 1 && options.verify) {
      let handoff
      try {
        handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'))
      } catch {
        refuse(`no run 1 to verify in ${options.work}: run --run 1 first`)
      }
      report.heading(`Run 1, after the restart: ${handoff.from} to ${handoff.to}`)
      report.beginRun('Run 1 --verify')
      await verifyInstall({ report, modules }, handoff)
      return summarize(report, host)
    }

    const older = options.runs[0] === 1 ? await olderAppFor(options, app, host) : null
    if (older) write(`Run 1 replaces ${older.olderApp} (${older.olderVersion}) and opens it in this account.`)
    const urls = preflight(report, { app, modules })
    if (report.totals.fail > 0) return summarize(report, host, 'Preflight failed: no run started.')
    const prepared = await scratchManifests(report, { app, options, modules })
    if (prepared === null || report.totals.fail > 0) return summarize(report, host, 'The scratch manifests are not right: no run started.')

    const latest = createLatest({ urls, scratchRelease: `${RELEASE_DOWNLOADS}/v${options.next}/`, fetchImpl: fetch })
    const context = (name) => ({
      report,
      host,
      modules,
      urls,
      latest,
      manifests: prepared.manifests,
      lastDmg: prepared.lastDmg,
      last: options.last,
      next: options.next,
      from: options.from,
      markAbove: nextPatch(options.last),
      runDir: fs.mkdtempSync(path.join(options.work, `${name}-${stamp}-`)),
    })
    if (older) {
      report.heading(`Run 1: ${older.olderVersion}, older than 1.x-last, installs ${options.last}`)
      report.beginRun('Run 1')
      const handoff = await runInstall(context('run-1'), older)
      if (handoff !== null) {
        fs.writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`)
        report.note(`The helper waits for this process (${process.pid}) to exit, swaps ${older.olderApp} and opens it.`)
        report.note('Once the app has opened, run the same command with --run 1 --verify (no --older-app needed).')
      }
      return summarize(report, host)
    }
    for (const run of options.runs) {
      if (run === 2) {
        report.heading(`Run 2: on ${options.last}, which Intel Macs stay on`)
        report.beginRun('Run 2')
        await runOnLast(context('run-2'))
      } else {
        report.heading(`Run 3: a bad or stale update-manifest.json, on ${options.from}`)
        report.beginRun('Run 3')
        await runBadV1(context('run-3'))
      }
    }
    return summarize(report, host)
  } catch (error) {
    if (error instanceof Refusal) {
      write(`REFUSED  ${error.message}`)
      if (options === undefined) write(`\n${USAGE}`)
      exitCode = 2
      return exitCode
    }
    report.check('the rehearsal finished without an unexpected error', false, error?.stack ?? String(error))
    return summarize(report, host)
  } finally {
    if (reportPath !== null) {
      fs.writeFileSync(reportPath, `${lines.join('\n')}\n`)
      process.stdout.write(`\nReport: ${reportPath}\n`)
    }
  }

  function summarize(summaryReport, summaryHost, reason) {
    write('')
    write('Summary')
    if (reason) write(reason)
    for (const run of summaryReport.runs) {
      write(`${run.name}: ${run.fail === 0 ? 'PASS' : 'FAIL'} (${run.pass} passed, ${run.fail} failed)`)
    }
    const passed = summaryReport.totals.fail === 0 && summaryReport.runs.length > 0
    write(`Result: ${passed ? 'PASS' : 'FAIL'} on ${summaryHost?.label ?? 'this host'}`)
    exitCode = passed ? 0 : 1
    return exitCode
  }
}

if (require.main === module) {
  // Exits as soon as stdout is flushed: after run 1 the helper waits for this process.
  main(process.argv.slice(2)).then(
    (code) => process.stdout.write('', () => process.exit(code)),
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`, () => process.exit(1))
    },
  )
}
