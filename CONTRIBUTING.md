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
`marketing/index.html` is self-contained and can also be opened directly.
The interactive demo uses fictional data held only in the page; the preview
server does not open the inbox database or expose the viewer API.
The marketing page defaults to light appearance and owns its styles independently
of `public/`. Use `?scoutTheme=dark` or the footer appearance button to review its
dark counterpart.
The inline brand symbol mirrors `assets/icon.svg`; keep it synchronized with the
source artwork.

### Hosting the marketing page

Publish `marketing/index.html` as a standalone static page. Its styles, scripts,
icons, and demo data are embedded; hosting it requires no build command,
dependencies, environment variables, or backend. It can live at a site's root,
on a subdomain, or under a path without changing its in-page links.

Keep the full document intact rather than inserting it into a blog template.
If the host sets a Content Security Policy, allow the embedded script and style
blocks by hash; `scripts/serve-marketing.mjs` shows how the local preview computes
those hashes.

Only the marketing page should be published. `npm run marketing` is a
loopback-only review server, and `npm run view` serves the private inbox; neither
is the public hosting entry point. The hosting provider, domain, and route are
left to the publishing site.

## Before a pull request

Before opening a pull request, run:

```sh
npm test
npm run typecheck
npm run build
```

Keep changes focused, add regression coverage for behavior changes, and preserve the
architecture invariants documented in [`CLAUDE.md`](CLAUDE.md). Bug reports should
include reproduction steps, expected behavior, actual behavior, operating system and
Node version.

Security reports must follow [`SECURITY.md`](SECURITY.md), not the public issue tracker.
