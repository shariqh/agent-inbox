#Requires -Version 7.2
<#
  #87 installer spike (CI only): build the per-user MSI from one verified
  Windows folder with the pinned WiX tool, then read back the identity the
  lifecycle checks and run ICE validation as a recorded measurement.
#>
param(
  [Parameter(Mandatory)][string]$App,
  [Parameter(Mandatory)][string]$Output,
  [Parameter(Mandatory)][string]$Wix,
  [Parameter(Mandatory)][string]$Icon,
  [Parameter(Mandatory)][string]$Report
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$tools = Get-Content -Raw (Join-Path $PSScriptRoot 'tools.json') | ConvertFrom-Json
$version = (Get-Content -Raw (Join-Path $App 'resources\app\package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "an MSI ProductVersion holds only major.minor.patch; the folder is $version"
}
New-Item -ItemType Directory -Force $Output | Out-Null
$msi = Join-Path $Output "AgentInbox-$version-x64.msi"
$intermediate = Join-Path $Output "obj-$version"
$identity = $tools.identity

$timer = [Diagnostics.Stopwatch]::StartNew()
& $Wix build (Join-Path $PSScriptRoot 'agent-inbox.wxs') -nologo -arch x64 `
  -d "AppDir=$App" `
  -d "Version=$version" `
  -d "IconFile=$Icon" `
  -d "ProductName=$($identity.productName)" `
  -d "Manufacturer=$($identity.manufacturer)" `
  -d "UpgradeCode=$($identity.upgradeCode)" `
  -d "AppUserModelId=$($identity.appUserModelId)" `
  -d "ToastActivatorClsid=$($identity.toastActivatorClsid)" `
  -intermediateFolder $intermediate `
  -pdbtype none `
  -o $msi
$timer.Stop()
Remove-Item -Recurse -Force $intermediate -ErrorAction SilentlyContinue

$installer = New-Object -ComObject WindowsInstaller.Installer
function Get-Rows([object]$Database, [string]$Query) {
  $view = $Database.OpenView($Query)
  $view.Execute()
  $rows = [Collections.Generic.List[object]]::new()
  while ($null -ne ($record = $view.Fetch())) {
    $fields = for ($i = 1; $i -le $record.FieldCount; $i++) { $record.StringData($i) }
    $rows.Add(@($fields))
  }
  $view.Close()
  return , $rows
}
$database = $installer.OpenDatabase($msi, 0)
$property = @{}
foreach ($row in (Get-Rows $database 'SELECT `Property`, `Value` FROM `Property`')) { $property[$row[0]] = $row[1] }
$summary = $installer.SummaryInformation($msi, 0)
$wordCount = [int]$summary.Property(15)
$report = [ordered]@{
  schema = 1
  kind = 'msi'
  version = $version
  seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)
  wix = "$(& $Wix --version)".Trim()
  msi = [ordered]@{
    name = Split-Path -Leaf $msi
    bytes = (Get-Item $msi).Length
    sha256 = (Get-FileHash -Algorithm SHA256 $msi).Hash.ToLowerInvariant()
  }
  productCode = $property['ProductCode']
  productVersion = $property['ProductVersion']
  upgradeCode = $property['UpgradeCode']
  allUsers = $property['ALLUSERS']
  template = "$($summary.Property(7))"
  wordCount = $wordCount
  elevationNotRequired = [bool]($wordCount -band 8)
  files = (Get-Rows $database 'SELECT `File` FROM `File`').Count
  components = (Get-Rows $database 'SELECT `Component` FROM `Component`').Count
  shortcuts = @((Get-Rows $database 'SELECT `Shortcut`, `Directory_`, `Name`, `Target` FROM `Shortcut`') |
    ForEach-Object { [ordered]@{ id = $_[0]; directory = $_[1]; name = $_[2]; target = $_[3] } })
  shortcutProperties = @((Get-Rows $database 'SELECT `PropertyKey`, `PropVariantValue` FROM `MsiShortcutProperty`') |
    ForEach-Object { [ordered]@{ key = $_[0]; value = $_[1] } })
}
[Runtime.InteropServices.Marshal]::ReleaseComObject($database) | Out-Null

# ICE validation is a measurement, not a gate: WiX documents that Files harvesting in a
# per-user package does not pass ICE validation.
$PSNativeCommandUseErrorActionPreference = $false
$iceOutput = @(& $Wix msi validate -nologo $msi 2>&1 | ForEach-Object { "$_" })
$iceExit = $LASTEXITCODE
$PSNativeCommandUseErrorActionPreference = $true
$ices = [ordered]@{}
foreach ($line in $iceOutput) {
  if ($line -match '\b(error|warning)\b[^:]*:\s*(ICE\d+)') {
    $key = "$($Matches[2]) $($Matches[1])"
    $ices[$key] = 1 + ($ices[$key] ?? 0)
  }
}
$report.ice = [ordered]@{
  exitCode = $iceExit
  counts = $ices
  sample = @($iceOutput | Select-Object -First 12)
}
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $Report
Write-Host "Built $($report.msi.name) ($($report.msi.bytes) bytes) in $($report.seconds)s; ICE exit $iceExit"
