#Requires -Version 7.2
<#
  #87 PR 2b: build the per-user MSI from one verified Windows folder with the pinned
  WiX on its pinned .NET runtime (install-tools.ps1), then read the package back and
  refuse any difference from the identity the installer must keep. -Validate also
  runs ICE validation as a gate.
#>
param(
  [Parameter(Mandatory)][string]$App,
  [Parameter(Mandatory)][string]$Output,
  [Parameter(Mandatory)][string]$Tools,
  [Parameter(Mandatory)][string]$Icon,
  [Parameter(Mandatory)][string]$Inputs,
  [Parameter(Mandatory)][string]$Report,
  [switch]$Validate
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
trap { Write-Host "build-msi.ps1 failed: $_`n$($_.InvocationInfo.PositionMessage)`n$($_.ScriptStackTrace)"; break }

$pins = Get-Content -Raw (Join-Path $PSScriptRoot 'installer.json') | ConvertFrom-Json
$installed = Get-Content -Raw $Tools | ConvertFrom-Json
$release = Get-Content -Raw $Inputs | ConvertFrom-Json
$App = [IO.Path]::GetFullPath($App)
$appPackage = Get-Content -Raw (Join-Path $App 'resources\app\package.json') | ConvertFrom-Json
$version = $appPackage.version
# A ProductVersion holds only major.minor.build, at most 255.255.65535, and a major
# upgrade compares exactly those three fields: a prerelease has no MSI version.
$fields = [regex]::Match("$version", '^(\d{1,3})\.(\d{1,3})\.(\d{1,5})$')
if (-not $fields.Success -or [int]$fields.Groups[1].Value -gt 255 -or [int]$fields.Groups[2].Value -gt 255 -or
    [int]$fields.Groups[3].Value -gt 65535) {
  throw "an MSI ProductVersion holds only major.minor.patch up to 255.255.65535; the folder is $version"
}
$minimum = [regex]::Match("$($release.minimumWindowsVersion)", '^10\.0\.(\d+)$')
if (-not $minimum.Success) { throw "minimumWindowsVersion $($release.minimumWindowsVersion) is not a Windows 10 or 11 build" }
$product = $release.product
New-Item -ItemType Directory -Force $Output | Out-Null
$msi = [IO.Path]::GetFullPath((Join-Path $Output "Agent-Inbox-v$version-windows-x64.msi"))
$intermediate = [IO.Path]::GetFullPath((Join-Path $Output "obj-$version"))

# WiX runs only on the pinned runtime, with no variable pointing the host elsewhere.
Get-ChildItem Env: | Where-Object { $_.Name -match '^(DOTNET_|COREHOST_)' } | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$dotnet = $installed.dotnet.muxer
$wixDll = $installed.wix.entryPoint
function Invoke-Wix([string[]]$Arguments) {
  & $dotnet exec --fx-version $pins.dotnet.version $wixDll @Arguments
}
# The project owner accepted the WiX Toolset Open Source Maintenance Fee EULA (v1.1,
# EULA ID wix7) on 2026-10-23. -acceptEula is WiX's documented switch for build
# scripts and CI; every WiX command here that needs the acceptance passes it, and
# nothing records a per-user acceptance on the runner.
$acceptEula = @('-acceptEula', $pins.wix.eulaId)

$timer = [Diagnostics.Stopwatch]::StartNew()
Invoke-Wix @(
  'build'
  $acceptEula
  (Join-Path $PSScriptRoot 'agent-inbox.wxs')
  '-arch', 'x64'
  '-wx'
  '-d', "AppDir=$App"
  '-d', "Version=$version"
  '-d', "IconFile=$Icon"
  '-d', "ProductName=$product"
  '-d', "Manufacturer=$($appPackage.author)"
  '-d', "UpgradeCode=$($pins.identity.upgradeCode)"
  '-d', "AppUserModelId=$($release.bundleId)"
  '-d', "ToastActivatorClsid=$($pins.identity.toastActivatorClsid)"
  '-d', "MinimumWindowsBuild=$($minimum.Groups[1].Value)"
  '-intermediateFolder', $intermediate
  '-pdbtype', 'none'
  '-o', $msi
)
$timer.Stop()
Remove-Item -Recurse -Force $intermediate -ErrorAction SilentlyContinue

# Late-bound Windows Installer automation, called through IDispatch explicitly:
# PowerShell's COM adapter does not resolve every parameterized property.
function Invoke-Com([object]$Target, [string]$Name, [Reflection.BindingFlags]$Kind, [object[]]$Arguments = @()) {
  return $Target.GetType().InvokeMember($Name, $Kind, $null, $Target, $Arguments)
}
$method = [Reflection.BindingFlags]::InvokeMethod
$get = [Reflection.BindingFlags]::GetProperty
$installer = New-Object -ComObject WindowsInstaller.Installer
function Get-Rows([object]$Database, [string]$Query) {
  $view = Invoke-Com $Database 'OpenView' $method @($Query)
  Invoke-Com $view 'Execute' $method | Out-Null
  $rows = [Collections.Generic.List[object]]::new()
  while ($null -ne ($record = Invoke-Com $view 'Fetch' $method)) {
    $count = [int](Invoke-Com $record 'FieldCount' $get)
    $fields = [object[]]::new($count)
    for ($i = 1; $i -le $count; $i++) { $fields[$i - 1] = Invoke-Com $record 'StringData' $get @($i) }
    $rows.Add($fields)
  }
  Invoke-Com $view 'Close' $method | Out-Null
  return , $rows
}
$database = Invoke-Com $installer 'OpenDatabase' $method @($msi, 0)
$property = @{}
foreach ($row in (Get-Rows $database 'SELECT `Property`, `Value` FROM `Property`')) { $property[$row[0]] = $row[1] }
$summary = Invoke-Com $installer 'SummaryInformation' $get @($msi, 0)
$wordCount = [int](Invoke-Com $summary 'Property' $get @(15))
$clsidKey = "Software\Classes\CLSID\$($pins.identity.toastActivatorClsid)"
$built = [ordered]@{
  schema = 1
  kind = 'msi'
  version = $version
  seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)
  wix = $installed.wix.reportedVersion
  dotnet = "$($pins.dotnet.framework) $($pins.dotnet.version)"
  msi = [ordered]@{
    name = Split-Path -Leaf $msi
    bytes = (Get-Item $msi).Length
    sha256 = (Get-FileHash -Algorithm SHA256 $msi).Hash.ToLowerInvariant()
  }
  productName = $property['ProductName']
  manufacturer = $property['Manufacturer']
  productCode = $property['ProductCode']
  productVersion = $property['ProductVersion']
  upgradeCode = $property['UpgradeCode']
  allUsers = $property['ALLUSERS']
  template = "$(Invoke-Com $summary 'Property' $get @(7))"
  wordCount = $wordCount
  elevationNotRequired = [bool]($wordCount -band 8)
  files = (Get-Rows $database 'SELECT `File` FROM `File`').Count
  folderFiles = @(Get-ChildItem -LiteralPath $App -Recurse -File -Force).Count
  components = (Get-Rows $database 'SELECT `Component` FROM `Component`').Count
  shortcuts = @((Get-Rows $database 'SELECT `Shortcut`, `Directory_`, `Name`, `Target` FROM `Shortcut`') |
    ForEach-Object { [ordered]@{ id = $_[0]; directory = $_[1]; name = $_[2]; target = $_[3] } })
  shortcutProperties = @((Get-Rows $database 'SELECT `PropertyKey`, `PropVariantValue` FROM `MsiShortcutProperty`') |
    ForEach-Object { [ordered]@{ key = $_[0]; value = $_[1] } })
  toastActivator = @((Get-Rows $database 'SELECT `Root`, `Key`, `Name`, `Value` FROM `Registry`') |
    Where-Object { $_[1] -like "$clsidKey*" } |
    ForEach-Object { [ordered]@{ root = $_[0]; key = $_[1]; name = $_[2]; value = $_[3] } })
  launchConditions = @((Get-Rows $database 'SELECT `Condition`, `Description` FROM `LaunchCondition`') |
    ForEach-Object { [ordered]@{ condition = $_[0]; message = $_[1] } })
}
[Runtime.InteropServices.Marshal]::ReleaseComObject($database) | Out-Null

