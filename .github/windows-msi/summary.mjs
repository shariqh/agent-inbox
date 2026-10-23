#!/usr/bin/env node
// #87 PR 2b, CI only: turn the evidence the MSI job collected into the job summary
// and one combined JSON report, and fail unless every requirement the installer
// must meet held on the runner. requirements() is pure, so a test can break each
// piece of evidence and watch its requirement fail.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const QUIT_LINE = '[agent-inbox] Windows asked the app to close (Restart Manager); quitting'
// Logged only once the quit reaches will-quit: Electron ends the process at once after
// the line above when a before-quit listener holds the quit.
const WILL_QUIT_LINE = '[agent-inbox] Windows asked the app to close (Restart Manager); reached will-quit'
const NOTIFY_LINE = '[agent-inbox] notifying: '

export function loadEvidence(directory, { pins, release }) {
  const load = (...parts) => {
    const path = join(directory, ...parts)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : null
  }
  const builds = { base: load('builds', 'base.json'), upgrade: load('builds', 'upgrade.json'), rebuild: load('builds', 'rebuild.json') }
  const checksumPath = join(directory, 'artifact', 'SHA256SUMS-windows.txt')
  return {
    pins,
    release,
    folders: load('folders.json'),
    tools: load('reports', 'tools.json'),
    builds,
    checksums: existsSync(checksumPath) ? readFileSync(checksumPath, 'utf8') : null,
    lifecycle: load('results', 'msi.json'),
  }
}

// PowerShell writes a one-element list as the element itself; read every list through this.
const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])
const step = (data, suffix) => {
  const steps = data.lifecycle?.steps ?? {}
  const name = Object.keys(steps).find((key) => key.replace(/^\d+-/, '') === suffix)
  return name ? { name, ...steps[name] } : null
}
const check = (data, name) => data.lifecycle?.checks?.[name] ?? null
const finalUpgrade = (data) => step(data, 'upgrade') ?? step(data, 'upgrade-while-running')
const finalUpgradeCheck = (data) => check(data, 'upgrade') ?? check(data, 'upgrade-while-running')
const installedDirectory = (data) => `%USERPROFILE%\\AppData\\Local\\Programs\\${data.release.product}`
const installedExe = (data) => `${installedDirectory(data)}\\${data.release.product}.exe`
const carriesIdentity = (data, link) =>
  link?.appUserModelId === data.release.bundleId && link?.toastActivatorClsid === data.pins.identity.toastActivatorClsid
const onlyShortcut = (data, state) => {
  const links = list(state?.startMenuShortcuts)
  return links.length === 1 &&
    links[0].path === `%USERPROFILE%\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\${data.release.product}.lnk` &&
    links[0].target === installedExe(data) && carriesIdentity(data, links[0])
}
const ranClean = (entry) => entry && !entry.error && entry.user?.isAdministrator === false
const logged = (entry, line) => list(entry?.appLog).some((text) => text.includes(line))
const lineAt = (entry, line) => list(entry?.appLog).findIndex((text) => text.includes(line))
const removedEverything = (entry) => ranClean(entry) && entry.run?.exitCode === 0 && !entry.state?.appDirectory &&
  entry.state?.msiRoot === null && list(entry.state?.startMenuShortcuts).length === 0 &&
  list(entry.state?.msiProducts).length === 0 && list(entry.state?.uninstallEntries).length === 0 &&
  entry.state?.toastActivator === null

/** Whether the app announced a notification in this step at all; the runner's session decides. */
export const notificationAttempted = (entry) => entry?.notification?.seen === true

