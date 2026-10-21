// Issue #103, PR1b: the viewer's issue poller (design §5). Every test drives
// refreshIssuesOnce with an injected clock and an injected `gh`, over a real
// SQLite hub; nothing here touches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  archiveBoard, closeProject, getBoard, insertItem, listIssueEntities, listIssueSnapshots, listSourceLinks, openDb,
  recordIssueFailure, upsertBoard, upsertIssueSnapshot, upsertSourceLink,
} from '../src/store.js'
import type { IssueDependencies, IssueSnapshot } from '../src/store.js'
import {
  IssueBudget, ISSUE_BATCH, ISSUE_POINTS_PER_HOUR, ISSUE_TTL, RATE_FLOOR, issueQueue, parseIssueBatch,
  invalidSnapshotNotice, refreshIssuesOnce, relationsArgs, relationsQuery, startGithubPoller,
} from '../src/issue-poller.js'
import type { IssueGhRun } from '../src/issue-poller.js'
import { createViewer } from '../src/viewer.js'
import { at, facts, snapshot } from './issue-fixtures.js'
import { scratchDir } from './scratch.js'

const REPO = 'shariqh/agent-inbox'
const MIN = 60_000
const ms = (minute: number) => Date.parse(at(minute))
const DESIGN = readFileSync(new URL('../docs/superpowers/specs/2026-10-19-plans-sub-issues-design.md', import.meta.url), 'utf8')
const DEPS_DESIGN = readFileSync(new URL('../docs/superpowers/specs/2026-10-21-plan-dependencies-design.md', import.meta.url), 'utf8')
const FAMILY = JSON.parse(readFileSync(new URL('./fixtures/issue-117-family.json', import.meta.url), 'utf8')) as {
  rows: Array<{ repo: string; number: number; snapshot: IssueSnapshot }>
}
const RELATIONS_10 = readFileSync(new URL('./fixtures/issue-relations-10.json', import.meta.url), 'utf8')
// the live answer to the slice-2 document for the same ten issues (2026-10-21, cost 1)
const RELATIONS_10_DEPS = readFileSync(new URL('./fixtures/issue-relations-10-deps.json', import.meta.url), 'utf8')

// ── a fake GitHub: answers the real document shape for the keys it is asked ──

interface WorldIssue { title?: string; state?: 'OPEN' | 'CLOSED'; parent?: string; blockedBy?: string[] }
type World = Map<string, WorldIssue>

const split = (key: string) => ({ repo: key.slice(0, key.lastIndexOf('#')), number: Number(key.slice(key.lastIndexOf('#') + 1)) })

function gqlNode(world: World, key: string) {
  const { repo, number } = split(key)
  const w = world.get(key) ?? {}
  const state = w.state ?? 'OPEN'
  return { number, title: w.title ?? `Title of ${key}`, state, stateReason: state === 'CLOSED' ? 'COMPLETED' : null, repository: { nameWithOwner: repo } }
}

function childrenOf(world: World, key: string): string[] {
  return [...world].filter(([, w]) => w.parent === key).map(([k]) => k)
}

function summary(world: World, key: string) {
  const kids = childrenOf(world, key)
  return { total: kids.length, completed: kids.filter((k) => world.get(k)?.state === 'CLOSED').length }
}

// GitHub keeps both directions of a dependency, so `blocking` is derived from every `blockedBy`
function gqlDependencies(world: World, key: string) {
  const blockedBy = world.get(key)?.blockedBy ?? []
  const blocking = [...world].filter(([, w]) => w.blockedBy?.includes(key)).map(([k]) => k)
  const open = (keys: string[]) => keys.filter((k) => world.get(k)?.state !== 'CLOSED').length
  const list = (keys: string[]) => ({ totalCount: keys.length, pageInfo: { hasNextPage: false }, nodes: keys.map((k) => gqlNode(world, k)) })
  return {
    issueDependenciesSummary: { blockedBy: open(blockedBy), totalBlockedBy: blockedBy.length, blocking: open(blocking), totalBlocking: blocking.length },
    blockedBy: list(blockedBy),
    blocking: list(blocking),
  }
}

function gqlRoot(world: World, key: string) {
  const chain = (k: string | undefined, level: number): unknown => {
    if (!k) return null
    const node: Record<string, unknown> = { ...gqlNode(world, k), parent: chain(world.get(k)?.parent, level + 1) }
    if (level === 0) node.subIssuesSummary = summary(world, k)
    return node
  }
  const kids = childrenOf(world, key)
  return {
    ...gqlNode(world, key),
    subIssuesSummary: summary(world, key),
    parent: chain(world.get(key)?.parent, 0),
    subIssues: {
      totalCount: kids.length, pageInfo: { hasNextPage: false },
      nodes: kids.map((k) => ({ ...gqlNode(world, k), subIssuesSummary: summary(world, k) })),
    },
    ...gqlDependencies(world, key),
  }
}

/** The keys a recorded argv asked for, in alias order. */
function asked(args: string[]): string[] {
  const vars = new Map<string, string>()
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-f' || args[i] === '-F') {
      const [name, ...value] = args[i + 1]!.split('=')
      vars.set(name!, value.join('='))
    }
  }
  const keys: string[] = []
  for (let i = 0; vars.has(`o${i}`); i++) keys.push(`${vars.get(`o${i}`)}/${vars.get(`n${i}`)}#${vars.get(`k${i}`)}`)
  return keys
}

function fakeGitHub(world: World, rateLimit = { cost: 1, remaining: 4_000, resetAt: '2026-10-19T23:59:00Z' }) {
  const calls: string[][] = []
  const run: IssueGhRun = (args) => {
    calls.push(asked(args))
    const data: Record<string, unknown> = { rateLimit }
    const errors: unknown[] = []
    asked(args).forEach((key, i) => {
      const { repo } = split(key)
      if (world.has(key)) data[`r${i}`] = { nameWithOwner: repo, issue: gqlRoot(world, key) }
      else {
        data[`r${i}`] = { nameWithOwner: repo, issue: null }
        errors.push({ type: 'NOT_FOUND', path: [`r${i}`, 'issue'], message: 'Could not resolve to an issue' })
      }
    })
    return { stdout: JSON.stringify(errors.length ? { data, errors } : { data }), stderr: '', code: errors.length ? 1 : 0 }
  }
  return { run, calls }
}

// ────────────────────────────────────────────────────────────────────────────

