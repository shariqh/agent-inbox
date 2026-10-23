#Requires -Version 7.2
<#
  #87 installer spike (CI only): drive one installer through its whole lifecycle
  as a fresh, disposable standard user, and compare every installed tree with the
  verified folder it came from. Runs as the runner's administrator only to create
  that user and to read the user's profile afterwards; every installer, Squirrel
  and app action runs through as-user.ps1 with the standard user's token.
#>
param(
  [Parameter(Mandatory)][ValidateSet('msi', 'squirrel')][string]$Kind,
  [Parameter(Mandatory)][string]$Build,
  [Parameter(Mandatory)][string]$Folders,
  [Parameter(Mandatory)][string]$Shared,
  [Parameter(Mandatory)][string]$UserName,
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$Out
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$tools = Get-Content -Raw (Join-Path $PSScriptRoot 'tools.json') | ConvertFrom-Json
$verified = Get-Content -Raw $Folders | ConvertFrom-Json
$builds = @{
  base = Get-Content -Raw (Join-Path $Build 'base.json') | ConvertFrom-Json
  upgrade = Get-Content -Raw (Join-Path $Build 'upgrade.json') | ConvertFrom-Json
}
$tree = Join-Path $PSScriptRoot 'tree.mjs'
$pwsh = (Get-Command pwsh).Source

# A workspace the standard user can read and write.
$work = Join-Path $Shared $Kind
New-Item -ItemType Directory -Force (Join-Path $work 'results'), (Join-Path $work 'logs'), (Join-Path $work 'installers') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'as-user.ps1') $work -Force
$installers = @{}
foreach ($side in 'base', 'upgrade') {
  $source = if ($Kind -eq 'msi') { Join-Path $Build $builds[$side].msi.name } else { Join-Path $Build "$side\$($builds[$side].setup.name)" }
  $installers[$side] = Join-Path $work "installers\$(Split-Path -Leaf $source)"
  Copy-Item $source $installers[$side] -Force
}
$releases = $null
if ($Kind -eq 'squirrel') {
  $releases = Join-Path $work 'releases-upgrade'
  New-Item -ItemType Directory -Force $releases | Out-Null
  Copy-Item (Join-Path $Build 'upgrade\RELEASES'), (Join-Path $Build "upgrade\$($builds.upgrade.nupkg.name)") $releases -Force
}

# The disposable standard user. Its password exists only in this process.
$password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)) + 'aA1!'
Write-Host "::add-mask::$password"
$computer = [ADSI]"WinNT://$env:COMPUTERNAME,computer"
$account = $computer.Create('User', $UserName)
$account.SetPassword($password)
$account.Put('Description', 'Agent Inbox installer spike (disposable)')
$account.SetInfo()
$account.Put('UserFlags', [int]$account.UserFlags.Value -bor 0x10000)
$account.SetInfo()
try { ([ADSI]"WinNT://$env:COMPUTERNAME/Users,group").Add("WinNT://$env:COMPUTERNAME/$UserName,user") } catch {}
# Each step also proves its own token is not an administrator's (as-user.ps1).
try {
  $administrators = @(([ADSI]"WinNT://$env:COMPUTERNAME/Administrators,group").Invoke('Members') |
    ForEach-Object { $_.GetType().InvokeMember('Name', 'GetProperty', $null, $_, $null) })
} catch {
  $administrators = @()
}
if ($administrators -contains $UserName) { throw "$UserName must not be an administrator" }
& icacls.exe $Shared /grant "${UserName}:(OI)(CI)M" /T /Q | Out-Null
$credential = [pscredential]::new("$env:COMPUTERNAME\$UserName", (ConvertTo-SecureString $password -AsPlainText -Force))

$steps = [ordered]@{}
$checks = [ordered]@{}
$script:index = 0

