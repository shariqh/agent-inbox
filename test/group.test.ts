import { describe, it, expect } from 'vitest'
import { groupItems } from '../src/group.js'
import type { Item } from '../src/store.js'

function item(p: Partial<Item>): Item {
  return {
    id: p.id ?? 'x', project: p.project ?? 'p', stream: p.stream ?? '', agent: p.agent ?? 'claude-code',
    session: p.session ?? null,
    kind: p.kind ?? 'note', title: p.title ?? 't', detail: p.detail ?? '', context: p.context ?? '', status: p.status ?? 'open',
    annotation: p.annotation ?? null, created_at: p.created_at ?? '2026-07-12T00:00:00.000Z', resolved_at: p.resolved_at ?? null,
    options: p.options ?? null, reply: p.reply ?? null, reply_context: p.reply_context ?? null, replied_at: p.replied_at ?? null, reply_seen_at: p.reply_seen_at ?? null,
    reply_source: p.reply_source ?? null,
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
})
