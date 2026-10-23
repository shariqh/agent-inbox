#Requires -Version 7.2
<#
  #87 installer spike (CI only). lifecycle.ps1 runs this script AS a disposable
  standard (non-administrator) user, so every installer action below is proven
  to work without elevation. One invocation performs one action and writes one
  JSON result; it never throws past the result file.
#>
param([Parameter(Mandatory)][string]$ParamsFile)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$params = Get-Content -Raw -LiteralPath $ParamsFile | ConvertFrom-Json
$identity = $params.identity
$product = $identity.productName
$result = [ordered]@{ action = $params.action; kind = $params.kind; label = $params.label }

# Start-Process -Credential hands this process the caller's environment block, so
# rebuild the per-user variables from this token's known folders. Electron reads
# USERPROFILE for the home directory, where the inbox data lives.
$env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
$env:HOME = $env:USERPROFILE
$env:HOMEDRIVE = $env:USERPROFILE.Substring(0, 2)
$env:HOMEPATH = $env:USERPROFILE.Substring(2)
$env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
$env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
$env:TMP = $env:TEMP
$env:USERNAME = [Environment]::UserName
$env:AGENT_INBOX_PORT = "$($params.port)"
Remove-Item Env:\AGENT_INBOX_DB, Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:TEMP, $params.logDir | Out-Null

$paths = [ordered]@{
  profile = $env:USERPROFILE
  msiRoot = Join-Path $env:LOCALAPPDATA "Programs\$product"
  squirrelRoot = Join-Path $env:LOCALAPPDATA $identity.squirrelPackageId
  startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu'
  desktop = [Environment]::GetFolderPath('Desktop')
  data = Join-Path $env:USERPROFILE '.agent-inbox'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SpikeShellLink {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  private class CShellLink { }

  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPersistFile {
    void GetClassID(out Guid classId);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  private struct PropertyKey { public Guid FormatId; public uint PropertyId; }

  [StructLayout(LayoutKind.Explicit, Size = 24)]
  private struct PropVariant {
    [FieldOffset(0)] public ushort VarType;
    [FieldOffset(8)] public IntPtr Pointer;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }

  [DllImport("ole32.dll")]
  private static extern int PropVariantClear(ref PropVariant value);

  // PKEY_AppUserModel_ID (5) and PKEY_AppUserModel_ToastActivatorCLSID (26).
  private static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

  public static string[] Read(string path) {
    object link = new CShellLink();
    try {
      ((IPersistFile)link).Load(path, 0);
      IPropertyStore store = (IPropertyStore)link;
      return new string[] { Value(store, 5), Value(store, 26) };
    } finally {
      Marshal.ReleaseComObject(link);
    }
  }

  private static string Value(IPropertyStore store, uint id) {
    PropertyKey key = new PropertyKey { FormatId = AppUserModel, PropertyId = id };
    PropVariant value;
    store.GetValue(ref key, out value);
    try {
      if (value.VarType == 0) return null;
      if (value.VarType == 31) return Marshal.PtrToStringUni(value.Pointer);
      if (value.VarType == 72) {
        Guid clsid = (Guid)Marshal.PtrToStructure(value.Pointer, typeof(Guid));
        return clsid.ToString("B").ToUpperInvariant();
      }
      return "unsupported VARTYPE " + value.VarType;
    } finally {
      PropVariantClear(ref value);
    }
  }
}
'@

function Get-Seconds([Diagnostics.Stopwatch]$Timer) { [math]::Round($Timer.Elapsed.TotalSeconds, 1) }

function Get-AppProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = '$product.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object {
      [ordered]@{
        pid = [int]$_.ProcessId
        path = $_.ExecutablePath
        main = -not ("$($_.CommandLine)" -match '--type=')
        args = ("$($_.CommandLine)" -replace '^\s*("[^"]*"|\S+)\s*', '')
      }
    })
}

function Get-ProcessesNamed([string]$Name) {
  @(Get-CimInstance Win32_Process -Filter "Name = '$Name'" -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.ProcessId })
}

function Invoke-Tool([string]$File, [string]$Arguments, [int]$TimeoutSeconds = 900, [switch]$SampleApp) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
  # Without a cached handle, Start-Process can leave ExitCode empty after exit.
  $null = $process.Handle
  $seen = [ordered]@{}
  $timedOut = $false
  while (-not $process.WaitForExit(1000)) {
    if ($SampleApp) { foreach ($app in Get-AppProcesses) { if ($app.main) { $seen["$($app.pid)"] = $app } } }
    if ($timer.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
      $timedOut = $true
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      break
    }
  }
  $process.WaitForExit()
  $record = [ordered]@{
    command = "$(Split-Path -Leaf $File) $Arguments"
    exitCode = $process.ExitCode
    seconds = Get-Seconds $timer
    timedOut = $timedOut
  }
  if ($SampleApp) { $record.appProcessesSeen = @($seen.Values) }
  return $record
}

