// The privacy screen and --kind (#483, unslop design §5). A refusal names the
// class only: never the matched value.
import { describe, expect, it } from 'vitest'
import { parseKind, screen } from '../src/screen.js'
import type { ScreenClass } from '../src/screen.js'

const CANARY = 'Zq7canary'
const opts = { deny: `# customers\nAcme Rockets\nglobex.example\n`, allowEmails: ['@shariq.dev'] }

const samples: Array<[ScreenClass, string]> = [
  ['letter-shape', `Hi Jane,\n\nThanks for the details on the SSO failure${CANARY}. We found the cause.\n\nBest,\nShariq`],
  ['letter-shape', `Hi Jane, thanks for the details on the SSO failure${CANARY}. We found the cause and a fix ships Friday. Best, Shariq`],
  ['letter-shape', `Dear team${CANARY},\nThe rollout is done.`],
  ['letter-shape', `The rollout is done${CANARY}.\n\nKind regards,\nShariq`],
  ['letter-shape', `The rollout is done${CANARY}.\n-- \nShariq Hirani\nStaff engineer`],
  ['email-headers', `From: Jane <x@y>\nSent: Tuesday\nTo: Shariq\nSubject: SSO ${CANARY}\n\nThe login fails.`],
  ['reply-marker', `Sounds good${CANARY}.\n\nOn Tue, Nov 4, 2026 at 10:02 AM Jane Doe\n<jane@corp.example> wrote:\n> the login fails`],
  ['email-address', `Ping jane.doe${CANARY}@corp.example for access.`],
  ['phone-number', `Call me on (415) 555-0134 ${CANARY}.`],
  ['phone-number', `Call me on +44 20 7946 0958 ${CANARY}.`],
  ['secret', `export GITHUB_TOKEN=ghp_${CANARY}aaaaaaaaaaaaaaaaaaaaaaaaaaaa`],
  ['secret', `key sk-proj-${CANARY}abcdefghijklmnop1234`],
  ['secret', `AKIA${CANARY.toUpperCase()}ABCDEFG used here`],
  ['secret', `-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blb${CANARY}\n-----END OPENSSH PRIVATE KEY-----`],
  ['secret', `Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0${CANARY}.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`],
  ['secret', `token: ${CANARY}9f8e7d6c5b4a`],
  ['secret', `password = "${CANARY}hunter22"`],
  // review round 1 (#486)
  ['letter-shape', `> Hi Sarah,\n> The export fails for ${CANARY}.\n> Thanks,\n> Sarah\n\nLooking into it.`],
  ['letter-shape', `Looking into it.\n\n> Hey Shariq,\n> From: Sarah ${CANARY}\n> The export fails.`],
  ['email-headers', `Looking into it.\n\n> From: Sarah ${CANARY}\n> Sent: Monday\n> To: Shariq\n> Subject: Export`],
  ['letter-shape', `The fix ships Friday ${CANARY}.\n\nThanks!\nShariq`],
  ['letter-shape', `The fix ships Friday ${CANARY}.\n\nThank you!\n\nShariq Hirani`],
  ['letter-shape', `The fix ships Friday ${CANARY}.\n\nThanks so much,\nShariq`],
  ['letter-shape', `The fix ships Friday ${CANARY}.\n\nBest regards,\nShariq Hirani\nStaff Engineer\nGitHub\n+1 555 0100\nshariq.dev\nPronouns: he/him\nSan Francisco`],
  ['letter-shape', `Hi team — the fix ships Friday ${CANARY}.`],
  ['letter-shape', `The fix ships Friday ${CANARY}.\nCheers — Shariq`],
  ['letter-shape', `H\u200Bi Jane,\nThe fix ships Friday ${CANARY}.`],
  ['letter-shape', `Ｈｉ Jane,\nThe fix ships Friday ${CANARY}.`],
  ['deny-list', `The Acme\u200B Rockets ${CANARY} rollout is blocked.`],
  ['secret', `-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOY${CANARY}\n-----END PGP PRIVATE KEY BLOCK-----`],
  ['secret', `export GITLAB_TOKEN=glpat-${CANARY}abcdefghijkl12`],
  ['secret', `POST to https://hooks.slack.com/services/T0ABC1234/B0DEF5678/${CANARY}xyzXYZ123`],
  ['secret', `password: correct-horse-staple ${CANARY}`],
  ['phone-number', `Call the office on 020 7946 0958 ${CANARY}.`],
  ['email-address', `Mail ${CANARY}@corp-mail.dev today.`],
  ['customer-path', `Notes are in ~/dev/obsidian-notes/customers/${CANARY}/sso.md`],
  ['customer-path', `Notes are in /Users/me/dev/obsidian-notes/customers/${CANARY}/sso.md`],
  ['deny-list', `The ACME ROCKETS ${CANARY} rollout is blocked on SSO.`],
  ['deny-list', `Their tenant at sso.globex.example ${CANARY} fails.`],
]