describe('relationsQuery and the gh argv (§5.6)', () => {
  it('builds exactly the verified one-root document: slice 1’s, with slice 2’s dependency fields closing Root', () => {
    const block = DESIGN.split('```graphql\n')[1]!.split('```')[0]!
    const deps = DEPS_DESIGN.split('```graphql\n')[1]!.split('```')[0]!
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
    expect(deps).toContain('blockedBy(first: 50)')
    expect(norm(relationsQuery(1))).toBe(norm(`${block.trimEnd().slice(0, -1)}${deps}}`))
  })

  it('declares exactly n variable sets and n aliases for every batch size, deterministically', () => {
    for (let n = 1; n <= 10; n++) {
      const doc = relationsQuery(n)
      expect(doc).toBe(relationsQuery(n))
      expect(doc.startsWith(`query Relations${n}(`)).toBe(true)
      expect(doc.match(/\$o\d+: String!/g)).toHaveLength(n)
      expect(doc.match(/\$k\d+: Int!/g)).toHaveLength(n)
      expect(doc.match(/\br\d+: repository\(/g)).toHaveLength(n)
      expect(doc).toContain(`r${n - 1}: repository(owner: $o${n - 1}, name: $n${n - 1})`)
      expect(doc).not.toContain(`$o${n}:`)
    }
    expect(relationsQuery(10)).toMatchSnapshot()
    expect(() => relationsQuery(0)).toThrow()
    expect(() => relationsQuery(11)).toThrow()
  })

  it('passes owner and name as raw -f strings and only validated numbers through -F, pinned to github.com', () => {
    const args = relationsArgs([{ repo: 'shariqh/agent-inbox', number: 120 }, { repo: 'Other/Lib.js', number: 7 }])
    expect(args.slice(0, 4)).toEqual(['api', '--hostname', 'github.com', 'graphql'])
    expect(args.slice(4)).toEqual([
      '-f', `query=${relationsQuery(2)}`,
      '-f', 'o0=shariqh', '-f', 'n0=agent-inbox', '-F', 'k0=120',
      '-f', 'o1=Other', '-f', 'n1=Lib.js', '-F', 'k1=7',
    ])
    expect(() => relationsArgs([{ repo: '../x', number: 1 }])).toThrow()
    expect(() => relationsArgs([{ repo: 'a/b', number: 1.5 }])).toThrow()
  })
})

describe('parseIssueBatch (§5.7)', () => {
  const claimed = (...keys: string[]) => keys.map(split)
  const ok = (repo: string, number: number, extra: Record<string, unknown> = {}) => ({
    nameWithOwner: repo,
    issue: {
      number, title: `T${number}`, state: 'OPEN', stateReason: null, repository: { nameWithOwner: repo },
      subIssuesSummary: { total: 0, completed: 0 }, parent: null,
      subIssues: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
      blockedBy: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
      blocking: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
      ...extra,
    },
  })
  const out = (body: unknown) => JSON.stringify(body)
  const NO_DEPENDENCIES = {
    status: 'ok',
    blocked_by: { open: 0, total: 0, truncated: false, list: [] },
    blocking: { open: 0, total: 0, truncated: false, list: [] },
  }

  // RELATIONS_10 is the live answer to the slice-1 document, which asked for no
  // dependency fields: its hierarchy parses exactly as before, and a section
  // GitHub did not return is unavailable, never "no dependencies".
  it('turns the live ten-root response into exactly the stored #117 family snapshots', () => {
    const keys = FAMILY.rows.map((r) => ({ repo: r.repo, number: r.number }))
    const batch = parseIssueBatch(RELATIONS_10, keys)
    expect(batch.outcomes).toEqual(FAMILY.rows.map((r) => ({ snapshot: r.snapshot, dependencies: { status: 'unavailable' } })))
    expect(batch.rateLimit).toEqual({ cost: 1, remaining: 9136, resetAt: '2026-10-19T22:49:46Z' })
  })

  it('classifies NOT_FOUND per alias and per issue as hard, leaving the other aliases intact', () => {
    const batch = parseIssueBatch(out({
      data: { r0: null, r1: { nameWithOwner: 'a/b', issue: null }, r2: ok('a/b', 3) },
      errors: [
        { type: 'NOT_FOUND', path: ['r0'], message: "Could not resolve to a Repository with the name 'x/none'." },
        // a pull request number is NOT_FOUND to issue(number:) as well
        { type: 'NOT_FOUND', path: ['r1', 'issue'], message: 'Could not resolve to an issue' },
      ],
    }), claimed('x/none#1', 'a/b#215', 'a/b#3'), { code: 1, stderr: 'gh: Could not resolve' })
    expect(batch.outcomes.map((o) => ('error' in o ? o.error : 'ok'))).toEqual(['not-found', 'not-found', 'ok'])
  })

  it('classifies SAML FORBIDDEN as hard and RATE_LIMITED or anything else per alias as soft', () => {
    const batch = parseIssueBatch(out({
      data: { r0: ok('a/b', 1), r1: null, r2: null, r3: null },
      errors: [
        { type: 'FORBIDDEN', path: ['r1'], extensions: { saml_failure: true }, message: 'SAML' },
        { type: 'RATE_LIMITED', path: ['r2'], message: 'slow down' },
        { type: 'SOMETHING_NEW', path: ['r3', 'issue'], message: '?' },
      ],
    }), claimed('a/b#1', 'github/roadmap#1', 'a/b#2', 'a/b#3'), { code: 1, stderr: '' })
    expect(batch.outcomes.map((o) => ('error' in o ? o.error : 'ok'))).toEqual(['ok', 'forbidden', 'rate-limit', 'gh-failed'])
  })

  it('a hard and a soft error on one alias stay soft: data is deleted only on a clear no', () => {
    const batch = parseIssueBatch(out({
      data: { r0: null },
      errors: [{ type: 'NOT_FOUND', path: ['r0'] }, { type: 'INTERNAL', path: ['r0', 'issue'] }],
    }), claimed('a/b#1'), { code: 1, stderr: '' })
    expect(batch.outcomes).toEqual([{ error: 'gh-failed' }])
  })

  it('a field error under parent or subIssues makes only that root\'s hierarchy unavailable', () => {
    const batch = parseIssueBatch(out({
      data: { r0: ok('a/b', 1, { subIssues: null }), r1: ok('a/b', 2, { parent: null }), r2: ok('a/b', 3) },
      errors: [
        { type: 'INTERNAL', path: ['r0', 'issue', 'subIssues'], message: 'timeout' },
        // an error deep in a section voids it even when the rest of it looks whole
        { type: 'INTERNAL', path: ['r2', 'issue', 'parent', 'parent', 'title'], message: 'timeout' },
      ],
    }), claimed('a/b#1', 'a/b#2', 'a/b#3'), { code: 1, stderr: '' })
    expect(batch.outcomes[0]).toEqual({
      snapshot: { v: 1, issue: { repo: 'a/b', number: 1, title: 'T1', state: 'OPEN', state_reason: null },
        ancestors: [], ancestors_end: 'top', hierarchy: { status: 'unavailable' } },
      // the sections are independent: a broken hierarchy leaves the dependencies alone
      dependencies: NO_DEPENDENCIES,
    })
    expect(batch.outcomes[1]).toMatchObject({ snapshot: { hierarchy: { status: 'ok' } } })
    expect(batch.outcomes[2]).toMatchObject({ snapshot: { issue: { number: 3 }, ancestors: [], hierarchy: { status: 'unavailable' } } })
  })

  it('fails a whole request softly for every claimed key, by its cause', () => {
    const two = claimed('a/b#1', 'a/b#2')
    // a validation error carries no data at all
    const validation = out({ errors: [{ message: 'Variable $o3 of type String! was provided invalid value' }] })
    expect(parseIssueBatch(validation, two, { code: 1, stderr: 'gh: Variable $o3' }).outcomes).toEqual([{ error: 'gh-failed' }, { error: 'gh-failed' }])
    expect(parseIssueBatch(out({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }), two, { code: 1, stderr: '' }))
      .toMatchObject({ outcomes: [{ error: 'rate-limit' }, { error: 'rate-limit' }], whole: 'rate-limit' })
    expect(parseIssueBatch('', two, { code: 'ENOENT', stderr: '' }).outcomes).toEqual([{ error: 'no-gh' }, { error: 'no-gh' }])
    expect(parseIssueBatch('', two, { code: 4, stderr: 'To get started with GitHub CLI, please run: gh auth login' }).outcomes[0]).toEqual({ error: 'auth' })
    expect(parseIssueBatch('', two, { code: 1, stderr: 'dial tcp: lookup api.github.com: no such host' }).outcomes[0]).toEqual({ error: 'offline' })
    expect(parseIssueBatch('<html>', two).outcomes).toEqual([{ error: 'gh-failed' }, { error: 'gh-failed' }])
    expect(parseIssueBatch(out({ data: {} }), two).outcomes).toEqual([{ error: 'gh-failed' }, { error: 'gh-failed' }])
  })

  it('aliases a repository redirect and calls any other identity mismatch moved', () => {
    const batch = parseIssueBatch(out({
      data: {
        r0: { ...ok('twbs/bootstrap', 2) },
        r1: ok('a/b', 9),
        r2: { nameWithOwner: 'a/b', issue: { ...ok('c/d', 3).issue } },
        r3: ok('A/B', 4),
      },
    }), claimed('twitter/bootstrap#2', 'a/b#8', 'a/b#3', 'a/b#4'))
    expect(batch.outcomes[0]).toMatchObject({ snapshot: { issue: { repo: 'twbs/bootstrap', number: 2 } } })
    expect(batch.outcomes[1]).toEqual({ error: 'moved' })
    expect(batch.outcomes[2]).toEqual({ error: 'moved' })
    // GitHub's own casing of the same repository is no redirect at all
    expect(batch.outcomes[3]).toMatchObject({ snapshot: { issue: { repo: 'A/B', number: 4 } } })
  })

  it('validates every node: drops an invalid child (the list is then incomplete), clips titles, drops self-links and duplicates', () => {
    const child = (number: number, extra: Record<string, unknown> = {}) => ({
      number, title: `C${number}`, state: 'CLOSED', stateReason: 'COMPLETED', repository: { nameWithOwner: 'a/b' },
      subIssuesSummary: { total: 0, completed: 0 }, ...extra,
    })
    const batch = parseIssueBatch(out({
      data: {
        r0: ok('a/b', 1, {
          title: 'x'.repeat(500),
          subIssuesSummary: { total: 5, completed: 3 },
          subIssues: {
            totalCount: 5, pageInfo: { hasNextPage: false },
            nodes: [child(2), child(1), child(2), child(3, { stateReason: 'WONTFIX' }), child(4, { subIssuesSummary: { total: 1, completed: 2 } })],
          },
        }),
        r1: ok('a/b', 9, {
          subIssues: { totalCount: 101, pageInfo: { hasNextPage: true }, nodes: [child(10)] },
          subIssuesSummary: { total: 101, completed: 1 },
        }),
      },
    }), claimed('a/b#1', 'a/b#9'))
    const first = (batch.outcomes[0] as { snapshot: IssueSnapshot }).snapshot
    expect(first.issue.title).toBe(`${'x'.repeat(300)}…`)
    expect(first.hierarchy).toEqual({
      status: 'ok', total: 5, completed: 3, truncated: true,
      children: [
        { repo: 'a/b', number: 2, title: 'C2', state: 'CLOSED', state_reason: 'COMPLETED', children_total: 0, children_completed: 0 },
        // invalid counts are omitted, never coerced; the node itself is valid
        { repo: 'a/b', number: 4, title: 'C4', state: 'CLOSED', state_reason: 'COMPLETED' },
      ],
    })
    expect((batch.outcomes[1] as { snapshot: IssueSnapshot }).snapshot.hierarchy).toMatchObject({ truncated: true })
  })

  it('walks up to eight ancestors, ending at the top or at the limit, and stops at an invalid or repeated one', () => {
    // `open`: the last ancestor carries no parent field at all, as level eight does
    const chainOf = (numbers: number[], end: 'top' | 'open' = 'top'): unknown =>
      numbers.length === 0 ? null : {
        number: numbers[0], title: `A${numbers[0]}`, state: 'OPEN', stateReason: null, repository: { nameWithOwner: 'a/b' },
        ...(numbers.length === 1 && end === 'open' ? {} : { parent: chainOf(numbers.slice(1), end) }),
      }
    const batch = parseIssueBatch(out({
      data: {
        r0: ok('a/b', 1, { parent: chainOf([2, 3, 4, 5, 6, 7, 8, 9], 'open') }),
        r1: ok('a/b', 1, { parent: chainOf([2, 3]) }),
        r2: ok('a/b', 1, { parent: chainOf([2, 1, 3]) }),
        r3: ok('a/b', 1, { parent: { ...(chainOf([2]) as object), state: 'MAYBE' } }),
        r4: ok('a/b', 1, { parent: chainOf([2, 3], 'open') }),
      },
    }), claimed('a/b#1', 'a/b#1', 'a/b#1', 'a/b#1', 'a/b#1'))
    const walk = (i: number) => {
      const s = (batch.outcomes[i] as { snapshot: IssueSnapshot }).snapshot
      return [s.ancestors.map((a) => a.number), s.ancestors_end, s.hierarchy.status]
    }
    expect(walk(0)).toEqual([[2, 3, 4, 5, 6, 7, 8, 9], 'limit', 'ok'])
    expect(walk(1)).toEqual([[2, 3], 'top', 'ok'])
    expect(walk(2)).toEqual([[2], 'limit', 'ok'])
    // the immediate parent unreadable: nothing about parentage can be said
    expect(walk(3)).toEqual([[], 'top', 'unavailable'])
    // a parent field missing below level eight is not "no parent"
    expect(walk(4)).toEqual([[2, 3], 'limit', 'ok'])
  })

  // ── slice 2 §5.2: GitHub's issue dependencies ──────────────────────────────

  const dep = (number: number, extra: Record<string, unknown> = {}) => ({
    number, title: `D${number}`, state: 'OPEN', stateReason: null, repository: { nameWithOwner: 'a/b' }, ...extra,
  })
  const connection = (nodes: unknown[], hasNextPage = false) => ({ totalCount: nodes.length, pageInfo: { hasNextPage }, nodes })
  const summary = (blockedBy: number, totalBlockedBy: number, blocking: number, totalBlocking: number) =>
    ({ blockedBy, totalBlockedBy, blocking, totalBlocking })
  const dependenciesOf = (batch: ReturnType<typeof parseIssueBatch>, i: number) =>
    (batch.outcomes[i] as { dependencies: IssueDependencies }).dependencies

  it('reads the #117 family’s dependencies from the live slice-2 response, both directions agreeing (slice 2 §2)', () => {
    const keys = FAMILY.rows.map((r) => ({ repo: r.repo, number: r.number }))
    const batch = parseIssueBatch(RELATIONS_10_DEPS, keys)
    expect(batch.rateLimit).toMatchObject({ cost: 1 })
    // the added fields leave the hierarchy exactly as slice 1 stored it
    expect(batch.outcomes.map((o) => ('snapshot' in o ? o.snapshot : o))).toEqual(FAMILY.rows.map((r) => r.snapshot))
    const numbers = (list: Array<{ number: number }>) => list.map((issue) => issue.number)
    expect(batch.outcomes.map((_, i) => {
      const deps = dependenciesOf(batch, i)
      return deps.status === 'ok' ? [keys[i]!.number, numbers(deps.blocked_by.list), numbers(deps.blocking.list)] : deps.status
    })).toEqual([
      [117, [], []],
      [118, [119], []],
      // GitHub listed these newest first; the section keeps key order
      [119, [], [118, 120, 121, 122, 123, 124, 125]],
      [120, [119], [121]],
      [121, [119, 120], []],
      [122, [119], []], [123, [119], []], [124, [119], []], [125, [119], []],
      [126, [], []],
    ])
    const facts = (number: number) => FAMILY.rows.find((r) => r.number === number)!.snapshot.issue
    expect(dependenciesOf(batch, 4)).toEqual({
      status: 'ok',
      blocked_by: { open: 2, total: 2, truncated: false, list: [facts(119), facts(120)] },
      blocking: { open: 0, total: 0, truncated: false, list: [] },
    })
  })

  it('a field error under issueDependenciesSummary, blockedBy or blocking makes only that root’s dependencies unavailable', () => {
    const batch = parseIssueBatch(out({
      data: {
        r0: ok('a/b', 1, { issueDependenciesSummary: null }),
        r1: ok('a/b', 2, { blockedBy: null }),
        r2: ok('a/b', 3),
        r3: ok('a/b', 4, { parent: null }),
        r4: ok('a/b', 5),
      },
      errors: [
        { type: 'INTERNAL', path: ['r0', 'issue', 'issueDependenciesSummary'], message: 'timeout' },
        { type: 'INTERNAL', path: ['r1', 'issue', 'blockedBy'], message: 'timeout' },
        // an error deep in the section voids it even when the rest of it looks whole
        { type: 'INTERNAL', path: ['r2', 'issue', 'blocking', 'nodes', 0, 'title'], message: 'timeout' },
        // one error in each section: each fails on its own and the root still stands
        { type: 'INTERNAL', path: ['r3', 'issue', 'parent'], message: 'timeout' },
        { type: 'INTERNAL', path: ['r3', 'issue', 'blocking'], message: 'timeout' },
      ],
    }), claimed('a/b#1', 'a/b#2', 'a/b#3', 'a/b#4', 'a/b#5'), { code: 1, stderr: '' })
    expect(batch.outcomes.map((o) => ('error' in o ? o.error : [o.snapshot.hierarchy.status, o.dependencies.status]))).toEqual([
      ['ok', 'unavailable'], ['ok', 'unavailable'], ['ok', 'unavailable'], ['unavailable', 'unavailable'], ['ok', 'ok'],
    ])
    // an unavailable section carries no lists, so it yields no observations
    expect(dependenciesOf(batch, 0)).toEqual({ status: 'unavailable' })
    expect(dependenciesOf(batch, 4)).toEqual(NO_DEPENDENCIES)
  })

  it('validates every listed issue like a child: drops an invalid one (the list is then incomplete), the root itself and duplicates; clips titles; caps at 50', () => {
    const batch = parseIssueBatch(out({
      data: {
        r0: ok('a/b', 1, {
          issueDependenciesSummary: summary(3, 4, 1, 1),
          blockedBy: connection([
            dep(30), dep(1), dep(30), dep(4, { state: 'MAYBE' }),
            dep(20, { title: 'x'.repeat(500), state: 'CLOSED', stateReason: 'COMPLETED' }),
          ]),
          blocking: connection([dep(5, { repository: { nameWithOwner: 'Other/Lib' } })], true),
        }),
        r1: ok('a/b', 9, { issueDependenciesSummary: summary(51, 51, 0, 0), blockedBy: connection(Array.from({ length: 51 }, (_, i) => dep(100 + i))) }),
        // the root itself and a repeat are dropped without making the list incomplete
        r2: ok('a/b', 3, { issueDependenciesSummary: summary(0, 0, 1, 1), blocking: connection([dep(3), dep(8), dep(8)]) }),
        // counts come from the summary alone: an issue the token cannot see is no missing entry
        r3: ok('a/b', 2, { issueDependenciesSummary: summary(2, 3, 0, 0), blockedBy: connection([dep(7)]) }),
      },
    }), claimed('a/b#1', 'a/b#9', 'a/b#3', 'a/b#2'))
    expect(dependenciesOf(batch, 0)).toEqual({
      status: 'ok',
      blocked_by: {
        open: 3, total: 4, truncated: true,
        list: [
          { repo: 'a/b', number: 20, title: `${'x'.repeat(300)}…`, state: 'CLOSED', state_reason: 'COMPLETED' },
          { repo: 'a/b', number: 30, title: 'D30', state: 'OPEN', state_reason: null },
        ],
      },
      blocking: { open: 1, total: 1, truncated: true, list: [{ repo: 'Other/Lib', number: 5, title: 'D5', state: 'OPEN', state_reason: null }] },
    })
    const capped = dependenciesOf(batch, 1)
    expect(capped.status === 'ok' && [capped.blocked_by.truncated, capped.blocked_by.list.map((issue) => issue.number)])
      .toEqual([true, Array.from({ length: 50 }, (_, i) => 100 + i)])
    expect(dependenciesOf(batch, 2)).toMatchObject({ blocking: { truncated: false, list: [{ number: 8 }] } })
    expect(dependenciesOf(batch, 3)).toMatchObject({ blocked_by: { open: 2, total: 3, truncated: false, list: [{ number: 7 }] } })
  })

  it('reads a dependency section it cannot trust as unavailable, never as "no dependencies", and keeps the hierarchy', () => {
    const batch = parseIssueBatch(out({
      data: {
        r0: ok('a/b', 1, { issueDependenciesSummary: summary(2, 1, 0, 0) }),
        r1: ok('a/b', 2, { issueDependenciesSummary: summary(0, 0, -1, 0) }),
        r2: ok('a/b', 3, { issueDependenciesSummary: { ...summary(0, 0, 0, 0), totalBlocking: 0.5 } }),
        r3: ok('a/b', 4, { blocking: undefined }),
        r4: ok('a/b', 5, { blockedBy: null }),
        r5: ok('a/b', 6, { blocking: { totalCount: 0, nodes: [] } }),
        r6: ok('a/b', 7, { blockedBy: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: null } }),
      },
    }), claimed('a/b#1', 'a/b#2', 'a/b#3', 'a/b#4', 'a/b#5', 'a/b#6', 'a/b#7'))
    expect(batch.outcomes.map((o) => ('error' in o ? o.error : o.dependencies))).toEqual(Array(7).fill({ status: 'unavailable' }))
    expect(batch.outcomes.every((o) => 'snapshot' in o && o.snapshot.hierarchy.status === 'ok')).toBe(true)
  })
})

