#!/usr/bin/env node
// #87 installer spike (CI only): turn the evidence the installers job collected
// into the job summary's comparison table and one combined JSON report.
// --assert-msi fails the job unless the MSI, the candidate the spike tests, met
// every requirement the decision record relies on; Squirrel results are recorded.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const { values } = parseArgs({
  options: {
    evidence: { type: 'string' },
    summary: { type: 'string' },
    out: { type: 'string' },
    'assert-msi': { type: 'boolean', default: false },
  },
})
if (!values.evidence || !values.out) throw new Error('usage: summary.mjs --evidence <dir> --out <json> [--summary <md>] [--assert-msi]')
const evidence = resolve(values.evidence)
const load = (...parts) => {
  const path = join(evidence, ...parts)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : null
}
const tools = JSON.parse(readFileSync(join(here, 'tools.json'), 'utf8'))
const data = {
  tools,
  folders: load('folders.json'),
  wix: load('reports', 'wix-tool.json'),
  signatures: load('reports', 'signatures.json'),
  builds: {
    msi: { base: load('builds', 'msi', 'base.json'), upgrade: load('builds', 'msi', 'upgrade.json') },
    squirrel: { base: load('builds', 'squirrel', 'base.json'), upgrade: load('builds', 'squirrel', 'upgrade.json') },
  },
  results: { msi: load('results', 'msi.json'), squirrel: load('results', 'squirrel.json') },
}

