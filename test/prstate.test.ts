import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
} from '../src/store.js'
import type { LinkTarget, SourceLink } from '../src/store.js'
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
} from '../src/prstate.js'

const REPO = new URL('..', import.meta.url).pathname

function freshDb(): Database.Database {
  return openDb(join(mkdtempSync(join(tmpdir(), 'prstate-')), 'inbox.db'))
}

// the shape `gh pr list --json …` actually emits (verified live against cli/cli)
function ghPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    number: 41,
    title: 'source + PR links',
    url: 'https://github.com/shariqh/agent-inbox/pull/41',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'test' }],
    closingIssuesReferences: [{ number: 30, url: 'https://github.com/shariqh/agent-inbox/issues/30' }],
    body: 'Links the inbox to its source issue and PR.',
    updatedAt: '2026-07-26T10:00:00Z',
    ...over,
  }])
}

describe('classifyChecks', () => {
  const run = (conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun', status, conclusion })

  it('a single FAILURE beats a hundred successes', () => {
    const rollup = [...Array(100).fill(run('SUCCESS')), run('FAILURE')]
    expect(classifyChecks(rollup)).toBe('failing')
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

  it('reads StatusContext state as well as CheckRun conclusion', () => {
    expect(classifyChecks([{ __typename: 'StatusContext', state: 'FAILURE' }])).toBe('failing')
    expect(classifyChecks([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('pending')
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
    const pr = parsePrPayload(ghPayload())!
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
    const pr = parsePrPayload(ghPayload())!
    expect(pr.issue_number).toBe(30)
    expect(pr.issue_url).toBe('https://github.com/shariqh/agent-inbox/issues/30')
  })

  it('leaves the issue null when the PR closes nothing', () => {
    const pr = parsePrPayload(ghPayload({ closingIssuesReferences: [] }))!
    expect(pr.issue_number).toBeNull()
    expect(pr.issue_url).toBeNull()
  })

  it('returns null for the empty array gh emits when there is no PR, and for junk', () => {
    expect(parsePrPayload('[]')).toBeNull()
    expect(parsePrPayload('not json')).toBeNull()
    expect(parsePrPayload('{}')).toBeNull()
    expect(parsePrPayload('[{"title":"no number"}]')).toBeNull()
  })

  it('truncates an absurdly long PR title rather than storing it whole', () => {
    const pr = parsePrPayload(ghPayload({ title: 'y'.repeat(900) }))!
    expect(pr.pr_title!.length).toBeLessThanOrEqual(301)
  })

  it('reads draft and merged state', () => {
    expect(parsePrPayload(ghPayload({ isDraft: true }))!.pr_draft).toBe(true)
    expect(parsePrPayload(ghPayload({ state: 'MERGED' }))!.pr_state).toBe('MERGED')
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
  const target = (branch: string): LinkTarget => ({ repo: 'o/n', branch })
  const link = (branch: string, over: Partial<SourceLink> = {}): SourceLink => ({
    repo: 'o/n', branch, provider: 'github',
    pr_number: 41, pr_url: null, pr_title: null, pr_state: 'OPEN', pr_draft: false,
    review_decision: null, checks: null, issue_number: null, issue_url: null, issue_title: null,
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

// ── invariants no unit test can observe, pinned as source text ───────────────

describe('the gh subprocess contract', () => {
  const src = readFileSync(join(REPO, 'src/prstate.ts'), 'utf8')

  it('never inherits a stdio stream — execFile pipes by construction, and nothing overrides it', () => {
    expect(src).not.toContain("'inherit'")
    expect(src).not.toContain('"inherit"')
    // if this ever switches to spawn it MUST capture, like src/infer.ts's git()
    if (src.includes('spawn(')) expect(src).toContain("stdio: ['ignore', 'pipe', 'ignore']")
  })

  it('passes -R and --head so the fetch never depends on the viewer\'s cwd', () => {
    expect(src).toContain("'-R'")
    expect(src).toContain("'--head'")
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
  it('src/mcp.ts and src/mcp-server.ts never import prstate, directly or transitively', () => {
    // the whole reachable graph of the stdio server, not just its two entry files
    // (a comment naming prstate.ts is fine — an IMPORT of it is not)
    const imports = /(?:from\s+'\.\/prstate\.js'|require\('\.\/prstate)/
    for (const file of ['src/mcp.ts', 'src/mcp-server.ts', 'src/store.ts', 'src/scope.ts', 'src/infer.ts', 'src/group.ts', 'src/hook.ts', 'src/hook-cli.ts']) {
      expect(read(file), `${file} pulls prstate into the stdio server`).not.toMatch(imports)
    }
  })

  it('src/prstate.ts opens with a header saying so', () => {
    expect(read('src/prstate.ts').slice(0, 400)).toContain('VIEWER PROCESS ONLY')
  })

  it('src/viewer-server.ts starts it, and createViewer does NOT (a timer there would leak into every viewer test)', () => {
    expect(read('src/viewer-server.ts')).toContain('startPrPoller(db)')
    expect(read('src/viewer.ts')).not.toContain('startPrPoller')
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
  it('src/prstate.ts contains no raw SQL', () => {
    const src = readFileSync(join(REPO, 'src/prstate.ts'), 'utf8')
    for (const sql of ['SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ', 'db.prepare']) {
      expect(src, `prstate.ts reaches around store.ts with ${sql}`).not.toContain(sql)
    }
  })

  it('does not seed a cache row for a link the store never handed it', () => {
    const db = freshDb()
    upsertSourceLink(db, { repo: 'o/n', branch: 'x' })
    recordLinkFailure(db, { repo: 'o/n', branch: 'x', error: 'offline' })
    expect(listSourceLinks(db)).toHaveLength(1)
  })
})
