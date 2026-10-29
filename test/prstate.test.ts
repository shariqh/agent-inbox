import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import type Database from 'better-sqlite3'
import {
  openDb,
  insertItem,
  resolveItem,
  upsertBoard,
  upsertSourceLink,
  recordLinkFailure,
  listSourceLinks,
  listLinkTargets,
  closeProject,
  reopenProject,
} from '../src/store.js'
import type { LinkTarget, SourceLink } from '../src/store.js'
import { issueKeyFor } from '../public/issue-key.js'
import {
  classifyChecks,
  classifyError,
  firstLine,
  parsePrPayload,
  dueTargets,
  refreshOnce,
  resolveGh,
  TTL,
  MAX_PER_TICK,
  PR_WINDOW,
} from '../src/prstate.js'
import { scratchDir } from './scratch.js'

const REPO = new URL('..', import.meta.url).pathname

function freshDb(): Database.Database {
  return openDb(join(scratchDir('prstate-'), 'inbox.db'))
}

// the shape `gh pr list --json …` actually emits (verified live against cli/cli),
// including the head identity issue #157 verifies against the expected head
function ghPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    number: 41,
    title: 'source + PR links',
    url: 'https://github.com/shariqh/agent-inbox/pull/41',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'test' }],
    closingIssuesReferences: [{
      id: 'I_30', number: 30, url: 'https://github.com/shariqh/agent-inbox/issues/30',
      repository: { id: 'R_1', name: 'agent-inbox', owner: { id: 'U_1', login: 'shariqh' } },
    }],
    body: 'Links the inbox to its source issue and PR.',
    updatedAt: '2026-07-26T10:00:00Z',
    isCrossRepository: false,
    headRepository: { id: 'R_1', name: 'agent-inbox', nameWithOwner: 'shariqh/agent-inbox' },
    headRepositoryOwner: { id: 'U_1', login: 'shariqh' },
    ...over,
  }])
}

// a branch pushed to the repository its PRs are opened against
const SAME = { repo: 'shariqh/agent-inbox', head_repo: 'shariqh/agent-inbox' }

