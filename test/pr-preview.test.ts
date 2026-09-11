import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  closeProject, insertItem, listSourceLinks, openDb, recordLinkFailure, setSourcePreview, upsertSourceLink,
} from '../src/store.js'
import { parsePrPayload, refreshOnce, resolvePreviewPayload, TTL } from '../src/prstate.js'
import { createViewer } from '../src/viewer.js'

const HEAD = 'a'.repeat(40)
const NEXT_HEAD = 'b'.repeat(40)
const NOW = '2026-09-09T03:00:00.000Z'
const URL = 'https://preview.example/pr-41'
const pr = (over: Record<string, unknown> = {}) => JSON.stringify([{
  number: 41, state: 'OPEN', headRefOid: HEAD, title: 'Preview this change',
  url: 'https://github.com/o/n/pull/41', ...over,
}])
const deployment = (id = 1, over: Record<string, unknown> = {}) => ({
  id, sha: HEAD, environment: 'Preview', production_environment: false, ...over,
})
const status = (over: Record<string, unknown> = {}) => ({
  state: 'success', environment_url: URL, updated_at: NOW, ...over,
})
const preview = {
  preview_url: URL, preview_environment: 'Preview', preview_deployment_id: 1,
  preview_updated_at: NOW, preview_error: null,
}

