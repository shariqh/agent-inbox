import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeScratchDirs, scratchDir } from './scratch.js'

// #87 PR 2b: the unsigned per-user MSI is built in CI with third-party tools on a
// runner, so every tool it fetches stays pinned and verified, the owner's WiX EULA
// acceptance stays in exactly one documented place, and the lifecycle evidence
// decides whether the MSI is handed out at all.
const root = resolve(process.cwd())
const msiDir = join(root, '.github', 'windows-msi')
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const workflow = (): string => read(join(root, '.github', 'workflows', 'windows-msi.yml'))
const harness = (): { name: string, text: string }[] => readdirSync(msiDir)
  .filter((name) => !name.endsWith('.json'))
  .map((name) => ({ name, text: read(join(msiDir, name)) }))
const everything = (): { name: string, text: string }[] => [{ name: 'workflow', text: workflow() }, ...harness()]
const commands = (text: string): string => text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')

type Pins = {
  wix: { package: string, version: string, url: string, sha512: string, sha256: string, sourceCommit: string, entryPoint: string, license: string, eulaId: string, eulaAcceptedOn: string }
  dotnet: { framework: string, version: string, url: string, sha512: string, sha256: string, supportedUntil: string }
  identity: { upgradeCode: string, toastActivatorClsid: string }
}
const pins = (): Pins => JSON.parse(read(join(msiDir, 'installer.json')))
const release = (): { product: string, bundleId: string, minimumWindowsVersion: string } =>
  JSON.parse(read(join(root, 'release', 'windows-inputs.json')))

type Requirement = { label: string, passed: boolean }
const summary = (await import(pathToFileURL(join(msiDir, 'summary.mjs')).href)) as {
  requirements(data: unknown): Requirement[]
}
const checksums = (await import(pathToFileURL(join(msiDir, 'checksums.mjs')).href)) as {
  CHECKSUMS: string
  writeWindowsChecksums(dir: string, version: string): string
  verifyWindowsChecksums(dir: string, version: string): string
}