function Wait-NoProcess([string]$Name, [int]$TimeoutSeconds) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ((Get-ProcessesNamed $Name).Count -gt 0) {
    if ($timer.Elapsed.TotalSeconds -gt $TimeoutSeconds) { return $false }
    Start-Sleep -Milliseconds 500
  }
  return $true
}

function Test-Port([int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try { return $client.ConnectAsync('127.0.0.1', $Port).Wait(500) -and $client.Connected } catch { return $false } finally { $client.Dispose() }
}

function Stop-App {
  $record = [ordered]@{ method = 'none'; graceful = $true; portReleased = $true }
  $main = @(Get-AppProcesses | Where-Object { $_.main })
  if ($main.Count -eq 0 -and (Get-AppProcesses).Count -eq 0) { return $record }
  $record.method = 'close-main-window'
  foreach ($entry in $main) {
    $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    for ($i = 0; $i -lt 20 -and $process.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 500; $process.Refresh() }
    if (-not $process.CloseMainWindow()) { $record.method = 'taskkill'; & taskkill.exe /PID $entry.pid | Out-Null }
  }
  if (-not (Wait-NoProcess "$product.exe" 30)) {
    $record.graceful = $false
    $record.method += '+forced'
    Get-AppProcesses | ForEach-Object { Stop-Process -Id $_.pid -Force -ErrorAction SilentlyContinue }
    Wait-NoProcess "$product.exe" 30 | Out-Null
  }
  $record.portReleased = -not (Test-Port $params.port)
  return $record
}

function Get-LinkInfo([string]$Path) {
  $info = [ordered]@{ path = $Path.Replace($paths.profile, '%USERPROFILE%') }
  try {
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($Path)
    $info.target = $link.TargetPath.Replace($paths.profile, '%USERPROFILE%')
    $info.arguments = $link.Arguments
    $info.workingDirectory = $link.WorkingDirectory.Replace($paths.profile, '%USERPROFILE%')
    $values = [SpikeShellLink]::Read($Path)
    $info.appUserModelId = $values[0]
    $info.toastActivatorClsid = $values[1]
  } catch {
    $info.error = "$_"
  }
  return $info
}

function Get-ProductShortcuts([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) { return @() }
  @(Get-ChildItem -LiteralPath $Root -Recurse -Force -Filter *.lnk -ErrorAction SilentlyContinue |
    ForEach-Object { Get-LinkInfo $_.FullName } |
    Where-Object { "$($_.path) $($_.target)" -match [regex]::Escape($product) -or "$($_.target)" -match $identity.squirrelPackageId })
}

function Get-RegistryValues([string]$Key) {
  if (-not (Test-Path -LiteralPath $Key)) { return $null }
  $item = Get-ItemProperty -LiteralPath $Key
  $values = [ordered]@{}
  foreach ($property in $item.PSObject.Properties) {
    if ($property.Name -notmatch '^PS(Path|ParentPath|ChildName|Drive|Provider)$') { $values[$property.Name] = "$($property.Value)" }
  }
  return $values
}

function Get-UninstallEntries {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  @(foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      if ("$($values.DisplayName)" -notmatch [regex]::Escape($product)) { continue }
      [ordered]@{
        hive = $root.Substring(0, 4)
        key = $key.PSChildName
        displayName = "$($values.DisplayName)"
        displayVersion = "$($values.DisplayVersion)"
        publisher = "$($values.Publisher)"
        installLocation = "$($values.InstallLocation)".Replace($paths.profile, '%USERPROFILE%')
        uninstallString = "$($values.UninstallString)".Replace($paths.profile, '%USERPROFILE%')
        quietUninstallString = "$($values.QuietUninstallString)".Replace($paths.profile, '%USERPROFILE%')
        windowsInstaller = "$($values.WindowsInstaller)"
      }
    }
  })
}

# Windows Installer automation through IDispatch explicitly: PowerShell's COM
# adapter does not resolve every parameterized property.
function Get-ComProperty([object]$Target, [string]$Name, [object[]]$Arguments = @()) {
  return $Target.GetType().InvokeMember($Name, [Reflection.BindingFlags]::GetProperty, $null, $Target, $Arguments)
}