const MiB = (bytes) => (typeof bytes === 'number' ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : 'not measured')
const code = (text) => `\`${String(text).replace(/`/g, "'")}\``
const cell = (text) => String(text ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
const ok = (value) => (value === true ? '✅' : value === false ? '❌' : '❔')
const step = (kind, suffix) => {
  const steps = data.results[kind]?.steps ?? {}
  const name = Object.keys(steps).find((key) => key.replace(/^\d+-/, '') === suffix)
  return name ? { name, ...steps[name] } : null
}
const check = (kind, suffix) => {
  const checks = data.results[kind]?.checks ?? {}
  const name = Object.keys(checks).find((key) => key === suffix)
  return name ? checks[name] : null
}
const runText = (entry) => {
  if (!entry) return 'not run'
  if (entry.error) return `error: ${entry.error}`
  if (!entry.run) return `done in ${entry.seconds}s`
  return `exit ${entry.run.exitCode} in ${entry.run.seconds}s${entry.run.timedOut ? ' (timed out)' : ''}`
}
const treeText = (entry) => {
  if (!entry) return 'not measured'
  if (!entry.installed) return '❌ nothing installed'
  const compare = entry.compare ?? {}
  const parts = ['added', 'changed', 'missing']
    .filter((key) => compare[key]?.count)
    .map((key) => `${key} ${compare[key].count}: ${compare[key].first.slice(0, 3).join(', ')}`)
  return `${ok(entry.matchesVerified)} ${parts.join('; ')}`.trim()
}
const shortcutText = (shortcuts) => {
  if (!shortcuts?.length) return 'none'
  return shortcuts.map((link) => `${link.path} → ${link.target}`).join('<br>')
}
const appIdText = (state) => (state?.appsFolder ?? []).map((entry) => entry.error ?? `${entry.name}: ${entry.appId}`).join('<br>') || 'not listed'
const launchText = (entry) => {
  if (!entry) return 'not run'
  if (entry.error) return `❌ ${entry.error}`
  const launch = entry.launch ?? {}
  const quit = entry.quit ?? {}
  return `${ok(launch.ready)} ready in ${launch.readySeconds}s from ${launch.via}; main process ${launch.mainProcess?.path ?? 'not found'}; ` +
    `quit by ${quit.method} (${quit.graceful ? 'graceful' : 'forced'}), port ${quit.portReleased ? 'released' : 'still bound'}`
}
const appsDuring = (entry) => (entry?.run?.appProcessesSeen ?? [])
  .map((process) => `${process.path?.split('\\').slice(-2).join('\\') ?? '?'} ${process.args ?? ''}`.trim())
const leftovers = (kind, suffix) => {
  const before = step(kind, 'baseline')?.snapshot
  const after = step(kind, suffix)?.snapshot
  if (!before || !after) return null
  const product = /agent.?inbox|squirrel|electron|^programs$/i
  const labels = {
    profile: '%USERPROFILE%', localAppData: '%LOCALAPPDATA%', localPrograms: '%LOCALAPPDATA%\\Programs',
    roamingAppData: '%APPDATA%', startMenu: 'Start Menu', desktop: 'Desktop', hkcuSoftware: 'HKCU\\Software',
    hkcuClsid: 'HKCU\\Software\\Classes\\CLSID', hkcuUninstall: 'HKCU\\…\\Uninstall', hkcuInstallerProducts: 'HKCU\\Software\\Microsoft\\Installer\\Products',
  }
  const all = []
  const relevant = []
  for (const [key, label] of Object.entries(labels)) {
    const previous = new Set(before[key] ?? [])
    for (const name of after[key] ?? []) {
      if (previous.has(name)) continue
      all.push(`${label}\\${name}`)
      if (['hkcuClsid', 'hkcuUninstall', 'hkcuInstallerProducts'].includes(key) || product.test(name)) relevant.push(`${label}\\${name}`)
    }
  }
  return { all, relevant }
}

function measure(kind) {
  const result = data.results[kind]
  const build = data.builds[kind]
  if (!result && !build.base) return null
  const install = step(kind, 'install-base')
  const shortcutStep = kind === 'squirrel' ? step(kind, 'shortcut-like-squirrel-startup') : install
  const upgradeRunning = step(kind, 'upgrade-while-running')
  const upgrade = step(kind, 'upgrade')
  const uninstall = step(kind, 'uninstall')
  const installCheck = check(kind, 'install-base')
  const deepest = installCheck?.deepestPath
  const leftover = leftovers(kind, 'uninstall')
  return {
    kind,
    failure: result?.failure ?? (result ? null : 'lifecycle did not run'),
    installerBytes: kind === 'msi' ? build.base?.msi?.bytes : build.base?.setup?.bytes,
    packageBytes: kind === 'squirrel' ? build.base?.nupkg?.bytes : null,
    buildSeconds: build.base?.seconds,
    install,
    installCheck,
    deepest,
    shortcutStep,
    launchBase: step(kind, 'launch-base'),
    upgradeRunning,
    upgradeRunningCheck: check(kind, 'upgrade-while-running'),
    upgrade,
    upgradeCheck: check(kind, 'upgrade'),
    launchUpgrade: step(kind, 'launch-upgrade'),
    repairWithSource: step(kind, 'repair-with-source'),
    repairWithSourceCheck: check(kind, 'repair-with-source'),
    repairWithoutSource: step(kind, 'repair-without-source'),
    repairWithoutSourceCheck: check(kind, 'repair-without-source'),
    uninstall,
    leftover,
    update: step(kind, 'update-with-update-exe'),
    updateCheck: check(kind, 'update-with-update-exe'),
    launchAfterUpdate: step(kind, 'launch-after-update'),
    finalUninstall: step(kind, 'uninstall-after-update'),
    finalLeftover: leftovers(kind, 'uninstall-after-update'),
  }
}
const msi = measure('msi')
const squirrel = measure('squirrel')

const unsignedFolder = (data.signatures?.folder ?? []).filter((entry) => entry.status !== 'Valid')
const signedFolder = (data.signatures?.folder ?? []).filter((entry) => entry.status === 'Valid')
const rows = []
const row = (label, msiText, squirrelText) => rows.push(`| ${cell(label)} | ${cell(msiText)} | ${cell(squirrelText)} |`)

row('Installer size',
  `${MiB(msi?.installerBytes)} (.msi, LZX high)`,
  `${MiB(squirrel?.installerBytes)} (Setup.exe) + ${MiB(squirrel?.packageBytes)} full .nupkg for Squirrel's updater`)
row('Build time (base)', `${msi?.buildSeconds ?? '—'} s`, `${squirrel?.buildSeconds ?? '—'} s`)
row('Silent install as a standard user',
  `${ok(msi?.install?.run?.exitCode === 0 && msi?.install?.user?.isAdministrator === false)} ${runText(msi?.install)}; ${msi?.install?.user?.integrity ?? ''}`,
  `${ok(squirrel?.install?.run?.exitCode === 0 && squirrel?.install?.user?.isAdministrator === false)} ${runText(squirrel?.install)}; ${squirrel?.install?.user?.integrity ?? ''}`)
row('App started by the installer itself',
  appsDuring(msi?.install).join('<br>') || 'none',
  appsDuring(squirrel?.install).join('<br>') || 'none')
row('Install location', msi?.install?.state?.appDirectory, squirrel?.install?.state?.appDirectory)
row('Installed tree = verified folder', treeText(msi?.installCheck), treeText(squirrel?.installCheck))
row('Disk footprint after install',
  `${MiB(msi?.installCheck?.footprint?.bytes)} in ${msi?.installCheck?.footprint?.root ?? '—'}`,
  `${MiB(squirrel?.installCheck?.footprint?.bytes)} in ${squirrel?.installCheck?.footprint?.root ?? '—'}`)
const deepestText = (deepest) => deepest
  ? `${deepest.fullLength} chars with a ${deepest.userNameLength}-char user name; fits MAX_PATH for user names up to ${deepest.maxUserNameLength} chars (${deepest.relative})`
  : 'not measured'
row('Deepest installed path', deepestText(msi?.deepest), deepestText(squirrel?.deepest))
row('Start-menu shortcut after install',
  shortcutText(msi?.install?.state?.startMenuShortcuts),
  `from Setup.exe: ${shortcutText(squirrel?.install?.state?.startMenuShortcuts)}<br>after \`Update.exe --createShortcut\` (what electron-squirrel-startup runs): ${shortcutText(squirrel?.shortcutStep?.state?.startMenuShortcuts)}`)
const ids = (entry, field) => (entry?.state?.startMenuShortcuts ?? []).map((link) => link[field] ?? 'not set').join('<br>') || '—'
row('Shortcut AppUserModelID', ids(msi?.shortcutStep, 'appUserModelId'), ids(squirrel?.shortcutStep, 'appUserModelId'))
row('Shortcut ToastActivatorCLSID', ids(msi?.shortcutStep, 'toastActivatorClsid'), ids(squirrel?.shortcutStep, 'toastActivatorClsid'))
row('Start apps list (shell:AppsFolder)', appIdText(msi?.shortcutStep?.state), appIdText(squirrel?.shortcutStep?.state))
row('Toast activator COM registration',
  msi?.install?.state?.toastActivatorServer ? `MSI-owned: LocalServer32 = ${Object.values(msi.install.state.toastActivatorServer)[0]}` : 'none',
  squirrel?.shortcutStep?.state?.toastActivatorServer ? 'present' : 'none at install (Electron writes one at its first notification)')
row('Launch from the shortcut, then quit', launchText(msi?.launchBase), launchText(squirrel?.launchBase))
const upgradeRunningText = (entry, measured) => entry
  ? `${runText(entry)}; app ${entry.launch?.ready ? 'was running' : 'was not running'}; after: ${(entry.processesAfterRun ?? []).filter((p) => p.main).map((p) => p.path?.split('\\').slice(-2).join('\\')).join(', ') || 'no app process'}; tree ${treeText(measured)}`
  : 'not run'
row('Upgrade while the app is running', upgradeRunningText(msi?.upgradeRunning, msi?.upgradeRunningCheck), upgradeRunningText(squirrel?.upgradeRunning, squirrel?.upgradeRunningCheck))
const upgradeText = (entry, measured, running) => {
  if (!entry) return running && !running.error ? 'not needed: the upgrade while running succeeded' : 'not run'
  return `${runText(entry)}; location ${entry.state?.appDirectory ?? '—'}; tree ${treeText(measured)}`
}
row('Upgrade with the app closed',
  upgradeText(msi?.upgrade, msi?.upgradeCheck, msi?.upgradeRunning),
  upgradeText(squirrel?.upgrade, squirrel?.upgradeCheck, squirrel?.upgradeRunning))
const finalUpgrade = (entry) => entry?.upgrade ?? entry?.upgradeRunning
row('Install location after upgrade', finalUpgrade(msi)?.state?.appDirectory, finalUpgrade(squirrel)?.state?.appDirectory)
const arp = (state) => [...(state?.uninstallEntries ?? []).map((entry) => `${entry.hive} ${entry.displayName} ${entry.displayVersion}`),
  ...(state?.msiProducts ?? []).map((entry) => entry.error ?? `MSI ${entry.productCode} ${entry.version} (cached package ${MiB(entry.localPackageBytes)})`)].join('<br>') || 'none'
row('Installed-apps entries after upgrade', arp(finalUpgrade(msi)?.state), arp(finalUpgrade(squirrel)?.state))
row('Launch after upgrade', launchText(msi?.launchUpgrade), launchText(squirrel?.launchUpgrade))
const repairText = (entry, measured) => entry
  ? `${runText(entry)}; deleted ${entry.deleted?.join(', ')}; restored ${Object.entries(entry.restored ?? {}).map(([file, back]) => `${file} ${ok(back)}`).join(', ')}; tree ${treeText(measured)}`
  : 'not run'
row('Repair, installer source present', repairText(msi?.repairWithSource, msi?.repairWithSourceCheck), 'no repair: re-running Setup.exe deletes and reinstalls the app')
row('Repair, installer source deleted', repairText(msi?.repairWithoutSource, msi?.repairWithoutSourceCheck), 'no repair')
const uninstallText = (entry) => entry
  ? `${runText(entry)}; app folder ${entry.state?.appDirectory ? 'still present' : 'removed'}; Start-menu shortcuts left: ${entry.state?.startMenuShortcuts?.length ?? '—'}; app started during uninstall: ${appsDuring(entry).join(', ') || 'no'}`
  : 'not run'
row('Uninstall', uninstallText(msi?.uninstall), uninstallText(squirrel?.uninstall))
const keepsData = (entry) => entry ? `${ok(entry.sentinelSurvived && entry.inboxDatabaseSurvived)} sentinel ${ok(entry.sentinelSurvived)}, inbox.db ${ok(entry.inboxDatabaseSurvived)}` : 'not run'
row('%USERPROFILE%\\.agent-inbox survives uninstall', keepsData(msi?.uninstall), keepsData(squirrel?.uninstall))
row('Product leftovers after uninstall', msi?.leftover?.relevant.join('<br>') || (msi?.leftover ? 'none' : '—'), squirrel?.leftover?.relevant.join('<br>') || (squirrel?.leftover ? 'none' : '—'))
row("Squirrel's own updater (Update.exe --update)", '—',
  squirrel?.update ? `${runText(squirrel.update)}; app folders: ${(squirrel.update.state?.squirrelRoot ?? []).filter((name) => name.startsWith('app-')).join(', ')}; tree ${treeText(squirrel.updateCheck)}; next launch ${launchText(squirrel.launchAfterUpdate)}` : 'not run')
row('Signing surface (this build)',
  `${unsignedFolder.length} unsigned PE files in the folder, then the .msi last (${signedFolder.length} PE files already carry third-party signatures); MSI status: ${data.signatures?.msi?.status ?? '—'}`,
  `${unsignedFolder.length} unsigned folder PE files + ${(data.signatures?.squirrelAdded ?? []).map((entry) => `${entry.path} (${entry.status})`).join(', ') || '—'} + Setup.exe (${data.signatures?.squirrelSetup?.status ?? '—'}), signed inside Squirrel's releasify via signtool parameters`)
row('ICE validation', Object.entries(data.builds.msi.base?.ice?.counts ?? {}).map(([key, count]) => `${key} ×${count}`).join(', ') || `exit ${data.builds.msi.base?.ice?.exitCode ?? '—'}`, '—')
row('Files a default build would drop', '—', (data.builds.squirrel.base?.defaultTemplateDrops ?? []).join(', ') || 'none')

const toolRows = [
  `| WiX .NET tool | ${cell(data.wix?.reportedVersion ?? tools.wix.version)} | nupkg SHA-512 ${code(tools.wix.sha512)} (nuget.org catalog packageHash), SHA-256 ${code(tools.wix.sha256)} | ${data.wix ? 'downloaded from its exact URL, both digests checked, installed from a private feed holding only that file' : 'not installed'} |`,
  `| .NET runtime for WiX | ${cell((data.wix?.dotnetRuntimes ?? []).join(', ') || '—')} | runner image | recorded |`,
  `| electron-winstaller | ${cell(data.builds.squirrel.base?.electronWinstaller ?? tools.squirrel.version)} | lockfile integrity ${code(tools.squirrel.integrity)} | npm ci --ignore-scripts from .github/windows-installer-spike/package-lock.json |`,
  ...Object.entries(data.builds.squirrel.base?.vendor ?? {}).map(([name, digest]) => `| vendored ${cell(name)} | (inside electron-winstaller) | SHA-256 ${code(digest)} | pinned by the npm integrity above |`),
]
const folders = data.folders
const lines = [
  '## Windows installer spike (#87, PR 2a)',
  '',
  'Unsigned CI evidence only. Nothing here is signed, published or released. Every installer action ran as a fresh, disposable standard (non-administrator) user.',
  '',
  folders
    ? `Inputs: verified folder **${folders.base.version}** (${folders.base.files} files, ${MiB(folders.base.bytes)}, ${code(folders.base.appTreeDigest)}) and the same commit rebuilt as **${folders.upgrade.version}** (${code(folders.upgrade.appTreeDigest)}).`
    : 'Inputs: the verified folders were not restored.',
  '',
  '### Pinned tools',
  '',
  '| Tool | Version | Pin | Verified |',
  '| --- | --- | --- | --- |',
  ...toolRows,
  '',
  '### Measured comparison',
  '',
  '| Measurement | MSI (WiX, per-user) | Squirrel.Windows (electron-winstaller) |',
  '| --- | --- | --- |',
  ...rows,
  '',
]
for (const entry of [msi, squirrel]) {
  if (entry?.failure) lines.push(`> **${entry.kind} lifecycle stopped:** ${cell(entry.failure)}`, '')
}
for (const kind of ['msi', 'squirrel']) {
  const steps = data.results[kind]?.steps ?? {}
  lines.push(`<details><summary>${kind} step log</summary>`, '', '| Step | Result | App folder |', '| --- | --- | --- |')
  for (const [name, entry] of Object.entries(steps)) lines.push(`| ${cell(name)} | ${cell(runText(entry))} | ${cell(entry.state?.appDirectory)} |`)
  lines.push('', '</details>', '')
}

const assertions = []
if (values['assert-msi']) {
  const require = (label, value) => assertions.push({ label, passed: value === true })
  const finalMsi = msi?.upgradeCheck ?? msi?.upgradeRunningCheck
  const finalMsiStep = msi?.upgrade ?? msi?.upgradeRunning
  const expectedDirectory = `%USERPROFILE%\\AppData\\Local\\Programs\\${tools.identity.productName}`
  const shortcut = msi?.install?.state?.startMenuShortcuts?.[0]
  require('MSI lifecycle ran to the end', msi?.failure === null)
  require('MSI installs silently as a standard user', msi?.install?.run?.exitCode === 0 && msi?.install?.user?.isAdministrator === false)
  require('MSI installs to %LOCALAPPDATA%\\Programs\\Agent Inbox', msi?.install?.state?.appDirectory === expectedDirectory)
  require('MSI installs exactly the verified base tree', msi?.installCheck?.matchesVerified)
  require('MSI shortcut carries the AppUserModelID and toast CLSID',
    msi?.install?.state?.startMenuShortcuts?.length === 1 &&
    shortcut?.appUserModelId === tools.identity.appUserModelId &&
    shortcut?.toastActivatorClsid === tools.identity.toastActivatorClsid)
  require('MSI-installed app launches from its shortcut', msi?.launchBase?.launch?.ready)
  require('MSI upgrade installs exactly the verified upgrade tree in the same folder',
    finalMsiStep?.run?.exitCode === 0 && finalMsi?.matchesVerified === true && finalMsiStep?.state?.appDirectory === expectedDirectory)
  require('MSI upgrade leaves one product at the upgrade version',
    finalMsiStep?.state?.msiProducts?.length === 1 && finalMsiStep.state.msiProducts[0].version === folders?.upgrade?.version)
  require('MSI-upgraded app launches', msi?.launchUpgrade?.launch?.ready)
  require('MSI repair restores deleted files', msi?.repairWithSource?.run?.exitCode === 0 && msi?.repairWithSourceCheck?.matchesVerified)
  require('MSI uninstall removes the app and its shortcut',
    msi?.uninstall?.run?.exitCode === 0 && !msi.uninstall.state?.appDirectory && msi.uninstall.state?.msiRoot === null &&
    msi.uninstall.state?.startMenuShortcuts?.length === 0 && msi.uninstall.state?.msiProducts?.length === 0)
  require('MSI uninstall keeps %USERPROFILE%\\.agent-inbox', msi?.uninstall?.sentinelSurvived && msi?.uninstall?.inboxDatabaseSurvived)
  require('Squirrel lifecycle ran to the end', squirrel?.failure === null)
  lines.push('### Requirements the recommendation relies on', '', ...assertions.map((entry) => `- ${ok(entry.passed)} ${entry.label}`), '')
}

const markdown = `${lines.join('\n')}\n`
if (values.summary) appendFileSync(values.summary, markdown)
writeFileSync(resolve(values.out), `${JSON.stringify({ schema: 1, ...data, measured: { msi, squirrel }, assertions }, null, 2)}\n`)
process.stdout.write(markdown)
const failed = assertions.filter((entry) => !entry.passed)
if (failed.length) {
  process.stderr.write(`summary: ${failed.length} requirement(s) failed: ${failed.map((entry) => entry.label).join('; ')}\n`)
  process.exitCode = 1
}