# The identity every later version must keep, read back from the package itself.
$failures = [Collections.Generic.List[string]]::new()
$expect = { param($Label, $Actual, $Expected) if ("$Actual" -cne "$Expected") { $failures.Add("$Label is '$Actual', expected '$Expected'") } }
& $expect 'ProductName' $built.productName $product
& $expect 'Manufacturer' $built.manufacturer $appPackage.author
& $expect 'ProductVersion' $built.productVersion $version
& $expect 'UpgradeCode' $built.upgradeCode $pins.identity.upgradeCode
& $expect 'ALLUSERS (unset in a per-user package)' $built.allUsers ''
& $expect 'elevation not required' $built.elevationNotRequired $true
& $expect 'template' $built.template 'x64;1033'
& $expect 'files' $built.files $built.folderFiles
& $expect 'shortcuts' (@($built.shortcuts | ForEach-Object { "$($_.directory)|$(($_.name -split '\|')[-1])|$($_.target)" }) -join ';') `
  "ProgramMenuFolder|$product|[INSTALLFOLDER]$product.exe"
& $expect 'shortcut properties' (@($built.shortcutProperties | ForEach-Object { "$($_.key)=$($_.value)" } | Sort-Object) -join ';') `
  "System.AppUserModel.ID=$($release.bundleId);System.AppUserModel.ToastActivatorCLSID=$($pins.identity.toastActivatorClsid)"
& $expect 'toast activator LocalServer32' (@($built.toastActivator | Where-Object { $_.key -like '*\LocalServer32' } | ForEach-Object value) -join ';') `
  "`"[INSTALLFOLDER]$product.exe`""
$minimumCondition = "Installed OR AGENTINBOXWINDOWSBUILD >= $($minimum.Groups[1].Value)"
& $expect 'minimum Windows launch condition' (@($built.launchConditions | Where-Object { $_.condition -ceq $minimumCondition }).Count) 1
if ($failures.Count -gt 0) { throw "the MSI does not carry the installer identity: $($failures -join '; ')" }

if ($Validate) {
  # ICE38, ICE64 and ICE91 hold a per-user package to a per-machine or roaming layout:
  # WiX documents that Files in a per-user package trips them, and the lifecycle
  # proves what they guard (every installed file and folder is removed on uninstall).
  # ICE61 flags an upgrade that also removes its own version. AllowSameVersionUpgrades
  # does that on purpose, so a second build of one version replaces the installed one
  # instead of becoming a second product; the lifecycle proves the replacement and
  # its clean uninstall. Every other ICE, and every warning, fails the build.
  $suppressed = @('ICE38', 'ICE61', 'ICE64', 'ICE91')
  $timer = [Diagnostics.Stopwatch]::StartNew()
  Invoke-Wix @('msi', 'validate'; $acceptEula; '-wx'; $suppressed | ForEach-Object { '-sice', $_ }; $msi)
  $built.validation = [ordered]@{ passed = $true; suppressed = $suppressed; seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1) }
}
$built | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $Report
Write-Host "Built $($built.msi.name) ($($built.msi.bytes) bytes, sha256 $($built.msi.sha256)) in $($built.seconds)s"
