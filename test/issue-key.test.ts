// Issue #103, PR1a: repo-qualified issue keys, the certainty of each entity's
// issue (§4.2) and the refresh and display key sets (§6).
import { describe, expect, it } from 'vitest'
import { issueKey, issueKeyFor, issueKeySets } from '../public/issue-key.js'
import type { IssueKeyLink, IssueKeySetEntity } from '../public/issue-key.js'

const REPO = 'shariqh/agent-inbox'
const FETCHED = '2026-10-19T22:30:00.000Z'

function link(extra: Partial<IssueKeyLink> = {}): IssueKeyLink {
  return { repo: REPO, branch: '120-ahp-input', head_repo: REPO, issue_number: null, fetched_at: FETCHED, ...extra }
}

const bound = (...refs: Array<{ repo: string; number: number }>) => JSON.stringify({ fetched_at: FETCHED, refs })

const item = { repo: REPO, stream: '120-ahp-input', head_repo: null, issue_ref: 120 }

describe('issueKey', () => {
  it('qualifies every number with its repository, lowercased', () => {
    expect(issueKey('Shariqh/Agent-Inbox', 120)).toBe('shariqh/agent-inbox#120')
    expect(issueKey('shariqh/agent-inbox', 120)).toBe(issueKey('SHARIQH/AGENT-INBOX', 120))
    expect(issueKey('a/x', 5)).not.toBe(issueKey('b/y', 5))
    expect(issueKey('twbs/bootstrap.js', 2_147_483_647)).toBe('twbs/bootstrap.js#2147483647')
  })

  it.each<[unknown, unknown]>([
    ['', 1], ['owner', 1], ['a/b/c', 1], ['../x', 1], ['x/..', 1], ['./x', 1], ['a b/c', 1],
    ['https://github.com/a/b', 1], [null, 1], [42, 1],
    ['a/b', 0], ['a/b', -1], ['a/b', 1.5], ['a/b', 2 ** 31], ['a/b', Number.NaN], ['a/b', '5'], ['a/b', null],
  ])('refuses %j #%j', (repo, number) => {
    expect(issueKey(repo, number)).toBeNull()
  })
})

describe('issueKeyFor: precedence and certainty (§4.2)', () => {
  it('uses the branch or registered issue, certain, when there is no PR', () => {
    expect(issueKeyFor(item, null)).toEqual({ key: 'shariqh/agent-inbox#120', source: 'branch', certain: true })
    expect(issueKeyFor({ ...item, repo: null }, null)).toBeNull()
    expect(issueKeyFor({ ...item, issue_ref: null }, null)).toBeNull()
    expect(issueKeyFor(null, null)).toBeNull()
  })

  it('a PR closing exactly one issue wins, certain, even across repositories', () => {
    expect(issueKeyFor(item, link({ closing_refs: bound({ repo: 'Other/Repo', number: 7 }) })))
      .toEqual({ key: 'other/repo#7', source: 'pr', certain: true })
  })

  it('a PR closing several issues is never guessed: the entity falls back to its branch issue', () => {
    const several = link({
      issue_number: 211,
      closing_refs: bound({ repo: REPO, number: 211 }, { repo: REPO, number: 212 }),
    })
    expect(issueKeyFor(item, several)).toEqual({ key: 'shariqh/agent-inbox#120', source: 'branch', certain: true })
    expect(issueKeyFor({ ...item, issue_ref: null }, several)).toBeNull()
  })

  it('counts distinct issues: one issue listed twice, in any casing, is one reference', () => {
    const twice = link({ closing_refs: bound({ repo: REPO, number: 211 }, { repo: 'SHARIQH/agent-inbox', number: 211 }) })
    expect(issueKeyFor(item, twice)).toEqual({ key: 'shariqh/agent-inbox#211', source: 'pr', certain: true })
  })

  it('a PR closing nothing falls back to the branch issue, as today', () => {
    expect(issueKeyFor(item, link({ closing_refs: bound() }))).toEqual({
      key: 'shariqh/agent-inbox#120', source: 'branch', certain: true,
    })
  })

  it.each([
    ['absent (written before PR1b)', undefined],
    ['unbound (rewritten since by an older process)', JSON.stringify({ fetched_at: '2026-10-19T22:00:00.000Z', refs: [{ repo: REPO, number: 211 }] })],
    ['corrupt', '{"fetched_at":'],
    ['holding an invalid reference', JSON.stringify({ fetched_at: FETCHED, refs: [{ repo: '../x', number: 211 }] })],
    ['missing its refs', JSON.stringify({ fetched_at: FETCHED })],
  ])('closing references %s keep the legacy chip display-only', (_why, closingRefs) => {
    expect(issueKeyFor(item, link({ issue_number: 211, closing_refs: closingRefs })))
      .toEqual({ key: 'shariqh/agent-inbox#211', source: 'pr', certain: false })
    // …and with no legacy issue at all, the branch issue is still certain
    expect(issueKeyFor(item, link({ issue_number: null, closing_refs: closingRefs })))
      .toEqual({ key: 'shariqh/agent-inbox#120', source: 'branch', certain: true })
  })

  it('accepts closing references already parsed as well as the stored JSON text', () => {
    const parsed = { fetched_at: FETCHED, refs: [{ repo: REPO, number: 211 }] }
    expect(issueKeyFor(item, link({ closing_refs: parsed }))).toEqual({
      key: 'shariqh/agent-inbox#211', source: 'pr', certain: true,
    })
  })
})

