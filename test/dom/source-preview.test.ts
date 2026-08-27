// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { upsertBoard, upsertSourceLink, getBoard } from '../../src/store.js'
import { useDomTest, freshDb, bootApp, showInbox, row } from './harness.js'

useDomTest()

describe('source preview links', () => {
  it('shows a Preview link for blocked approval rows when a current-head preview is cached', async () => {
    const db = freshDb()
    upsertBoard(db, {
      project: 'p',
      stream: 'feature-preview',
      agent: 'copilot',
      title: 'Release',
      repo: 'o/n',
      rows: [{
        label: 'Approve merge',
        status: 'blocked',
        note: 'Choose whether to merge.',
        action_owner: 'approval',
        next_step: 'Approve the merge.',
      }],
    })
    const rowId = getBoard(db, 'p', 'Release')!.rows[0]!.id
    upsertSourceLink(db, {
      repo: 'o/n',
      branch: 'feature-preview',
      pr_number: 42,
      pr_url: 'https://github.com/o/n/pull/42',
      pr_state: 'OPEN',
      pr_head_sha: 'abc123',
      preview_url: 'https://preview.example/pr-42',
      preview_environment: 'preview',
      preview_deployment_id: 10,
      preview_updated_at: '2026-07-26T12:00:00.000Z',
    })

    await bootApp(db)
    await showInbox()
    const ask = row(rowId)!
    expect(ask.querySelector('.nrow-src')?.textContent).toContain('Preview')
    expect(ask.querySelector('.nrow-src a[href="https://preview.example/pr-42"]')).toBeTruthy()

  })

  it('omits hostile preview urls from row and card rendering', async () => {
    const db = freshDb()
    upsertBoard(db, {
      project: 'p',
      stream: 'feature-preview',
      agent: 'copilot',
      title: 'Release',
      repo: 'o/n',
      rows: [{ label: 'Approve merge', status: 'blocked', note: 'Choose whether to merge.' }],
    })
    const rowId = getBoard(db, 'p', 'Release')!.rows[0]!.id
    upsertSourceLink(db, {
      repo: 'o/n',
      branch: 'feature-preview',
      pr_number: 42,
      pr_url: 'https://github.com/o/n/pull/42',
      pr_state: 'OPEN',
      pr_head_sha: 'abc123',
      preview_url: 'javascript:alert(1)',
      preview_environment: 'preview',
    })

    await bootApp(db)
    await showInbox()
    const ask = row(rowId)!
    expect(ask.querySelector('.nrow-src')?.innerHTML ?? '').not.toContain('javascript:')
    expect(ask.querySelector('.nrow-src')?.textContent ?? '').not.toContain('Preview')

  })
})
