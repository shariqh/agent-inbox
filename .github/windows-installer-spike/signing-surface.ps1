#Requires -Version 7.2
<#
  #87 installer spike (CI only): record which PE files carry an Authenticode
  signature today, in the verified folder and in what each installer adds, so the
  decision record can say exactly what a signing step must cover.
#>
param(
  [Parameter(Mandatory)][string]$Folder,
  [Parameter(Mandatory)][string]$Msi,
  [Parameter(Mandatory)][string]$SquirrelBuild,
  [Parameter(Mandatory)][string]$Report
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
trap { Write-Host "signing-surface.ps1 failed: $_`n$($_.InvocationInfo.PositionMessage)`n$($_.ScriptStackTrace)"; break }
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Folder = [IO.Path]::GetFullPath($Folder)
function Get-Signature([string]$Path, [string]$Label) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  [ordered]@{
    path = $Label
    status = "$($signature.Status)"
    signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    timestamped = [bool]$signature.TimeStamperCertificate
  }
}

$folderSignatures = @(Get-ChildItem -LiteralPath $Folder -Recurse -File |
  Where-Object { $_.Extension -in '.exe', '.dll', '.node' } |
  Sort-Object FullName |
  ForEach-Object { Get-Signature $_.FullName $_.FullName.Substring($Folder.Length + 1) })

# Squirrel adds executables to the package it builds; extract just those.
$extract = Join-Path $env:RUNNER_TEMP 'squirrel-added-executables'
New-Item -ItemType Directory -Force $extract | Out-Null
$nupkg = Get-ChildItem -LiteralPath $SquirrelBuild -Filter '*-full.nupkg' | Select-Object -First 1
$zip = [IO.Compression.ZipFile]::OpenRead($nupkg.FullName)
try {
  $added = @(foreach ($entry in $zip.Entries) {
    $name = [Uri]::UnescapeDataString($entry.FullName)
    if ($name -notmatch '^lib/net45/[^/]+\.(exe|dll)$') { continue }
    $relative = $name.Substring('lib/net45/'.Length)
    if (Test-Path -LiteralPath (Join-Path $Folder $relative)) { continue }
    $target = Join-Path $extract $relative
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    Get-Signature $target "package: $relative"
  })
} finally {
  $zip.Dispose()
}
$setup = Get-ChildItem -LiteralPath $SquirrelBuild -Filter '*-setup.exe' | Select-Object -First 1

[ordered]@{
  schema = 1
  folder = $folderSignatures
  msi = Get-Signature $Msi (Split-Path -Leaf $Msi)
  squirrelAdded = $added
  squirrelSetup = Get-Signature $setup.FullName $setup.Name
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 -LiteralPath $Report
$unsigned = @($folderSignatures | Where-Object { $_.status -ne 'Valid' }).Count
Write-Host "Folder PE files: $($folderSignatures.Count), of which $unsigned carry no valid signature"