describe('current-head deployment previews', () => {
  it('reads only a complete head SHA from the PR payload', () => {
    expect(parsePrPayload(pr())?.pr_head_sha).toBe(HEAD)
    for (const headRefOid of [null, '', 'main', '../head', 'a'.repeat(39)]) {
      expect(parsePrPayload(pr({ headRefOid }))?.pr_head_sha).toBeNull()
    }
  })

  it('uses the exact repo and head, and only the latest deployment status', async () => {
    const calls: string[] = []
    const result = await resolvePreviewPayload('o/n', HEAD, (endpoint) => {
      calls.push(endpoint)
      return JSON.stringify(endpoint.includes('/statuses')
        ? [status()]
        : [deployment(), deployment(2, { sha: NEXT_HEAD })])
    })
    expect(calls).toEqual([
      `repos/o/n/deployments?sha=${HEAD}&per_page=6`,
      'repos/o/n/deployments/1/statuses?per_page=1',
    ])
    expect(result).toEqual(preview)
  })

  it.each(['pending', 'queued', 'in_progress', 'failure', 'error', 'inactive'])(
    'does not call a %s deployment a usable preview',
    async (state) => {
      const result = await resolvePreviewPayload('o/n', HEAD, endpoint =>
        JSON.stringify(endpoint.includes('/statuses') ? [status({ state })] : [deployment()]))
      expect(result.preview_url).toBeNull()
    },
  )

  it('never labels a production or unknown environment as a preview', async () => {
    const calls: string[] = []
    const result = await resolvePreviewPayload('o/n', HEAD, endpoint => {
      calls.push(endpoint)
      return JSON.stringify([deployment(1, { production_environment: true }), deployment(2, { production_environment: undefined })])
    })
    expect(result.preview_url).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it.each(['javascript:alert(1)', 'data:text/html,no', '//preview.example', 'not a URL'])(
    'rejects unsafe preview URL %s before caching it',
    async environment_url => {
      const result = await resolvePreviewPayload('o/n', HEAD, endpoint =>
        JSON.stringify(endpoint.includes('/statuses') ? [status({ environment_url })] : [deployment()]))
      expect(result.preview_url).toBeNull()
    },
  )

  it('chooses the newest successful environment deterministically, regardless of API order', async () => {
    const deployments = [deployment(2, { environment: 'Docs' }), deployment(1)]
    const read = (rows: typeof deployments) => resolvePreviewPayload('o/n', HEAD, endpoint => {
      if (!endpoint.includes('/statuses')) return JSON.stringify(rows)
      return JSON.stringify([status({
        environment_url: endpoint.includes('/2/') ? 'https://preview.example/docs' : URL,
        updated_at: endpoint.includes('/2/') ? '2026-09-09T03:00:01Z' : NOW,
      })])
    })
    expect((await read(deployments)).preview_deployment_id).toBe(2)
    expect(await read([...deployments].reverse())).toEqual(await read(deployments))
  })

  it('refuses conflicting active URLs for the same environment', async () => {
    await expect(resolvePreviewPayload('o/n', HEAD, endpoint => {
      if (!endpoint.includes('/statuses')) return JSON.stringify([deployment(1), deployment(2, { environment: 'preview' })])
      return JSON.stringify([status({ environment_url: `https://preview.example/${endpoint.includes('/2/') ? 'two' : 'one'}` })])
    })).rejects.toThrow(/ambiguous/i)
  })

  it('does not pick a winner from an incomplete status read', async () => {
    await expect(resolvePreviewPayload('o/n', HEAD, endpoint => {
      if (!endpoint.includes('/statuses')) return JSON.stringify([deployment(1), deployment(2)])
      if (endpoint.includes('/2/')) throw new Error('status unavailable')
      return JSON.stringify([status()])
    })).rejects.toThrow('status unavailable')
  })

  it('bounds requests and refuses a potentially truncated deployment list', async () => {
    const run = vi.fn(() => JSON.stringify(Array.from({ length: 6 }, (_, index) => deployment(index + 1))))
    await expect(resolvePreviewPayload('o/n', HEAD, run)).rejects.toThrow(/limit/i)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each(['{}', 'not json', '[{"id":"../bad","sha":"bad"}]'])('rejects malformed metadata %s', async payload => {
    await expect(resolvePreviewPayload('o/n', HEAD, () => payload)).rejects.toThrow()
  })
})

describe('preview caching does not gate approval requests', () => {
  let db: Database.Database
  let directory: string
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    directory = mkdtempSync(join(tmpdir(), 'inbox-preview-'))
    db = openDb(join(directory, 'inbox.db'))
    insertItem(db, { project: 'p', agent: 'a', stream: 'feature', repo: 'o/n', kind: 'question', title: 'Approve', action_owner: 'approval' })
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true })
    vi.useRealTimers()
  })
  const api = (endpoint: string) => JSON.stringify(endpoint.includes('/statuses') ? [status()] : [deployment()])

  it('publishes ordinary PR state before the optional preview lookup completes', async () => {
    let release!: (value: string) => void
    let started!: () => void
    const atLookup = new Promise<void>(resolve => { started = resolve })
    const waiting = new Promise<string>(resolve => { release = resolve })
    const pending = refreshOnce(db, {
      run: () => pr(),
      runApi: endpoint => {
        if (endpoint.includes('/statuses')) return api(endpoint)
        started()
        return waiting
      },
    })
    await atLookup
    expect(listSourceLinks(db)[0]?.pr_number).toBe(41)
    release(JSON.stringify([deployment()]))
    await pending
    expect(listSourceLinks(db)[0]).toMatchObject({ pr_head_sha: HEAD, ...preview })
    const response = await createViewer(db).request('/api/links')
    expect((await response.json())[0]).toMatchObject(preview)
  })

  it('drops the preview if the PR changes while its deployment is being read', async () => {
    let reads = 0
    await refreshOnce(db, {
      run: () => pr({ headRefOid: ++reads === 1 ? HEAD : NEXT_HEAD }),
      runApi: api,
    })
    expect(reads).toBe(2)
    expect(listSourceLinks(db)[0]?.preview_url).toBeNull()
    expect(listSourceLinks(db)[0]?.pr_number).toBe(41)
  })

  it('keeps good PR metadata while surfacing an optional preview failure', async () => {
    await refreshOnce(db, { run: () => pr(), runApi: () => { throw new Error('deployment lookup failed') } })
    expect(listSourceLinks(db)[0]).toMatchObject({
      pr_number: 41, pr_head_sha: HEAD, error: null, preview_url: null, preview_error: 'gh-failed',
    })
  })

  it('does not fetch previews for a missing SHA, a closed PR, or no PR', async () => {
    for (const payload of [pr({ headRefOid: null }), pr({ state: 'CLOSED' }), '[]']) {
      const runApi = vi.fn(api)
      await refreshOnce(db, { run: () => payload, runApi, nowMs: Date.now() + TTL.settled * 2 })
      expect(runApi).not.toHaveBeenCalled()
      expect(listSourceLinks(db)[0]?.preview_url).toBeNull()
    }
  })

  it('pins preview writes to the original cache revision, even within the same millisecond', () => {
    const revision = upsertSourceLink(db, { repo: 'o/n', branch: 'feature', pr_number: 41, pr_state: 'OPEN', pr_head_sha: HEAD })
    upsertSourceLink(db, { repo: 'o/n', branch: 'feature', pr_number: 41, pr_state: 'OPEN', pr_head_sha: NEXT_HEAD })
    expect(setSourcePreview(db, { repo: 'o/n', branch: 'feature', revision }, preview)).toBe(false)
    expect(listSourceLinks(db)[0]?.pr_head_sha).toBe(NEXT_HEAD)
    expect(listSourceLinks(db)[0]?.preview_url).toBeNull()
  })

  it('clears previews on failures and successful refreshes with no matching deployment', async () => {
    await refreshOnce(db, { run: () => pr(), runApi: api })
    recordLinkFailure(db, { repo: 'o/n', branch: 'feature', error: 'offline' })
    expect(listSourceLinks(db)[0]).toMatchObject({ pr_number: 41, preview_url: null, error: 'offline' })
    await refreshOnce(db, { run: () => pr(), runApi: () => '[]', nowMs: Date.now() + TTL.errorSoft + 1 })
    expect(listSourceLinks(db)[0]).toMatchObject({ pr_number: 41, preview_url: null, error: null })
  })

  it('withholds the preview when its project closes while retaining normal PR history', async () => {
    await refreshOnce(db, { run: () => pr(), runApi: api })
    closeProject(db, 'p')
    expect(listSourceLinks(db)[0]).toMatchObject({ pr_number: 41, preview_url: null })
  })
})
