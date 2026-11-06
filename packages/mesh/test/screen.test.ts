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

describe('parseKind', () => {
  it('accepts the five public kinds and refuses anything else', () => {
    for (const kind of ['pr', 'issue', 'release-notes', 'docs', 'blog']) expect(parseKind(kind)).toBe(kind)
    for (const kind of ['email', 'PR', ' pr', 'notes', '', undefined, 'docs ']) expect(parseKind(kind)).toBeUndefined()
  })
})
