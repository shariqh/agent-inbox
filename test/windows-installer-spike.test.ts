import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// #87 PR 2a: the installer spike is CI-only, but it runs third-party installer
// tooling on a runner, so every tool it fetches must stay pinned and verified.
const root = resolve(process.cwd())
const spikeDir = join(root, '.github', 'windows-installer-spike')
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const workflow = (): string => read(join(root, '.github', 'workflows', 'windows-installer-spike.yml'))
const spikeFiles = (): { name: string, text: string }[] => readdirSync(spikeDir)
  .filter((name) => name !== 'node_modules' && !name.endsWith('.json'))
  .map((name) => ({ name, text: read(join(spikeDir, name)) }))
const everything = (): { name: string, text: string }[] => [{ name: 'workflow', text: workflow() }, ...spikeFiles()]

type Tools = {
  wix: { package: string, version: string, url: string, sha512: string, sha256: string, sourceCommit: string, license: string }
  squirrel: { package: string, version: string, integrity: string, license: string }
  identity: Record<string, string>
}
const tools = (): Tools => JSON.parse(read(join(spikeDir, 'tools.json')))

describe('Windows installer spike workflow (#87)', () => {
  it('runs only on dispatch or a change to its own files, read-only and secret-free', () => {
    const text = workflow()
    const trigger = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'))
    expect(trigger).toContain('  workflow_dispatch:\n')
    expect(trigger.match(/^\s+- "([^"]+)"$/gm)?.map((line) => line.trim())).toEqual([
      '- ".github/workflows/windows-installer-spike.yml"',
      '- ".github/workflows/windows-native-folder.yml"',
      '- ".github/windows-installer-spike/**"',
      '- "test/windows-installer-spike.test.ts"',
    ])
    expect(trigger).not.toMatch(/push:|pull_request_target|workflow_run|schedule:/)
    expect(text).toContain('permissions:\n  contents: read\n')
    expect(text).not.toMatch(/secrets\.|contents: write|id-token|gh release|release create|release upload/)
    for (const runner of text.matchAll(/runs-on: (\S+)/g)) expect(runner[1]).toBe('windows-2022')
  })

  it('builds the base installers from the reused, verified folder workflow', () => {
    const text = workflow()
    expect(text).toMatch(/^ {2}folder:\n {4}name: Verified folder\n {4}uses: \.\/\.github\/workflows\/windows-native-folder\.yml\n/m)
    expect(text).not.toMatch(/uses: \.\/[^\n]*@/)
    expect(read(join(root, '.github', 'workflows', 'windows-native-folder.yml'))).toMatch(/^ {2}workflow_call:\n/m)
    expect(text).toContain('needs: [folder, upgrade-folder]')
    expect(text).toContain('name: native-win32-x64-folder-inputs')
    expect(text).toContain('prepare-folders.mjs')
    const prepare = read(join(spikeDir, 'prepare-folders.mjs'))
    expect(prepare).toContain('tree.digest !== report.appTreeDigest')
    expect(prepare).toContain("extractTreeArchive({")
    // The upgrade folder comes from the same builder, which verifies what it builds.
    expect(text).toContain('npm run package:windows-thin --')
    expect(text).toContain('AGENT_INBOX_RELEASE_SOURCE_SHA=$(git rev-parse HEAD)')
  })

  it('pins WiX by exact version and nuget.org package hash, and installs only that file', () => {
    const { wix } = tools()
    expect(wix.package).toBe('wix')
    expect(wix.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(wix.url).toBe(`https://api.nuget.org/v3-flatcontainer/wix/${wix.version}/wix.${wix.version}.nupkg`)
    expect(wix.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/)
    expect(wix.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(wix.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    const install = read(join(spikeDir, 'install-wix.ps1'))
    // A failed check must stop the script, so each guard is pinned with its throw, in order.
    expect(install).toContain("\n$ErrorActionPreference = 'Stop'\n$PSNativeCommandUseErrorActionPreference = $true\n")
    expect(install).toMatch(/^trap \{[^\n]*; break \}$/m)
    const steps = [
      'Invoke-WebRequest -Uri $pin.url -OutFile $nupkg',
      '[Security.Cryptography.SHA512]::HashData($bytes)',
      '[Security.Cryptography.SHA256]::HashData($bytes)',
      'if ($sha512 -cne $pin.sha512 -or $sha256 -cne $pin.sha256) {\n  throw "WiX $($pin.version) package digest mismatch',
      '<clear />',
      '$env:NUGET_PACKAGES = $packages',
      'dotnet tool install $pin.package --version $pin.version --tool-path $toolPath --configfile $config',
      'if (-not $reported.StartsWith("$($pin.version)+$($pin.sourceCommit.Substring(0, 8))")) {\n  throw "installed WiX reports',
      "if (@($store | Where-Object { $_.path -like '*.nupkg' -and $_.sha256 -ne $pin.sha256 }).Count -gt 0) {\n  throw 'the tool store holds a WiX package other than the verified one'",
      '| Set-Content -Encoding utf8 -LiteralPath $Report',
    ]
    const at = steps.map((step) => install.indexOf(step))
    steps.forEach((step, index) => expect(at[index], step).toBeGreaterThan(-1))
    expect(at, 'install-wix.ps1 runs its checks in this order').toEqual([...at].sort((a, b) => a - b))
    for (const { name, text } of everything()) {
      if (name === 'install-wix.ps1') continue
      expect(text, `${name} must install no other .NET tool or package`).not.toMatch(/dotnet (tool|add)|nuget(\.exe)? install|wix extension/i)
    }
  })

  it('never accepts a WiX EULA on the owner\'s behalf', () => {
    expect(tools().wix.license).toBe('MS-RL')
    for (const { name, text } of everything()) {
      expect(text, name).not.toMatch(/acceptEula|eula accept|AcceptEula/i)
    }
  })

  it('pins the Squirrel tooling by lockfile and installs it without lifecycle scripts', () => {
    const { squirrel } = tools()
    const manifest = JSON.parse(read(join(spikeDir, 'package.json')))
    expect(manifest.dependencies).toEqual({ [squirrel.package]: squirrel.version })
    expect(manifest.devDependencies).toBeUndefined()
    const lock = JSON.parse(read(join(spikeDir, 'package-lock.json')))
    expect(lock.lockfileVersion).toBe(3)
    const locked = lock.packages[`node_modules/${squirrel.package}`]
    expect(locked.version).toBe(squirrel.version)
    expect(locked.integrity).toBe(squirrel.integrity)
    for (const [path, entry] of Object.entries<{ resolved?: string, integrity?: string }>(lock.packages)) {
      if (path === '') continue
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//)
      expect(entry.integrity, path).toMatch(/^sha512-/)
    }
    const text = workflow()
    const commands = text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
    expect(text).toContain('working-directory: .github/windows-installer-spike')
    expect(text).toContain('npm ci --ignore-scripts --omit=optional --no-audit --no-fund')
    expect(commands.match(/\bnpm (ci|install|i|exec)\b[^\n]*/g)).toEqual([
      'npm ci',
      'npm ci --ignore-scripts --omit=optional --no-audit --no-fund',
    ])
    expect(commands).not.toMatch(/\bnpx\b/)
    expect(read(join(spikeDir, 'build-squirrel.mjs'))).toContain('locked?.integrity !== tools.squirrel.integrity')
  })

  it('downloads nothing but the pinned WiX package', () => {
    for (const { name, text } of everything()) {
      for (const [url] of text.matchAll(/https?:\/\/[^\s"'`<>)]+/g)) {
        const local = url.startsWith('http://127.0.0.1:')
        expect(
          local || ['http://wixtoolset.org/schemas/v4/wxs', 'http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd',
            'https://github.com/shariqh/agent-inbox'].includes(url),
          `${name} names ${url}`,
        ).toBe(true)
      }
      expect(text, name).not.toMatch(/\b(Invoke-RestMethod|Start-BitsTransfer|DownloadFile|curl|wget|choco|winget|Install-Module|Install-Package|setup-dotnet|actions\/cache)\b/i)
      const fetches = [...text.matchAll(/Invoke-WebRequest[^\n]*/g)].map((match) => match[0])
      for (const fetch of fetches) {
        expect(fetch, name).toMatch(/^Invoke-WebRequest (-Uri \$pin\.url -OutFile \$nupkg|-Method Head -Uri "http:\/\/127\.0\.0\.1:)/)
      }
    }
    expect(read(join(spikeDir, 'tools.json'))).not.toMatch(/http:\/\//)
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
  })

  it('measures every installer action as a standard user', () => {
    const lifecycle = read(join(spikeDir, 'lifecycle.ps1'))
    expect(lifecycle).toContain('-Credential $credential -LoadUserProfile')
    expect(lifecycle).toContain('$result.user.isAdministrator -or $result.user.name -ne $UserName')
    expect(lifecycle).toContain('Write-Host "::add-mask::$password"')
    const asUser = read(join(spikeDir, 'as-user.ps1'))
    expect(asUser).toContain('[Security.Principal.WindowsBuiltInRole]::Administrator')
    expect(asUser).toMatch(/msiexec\.exe', "\/i `"\$Installer`" \/qn/)
    expect(asUser).toContain("'--silent'")
    for (const step of ['install-base', 'upgrade-while-running', 'repair-with-source', 'repair-without-source', 'uninstall']) {
      expect(lifecycle).toContain(`'${step}'`)
    }
    // The machine policy the MSI run changes is put back, and its key is never re-created.
    expect(lifecycle).not.toMatch(/New-Item[^\n]*-Force[^\n]*\$policyKey|New-Item[^\n]*\$policyKey[^\n]*-Force/)
    expect(lifecycle.slice(lifecycle.lastIndexOf('} finally {'))).toContain(
      'Set-ItemProperty -LiteralPath $policyKey -Name DisableMSI -Value $policy.disableMsiBefore -Type $policy.disableMsiKind')
  })

  it('keeps the MSI per-user and its identity in tools.json', () => {
    const wxs = read(join(spikeDir, 'agent-inbox.wxs'))
    expect(wxs).toContain('Scope="perUser"')
    expect(wxs).toMatch(/<StandardDirectory Id="LocalAppDataFolder">\s*<Directory Id="UserProgramsFolder" Name="Programs">/)
    expect(wxs).toContain('<ShortcutProperty Key="System.AppUserModel.ID" Value="$(var.AppUserModelId)" />')
    expect(wxs).toContain('<ShortcutProperty Key="System.AppUserModel.ToastActivatorCLSID" Value="$(var.ToastActivatorClsid)" />')
    expect(wxs).not.toMatch(/Root="HKLM"|Id="ProgramFiles(64)?Folder"|perMachine|<CustomAction/)
    const { identity } = tools()
    expect(identity.upgradeCode).toMatch(/^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/)
    expect(identity.toastActivatorClsid).toMatch(/^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/)
    expect(identity.appUserModelId).toBe(JSON.parse(read(join(root, 'release', 'windows-inputs.json'))).bundleId)
  })

  it('signs, publishes and releases nothing, and leaves the update manifest alone', () => {
    for (const { name, text } of everything()) {
      expect(text, name).not.toMatch(/signtool\s+sign|Set-AuthenticodeSignature|signWithParams|windowsSign|certificateFile/i)
    }
    expect(workflow()).not.toMatch(/update-manifest|release-aggregate/)
    const manifest = read(join(root, 'electron', 'update-manifest.cjs'))
    const specs = manifest.slice(manifest.indexOf('const TARGET_SPECS'), manifest.indexOf('])', manifest.indexOf('const TARGET_SPECS')))
    expect(specs).not.toMatch(/win32|windows|msi|squirrel/i)
  })
})