/** Every requirement, as { label, passed }; the job fails unless all pass. */
export function requirements(data) {
  const out = []
  const require = (label, value) => out.push({ label, passed: value === true })
  const { pins, release } = data
  const resolved = list(data.tools?.dotnet?.resolved)
  const framework = `\\shared\\${pins.dotnet.framework}\\${pins.dotnet.version}`
  const reported = /^(\d+\.\d+\.\d+)\+([0-9a-f]{7,40})$/.exec(data.tools?.wix?.reportedVersion ?? '')
  require(`WiX ${pins.wix.version} ran from its pinned package on .NET ${pins.dotnet.version}`,
    reported?.[1] === pins.wix.version && pins.wix.sourceCommit.startsWith(reported[2] ?? '-') &&
    data.tools?.wix?.sha512 === pins.wix.sha512 && data.tools?.dotnet?.sha512 === pins.dotnet.sha512 &&
    resolved.some((path) => /\\coreclr\.dll$/i.test(path)) &&
    resolved.every((path) => path.toLowerCase().includes(framework.toLowerCase())))
  const base = data.builds.base
  require('The MSI carries the installer identity and passes ICE validation',
    base?.upgradeCode === pins.identity.upgradeCode && base?.productVersion === data.folders?.base?.version &&
    base?.validation?.passed === true && base?.elevationNotRequired === true &&
    list(base?.shortcutProperties).some((entry) => entry.key === 'System.AppUserModel.ID' && entry.value === release.bundleId) &&
    list(base?.shortcutProperties).some((entry) => entry.key === 'System.AppUserModel.ToastActivatorCLSID' &&
      entry.value === pins.identity.toastActivatorClsid))
  require('SHA256SUMS-windows.txt names the MSI and its SHA-256',
    typeof base?.msi?.sha256 === 'string' && data.checksums === `${base.msi.sha256}  ${base.msi.name}\n` &&
    base.msi.name === `Agent-Inbox-v${data.folders?.base?.version}-windows-x64.msi`)
  require('The lifecycle ran to the end', data.lifecycle?.failure === null)
  const install = step(data, 'install-base')
  require('Installs silently as a standard user at medium integrity',
    ranClean(install) && install.run?.exitCode === 0 && /Medium Mandatory Level/.test(install.user?.integrity ?? ''))
  require(`Installs exactly the verified folder to %LOCALAPPDATA%\\Programs\\${release.product}`,
    install?.state?.appDirectory === installedDirectory(data) && check(data, 'install-base')?.matchesVerified === true)
  require('The Start-menu shortcut carries the AppUserModelID and toast activator CLSID', onlyShortcut(data, install?.state))
  require('The MSI registers the toast activator for the installed app',
    install?.state?.toastActivator?.localServer32 === `"${installedExe(data)}"` && install.state.toastActivator.customActivator === '1')
  const launch = step(data, 'launch-base')
  require('Launches from the shortcut and quits when its window closes',
    ranClean(launch) && launch.launch?.ready === true && launch.quit?.method === 'close-window' &&
    launch.quit?.graceful === true && launch.quit?.portReleased === true)
  const restart = step(data, 'restart-manager')
  const asked = list(restart?.restartManager?.apps)
  require('Quits through its own path, reaching will-quit, when Restart Manager asks it to close',
    ranClean(restart) && asked.length > 0 && asked.every((app) => app.type === 'main window') &&
    restart.restartManager?.shutdown === 0 && restart.exited === true && restart.portReleased === true &&
    lineAt(restart, QUIT_LINE) >= 0 && lineAt(restart, WILL_QUIT_LINE) > lineAt(restart, QUIT_LINE))
  const upgrade = finalUpgrade(data)
  require('Upgrades in place from the previous build',
    ranClean(upgrade) && upgrade.run?.exitCode === 0 && finalUpgradeCheck(data)?.matchesVerified === true &&
    upgrade.state?.appDirectory === installedDirectory(data) && list(upgrade.state?.msiProducts).length === 1 &&
    list(upgrade.state.msiProducts)[0].version === data.folders?.upgrade?.version && onlyShortcut(data, upgrade.state))
  const launchUpgrade = step(data, 'launch-upgrade')
  require('The upgraded app launches from the shortcut', ranClean(launchUpgrade) && launchUpgrade.launch?.ready === true)
  const repair = step(data, 'repair-with-source')
  require('Repair puts back deleted files from the original package',
    ranClean(repair) && repair.run?.exitCode === 0 && Object.values(repair.restored ?? {}).every((back) => back === true) &&
    Object.keys(repair.restored ?? {}).length > 0 && check(data, 'repair-with-source')?.matchesVerified === true)
  const uninstall = step(data, 'uninstall')
  require('Uninstall removes the app, its shortcut, its toast activator and its installed-apps entry', removedEverything(uninstall))
  require('Uninstall keeps %USERPROFILE%\\.agent-inbox',
    uninstall?.sentinelSurvived === true && uninstall?.inboxDatabaseSurvived === true)
  // Two builds of one version have their own ProductCodes; the second must replace the
  // first rather than install beside it as a second product sharing every component.
  const first = step(data, 'same-version-base')
  const rebuilt = step(data, 'same-version-rebuild')
  const products = list(rebuilt?.state?.msiProducts)
  require('A rebuild of the same version replaces the installed build',
    ranClean(first) && first.run?.exitCode === 0 &&
    list(first.state?.msiProducts).map((product) => product.productCode).join() === data.builds.base?.productCode &&
    typeof data.builds.rebuild?.productCode === 'string' && data.builds.rebuild.productCode !== data.builds.base?.productCode &&
    ranClean(rebuilt) && rebuilt.run?.exitCode === 0 && products.length === 1 &&
    products[0].productCode === data.builds.rebuild.productCode && products[0].version === data.folders?.base?.version &&
    list(rebuilt.state.uninstallEntries).length === 1 && rebuilt.state.appDirectory === installedDirectory(data) &&
    check(data, 'same-version-rebuild')?.matchesVerified === true)
  require('Uninstalling the rebuild leaves nothing installed', removedEverything(step(data, 'same-version-uninstall')))
  // Whether a notification is shown depends on the runner's session; when the app
  // announced one, the identity it used must be the MSI's.
  for (const [suffix, label] of [
    ['notify-with-shortcut', "A notification leaves the MSI shortcut's identity in place"],
    ['notify-without-shortcut', 'With no shortcut, the app announces under the identity the MSI installs'],
  ]) {
    const entry = step(data, suffix)
    if (!ranClean(entry)) require(label, false)
    else if (notificationAttempted(entry)) require(label, onlyShortcut(data, { startMenuShortcuts: entry.shortcutsAfter }))
  }
  return out
}

