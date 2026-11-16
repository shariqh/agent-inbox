import { describe, it, expect } from 'vitest'
import { groupItems } from '../src/group.js'
import type { Item } from '../src/store.js'

function item(p: Partial<Item>): Item {
  return {
    id: p.id ?? 'x', project: p.project ?? 'p', stream: p.stream ?? '', agent: p.agent ?? 'claude-code',
    session: p.session ?? null,
    kind: p.kind ?? 'note', title: p.title ?? 't', detail: p.detail ?? '', next_step: p.next_step ?? '',
    action_owner: p.action_owner ?? null, handoff: p.handoff ?? null, impact: p.impact ?? '', next_after: p.next_after ?? '',
    context: p.context ?? '', status: p.status ?? 'open',
    annotation: p.annotation ?? null, created_at: p.created_at ?? '2026-07-12T00:00:00.000Z', resolved_at: p.resolved_at ?? null,
    annotated_at: p.annotated_at ?? null,
    annotation_seen_at: p.annotation_seen_at ?? null,
    annotation_seen_by: p.annotation_seen_by ?? null,
    options: p.options ?? null, reply: p.reply ?? null, reply_context: p.reply_context ?? null, replied_at: p.replied_at ?? null, reply_seen_at: p.reply_seen_at ?? null,
    reply_source: p.reply_source ?? null, reply_kind: p.reply_kind ?? null,
    response_revision: p.response_revision ?? 0,
    snoozed_until: p.snoozed_until ?? null, outcome: p.outcome ?? '', outcome_at: p.outcome_at ?? null,
    pinned_at: p.pinned_at ?? null,
    watch_stopped_at: p.watch_stopped_at ?? null, watch_stopped_until: p.watch_stopped_until ?? null,
    action_agent: p.action_agent ?? null,
    updated_at: p.updated_at ?? p.created_at ?? '2026-07-12T00:00:00.000Z',
    repo: p.repo ?? null, issue_ref: p.issue_ref ?? null, head_repo: p.head_repo ?? null, repo_root: p.repo_root ?? null,
  }
}

describe('groupItems', () => {
  it('splits open questions and notes by project, and buckets closed items into done', () => {
    const g = groupItems([
      item({ id: '1', project: 'social-agent', kind: 'question', status: 'open', title: 'q1' }),
      item({ id: '2', project: 'social-agent', kind: 'note', status: 'open', title: 'n1' }),
      item({ id: '3', project: 'oris', kind: 'question', status: 'open', title: 'q2' }),
      item({ id: '4', project: 'oris', kind: 'note', status: 'resolved', title: 'done1' }),
      item({ id: '5', project: 'oris', kind: 'question', status: 'dismissed', title: 'done2' }),
    ])
    expect(g.needsYou.map((pg) => pg.project).sort()).toEqual(['oris', 'social-agent'])
    expect(g.needsYou.find((pg) => pg.project === 'social-agent')!.items.map((i) => i.id)).toEqual(['1'])
    expect(g.notes.map((pg) => pg.project)).toEqual(['social-agent'])
    expect(g.done.map((i) => i.id).sort()).toEqual(['4', '5'])
  })

  it('buckets OPEN kind=done milestones into done, never needsYou/notes, preserving order', () => {
    const g = groupItems([
      item({ id: '1', project: 'oris', kind: 'done', status: 'open', title: 'shipped v2', created_at: '2026-07-14T00:00:00.000Z' }),
      item({ id: '2', project: 'oris', kind: 'question', status: 'open', title: 'q1' }),
      item({ id: '3', project: 'oris', kind: 'note', status: 'open', title: 'n1' }),
      item({ id: '4', project: 'oris', kind: 'note', status: 'resolved', title: 'closed1', created_at: '2026-07-13T00:00:00.000Z' }),
    ])
    expect(g.needsYou.flatMap((pg) => pg.items.map((i) => i.id))).toEqual(['2'])
    expect(g.notes.flatMap((pg) => pg.items.map((i) => i.id))).toEqual(['3'])
    // input order (newest first) is preserved: open milestone before older closed item
    expect(g.done.map((i) => i.id)).toEqual(['1', '4'])
  })

  // #612: an open hand-off is an ask, so it joins Needs you and leaves History.
  it('puts an open hand-off in needsYou beside the open questions, not in done', () => {
    const g = groupItems([
      item({ id: 'q', project: 'p', kind: 'question', title: 'q' }),
      item({ id: 'h', project: 'p', kind: 'done', handoff: 1, action_owner: 'task', next_step: 'Review it.', title: 'h' }),
      item({ id: 'm', project: 'p', kind: 'done', next_step: 'No action', title: 'm' }),
    ])
    expect(g.needsYou).toHaveLength(1)
    expect(g.needsYou[0]!.items.map((i) => i.id).sort()).toEqual(['h', 'q'])
    expect(g.done.map((i) => i.id)).toEqual(['m'])
  })

  it('keeps a milestone with action_owner task and no marker out of needsYou', () => {
    const g = groupItems([item({ id: 'm', kind: 'done', action_owner: 'task', next_step: 'Do it.' })])
    expect(g.needsYou).toEqual([])
    expect(g.done.map((i) => i.id)).toEqual(['m'])
  })

  it('moves an acknowledged hand-off to done', () => {
    const g = groupItems([item({ id: 'h', kind: 'done', handoff: 1, status: 'resolved', outcome: 'Acknowledged' })])
    expect(g.needsYou).toEqual([])
    expect(g.done.map((i) => i.id)).toEqual(['h'])
  })
})
