#Requires -Version 7.2
<#
  #87 PR 2b: install the two tools the MSI build runs, both pinned in installer.json:
  the .NET runtime WiX runs on and the WiX .NET tool package. Each file is downloaded
  from its exact URL and must match both pinned digests before it is extracted into a
  destination that must not exist yet. Nothing comes from the runner's .NET, an SDK, a
  NuGet feed or a tool store: WiX runs through the pinned runtime's own dotnet.exe with
  --fx-version, so it can run on no other runtime, and the host's trace must show that
  it did.
#>
param(
  [Parameter(Mandatory)][string]$Destination,
  [Parameter(Mandatory)][string]$Report
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
trap { Write-Host "install-tools.ps1 failed: $_`n$($_.InvocationInfo.PositionMessage)`n$($_.ScriptStackTrace)"; break }

Add-Type -AssemblyName System.IO.Compression.FileSystem

$pins = Get-Content -Raw (Join-Path $PSScriptRoot 'installer.json') | ConvertFrom-Json
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw "tool destination already exists: $Destination" }
$downloads = Join-Path $Destination 'downloads'
New-Item -ItemType Directory -Force $downloads | Out-Null

# Both digests are checked in the form their publisher gives: nuget.org's catalog
# packageHash is base64 SHA-512, .NET's release metadata hex SHA-512.
function Get-PinnedFile([object]$Pin, [string]$Name, [string]$Sha512Form) {
  $path = Join-Path $downloads $Name
  Invoke-WebRequest -Uri $Pin.url -OutFile $path
  $bytes = [IO.File]::ReadAllBytes($path)
  $sha512Bytes = [Security.Cryptography.SHA512]::HashData($bytes)
  $sha512 = if ($Sha512Form -ceq 'base64') { [Convert]::ToBase64String($sha512Bytes) } else { [Convert]::ToHexString($sha512Bytes).ToLowerInvariant() }
  $sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  if ($sha512 -cne $Pin.sha512 -or $sha256 -cne $Pin.sha256) {
    throw "$Name digest mismatch: sha512 $sha512, sha256 $sha256"
  }
  return [ordered]@{ path = $path; bytes = $bytes.Length; sha512 = $sha512; sha256 = $sha256 }
}

# The .NET runtime: exactly the pinned Microsoft.NETCore.App and its host, nothing else.
$dotnetPin = $pins.dotnet
$runtimeZip = Get-PinnedFile $dotnetPin "dotnet-runtime-$($dotnetPin.version)-win-x64.zip" 'hex'
$dotnetRoot = Join-Path $Destination 'dotnet'
[IO.Compression.ZipFile]::ExtractToDirectory($runtimeZip.path, $dotnetRoot)
$dotnet = Join-Path $dotnetRoot 'dotnet.exe'
$names = { param($Path) @(Get-ChildItem -LiteralPath $Path -Directory -Force | ForEach-Object Name) -join ',' }
if (-not (Test-Path -LiteralPath $dotnet -PathType Leaf) -or
    (& $names (Join-Path $dotnetRoot 'shared')) -cne $dotnetPin.framework -or
    (& $names (Join-Path $dotnetRoot "shared\$($dotnetPin.framework)")) -cne $dotnetPin.version -or
    (& $names (Join-Path $dotnetRoot 'host\fxr')) -cne $dotnetPin.version) {
  throw "the .NET runtime archive does not hold exactly $($dotnetPin.framework) $($dotnetPin.version)"
}
$framework = Join-Path $dotnetRoot "shared\$($dotnetPin.framework)\$($dotnetPin.version)"

# The WiX tool package: its entry point, which must ask for that one framework alone,
# so --fx-version below replaces the only framework it names.
$wixPin = $pins.wix
$nupkg = Get-PinnedFile $wixPin "$($wixPin.package).$($wixPin.version).nupkg" 'base64'
$wixRoot = Join-Path $Destination 'wix'
[IO.Compression.ZipFile]::ExtractToDirectory($nupkg.path, $wixRoot)
$wixDll = Join-Path $wixRoot ($wixPin.entryPoint -replace '/', '\')
$runtimeConfig = (Get-Content -Raw -LiteralPath ([IO.Path]::ChangeExtension($wixDll, '.runtimeconfig.json')) | ConvertFrom-Json).runtimeOptions
if (-not (Test-Path -LiteralPath $wixDll -PathType Leaf) -or $null -ne $runtimeConfig.frameworks -or
    $runtimeConfig.framework.name -cne $dotnetPin.framework) {
  throw "WiX $($wixPin.version) does not run on $($dotnetPin.framework) alone"
}

# No variable may point the host at another runtime, extra dependencies or a startup hook.
Get-ChildItem Env: | Where-Object { $_.Name -match '^(DOTNET_|COREHOST_)' } | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$trace = Join-Path $Destination 'wix-host-trace.txt'
$env:COREHOST_TRACE = '1'
$env:COREHOST_TRACEFILE = $trace
$reported = "$(& $dotnet exec --fx-version $dotnetPin.version $wixDll --version)".Trim()
Remove-Item Env:COREHOST_TRACE, Env:COREHOST_TRACEFILE
if (-not $reported.StartsWith("$($wixPin.version)+$($wixPin.sourceCommit.Substring(0, 8))")) {
  throw "WiX reports $reported, not $($wixPin.version) from $($wixPin.sourceCommit)"
}
# What the host itself says it loaded: every framework path in its trace must be the
# pinned runtime's.
$traceText = Get-Content -Raw -LiteralPath $trace
$resolved = @([regex]::Matches($traceText, 'Chose FX version \[([^\]\r\n]+)\]|CoreCLR path:\s*\[([^\]\r\n]+)\]|Property FX_DEPS_FILE = ([^\r\n]+)') |
  ForEach-Object { ($_.Groups | Select-Object -Skip 1 | Where-Object Success | Select-Object -First 1).Value.Trim() })
if ($resolved.Count -eq 0 -or @($resolved | Where-Object { -not $_.StartsWith($framework, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
  throw "WiX did not run on $($dotnetPin.framework) $($dotnetPin.version) at $framework`: the host resolved $($resolved -join ', ')"
}

[ordered]@{
  schema = 1
  wix = [ordered]@{
    package = $wixPin.package
    version = $wixPin.version
    reportedVersion = $reported
    url = $wixPin.url
    sha512 = $nupkg.sha512
    sha256 = $nupkg.sha256
    bytes = $nupkg.bytes
    sourceCommit = $wixPin.sourceCommit
    entryPoint = $wixDll
    runtimeConfig = [ordered]@{
      tfm = $runtimeConfig.tfm
      framework = "$($runtimeConfig.framework.name) $($runtimeConfig.framework.version)"
      rollForward = $runtimeConfig.rollForward
    }
    eulaId = $wixPin.eulaId
    eulaAcceptedOn = $wixPin.eulaAcceptedOn
  }
  dotnet = [ordered]@{
    framework = $dotnetPin.framework
    version = $dotnetPin.version
    url = $dotnetPin.url
    sha512 = $runtimeZip.sha512
    sha256 = $runtimeZip.sha256
    bytes = $runtimeZip.bytes
    supportedUntil = $dotnetPin.supportedUntil
    muxer = $dotnet
    runtimes = @(& $dotnet --list-runtimes)
    resolved = $resolved
  }
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 -LiteralPath $Report
Write-Host "WiX $reported verified (sha256 $($nupkg.sha256)) on $($dotnetPin.framework) $($dotnetPin.version) (sha256 $($runtimeZip.sha256))"