describe('screen', () => {
  for (const [cls, text] of samples) {
    it(`refuses ${cls}: ${text.slice(0, 40).replace(/\n/g, ' ')}`, () => {
      const result = screen(text, opts)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.classes).toContain(cls)
      expect(JSON.stringify(result)).not.toContain(CANARY)
      expect(JSON.stringify(result).toLowerCase()).not.toContain(CANARY.toLowerCase())
    })
  }

  const publicTexts = [
    `## Summary\n\nAdds the rules loader (#483). Run \`npm test\` in packages/mesh/ on Node 24.\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
    `Fixes a race in the store: the read and write now run in one transaction. See docs/architecture/store-and-snapshots.md and https://github.com/shariqh/agent-inbox/pull/484.\n\nThanks to @jane for the report.`,
    `# v2.5.0\n\n- Message wake for Copilot sessions (#477).\n- Released 2026-11-02; about 70 s faster on cold start.\n- Contact security@shariq.dev for disclosures.`,
    `The token is created by \`meshctl enable --unslop\` and stored with mode 0600. It never appears in logs.\n\nThe customer list lives in the deny file, not here.`,
    `Hello from the blog. This week I moved the stdio server's poll to a single read, version 1.2.3.4 of the plan.`,
    // review round 1 (#486): routine package, action and remote references
    'Bump vitest@4.1.12 and typescript@5.6.0, and pin `@types/node@24.0.0`.',
    'Pin actions/setup-node@v7.1.0 and actions/checkout@v7.0.1.',
    'Clone git@github.com:shariqh/agent-inbox.git and run the tests.',
    'Publish foo@1.0.0-beta.rc to the registry.',
    'Released 2026-11-06 at 10:02; the viewer listens on 127.0.0.1:4319 and localhost:4420, build 0.12.3.',
    'Thanks to everyone who tested v2.5.0!\n\nThanks!',
    'The password: required field is checked, and the token: none case is handled.',
    // review round 2: ordinary public text, quoted issues, numbers and placeholders
    'Hi-DPI screens: icons are no longer blurry.',
    'Hello world: a minimal A2A agent in 40 lines.',
    'Hello world — a minimal A2A agent.',
    'Hello World\n\nA minimal A2A agent.',
    'The agent reads its rules.\n\nBest Practices\n\nKeep rules short.',
    'Fixed the export.\n\nThanks!\nRelated Issues\n\n- #12',
    'Reported upstream:\n\n> Hey, this breaks on Linux when the cache is cold.\n> It works on macOS.\n\nFixed in #12.',
    'Set modes 0600 0644 0755 on the files; build 0123 4567 8901 and ticket 0123 456 789.',
    'Set `password: <your-password>` in the config.',
    'Read it with password = process.env.DB_PASS or password: ${DB_PASS} or password: {{ secret }}, shown as password: ********.',
    'In Python, password = os.environ["DB_PASS"].',
  ]
  for (const text of publicTexts) {
    it(`passes public text: ${text.slice(0, 40).replace(/\n/g, ' ')}`, () => {
      expect(screen(text, opts)).toEqual({ ok: true })
    })
  }

  it('reports every class found, and has no override', () => {
    const result = screen('Hi Jane,\nCall (415) 555-0134.\nThanks,\nShariq', { ...opts, override: true } as never)
    expect(result).toEqual({ ok: false, classes: ['letter-shape', 'phone-number'] })
  })
})

describe('screen cost', () => {
  it('stays linear on hostile 12 KiB inputs', () => {
    const inputs = ['a'.repeat(12288), 'a.'.repeat(6144), '1'.repeat(12288), '0 '.repeat(6144), 'a@'.repeat(6144),
      '> '.repeat(6144), 'Thanks '.repeat(1755), 'Hi '.repeat(4096), '-----BEGIN '.repeat(1117), 'password: '.repeat(1228),
      '0123 '.repeat(2457), '(020) '.repeat(2048), 'password: <'.repeat(1117), 'Thanks!\n'.repeat(1536)]
    const started = Date.now()
    for (const text of inputs) screen(text, opts)
    expect(Date.now() - started).toBeLessThan(1500)
  })
})

describe('parseKind', () => {
  it('accepts the five public kinds and refuses anything else', () => {
    for (const kind of ['pr', 'issue', 'release-notes', 'docs', 'blog']) expect(parseKind(kind)).toBe(kind)
    for (const kind of ['email', 'PR', ' pr', 'notes', '', undefined, 'docs ']) expect(parseKind(kind)).toBeUndefined()
  })
})
