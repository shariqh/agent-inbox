#Requires -Version 7.2
<#
  #87 installer spike (CI only): install the WiX .NET tool pinned in tools.json.
  The package is downloaded from its exact nuget.org URL, must match both pinned
  digests (SHA-512 is nuget.org's own catalog packageHash), and is then installed
  from a private feed holding only that file, into an empty package cache, so no
  other source or cached copy can stand in for it.
#>
param(
  [Parameter(Mandatory)][string]$Destination,
  [Parameter(Mandatory)][string]$Report
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
trap { Write-Host "install-wix.ps1 failed: $_`n$($_.InvocationInfo.PositionMessage)`n$($_.ScriptStackTrace)"; break }

$pin = (Get-Content -Raw (Join-Path $PSScriptRoot 'tools.json') | ConvertFrom-Json).wix
$Destination = [IO.Path]::GetFullPath($Destination)
$feed = Join-Path $Destination 'feed'
$packages = Join-Path $Destination 'packages'
$toolPath = Join-Path $Destination 'tool'
if (Test-Path -LiteralPath $Destination) { throw "WiX destination already exists: $Destination" }
New-Item -ItemType Directory -Force $feed, $packages | Out-Null

$nupkg = Join-Path $feed "$($pin.package).$($pin.version).nupkg"
Invoke-WebRequest -Uri $pin.url -OutFile $nupkg
$bytes = [IO.File]::ReadAllBytes($nupkg)
$sha512 = [Convert]::ToBase64String([Security.Cryptography.SHA512]::HashData($bytes))
$sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
if ($sha512 -cne $pin.sha512 -or $sha256 -cne $pin.sha256) {
  throw "WiX $($pin.version) package digest mismatch: sha512 $sha512, sha256 $sha256"
}

$config = Join-Path $Destination 'nuget.config'
@"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="pinned-wix" value="$feed" />
  </packageSources>
</configuration>
"@ | Set-Content -Encoding utf8 -LiteralPath $config
$env:NUGET_PACKAGES = $packages
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
dotnet tool install $pin.package --version $pin.version --tool-path $toolPath --configfile $config

$wix = Join-Path $toolPath 'wix.exe'
$reported = "$(& $wix --version)".Trim()
if (-not $reported.StartsWith("$($pin.version)+$($pin.sourceCommit.Substring(0, 8))")) {
  throw "installed WiX reports $reported, not $($pin.version) from $($pin.sourceCommit)"
}
# What NuGet left in the tool store, for the record. A package file it kept must be
# the verified one; its hash and metadata files are recorded as written.
$store = @(Get-ChildItem -LiteralPath $toolPath -Recurse -Force -File |
  Where-Object { $_.Name -like "$($pin.package).$($pin.version).nupkg*" -or $_.Name -eq '.nupkg.metadata' } |
  ForEach-Object {
    [ordered]@{
      path = $_.FullName.Substring($toolPath.Length + 1)
      bytes = $_.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
      text = if ($_.Extension -ne '.nupkg' -and $_.Length -lt 4096) { (Get-Content -Raw -LiteralPath $_.FullName).Trim() } else { $null }
    }
  })
$store | ConvertTo-Json -Depth 3 | Write-Host
if (@($store | Where-Object { $_.path -like '*.nupkg' -and $_.sha256 -ne $pin.sha256 }).Count -gt 0) {
  throw 'the tool store holds a WiX package other than the verified one'
}

[ordered]@{
  schema = 1
  package = $pin.package
  version = $pin.version
  reportedVersion = $reported
  url = $pin.url
  sha512 = $sha512
  sha256 = $sha256
  toolStore = $store
  license = $pin.license
  dotnetSdk = "$(dotnet --version)".Trim()
  dotnetRuntimes = @(dotnet --list-runtimes | Where-Object { $_ -match '^Microsoft\.NETCore\.App ' })
  wix = $wix
} | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 -LiteralPath $Report
Write-Host "WiX $reported verified (sha256 $sha256) and installed at $wix"