describe('issueQueue: candidates, TTLs and order (§5.4)', () => {
  let dir: string
  let db: Database.Database
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ms(0))
    dir = scratchDir('issue-queue-')
    db = openDb(join(dir, 'inbox.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  const item = (number: number, project = 'p') =>
    insertItem(db, { project, stream: `${number}-x`, agent: 'a', kind: 'question', title: `q${number}`, repo: REPO, issue_ref: number })
  const queue = (nowMs: number) =>
    issueQueue({ entities: listIssueEntities(db), links: listSourceLinks(db), snapshots: listIssueSnapshots(db), nowMs })
  const numbers = (nowMs: number) => queue(nowMs).map((e) => e.number)
  const none = { open: 0, total: 0, truncated: false, list: [] }
  const NO_DEPS: IssueDependencies = { status: 'ok', blocked_by: none, blocking: none }
  // `deps: null` writes a snapshot as a v1.4 viewer leaves it: with no dependency section
  const seed = (number: number, minute: number, opts: {
    state?: 'OPEN' | 'CLOSED'; error?: Parameters<typeof recordIssueFailure>[1]['error']; deps?: IssueDependencies | null
  } = {}) => {
    upsertIssueSnapshot(db, {
      repo: REPO, number, snapshot: snapshot(`${REPO}#${number}`, { issue: { state: opts.state ?? 'OPEN' } }), startedAt: at(minute),
      ...(opts.deps === null ? {} : { dependencies: opts.deps ?? NO_DEPS }),
    })
    if (opts.error) recordIssueFailure(db, { repo: REPO, number, error: opts.error, startedAt: at(minute + 0.001) })
  }

  it('applies the TTL table, including the 10-minute retry of a hard failure', () => {
    const cases: Array<[number, Parameters<typeof seed>[2], number]> = [
      [1, {}, ISSUE_TTL.open],
      [2, { state: 'CLOSED' }, ISSUE_TTL.closed],
      [3, { error: 'offline' }, ISSUE_TTL.soft],
      [4, { error: 'rate-limit' }, ISSUE_TTL.soft],
      [5, { error: 'gh-failed' }, ISSUE_TTL.soft],
      [6, { error: 'no-gh' }, ISSUE_TTL.softSlow],
      [7, { error: 'auth' }, ISSUE_TTL.softSlow],
      [8, { error: 'not-found' }, ISSUE_TTL.hard],
      [9, { error: 'forbidden' }, ISSUE_TTL.hard],
      [10, { error: 'moved' }, ISSUE_TTL.hard],
    ]
    expect([ISSUE_TTL.open, ISSUE_TTL.closed, ISSUE_TTL.soft, ISSUE_TTL.softSlow, ISSUE_TTL.hard])
      .toEqual([10 * MIN, 60 * MIN, 10 * MIN, 60 * MIN, 10 * MIN])
    for (const [number, opts] of cases) {
      item(number)
      seed(number, 0, opts)
    }
    for (const [number, opts, ttl] of cases) {
      const checked = Date.parse(listIssueSnapshots(db).find((r) => r.number === number)!.checked_at)
      expect(numbers(checked + ttl - 1), `#${number} ${JSON.stringify(opts)}`).not.toContain(number)
      expect(numbers(checked + ttl), `#${number} ${JSON.stringify(opts)}`).toContain(number)
    }
  })

  it('a soft failure after a hard one keeps the hard schedule, which is the 10-minute one', () => {
    item(1)
    seed(1, 0, { error: 'not-found' })
    recordIssueFailure(db, { repo: REPO, number: 1, error: 'offline', startedAt: at(5) })
    expect(listIssueSnapshots(db)[0]).toMatchObject({ error: 'not-found', checked_at: at(5) })
    expect(numbers(ms(15) - 1)).toEqual([])
    expect(numbers(ms(15))).toEqual([1])
  })

  it('orders never fetched (by key), then nudged, then oldest checked_at, then key', () => {
    for (const n of [5, 4, 3, 2, 1, 20, 21]) item(n)
    seed(1, 3)
    seed(2, 1)
    seed(3, 1)
    seed(20, 52) // not due, but a merged PR closes it
    seed(21, 52) // not due
    vi.setSystemTime(ms(55))
    upsertSourceLink(db, {
      repo: REPO, branch: 'fix', head_repo: REPO, pr_number: 9, pr_state: 'MERGED', closing_refs: [{ repo: REPO, number: 20 }],
    })
    const q = queue(ms(60))
    expect(q.map((e) => [e.number, e.reason])).toEqual([[4, 'new'], [5, 'new'], [20, 'nudged'], [2, 'due'], [3, 'due'], [1, 'due']])
    expect(q[0]).toEqual({ repo: REPO, number: 4, checked_at: null, reason: 'new' })
    expect(q[3]).toMatchObject({ checked_at: at(1) })
  })

  it('a merged PR nudges its certain closing issue and every candidate listing it, once', () => {
    for (const n of [117, 120, 121]) item(n)
    upsertIssueSnapshot(db, {
      repo: REPO, number: 117, snapshot: snapshot(`${REPO}#117`, { children: [`${REPO}#120`] }), dependencies: NO_DEPS, startedAt: at(1),
    })
    seed(120, 1)
    seed(121, 1)
    vi.setSystemTime(ms(3))
    upsertSourceLink(db, { repo: REPO, branch: '120-x', head_repo: REPO, pr_number: 9, pr_state: 'MERGED', closing_refs: [{ repo: REPO, number: 120 }] })
    // an open PR, or one closing several issues, nudges nothing
    upsertSourceLink(db, { repo: REPO, branch: '121-x', head_repo: REPO, pr_number: 10, pr_state: 'OPEN', closing_refs: [{ repo: REPO, number: 121 }] })
    upsertSourceLink(db, {
      repo: REPO, branch: 'multi', head_repo: REPO, pr_number: 11, pr_state: 'CLOSED',
      closing_refs: [{ repo: REPO, number: 121 }, { repo: REPO, number: 117 }],
    })
    // nor does a legacy row whose closing issue was never proven to be the only one
    upsertSourceLink(db, { repo: REPO, branch: 'legacy', head_repo: REPO, pr_number: 12, pr_state: 'MERGED', issue_number: 121 })
    expect(queue(ms(4)).map((e) => [e.number, e.reason])).toEqual([[117, 'nudged'], [120, 'nudged']])
    // once refreshed after the merge was seen, the nudge is spent
    seed(117, 4)
    seed(120, 4)
    expect(queue(ms(5))).toEqual([])
  })

  // slice 2 §5.4
  it('fetches a readable snapshot without a bound dependency section at once: after new keys, before nudged ones', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) item(n)
    seed(2, 3) // current: not due
    seed(3, 3, { deps: null }) // written before slice 2, or since by an older viewer
    seed(4, 2, { deps: null })
    seed(5, 3, { deps: { status: 'unavailable' } }) // GitHub failed the section: an answer, kept until due
    seed(6, 3, { deps: null, error: 'no-gh' }) // GitHub could not be asked: its own TTL decides
    seed(7, 3)
    recordIssueFailure(db, { repo: REPO, number: 8, error: 'not-found', startedAt: at(3) }) // no snapshot to upgrade
    vi.setSystemTime(ms(4))
    upsertSourceLink(db, { repo: REPO, branch: '7-x', head_repo: REPO, pr_number: 9, pr_state: 'MERGED', closing_refs: [{ repo: REPO, number: 7 }] })
    expect(queue(ms(5)).map((e) => [e.number, e.reason])).toEqual([[1, 'new'], [4, 'upgrade'], [3, 'upgrade'], [7, 'nudged']])
    seed(3, 5)
    seed(4, 5)
    seed(7, 5)
    expect(queue(ms(6))).toEqual([{ repo: REPO, number: 1, checked_at: null, reason: 'new' }])
    expect(numbers(ms(3.001) + ISSUE_TTL.softSlow)).toContain(6)
  })

  it('a settled PR closing one of a key’s open blockers nudges that key, once', () => {
    for (const n of [121, 122, 123]) item(n)
    const blocker = (number: number, state: 'OPEN' | 'CLOSED' = 'OPEN') =>
      ({ ...none, open: state === 'OPEN' ? 1 : 0, total: 1, list: [facts(`${REPO}#${number}`, { state })] })
    seed(121, 1, { deps: { status: 'ok', blocked_by: blocker(119), blocking: none } })
    seed(122, 1, { deps: { status: 'ok', blocked_by: blocker(120, 'CLOSED'), blocking: none } }) // already closed
    seed(123, 1, { deps: { status: 'ok', blocked_by: none, blocking: blocker(119) } }) // a dependent, not a blocker
    vi.setSystemTime(ms(3))
    upsertSourceLink(db, { repo: REPO, branch: '119-x', head_repo: REPO, pr_number: 9, pr_state: 'MERGED', closing_refs: [{ repo: REPO, number: 119 }] })
    upsertSourceLink(db, { repo: REPO, branch: '120-x', head_repo: REPO, pr_number: 10, pr_state: 'CLOSED', closing_refs: [{ repo: REPO, number: 120 }] })
    expect(queue(ms(4)).map((e) => [e.number, e.reason])).toEqual([[121, 'nudged']])
    seed(121, 4, { deps: { status: 'ok', blocked_by: blocker(119, 'CLOSED'), blocking: none } })
    expect(queue(ms(5))).toEqual([])
  })

  it('takes only the refresh set: not closed projects, archived plans or closed items', () => {
    item(1)
    item(2, 'gone')
    closeProject(db, 'gone')
    upsertBoard(db, { project: 'p', stream: '3-x', agent: 'a', title: 'Old plan', rows: [], repo: REPO, issueRef: 3 })
    const old = getBoard(db, 'p', 'Old plan')!
    archiveBoard(db, old.id, old.revision)
    upsertBoard(db, { project: 'p', stream: '4-x', agent: 'a', title: 'Plan', rows: [], repo: REPO, issueRef: 4 })
    expect(numbers(ms(0))).toEqual([1, 4])
  })
})

