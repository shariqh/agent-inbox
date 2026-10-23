#Requires -Version 7.2
<#
  #87 PR 2b, CI only. lifecycle.ps1 runs this script AS a disposable standard
  (non-administrator) user, so every installer and app action below is proven to
  work without elevation. One invocation performs one action and writes one JSON
  result; it never throws past the result file.
#>
param([Parameter(Mandatory)][string]$ParamsFile)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$params = Get-Content -Raw -LiteralPath $ParamsFile | ConvertFrom-Json
$identity = $params.identity
$product = $identity.productName
$result = [ordered]@{ action = $params.action; label = $params.label }
trap {
  $result.error = "setup: $_"
  $result.errorAt = "$($_.InvocationInfo.PositionMessage)"
  $result | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -LiteralPath $params.out
  break
}

# Start-Process -Credential hands this process the administrator's environment
# block, and known-folder lookups expand those variables. So find this token's
# profile from its SID and rebuild the per-user variables from it. Electron reads
# USERPROFILE for the home directory, where the inbox data lives.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$profileDirectory = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid").ProfileImagePath
$env:USERPROFILE = [Environment]::ExpandEnvironmentVariables($profileDirectory)
$env:HOME = $env:USERPROFILE
$env:HOMEDRIVE = $env:USERPROFILE.Substring(0, 2)
$env:HOMEPATH = $env:USERPROFILE.Substring(2)
$env:LOCALAPPDATA = Join-Path $env:USERPROFILE 'AppData\Local'
$env:APPDATA = Join-Path $env:USERPROFILE 'AppData\Roaming'
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
$env:TMP = $env:TEMP
$env:USERNAME = [Environment]::UserName
$env:AGENT_INBOX_PORT = "$($params.port)"
Remove-Item Env:\AGENT_INBOX_DB, Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:TEMP, $params.logDir | Out-Null
foreach ($folder in 'LocalApplicationData', 'ApplicationData') {
  $known = [Environment]::GetFolderPath($folder)
  if (-not $known.StartsWith($env:USERPROFILE, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$folder resolves to $known, outside this user's profile $($env:USERPROFILE)"
  }
}

$paths = [ordered]@{
  profile = $env:USERPROFILE
  msiRoot = Join-Path $env:LOCALAPPDATA "Programs\$product"
  startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu'
  desktop = Join-Path $env:USERPROFILE 'Desktop'
  data = Join-Path $env:USERPROFILE '.agent-inbox'
}
$toastKey = "HKCU:\Software\Classes\CLSID\$($identity.toastActivatorClsid)"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentInboxShellLink {
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

// What Restart Manager sees using a file, and what happens when it asks those
// applications to close: the requests Windows Installer makes during an upgrade,
// repair or uninstall, made directly. With RmForceShutdown (0x1) it still asks each
// application with a window first, and ends only what it cannot ask or what does not
// respond within 30 seconds.
public static class AgentInboxRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  private struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmEndSession(uint session);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmRegisterResources(uint session, uint files, string[] fileNames, uint applications,
    RM_UNIQUE_PROCESS[] applicationList, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] apps,
    ref uint rebootReasons);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmShutdown(uint session, uint flags, IntPtr status);

  public sealed class App {
    public int ProcessId;
    public string Name;
    public int Type;
    public uint Status;
    public uint SessionId;
    public bool Restartable;
  }

  public sealed class Result {
    public int Start = -1;
    public int Register = -1;
    public int List = -1;
    public uint RebootReasons;
    public App[] Apps = new App[0];
    public int Shutdown = -1;
    public int ListAfter = -1;
    public App[] AppsAfter = new App[0];
  }

  private static int List(uint session, out App[] apps, out uint reasons) {
    apps = new App[0];
    reasons = 0;
    uint needed;
    uint count = 0;
    RM_PROCESS_INFO[] infos = null;
    int code = RmGetList(session, out needed, ref count, null, ref reasons);
    for (int attempt = 0; code == 234 && attempt < 5; attempt++) {
      count = needed;
      infos = new RM_PROCESS_INFO[count];
      code = RmGetList(session, out needed, ref count, infos, ref reasons);
    }
    if (code != 0 || infos == null) return code;
    apps = new App[count];
    for (int i = 0; i < count; i++) {
      apps[i] = new App {
        ProcessId = infos[i].Process.dwProcessId,
        Name = infos[i].strAppName,
        Type = infos[i].ApplicationType,
        Status = infos[i].AppStatus,
        SessionId = infos[i].TSSessionId,
        Restartable = infos[i].bRestartable,
      };
    }
    return code;
  }

  public static Result Probe(string[] files, bool shutdown, uint flags) {
    Result result = new Result();
    uint session;
    result.Start = RmStartSession(out session, 0, new StringBuilder(33));
    if (result.Start != 0) return result;
    try {
      result.Register = RmRegisterResources(session, (uint)files.Length, files, 0, null, 0, null);
      if (result.Register != 0) return result;
      uint reasons;
      App[] apps;
      result.List = List(session, out apps, out reasons);
      result.Apps = apps;
      result.RebootReasons = reasons;
      if (shutdown && result.List == 0) {
        result.Shutdown = RmShutdown(session, flags, IntPtr.Zero);
        App[] after;
        uint afterReasons;
        result.ListAfter = List(session, out after, out afterReasons);
        result.AppsAfter = after;
      }
    } finally {
      RmEndSession(session);
    }
    return result;
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
    Start-Sleep -Milliseconds 250
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
  $closing = [Diagnostics.Stopwatch]::StartNew()
  if (-not (Wait-NoProcess "$product.exe" 30)) {
    $record.graceful = $false
    $record.method += '+forced'
    $record.stillRunning = @(Get-AppProcesses | ForEach-Object {
      [ordered]@{ pid = $_.pid; main = $_.main; type = if ($_.args -match '--type=(\S+)') { $Matches[1] } else { 'main' } }
    })
    Get-AppProcesses | ForEach-Object { Stop-Process -Id $_.pid -Force -ErrorAction SilentlyContinue }
    Wait-NoProcess "$product.exe" 30 | Out-Null
  }
  $record.seconds = Get-Seconds $closing
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
    $info.description = $link.Description
    $info.modified = (Get-Item -LiteralPath $Path).LastWriteTimeUtc.ToString('o')
    $values = [AgentInboxShellLink]::Read($Path)
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
    Where-Object { "$($_.path) $($_.target)" -match [regex]::Escape($product) })
}