function Get-MsiProducts {
  try {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    @(foreach ($entry in (Get-ComProperty $installer 'ProductsEx' @('', '', 7))) {
      $name = try { Get-ComProperty $entry 'InstallProperty' @('ProductName') } catch { '' }
      if ($name -ne $product) { continue }
      $package = try { Get-ComProperty $entry 'InstallProperty' @('LocalPackage') } catch { '' }
      [ordered]@{
        productCode = Get-ComProperty $entry 'ProductCode'
        context = Get-ComProperty $entry 'Context'
        version = Get-ComProperty $entry 'InstallProperty' @('VersionString')
        installLocation = "$(Get-ComProperty $entry 'InstallProperty' @('InstallLocation'))".Replace($paths.profile, '%USERPROFILE%')
        localPackage = $package
        localPackageBytes = if ($package -and (Test-Path -LiteralPath $package)) { (Get-Item -LiteralPath $package).Length } else { $null }
      }
    })
  } catch {
    @([ordered]@{ error = "$_" })
  }
}

function Get-AppsFolder {
  try {
    $folder = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder')
    @($folder.Items() | Where-Object { $_.Name -match [regex]::Escape($product) } |
      ForEach-Object { [ordered]@{ name = $_.Name; appId = "$($_.Path)".Replace($paths.profile, '%USERPROFILE%') } })
  } catch {
    @([ordered]@{ error = "$_" })
  }
}

function Get-Names([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | ForEach-Object Name | Sort-Object)
}

function Get-AppDirectory {
  if ($params.kind -eq 'msi') {
    if (Test-Path -LiteralPath (Join-Path $paths.msiRoot "$product.exe")) { return $paths.msiRoot }
    return $null
  }
  $versions = @(Get-ChildItem -LiteralPath $paths.squirrelRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Name.Substring(4)) })
  if ($versions.Count -eq 0) { return $null }
  return $versions[-1].FullName
}

function Get-State {
  $toastKey = "HKCU:\Software\Classes\CLSID\$($identity.toastActivatorClsid)"
  $activators = @(Get-ChildItem 'HKCU:\Software\Classes\CLSID' -ErrorAction SilentlyContinue | Where-Object {
      "$((Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).'(default)')" -match 'Notification Activator'
    } | ForEach-Object {
      [ordered]@{
        clsid = $_.PSChildName
        name = "$((Get-ItemProperty -LiteralPath $_.PSPath).'(default)')"
        localServer32 = "$((Get-ItemProperty -LiteralPath (Join-Path $_.PSPath 'LocalServer32') -ErrorAction SilentlyContinue).'(default)')".Replace($paths.profile, '%USERPROFILE%')
      }
    })
  $appDirectory = Get-AppDirectory
  [ordered]@{
    appDirectory = if ($appDirectory) { $appDirectory.Replace($paths.profile, '%USERPROFILE%') } else { $null }
    appDirectoryFull = $appDirectory
    msiRoot = Get-Names $paths.msiRoot
    squirrelRoot = Get-Names $paths.squirrelRoot
    localPrograms = Get-Names (Join-Path $env:LOCALAPPDATA 'Programs')
    startMenuShortcuts = @(Get-ProductShortcuts $paths.startMenu)
    desktopShortcuts = @(Get-ProductShortcuts $paths.desktop)
    appsFolder = @(Get-AppsFolder)
    uninstallEntries = @(Get-UninstallEntries)
    msiProducts = @(if ($params.kind -eq 'msi') { Get-MsiProducts })
    installerRegistry = Get-RegistryValues "HKCU:\Software\$product\Installer"
    toastActivator = Get-RegistryValues $toastKey
    toastActivatorServer = Get-RegistryValues "$toastKey\LocalServer32"
    notificationActivators = $activators
    data = Get-Names $paths.data
    electronUserData = @('agent-inbox', $product | Where-Object { Test-Path -LiteralPath (Join-Path $env:APPDATA $_) })
    appProcesses = @(Get-AppProcesses)
  }
}

function Get-Snapshot {
  [ordered]@{
    profile = Get-Names $paths.profile
    localAppData = Get-Names $env:LOCALAPPDATA
    localPrograms = Get-Names (Join-Path $env:LOCALAPPDATA 'Programs')
    roamingAppData = Get-Names $env:APPDATA
    startMenu = @(Get-ChildItem -LiteralPath $paths.startMenu -Recurse -Force -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName.Substring($paths.startMenu.Length + 1) } | Sort-Object)
    desktop = Get-Names $paths.desktop
    hkcuSoftware = @(Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | ForEach-Object PSChildName | Sort-Object)
    hkcuClsid = @(Get-ChildItem 'HKCU:\Software\Classes\CLSID' -ErrorAction SilentlyContinue | ForEach-Object PSChildName | Sort-Object)
    hkcuUninstall = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
      ForEach-Object PSChildName | Sort-Object)
    hkcuInstallerProducts = @(Get-ChildItem 'HKCU:\Software\Microsoft\Installer\Products' -ErrorAction SilentlyContinue |
      ForEach-Object PSChildName | Sort-Object)
  }
}