describe('refreshIssuesOnce (§5.2–5.5)', () => {
  let dir: string
  let db: Database.Database
  let clock: number
  const now = () => clock

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    clock = ms(0)
    vi.setSystemTime(clock)
    dir = scratchDir('issue-poller-')
    db = openDb(join(dir, 'inbox.db'))
  })
  afterEach(() => {
    if (db.open) db.close()
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const item = (number: number, repo = REPO) =>
    insertItem(db, { project: 'p', stream: `${number}-x`, agent: 'a', kind: 'question', title: `q${number}`, repo, issue_ref: number })
  const fetchedNumbers = () => listIssueSnapshots(db).filter((r) => r.snapshot).map((r) => r.number)
  const tick = (minutes = 1) => {
    clock += minutes * MIN
    vi.setSystemTime(clock)
  }
  const world = (...numbers: number[]): World => new Map(numbers.map((n) => [`${REPO}#${n}`, {}]))

  it('fetches a due batch, stores what GitHub said, and /api/issues shows it', async () => {
    item(120)
    const w = world(117, 118, 120)
    w.get(`${REPO}#120`)!.parent = `${REPO}#117`
    w.get(`${REPO}#118`)!.parent = `${REPO}#117`
    const gh = fakeGitHub(w)
    const result = await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget: new IssueBudget(clock) })
    expect(result).toMatchObject({ claimed: 1, applied: 1 })
    expect(gh.calls).toEqual([[`${REPO}#120`]])
    const graph = await (await createViewer(db).request('/api/issues')).json() as {
      roots: Array<{ key: string; error: string | null }>; edges: Array<{ from: string; to: string }>
      nodes: Array<{ key: string; children_total?: number }>
    }
    expect(graph.roots).toEqual([expect.objectContaining({ key: `${REPO}#120`, error: null, fetched_at: at(0) })])
    expect(graph.edges).toEqual([expect.objectContaining({ from: `${REPO}#117`, to: `${REPO}#120` })])
    expect(graph.nodes.find((n) => n.key === `${REPO}#117`)).toMatchObject({ children_total: 2 })
  })

  it('stores each root’s dependency section with its snapshot, bound to that fetch (slice 2 §5.3)', async () => {
    item(121)
    const w = world(119, 120, 121, 122)
    w.get(`${REPO}#120`)!.state = 'CLOSED'
    w.get(`${REPO}#121`)!.blockedBy = [`${REPO}#120`, `${REPO}#119`]
    w.get(`${REPO}#122`)!.blockedBy = [`${REPO}#121`]
    await refreshIssuesOnce(db, { run: fakeGitHub(w).run, now, owner: 'v1', budget: new IssueBudget(clock) })
    const issue = (n: number, state: 'OPEN' | 'CLOSED' = 'OPEN') =>
      facts(`${REPO}#${n}`, { state, state_reason: state === 'CLOSED' ? 'COMPLETED' : null })
    expect(listIssueSnapshots(db)).toEqual([expect.objectContaining({
      number: 121, fetched_at: at(0),
      dependencies: {
        status: 'ok',
        blocked_by: { open: 1, total: 2, truncated: false, list: [issue(119), issue(120, 'CLOSED')] },
        blocking: { open: 1, total: 1, truncated: false, list: [issue(122)] },
      },
    })])
  })

  it('soft failures keep data, hard failures suppress it at once (a partial batch, per alias)', async () => {
    item(1)
    item(2)
    await refreshIssuesOnce(db, { run: fakeGitHub(world(1, 2)).run, now, owner: 'v1', budget: new IssueBudget(clock) })
    expect(fetchedNumbers()).toEqual([1, 2])
    tick(10)
    const run: IssueGhRun = () => ({
      stdout: JSON.stringify({
        data: { r0: null, r1: null, rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-10-19T23:59:00Z' } },
        errors: [{ type: 'RATE_LIMITED', path: ['r0'] }, { type: 'NOT_FOUND', path: ['r1'] }],
      }),
      stderr: '', code: 1,
    })
    await refreshIssuesOnce(db, { run, now, owner: 'v1', budget: new IssueBudget(clock) })
    expect(listIssueSnapshots(db).map((r) => [r.number, r.error, r.snapshot !== null, r.checked_at])).toEqual([
      [1, 'rate-limit', true, at(10)], [2, 'not-found', false, at(10)],
    ])
  })

  it('fetches all 120 due candidates within 12 runs when nothing new arrives (acceptance 1)', async () => {
    for (let n = 1; n <= 120; n++) item(n)
    const gh = fakeGitHub(world(...Array.from({ length: 120 }, (_, i) => i + 1)))
    const budget = new IssueBudget(clock)
    for (let run = 0; run < 12; run++) {
      await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })
      tick()
    }
    expect(gh.calls.every((c) => c.length === ISSUE_BATCH)).toBe(true)
    expect(new Set(gh.calls.flat()).size).toBe(120)
    expect(fetchedNumbers()).toHaveLength(120)

    // all due again later: the oldest are served first, so ages stay bounded
    tick(10)
    for (let run = 0; run < 12; run++) {
      await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })
      tick()
    }
    expect(new Set(gh.calls.slice(12).flat()).size).toBe(120)
  })

  it('while arrivals exceed a batch per run, older keys wait and age; they are served when the burst ends', async () => {
    for (let n = 1; n <= 20; n++) item(n)
    const all = world(...Array.from({ length: 200 }, (_, i) => i + 1))
    const gh = fakeGitHub(all)
    const budget = new IssueBudget(clock)
    await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })
    tick()
    await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })
    expect(fetchedNumbers()).toHaveLength(20)
    tick(10) // all twenty due again
    const ageOf = (n: number) => clock - Date.parse(listIssueSnapshots(db).find((r) => r.number === n)!.checked_at)
    let next = 100
    for (let run = 0; run < 5; run++) {
      for (let i = 0; i < 11; i++) item(next++) // a burst: more new links than one batch
      const before = ageOf(1)
      await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })
      expect(gh.calls.at(-1)!.every((k) => split(k).number >= 100)).toBe(true)
      tick()
      expect(ageOf(1)).toBeGreaterThan(before)
    }
    // the burst ends: the new stragglers first, then every older key, in turn
    for (let run = 0; run < 4; run++) {
      await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })
      tick()
    }
    for (let n = 1; n <= 20; n++) expect(ageOf(n), `#${n}`).toBeLessThan(10 * MIN)
  })

  it('two viewers on one hub never fetch the same key at once', async () => {
    for (let n = 1; n <= 15; n++) item(n)
    const gh = fakeGitHub(world(...Array.from({ length: 15 }, (_, i) => i + 1)))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow: IssueGhRun = async (args) => { await gate; return gh.run(args) }
    const first = refreshIssuesOnce(db, { run: slow, now, owner: 'viewer-a', budget: new IssueBudget(clock) })
    const second = await refreshIssuesOnce(db, { run: gh.run, now, owner: 'viewer-b', budget: new IssueBudget(clock) })
    release()
    await first
    // b ran while a was still waiting on GitHub, so b's call was recorded first
    const [b, a] = [gh.calls[0]!, gh.calls[1]!]
    expect(second).toMatchObject({ claimed: 5 })
    expect(a.filter((k) => b.includes(k))).toEqual([])
    expect(new Set([...a, ...b]).size).toBe(15)
  })

  it('spends the reported cost from a 120-point hourly bucket (cost 1, then cost 3)', () => {
    const budget = new IssueBudget(clock)
    for (let i = 0; i < ISSUE_POINTS_PER_HOUR; i++) {
      expect(budget.check(clock)).toBe('go')
      budget.spend(clock, { cost: 1, remaining: 4_000, resetAt: '2026-10-19T23:59:00Z' }, false)
    }
    expect(budget.check(clock)).toBe('wait')
    expect(budget.check(clock + 30_000)).toBe('go') // 120 an hour: one point every 30 s
    budget.spend(clock + 30_000, { cost: 3, remaining: 4_000, resetAt: '2026-10-19T23:59:00Z' }, false)
    // the next call needs the last reported cost, 3 points: 90 s of refill from empty-ish
    expect(budget.check(clock + 30_000 + 89_000)).toBe('wait')
    expect(budget.check(clock + 30_000 + 90_000 + 90_000)).toBe('go')
    // a call that reports nothing is charged the last reported cost
    const quiet = new IssueBudget(clock)
    quiet.spend(clock, { cost: 3, remaining: 4_000, resetAt: '2026-10-19T23:59:00Z' }, false)
    for (let i = 0; i < 39; i++) quiet.spend(clock, null, false)
    expect(quiet.check(clock)).toBe('wait')
  })

  it('waits for the bucket without calling gh, and records nothing', async () => {
    item(1)
    const gh = fakeGitHub(world(1), { cost: ISSUE_POINTS_PER_HOUR + 1, remaining: 4_000, resetAt: '2026-10-19T23:59:00Z' })
    const budget = new IssueBudget(clock)
    await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })
    tick(10)
    expect(await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })).toMatchObject({ skipped: 'budget' })
    expect(gh.calls).toHaveLength(1)
  })

  it('below the floor, waits until resetAt and records a soft rate-limit meanwhile', async () => {
    item(1)
    item(2)
    const resetAt = new Date(clock + 20 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const gh = fakeGitHub(world(1, 2), { cost: 1, remaining: RATE_FLOOR - 1, resetAt })
    const budget = new IssueBudget(clock)
    await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })
    expect(fetchedNumbers()).toEqual([1, 2])
    tick(10)
    expect(await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget })).toMatchObject({ skipped: 'floor' })
    expect(gh.calls).toHaveLength(1)
    expect(listIssueSnapshots(db).map((r) => [r.number, r.error, r.snapshot !== null])).toEqual([[1, 'rate-limit', true], [2, 'rate-limit', true]])
    tick(10) // resetAt
    expect(budget.check(clock - 1)).toBe('floor')
    expect(budget.check(clock)).toBe('go')
    // a resetAt GitHub never should send cannot park the class for more than an hour
    const odd = new IssueBudget(clock)
    odd.spend(clock, { cost: 1, remaining: 0, resetAt: '2099-01-01T00:00:00Z' }, false)
    expect(odd.check(clock + 60 * MIN)).toBe('go')
  })

  it('backs off for ten minutes after a rate-limited request that reported no budget', () => {
    const budget = new IssueBudget(clock)
    budget.spend(clock, null, true)
    expect(budget.check(clock + 10 * MIN - 1)).toBe('floor')
    expect(budget.check(clock + 10 * MIN)).toBe('go')
  })

  it('starts no gh call after its deadline', async () => {
    item(1)
    const gh = fakeGitHub(world(1))
    expect(await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget: new IssueBudget(clock), deadlineMs: clock - 1 }))
      .toMatchObject({ skipped: 'deadline' })
    expect(gh.calls).toEqual([])
  })

  it('never rejects: a throwing or rejecting gh, garbage output, or a closed hub', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    item(1)
    const budget = new IssueBudget(clock)
    await expect(refreshIssuesOnce(db, { run: () => { throw new Error('sync boom') }, now, owner: 'v1', budget })).resolves.toBeDefined()
    expect(listIssueSnapshots(db)).toEqual([expect.objectContaining({ error: 'gh-failed' })])
    tick(10)
    await expect(refreshIssuesOnce(db, { run: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, now, owner: 'v1', budget }))
      .resolves.toBeDefined()
    expect(listIssueSnapshots(db)).toEqual([expect.objectContaining({ error: 'no-gh' })])
    tick(60)
    await expect(refreshIssuesOnce(db, { run: () => ({ stdout: '\u0000garbage', stderr: '', code: 0 }), now, owner: 'v1', budget })).resolves.toBeDefined()
    db.close()
    await expect(refreshIssuesOnce(db, { run: fakeGitHub(world(1)).run, now, owner: 'v1', budget })).resolves.toMatchObject({ failed: true })
  })

  // §4.2: until PR1b, a PR link without closing_refs made its entity's identity
  // uncertain, so items on a branch with a PR fell out of both key sets.
  it('a PR link with closing_refs makes its entity a candidate again, as §4.2 intends', async () => {
    item(120)
    const legacy = { repo: REPO, branch: '120-x', head_repo: REPO, pr_number: 9, pr_state: 'OPEN', issue_number: 117 }
    upsertSourceLink(db, legacy)
    const gh = fakeGitHub(world(117, 120))
    await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget: new IssueBudget(clock) })
    expect(gh.calls).toEqual([]) // shadowed by an uncertain PR identity
    tick()
    upsertSourceLink(db, { ...legacy, closing_refs: [] })
    await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget: new IssueBudget(clock) })
    expect(gh.calls.at(-1)).toEqual([`${REPO}#120`]) // closes nothing: the branch issue
    tick()
    upsertSourceLink(db, { ...legacy, closing_refs: [{ repo: REPO, number: 117 }] })
    await refreshIssuesOnce(db, { run: gh.run, now, owner: 'v1', budget: new IssueBudget(clock) })
    expect(gh.calls.at(-1)).toEqual([`${REPO}#117`]) // closes exactly one: that issue
    const graph = await (await createViewer(db).request('/api/issues')).json() as { roots: Array<{ key: string }> }
    expect(graph.roots.map((r) => r.key)).toEqual([`${REPO}#117`])
  })
})