function Invoke-Step([string]$Label, [hashtable]$Parameters) {
  $script:index += 1
  $name = '{0:d2}-{1}' -f $script:index, $Label
  $paramsFile = Join-Path $work "results\$name.params.json"
  $outFile = Join-Path $work "results\$name.json"
  $Parameters.label = $name
  $Parameters.kind = $Kind
  $Parameters.out = $outFile
  $Parameters.logDir = Join-Path $work 'logs'
  $Parameters.port = $Port
  $Parameters.identity = $tools.identity
  $Parameters | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $paramsFile
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $work 'as-user.ps1')`" -ParamsFile `"$paramsFile`""
  $process = Start-Process -FilePath $pwsh -ArgumentList $arguments -Credential $credential -LoadUserProfile `
    -WorkingDirectory $work -PassThru
  $null = $process.Handle
  if (-not $process.WaitForExit(1500 * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "$Kind step $name timed out"
  }
  if (-not (Test-Path $outFile)) { throw "$Kind step $name wrote no result (pwsh exit $($process.ExitCode))" }
  $result = Get-Content -Raw $outFile | ConvertFrom-Json -AsHashtable
  if ($result.user.isAdministrator -or $result.user.name -ne $UserName) {
    throw "$Kind step $name did not run as the standard user $UserName"
  }
  $run = if ($result.run) { "exit $($result.run.exitCode) in $($result.run.seconds)s" } else { "done in $($result.seconds)s" }
  $errorText = if ($result.error) { "; ERROR: $($result.error)" } else { '' }
  Write-Host "[$Kind] $name ($($result.user.name), $($result.user.integrity)): $run; app $($result.state.appDirectory)$errorText"
  $steps[$name] = $result
  return $result
}

function Measure-Installed([string]$Name, [hashtable]$Result, [string]$Side) {
  $directory = $Result.state.appDirectoryFull
  $record = [ordered]@{ step = $Name; side = $Side; installed = [bool]$directory }
  if ($directory) {
    $arguments = @($tree, '--root', $directory, '--compare', $verified.$Side.root)
    if ($Kind -eq 'squirrel') { $arguments += @('--exclude', 'squirrel.exe') }
    $measured = & node @arguments | ConvertFrom-Json -AsHashtable
    $userLength = $Result.user.name.Length
    $deepest = $directory.Length + 1 + $measured.deepestRelativeLength
    $record.appDirectory = $Result.state.appDirectory
    $record.digest = $measured.digest
    $record.matchesVerified = $measured.digest -eq $verified.$Side.appTreeDigest
    $record.compare = $measured.compare
    $record.deepestPath = [ordered]@{
      relative = $measured.deepestRelative
      fullLength = $deepest
      userNameLength = $userLength
      # MAX_PATH is 260 including the terminating NUL.
      maxUserNameLength = 259 - ($deepest - $userLength)
    }
  }
  $profileDir = $Result.user.profile
  $root = if ($Kind -eq 'msi') { Join-Path $profileDir "AppData\Local\Programs\$($tools.identity.productName)" } else {
    Join-Path $profileDir "AppData\Local\$($tools.identity.squirrelPackageId)"
  }
  if (Test-Path -LiteralPath $root) {
    $footprint = & node $tree --root $root | ConvertFrom-Json -AsHashtable
    $record.footprint = [ordered]@{ root = $root.Replace($profileDir, '%USERPROFILE%'); files = $footprint.files; bytes = $footprint.bytes }
  }
  $checks[$Name] = $record
  Write-Host "[$Kind] $Name tree vs verified ${Side}: matches=$($record.matchesVerified)"
  return $record
}

$failure = $null
try {
  Invoke-Step 'baseline' @{ action = 'baseline' } | Out-Null
  $installed = Invoke-Step 'install-base' @{ action = 'install'; installer = $installers.base }
  Measure-Installed 'install-base' $installed 'base' | Out-Null
  if ($Kind -eq 'squirrel') { Invoke-Step 'shortcut-like-squirrel-startup' @{ action = 'squirrel-shortcut' } | Out-Null }
  Invoke-Step 'launch-base' @{ action = 'launch' } | Out-Null

  $upgraded = Invoke-Step 'upgrade-while-running' @{ action = 'upgrade'; installer = $installers.upgrade; whileRunning = $true }
  $measured = Measure-Installed 'upgrade-while-running' $upgraded 'upgrade'
  if ($upgraded.run.exitCode -ne 0 -or -not $measured.matchesVerified) {
    $upgraded = Invoke-Step 'upgrade' @{ action = 'upgrade'; installer = $installers.upgrade; whileRunning = $false }
    Measure-Installed 'upgrade' $upgraded 'upgrade' | Out-Null
  }
  Invoke-Step 'launch-upgrade' @{ action = 'launch' } | Out-Null

  if ($Kind -eq 'msi') {
    $productCode = $builds.upgrade.productCode
    $repaired = Invoke-Step 'repair-with-source' @{
      action = 'repair'; productCode = $productCode
      deleteFiles = @("$($tools.identity.productName).exe", 'resources\app\dist\store.js')
    }
    Measure-Installed 'repair-with-source' $repaired 'upgrade' | Out-Null
    Rename-Item -LiteralPath $installers.upgrade -NewName "$(Split-Path -Leaf $installers.upgrade).moved"
    try {
      $sourceless = Invoke-Step 'repair-without-source' @{
        action = 'repair'; productCode = $productCode; deleteFiles = @('resources\app\dist\store.js')
      }
    } finally {
      Rename-Item -LiteralPath "$($installers.upgrade).moved" -NewName (Split-Path -Leaf $installers.upgrade)
    }
    Measure-Installed 'repair-without-source' $sourceless 'upgrade' | Out-Null
    if (-not $checks['repair-without-source'].matchesVerified) {
      $restored = Invoke-Step 'repair-after-source-returns' @{ action = 'repair'; productCode = $productCode; deleteFiles = @() }
      Measure-Installed 'repair-after-source-returns' $restored 'upgrade' | Out-Null
    }
    Invoke-Step 'uninstall' @{ action = 'uninstall'; productCode = $productCode } | Out-Null
  } else {
    Invoke-Step 'uninstall' @{ action = 'uninstall' } | Out-Null
    $again = Invoke-Step 'install-base-again' @{ action = 'install'; installer = $installers.base }
    Measure-Installed 'install-base-again' $again 'base' | Out-Null
    $updated = Invoke-Step 'update-with-update-exe' @{ action = 'squirrel-update'; releasesDir = $releases }
    Measure-Installed 'update-with-update-exe' $updated 'upgrade' | Out-Null
    Invoke-Step 'launch-after-update' @{ action = 'launch' } | Out-Null
    Invoke-Step 'uninstall-after-update' @{ action = 'uninstall' } | Out-Null
  }
} catch {
  $failure = "$_"
  Write-Host "::error::[$Kind] lifecycle stopped: $failure"
  Write-Host "$($_.InvocationInfo.PositionMessage)`n$($_.ScriptStackTrace)"
} finally {
  [ordered]@{
    schema = 1
    kind = $Kind
    userName = $UserName
    failure = $failure
    steps = $steps
    checks = $checks
  } | ConvertTo-Json -Depth 16 | Set-Content -Encoding utf8 $Out
  try { $computer.Delete('User', $UserName) } catch { Write-Host "could not delete $UserName`: $_" }
}
if ($failure) { exit 1 }
