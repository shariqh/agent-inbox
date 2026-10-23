#Requires -Version 7.2
<#
  #87 PR 2b, CI only: drive the MSI through its whole lifecycle as a fresh,
  disposable standard user, and compare every installed tree with the verified
  folder it came from. Runs as the runner's administrator only to create that user,
  to set and restore one installer policy value, and to read the user's profile
  afterwards; every installer and app action runs through as-user.ps1 with the
  standard user's token.
#>
param(
  [Parameter(Mandatory)][string]$Build,
  [Parameter(Mandatory)][string]$Folders,
  [Parameter(Mandatory)][string]$Inputs,
  [Parameter(Mandatory)][string]$Shared,
  [Parameter(Mandatory)][string]$UserName,
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$Out
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$pins = Get-Content -Raw (Join-Path $PSScriptRoot 'installer.json') | ConvertFrom-Json
$release = Get-Content -Raw $Inputs | ConvertFrom-Json
$identity = [ordered]@{
  productName = $release.product
  appUserModelId = $release.bundleId
  toastActivatorClsid = $pins.identity.toastActivatorClsid
}
$verified = Get-Content -Raw $Folders | ConvertFrom-Json
$builds = @{
  base = Get-Content -Raw (Join-Path $Build 'base.json') | ConvertFrom-Json
  upgrade = Get-Content -Raw (Join-Path $Build 'upgrade.json') | ConvertFrom-Json
}
$tree = Join-Path $PSScriptRoot 'tree.mjs'
$pwsh = (Get-Command pwsh).Source

# A workspace the standard user can read and write.
$work = Join-Path $Shared 'msi'
New-Item -ItemType Directory -Force (Join-Path $work 'results'), (Join-Path $work 'logs'), (Join-Path $work 'installers') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'as-user.ps1'), (Join-Path $PSScriptRoot 'question.mjs') $work -Force
$installers = @{}
foreach ($side in 'base', 'upgrade') {
  $installers[$side] = Join-Path $work "installers\$($builds[$side].msi.name)"
  Copy-Item (Join-Path $Build $builds[$side].msi.name) $installers[$side] -Force
}

# The disposable standard user. Its password exists only in this process.
$password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)) + 'aA1!'
Write-Host "::add-mask::$password"
$computer = [ADSI]"WinNT://$env:COMPUTERNAME,computer"
$account = $computer.Create('User', $UserName)
$account.SetPassword($password)
$account.Put('Description', 'Agent Inbox MSI lifecycle (disposable)')
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
  $Parameters.out = $outFile
  $Parameters.logDir = Join-Path $work 'logs'
  $Parameters.port = $Port
  $Parameters.identity = $identity
  $Parameters.questionScript = Join-Path $work 'question.mjs'
  $Parameters | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $paramsFile
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $work 'as-user.ps1')`" -ParamsFile `"$paramsFile`""
  $stdout = Join-Path $work "results\$name.stdout.txt"
  $stderr = Join-Path $work "results\$name.stderr.txt"
  $process = Start-Process -FilePath $pwsh -ArgumentList $arguments -Credential $credential -LoadUserProfile `
    -WorkingDirectory $work -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $null = $process.Handle
  if (-not $process.WaitForExit(1500 * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "step $name timed out"
  }
  if (-not (Test-Path $outFile)) {
    $output = @($stdout, $stderr | Where-Object { Test-Path $_ } | ForEach-Object { Get-Content -Raw $_ }) -join "`n"
    throw "step $name wrote no result (pwsh exit $($process.ExitCode)): $output"
  }
  $result = Get-Content -Raw $outFile | ConvertFrom-Json -AsHashtable
  if ($result.user.isAdministrator -or $result.user.name -ne $UserName) {
    throw "step $name did not run as the standard user $UserName"
  }
  $run = if ($result.run) { "exit $($result.run.exitCode) in $($result.run.seconds)s" } else { "done in $($result.seconds)s" }
  $errorText = if ($result.error) { "; ERROR: $($result.error) $($result.errorAt)" } else { '' }
  Write-Host "[msi] $name ($($result.user.name), $($result.user.integrity), session $($result.user.session)): $run; app $($result.state.appDirectory)$errorText"
  $steps[$name] = $result
  return $result
}

function Measure-Installed([string]$Name, [hashtable]$Result, [string]$Side) {
  $directory = $Result.state.appDirectoryFull
  $record = [ordered]@{ step = $Name; side = $Side; installed = [bool]$directory }
  if ($directory) {
    $measured = & node $tree --root $directory --compare $verified.$Side.root | ConvertFrom-Json -AsHashtable
    $userLength = $Result.user.name.Length
    $deepest = $directory.Length + 1 + $measured.deepestRelativeLength
    $record.appDirectory = $Result.state.appDirectory
    $record.digest = $measured.digest
    $record.matchesVerified = $measured.digest -eq $verified.$Side.appTreeDigest
    $record.compare = $measured.compare
    $record.files = $measured.files
    $record.bytes = $measured.bytes
    $record.deepestPath = [ordered]@{
      relative = $measured.deepestRelative
      fullLength = $deepest
      userNameLength = $userLength
      # MAX_PATH is 260 including the terminating NUL.
      maxUserNameLength = 259 - ($deepest - $userLength)
    }
  }
  $checks[$Name] = $record
  Write-Host "[msi] $Name tree vs verified ${Side}: matches=$($record.matchesVerified)"
  return $record
}

