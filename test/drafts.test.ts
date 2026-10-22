// test/drafts.test.ts — the pure half of durable drafts (#279): what a stored
// entry must look like, and how one window's changes merge into what the
// profile's other windows already wrote.
import { describe, expect, it } from 'vitest'
import { DRAFTS_KEY, draftEntry, draftKey, mergeDrafts, readDrafts } from '../public/drafts.js'
import type { Draft } from '../public/drafts.js'

const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

const reply = (itemId: string, text = 'Ship it.'): Draft => ({
  type: 'reply', itemId, title: 'Question', text, context: '', answer: { at: null, source: null, kind: null, text: null },
  intent: null,
})

function store(entries: Record<string, { savedAt: number; draft: unknown }>): string {
  return JSON.stringify({ v: 1, entries })
}

function keys(raw: string): string[] {
  return Object.keys(JSON.parse(raw).entries)
}

describe('draftEntry', () => {
  it('keeps only the fields of each kind, in one canonical shape', () => {
    expect(draftEntry({ ...reply('q1'), extra: 'dropped' })).toEqual(reply('q1'))
    expect(draftEntry({
      type: 'row', rowId: 'r1', boardId: 'b1', boardRevision: 4, revision: 7, actionVersion: 2,
      text: 'Go.', kind: 'answer', boardTitle: 'Plan', label: 'Step', context: '',
    })).toMatchObject({ type: 'row', rowId: 'r1', revision: 7 })
    expect(draftEntry({
      type: 'note', itemId: 'n1', title: 'Update', text: '', error: 'Note save was not confirmed.', pending: false,
    })).toMatchObject({ type: 'note', text: '' })
  })

  it('refuses anything it cannot vouch for, never throwing', () => {
    for (const raw of [
      null, 'reply', 42, [], {},
      { ...reply('q1'), type: 'unknown' },
      { ...reply('q1'), itemId: '' },
      { ...reply('q1'), text: '  ', context: '' },
      { ...reply('q1'), answer: { at: 7, source: null, kind: null } },
      { ...reply('q1'), answer: { at: null, source: null } },
      { ...reply('q1'), answer: 'pinned' },
      { ...reply('q1'), answer: { at: null, source: null, kind: null, text: 7 } },
      { ...reply('q1'), intent: { clientId: 'c', sequence: 0, actionId: 'a' } },
      { ...reply('q1'), intent: { clientId: 'c', sequence: 1, actionId: 'a', pin: 'answered' } },
      { ...reply('q1'), intent: { clientId: 'c', sequence: 1, actionId: 'a', pin: { at: 7, source: null, kind: null } } },
      { ...reply('q1'), intent: { clientId: '', sequence: 1, actionId: 'a' } },
      { ...reply('q1'), title: 7 },
      {
        type: 'item-recovery', itemId: 'q1', title: 'Q', text: 'x', context: '', kind: 'shrug', intent: null, reason: '',
      },
      {
        type: 'row-recovery', rowId: 'r1', revision: 2, actionVersion: null, text: '', kind: 'answer',
        boardTitle: 'Plan', label: 'Step', context: '', setAside: false, reason: '',
      },
    ]) {
      expect(draftEntry(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it('keeps the answer a question draft and each reply intent are pinned to, and an unconfirmed row send', () => {
    const answered = { at: '2026-10-22T11:00:00.000Z', source: 'agent', kind: 'answer', text: 'Thursday' }
    const intent = { clientId: 'c', sequence: 2, actionId: 'a' }
    expect(draftEntry({ ...reply('q1'), answer: answered })).toMatchObject({ answer: answered })
    expect(draftEntry({ ...reply('q1'), answer: null })).toMatchObject({ answer: null })
    expect(draftEntry({ ...reply('q1'), answer: { ...answered, text: undefined } }))
      .toMatchObject({ answer: { ...answered, text: null } })
    expect(draftEntry({ ...reply('q1'), intent: { ...intent, pin: answered } }))
      .toMatchObject({ intent: { ...intent, pin: answered } })
    expect(draftEntry({ ...reply('q1'), intent }), 'an intent without its pin is never replayed')
      .toMatchObject({ intent: { ...intent, pin: null } })
    const recovery = draftEntry({
      type: 'item-recovery', itemId: 'q1', title: 'Q', text: 'x', context: '', kind: 'answer', answer: answered,
      intent: { ...intent, pin: answered }, reason: '',
    })
    expect(recovery, 'a recovery is pinned only through its intent').not.toHaveProperty('answer')
    expect(recovery).toMatchObject({ intent: { pin: answered } })
    expect(draftEntry({
      type: 'row', rowId: 'r1', boardId: 'b1', boardRevision: 4, revision: 7, actionVersion: 2,
      text: 'Go.', kind: 'answer', boardTitle: 'Plan', label: 'Step', context: '', unconfirmed: true,
    })).toMatchObject({ unconfirmed: true, setAside: false })
    expect(draftEntry({
      type: 'row', rowId: 'r1', boardId: 'b1', boardRevision: 4, revision: 7, actionVersion: 2,
      text: 'Go.', kind: 'answer', boardTitle: 'Plan', label: 'Step', context: '', unconfirmed: 'yes',
    })).toBeNull()
  })

  it('names every kind but an item recovery, whose window names it', () => {
    expect(draftKey(reply('q1'))).toBe('reply:q1')
    expect(draftKey(draftEntry({
      type: 'row-recovery', rowId: 'r1', revision: 3, actionVersion: 1, text: 'x', kind: 'answer',
      boardTitle: 'Plan', label: 'Step', context: '', setAside: true, reason: '',
    })!)).toBe('row-recovery:r1:3')
    expect(draftKey(draftEntry({
      type: 'item-recovery', itemId: 'q1', title: 'Q', text: 'x', context: '', kind: 'answer', intent: null, reason: '',
    })!)).toBeNull()
  })
})

describe('readDrafts', () => {
  it('reads valid entries and drops unreadable, mislabelled and expired ones without throwing', () => {
    const raw = store({
      'reply:q1': { savedAt: NOW - DAY, draft: reply('q1') },
      'reply:q2': { savedAt: NOW - 31 * DAY, draft: reply('q2') },
      'reply:wrong': { savedAt: NOW, draft: reply('q3') },
      'reply:q4': { savedAt: -1, draft: reply('q4') },
      'reply:q5': { savedAt: NOW, draft: { type: 'reply' } },
      'item-recovery:page:item:q6': {
        savedAt: NOW,
        draft: { type: 'item-recovery', itemId: 'q6', title: 'Q', text: 'x', context: '', kind: 'answer', intent: null, reason: '' },
      },
    })
    const read = readDrafts(raw, NOW)
    expect([...read.keys()]).toEqual(['reply:q1', 'item-recovery:page:item:q6'])
    expect(read.get('reply:q1')).toEqual({ savedAt: NOW - DAY, draft: reply('q1') })
    for (const broken of [null, '', '{', 'null', '[]', JSON.stringify({ v: 2, entries: {} }), JSON.stringify({ v: 1, entries: [] })]) {
      expect(readDrafts(broken, NOW).size).toBe(0)
    }
  })

  it('applies both bounds as it reads, evicting the oldest', () => {
    const many: Record<string, { savedAt: number; draft: Draft }> = {}
    for (let index = 0; index < 150; index += 1) {
      many[`reply:q${index}`] = { savedAt: NOW - 1000 + index, draft: reply(`q${index}`) }
    }
    const kept = [...readDrafts(store(many), NOW).keys()]
    expect(kept).toHaveLength(100)
    expect(kept[0]).toBe('reply:q50')
    const big = (itemId: string) => reply(itemId, 'x'.repeat(60_000))
    const heavy = store({
      'reply:a': { savedAt: NOW - 4, draft: big('a') },
      'reply:b': { savedAt: NOW - 3, draft: big('b') },
      'reply:c': { savedAt: NOW - 2, draft: big('c') },
      'reply:d': { savedAt: NOW - 1, draft: big('d') },
    })
    expect([...readDrafts(heavy, NOW).keys()]).toEqual(['reply:b', 'reply:c', 'reply:d'])
  })

  it('keeps an entry until it is thirty days old', () => {
    const raw = store({ 'reply:q1': { savedAt: NOW - 30 * DAY, draft: reply('q1') } })
    expect(readDrafts(raw, NOW).size).toBe(1)
    expect(readDrafts(raw, NOW + 1).size).toBe(0)
  })

  it('uses one storage key', () => {
    expect(DRAFTS_KEY).toBe('agent-inbox-drafts-v1')
  })
})

describe('mergeDrafts', () => {
  const none = new Map<string, number>()

  it('writes this window\'s changes stamped with the time of the write', () => {
    const raw = mergeDrafts(null, { upserts: new Map([['reply:q1', reply('q1')]]), deletes: none }, NOW)
    expect(readDrafts(raw, NOW).get('reply:q1')).toEqual({ savedAt: NOW, draft: reply('q1') })
  })

  it('deletes only the copy this window last saw, never a newer one another window wrote', () => {
    const raw = store({
      'reply:q1': { savedAt: NOW - 10, draft: reply('q1', 'mine') },
      'reply:q2': { savedAt: NOW - 5, draft: reply('q2', 'theirs, newer') },
    })
    const merged = mergeDrafts(raw, {
      upserts: new Map(),
      deletes: new Map([['reply:q1', NOW - 10], ['reply:q2', NOW - 20], ['reply:q3', NOW - 1]]),
    }, NOW)
    expect(keys(merged)).toEqual(['reply:q2'])
  })

  it('leaves every entry it was not told about alone', () => {
    const raw = store({ 'note:n1': { savedAt: NOW - 50, draft: draftEntry({
      type: 'note', itemId: 'n1', title: 'Update', text: 'Theirs.', error: 'Not saved.', pending: false,
    }) } })
    const merged = mergeDrafts(raw, { upserts: new Map([['reply:q1', reply('q1')]]), deletes: none }, NOW)
    expect(keys(merged).sort()).toEqual(['note:n1', 'reply:q1'])
  })

  it('lets the latest write win per entry', () => {
    const older = store({ 'reply:q1': { savedAt: NOW - 1, draft: reply('q1', 'theirs') } })
    expect(readDrafts(mergeDrafts(older, { upserts: new Map([['reply:q1', reply('q1', 'mine')]]), deletes: none }, NOW), NOW)
      .get('reply:q1')).toEqual({ savedAt: NOW, draft: reply('q1', 'mine') })
  })

  describe('a stamp from the future (the clock was set back)', () => {
    const ahead = NOW + 365 * DAY

    it('can still be overwritten', () => {
      const raw = store({ 'reply:q1': { savedAt: ahead, draft: reply('q1', 'before the clock moved') } })
      expect(readDrafts(mergeDrafts(raw, { upserts: new Map([['reply:q1', reply('q1', 'mine')]]), deletes: none }, NOW), NOW)
        .get('reply:q1')).toEqual({ savedAt: NOW, draft: reply('q1', 'mine') })
    })

    it('is re-stamped by any write, so it expires thirty days later', () => {
      const raw = store({ 'reply:q1': { savedAt: ahead, draft: reply('q1') } })
      expect(readDrafts(raw, NOW + 31 * DAY).size, 'read alone counts it as written now').toBe(1)
      const merged = mergeDrafts(raw, { upserts: new Map([['reply:q2', reply('q2')]]), deletes: none }, NOW)
      expect(readDrafts(merged, NOW).get('reply:q1')?.savedAt).toBe(NOW)
      expect(readDrafts(merged, NOW + 31 * DAY).size).toBe(0)
    })

    it('is still deleted by the window that read its stamp', () => {
      const raw = store({ 'reply:q1': { savedAt: ahead, draft: reply('q1') } })
      expect(keys(mergeDrafts(raw, { upserts: new Map(), deletes: new Map([['reply:q1', ahead]]) }, NOW))).toEqual([])
    })

    it('counts as the newest entry when the bounds evict', () => {
      const entries: Record<string, { savedAt: number; draft: Draft }> = { 'reply:ahead': { savedAt: ahead, draft: reply('ahead') } }
      for (let index = 0; index < 100; index += 1) {
        entries[`reply:q${index}`] = { savedAt: NOW - 1000 + index, draft: reply(`q${index}`) }
      }
      const kept = [...readDrafts(store(entries), NOW).keys()]
      expect(kept).toHaveLength(100)
      expect(kept).toContain('reply:ahead')
      expect(kept).not.toContain('reply:q0')
    })
  })

  it('refuses to write an invalid or mislabelled entry', () => {
    const merged = mergeDrafts(null, {
      upserts: new Map<string, Draft>([['reply:other', reply('q1')], ['item-recovery:', reply('q2')]]),
      deletes: none,
    }, NOW)
    expect(keys(merged)).toEqual([])
  })

  it('drops expired entries whoever wrote them', () => {
    const raw = store({ 'reply:old': { savedAt: NOW - 31 * DAY, draft: reply('old') } })
    expect(keys(mergeDrafts(raw, { upserts: new Map([['reply:q1', reply('q1')]]), deletes: none }, NOW)))
      .toEqual(['reply:q1'])
  })

  it('caps the number of entries, evicting the oldest first', () => {
    const entries: Record<string, { savedAt: number; draft: Draft }> = {}
    for (let index = 0; index < 100; index += 1) {
      entries[`reply:q${index}`] = { savedAt: NOW - 1000 + index, draft: reply(`q${index}`) }
    }
    const merged = mergeDrafts(store(entries), { upserts: new Map([['reply:new', reply('new')]]), deletes: none }, NOW)
    const kept = keys(merged)
    expect(kept).toHaveLength(100)
    expect(kept).not.toContain('reply:q0')
    expect(kept).toContain('reply:q1')
    expect(kept).toContain('reply:new')
  })

  it('caps the serialized size, evicting the oldest first, and never keeps an entry that can never fit', () => {
    const big = (itemId: string) => reply(itemId, 'x'.repeat(60_000))
    const raw = store({
      'reply:a': { savedAt: NOW - 3, draft: big('a') },
      'reply:b': { savedAt: NOW - 2, draft: big('b') },
      'reply:c': { savedAt: NOW - 1, draft: big('c') },
    })
    const merged = mergeDrafts(raw, { upserts: new Map([['reply:d', big('d')]]), deletes: none }, NOW)
    expect(merged.length).toBeLessThanOrEqual(200_000)
    expect(keys(merged)).toEqual(['reply:b', 'reply:c', 'reply:d'])

    const huge = mergeDrafts(raw, { upserts: new Map([['reply:huge', reply('huge', 'x'.repeat(250_000))]]), deletes: none }, NOW)
    expect(keys(huge)).toEqual(['reply:a', 'reply:b', 'reply:c'])
  })

  it('accepts tighter limits for a retry after the browser refused the write', () => {
    const raw = store({
      'reply:a': { savedAt: NOW - 2, draft: reply('a', 'x'.repeat(1000)) },
      'reply:b': { savedAt: NOW - 1, draft: reply('b', 'x'.repeat(1000)) },
    })
    expect(keys(mergeDrafts(raw, { upserts: new Map(), deletes: none }, NOW, { maxChars: 1500 }))).toEqual(['reply:b'])
  })
})
