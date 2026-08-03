# Contributing

## Development setup

Agent Inbox uses Node 24 and npm:

```sh
git clone https://github.com/shariqh/agent-inbox.git
cd agent-inbox
npm ci
npm test
```

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