const MiB = (bytes) => (typeof bytes === 'number' ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : 'not measured')
const code = (text) => `\`${String(text).replace(/`/g, "'")}\``
const cell = (text) => String(text ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
const ok = (value) => (value === true ? '✅' : value === false ? '❌' : '❔')
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
  const parts = ['added', 'changed', 'missing'].filter((key) => compare[key]?.count)
    .map((key) => `${key} ${compare[key].count}: ${compare[key].first.slice(0, 3).join(', ')}`)
  return `${ok(entry.matchesVerified)} ${parts.join('; ')}`.trim()
}
const links = (value) => list(value).map((link) => `${link.path} → ${link.target} (ID ${link.appUserModelId ?? 'not set'}, CLSID ${link.toastActivatorClsid ?? 'not set'}, working directory ${link.workingDirectory || 'none'})`).join('<br>') || 'none'
const activator = (value) => (value ? `${value.name}; LocalServer32 ${value.localServer32}` : 'none')
const restartManagerText = (record) => {
  if (!record) return 'not run'
  const apps = list(record.apps).map((app) => `pid ${app.pid} (${app.type}, session ${app.session})`).join(', ') || 'none'
  const after = list(record.appsAfter).map((app) => `pid ${app.pid} status ${app.status}`).join(', ')
  return `RmGetList ${record.list}: ${apps}${record.shutdown === -1 ? '' : `; RmShutdown ${record.shutdown}${after ? `; then ${after}` : ''}`}`
}
const windowsText = (value) => list(value).map((window) => `"${window.title}" (${window.class}${window.hung ? ', hung' : ''}${window.enabled === false ? ', disabled' : ''}${window.owned ? ', owned' : ''})`).join(', ') || 'none'
const quitText = (quit) => quit
  ? `${quit.graceful ? `closed by ${quit.method} in ${quit.seconds ?? '—'}s` : `${quit.method}: still running after 30 s (${list(quit.stillRunning).map((p) => p.type).join(', ') || 'unknown'}; windows before ${windowsText(quit.windows)}, after ${windowsText(quit.windowsStillOpen)}; screen ${quit.screen ?? '—'})`}, port ${quit.portReleased ? 'released' : 'still bound'}`
  : 'not run'
const appsDuring = (entry) => [...new Set(list(entry?.run?.appProcessesSeen).map((process) => process.path ? process.path.split('\\').slice(-1)[0] : 'Agent Inbox.exe'))].join(', ') || 'none'

