# Contributing

## Development setup

Agent Inbox uses Node 24 and npm:

```sh
git clone https://github.com/shariqh/agent-inbox.git
cd agent-inbox
npm ci
npm test
```

## Marketing preview

```sh
npm run marketing
```

Open `http://127.0.0.1:4320` to review the marketing site. Use
`npm run marketing -- --port 4321` to choose another local port.
`marketing/index.html` is a single file and can also be opened directly, but
browsers refuse to load its hero's Three.js modules from a `file:` URL, so the
hero then shows its plain background. Review the hero through the preview server.
The interactive demo uses fictional data held only in the page; the preview
server does not open the inbox database or expose the viewer API.
The marketing page defaults to light appearance and owns its styles independently
of `public/`. Use `?scoutTheme=dark` or the footer appearance button to review its
dark counterpart.
The inline brand symbol mirrors `assets/icon.svg`; keep it synchronized with the
source artwork.

### Hosting the marketing page

Publish `marketing/index.html` as a standalone static page, together with the
files `marketing/vendor/manifest.json` lists, at the same paths relative to the
page. The page embeds its styles, scripts, icons, and demo data; hosting it
requires no build command, dependencies, environment variables, or backend. It
can live at a site's root, on a subdomain, or under a path without changing its
in-page links. Serve it at a URL that ends in `/` or `/index.html`, or redirect
to one, so that relative URLs resolve next to the page.

The hero's animated visual uses Three.js r186 from the page's own `vendor/`
folder: `three.module.js` and the `three.core.js` it imports, unchanged from the
npm package `three@0.186.0`, with the package's MIT `LICENSE`. The hero imports
them by relative URL, so the page makes no third-party requests. If they are
missing or blocked, or WebGL is unavailable, the hero falls back to its plain
background and the rest of the page works as usual.

`manifest.json` records each vendored file's SHA-256 and, for each folder, the
npm tarball it came from and that tarball's `integrity`. `test/dom/marketing.test.ts`
checks the hashes, that the manifest lists every file under `marketing/vendor/`,
and that each module the hero imports, directly or through another module, is
vendored. A publishing site should copy exactly the files the manifest lists and
can check each against its SHA-256. The sync that publishes
https://shariq.dev/agent-inbox/ does both, and it also downloads the named
`three` release from the npm registry, checks the tarball against the registry's
`dist.integrity`, and requires each vendored file to match the same file in that
tarball. It accepts only `three.module.js`, `three.core.js` and `LICENSE` from the
`three` package, so vendoring any other file needs a change to that sync first.

Keep the full document intact rather than inserting it into a blog template, and
serve the `.js` files with a JavaScript MIME type. If the host sets a Content
Security Policy, allow the embedded script and style blocks by hash and the
vendored modules with `script-src 'self'`; `scripts/serve-marketing.mjs` shows
how the local preview builds that policy.

To move to another Three.js release:

1. Download its package with `npm pack three@<version> --json`, and check that
   the `integrity` it prints matches `npm view three@<version> dist.integrity`.
2. Copy `package/build/three.module.js`, every file it imports, and
   `package/LICENSE` unchanged into `marketing/vendor/three-<version>/`, and
   delete the previous folder.
3. Update `manifest.json`, the hero's import URL, and `THREE_MODULE` in
   `test/dom/marketing.test.ts`.

Only the marketing page and its vendored files should be published.
`npm run marketing` is a loopback-only review server, and `npm run view` serves
the private inbox; neither is the public hosting entry point. The hosting
provider, domain, and route are left to the publishing site.

## Before a pull request

Before opening a pull request, run:

```sh
npm test
npm run typecheck
npm run build
```

Keep changes focused, add regression coverage for behavior changes, and preserve the
architecture invariants documented in [`CLAUDE.md`](CLAUDE.md) and the subsystem docs it
points to in [`docs/architecture/`](docs/architecture/). Bug reports should
include reproduction steps, expected behavior, actual behavior, operating system and
Node version.

After a pull request merges or a release publishes, remove its worktree, branches,
scratch directories and build outputs as described in
[`docs/workspace-hygiene.md`](docs/workspace-hygiene.md).

Security reports must follow [`SECURITY.md`](SECURITY.md), not the public issue tracker.
