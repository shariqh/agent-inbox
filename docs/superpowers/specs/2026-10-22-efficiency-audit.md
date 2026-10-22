# Efficiency audit: app size, memory and CPU (#281)

Status: decided 2026-10-22. No app code changes here; each reduction below gets
its own issue and PR. Measured 2026-10-22 against the published v1.5.0 release
(Electron 43.8.0, Node v24.18.1 runtimes) and the v1.5.0 app installed on an
Apple Silicon Mac.

**Decision (2026-10-22).** Shariq accepted the recommended plan with one change:
there will be no Intel Mac release going forward. So V1 becomes an Apple
Silicon-only build (#296), and it must wait for the #295 hand-off. Installed
1.3–1.5 apps accept only the five-target manifest with a `darwin/universal` DMG.
An arm64-only DMG published under that name would install an app that cannot
launch on Intel, and a new target set would make those apps reject the whole
manifest. #295 therefore ships in the last universal 1.x release.

## Why is it ~900 MB?

The installed macOS app is **925,208 KiB (903 MiB)**. It is a universal app, so
it carries a full copy of nearly everything for both Apple Silicon and Intel:

| What | Size | Note |
| --- | ---: | --- |
| Electron Framework binary (fat) | 401 MB | x86_64 slice 214.1 MB + arm64 slice 196.4 MB |
| Embedded Node runtimes (Setup payloads) | 345 MB | `darwin-arm64` 171 MB + `darwin-x64` 173 MB |
| Rest of Electron (locales, ICU, paks, GPU libs, helpers) | 113 MB | 48 MB of that is 220 `.lproj` locale folders |
| App `node_modules` | 41 MB | 14 MB is better-sqlite3, 10 MB of it C source |
| Chromium license file | 19.5 MB | `LICENSES.chromium.html` |
| App code (`dist`, `public`, `electron`, docs) | 2.3 MB | |

About **746 MB (81%)** is two items: Electron's fat binary and two Node runtimes.
A machine only ever runs one architecture. An arm64-only copy of the same app,
with the x86_64 slices removed (`lipo -thin`) and the x64 runtime deleted, measured
**523 MB**. With the low-risk trims in this document applied too, it measured
**422 MB**, compressing to a 209 MB UDZO DMG or a 145 MB ULMO DMG (the v1.5.0
DMG is 339 MB).

Two things add to that on disk outside the app:

- Each Setup runtime install under `~/.agent-inbox/runtime/<id>` is about 171 MB.
  This Mac still holds two old ones (1.2.2 and 1.2.4), **341 MB**. The installer
  prunes only during an install, and only runtimes nothing references.
- The hub database is small: `inbox.db` 5.6 MB plus a 4.2 MB WAL. Electron's
  userData folder is 11.9 MB, mostly Chromium caches.

## 1. Release artifacts (v1.5.0)

All five checksums match `SHA256SUMS.txt`.

| Artifact | Download | Installed / uncompressed |
| --- | ---: | ---: |
| `Agent-Inbox-v1.5.0-universal.dmg` (UDZO) | 338.7 MB | 1,466 MB image; app 925,208 KiB |
| `Agent-Inbox-v1.5.0-linux-x86_64.AppImage` (zstd squashfs) | 168.7 MB | ≈ the DEB payload (same thin app) |
| `Agent-Inbox-v1.5.0-linux-arm64.AppImage` | 167.5 MB | ≈ the DEB payload |
| `agent-inbox_1.5.0_amd64.deb` (xz) | 127.9 MB | 554.5 MB |
| `agent-inbox_1.5.0_arm64.deb` | 121.1 MB | 555.0 MB |

Linux packages are single-architecture, which is why they are about 40% smaller
than the macOS app installed. The AppImages were not unpacked because neither
`unsquashfs` nor `7z` was available. `build-linux-appimage.mjs` builds them from
the same verified thin app as the DEB.

### macOS app breakdown (`du -sk`, KiB)

| Path under `Agent Inbox.app/Contents` | KiB |
| --- | ---: |
| `Frameworks/Electron Framework.framework` | 509,776 |
| ↳ `Versions/A/Electron Framework` (fat Mach-O) | 400,948 |
| ↳ `Versions/A/Resources` (220 `.lproj` = 48,288; `icudtl.dat` 10,624; `resources.pak` 7,064; two V8 snapshots) | 67,748 |
| ↳ `Versions/A/Libraries` (swiftshader 21.2 MB, GLESv2 13.1 MB, ffmpeg 4.8 MB, EGL) | 38,492 |
| ↳ `Versions/A/Helpers` | 2,484 |
| Other frameworks (Squirrel, Mantle, ReactiveObjC) and the four helper apps | 3,592 |
| `Resources/app/runtime/darwin-arm64` | 171,228 |
| ↳ `bin/node` (arm64) | 118,124 |
| ↳ `node_modules` (better-sqlite3 24,760) | 51,408 |
| `Resources/app/runtime/darwin-x64` | 173,372 |
| ↳ `bin/node` (x86_64) | 120,428 |
| ↳ `node_modules` (better-sqlite3 24,600) | 51,248 |
| `Resources/app/node_modules` (better-sqlite3 14,140, zod 6,404, MCP SDK 6,248, hono 2,880, ajv 2,364; 126 packages) | 40,788 |
| `Resources/LICENSES.chromium.html` | 19,492 |
| `Resources/app/{public,electron,dist,docs,release}` | 2,268 |
| `_CodeSignature` | 3,976 |

The installed `/Applications/Agent Inbox.app` (v1.5.0) measured 925,152 KiB with
the same split.

#### Waste inside the payloads

- **better-sqlite3 build leftovers in every runtime.** The runtime is installed
  with lifecycle scripts so the addon is compiled from source, and everything the
  compile left behind ships too: `build/Release/obj/gen/sqlite3/sqlite3.c`
  (9.5 MB), `sqlite3.h` (0.7 MB), `sqlite3.a` (2.4 MB) and the object files. Only
  `build/Release/better_sqlite3.node` (1.95 MB) is loaded.
- **SQLite C source in all three copies.** `better-sqlite3/deps/sqlite3` (10 MB)
  is in the app and in both runtimes. Nothing reads it at runtime.
- **Typings, markdown and source maps.** `*.d.ts` 5.6 MB, `*.map` 3.3 MB and 196
  markdown files, about 10.4 MB per `node_modules` copy, three copies.
- **Locales.** The UI is English-only, but Chromium's 220 `.lproj` folders
  (48 MB) ship. Linux ships the same 48 MB as `locales/*.pak`.
- **Possibly unused dependencies per copy.** The app's `node_modules` serves the
  in-process viewer, which does not import the MCP SDK, zod or ajv. The runtime
  serves the MCP server and hook/watch CLIs, which may not need `hono`. Both copies
  install the full production graph. Not yet proven: the import graphs need to be
  checked.

### Measured effect of the trims (arm64 copy, scratch only)

These numbers come from a scratch copy of the app: unsigned, never run, and used
only for sizing.

| Step (cumulative) | KiB | Saved |
| --- | ---: | ---: |
| v1.5.0 universal app | 925,208 | |
| arm64 only: `lipo -thin arm64` on 16 fat Mach-O files, x64 runtime and x86_64 V8 snapshot removed | 523,040 | 402,168 |
| plus better-sqlite3 pruned to `lib/`, `package.json`, `LICENSE` and the `.node` file (app + runtime) | 490,080 | 32,960 |
| plus `*.d.ts`/`*.map`/non-license `*.md` removed from `node_modules` (app + runtime) | 469,348 | 20,732 |
| plus every Electron `.lproj` except `en` removed | 421,612 | 47,736 |

Compressing that last copy: UDZO 209.2 MB, ULMO 144.7 MB.

Converting the unchanged v1.5.0 DMG: ULMO **254.4 MB (−25%)**, 82 s to build;
ULFO 332.7 MB (−2%). The minimum macOS is 13.5, and ULMO needs only 10.15.

### DEB breakdown (amd64, uncompressed bytes)

| Category | Bytes |
| --- | ---: |
| Electron main binary `usr/lib/agent-inbox/Agent Inbox` | 225,451,256 |
| Runtime `bin/node` (linux-x64) | 123,656,816 |
| Electron locales (`locales/*.pak`) | 48,122,115 |
| Rest of Electron (ICU, paks, GL/Vulkan/ffmpeg libs) | 38,309,393 |
| better-sqlite3 `deps/` source, all copies | 20,498,320 |
| `usr/share/doc/agent-inbox` (a second copy of `LICENSES.chromium.html`) | 19,958,188 |
| `LICENSES.chromium.html` next to the binary | 19,956,022 |
| Runtime `node_modules` without better-sqlite3 | 16,561,211 |
| App `node_modules` without better-sqlite3 | 16,561,211 |
| Runtime better-sqlite3 `build/Release/obj` | 14,925,461 |
| Runtime better-sqlite3 other build output | 4,760,963 |
| App better-sqlite3 `.node` | 2,100,952 |
| App code | 1,973,804 |
| Runtime other (`dist`, `scripts`, manifest) | 1,648,858 |

## 2. Running app: memory and CPU

Command: `ps -axo pid=,ppid=,rss=,vsz=,%cpu=,cputime=,etime=,command=` every 10 s
for 304 s (31 samples). CPU is the `cputime` delta over the window, as a percentage
of one core. The window was visible, the hub idle, and agent sessions were open.

| Process | RSS min / max / last (MB) | Avg CPU | CPU time in 304 s |
| --- | ---: | ---: | ---: |
| Electron main (with the in-process viewer, dock watcher and pollers) | 199 / 388 / 376 | 1.88% | 5.73 s |
| Renderer | 191 / 210 / 198 | 1.29% | 3.92 s |
| GPU | 72 / 83 / 76 | 1.49% | 4.52 s |
| Network service | 44 / 46 / 44 | 0.19% | 0.59 s |
| **App total** | **≈ 570 → 694** | **≈ 4.9%** | 14.76 s |
| MCP server, per agent session (`node …/dist/mcp-server.js`; 5 running) | 46–55 each, ≈ 215 total | ≈ 0% | ≤ 0.01 s each |
| Claude hook `watch` (`hook-cli.js watch`) | 62–65 | 0.03% | |
| Copilot answer watcher (`watch-cli`), seen briefly | 79 | 0% | |

- **Growth.** The renderer and GPU stayed flat. Main moved between 199 and
  224 MB for the first 100 s, then stepped up to about 375 MB at sample 11 and
  stayed between 369 and 388 MB. The step came when the poll measurement below
  first requested `/api/boards/archived` and `/api/items/history` without a
  validator, so the viewer built and cached those snapshots: about 4 MB of JSON
  strings plus the V8 heap that held them. Nothing grew afterwards, so this is
  heap high-water, not a leak. A longer run (hours) should confirm that.
- **Main uses the most CPU of any process.** Part of the reason is the dock
  watcher (§3).
- **RSS adds up shared pages more than once.** The app total is an upper bound.
- **The MCP servers ran from a checkout**, since this machine registers its
  checkout. A Setup runtime runs the same code on the same Node major.
- Not ours, and only noted: two `/bin/sh …/agent-installer-*/fakebin/{copilot,claude} mcp add`
  processes from an installer test run were still alive after 2 days 17 h
  (1.7 MB each). This could be a test-harness leak, and deserves its own issue.

## 3. Poll cost

### The renderer's 3-second poll

Endpoints come from `load()` in `public/app.js`. Requests were read-only GETs to
`http://127.0.0.1:4319` with `Host: 127.0.0.1:4319`. Bodies were discarded
unread; only sizes, statuses and timings were kept. The median of 5 requests is
shown for each.

| Endpoint | Body | Unconditional | ETag | With `If-None-Match` |
| --- | ---: | ---: | :---: | --- |
| `/api/items` | 451,709 B | 5.2 ms | yes | 304, 2.2 ms |
| `/api/boards` | 866,441 B | 5.3 ms | yes | 304, 2.4 ms |
| `/api/boards/archived` | 2,239,145 B | 9.0 ms | yes | 304, 2.2 ms |
| `/api/activity` | 2,760 B | 2.2 ms | no | always 200 |
| `/api/activity/history?since_ms=…` | 91,700 B | 3.4 ms | yes | 304, 3.0 ms |
| `/api/projects/closed` | 185 B | 2.0 ms | no | always 200 |
| `/api/links` | 18,212 B | 2.1 ms | no | always 200 |
| `/api/issues` | 6,899 B | 2.2 ms | yes | 304, 2.1 ms |
| `/api/items/history` (only while a surface needs it) | 1,707,145 B | 9.4 ms | yes | 304, 2.3 ms |

A simulated poll ran 20 ticks of the 8 standing reads, concurrent and conditional,
every 3 s: **160 requests, 100 × 304, 60 × 200, 21,157 B of body per tick**
(about 7 KB/s, 25 MB/hour, all from the three unconditional endpoints). The median
tick took 5.8 ms (12.9 ms max). The hub did not change during the run.

The renderer still repaints every tick. `load()` always calls `renderIfIdle()`,
which runs `paintAmbient()` and then a full `render()`. Nothing checks whether
the tick changed anything, and the DOM is rebuilt every 3 s even when all eight
reads were 304s. That repaint is the renderer's 1.3% CPU and most of the GPU's
1.5%.

### The dock watcher in Electron main (also every 3 s)

`startAttentionWatch()` in `electron/main.cjs` reads, unconditionally and one
after another:

| Read | Body |
| --- | ---: |
| `/api/items?scope=attention` | 5,456 B |
| `/api/boards` | **866,441 B** |
| `/api/activity` | 2,760 B |
| `/api/projects/closed` | 185 B |

That is **≈ 875 KB of JSON serialized, sent over loopback and `JSON.parse`d in
the main process every 3 s** (≈ 290 KB/s, ≈ 1 GB/hour). The renderer gets 304s,
but this watcher sends no validator, so the viewer returns the full 866 KB boards
body every time. The watcher needs only blocked rows. #156 already gave items a
lean `scope=attention` projection; boards never got one.

### Rebuild after an unrelated write (synthetic hub)

`conditionalSnapshot()` keys its cache on `data_version`, `total_changes()` and
the schema version. Any committed write therefore invalidates every snapshot,
including `recordActivityCall`, which every MCP tool call makes. The next read
then re-serializes and re-hashes each body, and only after that can it answer
304.

To size this, a scratch hub was built with `openDb` + `createViewer` in a scratch
directory. It held 1,500 items and 160 boards of 25 rows with 600–900-character
contexts: `/api/items` 2.2 MB, `/api/boards` 1.7 MB, `/api/boards/archived`
5.2 MB.

| After one `recordActivityCall` | items | boards | archived | items/history | issues | Total (all 304) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 runs | 20–130 ms | 13–33 ms | 30–89 ms | 15–26 ms | 7–12 ms | **89–257 ms** |

All of it runs on Electron main's thread in the packaged app. On this machine's
hub, which is about half that size, the same rebuild costs roughly 25–40 ms per
write. A busy fan-out makes MCP calls every few seconds, so most ticks pay it.

## 4. Invariants the proposals must respect (from CLAUDE.md)

- **Conditional snapshots must remain authoritative.** The store tokens decide
  invalidation, and nothing may cache an uncommitted body or label old bytes with
  a newer token. Any finer-grained invalidation must keep that proof and observe
  writes made by older processes sharing the file. That is why triggers, rather
  than application code, would have to maintain any per-domain counter (the same
  precedent as `increment_item_response_revision`).
- **Only `renderIfIdle` and `forceRender` enter `render()`.** The poll gate, the
  press guard, the scroll guards, selection restore and `renderDirty`/`#pauseHint`
  must stay as they are. Skipping a frame must not hide ambient signals, and
  time-derived state still has to repaint: ages, snooze expiry, follow-up-due
  chips, claim decay from `/api/activity`.
- **The dock badge comes from the same `attentionEntries` call** as the viewer.
  A lean projection must yield an identical attention set and `known` set
  (`test/reply-watch.test.ts`, `test/badge.test.ts`).
- **No asar.** The server serves `./public` from the real filesystem.
- **Setup's verified runtime payloads.** The manifest is content-derived, so
  trims must happen before the manifest is computed. The signing order is fixed:
  nested runtime Mach-O files, manifests, setup-info, the outer app without
  `--deep`, then strict verification. `runtime-sqlite-check`,
  `electron-sqlite-check`, `probeRuntimeMcp` and the selftest must keep passing
  on the trimmed payload.
- **The update manifest validator requires exactly five targets** (`TARGET_SPECS`
  in `electron/update-manifest.cjs`). Installed 1.3–1.5 clients reject a manifest
  with any other target set. Release aggregation also expects five packages.

## 5. Prioritized proposals

Savings figures are measured where marked (m) and estimated otherwise (e).

### Quick wins (v1.5.x / v1.6; each a small PR)

| # | Change | Savings | Risk | Effort | Touches | Must verify |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 (#287) | Dock watcher: send `If-None-Match` on each read and skip recomputing when all four are unchanged; better, add a lean `/api/boards?scope=attention` projection (only active boards with blocked rows) with its own validator, as #156 did for items | ≈ 875 KB → ≈ 8 KB JSON per 3 s in main (m); main CPU ≈ 1.9% → < 0.5% (e) | Low | S | `electron/main.cjs`, `src/viewer.ts` | Identical badge and `known` set with and without the projection; boot marker; older reused viewer fallback |
| Q2 (#291) | Prune better-sqlite3 to `lib/`, `package.json`, `LICENSE` and `build/Release/better_sqlite3.node` in the app and each runtime, before the manifest is computed | ≈ 23 MB per runtime + 10 MB app: ≈ 56 MB universal, 33 MB thin (m), ≈ 38 MB per DEB (m) | Low | S | `scripts/stage-runtime.mjs`, `package-app-stage`, Linux thin app | Sqlite checks, MCP probe, manifest file list, the signing list (`sqlite3.a`/`test_extension` drop out) |
| Q3 (#291) | Remove `*.d.ts`, `*.map` and non-license markdown from shipped `node_modules`; keep every `LICENSE*`/`NOTICE*` | ≈ 10 MB per copy: 31 MB universal (e), 21 MB thin (m) | Low | S | Staging scripts | License inventory unchanged; no runtime `require` of a removed file |
| Q4 (#292) | Ship only the `en` locale (macOS `.lproj`, Linux `locales/en-US.pak`) | 48 MB installed per platform (m) | Low–med | S | Packager `afterCopy`/staging, before signing | Native menus, dialogs and notifications still render; `app.getLocale()` is unused for UI |
| Q5 (#289) | Build the DMG as ULMO instead of UDZO | 339 → 254 MB download, −25% (m) | Low | XS | `assemble-macos-release.mjs` `createDMG({format})` | `appdmg` accepts ULMO; the in-app installer's `hdiutil attach` works on ULMO (macOS ≥ 10.15; minimum is 13.5); notarization of the DMG; ~80 s longer build |
| Q6 (#293) | DEB: keep one `LICENSES.chromium.html` (symlink or a gzipped copy in `/usr/share/doc`) | ≈ 20 MB installed per DEB (m) | Low | XS | `build-linux-deb.mjs`, DEB contract and verify | lintian/policy, the DEB contract tests |
| Q7 (#288) | Make `/api/links` conditional and return 304 from it like the snapshots | 18 KB of the 21 KB steady per-tick body (m) | Low | S | `src/viewer.ts`, `public/snapshots.js` | `/api/links` fallback rules; the PR poller still invalidates it |
| Q8 (#294) | Offer to remove unreferenced Setup runtimes (or prune after a successful Setup update) | 341 MB on this Mac (m); ≈ 171 MB per stale version (e) | Low–med | S | Setup UI, `runtime-payload.mjs prune` (already reference-gated) | Never prune a referenced runtime; trash semantics (#211/#214) |

Q2–Q4 together, on the universal app: ≈ 135 MB (e), 925 → ≈ 790 MB.

### v2.0-sized work

| # | Change | Savings | Risk | Effort | Touches | Must verify |
| --- | --- | --- | --- | --- | --- | --- |
| V1 (#295 + #296) | **Apple Silicon-only macOS build**: an arm64 app and DMG with only the arm64 runtime, and no Intel release, so there is no second build to sign. Ships after #295's manifest v2 and Apple Silicon install checks | Installed 925 → 523 MB (m); ≈ 422 MB with Q2–Q4 (m); DMG 339 → 209 MB UDZO / ≈ 145 MB ULMO (m) | Med–high | L | `macos-universal.yml` and assembly, signing and notarization, release aggregation, update manifest, installer feasibility (refuse to install on Intel), website links | Shipped 1.3–1.5 updaters accept only the five-target schema with `darwin/universal`. #295 must ship in the last universal 1.x release, so the v2 manifest is in place before the arm64-only build |
| V2 (#297) | **Per-domain snapshot invalidation**: trigger-maintained generation counters (items, boards/rows, issues, projects) so activity writes stop rebuilding items/boards/archived | 89–257 ms of main-thread work per MCP call on a 10 MB hub (m); ≈ 25–40 ms here (e) | Med | M | `src/store.ts` (schema + triggers), `src/viewer.ts` | The "conditional snapshots must remain authoritative" proof; mixed-version writers (`test/mixed-version.test.ts`); 304 correctness under concurrent commits |
| V3 (#298) | **Renderer: skip an unchanged frame.** If every read reused its representation and the ambient bytes are equal, don't rebuild; repaint on a clock tick (30–60 s) for time-derived labels; while `document.hidden`, defer the editable rebuild until the window is visible again | Renderer ≈ 1.3% and GPU ≈ 1.5% CPU → near idle (e) | Med | M | `public/app.js` `load()`/`renderIfIdle` | Two render entries, `renderDirty`/`#pauseHint`, focus/selection restore, deep links, ages and snooze expiry still update; DOM tests |
| V4 (#299) | **Load archived plans lazily**, like closed history (#184): the default poll carries counts only, and the full list loads when the Archived view, search or a deep link needs it | 2.2 MB per changed tick and its parse/deep-freeze (m); the steady 304 read goes away | Med | M | `src/viewer.ts`, `public/app.js`, search index | Search over archived plans, deep links, Plans grouping, `historyWanted`-style rules |
| V5 (not scheduled) | **Stop embedding both Node runtimes**: download the host's runtime at Setup, verified against a digest in the signed update manifest | 171–345 MB of the app (e); V1 already removes the cross-arch half | High | L | Setup trust chain (today anchored on the signed bundle's `setup-info.json`), offline install, Intel release gate | A new trust anchor and failure modes; Setup working offline |
| V6 (not scheduled) | **Ship only the dependencies each graph imports**: the viewer doesn't import the MCP SDK/zod/ajv, and the runtime may not need `hono` | ≈ 15–20 MB per copy (e) | Med | M | Staging scripts, `copyRequiredTree` lockfile verification (#139) | Import graphs from `dist/` entries; `package-app-stage verify` stays exact |
| V7 (not scheduled) | **Smaller resident helpers**: the MCP server is 46–55 MB per session and hook/Copilot watchers 63–79 MB; trim import graphs (watch-cli needs only `getItem`) and consider lazy imports | ≈ 20–30 MB per watcher (e) | Low–med | S–M | `src/watch-cli.ts`, `src/hook-cli.ts`, `src/mcp-server.ts` | MCP stdout rules; the dead-export test |

### Not recommended

- **Removing SwiftShader/GL/ffmpeg** (≈ 39 MB on macOS): Chromium falls back to
  them when GPU acceleration fails.
- **An asar archive:** the server serves `public/` and chdirs into the app folder
  (`package-app.sh`).
- **Stripping the Node binary:** little gain, and it complicates Setup's
  verified, signed runtime payload.

## 6. Dashboard 2.0 (#280) performance budget

The redesign should start from these numbers rather than re-measure:

- **Idle cost.** Today an idle window spends about 1.3% of a core in the renderer
  and 1.5% in the GPU rebuilding unchanged DOM every 3 s. Budget: an unchanged
  tick does no DOM work (V3), and the clock-only repaint stays under one per
  30 s.
- **Payload.** The steady per-tick body is 21 KB today and could drop below 3 KB
  with Q7. A changed tick moves up to 3.5 MB on this hub because
  `/api/boards/archived` is 2.2 MB. Budget: the default poll carries no archived
  or closed bodies (V4 plus #184's paging).
- **Main thread.** Snapshot rebuilds run on Electron main (V2). Dashboard work
  should not add another full-hub serialization per tick.

## 7. Method and reproduction

Run from a worktree (`research-efficiency`). Scratch files lived in a git-excluded
folder inside it and were deleted afterwards.

```sh
gh release download v1.5.0 -R shariqh/agent-inbox --dir <scratch>/dl
shasum -a 256 <scratch>/dl/*.{dmg,deb,AppImage}       # compared with SHA256SUMS.txt
hdiutil attach -nobrowse -readonly -mountpoint <scratch>/mnt <dmg>
du -sk "<scratch>/mnt/Agent Inbox.app"/Contents/* …     # tables above
lipo -detailed_info ".../Electron Framework"            # per-arch slice sizes
hdiutil detach <scratch>/mnt
hdiutil convert <dmg> -format ULMO -o <scratch>/conv.dmg   # ULFO likewise
ar x <deb> && bsdtar -tvf data.tar.xz                   # per-file sizes, categorized
du -sk "/Applications/Agent Inbox.app" ~/.agent-inbox/runtime/*   # sizes only
ps -axo pid=,ppid=,rss=,vsz=,%cpu=,cputime=,etime=,command=       # every 10 s × 31
```

- **Thin-copy sizing.** `ditto` the mounted app into scratch, delete
  `runtime/darwin-x64`, run `lipo -thin arm64` on every fat Mach-O (16 files),
  remove `v8_context_snapshot.x86_64.bin`, then apply each trim and run `du -sk`
  after each step. `hdiutil create -srcfolder … -format UDZO|ULMO` gives the
  compressed sizes.
- **Poll measurement.** A Node 24 script issued each GET five times without and
  five times with the returned ETag, then ran 20 concurrent conditional ticks
  3 s apart. It recorded status, byte length and time only.
- **Synthetic rebuild.** A `tsx` script seeded a scratch `AGENT_INBOX_DB` (with
  a scratch `HOME` and `GH_CONFIG_DIR`) through `store.ts` and called
  `createViewer(db).request(...)` directly. It timed every snapshot read after
  each `recordActivityCall`.