function Get-LogLines([string]$Path, [string]$Pattern, [int]$Limit = 25) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  @(Select-String -LiteralPath $Path -Pattern $Pattern -ErrorAction SilentlyContinue |
    Select-Object -First $Limit | ForEach-Object { $_.Line.Trim().Replace($paths.profile, '%USERPROFILE%') })
}

function Save-SquirrelLogs([string]$Step) {
  $lines = [ordered]@{}
  foreach ($source in @(
      (Join-Path $env:LOCALAPPDATA 'SquirrelTemp\SquirrelSetup.log'),
      (Join-Path $paths.squirrelRoot 'SquirrelSetup.log'))) {
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $copy = Join-Path $params.logDir "$Step-$(Split-Path -Leaf (Split-Path -Parent $source))-SquirrelSetup.log"
    Copy-Item -LiteralPath $source -Destination $copy -Force
    $lines[(Split-Path -Leaf (Split-Path -Parent $source))] = Get-LogLines $source `
      'Squirrel Enabled Apps|squirrel-(install|updated|uninstall|firstrun|obsolete)|hook|burning it to the ground|already exists|Failed|Couldn''t|Exception' 40
  }
  return $lines
}

function Get-InstallerCommand([string]$Installer) {
  $log = Join-Path $params.logDir "$($params.label).log"
  if ($params.kind -eq 'msi') {
    return @('msiexec.exe', "/i `"$Installer`" /qn /norestart /l*v `"$log`"", $log)
  }
  return @($Installer, '--silent', $null)
}

function Wait-SquirrelIdle {
  return [ordered]@{ updateExeIdle = Wait-NoProcess 'Update.exe' 180 }
}