function rows(data) {
  const out = []
  const row = (label, text) => out.push(`| ${cell(label)} | ${cell(text)} |`)
  const base = data.builds.base
  const install = step(data, 'install-base')
  const serverPolicy = step(data, 'install-under-server-policy')
  const policy = check(data, 'installer-policy')
  const restart = step(data, 'restart-manager')
  const running = step(data, 'upgrade-while-running')
  const upgrade = finalUpgrade(data)
  const uninstall = step(data, 'uninstall')
  row('MSI', base ? `${base.msi.name}, ${MiB(base.msi.bytes)}, SHA-256 ${code(base.msi.sha256)}; built in ${base.seconds}s` : 'not built')
  row('Previous build it upgrades to', data.builds.upgrade ? `${data.builds.upgrade.msi.name}, ${MiB(data.builds.upgrade.msi.bytes)}` : 'not built')
  row('Package identity', base ? `${base.productName} ${base.productVersion} by ${base.manufacturer}; UpgradeCode ${base.upgradeCode}; ProductCode ${base.productCode}; ${base.template}; ${base.files} files (the folder holds ${base.folderFiles})` : '—')
  row('ICE validation', base?.validation ? `${ok(base.validation.passed)} in ${base.validation.seconds}s, every ICE but ${base.validation.suppressed.join(', ')}, warnings as errors` : 'not run')
  row("Unelevated install under Windows Server's default installer policy",
    `${runText(serverPolicy)}; DisableMSI was ${policy?.disableMsiBefore ?? 'unset'}, set to ${policy?.disableMsiMeasured ?? '—'} (the Windows 10 and 11 default) for every other step; ${policy?.restored === true ? 'restored afterwards' : `❌ not restored: ${policy?.restoreError ?? 'not recorded'}`}`)
  row('Silent install as a standard user', `${runText(install)}; ${install?.user?.integrity ?? ''}, session ${install?.user?.session ?? '—'}; app processes during the install: ${appsDuring(install)}`)
  row('Installed tree = verified folder', `${install?.state?.appDirectory ?? '—'}: ${treeText(check(data, 'install-base'))}`)
  const deepest = check(data, 'install-base')?.deepestPath
  row('Deepest installed path', deepest ? `${deepest.fullLength} characters for a user name of ${deepest.userNameLength}; fits MAX_PATH for user names up to ${deepest.maxUserNameLength} (${deepest.relative})` : '—')
  row('Start-menu shortcut', links(install?.state?.startMenuShortcuts))
  row('Toast activator after install', activator(install?.state?.toastActivator))
  row('Start apps list (shell:AppsFolder)', list(install?.state?.appsFolder).map((entry) => entry.error ?? `${entry.name}: ${entry.appId}`).join('<br>') || 'not listed')
  const launch = step(data, 'launch-base')
  row('Launch from the shortcut, then close its window', launch ? `${ok(launch.launch?.ready)} ready in ${launch.launch?.readySeconds}s; ${quitText(launch.quit)}` : 'not run')
  for (const suffix of ['notify-with-shortcut', 'notify-without-shortcut']) {
    const entry = step(data, suffix)
    row(`Notification (${suffix.replace('notify-', '')})`, entry ? [
      entry.error ? `error: ${entry.error}` : null,
      `app announced: ${entry.notification?.seen ? `yes, after ${entry.notification.seconds}s` : 'no, not in this session'}`,
      `toast activator ${activator(entry.toastActivatorBefore)} → ${activator(entry.toastActivatorAfter)}`,
      `shortcut before: ${links(entry.shortcutsBefore)}`,
      `shortcut after: ${links(entry.shortcutsAfter)}`,
      `Windows notification history: ${entry.toastHistory?.error ? `unavailable (${entry.toastHistory.error})` : `${entry.toastHistory?.count} for ${data.release.bundleId}`}`,
      `app quit when its window closed: ${quitText(entry.quit)}`,
    ].filter(Boolean).join('<br>') : 'not run')
  }
  row('Restart Manager asks the running app to close', restart ? [
    restart.error ? `error: ${restart.error}` : null,
    `what holds ${data.release.product}.exe: ${restartManagerText(restart.restartManagerExecutable)}`,
    `asked through the SQLite addon only the main process loads: ${restartManagerText(restart.restartManager)}`,
    `every app process ${restart.exited ? `exited within ${restart.exitSeconds}s` : 'did not exit within 30 s'}; main process exit code ${restart.mainExit?.exitCode ?? '—'}; port ${restart.portReleased ? 'released' : 'still bound'}`,
    `app log: ${list(restart.appLog).filter((line) => line.includes('Windows asked')).join(' ') || 'no quit line'}`,
    list(restart.chromiumLog).length ? `Chromium: ${list(restart.chromiumLog).join(' / ')}` : null,
    restart.screen ? `still running: windows ${windowsText(restart.windowsAfter)}; screen ${restart.screen}` : null,
  ].filter(Boolean).join('<br>') : 'not run')
  row('Upgrade to the next build while the app runs', running ? [
    runText(running),
    `before: ${restartManagerText(running.restartManagerBefore)}`,
    `Windows Installer: ${list(running.msiLog).filter((line) => /RESTART MANAGER/.test(line)).map((line) => line.replace(/^MSI \([^)]*\) \([^)]*\) \[[^\]]*\]: RESTART MANAGER: /, '')).join(' ') || 'no Restart Manager lines'}`,
    `app ${logged(running, QUIT_LINE) ? 'quit when asked' : 'was not asked to quit'}; still running afterwards: ${list(running.processesAfterRun).filter((p) => p.main).length ? `yes, then ${quitText(running.quit)}` : 'no'}; ${running.rebootOperations ?? '—'} moved-aside copies of in-use files scheduled for deletion at the next reboot`,
    `tree ${treeText(check(data, 'upgrade-while-running'))}`,
  ].join('<br>') : 'not run')
  if (step(data, 'upgrade')) row('Upgrade with the app closed', `${runText(step(data, 'upgrade'))}; tree ${treeText(check(data, 'upgrade'))}`)
  row('After the upgrade', upgrade?.state ? `${upgrade.state.appDirectory}; ${list(upgrade.state.msiProducts).map((product) => product.error ?? `MSI ${product.productCode} ${product.version}, cached package ${MiB(product.localPackageBytes)}`).join(', ')}; ${list(upgrade.state.uninstallEntries).map((entry) => `${entry.hive} ${entry.displayName} ${entry.displayVersion}`).join(', ')}` : '—')
  const launchUpgrade = step(data, 'launch-upgrade')
  row('Launch after the upgrade', launchUpgrade ? `${ok(launchUpgrade.launch?.ready)} ready in ${launchUpgrade.launch?.readySeconds}s` : 'not run')
  for (const [suffix, label] of [['repair-with-source', 'Repair by product code, package in place'], ['repair-without-source', 'Repair by product code, package renamed away'], ['repair-after-source-returns', 'Repair once the package is back']]) {
    const entry = step(data, suffix)
    if (!entry) continue
    row(label, `${runText(entry)}; deleted ${list(entry.deleted).join(', ') || 'nothing'}; restored ${Object.entries(entry.restored ?? {}).map(([file, back]) => `${file} ${ok(back)}`).join(', ') || '—'}; tree ${treeText(check(data, suffix))}`)
  }
  row('Uninstall', uninstall ? `${runText(uninstall)}; app folder ${uninstall.state?.appDirectory ? 'still present' : 'removed'}; shortcuts left ${list(uninstall.state?.startMenuShortcuts).length}; toast activator ${uninstall.state?.toastActivator ? 'left' : 'removed'}; installed-apps entries ${list(uninstall.state?.uninstallEntries).length}` : 'not run')
  row('%USERPROFILE%\\.agent-inbox after uninstall', uninstall ? `sentinel ${ok(uninstall.sentinelSurvived)}, inbox.db ${ok(uninstall.inboxDatabaseSurvived)}; holds ${list(uninstall.dataAfter).join(', ')}` : 'not run')
  const before = step(data, 'baseline')?.snapshot
  const after = uninstall?.snapshot
  if (before && after) {
    const left = []
    for (const key of Object.keys(after)) {
      const previous = new Set(list(before[key]))
      for (const name of list(after[key])) if (!previous.has(name) && !(key === 'profile' && name === '.agent-inbox')) left.push(`${key}: ${name}`)
    }
    row('Left after uninstall (beyond .agent-inbox)', left.join('<br>') || 'nothing')
  }
  const sameFirst = step(data, 'same-version-base')
  const sameRebuild = step(data, 'same-version-rebuild')
  const sameUninstall = step(data, 'same-version-uninstall')
  const rebuildFolder = data.folders?.rebuild
  row('Same version built twice', sameRebuild ? [
    `first build ${data.builds.base?.productCode ?? '—'}: ${runText(sameFirst)}`,
    `rebuild ${data.builds.rebuild?.productCode ?? '—'}${rebuildFolder ? ` (the base folder without ${rebuildFolder.removed}, with ${rebuildFolder.added})` : ''}: ${runText(sameRebuild)}; Windows Installer ${list(sameRebuild.msiLog).filter((line) => /Found application/.test(line)).map((line) => line.replace(/^.*Found application: ?/, 'found ')).join(', ') || 'found no related product'}`,
    `installed afterwards: ${list(sameRebuild.state?.msiProducts).map((product) => product.error ?? `${product.productCode} ${product.version}`).join(', ') || 'nothing'}; installed-apps entries ${list(sameRebuild.state?.uninstallEntries).length}; tree ${treeText(check(data, 'same-version-rebuild'))}`,
    `uninstall: ${runText(sameUninstall)}; app folder ${sameUninstall?.state?.appDirectory ? 'still present' : 'removed'}; products left ${list(sameUninstall?.state?.msiProducts).length}; installed-apps entries left ${list(sameUninstall?.state?.uninstallEntries).length}`,
  ].join('<br>') : 'not run')
  return out
}

