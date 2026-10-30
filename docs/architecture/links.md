---
paths:
  - "public/links.js"
  - "public/source.js"
  - "public/link-open.js"
  - "public/link-strip.js"
  - "public/link-settings.js"
  - "public/structured-text.js"
  - "electron/link-open.cjs"
  - "electron/link-preferences.cjs"
applyTo: "public/links.js,public/source.js,public/link-open.js,public/link-strip.js,public/link-settings.js,public/structured-text.js,electron/link-open.cjs,electron/link-preferences.cjs"
---

# Links in agent text

Link detection, rendering and opening (#300), Settings → Links (#300 part 2) and repo-relative paths (#324).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- Links in agent text (#300) are found only by `public/links.js` (GitHub
  references and local paths; URLs stay in `structured-text.js`, which must
  stay under 350 lines) and drawn only by `public/source.js`. Detection is
  conservative: ordinals, counters, colours, routes such as `/api/items`,
  globs and paths with spaces stay plain. A local file is never an href: it
  carries its path in an escaped `data-link-path`. `public/link-strip.js`
  lists a card's links by collecting what `renderStructuredText` renders, so
  the strip never shows a link from a fence or quarantined markup, and nothing
  about links reaches attention, a badge or a count. Only Electron main opens
  anything: `public/link-open.js` calls the one preload method
  `agentInboxLinks.open`, and `electron/link-open.cjs` re-checks the sender
  (the viewer window's top frame on its origin; a local file also needs the
  binding's `files` grant, so only the viewer this app started and owns opens
  or reveals files, a reused one copies the path and main refuses it as
  `unowned`; `agentInboxLinks.filesAvailable()` reads the grant), the request's exact shape,
  http(s) only, and a file's final target: folders, apps, denied types
  (launchers, installers, disk images, executables, macro documents, …) and
  any execute bit are only revealed. Opening is an allow-list of common
  document types; anything else is revealed, and on macOS so is an alias or a
  file with its own Open With (checked through `/usr/bin/xattr`, argv only,
  failing closed). `setWindowOpenHandler` and `will-navigate` share the same
  http(s) check. A browser copies a file's path instead.