describe('Windows MSI workflow (#87 PR 2b)', () => {
  it('runs on dispatch or a change to what it builds, read-only and secret-free', () => {
    const text = workflow()
    const trigger = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'))
    expect(trigger).toContain('  workflow_dispatch:\n')
    expect(trigger.match(/^\s+- "([^"]+)"$/gm)?.map((line) => line.trim())).toEqual([
      '- ".github/workflows/windows-msi.yml"',
      '- ".github/workflows/windows-native-folder.yml"',
      '- ".github/windows-msi/**"',
      '- "electron/windows-app.cjs"',
      '- "release/windows-inputs.json"',
      '- "test/windows-msi.test.ts"',
    ])
    expect(trigger).not.toMatch(/push:|pull_request_target|workflow_run|schedule:/)
    expect(text).toContain('permissions:\n  contents: read\n')
    expect(text).not.toMatch(/permissions:[\s\S]*permissions:/)
    expect(text).not.toMatch(/secrets\.|contents: write|id-token|gh release|release create|release upload/)
    for (const runner of text.matchAll(/runs-on: (\S+)/g)) expect(runner[1]).toBe('windows-2022')
  })

  it('builds the MSI from the reused, verified folder and the next build from the same builder', () => {
    const text = workflow()
    expect(text).toMatch(/^ {2}folder:\n {4}name: Verified folder\n {4}uses: \.\/\.github\/workflows\/windows-native-folder\.yml\n/m)
    expect(text).not.toMatch(/uses: \.\/[^\n]*@/)
    expect(read(join(root, '.github', 'workflows', 'windows-native-folder.yml'))).toMatch(/^ {2}workflow_call:\n/m)
    expect(text).toContain('needs: [folder, upgrade-folder]')
    expect(text).toContain('name: native-win32-x64-folder-inputs')
    const prepare = read(join(msiDir, 'prepare-folders.mjs'))
    expect(prepare).toContain('tree.digest !== report.appTreeDigest')
    expect(prepare).toContain('extractTreeArchive({')
    expect(text).toContain('npm run package:windows-thin --')
    expect(text).toContain('AGENT_INBOX_RELEASE_SOURCE_SHA=$(git rev-parse HEAD)')
    // The MSI handed out is the verified folder's; the next build only proves the upgrade.
    expect(text).toContain('-Validate:($side -eq \'base\')')
    expect(text).toContain('Copy-Item "build/msi/builds/$($base.msi.name)" build/msi/artifact/')
  })

  it('pins WiX v7 by exact version, nuget.org package hash and source commit', () => {
    const { wix } = pins()
    expect(wix.package).toBe('wix')
    expect(wix.version).toBe('7.0.0')
    expect(wix.url).toBe(`https://api.nuget.org/v3-flatcontainer/wix/${wix.version}/wix.${wix.version}.nupkg`)
    expect(wix.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/)
    expect(wix.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(wix.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(wix.entryPoint).toBe('tools/net8.0/any/wix.dll')
  })

  it('runs WiX on a pinned .NET 10 runtime that Microsoft supports past .NET 8', () => {
    const { dotnet } = pins()
    expect(dotnet.framework).toBe('Microsoft.NETCore.App')
    expect(dotnet.version).toMatch(/^10\.0\.\d+$/)
    expect(dotnet.url).toBe(`https://builds.dotnet.microsoft.com/dotnet/Runtime/${dotnet.version}/dotnet-runtime-${dotnet.version}-win-x64.zip`)
    expect(dotnet.sha512).toMatch(/^[0-9a-f]{128}$/)
    expect(dotnet.sha256).toMatch(/^[0-9a-f]{64}$/)
    // .NET 8, which WiX 7 asks for, is supported until 2026-11-10.
    expect(dotnet.supportedUntil > '2026-11-10').toBe(true)
  })

  it('installs each tool only after both digests match, and never from a feed, SDK or the runner\'s .NET', () => {
    const install = read(join(msiDir, 'install-tools.ps1'))
    // A failed check must stop the script, so each guard is pinned with its throw, in order.
    expect(install).toContain("\n$ErrorActionPreference = 'Stop'\n$PSNativeCommandUseErrorActionPreference = $true\n")
    expect(install).toMatch(/^trap \{[^\n]*; break \}$/m)
    const steps = [
      'if (Test-Path -LiteralPath $Destination) { throw "tool destination already exists',
      'Invoke-WebRequest -Uri $Pin.url -OutFile $path',
      '[Security.Cryptography.SHA512]::HashData($bytes)',
      '[Security.Cryptography.SHA256]::HashData($bytes)',
      'if ($sha512 -cne $Pin.sha512 -or $sha256 -cne $Pin.sha256) {\n    throw "$Name digest mismatch',
      "$runtimeZip = Get-PinnedFile $dotnetPin \"dotnet-runtime-$($dotnetPin.version)-win-x64.zip\" 'hex'",
      '[IO.Compression.ZipFile]::ExtractToDirectory($runtimeZip.path, $dotnetRoot)',
      'throw "the .NET runtime archive does not hold exactly',
      "$nupkg = Get-PinnedFile $wixPin \"$($wixPin.package).$($wixPin.version).nupkg\" 'base64'",
      '[IO.Compression.ZipFile]::ExtractToDirectory($nupkg.path, $wixRoot)',
      'throw "WiX $($wixPin.version) does not run on $($dotnetPin.framework) alone"',
      "Get-ChildItem Env: | Where-Object { $_.Name -match '^(DOTNET_|COREHOST_)' } | ForEach-Object { Remove-Item",
      '$reported = "$(& $dotnet exec --fx-version $dotnetPin.version $wixDll --version)".Trim()',
      "$reportedParts = [regex]::Match($reported, '^(\\d+\\.\\d+\\.\\d+)\\+([0-9a-f]{7,40})$')",
      '-not $wixPin.sourceCommit.StartsWith($reportedParts.Groups[2].Value)) {\n  throw "WiX reports',
      'throw "WiX did not run on $($dotnetPin.framework) $($dotnetPin.version)',
      '| Set-Content -Encoding utf8 -LiteralPath $Report',
    ]
    const at = steps.map((step) => install.indexOf(step))
    steps.forEach((step, index) => expect(at[index], step).toBeGreaterThan(-1))
    expect(at, 'install-tools.ps1 runs its checks in this order').toEqual([...at].sort((a, b) => a - b))
    const build = read(join(msiDir, 'build-msi.ps1'))
    expect(build).toContain("Get-ChildItem Env: | Where-Object { $_.Name -match '^(DOTNET_|COREHOST_)' } | ForEach-Object { Remove-Item")
    expect(build).toContain('& $dotnet exec --fx-version $pins.dotnet.version $wixDll @Arguments')
    for (const { name, text } of everything()) {
      expect(commands(text), `${name} must install or run no other .NET tool`)
        .not.toMatch(/dotnet (tool|add|restore|build)|nuget(\.exe)? install|wix extension|wix\.exe|setup-dotnet|DOTNET_ROOT|NUGET_PACKAGES/i)
    }
  })

  it('accepts the WiX EULA only with the owner\'s dated acceptance, through WiX\'s documented switch', () => {
    const { wix } = pins()
    expect(wix.eulaId).toBe('wix7')
    expect(wix.eulaAcceptedOn).toBe('2026-10-23')
    expect(wix.license).toMatch(/Open Source Maintenance Fee EULA v1\.1/)
    const build = read(join(msiDir, 'build-msi.ps1'))
    expect(build).toContain([
      '# The project owner accepted the WiX Toolset Open Source Maintenance Fee EULA (v1.1,',
      '# EULA ID wix7) on 2026-10-23. -acceptEula is WiX\'s documented switch for build',
      '# scripts and CI; every WiX command here that needs the acceptance passes it, and',
      '# nothing records a per-user acceptance on the runner.',
      "$acceptEula = @('-acceptEula', $pins.wix.eulaId)",
    ].join('\n'))
    // Both WiX commands that need it carry it, and nothing else names the switch.
    expect(build).toMatch(/Invoke-Wix @\(\n {2}'build'\n {2}\$acceptEula\n/)
    expect(build).toContain("Invoke-Wix @('msi', 'validate'; $acceptEula; ")
    expect(build.match(/acceptEula/gi)).toHaveLength(5)
    for (const { name, text } of everything()) {
      if (name === 'build-msi.ps1') continue
      expect(commands(text), name).not.toMatch(/accepteula/i)
    }
    for (const { name, text } of everything()) {
      expect(text, `${name} must not record an acceptance on the runner`).not.toMatch(/eula accept|EulaId=|\.wix[\\/]/i)
    }
  })

  it('downloads nothing but the pinned .NET runtime and WiX package', () => {
    const allowed = ['http://wixtoolset.org/schemas/v4/wxs', 'https://github.com/shariqh/agent-inbox']
    for (const { name, text } of everything()) {
      for (const [url] of text.matchAll(/https?:\/\/[^\s"'`<>)]+/g)) {
        expect(url.startsWith('http://127.0.0.1:') || allowed.includes(url), `${name} names ${url}`).toBe(true)
      }
      expect(commands(text), name).not.toMatch(/\b(Invoke-RestMethod|Start-BitsTransfer|DownloadFile|curl|wget|choco|winget|Install-Module|Install-Package|actions\/cache)\b/i)
      for (const [fetch] of text.matchAll(/Invoke-WebRequest[^\n]*/g)) {
        expect(fetch, name).toMatch(/^Invoke-WebRequest (-Uri \$Pin\.url -OutFile \$path$|-Method Head -Uri "http:\/\/127\.0\.0\.1:)/)
      }
    }
    expect(read(join(msiDir, 'installer.json'))).not.toMatch(/http:\/\//)
  })

  it('restores no npm cache and compiles better-sqlite3 from source in every npm install (#315)', () => {
    const lines = workflow().split('\n')
    const top = lines.slice(lines.indexOf('env:') + 1, lines.indexOf('jobs:'))
    expect(top).toContain('  npm_config_build_from_source: "true"')
    const setupNodes = lines.flatMap((line, index) => (line.includes('uses: actions/setup-node@') ? [index] : []))
    expect(setupNodes.length).toBe(2)
    for (const index of setupNodes) {
      expect(lines.slice(index + 1, index + 5)).toContain('          package-manager-cache: false')
    }
    expect(workflow()).not.toMatch(/^\s+cache:/m)
    expect(commands(workflow()).match(/\bnpm (ci|install|i|exec)\b[^\n]*/g)).toEqual(['npm ci'])
    expect(commands(workflow())).not.toMatch(/\bnpx\b/)
  })

  it('pins actions by commit with version comments, drops checkout credentials and stops on native errors', () => {
    const text = workflow()
    const refs = [...text.matchAll(/^\s*-\s+uses:\s+([^@\s]+)@([^\s#]+)(?:\s+#\s+(.+))?$/gm)]
    expect(refs.length).toBeGreaterThan(0)
    for (const [, action, ref, comment] of refs) {
      expect(action).toMatch(/^actions\//)
      expect(ref).toMatch(/^[0-9a-f]{40}$/)
      expect(comment).toMatch(/^v\d+\.\d+\.\d+$/)
    }
    const checkouts = text.match(/^\s{6}- uses: actions\/checkout@/gm)?.length ?? 0
    expect(checkouts).toBe(2)
    expect(text.match(/^\s{10}persist-credentials: false$/gm)).toHaveLength(checkouts)
    const pwshBlocks = text.match(/^\s{8}shell: pwsh$/gm)?.length ?? 0
    expect(pwshBlocks).toBeGreaterThan(0)
    expect(text.match(/\$PSNativeCommandUseErrorActionPreference = \$true/g)).toHaveLength(pwshBlocks)
    for (const script of ['install-tools.ps1', 'build-msi.ps1', 'lifecycle.ps1']) {
      expect(read(join(msiDir, script)), script).toContain("\n$ErrorActionPreference = 'Stop'\n$PSNativeCommandUseErrorActionPreference = $true\n")
    }
  })
})

describe('Windows MSI authoring (#87 PR 2b)', () => {
  const wxs = (): string => read(join(msiDir, 'agent-inbox.wxs'))

  it('installs per user, unelevated, to the same folder for every version', () => {
    const text = wxs()
    expect(text).toContain('Scope="perUser"')
    expect(text).toMatch(/<StandardDirectory Id="LocalAppDataFolder">\s*<Directory Id="UserProgramsFolder" Name="Programs">\s*<Directory Id="INSTALLFOLDER" Name="\$\(var\.ProductName\)" \/>/)
    expect(text).toContain('<MajorUpgrade DowngradeErrorMessage=')
    expect(text).toContain('<Files Directory="INSTALLFOLDER" Include="$(var.AppDir)\\**" />')
    // It writes nothing per-machine, runs no custom code and never touches the inbox data.
    const authored = text.replace(/<!--[\s\S]*?-->/g, '')
    expect(authored).not.toMatch(/<RegistryValue\s[^>]*Root="HKLM"|Id="ProgramFiles(64)?Folder"|perMachine|<CustomAction|<RemoveFolder|\.agent-inbox/)
    // Its one HKLM reference is the read-only Windows build search.
    expect(authored.match(/Root="HKLM"/g)).toHaveLength(1)
    expect(authored).toMatch(/<RegistrySearch\s+Root="HKLM"\s+Key="SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"\s+Name="CurrentBuildNumber"\s+Type="raw"/)
  })

  it('gives the shortcut the identity the app sets, and owns the toast activator registration', () => {
    const text = wxs()
    expect(text).toContain('<ShortcutProperty Key="System.AppUserModel.ID" Value="$(var.AppUserModelId)" />')
    expect(text).toContain('<ShortcutProperty Key="System.AppUserModel.ToastActivatorCLSID" Value="$(var.ToastActivatorClsid)" />')
    expect(text).toContain('Target="[INSTALLFOLDER]$(var.ProductName).exe"')
    expect(text).toContain('Key="Software\\Classes\\CLSID\\$(var.ToastActivatorClsid)\\LocalServer32"')
    const build = read(join(msiDir, 'build-msi.ps1'))
    expect(build).toContain("'-d', \"AppUserModelId=$($release.bundleId)\"")
    expect(build).toContain("'-d', \"ToastActivatorClsid=$($pins.identity.toastActivatorClsid)\"")
    expect(build).toContain("'-d', \"UpgradeCode=$($pins.identity.upgradeCode)\"")
    const { identity } = pins()
    expect(identity.upgradeCode).toBe('{086C4AF7-CD48-4050-A328-CA911E7F7423}')
    expect(identity.toastActivatorClsid).toBe('{08973E92-A6EF-47B2-9E91-A876F4B8F210}')
    expect(release().bundleId).toBe('io.github.shariqh.agent-inbox')
  })

  it('refuses Windows older than the release inputs\' minimum build, but never blocks repair or removal', () => {
    expect(wxs()).toContain('Condition="Installed OR AGENTINBOXWINDOWSBUILD &gt;= $(var.MinimumWindowsBuild)"')
    const build = read(join(msiDir, 'build-msi.ps1'))
    expect(build).toContain("$minimum = [regex]::Match(\"$($release.minimumWindowsVersion)\", '^10\\.0\\.(\\d+)$')")
    expect(build).toContain("'-d', \"MinimumWindowsBuild=$($minimum.Groups[1].Value)\"")
    expect(release().minimumWindowsVersion).toMatch(/^10\.0\.\d+$/)
  })

  it('names the MSI for the release and refuses a version an MSI cannot hold', () => {
    const build = read(join(msiDir, 'build-msi.ps1'))
    expect(build).toContain('Join-Path $Output "Agent-Inbox-v$version-windows-x64.msi"')
    expect(build).toContain("$fields = [regex]::Match(\"$version\", '^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,5})$')")
    expect(build).toContain('throw "an MSI ProductVersion holds only major.minor.patch')
  })

  it('reads the package back and refuses any difference from the installer identity', () => {
    const build = read(join(msiDir, 'build-msi.ps1'))
    for (const label of ['ProductName', 'Manufacturer', 'ProductVersion', 'UpgradeCode', 'ALLUSERS (unset in a per-user package)',
      'elevation not required', 'template', 'files', 'shortcuts', 'shortcut properties', 'toast activator LocalServer32',
      'minimum Windows launch condition']) {
      expect(build).toContain(`& $expect '${label}' `)
    }
    expect(build).toContain('if ($failures.Count -gt 0) { throw "the MSI does not carry the installer identity')
  })

  it('gates on ICE validation, waiving only the per-user checks WiX documents for Files', () => {
    const build = read(join(msiDir, 'build-msi.ps1'))
    expect(build).toContain("$suppressed = @('ICE38', 'ICE64', 'ICE91')")
    expect(build).toContain("Invoke-Wix @('msi', 'validate'; $acceptEula; '-wx'; $suppressed | ForEach-Object { '-sice', $_ }; $msi)")
    // Validation's exit code is no longer data: a failure stops the build.
    expect(build).not.toMatch(/PSNativeCommandUseErrorActionPreference = \$false|LASTEXITCODE = 0/)
    expect(build).toMatch(/^ {2}'-wx'$/m)
  })
})

describe('Windows MSI lifecycle (#87 PR 2b)', () => {
  it('measures every installer and app action as a standard user', () => {
    const lifecycle = read(join(msiDir, 'lifecycle.ps1'))
    expect(lifecycle).toContain('-Credential $credential -LoadUserProfile')
    expect(lifecycle).toContain('$result.user.isAdministrator -or $result.user.name -ne $UserName')
    expect(lifecycle).toContain('Write-Host "::add-mask::$password"')
    const asUser = read(join(msiDir, 'as-user.ps1'))
    expect(asUser).toContain('[Security.Principal.WindowsBuiltInRole]::Administrator')
    expect(asUser).toMatch(/msiexec\.exe', "\/i `"\$Installer`" \/qn/)
    const order = ['install-under-server-policy', 'install-base', 'launch-base', 'notify-with-shortcut', 'notify-without-shortcut',
      'restart-manager', 'upgrade-while-running', 'launch-upgrade', 'repair-with-source', 'repair-without-source', 'uninstall']
    const at = order.map((step) => lifecycle.indexOf(`Invoke-Step '${step}'`))
    order.forEach((step, index) => expect(at[index], step).toBeGreaterThan(-1))
    expect(at).toEqual([...at].sort((a, b) => a - b))
    // The machine policy the run changes is put back, and its key is never re-created.
    expect(lifecycle).not.toMatch(/New-Item[^\n]*-Force[^\n]*\$policyKey|New-Item[^\n]*\$policyKey[^\n]*-Force/)
    expect(lifecycle.slice(lifecycle.lastIndexOf('} finally {'))).toContain(
      'Set-ItemProperty -LiteralPath $policyKey -Name DisableMSI -Value $policy.disableMsiBefore -Type $policy.disableMsiKind')
  })

  it('asks the running app to close through Restart Manager without forcing it', () => {
    const asUser = read(join(msiDir, 'as-user.ps1'))
    expect(asUser.match(/RmShutdown\(session,[^)]*\)/g)).toEqual(['RmShutdown(session, flags, IntPtr.Zero)'])
    // RmForceShutdown (0x1) would end what it cannot ask; no probe passes it.
    expect(asUser.match(/::Probe\([^\n]*, \$(true|false), \d\)/g)?.map((call) => call.slice(-3))).toEqual([' 0)', ' 0)', ' 0)'])
    const step = asUser.slice(asUser.indexOf("    'restart-manager' {"), asUser.indexOf("    'upgrade' {"))
    const looked = step.indexOf('[AgentInboxRestartManager]::Probe(@(Join-Path $directory "$product.exe"), $false, 0)')
    const asked = step.indexOf('[AgentInboxRestartManager]::Probe(@($addon), $true, 0)')
    expect(looked).toBeGreaterThan(0)
    expect(asked).toBeGreaterThan(looked)
    expect(step).toContain("$addon = Join-Path $directory 'resources\\app\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node'")
    // Before the upgrade it only looks: Windows Installer does the asking there.
    expect(asUser).toContain('[AgentInboxRestartManager]::Probe(@(Join-Path (Get-AppDirectory) "$product.exe"), $false, 0)')
    expect(asUser).toContain("$quitLine = 'Windows asked the app to close \\(Restart Manager\\); quitting'")
    expect(read(join(root, 'electron', 'windows-app.cjs')))
      .toContain("log('[agent-inbox] Windows asked the app to close (Restart Manager); quitting')")
  })
})

describe('Windows MSI requirements (#87 PR 2b)', () => {
  const QUIT = '[agent-inbox] Windows asked the app to close (Restart Manager); quitting'
  const folder = '%USERPROFILE%\\AppData\\Local\\Programs\\Agent Inbox'
  const exe = `${folder}\\Agent Inbox.exe`
  const user = { name: 'msiuser', isAdministrator: false, integrity: 'Mandatory Label\\Medium Mandatory Level Label' }
  const sha = 'a'.repeat(64)

  function evidence() {
    const { identity, wix, dotnet } = pins()
    const link = {
      path: '%USERPROFILE%\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Agent Inbox.lnk',
      target: exe,
      workingDirectory: `${folder}\\`,
      appUserModelId: release().bundleId,
      toastActivatorClsid: identity.toastActivatorClsid,
    }
    const installed = { appDirectory: folder, startMenuShortcuts: [link], msiProducts: [{ version: '1.6.1' }] }
    return {
      link,
      data: {
        pins: pins(),
        release: release(),
        folders: { base: { version: '1.6.0' }, upgrade: { version: '1.6.1' } },
        tools: {
          wix: { reportedVersion: `${wix.version}+${wix.sourceCommit.slice(0, 7)}`, sha512: wix.sha512 },
          dotnet: { sha512: dotnet.sha512, resolved: [`D:\\a\\tools\\dotnet\\shared\\Microsoft.NETCore.App\\${dotnet.version}\\coreclr.dll`] },
        },
        builds: {
          base: {
            upgradeCode: identity.upgradeCode,
            productVersion: '1.6.0',
            elevationNotRequired: true,
            validation: { passed: true },
            msi: { name: 'Agent-Inbox-v1.6.0-windows-x64.msi', sha256: sha },
            shortcutProperties: [
              { key: 'System.AppUserModel.ID', value: release().bundleId },
              { key: 'System.AppUserModel.ToastActivatorCLSID', value: identity.toastActivatorClsid },
            ],
          },
          upgrade: { msi: { name: 'Agent-Inbox-v1.6.1-windows-x64.msi' } },
        },
        checksums: `${sha}  Agent-Inbox-v1.6.0-windows-x64.msi\n`,
        lifecycle: {
          failure: null,
          steps: {
            '03-install-base': { user, run: { exitCode: 0 }, state: { ...installed, toastActivator: { localServer32: `"${exe}"`, customActivator: '1' } } },
            '04-launch-base': { user, launch: { ready: true }, quit: { graceful: true, portReleased: true } },
            '05-notify-with-shortcut': { user, notification: { seen: true }, shortcutsAfter: [{ ...link, workingDirectory: folder }] },
            '06-notify-without-shortcut': { user, notification: { seen: false }, shortcutsAfter: [] },
            '07-restart-manager': {
              user,
              restartManager: { apps: [{ pid: 1, type: 'main window' }], shutdown: 0 },
              exited: true,
              portReleased: true,
              appLog: [QUIT],
            },
            '08-upgrade-while-running': { user, run: { exitCode: 0 }, state: installed },
            '09-launch-upgrade': { user, launch: { ready: true } },
            '10-repair-with-source': { user, run: { exitCode: 0 }, restored: { 'Agent Inbox.exe': true } },
            '13-uninstall': {
              user,
              run: { exitCode: 0 },
              state: { appDirectory: null, msiRoot: null, startMenuShortcuts: [], msiProducts: [], uninstallEntries: [], toastActivator: null },
              sentinelSurvived: true,
              inboxDatabaseSurvived: true,
            },
          },
          checks: {
            'install-base': { matchesVerified: true },
            'upgrade-while-running': { matchesVerified: true },
            'repair-with-source': { matchesVerified: true },
          },
        },
      },
    }
  }
  type Data = ReturnType<typeof evidence>['data']
  type Steps = Record<string, Record<string, unknown> & { state?: Record<string, unknown> }>
  const steps = (data: Data): Steps => data.lifecycle.steps as unknown as Steps

  it('pass on complete evidence; a notification the runner could not show adds no requirement', () => {
    const results = summary.requirements(evidence().data)
    expect(results.filter((entry) => !entry.passed)).toEqual([])
    expect(results.map((entry) => entry.label)).toContain("A notification leaves the MSI shortcut's identity in place")
    expect(results.map((entry) => entry.label)).not.toContain('With no shortcut, the app announces under the identity the MSI installs')
  })

  it('read a one-element list that PowerShell wrote as the element itself', () => {
    const { data, link } = evidence()
    steps(data)['07-restart-manager']!.appLog = QUIT
    steps(data)['03-install-base']!.state = { ...steps(data)['03-install-base']!.state, startMenuShortcuts: link }
    expect(summary.requirements(data).filter((entry) => !entry.passed)).toEqual([])
  })

  const breaks: [string, RegExp, (data: Data, link: ReturnType<typeof evidence>['link']) => void][] = [
    ['WiX ran on the runner\'s .NET 8', /^WiX 7\.0\.0 ran/, (data) => {
      data.tools.dotnet.resolved = ['C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App\\8.0.31\\coreclr.dll']
    }],
    ['the host trace names no runtime it loaded', /^WiX 7\.0\.0 ran/, (data) => {
      data.tools.dotnet.resolved = [`D:\\a\\tools\\dotnet\\shared\\Microsoft.NETCore.App\\${pins().dotnet.version}`]
    }],
    ['the host also loaded another runtime', /^WiX 7\.0\.0 ran/, (data) => {
      data.tools.dotnet.resolved.push('C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App\\8.0.31\\coreclr.dll')
    }],
    ['another WiX build ran', /^WiX 7\.0\.0 ran/, (data) => { data.tools.wix.reportedVersion = '5.0.2+aa65968c' }],
    ['WiX came from another commit', /^WiX 7\.0\.0 ran/, (data) => { data.tools.wix.reportedVersion = '7.0.0+aa65968' }],
    ['ICE validation did not pass', /ICE validation/, (data) => { data.builds.base.validation.passed = false }],
    ['the checksum names another digest', /SHA256SUMS-windows\.txt/, (data) => { data.checksums = `${'b'.repeat(64)}  Agent-Inbox-v1.6.0-windows-x64.msi\n` }],
    ['the lifecycle stopped', /ran to the end/, (data) => { (data.lifecycle as { failure: string | null }).failure = 'stopped' }],
    ['the install ran elevated', /standard user/, (data) => { steps(data)['03-install-base']!.user = { ...user, isAdministrator: true } }],
    ['the installed tree differs', /exactly the verified folder/, (data) => { data.lifecycle.checks['install-base'].matchesVerified = false }],
    ['the shortcut lost the app ID', /Start-menu shortcut/, (data, link) => {
      steps(data)['03-install-base']!.state!.startMenuShortcuts = [{ ...link, appUserModelId: 'electron.app.Agent Inbox' }]
    }],
    ['the toast activator points elsewhere', /toast activator for the installed app/, (data) => {
      steps(data)['03-install-base']!.state!.toastActivator = { localServer32: '"C:\\elsewhere.exe"', customActivator: '1' }
    }],
    ['the app had to be killed', /quits when its window closes/, (data) => { steps(data)['04-launch-base']!.quit = { graceful: false, portReleased: true } }],
    ['PowerShell wrote one log line as a string', /Restart Manager/, (data) => { steps(data)['07-restart-manager']!.appLog = 'no quit line' }],
    ['Restart Manager saw no app', /Restart Manager/, (data) => { steps(data)['07-restart-manager']!.restartManager = { apps: [], shutdown: 0 } }],
    ['Restart Manager also saw a process it cannot ask', /Restart Manager/, (data) => {
      steps(data)['07-restart-manager']!.restartManager = { apps: [{ pid: 1, type: 'main window' }, { pid: 2, type: 'unknown' }], shutdown: 0 }
    }],
    ['Restart Manager could not shut it down', /Restart Manager/, (data) => {
      steps(data)['07-restart-manager']!.restartManager = { apps: [{ pid: 1, type: 'main window' }], shutdown: 351 }
    }],
    ['the app stayed running', /Restart Manager/, (data) => { steps(data)['07-restart-manager']!.exited = false }],
    ['Electron ended the app without its own quit', /Restart Manager/, (data) => { steps(data)['07-restart-manager']!.appLog = [] }],
    ['the upgrade left two products', /Upgrades in place/, (data) => {
      steps(data)['08-upgrade-while-running']!.state = { ...steps(data)['08-upgrade-while-running']!.state, msiProducts: [{ version: '1.6.0' }, { version: '1.6.1' }] }
    }],
    ['the upgraded app did not start', /upgraded app launches/, (data) => { steps(data)['09-launch-upgrade']!.launch = { ready: false } }],
    ['repair left a file missing', /Repair/, (data) => { steps(data)['10-repair-with-source']!.restored = { 'Agent Inbox.exe': false } }],
    ['uninstall left the toast activator', /Uninstall removes/, (data) => {
      steps(data)['13-uninstall']!.state = { ...steps(data)['13-uninstall']!.state, toastActivator: { name: 'left' } }
    }],
    ['uninstall removed the inbox', /keeps %USERPROFILE%\\\.agent-inbox/, (data) => { steps(data)['13-uninstall']!.inboxDatabaseSurvived = false }],
    ['a notification rewrote the shortcut under another ID', /notification leaves/, (data, link) => {
      steps(data)['05-notify-with-shortcut']!.shortcutsAfter = [{ ...link, appUserModelId: 'electron.app.Agent Inbox' }]
    }],
    ['the shortcut the app wrote has a made-up CLSID', /no shortcut, the app announces/, (data, link) => {
      steps(data)['06-notify-without-shortcut']!.notification = { seen: true }
      steps(data)['06-notify-without-shortcut']!.shortcutsAfter = [{ ...link, toastActivatorClsid: '{00000000-0000-0000-0000-000000000000}' }]
    }],
  ]
  it.each(breaks)('fail when %s', (_name, label, mutate) => {
    const { data, link } = evidence()
    mutate(data, link)
    const failed = summary.requirements(data).filter((entry) => !entry.passed).map((entry) => entry.label)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatch(label)
  })
})

describe('SHA256SUMS-windows.txt (#87 PR 2b)', () => {
  afterEach(() => removeScratchDirs())

  const artifact = (files: Record<string, string>): string => {
    const dir = scratchDir('windows-msi-artifact-')
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    return dir
  }

  it('names the MSI and its SHA-256 in sha256sum form, and reads it back', () => {
    const dir = artifact({ 'Agent-Inbox-v1.7.0-windows-x64.msi': 'msi bytes' })
    const text = checksums.writeWindowsChecksums(dir, '1.7.0')
    // sha256("msi bytes")
    expect(text).toBe('b2d6e91a2086151d526602bbba497382d318625a0e9f36ccd100c746bcf80663  Agent-Inbox-v1.7.0-windows-x64.msi\n')
    expect(read(join(dir, checksums.CHECKSUMS))).toBe(text)
    expect(checksums.verifyWindowsChecksums(dir, '1.7.0')).toBe(text)
  })

  it('refuses a changed MSI, a stray file, another version and a missing checksum file', () => {
    const changed = artifact({ 'Agent-Inbox-v1.7.0-windows-x64.msi': 'msi bytes' })
    checksums.writeWindowsChecksums(changed, '1.7.0')
    writeFileSync(join(changed, 'Agent-Inbox-v1.7.0-windows-x64.msi'), 'other bytes')
    expect(() => checksums.verifyWindowsChecksums(changed, '1.7.0')).toThrow(/stale or malformed/)
    const stray = artifact({ 'Agent-Inbox-v1.7.0-windows-x64.msi': 'msi bytes', 'notes.txt': '' })
    expect(() => checksums.writeWindowsChecksums(stray, '1.7.0')).toThrow(/must hold only Agent-Inbox-v1\.7\.0-windows-x64\.msi/)
    const other = artifact({ 'Agent-Inbox-v1.6.0-windows-x64.msi': 'msi bytes' })
    expect(() => checksums.writeWindowsChecksums(other, '1.7.0')).toThrow(/must hold only/)
    expect(() => checksums.writeWindowsChecksums(other, '1.7.0-rc.1')).toThrow(/not a release version/)
    const unwritten = artifact({ 'Agent-Inbox-v1.7.0-windows-x64.msi': 'msi bytes' })
    expect(() => checksums.verifyWindowsChecksums(unwritten, '1.7.0')).toThrow(/is missing/)
    mkdirSync(join(unwritten, 'nested'))
    expect(() => checksums.writeWindowsChecksums(unwritten, '1.7.0')).toThrow(/must hold only/)
  })

  it('is what the workflow uploads, and only once every requirement held', () => {
    const text = workflow()
    expect(text).toContain('node "$env:MSI/checksums.mjs" --dir build/msi/artifact --version $base.version')
    const upload = text.slice(text.indexOf('name: windows-x64-msi-unsigned') - 200)
    expect(upload).toContain('if: ${{ success() }}')
    expect(upload).toContain('build/msi/artifact/Agent-Inbox-v*-windows-x64.msi\n            build/msi/artifact/SHA256SUMS-windows.txt\n')
    expect(upload).toContain('if-no-files-found: error')
    expect(text).toContain('node "$env:MSI/summary.mjs" --evidence build/msi')
  })
})

describe('Windows MSI scope (#87 PR 2b)', () => {
  it('signs, publishes and releases nothing, and gives the update manifest no Windows target (#343)', () => {
    for (const { name, text } of everything()) {
      expect(text, name).not.toMatch(/signtool\s+sign|Set-AuthenticodeSignature|certificateFile|AzureSignTool/i)
    }
    expect(workflow()).not.toMatch(/update-manifest|release-aggregate|update-keys/)
    const manifest = read(join(root, 'electron', 'update-manifest.cjs'))
    const specs = manifest.slice(manifest.indexOf('const TARGET_SPECS'), manifest.indexOf('])', manifest.indexOf('const TARGET_SPECS')))
    expect(specs).not.toMatch(/win32|windows|msi/i)
  })

  it('runs in package smoke', () => {
    const pkg = JSON.parse(read(join(root, 'package.json')))
    expect(pkg.scripts['package:smoke']).toContain('test/windows-msi.test.ts')
  })
})
