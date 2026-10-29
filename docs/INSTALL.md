# Install

## Supported hosts

| Surface | Support |
|---|---|
| Notarized desktop app | macOS 13.5+ on Apple silicon |
| Portable Linux desktop app | x64/arm64 AppImage; kernel 4.18+, glibc 2.34+, GLIBCXX_3.4.29+ |
| Debian package | Ubuntu 22.04+/Debian 12+ on amd64 or arm64 |
| MCP server and browser viewer | macOS and Linux with Node 24 |
| Agent setup installer | Claude Code and GitHub Copilot CLI on macOS/Linux |
| Electron source package | Apple silicon macOS with Node 24 |
| Windows | Not currently supported by the shell installers or Electron packager |

Agent Inbox is not published to npm. When a public release is available, download its
macOS DMG, Linux AppImage, or Debian package from
[GitHub Releases](https://github.com/shariqh/agent-inbox/releases). If no public release
is listed yet, use the source-build path below.

Packaged desktop apps can check the signed release manifest from **Settings → Updates**
or **Check for Updates…** in the app menu. Automatic checks are off by default and can
be enabled explicitly in Settings. A check makes a plain request to GitHub Releases,
sends no telemetry, and notifies once when a newer verified version is available.
On macOS and AppImage installs, **Download update** fetches exactly the package the
signed manifest names, only from GitHub Releases, and keeps it only when its size and
SHA-256 match the manifest. Downloads start only when you click, can be cancelled, and
are kept in a private `update-downloads` folder inside the app's data directory;
superseded and installed versions are cleaned up automatically. On macOS and AppImage
installs the verified download then offers **Install and restart** (see below). DEB
installs stay notify-only: **Review release** opens the verified GitHub release page so
you can install the package yourself.
Browser viewers and source/dev Electron runs do not expose update checks.

The app remembers the newest release version it has verified, in its own file
(`update-trust-state.json`) in the app's settings folder. If a later check receives older
signed release information, Settings → Updates says the information was out of date,
nothing older is offered, and the next check tries again. Reinstalling an older 1.3 or
later version still offers the newest verified release. Versions before 1.3 do not read
this file, so while a 1.2.x build is installed there is no rollback protection; it
resumes when a 1.3 or later build runs again. Update preferences keep their 1.2.x format,
so automatic checks stay as you set them in either direction. This protection starts
after the first successful check and resets if the app's settings folder is deleted.

### Install an update from the app (macOS)

After **Download update** verifies the file, Settings → Updates offers **Install and
restart**. It never starts on its own. The app can install updates only when:

- Agent Inbox runs from a folder you can change, such as **Applications**. A copy opened
  straight from the disk image or from a quarantined download (macOS "App Translocation")
  cannot replace itself; move it to Applications first.
- The app belongs to your user account and its folder is not read-only.
- Your Mac runs the macOS version the release requires (13.5 or later today).
- Agent setup is not running at the same moment.

When one of these is not met, Settings → Updates says why and offers **Review release**
instead of the download. If it says "Restart Agent Inbox to install this update." instead,
see [Install and restart asks you to restart first](#install-and-restart-asks-you-to-restart-first).
When you click **Install and restart**, the app:

1. re-checks the downloaded file against the signed size and SHA-256;
2. copies it to a private folder, opens it read-only, and copies the new Agent Inbox
   next to the current one;
3. checks that copy's bundle identifier and version, its Developer ID signature from team
   `VVR2DKR923`, and Gatekeeper's verdict;
4. quits. A small helper waits until Agent Inbox has fully exited, moves the current app
   aside, moves the new one into its place, and opens Agent Inbox again.

If any step before the swap fails, nothing changes and Settings shows **Try again**. If the
new app cannot be moved into place, the helper puts the previous app back and reopens it.
If the helper waits more than about two minutes for Agent Inbox to exit, it gives up
without changing anything.

When the swap does not happen, Agent Inbox says so the next time it opens: Settings →
Updates (and one notification) reads, for example, "Version 1.3.1 could not be installed,
so Agent Inbox is still on 1.3.0. macOS did not allow replacing the app." The same note
stays on the next offer of that version, so you can **Try again** knowingly or install it
manually. The app keeps this record in `last-attempt.json` (and the helper's
`last-attempt.result`) in its private `update-install` folder and deletes both once read.

The manual path always works: **Review release** opens the verified GitHub release; download
the DMG and drag Agent Inbox to Applications as described below.

The previous version is kept for at least an hour, in a hidden folder next to the app,
for example `/Applications/.agent-inbox-update-AbC123/Agent Inbox.app.previous`. Agent
Inbox removes that folder on a later launch. To go back to it by hand, quit Agent Inbox
and run, with your folder's real name:

```sh
mv "/Applications/Agent Inbox.app" ~/.Trash/
mv "/Applications/.agent-inbox-update-AbC123/Agent Inbox.app.previous" "/Applications/Agent Inbox.app"
```

### Install an update from the app (AppImage)

An AppImage updates itself in place. After **Download update** verifies the file,
Settings → Updates offers **Install and restart**, and the new version replaces the
AppImage file you started, under the same name and in the same folder, so launchers,
desktop entries and scripts that point at that file keep working. It never starts on its
own. The app can install updates only when:

- Agent Inbox runs from its AppImage file. A DEB install stays notify-only, even when it
  was started from inside another AppImage.
- It runs from the AppImage runtime's own FUSE mount of that file. An extracted copy
  (`--appimage-extract`, then `squashfs-root/AppRun`) and the extract-and-run fallback
  (`APPIMAGE_EXTRACT_AND_RUN` or `--appimage-extract-and-run`; see
  [the fallback](#appimage)) stay notify-only. A copy started from inside another
  AppImage, such as a terminal, therefore never replaces that application's file. Hosts
  that mount or extract the image themselves, such as `firejail --appimage` (a
  loop-mounted squashfs) or NixOS `appimage-run` (an extracted copy), get the same
  notify-only offer with **Review release**, by design.
- The AppImage is a regular file (not a symlink) that belongs to your user account, and
  both the file and its folder are writable, for example `~/Applications`.
- The file is still the one Agent Inbox started from. If you replaced or edited it while
  the app was running, restart Agent Inbox first.
- Agent setup is not running at the same moment.

When either of the first two is not met, Settings → Updates treats the app like a DEB
install: it shows the new version with **Review release** and no download. When another
is not met, it says why and offers **Review release** instead of the download. If it says
"Quit and reopen Agent Inbox to install this update." instead, see
[Install and restart asks you to restart first](#install-and-restart-asks-you-to-restart-first).
When you click **Install and restart**, the app:

1. re-checks the downloaded file against the signed size and SHA-256;
2. copies it into a hidden file next to your AppImage, for example
   `~/Applications/.Agent-Inbox-v1.3.0-linux-x86_64.AppImage.update-1a2b3c4d5e6f7a8b`,
   checking the size and SHA-256 again as it copies, and checks that the copy is an
   AppImage;
3. replaces your AppImage with that copy in one atomic rename. The running app keeps
   working from the version it started with;
4. quits. A small helper waits until Agent Inbox has fully exited and starts the new
   AppImage from the same path, with the arguments you started Agent Inbox with (for
   example `--no-sandbox` or `--ozone-platform=wayland`).

If any step before the rename fails, nothing changes and Settings shows **Try again**. After
the rename the new version is installed even if it does not open: when the helper cannot
start it, or waits more than about two minutes for Agent Inbox to exit, open Agent Inbox
again yourself.

Unlike on macOS, there is no failed-install note to show after an AppImage restart: the
file is already the new version before Agent Inbox quits, so whatever you open next from
it is the update.

The file keeps its name even when that name contains the previous version number; Settings
shows the version that is installed. The previous version is not kept, so to go back,
download it again from GitHub Releases. A hidden `.update-` file left by an interrupted
install is removed on a later launch once it is an hour old.

The manual path always works: **Review release** opens the verified GitHub release; download
the new AppImage and replace your file as described below.

### App opens blank after an upgrade

Older builds can mix cached interface files from different versions. If the app opens
but never loads its content or responds to clicks, choose **View → Force Reload**
(`Command-Shift-R` on macOS, `Ctrl-Shift-R` on Linux). This reloads the interface without
deleting saved Inbox data or preferences. Do not delete the database or reset browser
storage to recover from this problem. In 1.3.1 and earlier, a reload also stops **Install
and restart** from working until Agent Inbox restarts; see the next section.

### Install and restart asks you to restart first

Agent Inbox installs updates (and runs agent Setup) only from a window showing the viewer
that this app started itself. Reloading the window (**View → Reload**, **View → Force
Reload**, or the viewer's own reload after it restarts) or a crash of the window's content
withdraws that permission until the app has checked again.

- **1.3.2 and later:** after a reload, the app checks again that the window shows its own
  viewer and keeps **Install and restart** available. If it can't confirm that, for
  example because the viewer didn't answer in time, Settings → Updates says "Restart Agent
  Inbox to install this update." and offers **Restart Agent Inbox** on macOS. If agent
  setup is still running, the app doesn't restart yet and says so; try again when setup
  finishes. An AppImage says "Quit and reopen Agent Inbox to install this update."
  instead: quit Agent Inbox and open it again from your AppImage. Either way the verified
  download is kept: after the restart, click **Check now** and then **Download update**,
  which re-checks the file you already have instead of downloading it again, and then
  **Install and restart**.
- **1.3.1 and earlier:** after any reload or crash, **Install and restart** kept being
  offered but always failed with "Agent Inbox *X* couldn't be installed. Restart Agent Inbox
  to install this update." until the app restarted. Quit Agent Inbox (`Command-Q` on macOS,
  **File → Quit** on Linux), open it again, and repeat **Check now**, **Download update**
  and **Install and restart** in Settings → Updates without reloading the window first.

## Recommended macOS installation

When a public release is available, download `Agent-Inbox-vX.Y.Z-arm64.dmg` from GitHub
Releases, drag **Agent Inbox** to `/Applications`, and launch it. The app requires macOS
13.5 (Ventura) or later on a Mac with Apple silicon. It includes the matching Node 24 agent
runtime; no system Node installation is required.
Intel Macs stay on [v1.8.0](https://github.com/shariqh/agent-inbox/releases/tag/v1.8.0),
the last version for them.

On first launch, open **Setup**, select GitHub Copilot CLI, Claude Code, or both, then
choose **Install now**. Setup verifies and installs the bundled architecture-specific
runtime under `~/.agent-inbox/runtime/<content-derived-runtime-id>/`, registers the MCP
server, and adds the reporting instructions. Start a fresh agent session afterward.

Verify the selected DMG against the release checksum manifest:

```sh
ASSET=Agent-Inbox-vX.Y.Z-arm64.dmg
grep -F "  $ASSET" SHA256SUMS.txt | shasum -a 256 -c -
xcrun stapler validate "$ASSET"
spctl --assess --type open --context context:primary-signature --verbose=4 "$ASSET"
```

After copying the app to `/Applications`, macOS must also accept the app:

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/Agent Inbox.app"
xcrun stapler validate "/Applications/Agent Inbox.app"
spctl --assess --type execute --verbose=4 "/Applications/Agent Inbox.app"
```

These Gatekeeper and notarization claims apply only to the macOS package. Linux packages
currently use the exact release checksum manifest, not an OS-wide signing or attestation
claim.

## Recommended Linux installation

The Linux packages are native to their advertised architecture:

| Machine | AppImage | DEB |
|---|---|---|
| x86_64 / amd64 | `Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage` | `agent-inbox_X.Y.Z_amd64.deb` |
| arm64 / aarch64 | `Agent-Inbox-vX.Y.Z-linux-arm64.AppImage` | `agent-inbox_X.Y.Z_arm64.deb` |

The supported binary floor is Linux kernel 4.18 or newer, glibc 2.34 or newer, and
`GLIBCXX_3.4.29` (`libstdc++.so.6.0.29`) or newer. Representative first supported
distribution releases are Ubuntu 22.04, Debian 12, and RHEL 9. Other glibc-based
distributions meeting the same binary and desktop-library requirements may work, but are
not claimed as tested. Musl-only distributions and WSL desktop environments are not
supported.

### AppImage

Download `SHA256SUMS.txt` and the AppImage matching the host, then:

```sh
ASSET=Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage
# Use Agent-Inbox-vX.Y.Z-linux-arm64.AppImage on arm64.
grep -F "  $ASSET" SHA256SUMS.txt | sha256sum -c -
chmod +x "$ASSET"
./"$ASSET"
```

Normal AppImage mounting requires FUSE and unprivileged user namespaces. If `/dev/fuse`
is unavailable, use the AppImage runtime's extract-and-run mode with a private temporary
base:

```sh
ASSET=Agent-Inbox-vX.Y.Z-linux-x86_64.AppImage
APPIMAGE_TMPDIR="$(mktemp -d)"
chmod 0700 "$APPIMAGE_TMPDIR"
trap 'rm -rf -- "$APPIMAGE_TMPDIR"' EXIT
TMPDIR="$APPIMAGE_TMPDIR" APPIMAGE_EXTRACT_AND_RUN=1 ./"$ASSET"
```

Use the arm64 filename on arm64. The private mode-`0700` `TMPDIR` is required because
the pinned AppImage runtime uses a predictable child name while extracting. This fallback
extracts on every launch; it does not install a system launcher or delete user data.

In this mode Agent Inbox does not install its own updates: Settings → Updates offers
**Review release** instead. A restart from inside the app would extract into this
command's `TMPDIR` after the `trap` removed it, and the runtime would recreate that folder
without the private mode. To update, quit Agent Inbox, download and check the new
AppImage as above, replace your file with it, and run the same command again.

With normal FUSE mounting, later versions can replace this file in place from Settings →
Updates; see
[Install an update from the app (AppImage)](#install-an-update-from-the-app-appimage).

### Debian/Ubuntu package

Download `SHA256SUMS.txt` and the DEB matching the host, then install through apt so its
desktop-library dependencies are resolved:

```sh
ASSET=agent-inbox_X.Y.Z_amd64.deb
# Use agent-inbox_X.Y.Z_arm64.deb on arm64.
grep -F "  $ASSET" SHA256SUMS.txt | sha256sum -c -
sudo apt install "./$ASSET"
```

Launch **Agent Inbox** from the desktop menu or run `agent-inbox`. Remove package-owned
files with either command:

```sh
sudo apt remove agent-inbox
sudo apt purge agent-inbox
```

Both operations preserve `~/.agent-inbox`, including the inbox database and any runtime
copied there by Setup. The DEB owns no home-directory paths, maintainer scripts, or
configuration under `/etc`; reinstall and upgrade replace only package-owned `/usr`
files.

The AppImage and DEB both bundle the matching Linux Node 24 runtime. In **Setup**, choose
Claude Code, GitHub Copilot CLI, or both. Setup verifies and copies the runtime under
`~/.agent-inbox/runtime/<content-derived-runtime-id>/` before registering it, so moving
an AppImage or removing a DEB later does not break an installed agent integration.

## Source-build installation

GitHub CLI (`gh`) is optional and adds live PR state. Source-checkout Claude hook setup
requires `jq`; a portable release runtime uses its bundled Node helper instead.

Both transactional installers source the same kernel-backed Setup lease. On macOS
they use descriptor-mode `/usr/bin/lockf` when the OS provides it and otherwise
fall back to `flock`; Linux uses `flock` only. Newer macOS versions include
`lockf`, while older supported versions need `flock` on `PATH`. If neither is
available on macOS, install `flock` first:

```sh
brew install flock
```

Applied setup fails before protected mutation when its platform utility is
unavailable or the persistent lock path is not a plain regular file. The lock
file may remain after a process exits; kernel ownership, not file existence,
serializes setup.

## 1. Clone and build

```sh
git clone https://github.com/shariqh/agent-inbox.git
cd agent-inbox
npm ci
npm run build
```

## 2. Install the MCP server and agent instructions

The recommended installer handles both pieces. It is a dry run unless `--apply` is
present, verifies Node 24 against the built runtime, backs up every instruction file it
changes, and owns only content between `<!-- agent-inbox:begin -->` /
`<!-- agent-inbox:end -->`.

```sh
npm run install:agents                              # dry run for both hosts
npm run install:agents -- --apply                   # Claude + Copilot
npm run install:agents -- --apply --target claude   # Claude only
npm run install:agents -- --apply --target copilot  # Copilot only
npm run install:agents -- --apply --force           # replace existing MCP entries
npm run install:agents -- --apply --uninstall       # remove managed entries/blocks
```

MCP registration cannot itself inject instructions into a host: `mcp add` stores a
transport command and arguments, while global prompts belong to each host. The installer
is the explicit, auditable one-command equivalent—it performs both operations without
changing anything during package install, build, or Electron launch.

The Electron app exposes the same choices in **Setup**. Select both hosts,
Claude only, or Copilot only, then choose **Install now**, **Copy prompt for
agent**, or **Copy terminal command**. The direct button calls the same audited
installer and is available only in an Electron window backed by the viewer
process that app started; browser tabs and reused third-party localhost pages
never receive command-execution access.

In a portable package, Setup verifies the exact architecture payload embedded in the
app, atomically installs it under
`~/.agent-inbox/runtime/<content-derived-runtime-id>/`, proves its Node 24 native addon,
and registers the installed paths. The release metadata and host configuration contain
no CI checkout, build-machine Node, or movable app path. A packaged upgrade replaces
only a prior manifest-owned release registration; a checkout/custom registration is
left untouched. Uninstall likewise removes only exact owned release state and retains
any runtime still referenced by another host or Claude hook.

### After an app update

An app update does not move your agents by itself, and a running agent session keeps
the MCP server build it started with until it restarts. Setup's **Agents** section
shows which build each host is registered to run, compared with the runtime the app
bundles:

```text
Claude Code: v1.2.8 runtime (Setup) — older than this app's v1.3.0
Copilot CLI: source checkout at /Users/you/src/agent-inbox (not managed by Setup)
Claude hooks: not installed
```

It reads only the `agent-inbox` entry of `~/.claude.json` and
`~/.copilot/mcp-config.json`, and the agent-inbox hook entries of
`~/.claude/settings.json`. Other MCP servers and their settings are never shown, and
nothing is run to find this out.

- **Update agents** appears when a host registered by Setup runs an older runtime. It
  runs the same installer as **Install now** for exactly those hosts, keeping its
  timestamped backups and managed-block rules. It never replaces a checkout or custom
  registration, and it is available only in the Agent Inbox app's own window.
- **Match agents to vX** appears instead when a host registered by Setup runs a *newer*
  runtime than the app, for example after you went back to an older app version. It
  runs the same installer, which moves the host back to the app's runtime; if one host
  is behind and another ahead, this one action moves both.
- **Each host is moved on its own.** Setup runs the installer for Claude Code, then for
  Copilot CLI, and shows each host's result. If one host cannot be moved (for example
  its CLI was uninstalled), the other still is.
- **Restart running sessions afterward.** Setup then says how many sessions of each
  moved host still run another build: exit each one and run `claude --resume` or
  `copilot --resume` to pick it back up. Live marks them too: sessions on an older
  build, and sessions still on a newer build after Match agents.
- **A source checkout** updates in place: run `git pull` and `npm run build` in it,
  then restart its sessions.
- **Claude hooks** that a Setup runtime installed move with your agents: Setup runs the
  app's own runtime installer for them, `install-hooks.sh --apply --move-only` from
  `~/.agent-inbox/runtime/<runtime-id>/`, as a step of its own after Claude Code and
  Copilot CLI, and then says whether they now run the app's runtime. `--move-only` makes
  the installer write nothing where no Setup runtime's hooks are there, so Setup never
  installs hooks you don't have. If no agent needs
  moving, the step appears once the app's runtime is installed. In a browser tab, Setup
  shows that command for a terminal instead. When Claude Code runs from a source
  checkout, Setup never installs the app's runtime for it, so it shows the checkout's
  own `npm run install:hooks -- --apply --replace-existing` (after a `cd` into the
  checkout) to run in a terminal with Node 24. Hooks installed from a source checkout are
  never moved by Setup; switch them with `--replace-existing` (a 1.3.2 or later
  runtime), see [the backstop hooks](#5-optional-the-backstop-hooks-issues-10--21).
  Nor are hooks of a runtime outside Setup's folder, which Setup reports as not verified.
  Claude Code's documentation says it normally applies changed hooks to running sessions
  too; restart a session to be sure.

Nothing runs when the app starts; updating agents is always your explicit choice.

### Removing old runtimes

Each runtime Setup installs under `~/.agent-inbox/runtime/<runtime-id>/` (or under
`AGENT_INBOX_RUNTIME_ROOT`, when the app's environment sets it to an absolute folder) takes
about 170 MB. The installer removes old ones only during an install, and even then keeps the
newest previous one. Setup's **Runtimes** section lists every runtime there, its size and
what uses it:

```text
v1.2.2: not used · 171 MB
v1.2.4: used by Claude Code settings · 171 MB
v1.7.0: this app's runtime · 171 MB
```

In the Agent Inbox app's own window, **Remove the v1.2.2 runtime** (or **Remove 2 unused
runtimes**) removes exactly the runtimes the list shows as not used. Setup reads the list
again just before it starts, and does nothing if it changed; the removal itself checks again,
under the setup lock, and keeps anything that has started being used. A line can also say
`1 running session reports v1.2.2`: an agent session still running the MCP server it
started with, which keeps that runtime until you exit it. A runtime that no longer matches
what was installed (a file added, removed or changed) is left alone, and so is any folder
that is not a runtime. If a host config exists but proves nothing (it is not valid JSON, for
example), the section names it and says why, and offers to remove nothing. Nothing is removed
when the app starts.

From a terminal, run a runtime's own `prune-runtimes.sh` (in a 1.7.0 or later runtime, or
the app's own copy inside `Agent Inbox.app/Contents/Resources/app/runtime/<platform-arch>/scripts/`):

```sh
bash ~/.agent-inbox/runtime/<runtime-id>/scripts/prune-runtimes.sh           # dry run
bash ~/.agent-inbox/runtime/<runtime-id>/scripts/prune-runtimes.sh --apply   # remove them
```

The dry run lists each runtime and what would happen to it, and changes nothing. With
`--apply` it takes the same setup lock as the installers and removes each runtime that:

- is not the runtime the script runs from;
- no host config uses: `~/.claude.json` (every scope in it, per-project servers included),
  `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.copilot/mcp-config.json`
  or Claude Desktop's config, wherever a value names the runtime (unless as a path to a
  folder that no longer exists) or a command, argument or environment path in an MCP server
  or hook leads into it, through a symlink or however its case or accents are spelled;
- no running process names, such as an agent session still running the MCP server it
  started with. Exit that session and run it again to remove that runtime too; and
- still matches what was installed. A runtime with a file added, removed or changed is
  kept and named, with what changed: a `.DS_Store` that Finder wrote when you opened the
  folder is enough. Delete what was added and run it again to remove that runtime too.

If a host config exists but cannot be read, nothing is removed; the script names the file
and why, but never quotes it, since it can hold a secret. Project-scope configs
(`<project>/.mcp.json`, `<project>/.claude/settings*.json`) are not read; a session started
from one is still protected while it runs. Each removal is the same one the installer
makes: the runtime folder is checked against its manifest and renamed into a `.trash-…`
folder before anything is deleted, so an interrupted removal never leaves half a runtime.

### If an install is interrupted

Stopping the installer partway (Ctrl-C, a closed terminal, Setup's cancel when the app
quits, or the app crashing) puts back what it had changed, then exits with 128 + the
signal number. A repeated Ctrl-C or cancel does not stop that restore. That includes the
steps that run a host CLI (such as `claude mcp remove`) or a packaged-runtime helper: each
runs in its own session, out of reach of those signals, for at most 30 seconds. If such a
step fails or does not finish in time, or anything cannot be put back, the installer
prints a warning and `report retained at …`, and keeps its report in a folder named
`agent-inbox-install.XXXXXX` in your temporary directory (`$TMPDIR`; on macOS
`getconf DARWIN_USER_TEMP_DIR` prints it, on Linux it is usually `/tmp`):

- `report.log` says what was restored and what was not.
- `claude.mcp-config` or `copilot.mcp-config`, when present, is a copy of that host's
  whole configuration file from before the install (`~/.claude.json` or
  `~/.copilot/mcp-config.json`; the matching `*.mcp-config-path` names it). Do not just
  copy it back: running Claude Code sessions keep rewriting `~/.claude.json` (other MCP
  servers, project trust and approvals, account state), so an old copy undoes all of that
  and a session still running can overwrite the restore; `mcp-config.json` likewise holds
  your other Copilot MCP servers. To restore the registration:
  1. Quit every session of that host.
  2. Back up the current file.
  3. Restore only the `agent-inbox` entry under `mcpServers`: copy it from the snapshot
     into the current file, or run the host's own `mcp add` with that entry's `command`
     and `args`, for example `claude mcp add --scope user agent-inbox -- <command> <args…>`
     or `copilot mcp add agent-inbox -- <command> <args…>`. Running Setup or the installer
     again also registers it, with the current runtime.
  4. Copy the whole snapshot back only if nothing else in the file has changed since the
     install; `diff` the two files to check.
- An instruction file that could not be restored keeps its timestamped backup beside it,
  for example `~/.claude/CLAUDE.md.bak.<timestamp>.<pid>`. For a symlinked instruction
  file, the backup sits beside the file the link points to.

An installer killed outright (`kill -9`, or Setup's forced stop 10 seconds after a
cancel) stops wherever it was, but that folder then keeps every copy it took, and a
staged `.agent-inbox.<host>.*` file may remain beside an instruction file; it is safe to
delete. A restore step that was already running, such as a host CLI's `mcp remove`, is
not stopped with it: it finishes on its own or is stopped after its 30 seconds, and until
then a new install reports that another setup is already running. A runtime removal cut short leaves
a `.trash-…` folder in `~/.agent-inbox/runtime`, never a half-deleted runtime; the next
install or update deletes it. To finish the job instead, run the same install again.

### Host-specific behavior

If `~/.claude/CLAUDE.md` and `~/.copilot/copilot-instructions.md` are symlinks or
hard links to the same real file, the installer writes one managed block to that shared
file. The shared block inlines the reporting snippet once, then appends the Claude Code
and Copilot CLI host notes in that order, even when `--target` selects only one host,
because both hosts may read the shared instructions.

<details>
<summary><strong>Claude Code</strong></summary>

The installer writes the shared [`reporting-snippet.md`](reporting-snippet.md) plus
[`instructions/claude-code.md`](instructions/claude-code.md) to
`~/.claude/CLAUDE.md`. Claude questions do not return the Copilot `watch` contract.
Automatic idle-session pickup comes from the optional hooks in step 5.

**If you already import the snippet, the installer will not inline it again.** Claude Code
resolves `@path` imports, so a line like

```
@/ABSOLUTE/PATH/TO/agent-inbox/docs/reporting-snippet.md
```

anywhere in `~/.claude/CLAUDE.md` (outside the managed block) already keeps you on the live
file. When the installer sees one, its block carries only the Claude appendix plus a line
saying where the snippet came from — a second, inlined copy would both double the tokens and
freeze a snapshot that goes stale the next time the snippet changes. The dry run says so
explicitly before you apply. Delete the import and the next run puts the snippet back;
`--uninstall` removes the block either way and never touches your import line.

Only a directive Claude Code would really follow, to really this file, counts. It has to be
a line whose first non-blank character is `@` (up to three spaces of indent), outside any
code fence or indented code block — so documenting the import inside your own instructions
does not count as having it. And the path has to resolve to this checkout's snippet:
absolute, `~/…` or relative (relative to the directory of the file holding the line, as
Claude Code resolves it), through symlinks and `..` if you like. A stale path left behind
when the checkout moved, a URL, a different file that merely ends in the same name, or
anything else that fails to resolve all inline instead — a duplicate is only wasteful,
whereas trusting a broken import would leave you with no reporting instructions at all.

</details>

<details>
<summary><strong>GitHub Copilot CLI</strong></summary>

The installer writes the shared [`reporting-snippet.md`](reporting-snippet.md) plus
[`instructions/copilot-cli.md`](instructions/copilot-cli.md) to
`~/.copilot/copilot-instructions.md`. Copilot questions return an exact-item detached
watcher command; its background completion wakes the owning session.

Copilot CLI has no import mechanism, so the snippet is **always** inlined here — an `@path`
line in `copilot-instructions.md` is inert text, not a live reference. Re-run the installer
after the snippet changes to pick the new text up.

</details>

### Manual MCP registration

**Claude Code:**
```sh
claude mcp add --scope user agent-inbox -- node /ABSOLUTE/PATH/TO/agent-inbox/dist/mcp-server.js
```

> **Node 24 required.** `better-sqlite3`'s native binding does not build/load under Node 26+, so the server must be spawned with Node 24. If your default `node` is newer, register the **absolute path to your Node 24 binary** instead of bare `node`, e.g. `$(fnm exec --using=24 -- node -p process.execPath 2>/dev/null || echo ~/.local/share/fnm/node-versions/v24.*/installation/bin/node)`. (There is no `fnm which` — fnm answers `unrecognized subcommand 'which'`, so that form silently falls through to the glob.)

**Copilot CLI:**
```sh
copilot mcp add agent-inbox -- /ABSOLUTE/PATH/TO/NODE24 /ABSOLUTE/PATH/TO/agent-inbox/dist/mcp-server.js
```

Verify: in a repo, run the agent and call the `whoami` tool — it should report that repo's project and branch.

## 3. Run the viewer
```sh
npm run view   # http://127.0.0.1:4319
```
Leave it running (or wrap as a login item / Electron app later).

The viewer listens only on IPv4 loopback; `http://localhost:4319` remains an exact browser
Host/Origin alias without widening the socket, and every mutation requires one of those
trusted Origins. It is intentionally unauthenticated inside the local machine, so use it
on a single-user workstation rather than a shared host. If an older viewer is already
running on port 4319 after an upgrade, stop and restart it before opening the Electron app.

## 4. Add instructions manually (only if you skipped the installer)

Paste `docs/reporting-snippet.md` plus the matching file under `docs/instructions/` into
the host's global instructions. The installer is preferred because it can update its
marked block idempotently without duplicating or overwriting personal instructions.

## 5. Optional: the backstop hooks (issues #10 / #21)

Deterministic, no-AI Claude Code hooks that (a) raise an inbox item when a session sits blocked at a permission prompt and the agent never flagged it, and (b) bounce an idle agent back to work the moment you answer one of its questions. Full contract in [`docs/hooks.md`](hooks.md).

```sh
npm run install:hooks                         # DRY RUN — prints what it would write, changes nothing
npm run install:hooks -- --apply              # write it (timestamped backup of ~/.claude/settings.json first)
npm run install:hooks -- --apply --migrate    # also retire the older hand-written agent-inbox-*.sh Stop hooks
npm run install:hooks -- --apply --replace-existing  # replace any other Agent Inbox install's hooks with this checkout's
npm run install:hooks -- --apply --uninstall  # remove this checkout's hooks again
```

Source-checkout installation requires `jq`. Packaged installation uses the runtime's
bundled Node config helper and works without ambient `node` or `jq`. Both paths share
the same kernel-backed setup lock; packaged hook upgrade/uninstall changes only entries
whose Node and hook entrypoint resolve to the same valid manifest-owned runtime (and,
with `--replace-existing`, another Agent Inbox install's entries and ones that can no
longer run).
Nothing about this runs from `npm install` or `npm run build`. Claude Code reads hooks
when a session starts, and its documentation says it normally applies changes to running
sessions too; restart a session to be sure it has them.

**Only one install's hooks at a time.** Two sets would run every hook twice, so the
installer refuses to add its hooks beside those of a Setup runtime or another
checkout, of a runtime copied or extracted outside Setup's runtime folder, or of an
install that was moved or deleted, and changes nothing. Its message names what is
there and puts the recommended fix first: one command that replaces them all with
this install's hooks. To switch:

- **Setup runtime → this checkout:** `npm run install:hooks -- --apply --replace-existing`.
- **This checkout → the Setup runtime:**
  `bash ~/.agent-inbox/runtime/<runtime-id>/scripts/install-hooks.sh --apply --replace-existing`.
  That needs a 1.3.2 or later runtime (its folder is named
  `agent-inbox-runtime-<version>-…`); an older one exits 2 with `unknown flag`. With
  an older runtime, run `npm run install:hooks -- --apply --uninstall` here first,
  then that runtime's `install-hooks.sh --apply`.

The same command fixes hooks that already run twice. Removing the old install's hooks
with its own `--apply --uninstall` first, and then installing the new ones, works too
when nothing else is in the way; the message prints that command only when it can
succeed. Other tools' hooks are never touched. See
[One set of hooks](hooks.md#one-set-of-hooks-switching-between-a-setup-runtime-and-a-checkout)
in `docs/hooks.md` for the details.

Runtimes of 1.3.2 and older do not recognize hooks of a runtime copied or extracted
outside Setup's folder: their `--replace-existing` keeps that set and adds a second
one. To give such a runtime the hooks, first clear that set, either by hand or by
running `npm run install:hooks -- --apply --replace-existing` and then
`npm run install:hooks -- --apply --uninstall` here. Then run the runtime's
`install-hooks.sh --apply`.

> **Node 24, again.** The installer resolves a Node 24 binary, **proves it** by running `dist/hook-cli.js selftest`, and only then bakes the absolute path into `settings.json`. It refuses to write if that fails. Do not hand-write `"command": "node"` — a hook spawned under Node 26 cannot load `better-sqlite3` and dies silently on every invocation, forever. Override the choice with `AGENT_INBOX_NODE=/abs/path/to/node24`.

To turn the hooks off without uninstalling them, set `AGENT_INBOX_HOOKS=0` in your environment.
