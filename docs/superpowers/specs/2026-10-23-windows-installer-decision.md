# Decision record: the Windows x64 installer (#87, PR 2a)

**Date:** 2026-10-23
**Status:** Decided. The spike (PR 2a) measured both installers and recommended the per-user
MSI; the owner chose WiX v7 and accepted its EULA on 2026-10-23 (§8.3), and PR 2b built the
pinned, unsigned MSI (§9).
**Milestone:** v1.7. Refs #87.
**Scope of PR 2a:** a CI-only spike workflow and this record. Nothing is signed, published or
released. Setup and the in-app updater stay off on Windows, and the signed update manifest
gains no Windows target: installed 1.3–1.6 apps accept only its exact five targets
(`TARGET_SPECS` in `electron/update-manifest.cjs`). PR 2b keeps every one of those limits.

---

## §0 — Summary

**Recommendation: ship a per-user MSI built with WiX.** PR 2b should pin it, add the shortcut
identity the app needs, and keep it unsigned until a signing provider is chosen.

The spike built both candidates from the same verified Windows folder and drove each through
install, launch, upgrade, repair and uninstall as a fresh standard (non-administrator) user on
a `windows-2022` runner. The numbers below are from run
[39893800330](https://github.com/shariqh/agent-inbox/actions/runs/39893800330) (1.6.0 upgraded
to 1.6.1). Runs [39896941593](https://github.com/shariqh/agent-inbox/actions/runs/39896941593)
and [39899654879](https://github.com/shariqh/agent-inbox/actions/runs/39899654879), on later
commits of this PR, reproduced every result; only the times varied. Every run writes the same
table to its job summary.

1. **One install folder for every version.** The MSI installs to
   `%LOCALAPPDATA%\Programs\Agent Inbox` and upgrades in place. Squirrel installs to
   `%LOCALAPPDATA%\AgentInbox\app-<version>`, a new folder each version, and its Start-menu
   shortcut kept pointing its working directory at the deleted old folder after an upgrade.
2. **Both install exactly the verified bytes.** Each installed tree matched the folder's
   verified digest file for file. Squirrel adds its own `squirrel.exe` and a log to every
   version folder.
3. **Repair exists only in the MSI.** A silent repair by product code (`msiexec /fomus`) put back
   a deleted `Agent Inbox.exe` and a deleted script, byte for byte. That repair needs the
   original source: with the `.msi` the product was installed from renamed away, it failed (1603,
   no valid source). Squirrel has no repair; re-running Setup.exe deletes the install and starts
   over.
4. **Squirrel needs app changes before it can work properly.** Electron's executable declares
   itself "Squirrel-aware", so Setup.exe creates no shortcut and instead starts the full app
   with `--squirrel-install` during install (and `--squirrel-updated`, `--squirrel-uninstall`
   later), then kills it. The app would have to handle those events. With today's app the
   uninstall left the whole 560 MiB version folder, `Update.exe` and a Start-menu shortcut
   behind. The MSI needs only the app to set the AppUserModelID and toast CLSID its shortcut
   carries, and to exit when Windows asks (item 9).
5. **Uninstall is clean only for the MSI.** It removed the app, its folder, its shortcut, its
   registry entries and the COM registration it owns, and kept `%USERPROFILE%\.agent-inbox`.
   Squirrel kept that data too, but left the points in item 4 behind.
6. **Signing is simpler for the MSI.** Sign the 10 unsigned PE files in the folder, build, then
   sign the one `.msi`. Squirrel adds three unsigned executables of its own, which can only be
   signed inside its build step, so the signing provider must run there as a local `signtool`
   command.
7. **Smaller download.** The MSI is 161 MiB; Squirrel's Setup.exe is 203 MiB, and Squirrel
   keeps another 205 MiB package copy on disk for its own updater.
8. **Healthier tooling, one licence decision.** Squirrel.Windows has not released since 2020;
   electron-winstaller bundles NuGet 2.8.3, 7-Zip 16.04 and a Windows 7 `signtool`. WiX v7 is
   current but asks the owner to accept its Open Source Maintenance Fee EULA (§8.3); the spike
   used WiX v5.0.2 (MS-RL, no EULA) to avoid accepting it on the owner's behalf. v5 no longer
   gets security fixes, and it ran on the runner's unpinned .NET 6, so PR 2b must choose WiX's
   .NET runtime too (§6).
9. **Two caveats for the MSI.** Windows Server refuses an unelevated per-user MSI install by
   default (Windows Installer's `DisableMSI` policy); Windows 10 and 11 allow it, and machines
   that set that policy would need the portable ZIP. And an upgrade while the app runs
   succeeded, but left the old process running until it was killed, so the app should exit
   when Windows asks.

Open decisions for the owner: the signing provider, a clean Windows 11 x64 test machine, and
the WiX version and its licence (§8).

---

## §1 — What the spike did

`.github/workflows/windows-installer-spike.yml` ran on `workflow_dispatch` and on pull
requests that touched its own files. PR 2b retired it once the decision was made: its MSI
harness moved to `.github/windows-msi/` (§9), and its Squirrel tooling was removed. It had
three jobs.

1. **Verified folder.** It calls `windows-native-folder.yml`, now also callable, unchanged: the
   native Node runtime, the Electron folder, the archive round trip, the PE/ABI gates and the
   launch check. Its artifact is the installers' base input.
2. **Upgrade folder.** The same commit with only its version bumped one patch
   (`package.json`, `package-lock.json`, `src/version.ts`), committed locally so the build's
   source provenance stays clean, then built by the same `package:windows-thin` builder, which
   runs the same verifier on its output.
3. **Installers.** Restores both folders and requires each to match its verified tree digest;
   installs the pinned tools; builds an MSI and a Squirrel installer from each folder; records
   the signing surface; then runs each installer's lifecycle as its own fresh standard user and
   writes the job summary. The evidence is the `windows-installer-spike-evidence` artifact;
   the unsigned installers are a separate seven-day artifact for manual tests, never a release
   asset.

### Pinned tools

| Tool | Pin | How it is verified |
| --- | --- | --- |
| WiX .NET tool 5.0.2 (`5.0.2+aa65968c`) | nupkg SHA-512 `z+fu1deTcaV+TRCo4+6HrJ48Sdnj+yeQjjMStTI3GW7NxFEPaknYCdxrf0qEvgdXrjYdjLnkZKCsNSqTTOo2OA==` (nuget.org's catalog `packageHash`) and SHA-256 `f30ef0c74e2a986126539c5780be93ac24e8136eaf723b1937b26272703ae173` | Downloaded from its exact nuget.org URL; both digests checked; installed with `dotnet tool install` from a private feed holding only that file, into an empty package cache; the reported version and source commit checked; the package the tool store keeps must hash to the pin. |
| electron-winstaller 5.4.4 | lockfile integrity `sha512-j9ETcBGJaXxAY/b6UBpR7LZfjdU4BAO+yvr4ifqHEdyuc3UNCy91PDGkWKY5UQ4coHNYfnwFggrqD6QPeFGAlg==` | `npm ci --ignore-scripts` from `.github/windows-installer-spike/package-lock.json` (every entry from registry.npmjs.org with a SHA-512 integrity); its one install script, which selects the package's own bundled x64 7-Zip in `vendor/` (nothing from the runner), is run explicitly. |
| Squirrel.Windows binaries inside it | Update.exe 2.0.1, Setup.exe 1.9.1, NuGet 2.8.3, 7-Zip 16.04, signtool 6.1.7600, rcedit 0.2.0 | Pinned by the npm integrity above; the summary records each binary's SHA-256. |
| .NET runtime for WiX 5 | the runner image's .NET 6: 6.0.46 in the cited run, 6.0.47 on the runner of run 39899654879 | Recorded, not downloaded and not pinned, so it varies with the runner image. WiX 5 asks for .NET 6 with `rollForward: Major`, so it runs on .NET 6 whenever the image has it (§3.7). |

No step downloads anything else, restores an npm cache, or sets `npm_config_build_from_source`
anywhere but the workflow's top-level `env` (#315); `test/windows-installer-spike.test.ts` pins
all of it.

### The lifecycle

Each installer gets a new local account in the Users group, never Administrators. Every action
runs in that account's own logon session (`Start-Process -Credential -LoadUserProfile`); every
step fails unless its token is that user's and not an administrator's, and records its
integrity level (Medium throughout). The steps are: install the base version silently; launch
it from its Start-menu shortcut and quit it; upgrade while it runs; upgrade with it closed (when
the first upgrade did not finish cleanly); launch again; for the MSI, a silent repair by product
code after deleting files, both with the source `.msi` in place and with it renamed away;
uninstall after writing a sentinel file into `%USERPROFILE%\.agent-inbox`. For Squirrel the
spike then reinstalls the base and runs Squirrel's own updater (`Update.exe --update`),
launches and uninstalls again. After every install, upgrade and repair, the installed app folder
is compared file by file with the verified folder it came from.

### What this evidence cannot show

- The runner is Windows Server 2022, not a Windows 11 desktop. Start-menu indexing, toast
  notifications, SmartScreen and browser downloads were not exercised.
- Everything is unsigned.
- The app is unmodified: it neither sets an AppUserModelID nor handles Squirrel's events.
- The two builds differ only in version, so the upgrade proves replacement of the whole tree,
  not a migration.

---

## §2 — Results

Run [39893800330](https://github.com/shariqh/agent-inbox/actions/runs/39893800330), commit
`f041c3bf`, except where noted. Both versions hold 8,115 files and 560.5 MiB. Times are single
runs on a hosted runner and were up to twice as long in later runs, so only their order of
magnitude means anything.

| Measurement | MSI (WiX 5.0.2, per-user) | Squirrel.Windows (electron-winstaller 5.4.4) |
| --- | --- | --- |
| Installer size | 161.3 MiB `.msi` (LZX) | 203.3 MiB `Setup.exe` |
| Build time per installer | about 85 s | about 100 s |
| Silent install as a standard user (Medium integrity) | exit 0 in 20 s | exit 0 in 34 s |
| …under Windows Server's default installer policy | refused: 1625, "Non-assigned apps are disabled for non-admin users" | not subject to that policy |
| App processes during install | none | the app, started with `--squirrel-install`; it created `.agent-inbox\inbox.db` before anyone launched it |
| Install location | `%LOCALAPPDATA%\Programs\Agent Inbox` | `%LOCALAPPDATA%\AgentInbox\app-1.6.0` |
| Installed tree = verified folder | yes | yes, plus Squirrel's `squirrel.exe` and its log |
| Disk used after install | 560.5 MiB, plus a 161.3 MiB cached copy of the `.msi` in `C:\Windows\Installer` | 769.6 MiB (the app, plus a 205 MiB package copy kept for Squirrel's updater) |
| Deepest installed path | 200 characters for an 8-character user name; fits MAX_PATH for user names up to 67 | the same: 200 and 67 |
| Start-menu shortcut | `Programs\Agent Inbox.lnk` → the installed exe | none from Setup.exe; `Update.exe --createShortcut` (what an app's install hook runs) made `Programs\Shariq Hirani\Agent Inbox.lnk` → the root launcher stub |
| Shortcut AppUserModelID | `io.github.shariqh.agent-inbox` (set by the MSI) | `com.squirrel.AgentInbox.AgentInbox` (Squirrel's fixed pattern) |
| Shortcut toast activator CLSID | `{08973E92-A6EF-47B2-9E91-A876F4B8F210}`, with its `LocalServer32` registration owned by the MSI | `{FB7E709B-6561-538D-86A3-6C663B6BB412}`, derived from the ID; no registration |
| Launch from the shortcut, then quit | ready in under a second; closed by its window; port released | the same |
| Upgrade while the app runs | exit 0 in 46 s, tree = 1.6.1. The running 1.6.0 kept running from 15 in-use files Windows Installer had moved aside for deletion at the next reboot (counted in run 39896941593), and then quit only when killed | exit 0 in 30 s, tree = 1.6.1. Setup.exe killed the running app, deleted the 1.6.0 folder, and started 1.6.1 with `--squirrel-install` |
| Install location after upgrade | the same folder | `app-1.6.1`; the shortcut's working directory still named the deleted `app-1.6.0` |
| Installed-apps entries after upgrade | one, 1.6.1 | one, 1.6.1 |
| Silent repair by product code (`msiexec /fomus`), `.msi` in place | exit 0; deleted `Agent Inbox.exe` and `dist\store.js` restored | none |
| The same repair, `.msi` renamed away | exit 1603 (1706, no valid source); nothing restored | none |
| Uninstall | exit 0 in 20 s; folder, shortcut, registry and COM entries removed | exit 0 in 12 s; started the app with `--squirrel-uninstall`; left `%LOCALAPPDATA%\AgentInbox` (`.dead`, `Update.exe`, the whole `app-1.6.1`), `%LOCALAPPDATA%\SquirrelTemp` and the Start-menu shortcut |
| `%USERPROFILE%\.agent-inbox` after uninstall | kept (sentinel file and `inbox.db`) | kept |
| Left by either | `%APPDATA%\agent-inbox`, the Chromium profile the app itself creates | the same |
| Squirrel's own updater, `Update.exe --update` | — | exit 0 in 29 s; `app-1.6.0` and `app-1.6.1` side by side (1.30 GiB); next launch ran 1.6.1; uninstall again left `app-1.6.1` |
| PE files that need a signature | the folder's 10 unsigned files, then the `.msi` | the folder's 10, plus `squirrel.exe`/`Update.exe`, the stub and `Setup.exe` |
| Other checks | ICE validation reports ICE38 ×8115, ICE64 ×1597 (errors) and ICE91 ×8115 (warnings), as WiX documents for `Files` in a per-user package; uninstall still removed every folder | electron-winstaller's default package list drops `LICENSES.chromium.html` and `version`; the spike supplies its own list |

The start-apps list (`shell:AppsFolder`) listed nothing at all for either user in the runner's
session, so whether Windows indexes each shortcut under its AppUserModelID is left to the clean
Windows 11 machine.

---

## §3 — Findings

### 3.1 Per-user install without elevation

Both installed silently into the user's profile, with the standard user's own token at Medium
integrity. On Windows Server, though, an unelevated per-user MSI install is refused unless the
machine sets Windows Installer's `DisableMSI` policy to 0: Microsoft documents that server
default as blocking unmanaged installs, client Windows allows them, and the runner (Windows
Server 2022) refused one. The spike recorded that refusal, then set `DisableMSI=0` (the client
default) for the rest of the MSI lifecycle, and put the previous setting back afterwards.
Machines whose administrators set the same policy will refuse the MSI; #87's portable ZIP
covers them.

### 3.2 What each installer runs

Electron's executable carries `SquirrelAwareVersion=1` in its version resource, so Squirrel
hands every lifecycle event to the app: it starts `Agent Inbox.exe --squirrel-install`
(`--squirrel-updated`, `--squirrel-uninstall`) and waits up to 15 seconds (10 for uninstall)
before killing it, and it creates no shortcut itself. Its log shows exactly that: "Squirrel
Enabled Apps: [...\Agent Inbox.exe]", then "Couldn't run Squirrel hook, continuing ... The
operation was canceled". Today's app treats those flags as a normal
launch, so each install, upgrade and uninstall briefly ran the full app, which created the inbox
database before the user had opened anything. Choosing Squirrel would mean handling those events in
`electron/main.cjs` (create or remove the shortcut through `Update.exe`, then quit at once), the
job `electron-squirrel-startup` does for other apps. The MSI starts nothing.

### 3.3 Shortcut, AppUserModelID and notifications

Electron's notification guide requires an unpackaged Windows app to have a Start-menu shortcut
carrying the app's AppUserModelID and a matching toast activator CLSID. Electron 43 handles part
of this itself, at the first notification
(`shell/browser/notifications/win/windows_toast_activator.cc`): it looks for
`Programs\<product name>.lnk`, adopts that shortcut's CLSID, rewrites the shortcut when its
AppUserModelID, target or working directory differ from the running app's, and registers the
CLSID's `LocalServer32` under `HKCU\Software\Classes\CLSID`.

- **MSI.** Its shortcut is exactly `Programs\Agent Inbox.lnk`, with
  `io.github.shariqh.agent-inbox` (the bundle ID the other platforms use) and a fixed CLSID, and
  the MSI owns the matching COM registration, so uninstall removes it. The app still uses
  Electron's default ID, `electron.app.Agent Inbox`, so 2b must call
  `app.setAppUserModelId('io.github.shariqh.agent-inbox')` before the first notification;
  otherwise Electron would rewrite the MSI's shortcut to its own ID. Electron also compares the
  shortcut's working directory literally, and Windows Installer writes it with a trailing
  backslash, so the first notification will rewrite the shortcut once, with the same ID and
  CLSID; uninstall still removes it by name. 2c should confirm this on Windows 11.
- **Squirrel.** Electron sets the `com.squirrel.<package>.<exe>` ID by itself when it finds
  `..\Update.exe`, and that matches Squirrel's shortcut. But Squirrel puts its shortcut in a
  folder named after the authors (`Programs\Shariq Hirani\`), where Electron does not look, so
  the first notification would create a second shortcut that nothing removes.

### 3.4 Upgrade

The MSI upgrade removed 1.6.0 and installed 1.6.1 into the same folder, kept one
installed-apps entry, and left the installed tree identical to the verified 1.6.1 folder, even
with 1.6.0 running. Windows Installer's Restart Manager reported closing the app, but the app
kept running from files moved aside for deletion at the next reboot, and then quit only when
killed. The app should therefore exit when Windows asks it to (Restart Manager sends the
session-end messages Electron reports as `query-session-end` and `session-end`), or the
installer should close it first. (§9.4 corrects this reading: Windows Installer detected no
app, and the app did not quit because the spike's close request reached another window.)

Squirrel's Setup.exe treats a second install as a fresh one: it kills the app, deletes the whole
install, installs `app-1.6.1`, and leaves the old shortcut pointing its working directory at a
folder that no longer exists. Its own updater (`Update.exe --update`), which a notify-only
design would not use, kept both version folders after updating and after the next launch.

### 3.5 Repair

A silent repair by product code (`msiexec /fomus {ProductCode} /qn`) restored both a deleted
executable and a deleted script. With the `.msi` the product was installed from renamed away,
the same repair failed (1603, error 1706: no valid source), so a silent product-code repair
needs the original source. The spike tried no other route, such as repairing from a fresh copy
of the `.msi`. Users who delete the download can still reinstall from a new copy; 2b's
documentation should say so. Squirrel has nothing comparable.

### 3.6 Uninstall and leftovers

The MSI removed every file and folder it installed, including the now empty
`%LOCALAPPDATA%\Programs`, plus its shortcut, its `HKCU` keys and the COM registration. Squirrel
left the whole `app-1.6.1` folder, `Update.exe`, a `.dead` marker, its temp folder and the
Start-menu shortcut. Squirrel's log does not say why the folder stayed. The likely cause is
today's app: the uninstall hook had started it seconds earlier, so its files were probably still
in use when Squirrel deleted the folder. Both kept `%USERPROFILE%\.agent-inbox`,
and neither removed `%APPDATA%\agent-inbox`, the Chromium profile the app creates; whether an
uninstall should is a product question for 2b, not an installer difference.

### 3.7 Tools and licences

| | WiX | electron-winstaller / Squirrel.Windows |
| --- | --- | --- |
| Latest release | v7.0.0, 2026-04-06; annual majors | electron-winstaller 5.4.4, 2026-07-01; Squirrel.Windows 2.0.1, 2020-09-27, maintainers wanted |
| Runs on | .NET 6 (v5) or .NET 8 (v7), each with `rollForward: Major`: a newer .NET runs it only when its own major is missing | Node, plus the Windows binaries it bundles: Squirrel 2.0.1 (2020), NuGet 2.8.3, 7-Zip 16.04 (2016), signtool 6.1.7600 (Windows 7 SDK) and rcedit 0.2.0 |
| Support for that runtime | .NET 6 ended 2024-11-12; .NET 8 ends 2026-11-10; .NET 10 runs to 2028-11-14 | the .NET Framework that ships with Windows |
| Licence | MS-RL source; v6+ binaries under the Open Source Maintenance Fee EULA (§8.3) | MIT |
| Consumer security fixes | v5 ended 2026-02-05; v6 until 2027-02-05; v7 current | none upstream since 2020 |

The runners reported their .NET 6 runtime as 6.0.46 in most runs and 6.0.47 in run
39899654879. Neither appears in Microsoft's public .NET 6 release metadata, which ends at 6.0.36
on 2024-11-12, so the spike's WiX ran on a runtime build that comes with the runner image rather
than from a public .NET release, on a .NET version Microsoft no longer supports. That does not
change the comparison, but PR 2b must choose WiX's runtime on purpose (§6).

---

## §4 — Recommendation and reasoning

The plan going into the spike favoured the MSI for three reasons. The measurements support all
three, and add more.

1. **A fixed install folder.** Measured: the MSI upgraded in place; Squirrel moved to a new
   `app-<version>` folder and left a stale working directory behind. Setup's runtime is copied
   to `%USERPROFILE%\.agent-inbox\runtime`, so either layout works for the MCP runtime, but
   everything that names the app's path (shortcuts, the toast activator's `LocalServer32`, a
   user's pinned taskbar entry) stays valid only with a fixed folder.
2. **Repair, upgrade and uninstall built in.** Measured: all three worked, with the caveat
   that the silent product-code repair needs the original source. Squirrel has no repair, and
   its uninstall left most of the install behind with today's app.
3. **One container to sign.** Measured: ten app files plus the `.msi`, in plain steps any
   provider supports; Squirrel adds three of its own executables that must be signed inside
   its build.

Further, the MSI starts nothing during install, needs a few lines of app code (its
AppUserModelID and toast CLSID, and exiting when Windows asks) where Squirrel needs a handler
for four lifecycle flags, downloads 42 MiB less, and is built by maintained tools. Its costs are
the DisableMSI refusal on servers and locked-down machines (the portable ZIP covers those), the
ICE errors (accepted for a per-user package, or avoided by a dual-purpose package, §6), and the
WiX licence decision (§8.3).

Squirrel's one real advantage, a built-in background updater with delta packages, is outside
#87's scope: updates stay notify-only through the existing signed manifest.

---

## §5 — Signing

The spike signs nothing. It records what a signing step would have to cover, from the files
this build actually produced (`signing-surface.ps1`).

### What needs a signature

The verified folder holds 13 PE files. Three already carry valid, timestamped vendor
signatures and keep them: `d3dcompiler_47.dll` and `dxil.dll` (Microsoft) and the runtime's
`node.exe` (OpenJS Foundation). Ten have none: `Agent Inbox.exe`, `dxcompiler.dll`,
`ffmpeg.dll`, `libEGL.dll`, `libGLESv2.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`, and three
native addons, the app's and the runtime's `better_sqlite3.node` and the runtime's
`test_extension.node` (a test build of better-sqlite3 that should not ship at all).

The runtime's files are listed, with their hashes, in its `runtime-manifest.json`, whose digest
`setup-info.json` pins. So the macOS order applies on Windows too: sign the runtime's PE files,
regenerate its manifest and the setup-info digest, sign the app's PE files, verify the folder,
and only then package. Nested bytes must not change after that.

### MSI

1. Sign the folder's ten unsigned PE files in the order above.
2. Build the MSI from the signed folder. Its cabinets are embedded.
3. Sign the `.msi` last, SHA-256 with an RFC 3161 timestamp. The signature covers the embedded
   cabinets.
4. Verify the publisher, chain and timestamp of the `.msi` and of every PE file it installs.

Every step signs one file in place, so every provider in #87's order fits: Azure Artifact
Signing through its `signtool` client, SignPath (which can also sign an MSI's nested files and
then the MSI itself from one submission), or an HSM-backed certificate with `signtool`.

### Squirrel

1. The same ten folder PE files.
2. Plus three unsigned executables Squirrel adds: its `Update.exe` (shipped twice, inside
   Setup.exe's payload and as `squirrel.exe` in every version folder), the launcher stub it
   generates (`Agent Inbox_ExecutionStub.exe`, installed as `%LOCALAPPDATA%\AgentInbox\Agent
   Inbox.exe`), and `Setup.exe`.
3. The stub and Setup.exe only exist inside `Squirrel.exe --releasify`, and Setup.exe embeds the
   package, so they can only be signed inside that step: through `--signWithParams` (raw
   `signtool` arguments) or electron-winstaller's `windowsSign` hook. The bundled `signtool.exe`
   is 6.1.7600 (Windows 7 SDK), far older than the 10.0.22621.755 that Azure Artifact Signing's
   client requires, so the hook would have to replace it.
4. The `.nupkg` and `RELEASES` files are not Authenticode-signed. Squirrel's own updater trusts
   the SHA-1 in `RELEASES`.

So Squirrel needs a provider that runs as a local, per-file signing command in the middle of
its build. Azure Artifact Signing or an HSM certificate can; a submit-and-download service such
as SignPath would need a per-file hook and per-file approval inside that step.

---

## §6 — What PR 2b needs

PR 2b ("the chosen installer builder, pinned, unsigned, with the shortcut and AppUserModelID,
plus `SHA256SUMS-windows.txt`") should:

1. **Pin WiX** at the version §8.3 settles, the same way the spike does: exact URL, nuget.org
   package hash and SHA-256, a private feed and an empty package cache, and a test like
   `test/windows-installer-spike.test.ts`.
2. **Keep the installer identity permanent:** the UpgradeCode
   `{086C4AF7-CD48-4050-A328-CA911E7F7423}`, the AppUserModelID
   `io.github.shariqh.agent-inbox` and the toast activator CLSID
   `{08973E92-A6EF-47B2-9E91-A876F4B8F210}` in `.github/windows-installer-spike/tools.json`.
   Nothing has shipped with them, so 2b may choose new ones once, but never again after that.
3. **Call `app.setAppUserModelId` and `app.setToastActivatorCLSID`** with those values early in
   `electron/main.cjs` on Windows, so Electron accepts the MSI's shortcut instead of rewriting it.
4. **Make the app exit when Windows asks** (Restart Manager's session-end request), so an
   upgrade or uninstall never leaves the old process running.
5. **Decide the ICE question:** keep `Scope="perUser"` and accept ICE38/ICE64/ICE91, which
   guard roaming and multi-user cases that do not apply, or use a dual-purpose
   `perUserOrMachine` package, which WiX recommends for `Files` and which installs per-user by
   default.
6. **Name and hash the artifact** (`Agent-Inbox-vX.Y.Z-windows-x64.msi`, `SHA256SUMS-windows.txt`)
   without adding a target to the update manifest.
7. **Remember MSI versions hold only `major.minor.patch`.** A prerelease such as `1.7.0-rc.1`
   cannot be expressed, and two builds of one version cannot upgrade each other.
8. **Decide the minimum Windows check.** The inputs pin Windows 10.0.17763, but Windows
   Installer reports Windows 10 and 11 as version 6.3 (`VersionNT` 603), so a launch condition
   needs the real build number from the registry.
9. **Run WiX on a supported .NET, and record which.** WiX asks for its own .NET major (6 for v5,
   8 for v7) and uses it whenever the runner has it. .NET 6 support ended on 2024-11-12, and .NET
   8's ends on 2026-11-10. 2b should pick the runtime deliberately (for example .NET 10,
   supported to 2028-11-14), build and validate on it, and record it in the job summary. The
   spike did not test WiX on a newer runtime than it asks for.

Separately, and not part of any installer slice: the runtime payload still ships
better-sqlite3's MSBuild `obj` and `.tlog` files and `test_extension.node`. They hold the deepest
path (147 of the 200 characters above) and should be pruned like the app's copy, in its own
issue.

---

## §7 — What this PR does not change

- No release, aggregation or update-manifest wiring; no Windows target in `TARGET_SPECS`.
- `windows-native-folder.yml` only gains `workflow_call:`; its steps, gates and artifact are
  unchanged, and it still never mentions an installer tool.
- Setup and the updater stay off on Windows. The app's code is unchanged.
- The installers built here are unsigned CI artifacts with a seven-day retention.

---

## §8 — Open decisions for the owner

1. **Signing provider.** #87's order stands: Azure Artifact Signing if Bundle LLC is eligible,
   else SignPath Foundation, else an HSM-backed certificate. With the MSI, any of the three fits
   the build (§5). Nothing in PR 2b depends on the choice; the signing slice does.
2. **A clean Windows 11 x64 test machine.** 2c's acceptance needs a real Windows 11 desktop: an
   x64 PC or an x64 cloud VM. A Windows-on-Arm VM on an Apple Silicon Mac does not count, because
   the product is x64 and the acceptance criteria are x64. It is where Start-menu indexing,
   toast notifications, SmartScreen on a browser download and the interactive install, upgrade
   and uninstall get checked; the CI runner cannot show those.
3. **WiX version and licence.** Each choice has a cost:
   - **WiX v7.0.0** (current). Its binaries come under the Open Source Maintenance Fee EULA
     v1.1: a fee applies only to users who use WiX for revenue-generating activities and have
     annual gross revenue of at least US$10,000. Every build must pass `-acceptEula wix7` (or
     run `wix eula accept wix7` first), which only the owner can agree to.
   - **WiX v6.0.2.** The earlier OSMF EULA, without the revenue threshold; consumer security
     fixes until 2027-02-05.
   - **WiX v5.0.2** (what the spike used). MS-RL only, no EULA, but consumer security fixes
     ended on 2026-02-05, and it asks for .NET 6, which Microsoft stopped supporting in 2024.
   - **WiX built from source.** MS-RL only; the EULA covers just the published binaries. It
     costs a pinned source build in CI.

   The recommendation is v7 if the owner accepts its EULA, else WiX built from source. Either way
   the authoring here carries over: it uses the v4 schema all four share.

   **Decided on 2026-10-23: WiX v7.** The owner accepted the Open Source Maintenance Fee EULA
   v1.1 for the project that day. No fee applies, since Agent Inbox has no revenue. PR 2b passes
   that acceptance to WiX only through its documented `-acceptEula wix7` switch (§9).

---

## §9 — PR 2b: the pinned, unsigned per-user MSI

PR 2b built the MSI §4 recommends, with WiX 7.0.0 as §8.3 decided.
`.github/workflows/windows-msi.yml` replaces the spike workflow. It calls the native folder
workflow, rebuilds the same commit one patch version later as the upgrade, builds an MSI from
each folder and runs the lifecycle below as a fresh standard user. Only when `summary.mjs`
finds that every requirement held does it upload `Agent-Inbox-vX.Y.Z-windows-x64.msi` and
`SHA256SUMS-windows.txt`, as the seven-day `windows-x64-msi-unsigned` artifact. Nothing is
signed or published, and the update manifest gains no target. The spike's MSI harness moved to
`.github/windows-msi/`; its Squirrel tooling and workflow are gone.

### 9.1 Pins

| Tool | Pin | How it runs |
| --- | --- | --- |
| WiX 7.0.0 (reports `7.0.0+b8977d6`) | nuget.org's `wix` package by exact URL; SHA-512 `4GbdoDWjm0QmBLyJ8PPiknXomjI5vHat4H27AB6NNGzFpbEhN9Xw0kiPQokZ3zH8F1RcjvDSn8yGDXwKxlW8Tg==` (nuget.org's `packageHash`), SHA-256 `7f992e57c356dcbda2ea961bf3b348e1bd7d31d96795be4ac391e04cf140536d`, source commit `b8977d6f88e7b68e000bac226a2814f236770570` | Extracted, never installed as a .NET tool; its `tools/net8.0/any/wix.dll` runs under the runtime below. `build` and `msi validate` get `-acceptEula wix7`, the only acceptance anywhere: nothing writes WiX's per-user acceptance file. |
| .NET runtime 10.0.13 (`Microsoft.NETCore.App`, LTS, supported until 2028-11-14) | Microsoft's `win-x64` runtime zip by exact URL; the SHA-512 its release metadata publishes, and the SHA-256 | `dotnet exec --fx-version 10.0.13` from the extracted runtime, with every `DOTNET_` and `COREHOST_` variable cleared. The host trace must show `coreclr.dll` loaded from the pinned runtime, and the job summary records it. |

WiX 7 asks for .NET 8 with `rollForward: Major`, and .NET 8's support ends on 2026-11-10, so
the build names .NET 10 itself instead of letting the host choose. The runner's own .NET
(8.0.31 and 10.0.12 in these runs) is never used, so an image update cannot change the result,
unlike the spike's WiX 5, which ran on whatever .NET 6 the image had. On .NET 10, WiX built the
package and passed ICE validation with warnings as errors.

### 9.2 Answers to §6

1. **WiX pinned** as above. `test/windows-msi.test.ts` pins the URLs, digests, switch and
   workflow rules.
2. **Identity.** The spike's UpgradeCode, AppUserModelID and CLSID are now permanent. They are
   held in `installer.json`, `release/windows-inputs.json` and `electron/windows-app.cjs`; a
   test keeps them equal, and the build reads the package back and refuses any difference.
3. **AppUserModelID and CLSID.** `electron/windows-app.cjs` sets both at startup on Windows
   (§9.5).
4. **Exit when Windows asks.** Done for Restart Manager's request, but a silent upgrade never
   makes it, so an upgrade can still leave the old process running (§9.4).
5. **ICE.** `Scope="perUser"` stays. ICE validation passes with warnings as errors, waiving only
   ICE38, ICE64 and ICE91.
6. **Artifact.** Named as proposed, with `SHA256SUMS-windows.txt` in `sha256sum -c` form. No
   update-manifest target is added.
7. **Versions.** The build refuses any version other than `major.minor.patch`. There is no
   `AllowSameVersionUpgrades`, so a rebuild needs a new patch version.
8. **Minimum Windows.** A launch condition reads `CurrentBuildNumber` from the registry and
   refuses builds below 17763. `Installed OR` keeps it from blocking a repair or an uninstall.
9. **.NET.** 10.0.13, as above.

### 9.3 Evidence

Run [40021288282](https://github.com/shariqh/agent-inbox/actions/runs/40021288282), commit
`d95dd504`, upgraded 1.6.0 to 1.6.1. Later commits changed only comments, documentation and how
the evidence counts Windows' notification history. Every step ran as a fresh standard user in
that user's own session at Medium integrity on `windows-2022`. Times are from that run.

| Step | Result |
| --- | --- |
| Install under Windows Server's default policy | Refused, 1625: unelevated per-user installs of unmanaged packages are off on servers. The run then set `DisableMSI` to 0, the Windows 10 and 11 default, and put it back at the end. |
| Install | Exit 0 in 19.9 s. The tree matched the verified folder. The shortcut carried the AppUserModelID and the CLSID, and `LocalServer32` named the installed exe. |
| Launch from the shortcut, leave it open 20 s, then close its window | Ready in 0.7 s; closed in 0.6 s, port released. |
| Notification, with the shortcut | Shown: Windows' notification history holds it under `io.github.shariqh.agent-inbox`. Electron rewrote the shortcut once, dropping the working directory's trailing backslash and replacing its description, and rewrote the CLSID's registration in its own form (an unquoted `LocalServer32` naming the same exe). The AppUserModelID and CLSID stayed the same, and uninstall still removed both. |
| Notification, without the shortcut | Electron created `Programs\Agent Inbox.lnk` with exactly the MSI's AppUserModelID and CLSID. |
| Restart Manager asks the app to close | Asked through the SQLite addon (§9.4): `RmShutdown` returned 0 in 0.2 s, and the app logged its quit line and exited 0, with every process gone in 0.3 s and its port released. |
| Upgrade while the app runs | Exit 0 in 46.8 s. The tree matched the 1.6.1 folder, with one product and one installed-apps entry. The old app kept running (§9.4). |
| Launch after the upgrade | Ready in 1.0 s from the upgraded tree; closed in 0.3 s. |
| Repair by product code | With the `.msi` in place: 0 in 17.1 s, deleted files restored. With it renamed away: 1603 (no valid source). With it back: 0. |
| Uninstall | Exit 0 in 21.9 s. The app folder, shortcut, CLSID registration and installed-apps entry were removed; `%USERPROFILE%\.agent-inbox` (sentinel and `inbox.db`) was kept. The one other leftover is `%APPDATA%\agent-inbox`, the Chromium profile the app creates (§3.6). |

The MSI is 143,217,058 bytes (136.6 MiB). The installed tree is 4,890 files and 452,400,743
bytes. The deepest installed path is 187 characters for a seven-character user name, so it fits
MAX_PATH for user names up to 79 characters.

### 9.4 Closing the app

PR 2b's runs found three things the spike missed.

- **The spike's "quit only when killed" was the harness.** `Process.CloseMainWindow` asks the
  first visible, unowned window, and a few seconds after launch the app's process had a second,
  untitled one above its window (most likely a Chromium tooltip under the resting pointer). The
  close request went to that window, so the app's own window never got one. Closed through the
  window titled `Agent Inbox`, as the close button would, the app quit in 0.6 s.
- **Restart Manager cannot ask an Electron app as a whole without forcing it.** For
  `Agent Inbox.exe`, it lists the main process as a main window and Chromium's GPU, network and
  renderer processes as unknown apps. `RmShutdown` without `RmForceShutdown` then refuses at once
  (351), and with it would end those processes rather than ask. A runner process
  (`provjobd.exe`) that Restart Manager counts as critical also sometimes holds the executable
  (350). Asked about the SQLite addon, which only the main process loads, Restart Manager asks
  just the app's window. The app quits through `app.quit()`, and its child processes and port
  go with it.
- **A silent upgrade does not ask at all.** Windows Installer opened Restart Manager sessions and
  logged "Successfully shut down all applications that held files in use" within 30 ms,
  without detecting the app; the spike read that line as closing it. The old app kept running
  on its moved-aside files (15 of them scheduled for deletion at the next reboot). The upgrade
  still exited 0 with the new tree, and the next launch ran 1.6.1.

So the app's Restart Manager handling works, but nothing in the MSI path triggers it. Closing
the app before an upgrade stays open for the Windows update slice (#343). The options are:

- the in-app updater quits the app before it runs the MSI, as the macOS install helper waits
  for the app to exit, with no installer change;
- WiX's Util extension `CloseApplication`, which asks the app's windows to close before files
  are replaced, at the cost of another pinned WiX extension and a custom action;
- accepting it: the upgrade succeeds, and the old app runs on until it is closed.

### 9.5 Electron main

`electron/windows-app.cjs` does nothing outside Windows. `main.cjs` calls it twice:

- `setWindowsAppIdentity` at module load, before any window or notification. Otherwise
  Electron's first notification would rewrite the MSI's shortcut to its default ID, or make up
  a CLSID when there is no shortcut.
- `quitWhenRestartManagerAsks` on the window. A `session-end` whose reasons include `close-app`
  calls `app.quit()`, because Electron 43 otherwise ends the process at once on
  `WM_ENDSESSION`, skipping `beforeunload` (staged sends, drafts) and `will-quit`'s storage
  flush. A shutdown or log-off keeps Electron's immediate exit.

A failure to set the identity is logged and the app starts anyway.

### 9.6 Not covered

- A Windows 11 desktop (§8.2): Start-menu search, SmartScreen on a browser download and the
  interactive installer UI.
- A click on a notification, which would start the app through the CLSID's `LocalServer32`.
- Signing (§8.1).
- An upgrade from a published MSI, since none exists yet.