function Get-RegistryValues([string]$Key) {
  if (-not (Test-Path -LiteralPath $Key)) { return $null }
  $item = Get-ItemProperty -LiteralPath $Key
  $values = [ordered]@{}
  foreach ($property in $item.PSObject.Properties) {
    if ($property.Name -notmatch '^PS(Path|ParentPath|ChildName|Drive|Provider)$') { $values[$property.Name] = "$($property.Value)".Replace($paths.profile, '%USERPROFILE%') }
  }
  return $values
}

function Get-ToastActivator {
  $values = Get-RegistryValues $toastKey
  if ($null -eq $values) { return $null }
  $server = Get-RegistryValues "$toastKey\LocalServer32"
  [ordered]@{
    name = $values['(default)']
    customActivator = $values['CustomActivator']
    localServer32 = if ($server) { $server['(default)'] } else { $null }
  }
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
    $items = @((New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder').Items())
    $matched = @($items | Where-Object { $_.Name -match [regex]::Escape($product) } |
      ForEach-Object { [ordered]@{ name = $_.Name; appId = "$($_.Path)".Replace($paths.profile, '%USERPROFILE%') } })
    if ($items.Count -eq 0) { return @([ordered]@{ error = 'shell:AppsFolder listed no apps at all in this session' }) }
    return $matched
  } catch {
    @([ordered]@{ error = "$_" })
  }
}

function Get-Names([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | ForEach-Object Name | Sort-Object)
}

function Get-AppDirectory {
  if (Test-Path -LiteralPath (Join-Path $paths.msiRoot "$product.exe")) { return $paths.msiRoot }
  return $null
}

function Get-State {
  $appDirectory = Get-AppDirectory
  [ordered]@{
    appDirectory = if ($appDirectory) { $appDirectory.Replace($paths.profile, '%USERPROFILE%') } else { $null }
    appDirectoryFull = $appDirectory
    msiRoot = Get-Names $paths.msiRoot
    localPrograms = Get-Names (Join-Path $env:LOCALAPPDATA 'Programs')
    startMenuShortcuts = @(Get-ProductShortcuts $paths.startMenu)
    desktopShortcuts = @(Get-ProductShortcuts $paths.desktop)
    appsFolder = @(Get-AppsFolder)
    uninstallEntries = @(Get-UninstallEntries)
    msiProducts = @(Get-MsiProducts)
    installerRegistry = Get-RegistryValues "HKCU:\Software\$product\Installer"
    toastActivator = Get-ToastActivator
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

function Get-InstallerCommand([string]$Installer) {
  $log = Join-Path $params.logDir "$($params.label).log"
  return @('msiexec.exe', "/i `"$Installer`" /qn /norestart /l*v `"$log`"", $log)
}

function Wait-Ready([Diagnostics.Stopwatch]$Timer) {
  while ($Timer.Elapsed.TotalSeconds -lt 120) {
    try {
      $response = Invoke-WebRequest -Method Head -Uri "http://127.0.0.1:$($params.port)/" -TimeoutSec 2 -SkipHttpErrorCheck
      if ("$($response.Headers['x-agent-inbox-local-boundary'])" -eq 'loopback-v1') { return $true }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Get-MainProcess {
  $main = @(Get-AppProcesses | Where-Object { $_.main })
  if ($main.Count -eq 0) { return $null }
  [ordered]@{ count = $main.Count; pid = $main[0].pid; path = "$($main[0].path)".Replace($paths.profile, '%USERPROFILE%') }
}

function Start-AppFromShortcut {
  $shortcuts = @(Get-ProductShortcuts $paths.startMenu)
  if ($shortcuts.Count -eq 0) { throw 'no Start-menu shortcut to launch' }
  $record = [ordered]@{ via = $shortcuts[0].path; ready = $false; readySeconds = $null; mainProcess = $null }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  Start-Process -FilePath $shortcuts[0].path.Replace('%USERPROFILE%', $paths.profile) | Out-Null
  $record.ready = Wait-Ready $timer
  $record.readySeconds = Get-Seconds $timer
  $record.mainProcess = Get-MainProcess
  $record.dataAfterLaunch = Get-Names $paths.data
  return $record
}

# Started from the installed executable rather than the shortcut, so the app's own
# [agent-inbox] log lines on stdout and stderr are kept.
function Start-AppWithLog([string]$Name) {
  $directory = Get-AppDirectory
  if (-not $directory) { throw 'no installed app to launch' }
  $record = [ordered]@{
    via = "$product.exe"
    stdout = Join-Path $params.logDir "$($params.label)-$Name.stdout.txt"
    stderr = Join-Path $params.logDir "$($params.label)-$Name.stderr.txt"
  }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  # Chromium's own log lines (a child process that ended, a renderer that went away) go to stderr.
  $env:ELECTRON_ENABLE_LOGGING = '1'
  try {
    $script:appProcess = Start-Process -FilePath (Join-Path $directory "$product.exe") -WorkingDirectory $directory `
      -RedirectStandardOutput $record.stdout -RedirectStandardError $record.stderr -PassThru
    # Without a cached handle, the exit code is not kept.
    $null = $script:appProcess.Handle
  } finally {
    Remove-Item Env:\ELECTRON_ENABLE_LOGGING -ErrorAction SilentlyContinue
  }
  $record.ready = Wait-Ready $timer
  $record.readySeconds = Get-Seconds $timer
  # Restart Manager sends its request to the app's top-level window, which shows once the viewer loads.
  for ($i = 0; $i -lt 40; $i++) {
    $main = Get-MainProcess
    $process = if ($main) { Get-Process -Id $main.pid -ErrorAction SilentlyContinue }
    if ($process -and $process.MainWindowHandle -ne 0) { break }
    Start-Sleep -Milliseconds 500
  }
  $record.windowShown = [bool]($process -and $process.MainWindowHandle -ne 0)
  $record.mainProcess = Get-MainProcess
  return $record
}

function Read-SharedText([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
  try { return [IO.StreamReader]::new($stream).ReadToEnd() } finally { $stream.Dispose() }
}

function Read-AppLog([object]$Started) {
  @($Started.stdout, $Started.stderr | ForEach-Object { (Read-SharedText $_) -split "`r?`n" } |
    Where-Object { $_ -match '\[agent-inbox\]' } | ForEach-Object { $_.Trim().Replace($paths.profile, '%USERPROFILE%') })
}

# How the main process this step started ended, once it has.
function Get-AppExit {
  if (-not $script:appProcess) { return $null }
  [ordered]@{ exited = $script:appProcess.HasExited; exitCode = if ($script:appProcess.HasExited) { $script:appProcess.ExitCode } else { $null } }
}

# Chromium's log lines about child processes and the renderer ending.
function Read-ChromiumLog([object]$Started) {
  @((Read-SharedText $Started.stderr) -split "`r?`n" | Where-Object { $_ -match 'exited|crash|gone|terminat|kill' } |
    Select-Object -First 20 | ForEach-Object { $_.Trim().Replace($paths.profile, '%USERPROFILE%') })
}

function Wait-AppLog([object]$Started, [string]$Pattern, [int]$TimeoutSeconds) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $line = @(Read-AppLog $Started | Where-Object { $_ -match $Pattern })[0]
    if ($line) { return [ordered]@{ seen = $true; seconds = Get-Seconds $timer; line = $line } }
    Start-Sleep -Milliseconds 500
  } while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds)
  return [ordered]@{ seen = $false; seconds = Get-Seconds $timer; line = $null }
}

$restartManagerTypes = @{ 0 = 'unknown'; 1 = 'main window'; 2 = 'other window'; 3 = 'service'; 4 = 'Explorer'; 5 = 'console'; 1000 = 'critical' }
function ConvertTo-RestartManagerRecord([object]$Probe) {
  $apps = {
    param($List)
    @($List | ForEach-Object {
      [ordered]@{
        pid = $_.ProcessId
        name = $_.Name
        type = $restartManagerTypes[$_.Type] ?? "$($_.Type)"
        status = $_.Status
        session = $_.SessionId
        restartable = $_.Restartable
      }
    })
  }
  [ordered]@{
    start = $Probe.Start
    register = $Probe.Register
    list = $Probe.List
    rebootReasons = $Probe.RebootReasons
    apps = & $apps $Probe.Apps
    shutdown = $Probe.Shutdown
    listAfter = $Probe.ListAfter
    appsAfter = & $apps $Probe.AppsAfter
  }
}

$quitLine = 'Windows asked the app to close \(Restart Manager\); quitting'

# Adds an open question through the installed app's own runtime, which the running
# app's attention watch then announces with a Windows notification.
function Add-Question([string]$Title) {
  $runtime = Join-Path (Get-AppDirectory) 'resources\app\runtime\win32-x64'
  $output = & (Join-Path $runtime 'node.exe') $params.questionScript (Join-Path $runtime 'dist\store.js') $Title 2>&1
  if ($LASTEXITCODE -ne 0) { throw "could not add a question (exit $LASTEXITCODE): $output" }
  return ("$output" | ConvertFrom-Json).id
}

# Windows' notification history for the app's ID, read through WinRT in Windows
# PowerShell, which projects it. A session without the notification platform says why.
function Get-ToastHistory {
  $script = @"
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  'count=' + [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('$($identity.appUserModelId)').Count
} catch {
  'error=' + `$_.Exception.Message
}
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $lines = @(& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1 |
    ForEach-Object { "$_".Trim() } | Where-Object { $_ })
  $count = @($lines | Where-Object { $_ -match '^count=\d+$' })[0]
  if ($count) { return [ordered]@{ count = [int]($count -replace '^count=', ''); output = $lines } }
  return [ordered]@{ error = (@($lines | Where-Object { $_ -match '^error=' })[0] ?? ($lines -join ' ')) -replace '^error=', ''; output = $lines }
}

$result.user = [ordered]@{
  name = [Environment]::UserName
  profile = $paths.profile
  isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  integrity = "$((& whoami.exe /groups) -match 'Mandatory Level')".Trim() -replace '\s{2,}.*$', ''
  session = [Diagnostics.Process]::GetCurrentProcess().SessionId
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
      $result.msiLog = @(Get-LogLines $command[2] 'Installation success or error status|Product: .* --|Error \d{4}|in use|Restart Manager|RmShutdown|1603|1612|1625')
      $result.dataAfterInstall = Get-Names $paths.data
      $result.state = Get-State
    }
    'launch' {
      $result.before = Stop-App
      $result.launch = Start-AppFromShortcut
      # Running a while first, so a quit is measured once the app's background work has started.
      if ($params.holdSeconds) { Start-Sleep -Seconds $params.holdSeconds }
      $result.state = Get-State
      $result.quit = Stop-App
      $result.processesAfterQuit = @(Get-AppProcesses)
    }
    'notify' {
      $result.before = Stop-App
      if ($params.withoutShortcut) {
        # Without the MSI's shortcut, Electron writes its own at the first
        # notification from the app's own ID and CLSID, which shows those two values.
        $result.removedShortcuts = @(Get-ProductShortcuts $paths.startMenu | ForEach-Object path)
        foreach ($link in $result.removedShortcuts) { Remove-Item -LiteralPath $link.Replace('%USERPROFILE%', $paths.profile) -Force }
      }
      $result.shortcutsBefore = @(Get-ProductShortcuts $paths.startMenu)
      $result.toastActivatorBefore = Get-ToastActivator
      $started = Start-AppWithLog 'notify'
      $result.launch = $started
      if (-not $started.ready) { throw 'the app did not become ready' }
      # The attention watch polls every 3 s and announces only what arrives after its first poll.
      Start-Sleep -Seconds 8
      $result.questionId = Add-Question "Windows MSI lifecycle notification check ($($params.label))"
      $result.notification = Wait-AppLog $started '\[agent-inbox\] notifying: ' 30
      # Electron registers its toast activator (shortcut and COM entry) off its main
      # thread once its notification presenter exists.
      $before = if ($result.toastActivatorBefore) { $result.toastActivatorBefore.name } else { $null }
      $wait = [Diagnostics.Stopwatch]::StartNew()
      while ($wait.Elapsed.TotalSeconds -lt 15) {
        $activator = Get-ToastActivator
        if ($activator -and $activator.name -ne $before) { break }
        Start-Sleep -Milliseconds 500
      }
      Start-Sleep -Seconds 2
      $result.toastActivatorAfter = Get-ToastActivator
      $result.shortcutsAfter = @(Get-ProductShortcuts $paths.startMenu)
      $result.toastHistory = Get-ToastHistory
      $result.appLog = @(Read-AppLog $started)
      $result.quit = Stop-App
      $result.mainExit = Get-AppExit
      $result.chromiumLog = @(Read-ChromiumLog $started)
      $result.state = Get-State
    }
    'restart-manager' {
      $result.before = Stop-App
      $started = Start-AppWithLog 'restart-manager'
      $result.launch = $started
      if (-not $started.ready) { throw 'the app did not become ready' }
      $result.processesBefore = @(Get-AppProcesses)
      $exe = Join-Path (Get-AppDirectory) "$product.exe"
      # Chromium's child processes have no window, so Restart Manager cannot ask them
      # to close: without RmForceShutdown it asks nothing at all.
      $result.restartManagerWithoutForce = ConvertTo-RestartManagerRecord ([AgentInboxRestartManager]::Probe(@($exe), $true, 0))
      $result.runningAfterWithoutForce = @(Get-AppProcesses).Count
      # With it (what Windows Installer uses when MSIRMSHUTDOWN is 1), the app's window is asked.
      $asked = [Diagnostics.Stopwatch]::StartNew()
      $result.restartManager = ConvertTo-RestartManagerRecord ([AgentInboxRestartManager]::Probe(@($exe), $true, 1))
      $result.restartManager.seconds = Get-Seconds $asked
      $result.exited = Wait-NoProcess "$product.exe" 30
      $result.exitSeconds = Get-Seconds $asked
      $result.mainExit = Get-AppExit
      $result.portReleased = -not (Test-Port $params.port)
      $result.appLog = @(Read-AppLog $started)
      $result.chromiumLog = @(Read-ChromiumLog $started)
      $result.quitLogged = [bool](@($result.appLog | Where-Object { $_ -match $quitLine }).Count)
      $result.processesAfter = @(Get-AppProcesses)
      $result.leftover = Stop-App
      $result.dataAfter = Get-Names $paths.data
      $result.state = Get-State
    }
    'upgrade' {
      $result.before = Stop-App
      $started = $null
      if ($params.whileRunning) {
        $started = Start-AppWithLog 'upgrade'
        $result.launch = $started
        # What Restart Manager sees using the app just before Windows Installer asks it to close.
        $result.restartManagerBefore = ConvertTo-RestartManagerRecord (
          [AgentInboxRestartManager]::Probe(@(Join-Path (Get-AppDirectory) "$product.exe"), $false, 0))
      }
      $command = Get-InstallerCommand $params.installer
      $result.run = Invoke-Tool $command[0] $command[1] -SampleApp
      $result.processesAfterRun = @(Get-AppProcesses)
      if ($started) {
        $result.appLog = @(Read-AppLog $started)
        $result.quitLogged = [bool](@($result.appLog | Where-Object { $_ -match $quitLine }).Count)
      }
      $result.quit = Stop-App
      if ($started) {
        $result.mainExit = Get-AppExit
        $result.chromiumLog = @(Read-ChromiumLog $started)
      }
      $result.msiLog = @(Get-LogLines $command[2] 'Installation success or error status|Product: .* --|Error \d{4}|in use|RESTART MANAGER|1603|1612|3010' 40)
      # In-use files Windows Installer moved aside, to be deleted at the next reboot.
      $result.rebootOperations = @(Select-String -LiteralPath $command[2] -Pattern 'Scheduling reboot operation' -ErrorAction SilentlyContinue).Count
      $result.state = Get-State
    }
    'repair' {
      $result.before = Stop-App
      $directory = Get-AppDirectory
      $result.deleted = @(foreach ($relative in $params.deleteFiles) {
        Remove-Item -LiteralPath (Join-Path $directory $relative) -Force
        $relative
      })
      $log = Join-Path $params.logDir "$($params.label).log"
      $result.run = Invoke-Tool 'msiexec.exe' "/fomus $($params.productCode) /qn /norestart /l*v `"$log`""
      $result.restored = [ordered]@{}
      foreach ($relative in $params.deleteFiles) { $result.restored[$relative] = Test-Path -LiteralPath (Join-Path $directory $relative) }
      $result.msiLog = @(Get-LogLines $log 'Installation success or error status|Product: .* --|Error \d{4}|source|1612|1706' 30)
      $result.state = Get-State
    }
    'uninstall' {
      $result.before = Stop-App
      New-Item -ItemType Directory -Force $paths.data | Out-Null
      Set-Content -LiteralPath (Join-Path $paths.data 'msi-lifecycle-sentinel.txt') -Value 'user data written before uninstall'
      $result.dataBefore = Get-Names $paths.data
      $log = Join-Path $params.logDir "$($params.label).log"
      $result.run = Invoke-Tool 'msiexec.exe' "/x $($params.productCode) /qn /norestart /l*v `"$log`"" -SampleApp
      $result.msiLog = @(Get-LogLines $log 'Installation success or error status|Product: .* --|Error \d{4}|Removal' 20)
      $result.dataAfter = Get-Names $paths.data
      $result.sentinelSurvived = Test-Path -LiteralPath (Join-Path $paths.data 'msi-lifecycle-sentinel.txt')
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