describe('startGithubPoller: one tick, issues first (§5.2)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the issue class before the PR class in every tick, and never overlaps ticks', async () => {
    vi.useFakeTimers()
    const dir = scratchDir('issue-tick-')
    const db = openDb(join(dir, 'inbox.db'))
    insertItem(db, { project: 'p', stream: '30-x', agent: 'a', kind: 'question', title: 'q', repo: 'o/n', issue_ref: 30 })
    const order: string[] = []
    let releasePr!: () => void
    const poller = startGithubPoller(db, {
      intervalMs: 1_000,
      issueRun: (args) => { order.push('issues'); return fakeGitHub(new Map([['o/n#30', {}]])).run(args) },
      run: () => new Promise<string>((resolve) => { order.push('prs'); releasePr = () => resolve('[]') }),
      runApi: () => '[]',
    })
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      expect(order).toEqual(['issues', 'prs'])
      await vi.advanceTimersByTimeAsync(5_000) // the PR class is still in flight: no second tick
      expect(order).toEqual(['issues', 'prs'])
      releasePr()
      await vi.advanceTimersByTimeAsync(1_000)
    } finally {
      poller.stop()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// keep the fixture helpers honest: the fake answers what the real document asks
describe('the fake GitHub', () => {
  it('reads back the keys a real argv asks for', () => {
    expect(asked(relationsArgs([{ repo: 'a/b', number: 1 }, { repo: 'c/d', number: 2 }]))).toEqual(['a/b#1', 'c/d#2'])
  })
})


// PR1b review hardening: a snapshot the store refuses is downgraded to a soft
// gh-failed, which is visible ONCE, on stderr, by key and never by title.
describe('invalidSnapshotNotice', () => {
  it('says it once per poller, naming keys and never titles', () => {
    const lines: string[] = []
    const notice = invalidSnapshotNotice((line) => lines.push(line))
    notice([])
    expect(lines).toEqual([])
    notice(['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4', 'o/r#5', 'o/r#6', 'o/r#7'])
    notice(['o/r#8'])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[agent-inbox\] 7 GitHub issue snapshot\(s\) failed validation and were recorded as gh-failed: o\/r#1, o\/r#2, o\/r#3, o\/r#4, o\/r#5, and 2 more\./)
    expect(lines[0]).not.toContain('o/r#8')
  })

  it('the viewer poller writes it to stderr, never stdout', () => {
    const src = readFileSync(new URL('../src/issue-poller.ts', import.meta.url), 'utf8')
    expect(src).toContain('const onInvalid = invalidSnapshotNotice((line) => console.error(line))')
    expect(src).toMatch(/refreshIssuesOnce\(db, \{[^}]*onInvalid \}\)/)
    expect(src).not.toMatch(/console\.log|process\.stdout/)
    // the store reports through the caller and never logs itself (it is in the stdio graph)
    expect(readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')).not.toMatch(/console\.(log|error|warn)/)
  })
})