describe('issueKeyFor: explicit links (PR2)', () => {
  const pinned = { ...item, issue_pin_repo: 'Shariqh/Agent-Inbox', issue_pin_number: 117 }
  const pin = { key: 'shariqh/agent-inbox#117', source: 'pin', certain: true }

  it('a plan pin outranks the PR issue and the branch issue', () => {
    expect(issueKeyFor(pinned, null)).toEqual(pin)
    expect(issueKeyFor(pinned, link({ closing_refs: bound({ repo: REPO, number: 211 }) }))).toEqual(pin)
    expect(issueKeyFor(pinned, link({ issue_number: 211 }))).toEqual(pin)
    expect(issueKeyFor({ ...pinned, repo: null, issue_ref: null }, null)).toEqual(pin)
  })

  it('an unusable pin falls back to the PR and branch issue', () => {
    expect(issueKeyFor({ ...pinned, issue_pin_number: null }, null)).toEqual({ key: 'shariqh/agent-inbox#120', source: 'branch', certain: true })
    expect(issueKeyFor({ ...pinned, issue_pin_repo: '../x' }, link({ closing_refs: bound({ repo: REPO, number: 211 }) })))
      .toEqual({ key: 'shariqh/agent-inbox#211', source: 'pr', certain: true })
  })

  it('a row link is the row’s only source, and certain', () => {
    expect(issueKeyFor({ issue_repo: 'o/r', issue_number: 5 }, null)).toEqual({ key: 'o/r#5', source: 'link', certain: true })
    expect(issueKeyFor({ issue_repo: null, issue_number: null }, null)).toBeNull()
  })
})

describe('issueKeySets: refresh and display (§6)', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 22, minute)).toISOString()
  function entity(extra: Partial<IssueKeySetEntity>): IssueKeySetEntity {
    return {
      kind: 'item', id: 'x', project: 'agent-inbox', project_closed: false, archived: false,
      repo: REPO, stream: 'main', head_repo: null, issue_ref: null, updated_at: at(0), ...extra,
    }
  }

  it('refreshes open items and active plans in open projects, and displays closed projects and archived plans too', () => {
    const sets = issueKeySets([
      entity({ id: 'open', issue_ref: 1, updated_at: at(1) }),
      entity({ id: 'plan', kind: 'plan', issue_ref: 2, updated_at: at(2) }),
      entity({ id: 'peek', project: 'retired', project_closed: true, issue_ref: 3, updated_at: at(3) }),
      entity({ id: 'old', kind: 'plan', archived: true, issue_ref: 4, updated_at: at(4) }),
      entity({ id: 'nothing', issue_ref: null }),
    ], [])
    expect([...sets.refresh].sort()).toEqual(['shariqh/agent-inbox#1', 'shariqh/agent-inbox#2'])
    expect(Object.fromEntries(sets.display)).toEqual({
      'shariqh/agent-inbox#1': { refresh: true, updated_at: at(1) },
      'shariqh/agent-inbox#2': { refresh: true, updated_at: at(2) },
      'shariqh/agent-inbox#3': { refresh: false, updated_at: at(3) },
      'shariqh/agent-inbox#4': { refresh: false, updated_at: at(4) },
    })
  })

  it('merges entities that link one key: it refreshes if any of them does, and keeps the newest activity', () => {
    const sets = issueKeySets([
      entity({ id: 'a', project: 'retired', project_closed: true, issue_ref: 9, updated_at: at(9) }),
      entity({ id: 'b', repo: 'SHARIQH/AGENT-INBOX', issue_ref: 9, updated_at: at(5) }),
      entity({ id: 'c', kind: 'plan', archived: true, issue_ref: 9, updated_at: at(7) }),
    ], [])
    expect([...sets.refresh]).toEqual(['shariqh/agent-inbox#9'])
    expect(sets.display.get('shariqh/agent-inbox#9')).toEqual({ refresh: true, updated_at: at(9) })
  })

  it('joins each entity to its PR exactly as the chips do, and leaves uncertain identities out of both sets', () => {
    const fork = 'fork/agent-inbox'
    const links: IssueKeyLink[] = [
      link({ branch: 'one', closing_refs: bound({ repo: REPO, number: 31 }) }),
      link({ branch: 'legacy', issue_number: 32 }),
      // a fork's same-named branch must not lend its PR to a same-repository entity (#157)
      link({ branch: 'shared', head_repo: fork, closing_refs: bound({ repo: REPO, number: 33 }) }),
    ]
    const sets = issueKeySets([
      entity({ id: 'pr', stream: 'one', issue_ref: 1 }),
      entity({ id: 'legacy', stream: 'legacy', issue_ref: 2 }),
      entity({ id: 'same-repo', stream: 'shared', issue_ref: 3 }),
      entity({ id: 'forked', stream: 'shared', head_repo: fork, issue_ref: 4 }),
    ], links)
    expect([...sets.display.keys()].sort()).toEqual([
      'shariqh/agent-inbox#3', 'shariqh/agent-inbox#31', 'shariqh/agent-inbox#33',
    ])
  })

  it('a pinned plan and its linked rows join both sets on their explicit keys (PR2)', () => {
    const sets = issueKeySets([
      entity({ id: 'plan', kind: 'plan', issue_ref: 119, issue_pin_repo: REPO, issue_pin_number: 117 }),
      entity({ id: 'row', kind: 'row', repo: null, stream: '', issue_repo: 'o/r', issue_number: 5, updated_at: at(5) }),
      entity({ id: 'old-row', kind: 'row', archived: true, repo: null, stream: '', issue_repo: 'o/r', issue_number: 6 }),
    ], [])
    expect([...sets.refresh].sort()).toEqual(['o/r#5', 'shariqh/agent-inbox#117'])
    expect([...sets.display.keys()].sort()).toEqual(['o/r#5', 'o/r#6', 'shariqh/agent-inbox#117'])
  })
})