export function renderSummary(data, results) {
  const tools = data.tools
  const lines = [
    '## Windows x64 MSI (unsigned, #87 PR 2b)',
    '',
    'A CI artifact only: unsigned, never published, and not in the update manifest. Every installer and app action ran as a fresh, disposable standard (non-administrator) user.',
    '',
    data.folders
      ? `Inputs: verified folder **${data.folders.base.version}** (${data.folders.base.files} files, ${MiB(data.folders.base.bytes)}, ${code(data.folders.base.appTreeDigest)}) and the same commit rebuilt as **${data.folders.upgrade.version}**.`
      : 'Inputs: the verified folders were not restored.',
    '',
    '### Pinned tools',
    '',
    '| Tool | Pin | Ran as |',
    '| --- | --- | --- |',
    `| WiX ${cell(data.pins.wix.version)} (nuget.org \`wix\`) | SHA-512 ${code(data.pins.wix.sha512)}, SHA-256 ${code(data.pins.wix.sha256)}; EULA ${data.pins.wix.eulaId} accepted by the owner on ${data.pins.wix.eulaAcceptedOn} | ${cell(tools?.wix?.reportedVersion ?? 'not installed')} |`,
    `| .NET runtime ${cell(data.pins.dotnet.version)} (supported until ${data.pins.dotnet.supportedUntil}) | SHA-512 ${code(data.pins.dotnet.sha512)}, SHA-256 ${code(data.pins.dotnet.sha256)} | ${cell(list(tools?.dotnet?.resolved).find((path) => /coreclr\.dll$/i.test(path)) ?? 'not resolved')} |`,
    '',
    '### Lifecycle',
    '',
    '| Check | Result |',
    '| --- | --- |',
    ...rows(data),
    '',
    '### Requirements',
    '',
    ...results.map((entry) => `- ${ok(entry.passed)} ${entry.label}`),
    '',
  ]
  if (data.lifecycle?.failure) lines.push(`> **Lifecycle stopped:** ${cell(data.lifecycle.failure)}`, '')
  const steps = data.lifecycle?.steps ?? {}
  lines.push('<details><summary>Step log</summary>', '', '| Step | Result | App folder |', '| --- | --- | --- |')
  for (const [name, entry] of Object.entries(steps)) lines.push(`| ${cell(name)} | ${cell(runText(entry))} | ${cell(entry.state?.appDirectory)} |`)
  lines.push('', '</details>', '')
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { evidence: { type: 'string' }, inputs: { type: 'string' }, summary: { type: 'string' }, out: { type: 'string' } },
  })
  if (!values.evidence || !values.inputs || !values.out) {
    process.stderr.write('usage: summary.mjs --evidence <dir> --inputs <windows-inputs.json> --out <json> [--summary <md>]\n')
    process.exit(2)
  }
  const pins = JSON.parse(readFileSync(join(here, 'installer.json'), 'utf8'))
  const release = JSON.parse(readFileSync(resolve(values.inputs), 'utf8'))
  const data = loadEvidence(resolve(values.evidence), { pins, release })
  const results = requirements(data)
  const markdown = renderSummary(data, results)
  if (values.summary) appendFileSync(values.summary, markdown)
  writeFileSync(resolve(values.out), `${JSON.stringify({ schema: 1, ...data, requirements: results }, null, 2)}\n`)
  process.stdout.write(markdown)
  const failed = results.filter((entry) => !entry.passed)
  if (failed.length) {
    process.stderr.write(`summary: ${failed.length} requirement(s) failed: ${failed.map((entry) => entry.label).join('; ')}\n`)
    process.exitCode = 1
  }
}