function Start-AppFromShortcut {
  $shortcuts = @(Get-ProductShortcuts $paths.startMenu)
  $record = [ordered]@{ via = $null; ready = $false; readySeconds = $null; mainProcess = $null }
  if ($shortcuts.Count -gt 0) {
    $record.via = $shortcuts[0].path
    $launchPath = $shortcuts[0].path.Replace('%USERPROFILE%', $paths.profile)
  } else {
    $directory = Get-AppDirectory
    if (-not $directory) { throw 'no shortcut and no installed app to launch' }
    $launchPath = Join-Path $directory "$product.exe"
    $record.via = "$launchPath (no Start-menu shortcut)".Replace($paths.profile, '%USERPROFILE%')
  }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  Start-Process -FilePath $launchPath | Out-Null
  while ($timer.Elapsed.TotalSeconds -lt 120) {
    try {
      $response = Invoke-WebRequest -Method Head -Uri "http://127.0.0.1:$($params.port)/" -TimeoutSec 2 -SkipHttpErrorCheck
      if ("$($response.Headers['x-agent-inbox-local-boundary'])" -eq 'loopback-v1') { $record.ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  $record.readySeconds = Get-Seconds $timer
  $main = @(Get-AppProcesses | Where-Object { $_.main })
  if ($main.Count -gt 0) {
    $record.mainProcess = [ordered]@{ count = $main.Count; path = "$($main[0].path)".Replace($paths.profile, '%USERPROFILE%') }
  }
  $record.dataAfterLaunch = Get-Names $paths.data
  return $record
}

$result.user = [ordered]@{
  name = [Environment]::UserName
  profile = $paths.profile
  isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  integrity = "$((& whoami.exe /groups) -match 'Mandatory Level')".Trim() -replace '\s{2,}.*$', ''
}

$timer = [Diagnostics.Stopwatch]::StartNew()
try {
  switch ($params.action) {
    'baseline' {
      $result.snapshot = Get-Snapshot
      $result.state = Get-State
    }
    'install' {
      $command = Get-InstallerCommand $params.installer
      $result.dataBefore = Get-Names $paths.data
      $result.run = Invoke-Tool $command[0] $command[1] -SampleApp
      if ($params.kind -eq 'squirrel') {
        $result.idle = Wait-SquirrelIdle
        $result.strayApp = Stop-App
        $result.squirrelLog = Save-SquirrelLogs $params.label
      }
      if ($command[2]) { $result.msiLog = Get-LogLines $command[2] 'Installation success or error status|Product: .* --|Error \d{4}|in use|Restart Manager|RmShutdown|1603|1612' }
      $result.dataAfterInstall = Get-Names $paths.data
      $result.state = Get-State
    }
    'squirrel-shortcut' {
      $update = Join-Path $paths.squirrelRoot 'Update.exe'
      $result.run = Invoke-Tool $update "--createShortcut `"$product.exe`" --shortcut-locations StartMenu" 120
      $result.state = Get-State
    }
    'launch' {
      $result.before = Stop-App
      $result.launch = Start-AppFromShortcut
      $result.state = Get-State
      $result.quit = Stop-App
      $result.processesAfterQuit = @(Get-AppProcesses)
    }
    'upgrade' {
      $result.before = Stop-App
      if ($params.whileRunning) { $result.launch = Start-AppFromShortcut }
      $command = Get-InstallerCommand $params.installer
      $result.run = Invoke-Tool $command[0] $command[1] -SampleApp
      if ($params.kind -eq 'squirrel') { $result.idle = Wait-SquirrelIdle }
      $result.processesAfterRun = @(Get-AppProcesses)
      $result.quit = Stop-App
      if ($params.kind -eq 'squirrel') { $result.squirrelLog = Save-SquirrelLogs $params.label }
      if ($command[2]) { $result.msiLog = Get-LogLines $command[2] 'Installation success or error status|Product: .* --|Error \d{4}|in use|Restart Manager|RmShutdown|RmGetList|reboot|1603|1612|3010' 40 }
      $result.state = Get-State
    }
    'repair' {
      $result.before = Stop-App
      $directory = Get-AppDirectory
      $result.deleted = @(foreach ($relative in $params.deleteFiles) {
        $path = Join-Path $directory $relative
        Remove-Item -LiteralPath $path -Force
        $relative
      })
      $log = Join-Path $params.logDir "$($params.label).log"
      $result.run = Invoke-Tool 'msiexec.exe' "/fomus $($params.productCode) /qn /norestart /l*v `"$log`""
      $result.restored = [ordered]@{}
      foreach ($relative in $params.deleteFiles) { $result.restored[$relative] = Test-Path -LiteralPath (Join-Path $directory $relative) }
      $result.msiLog = Get-LogLines $log 'Installation success or error status|Product: .* --|Error \d{4}|source|1612|1706' 30
      $result.state = Get-State
    }
    'squirrel-update' {
      $result.before = Stop-App
      $update = Join-Path $paths.squirrelRoot 'Update.exe'
      $result.run = Invoke-Tool $update "--update `"$($params.releasesDir)`"" 600 -SampleApp
      $result.idle = Wait-SquirrelIdle
      $result.strayApp = Stop-App
      $result.squirrelLog = Save-SquirrelLogs $params.label
      $result.state = Get-State
    }
    'uninstall' {
      $result.before = Stop-App
      New-Item -ItemType Directory -Force $paths.data | Out-Null
      Set-Content -LiteralPath (Join-Path $paths.data 'installer-spike-sentinel.txt') -Value 'user data written before uninstall'
      $result.dataBefore = Get-Names $paths.data
      if ($params.kind -eq 'msi') {
        $log = Join-Path $params.logDir "$($params.label).log"
        $result.run = Invoke-Tool 'msiexec.exe' "/x $($params.productCode) /qn /norestart /l*v `"$log`"" -SampleApp
        $result.msiLog = Get-LogLines $log 'Installation success or error status|Product: .* --|Error \d{4}|Removal' 20
      } else {
        $update = Join-Path $paths.squirrelRoot 'Update.exe'
        $result.run = Invoke-Tool $update '--uninstall -s' 300 -SampleApp
        $result.idle = Wait-SquirrelIdle
        $result.strayApp = Stop-App
        $result.squirrelLog = Save-SquirrelLogs $params.label
      }
      $result.dataAfter = Get-Names $paths.data
      $result.sentinelSurvived = Test-Path -LiteralPath (Join-Path $paths.data 'installer-spike-sentinel.txt')
      $result.inboxDatabaseSurvived = Test-Path -LiteralPath (Join-Path $paths.data 'inbox.db')
      $result.state = Get-State
      $result.snapshot = Get-Snapshot
    }
    default { throw "unknown action $($params.action)" }
  }
} catch {
  $result.error = "$_"
  $result.errorAt = "$($_.InvocationInfo.PositionMessage)"
}
$result.seconds = Get-Seconds $timer
$result | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -LiteralPath $params.out