$failure = $null
# The lifecycle changes one machine policy value, DisableMSI, and the finally below
# puts it back: the key is created only when missing, nothing else in it is touched,
# and a key this run created is removed again once it is empty.
$policyKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Installer'
$policy = [ordered]@{ keyExisted = $false; disableMsiBefore = $null; disableMsiKind = $null; keyCreated = $false; changed = $false }
$policyRead = Get-Item -LiteralPath $policyKey -ErrorAction SilentlyContinue
if ($policyRead) {
  $policy.keyExisted = $true
  if ($policyRead.GetValueNames() -contains 'DisableMSI') {
    $policy.disableMsiBefore = $policyRead.GetValue('DisableMSI', $null, 'DoNotExpandEnvironmentNames')
    $policy.disableMsiKind = "$($policyRead.GetValueKind('DisableMSI'))"
  }
}
$checks['installer-policy'] = $policy
try {
  Invoke-Step 'baseline' @{ action = 'baseline' } | Out-Null
  # Windows Server leaves DisableMSI unset, which blocks unelevated per-user
  # installs of unmanaged packages; Windows 10 and 11 allow them. Record the
  # server result, then measure everything else under the client default.
  $serverDefault = Invoke-Step 'install-under-server-policy' @{ action = 'install'; installer = $installers.base }
  if ($serverDefault.run.exitCode -eq 0) {
    Invoke-Step 'uninstall-after-server-policy' @{ action = 'uninstall'; productCode = $builds.base.productCode } | Out-Null
  }
  if (-not (Test-Path -LiteralPath $policyKey)) {
    New-Item -Path $policyKey | Out-Null
    $policy.keyCreated = $true
  }
  $policy.changed = $true
  Set-ItemProperty -LiteralPath $policyKey -Name DisableMSI -Value 0 -Type DWord
  $policy.disableMsiMeasured = (Get-ItemProperty -LiteralPath $policyKey -Name DisableMSI).DisableMSI

  $installed = Invoke-Step 'install-base' @{ action = 'install'; installer = $installers.base }
  Measure-Installed 'install-base' $installed 'base' | Out-Null
  Invoke-Step 'launch-base' @{ action = 'launch'; holdSeconds = 20 } | Out-Null
  Invoke-Step 'notify-with-shortcut' @{ action = 'notify'; withoutShortcut = $false } | Out-Null
  Invoke-Step 'notify-without-shortcut' @{ action = 'notify'; withoutShortcut = $true } | Out-Null
  Invoke-Step 'restart-manager' @{ action = 'restart-manager' } | Out-Null

  # The previous build is the MSI under test; the upgrade is this commit rebuilt
  # one patch version later.
  $upgraded = Invoke-Step 'upgrade-while-running' @{ action = 'upgrade'; installer = $installers.upgrade; whileRunning = $true }
  $measured = Measure-Installed 'upgrade-while-running' $upgraded 'upgrade'
  if ($upgraded.run.exitCode -ne 0 -or -not $measured.matchesVerified) {
    $upgraded = Invoke-Step 'upgrade' @{ action = 'upgrade'; installer = $installers.upgrade; whileRunning = $false }
    Measure-Installed 'upgrade' $upgraded 'upgrade' | Out-Null
  }
  Invoke-Step 'launch-upgrade' @{ action = 'launch' } | Out-Null

  $productCode = $builds.upgrade.productCode
  $repaired = Invoke-Step 'repair-with-source' @{
    action = 'repair'; productCode = $productCode
    deleteFiles = @("$($identity.productName).exe", 'resources\app\dist\store.js')
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
} catch {
  $failure = "$_"
  Write-Host "::error::[msi] lifecycle stopped: $failure"
  Write-Host "$($_.InvocationInfo.PositionMessage)`n$($_.ScriptStackTrace)"
} finally {
  if ($policy.changed -or $policy.keyCreated) {
    try {
      if ($null -eq $policy.disableMsiBefore) {
        Remove-ItemProperty -LiteralPath $policyKey -Name DisableMSI -ErrorAction SilentlyContinue
      } else {
        Set-ItemProperty -LiteralPath $policyKey -Name DisableMSI -Value $policy.disableMsiBefore -Type $policy.disableMsiKind
      }
      if ($policy.keyCreated) {
        $createdKey = Get-Item -LiteralPath $policyKey
        if ($createdKey.ValueCount -eq 0 -and $createdKey.SubKeyCount -eq 0) { Remove-Item -LiteralPath $policyKey }
      }
      $policyAfter = Get-Item -LiteralPath $policyKey -ErrorAction SilentlyContinue
      $policy.keyExistsAfter = $null -ne $policyAfter
      $policy.disableMsiAfter = if ($policyAfter -and $policyAfter.GetValueNames() -contains 'DisableMSI') {
        $policyAfter.GetValue('DisableMSI', $null, 'DoNotExpandEnvironmentNames')
      } else { $null }
      $sameValue = if ($null -eq $policy.disableMsiBefore) { $null -eq $policy.disableMsiAfter } else {
        $null -ne $policy.disableMsiAfter -and "$($policy.disableMsiAfter)" -ceq "$($policy.disableMsiBefore)"
      }
      $policy.restored = $sameValue -and $policy.keyExistsAfter -eq $policy.keyExisted
      if (-not $policy.restored) {
        throw "the Installer policy key exists=$($policy.keyExistsAfter) with DisableMSI=$($policy.disableMsiAfter ?? 'unset') after the run"
      }
    } catch {
      $policy.restored = $false
      $policy.restoreError = "$_"
      Write-Host "::error::[msi] could not restore the Windows Installer policy: $_"
      if (-not $failure) { $failure = "could not restore the Windows Installer policy: $_" }
    }
  }
  [ordered]@{
    schema = 1
    userName = $UserName
    failure = $failure
    steps = $steps
    checks = $checks
  } | ConvertTo-Json -Depth 16 | Set-Content -Encoding utf8 $Out
  try { $computer.Delete('User', $UserName) } catch { Write-Host "could not delete $UserName`: $_" }
}
if ($failure) { exit 1 }