describe('classifyChecks', () => {
  const run = (conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun', status, conclusion })

  it('a single FAILURE beats a hundred successes', () => {
    const rollup = [...Array(100).fill(run('SUCCESS')), run('FAILURE')]
    expect(classifyChecks(rollup)).toBe('failing')
  })

  // Each conclusion pinned BY NAME. Narrowing FAILING_CONCLUSIONS to ['FAILURE']
  // alone left all 43 tests in this file green, and under that mutation a rollup
  // of [SUCCESS, TIMED_OUT] classified as `passing` — a green chip on a red PR.
  it('every failing conclusion GitHub reports is red, not just FAILURE', () => {
    for (const conclusion of ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']) {
      expect(classifyChecks([run(conclusion)]), conclusion).toBe('failing')
      // and worst-first still holds beside a green job
      expect(classifyChecks([run('SUCCESS'), run(conclusion)]), `${conclusion} beside a SUCCESS`).toBe('failing')
    }
  })

  it('IN_PROGRESS with no failure is pending', () => {
    expect(classifyChecks([run('SUCCESS'), run('', 'IN_PROGRESS')])).toBe('pending')
    expect(classifyChecks([run('', 'QUEUED')])).toBe('pending')
  })

  // a skipped job is not a red job — counting it as failure would paint every
  // repo with conditional workflows permanently red
  it('an all-SKIPPED rollup is none, not passing and not failing', () => {
    expect(classifyChecks([run('SKIPPED'), run('NEUTRAL'), run('CANCELLED')])).toBe('none')
  })

  it('an empty, absent or malformed rollup is none', () => {
    expect(classifyChecks([])).toBe('none')
    expect(classifyChecks(null)).toBe('none')
    expect(classifyChecks(undefined)).toBe('none')
    expect(classifyChecks('nonsense')).toBe('none')
  })

  // the legacy commit-status side of the rollup, every branch of it named: ERROR
  // and EXPECTED were as unpinned as the four conclusions above
  it('reads StatusContext state as well as CheckRun conclusion', () => {
    expect(classifyChecks([{ __typename: 'StatusContext', state: 'FAILURE' }])).toBe('failing')
    expect(classifyChecks([{ __typename: 'StatusContext', state: 'ERROR' }])).toBe('failing')
    expect(classifyChecks([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('pending')
    expect(classifyChecks([{ __typename: 'StatusContext', state: 'EXPECTED' }])).toBe('pending')
    expect(classifyChecks([{ __typename: 'StatusContext', state: 'SUCCESS' }])).toBe('passing')
  })

  it('a mixed rollup reports the worst thing in it', () => {
    expect(classifyChecks([{ __typename: 'StatusContext', state: 'SUCCESS' }, run('FAILURE')])).toBe('failing')
    expect(classifyChecks([run('SUCCESS'), run('SKIPPED')])).toBe('passing')
  })
})

describe('firstLine (the TL;DR)', () => {
  it('takes the first non-empty body line and strips markdown markers', () => {
    expect(firstLine('\n\n# What it does\n\nmore text')).toBe('What it does')
    expect(firstLine('> quoted opener\nrest')).toBe('quoted opener')
    expect(firstLine('- a bullet\n- another')).toBe('a bullet')
    expect(firstLine('* starred\n')).toBe('starred')
    // ** is emphasis, not a bullet — only a marker followed by space is stripped
    expect(firstLine('**bold opener**')).toBe('**bold opener**')
  })

  it('collapses whitespace and truncates at 240 with an ellipsis', () => {
    expect(firstLine('a   \t b')).toBe('a b')
    const long = firstLine('x'.repeat(400))
    expect(long.length).toBeLessThanOrEqual(241)
    expect(long.endsWith('…')).toBe(true)
  })

  it('returns empty string for an empty, whitespace or absent body', () => {
    expect(firstLine('')).toBe('')
    expect(firstLine('   \n\n  ')).toBe('')
    expect(firstLine(null)).toBe('')
    expect(firstLine(undefined)).toBe('')
  })
})

describe('parsePrPayload', () => {
  it('reads number/title/url/state/isDraft/reviewDecision off gh pr list output', () => {
    const pr = parsePrPayload(ghPayload(), SAME)!
    expect(pr.pr_number).toBe(41)
    expect(pr.pr_title).toBe('source + PR links')
    expect(pr.pr_url).toBe('https://github.com/shariqh/agent-inbox/pull/41')
    expect(pr.pr_state).toBe('OPEN')
    expect(pr.pr_draft).toBe(false)
    expect(pr.review_decision).toBe('REVIEW_REQUIRED')
    expect(pr.checks).toBe('passing')
    expect(pr.tldr).toBe('Links the inbox to its source issue and PR.')
  })

  it('carries the authoritative issue from closingIssuesReferences', () => {
    const pr = parsePrPayload(ghPayload(), SAME)!
    expect(pr.issue_number).toBe(30)
    expect(pr.issue_url).toBe('https://github.com/shariqh/agent-inbox/issues/30')
  })

  it('leaves the issue null when the PR closes nothing', () => {
    const pr = parsePrPayload(ghPayload({ closingIssuesReferences: [] }), SAME)!
    expect(pr.issue_number).toBeNull()
    expect(pr.issue_url).toBeNull()
  })

  // issue #103 PR1b: every reference, so a PR that closes several is never guessed
  it('records every closing reference with its repository, in GitHub\'s order', () => {
    const pr = parsePrPayload(ghPayload({
      closingIssuesReferences: [
        { number: 30, url: 'u', repository: { name: 'agent-inbox', owner: { login: 'shariqh' } } },
        { number: 7, url: 'u', repository: { name: 'Lib', owner: { login: 'Other' } } },
      ],
    }), SAME)!
    expect(pr.closing_refs).toEqual([{ repo: 'shariqh/agent-inbox', number: 30 }, { repo: 'Other/Lib', number: 7 }])
    // the #30 chip still reads its first reference
    expect(pr.issue_number).toBe(30)
  })

  it('records a PR that closes nothing as an empty list, and an unreadable list as no record at all', () => {
    expect(parsePrPayload(ghPayload({ closingIssuesReferences: [] }), SAME)!.closing_refs).toEqual([])
    expect(parsePrPayload(ghPayload({ closingIssuesReferences: undefined }), SAME)!.closing_refs).toBeNull()
    // dropping only the bad reference could turn two into one, a false certainty
    for (const bad of [
      { number: 7, url: 'u' },
      { number: 7, repository: { name: '..', owner: { login: 'x' } } },
      { number: 0, repository: { name: 'lib', owner: { login: 'x' } } },
      { number: '7', repository: { name: 'lib', owner: { login: 'x' } } },
    ]) {
      const refs = [{ number: 30, repository: { name: 'agent-inbox', owner: { login: 'shariqh' } } }, bad]
      expect(parsePrPayload(ghPayload({ closingIssuesReferences: refs }), SAME)!.closing_refs).toBeNull()
    }
  })

  it('returns null for the empty array gh emits when there is no PR, and for junk', () => {
    expect(parsePrPayload('[]', SAME)).toBeNull()
    expect(parsePrPayload('not json', SAME)).toBeNull()
    expect(parsePrPayload('{}', SAME)).toBeNull()
    expect(parsePrPayload('[{"title":"no number"}]', SAME)).toBeNull()
  })

  it('truncates an absurdly long PR title rather than storing it whole', () => {
    const pr = parsePrPayload(ghPayload({ title: 'y'.repeat(900) }), SAME)!
    expect(pr.pr_title!.length).toBeLessThanOrEqual(301)
  })

  it('reads draft and merged state', () => {
    expect(parsePrPayload(ghPayload({ isDraft: true }), SAME)!.pr_draft).toBe(true)
    expect(parsePrPayload(ghPayload({ state: 'MERGED' }), SAME)!.pr_state).toBe('MERGED')
  })
})

describe('classifyError', () => {
  it('names the failure modes the TTL policy branches on', () => {
    expect(classifyError('ENOENT', '')).toBe('no-gh')
    expect(classifyError(1, 'gh auth login required')).toBe('auth')
    expect(classifyError(1, 'You have exceeded a secondary rate limit')).toBe('rate-limit')
    expect(classifyError(1, 'dial tcp: lookup api.github.com: no such host')).toBe('offline')
    expect(classifyError(1, 'could not resolve to a Repository')).toBe('gh-failed')
    expect(classifyError(undefined, '')).toBe('gh-failed')
  })
})

describe('dueTargets (TTL policy)', () => {
  const T0 = Date.parse('2026-07-26T12:00:00.000Z')
  const target = (branch: string): LinkTarget => ({ repo: 'o/n', branch, head_repo: 'o/n' })
  const link = (branch: string, over: Partial<SourceLink> = {}): SourceLink => ({
    repo: 'o/n', branch, head_repo: 'o/n', provider: 'github',
    pr_number: 41, pr_url: null, pr_title: null, pr_state: 'OPEN', pr_draft: false,
    pr_head_sha: null, preview_url: null, preview_environment: null, preview_deployment_id: null,
    preview_updated_at: null, preview_error: null, revision: 1,
    review_decision: null, checks: null, issue_number: null, issue_url: null, issue_title: null, closing_refs: null,
    tldr: null, fetched_at: new Date(T0).toISOString(), checked_at: new Date(T0).toISOString(), error: null,
    ...over,
  })
  const at = (ms: number) => new Date(T0 + ms).toISOString()

  it('a branch with no cache row at all is due immediately', () => {
    expect(dueTargets([target('a')], [], T0)).toEqual([target('a')])
  })

  it('an open PR is rechecked every five minutes, a merged one hourly', () => {
    const open = [link('a', { checked_at: at(-TTL.openPr - 1) })]
    expect(dueTargets([target('a')], open, T0)).toHaveLength(1)
    const openFresh = [link('a', { checked_at: at(-TTL.openPr + 1000) })]
    expect(dueTargets([target('a')], openFresh, T0)).toHaveLength(0)

    const merged = [link('a', { pr_state: 'MERGED', checked_at: at(-TTL.openPr - 1) })]
    expect(dueTargets([target('a')], merged, T0)).toHaveLength(0)
    const mergedStale = [link('a', { pr_state: 'MERGED', checked_at: at(-TTL.settled - 1) })]
    expect(dueTargets([target('a')], mergedStale, T0)).toHaveLength(1)
  })

  it('a branch with no PR is rechecked on the middle cadence', () => {
    const noPr = [link('a', { pr_number: null, pr_state: null, checked_at: at(-TTL.openPr - 1) })]
    expect(dueTargets([target('a')], noPr, T0)).toHaveLength(0)
    const stale = [link('a', { pr_number: null, pr_state: null, checked_at: at(-TTL.noPr - 1) })]
    expect(dueTargets([target('a')], stale, T0)).toHaveLength(1)
  })

  // a machine with no gh installed must not retry every minute forever
  it('a no-gh or auth failure backs off to an hour; a transient one to ten minutes', () => {
    const hard = [link('a', { error: 'no-gh', checked_at: at(-TTL.errorSoft - 1) })]
    expect(dueTargets([target('a')], hard, T0)).toHaveLength(0)
    const hardStale = [link('a', { error: 'no-gh', checked_at: at(-TTL.errorHard - 1) })]
    expect(dueTargets([target('a')], hardStale, T0)).toHaveLength(1)
    const soft = [link('a', { error: 'offline', checked_at: at(-TTL.errorSoft - 1) })]
    expect(dueTargets([target('a')], soft, T0)).toHaveLength(1)
  })

  it('orders the oldest check first so nothing starves behind a busy branch', () => {
    const links = [
      link('new', { checked_at: at(-TTL.openPr - 1000) }),
      link('old', { checked_at: at(-TTL.openPr - 900_000) }),
    ]
    expect(dueTargets([target('new'), target('old')], links, T0).map((t) => t.branch)).toEqual(['old', 'new'])
    // and a never-fetched branch outranks both
    expect(dueTargets([target('new'), target('never'), target('old')], links, T0)[0]!.branch).toBe('never')
  })
})

describe('refreshOnce', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const seedItem = (branch: string, title = 'q') =>
    insertItem(db, { project: 'p', stream: branch, agent: 'a', kind: 'question', title, repo: 'o/n', issue_ref: 30 })

  it('fetches the due branches and caches what gh returned', async () => {
    seedItem('30-x')
    const calls: string[] = []
    await refreshOnce(db, { run: async (repo, branch) => { calls.push(`${repo}#${branch}`); return ghPayload() } })
    expect(calls).toEqual(['o/n#30-x'])
    const link = listSourceLinks(db)[0]!
    expect(link.pr_number).toBe(41)
    expect(link.checks).toBe('passing')
    expect(link.tldr).toBe('Links the inbox to its source issue and PR.')
    expect(link.error).toBeNull()
  })

  it('never runs gh twice for two items on the same branch', async () => {
    seedItem('30-x', 'q1')
    seedItem('30-x', 'q2')
    let calls = 0
    await refreshOnce(db, { run: async () => { calls++; return ghPayload() } })
    expect(calls).toBe(1)
  })

  it('fetches at most `max` due branches per tick', async () => {
    for (let i = 0; i < 10; i++) seedItem(`br-${i}`, `q${i}`)
    let calls = 0
    await refreshOnce(db, { run: async () => { calls++; return '[]' }, max: 3 })
    expect(calls).toBe(3)
    expect(MAX_PER_TICK).toBeGreaterThan(0)
  })

  it('stores every closing reference bound to the fetched_at it wrote (issue #103)', async () => {
    seedItem('30-x')
    await refreshOnce(db, {
      run: async () => ghPayload({
        closingIssuesReferences: [
          { number: 30, repository: { name: 'n', owner: { login: 'o' } } },
          { number: 31, repository: { name: 'n', owner: { login: 'o' } } },
        ],
      }),
    })
    const link = listSourceLinks(db)[0]!
    expect(JSON.parse(link.closing_refs!)).toEqual({
      fetched_at: link.fetched_at, refs: [{ repo: 'o/n', number: 30 }, { repo: 'o/n', number: 31 }],
    })
    // several references: never a certain PR identity; the branch issue decides
    expect(issueKeyFor({ repo: 'o/n', issue_ref: 30 }, link)).toEqual({ key: 'o/n#30', source: 'branch', certain: true })
  })

  it('starts no new target after deadlineMs, but finishes the one in flight', async () => {
    for (let i = 0; i < 4; i++) seedItem(`br-${i}`, `q${i}`)
    let clock = 1_000
    const calls: string[] = []
    const done = await refreshOnce(db, {
      now: () => clock,
      deadlineMs: 46_000,
      run: async (_r, branch) => { calls.push(branch); clock += 30_000; return '[]' },
    })
    // t=1s starts br-0; t=31s starts br-1; t=61s is past the deadline
    expect(calls).toHaveLength(2)
    expect(done).toBe(2)
  })

  it('caches "there is no PR" as a real answer, not as an error', async () => {
    seedItem('30-x')
    await refreshOnce(db, { run: async () => '[]' })
    const link = listSourceLinks(db)[0]!
    expect(link.pr_number).toBeNull()
    expect(link.error).toBeNull()
    expect(link.fetched_at).not.toBeNull()
  })

  it('a gh failure records the error and leaves the previous good PR state intact', async () => {
    seedItem('30-x')
    await refreshOnce(db, { run: async () => ghPayload({ state: 'MERGED' }) })
    await refreshOnce(db, {
      run: async () => { const e = new Error('boom') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e },
      nowMs: Date.now() + TTL.settled + 1000,
    })
    const link = listSourceLinks(db)[0]!
    expect(link.pr_state).toBe('MERGED') // still the last good answer
    expect(link.pr_number).toBe(41)
    expect(link.error).toBe('no-gh')
  })

  it('a branch whose item was resolved stops being refreshed but keeps its last cached state', async () => {
    const id = seedItem('30-x')
    await refreshOnce(db, { run: async () => ghPayload() })
    resolveItem(db, id)
    expect(listLinkTargets(db)).toHaveLength(0)
    let calls = 0
    await refreshOnce(db, { run: async () => { calls++; return '[]' }, nowMs: Date.now() + 86_400_000 })
    expect(calls).toBe(0)
    expect(listSourceLinks(db)[0]!.pr_number).toBe(41) // the cache row survives
  })

  // #32 × #30. Retiring a project has to stop the NETWORK work too: before this,
  // a closed project kept spawning `gh pr list` every 60s and kept consuming the
  // shared MAX_PER_TICK budget, diluting the refresh rate for projects still in
  // use. Nobody owned the seam — #30 predates #32's table.
  it('spends no gh call on a CLOSED project, and resumes the moment it reopens', async () => {
    seedItem('30-x')
    closeProject(db, 'p')
    let calls = 0
    const run = async (): Promise<string> => { calls++; return ghPayload() }
    await refreshOnce(db, { run })
    expect(calls).toBe(0)
    expect(listSourceLinks(db)).toHaveLength(0)
    reopenProject(db, 'p')
    await refreshOnce(db, { run })
    expect(calls).toBe(1)
  })

  // the reopen that matters most is the DERIVED one — the agent flags again and
  // the project un-closes itself, with nobody writing a row
  it('resumes polling a project a new flag implicitly reopened', async () => {
    seedItem('30-x')
    closeProject(db, 'p')
    await new Promise((r) => setTimeout(r, 5)) // created_at must land AFTER closed_at
    seedItem('30-y', 'raised after the close')
    const calls: string[] = []
    await refreshOnce(db, { run: async (_r, branch) => { calls.push(branch); return ghPayload() } })
    expect(calls.sort()).toEqual(['30-x', '30-y'])
  })

  // a closed project must not drag a live one's branch down with it
  it('keeps a branch a closed project SHARES with a live one', async () => {
    seedItem('shared')
    insertItem(db, { project: 'live', stream: 'shared', agent: 'a', kind: 'question', title: 'q', repo: 'o/n', issue_ref: 30 })
    closeProject(db, 'p')
    const calls: string[] = []
    await refreshOnce(db, { run: async (_r, branch) => { calls.push(branch); return ghPayload() } })
    expect(calls).toEqual(['shared'])
  })

  it('refreshes a branch an ACTIVE board sits on, not only items', async () => {
    upsertBoard(db, { project: 'p', stream: 'board-br', agent: 'a', title: 'cov', rows: [{ label: 'a', status: 'tracked' }], repo: 'o/n', issueRef: 2 })
    const calls: string[] = []
    await refreshOnce(db, { run: async (_r, branch) => { calls.push(branch); return ghPayload() } })
    expect(calls).toEqual(['board-br'])
  })

  // Node 24 defaults to --unhandled-rejections=throw: an escaping rejection from
  // a background PR fetcher would kill the whole viewer (and, in Electron, the
  // whole app). A PR title is never worth the human's inbox.
  it('resolves rather than rejecting when the fetcher throws synchronously', async () => {
    seedItem('30-x')
    await expect(refreshOnce(db, { run: () => { throw new Error('sync boom') } })).resolves.toBeDefined()
    expect(listSourceLinks(db)[0]!.error).toBeTruthy()
  })

  it('resolves rather than rejecting when the db itself is unusable', async () => {
    const broken = freshDb()
    broken.close()
    await expect(refreshOnce(broken, { run: async () => ghPayload() })).resolves.toBeDefined()
  })
})

// ── issue #157: a PR counts only when its HEAD repository is the expected one ──
// `gh pr list -R <base> --head <branch>` filters on the head branch NAME across
// every fork (`--head owner:branch` is not supported), so a stranger's fork PR
// from a same-named branch used to be cached as this branch's PR — chip, title,
// TL;DR and the closing issue that overrides the item's own issue.
describe('head repository verification (issue #157)', () => {
  const BASE = 'upstream/x'
  const SHA = 'c'.repeat(40)
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  // one PR the way `gh pr list --json` lists it, opened from the `head` repository
  const prFrom = (head: string, number: number, over: Record<string, unknown> = {}) => ({
    number,
    title: `PR ${number} from ${head}`,
    url: `https://github.com/${BASE}/pull/${number}`,
    state: 'OPEN',
    headRefOid: SHA,
    isCrossRepository: head.toLowerCase() !== BASE,
    headRepository: { id: `R_${number}`, name: head.split('/')[1], nameWithOwner: head },
    headRepositoryOwner: { id: `U_${number}`, login: head.split('/')[0] },
    closingIssuesReferences: [{ number: number + 1000, url: `https://github.com/${BASE}/issues/${number + 1000}` }],
    body: `body of ${number}`,
    ...over,
  })
  const list = (...prs: object[]): string => JSON.stringify(prs)
  const seed = (branch: string, head_repo?: string) => insertItem(db, {
    project: 'p', stream: branch, agent: 'a', kind: 'question', title: `q ${branch} ${String(head_repo)}`, repo: BASE, head_repo,
  })
  const rowFor = (head: string) => listSourceLinks(db).find((l) => l.head_repo === head)
  const api = (endpoint: string): string => JSON.stringify(endpoint.includes('/statuses')
    ? [{ state: 'success', environment_url: 'https://preview.example/pr', updated_at: new Date().toISOString() }]
    : [{ id: 1, sha: SHA, environment: 'Preview', production_environment: false }])

  it('selects the valid PR when a fork\'s same-named branch is listed first', async () => {
    seed('main', BASE)
    await refreshOnce(db, { run: () => list(prFrom('stranger/x', 90), prFrom(BASE, 41)), runApi: () => '[]' })
    expect(rowFor(BASE)).toMatchObject({ pr_number: 41, pr_title: `PR 41 from ${BASE}`, issue_number: 1041, error: null })
  })

  it('caches no PR, no closing-issue override and resolves no preview when every result is a fork\'s', async () => {
    seed('trunk', BASE)
    const runApi = vi.fn(api)
    await refreshOnce(db, { run: () => list(prFrom('stranger/x', 90), prFrom('other/x', 91)), runApi })
    expect(rowFor(BASE)).toMatchObject({
      pr_number: null, pr_url: null, pr_title: null, pr_head_sha: null, tldr: null,
      issue_number: null, issue_url: null, preview_url: null, error: null,
    })
    expect(runApi).not.toHaveBeenCalled()
  })

  // the contributor workflow that must KEEP working: origin (or register({ repo }))
  // names the upstream, and the branch is pushed to the contributor's own fork
  it('selects the contributor\'s own cross-repository PR when the branch is pushed to their fork', async () => {
    seed('feature', 'me/x')
    const runApi = vi.fn(api)
    const run = vi.fn(() => list(prFrom('stranger/x', 90), prFrom(BASE, 88), prFrom('Me/X', 41)))
    await refreshOnce(db, { run, runApi })
    expect(run).toHaveBeenCalledWith(BASE, 'feature')
    expect(rowFor('me/x')).toMatchObject({ pr_number: 41, issue_number: 1041, preview_url: 'https://preview.example/pr' })
    // the preview is read from the BASE repository, for the VERIFIED head only
    expect(runApi).toHaveBeenCalledWith(`repos/${BASE}/deployments?sha=${SHA}&per_page=6`)
  })

  it('reports a full window with no match as no PR, never as a guess', async () => {
    seed('patch-1', BASE)
    const forks = Array.from({ length: PR_WINDOW }, (_, i) => prFrom(`fork${i}/x`, 100 + i))
    const runApi = vi.fn(api)
    await refreshOnce(db, { run: () => list(...forks), runApi })
    expect(rowFor(BASE)).toMatchObject({ pr_number: null, issue_number: null, preview_url: null })
    expect(runApi).not.toHaveBeenCalled()
  })

  // an item written before #157 recorded no head: the only PR it can safely
  // claim is one opened from the base repository itself
  it('a legacy row with no expected head accepts only a same-repository PR', async () => {
    seed('feature')
    await refreshOnce(db, { run: () => list(prFrom('me/x', 41)), runApi: () => '[]' })
    expect(rowFor(BASE)).toMatchObject({ pr_number: null, issue_number: null })
    await refreshOnce(db, {
      run: () => list(prFrom('me/x', 41), prFrom(BASE, 40)), runApi: () => '[]', nowMs: Date.now() + TTL.noPr + 1,
    })
    expect(rowFor(BASE)).toMatchObject({ pr_number: 40, issue_number: 1040 })
  })

  it('caches one branch name pushed to two repositories as two separate answers', async () => {
    seed('feature', BASE)
    seed('feature', 'me/x')
    await refreshOnce(db, { run: () => list(prFrom('me/x', 41), prFrom(BASE, 40)), runApi: () => '[]' })
    expect(rowFor(BASE)?.pr_number).toBe(40)
    expect(rowFor('me/x')?.pr_number).toBe(41)
  })

  // the head re-read that guards a preview runs through the SAME selection
  it('re-verifies a preview\'s head with the same rule', async () => {
    seed('main', BASE)
    let reads = 0
    // a newer fork PR appearing between the two reads leaves the verified head alone …
    await refreshOnce(db, {
      run: () => (++reads === 1 ? list(prFrom(BASE, 41)) : list(prFrom('stranger/x', 95, { headRefOid: 'd'.repeat(40) }), prFrom(BASE, 41))),
      runApi: api,
    })
    expect(reads).toBe(2)
    expect(rowFor(BASE)).toMatchObject({ pr_number: 41, preview_url: 'https://preview.example/pr' })
    // … and a re-read whose only PR is a fork's no longer confirms it, however alike it looks
    reads = 0
    await refreshOnce(db, {
      run: () => (++reads === 1 ? list(prFrom(BASE, 41)) : list(prFrom('stranger/x', 41))),
      runApi: api,
      nowMs: Date.now() + TTL.openPr + 1,
    })
    expect(reads).toBe(2)
    expect(rowFor(BASE)).toMatchObject({ pr_number: 41, preview_url: null, preview_error: 'head-changed' })
  })

  // issue #183 — gh pr checkout of a fork PR without maintainer edits leaves a
  // branch whose upstream is refs/pull/<n>/head of the base, and the base may
  // have its own same-named branch with a same-repository PR. The recorded head
  // is that pull ref: this viewer never polls it, and a viewer that still did
  // (one that predates this fix, sharing the database) could select nothing.
  it('links no PR to a branch whose head is a pull request ref, not even the base\'s same-named one', async () => {
    seed('patch-1', 'refs/pull/7/head')
    const run = vi.fn(() => list(prFrom(BASE, 40), prFrom('contributor/x', 7)))
    const runApi = vi.fn(api)
    expect(await refreshOnce(db, { run, runApi })).toBe(0)
    expect(run).not.toHaveBeenCalled()
    expect(runApi).not.toHaveBeenCalled()
    expect(listSourceLinks(db)).toEqual([])
    expect(parsePrPayload(run(), { repo: BASE, head_repo: 'refs/pull/7/head' })).toBeNull()
  })
})

// ── invariants no unit test can observe, pinned as source text ───────────────

describe('the gh subprocess contract', () => {
  const src = readFileSync(join(REPO, 'src/prstate.ts'), 'utf8')

  it('never inherits a stdio stream — execFile pipes by construction, and nothing overrides it', () => {
    expect(src).not.toContain("'inherit'")
    expect(src).not.toContain('"inherit"')
  })

  // The other half of the same invariant, and previously the hole in it: this used
  // to read `if (src.includes('spawn(')) expect(...)`. Because prstate.ts has never
  // contained `spawn(`, that branch never executed — the file was pinned against
  // 'inherit' only, while the contract it documents is "no subprocess may inherit
  // stdout". spawn() is the construct that makes inheriting easy (stdio defaults
  // are per-call and easy to widen by accident), so it is pinned OUT of the file
  // outright rather than pinned conditionally.
  //
  // If prstate ever genuinely needs spawn, this assertion is the thing that forces
  // the change to be deliberate: replace it with the capture form src/infer.ts's
  // git() uses — stdio: ['ignore', 'pipe', 'ignore'] — and say so here.
  it('shells out through execFile ONLY — no spawn( anywhere in the file', () => {
    expect(src).not.toContain('spawn(')
    expect(src).toContain('execFile')
  })

  it('passes -R and --head so the fetch never depends on the viewer\'s cwd', () => {
    expect(src).toContain("'-R'")
    expect(src).toContain("'--head'")
  })

  // issue #157 — gh cannot filter by head repository, so the call asks for the
  // head identity and examines a small bounded window instead of trusting row 0
  it('requests the head identity over a small bounded window', () => {
    expect(src).toMatch(/'--limit',\s*String\(PR_WINDOW\)/)
    for (const field of ['headRepository', 'headRepositoryOwner', 'isCrossRepository']) expect(src).toContain(field)
    expect(PR_WINDOW).toBeGreaterThan(1)
    expect(PR_WINDOW).toBeLessThanOrEqual(20)
  })

  it('caps maxBuffer and timeout so a wedged gh cannot hang or balloon the viewer', () => {
    expect(src).toMatch(/timeout:\s*GH_TIMEOUT_MS/)
    expect(src).toMatch(/maxBuffer:\s*GH_MAX_BUFFER/)
  })

  it('keeps the cadence and TTL numbers as named constants at the top of the file', () => {
    const head = src.slice(0, src.indexOf('export type'))
    for (const name of ['POLL_INTERVAL_MS', 'MAX_PER_TICK', 'GH_TIMEOUT_MS', 'TTL']) {
      expect(head, `${name} is not a named constant near the top`).toContain(name)
    }
  })

  it('resolveGh honours an explicit override before anything it guesses', () => {
    const prev = process.env.AGENT_INBOX_GH
    process.env.AGENT_INBOX_GH = '/nonexistent/gh'
    try {
      expect(resolveGh()).toBe('/nonexistent/gh')
    } finally {
      if (prev === undefined) delete process.env.AGENT_INBOX_GH
      else process.env.AGENT_INBOX_GH = prev
    }
  })
})

describe('the poller runs in the viewer process only', () => {
  const read = (p: string) => readFileSync(join(REPO, p), 'utf8')

  // the stdio channel is the MCP server's protocol wire: a `gh` subprocess that
  // inherited it, or an update notifier that printed to it, would corrupt MCP
  // the whole reachable graph of the stdio server, not just its two entry files.
  // Since #103 PR2 it includes the pure issue modules a titled board_get needs.
  const STDIO_GRAPH = [
    'src/mcp.ts', 'src/mcp-server.ts', 'src/store.ts', 'src/scope.ts', 'src/infer.ts', 'src/group.ts',
    'src/hook.ts', 'src/hook-cli.ts', 'src/shape.ts', 'src/watch.ts', 'src/watch-cli.ts', 'src/version.ts',
    'src/server-source.ts', 'src/issue-graph.ts', 'public/issue-key.js', 'public/source.js', 'public/esc.js',
  ]
  // Every relative module a file names, in either quote style: static
  // (`from '…'`), side-effect (`import '…'`), dynamic `import('…')` and
  // `require('…')`. Type-only imports count too, which only errs on the safe side.
  const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g
  const specifiers = (code: string): string[] => [...code.matchAll(SPECIFIERS)].map((m) => m[2]!)
  // repo-relative path of the module a specifier names; src/ sources are .ts
  const resolveSpec = (file: string, spec: string): string => {
    const target = posix.join(posix.dirname(file), spec)
    return target.startsWith('src/') ? target.replace(/\.js$/, '.ts') : target
  }
  const POLLERS = ['src/prstate.ts', 'src/issue-poller.ts']

  it('the specifier scan sees every import form, in either quote style', () => {
    expect(specifiers([
      `import { a } from './prstate.js'`,
      `import { b } from "./issue-poller.js"`,
      `import "./side-effect.js"`,
      `import './other.js'`,
      `const m = await import("./dynamic.js")`,
      `const r = require('./required.js')`,
      `import { c } from '../public/issue-key.js'`,
      `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'`,
    ].join('\n'))).toEqual([
      './prstate.js', './issue-poller.js', './side-effect.js', './other.js', './dynamic.js', './required.js', '../public/issue-key.js',
    ])
    expect(resolveSpec('src/mcp.ts', '../public/issue-key.js')).toBe('public/issue-key.js')
    expect(resolveSpec('public/issue-key.js', './source.js')).toBe('public/source.js')
    expect(resolveSpec('src/mcp.ts', './issue-poller.js')).toBe('src/issue-poller.ts')
  })

  it('no file of the stdio server graph imports prstate or the issue poller, directly or transitively', () => {
    for (const file of STDIO_GRAPH) {
      const reached = specifiers(read(file)).map((spec) => resolveSpec(file, spec))
      expect(reached.filter((target) => POLLERS.includes(target)), `${file} pulls a gh poller into the stdio server`).toEqual([])
      // the list is the graph: every relative import of a listed file is listed too
      for (const target of reached) expect(STDIO_GRAPH, `${file} imports ${target}`).toContain(target)
    }
  })

  it('src/prstate.ts and src/issue-poller.ts open with a header saying so', () => {
    expect(read('src/prstate.ts').slice(0, 400)).toContain('VIEWER PROCESS ONLY')
    expect(read('src/issue-poller.ts').slice(0, 400)).toContain('VIEWER PROCESS ONLY')
  })

  it('src/viewer-server.ts starts the one GitHub tick, and createViewer does NOT (a timer there would leak into every viewer test)', () => {
    expect(read('src/viewer-server.ts')).toContain('startGithubPoller(db)')
    expect(read('src/viewer-server.ts')).toContain('startLocalViewer(app, port)')
    expect(read('src/viewer-server.ts')).not.toContain('AGENT_INBOX_HOST')
    expect(read('src/viewer.ts')).not.toMatch(/startGithubPoller|startPrPoller|issue-poller/)
  })

  // Mesh M1 (#397, design §2.4a): the stdio server reaches no mesh module.
  it('no mesh module enters the stdio MCP import graph', () => {
    const MESH = ['src/mesh-config.ts', 'src/meshctl.ts', 'public/mesh-view.js']
    for (const file of MESH) expect(STDIO_GRAPH, `${file} is in the stdio graph`).not.toContain(file)
    for (const file of STDIO_GRAPH) {
      const reached = specifiers(read(file)).map((spec) => resolveSpec(file, spec))
      expect(reached.filter((target) => MESH.includes(target) || /mesh/i.test(target)), `${file} pulls a mesh module into MCP`).toEqual([])
    }
  })

  it('the local HTTP boundary never enters the stdio MCP import graph', () => {
    for (const file of STDIO_GRAPH) {
      expect(specifiers(read(file)).map((spec) => resolveSpec(file, spec)), `${file} pulls the local HTTP boundary into MCP`)
        .not.toContain('src/viewer-network.ts')
    }
  })
})

// Tenet 2: the badge must stay trustworthy. A red CI is the AGENT's problem, not
// the human being blocked — it may never escalate into the attention set, the
// Needs-you list, the tab badge or the dock badge.
describe('PR state never enters the attention set', () => {
  const read = (p: string) => readFileSync(join(REPO, p), 'utf8')

  it('public/attention.js knows nothing about PRs, checks or reviews', () => {
    const src = read('public/attention.js')
    for (const token of ['pr_', 'checks', 'review_decision', 'source.js', 'linkFor']) {
      expect(src, `attention.js mentions ${token}`).not.toContain(token)
    }
  })

  it('the Electron dock badge does not poll the links endpoint', () => {
    expect(read('electron/main.cjs')).not.toContain('api/links')
  })
})

describe('the source_links cache is only ever touched through store.ts', () => {
  it('src/prstate.ts and src/issue-poller.ts contain no raw SQL', () => {
    for (const file of ['src/prstate.ts', 'src/issue-poller.ts']) {
      const src = readFileSync(join(REPO, file), 'utf8')
      for (const sql of ['SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ', 'db.prepare', 'db.exec']) {
        expect(src, `${file} reaches around store.ts with ${sql}`).not.toContain(sql)
      }
    }
  })

  it('does not seed a cache row for a link the store never handed it', () => {
    const db = freshDb()
    upsertSourceLink(db, { repo: 'o/n', branch: 'x' })
    recordLinkFailure(db, { repo: 'o/n', branch: 'x', error: 'offline' })
    expect(listSourceLinks(db)).toHaveLength(1)
  })
})