- Settings → Links (#300 part 2, macOS only) lives in main:
  `electron/link-preferences.cjs` keeps per-type rules in userData
  `link-preferences.json` (schema 1, `createLockedFile`, tolerant reader that
  never overwrites a newer schema). The renderer names a rule and a handler,
  never an app path; an app comes only from main's own `dialog.showOpenDialog`
  limited to `.app` bundles, and `launchableApp` re-checks it at every launch
  (real path, `Contents/Info.plist`, never an app that runs what it opens or
  hands it to its default app, such as Finder).
  A rule is read only after folders, bundles, denied types and execute bits
  are revealed, and the alias and Open With checks run before it opens
  anything. An app or Quick Look rule may open a type off the allow-list (a
  code file in an editor); System default never does. Launches use argv only
  (`/usr/bin/open -a <app> -- <target>`, `/usr/bin/qlmanage -p <file>`), no
  shell, stdio ignored. On the window's own open path, a chosen browser that
  fails falls back to the default one. Rules, Quick Look and Reveal are file
  requests, so they share the owned-viewer `files` grant, and so do the
  Settings → Links channels (a reused viewer gets `error: 'unowned'`).
- Repo-relative paths (#324) link only in a card whose item or plan recorded
  `repo_root` (additive, nullable columns on `items` and `boards`): the MCP
  server's `git rev-parse --show-toplevel`, read live by `scope.rootFor()` on
  writes only (never in `get()`, never memoized, fail open to null). A board
  write that finds none keeps the stored folder (`COALESCE`); `board_advance`
  and older servers never touch it. Agent reads never return it
  (`agentItem`/`shapeBoard` in `src/shape.ts`). `public/links.js` detects them
  conservatively (a folder and a name, an extension or a file-like name with
  `:line`, no dotted first folder, no `.`/`..`/`...` segment), reading at most
  255 characters a segment and 1024 in all (longer links nothing), with no
  pattern that can backtrack over agent text: the render runs on every
  3-second poll, so a quadratic regex there freezes the viewer. They carry
  the folder in an escaped `data-link-root`, never an href. Main joins a plain
  relative path to the folder (`joinRepoPath`), refuses it as `outside` when
  its real path leaves the folder's real path, and then applies the same
  policy and grant as any file. A missing one copies its path instead.

## Invariants in detail

- **Links in agent text are found conservatively, drawn by `source.js`, and opened only by
  Electron main (issue #300).** `public/links.js` (pure) finds GitHub references (`#287`,
  `PR #284`, `owner/name#12`, a bare `#N` only against the card's own `repo`) and local paths
  (`/Users/…`, `~/…`, optional `:line`) in the plain runs between the URLs `structured-text.js`
  finds; `renderStructuredText(value, { repo, found })` threads both. A wrong link is worse than
  none, so ordinals (a single-digit `#N` needs `issue`/`PR`/a closing keyword or parentheses),
  counters (`step #12`, `run #1234`), colours, entities, versions, dates, routes such as
  `/api/items` (only known roots like `/Users`, `/home`, `/tmp` start a path), globs, and paths
  that go on across a space stay plain; every check is bounded, so a run scans in linear time.
  `structured-text.js` must stay under 350 lines (a test pins it), so new grammar goes in
  `links.js`. References and URLs become anchors through `anchorHtml`/`chipHtml` like every
  href; a local file is a control carrying its path in an escaped `data-link-path`, NEVER an
  href (inline: a `role="button"` anchor with no href, so it still reads and selects as text;
  in the strip: a `<button>`). `public/link-strip.js` builds the Links strip under each card's
  origin (Inbox inspector, Review queue, Notes, History, Plans row panel: they all share
  `cardOriginHtml`) by COLLECTING what `renderStructuredText` renders for each agent field, so
  it lists exactly the links the card shows, never one from a fence or quarantined markup: own
  PR and issue first, then first appearance, one chip per target (`#284`, `PR #284` and its
  github.com URL share a key), six visible and a `+N more` `<details>` kept open across
  rebuilds by `openContexts`; no strip when the text links nothing beyond the origin chips.
  Nothing about links reaches `public/attention.js`, a badge or a count. `public/link-open.js`
  is ONE capture-phase listener per document (the inspector stops propagation): in Electron
  every detected link (`[data-link-kind]`) goes to the one preload method
  `window.agentInboxLinks.open({kind:'web',url} | {kind:'file',path,reveal})`, a modified click
  on a web link keeps its native path; in a browser a file link copies its path through
  `writeClipboard` and says a browser cannot open local files. `electron/link-open.cjs`
  decides, testable without Electron: the sender is the viewer window's exact `webContents`,
  its top frame, on the viewer origin (the update channel's non-install check plus the top
  frame), which is all a web link needs, so web links work in a reused viewer too. **A local
  file (open, reveal, Quick Look) also needs the window to show the viewer this app started
  and proved it owns**: the window's `createInstallBinding()` holds a third grant, `files`
  (`filesAllowed: () => viewerOwned`, applied as `fileLinkWebContentsId`), revoked by every
  later navigation and re-proved like installs (#216), so a reused or failed-over viewer never
  gets it; main passes `filesPermitted` and `openLinkRequest` refuses a file request without
  it (`unowned`) before the path is even read. `agentInboxLinks.filesAvailable()` reads the
  grant (`agent-inbox:link-files-available` awaits `installBinding.settled()`), asked once per
  page load, again when Settings opens, and again before a file link copies instead of
  opening; where it is false (and in a browser) `fileLinksCopy()` makes file links say "Copy
  path" in their title and a click copies the path with "File links open only in Agent
  Inbox’s own viewer". The UI is only a hint: main's refusal is the boundary, and a refused
  click falls back to copying. The request has exactly its keys; a web link is http(s) by
  `URL` and only its normalized href reaches `shell.openExternal`; a file path is absolute
  after `~/`, normalized, control-free, and judged by its FINAL target after `realpath`:
  missing is reported, a folder or `.app` is only revealed, a denied extension on the link or
  its target (apps, launchers, location and VPN files, installers, disk images, executables,
  compiled and Windows scripts, documents that can carry macros, certificates) or any execute
  bit is only revealed. **Opening is an ALLOW-list** (`OPENABLE_EXTENSIONS`: Markdown, text,
  logs, JSON/YAML/TOML, CSV/TSV, PDF, images, SVG, HTML, diffs, MOV/MP4): any other type
  is revealed with reason `type`, because a deny-list of what runs code never ends; code files
  (`py`, `sh`, …) are neither allowed nor denied, and XML stays off the list (on Windows,
  Office's handler sends a `.xml` naming Word to Word, and Word 2003 XML can carry macros). On macOS, before anything opens, the resolved
  file is checked for an alias, which `realpath` does not follow and Launch Services opens the
  target of (bookmark magic `book\0\0\0\0mark` in its first bytes, the Finder alias flag in
  `com.apple.FinderInfo`, a non-empty `..namedfork/rsrc`), and for a per-file
  `com.apple.LaunchServices.OpenWith`; xattrs are read with `/usr/bin/xattr` through
  `execFile`, argv only, and a check that cannot finish reveals (`blocked`, fail closed). Only
  then does `shell.openPath` get the resolved path. The check is point-in-time.
  `setWindowOpenHandler` and `will-navigate` share `openWebLink`, so no path in main hands a
  non-http(s) URL to the OS.
- **Settings → Links (#300 part 2) is macOS-only, main-owned, and never outranks the safety
  policy.** `electron/link-preferences.cjs` keeps the rules in userData `link-preferences.json`:
  schema 1, written by `createLockedFile` (exported from `update-preferences.cjs`: temp file and
  rename under the same cross-process lock), read tolerantly (corrupt → defaults, a bad rule
  dropped, a newer schema read as defaults and never overwritten, unknown top-level fields kept).
  Rules: Web links (Default browser or an app), Markdown (`.md`, `.markdown`) and up to 20 added
  types (Quick Look, Reveal, or an app, plus System default only for a type on the allow-list:
  the view's `systemDefault` says which, an added type off the list starts as Reveal, and a stored
  System default off the list reads as Reveal); a denied type can never get one. The
  renderer's `agentInboxLinkSettings` bridge (get, setHandler, chooseApp, addType, removeType,
  exact arity, same sender check as opening and the same owned-viewer `files` grant: any other
  page gets `{ available: false, rules: [], error: 'unowned' }`, after any re-proof in flight,
  and the section says where it works; Settings asks again each time it opens,
  `refreshLinkSettings()`) names a rule id and a handler, NEVER an app path:
  `app` comes only from `chooseApp`, which asks main's own `dialog.showOpenDialog` (`openFile`,
  `.app` filter), and the view the renderer gets names the app, never its path. ONE check,
  `launchableApp` in `link-open.cjs`, judges an app when the picker returns it AND at every launch
  (the file can be edited by hand, the bundle can move): its `realpath` must still end in `.app`,
  be a directory and hold a `Contents/Info.plist` file, and neither the name it was chosen under
  nor the one it resolves to may be an app that runs what it opens (Terminal, iTerm, Script Editor,
  Python Launcher, JavaLauncher…) or hands it to its default app (Finder, System Events, which
  would make a rule System default for a type off the allow-list); the real path is what is
  saved and launched, and the reader also drops a rule
  naming a runner. `fileOpenPlan(value, { rules })` reads a rule only AFTER a folder, a bundle, a
  denied type and an execute bit have been revealed; a Reveal rule reveals (`rule`); an app or
  Quick Look rule may open a type the allow-list leaves out (the escape hatch for code files,
  such as `.py` in an editor), while System default never does; and the alias and Open With
  checks run before any rule or default opens a file, so a rule never applies to an alias, an
  Open With file, an executable, a bundle or a denied type. A reveal request (a file chip's
  Reveal action, `{kind:'file',path,reveal:true}`) reveals whatever the rule. Launches use argv
  only (`/usr/bin/open -a <app> -- <target>`, `/usr/bin/qlmanage -p <file>`), `shell: false`,
  stdio ignored, detached; an app that fails the check is `app-missing` (gone or not an app) or
  `app-refused` (a runner), reported to the renderer. The web rule also governs the window-open and
  navigate paths (`openWebLink(url, shell, { readRules })`, where an unreadable file means the
  system defaults); nothing there can say why, so a chosen browser that is gone, refused or fails
  to start falls back to `shell.openExternal` on the already-checked href. Off macOS nothing is
  offered and links keep the system defaults. In the viewer this app owns (`linkFileActions()`
  needs main's `filesAvailable()` yes), a strip's file chip also gets Reveal and Copy path
  buttons (`data-link-action`), never in a browser or a reused viewer. Opening, a rule's app or
  Quick Look, a Reveal rule and a Reveal request are all file requests, so `openLinkRequest`
  refuses each of them as `unowned` without the grant, before any rule is read.
- **Repo-relative paths (#324, #300 part 3) open against the folder the item or plan recorded,
  and never outside it.** `items.repo_root` and `boards.repo_root` are additive, nullable
  columns: the MCP server's `git rev-parse --show-toplevel` (`inferRepoRoot` in `src/infer.ts`,
  through the stdout-capturing `git()` helper, null on any failure or anything but one plain
  absolute path). `scope.rootFor()` reads it LIVE and only on writes, like `headFor`: never in
  `get()` (every call, `pending()` polls included, would pay a spawn), never memoized (worktrees
  and checkouts move), no `register` override, and not in the scope `whoami` returns. `flag`
  stamps it at insert; `board_upsert`/`board_row` pass it to `ensureBoard`, whose
  `repo_root = COALESCE(?, repo_root)` keeps the stored folder through a write that found none,
  and whose change counts like `head_repo`'s (`updated_at`, board revision; `rootChanged`).
  `board_advance` restamps no plan field, and no older server's statement names the column
  (`test/mixed-version.test.ts` runs v1.6.0's item insert, plan writes and `board_advance`).
  Agent reads never carry it: `agentItem` (`src/shape.ts`) strips it from `pending()` items,
  `shapeBoard` from a titled `board_get`, and the summary and `listPendingRows` never select it;
  `/api/items` and `/api/boards` simply carry it. **Detection** (`relativeAt` in
  `public/links.js`) runs only with a usable `ctx.root` (an absolute folder: `textContext()` and
  `cardLinks` pass the item's or the row's plan's `repo_root`), so a card without one renders
  exactly as before. It starts at a token's first `/` and reads back over one segment: an
  opener before it (as for absolute paths), at least a folder and a name, a first folder with
  no inner dot (`.github` yes; domains, versions, `Node.js` no), no segment of dots alone (`.`,
  `..`, an elided `...`; a leading `./` is dropped), and either an extension (all lowercase or
  all uppercase, ≤ 10 characters, so `write.Then` stays prose) or a `:line` on a name that still
  looks like a file's (a dotfile, or a capital, `-` or `_`: never `origin/main:238`). A token
  after a space whose previous token ended in a bare folder name (`/Users/s/My Documents/a.md`)
  is a continuation and never links; `owner/name#N`, URLs, globs, routes and absolute paths keep
  their own detectors. **Both reads are bounded, and no pattern can backtrack:** back over at
  most one 255-character segment, forward over at most 255 characters a segment and 1024
  (`MAX_RELATIVE`) in all, and a path past either cap links nothing, never a shortened prefix.
  No pattern there nests quantifiers or puts two unbounded ones side by side: the `:line` name
  check is plain code (`fileLikeName`), because as one regex it backtracked quadratically on a
  long name (9 s at 80k characters) and froze every render of a card that showed one (review
  of #330), and `fileLabel`, `webLabel` and `repoFilePath` strip trailing slashes with a loop,
  never an unanchored `/\/+$/`, for the same reason. `test/links.test.ts` times each shape.
  The link carries the path (`./` dropped, no `:line`) in `data-link-path` and the folder in an
  escaped `data-link-root`, never an href; its title and the strip's key use the full path
  (`repoFilePath` in `source.js`), so it shares one chip with the same file written absolute.
  `link-open.js` sends `{kind:'file', path, root, reveal}`; the preload passes `root` only as a
  string; main accepts exactly that key set and `fileOpenPlan(path, { root })` joins only a plain
  relative path (`joinRepoPath`: no `.`/`..`/empty segment, `~`, `:` or backslash) to a plain
  absolute folder, then resolves both with `realpath` and refuses a file whose real path is not
  inside the folder's (`outside`, said as "points outside its repository") before `lstat`, the
  xattr checks or any rule; everything after that is today's policy, ownership grant included.
  A `missing` answer for a relative request copies the path as written and says it may be on
  another branch or worktree; Copy path, a browser and a reused viewer copy the full path.
  Nothing about it reaches attention, a badge or a count.
