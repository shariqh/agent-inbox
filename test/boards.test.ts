import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { boardRowsView, progressLabel, hiddenDoneCount, lingeringBoards } from '../public/boards.js'

type Row = Parameters<typeof boardRowsView>[0]['rows'][number]

const row = (over: Partial<Row> & { id: string; status: Row['status'] }): Row => ({
  label: 'Row', note: '', context: '', annotation: null, annotation_unseen: false, ...over,
})

const board = (rows: Row[]) => ({
  id: 'b1',
  rows,
  progress: { done: rows.filter((r) => r.status === 'done').length, countable: rows.length, fraction: rows.length ? rows.filter((r) => r.status === 'done').length / rows.length : 0 },
})

describe('boardRowsView', () => {
  const b = board([
    row({ id: 'r1', status: 'done', label: 'Ship' }),
    row({ id: 'r2', status: 'blocked', label: 'Creds' }),
    row({ id: 'r3', status: 'tracked', label: 'Docs' }),
  ])

  it('numbers rows by their ORIGINAL position even when done rows are hidden', () => {
    const view = boardRowsView(b, { hideCompleted: true })
    expect(view.map((v) => v.row.id)).toEqual(['r2', 'r3'])
    expect(view.map((v) => v.num)).toEqual([2, 3])
  })

  it('keeps done rows when hideCompleted is off, or when this board opted back in', () => {
    expect(boardRowsView(b, { hideCompleted: false }).map((v) => v.num)).toEqual([1, 2, 3])
    expect(boardRowsView(b, { hideCompleted: true, showDone: true }).map((v) => v.num)).toEqual([1, 2, 3])
  })

  it('flags a blocked row as needing an answer', () => {
    const v = boardRowsView(b).find((x) => x.row.id === 'r2')!
    expect(v.needsAnswer).toBe(true)
  })

  it('clears needsAnswer once the human annotation has been seen by the agent', () => {
    const seen = board([row({ id: 'r2', status: 'blocked', annotation: 'use the staging key', annotation_unseen: false })])
    const unseen = board([row({ id: 'r2', status: 'blocked', annotation: 'use the staging key', annotation_unseen: true })])
    expect(boardRowsView(seen)[0]!.needsAnswer).toBe(false)
    expect(boardRowsView(unseen)[0]!.needsAnswer).toBe(true)
  })

  it('never flags a non-blocked row', () => {
    expect(boardRowsView(b).filter((v) => v.needsAnswer).map((v) => v.row.id)).toEqual(['r2'])
  })
})

describe('progressLabel', () => {
  it('makes done/countable primary and % secondary', () => {
    expect(progressLabel({ done: 3, countable: 5, fraction: 0.6 })).toEqual({ primary: '3/5', secondary: '60%', complete: false })
  })
  it('marks complete only when there is something countable', () => {
    expect(progressLabel({ done: 4, countable: 4, fraction: 1 }).complete).toBe(true)
    expect(progressLabel({ done: 0, countable: 0, fraction: 0 }).complete).toBe(false)
  })
  it('rounds the percentage', () => {
    expect(progressLabel({ done: 1, countable: 3, fraction: 1 / 3 }).secondary).toBe('33%')
  })
})

describe('hiddenDoneCount', () => {
  const b = board([row({ id: 'a', status: 'done' }), row({ id: 'b', status: 'done' }), row({ id: 'c', status: 'missing' })])
  it('counts the done rows currently hidden', () => {
    expect(hiddenDoneCount(b, { hideCompleted: true })).toBe(2)
  })
  it('is 0 when nothing is being hidden', () => {
    expect(hiddenDoneCount(b, { hideCompleted: false })).toBe(0)
    expect(hiddenDoneCount(b, { hideCompleted: true, showDone: true })).toBe(0)
  })
})

// spec §9: a board that hits 100% is archived by its agent moments later. If the
// card simply disappeared, the human would watch work vanish mid-glance — so a
// board seen ACTIVE earlier in this session lingers as "completed — archived".
describe('lingeringBoards', () => {
  const prog = (done: number, countable: number) => ({ done, countable, fraction: countable ? done / countable : 0 })
  const bd = (id: string, done: number, countable: number) => ({ id, progress: prog(done, countable) })

  it('lingers a completed board that was active this session and has since been archived', () => {
    expect(lingeringBoards(new Set(['b1']), [], [bd('b1', 3, 3)]).map((b) => b.id)).toEqual(['b1'])
  })
  it('does not linger a board that is still active — it renders in the main list', () => {
    expect(lingeringBoards(new Set(['b1']), [bd('b1', 3, 3)], [bd('b1', 3, 3)])).toEqual([])
  })
  it('does not linger an archive this session never saw active', () => {
    expect(lingeringBoards(new Set(), [], [bd('b9', 4, 4)])).toEqual([])
  })
  it('does not linger an incomplete board — only the 100% auto-archive vanishes mid-glance', () => {
    expect(lingeringBoards(new Set(['b2']), [], [bd('b2', 1, 4)])).toEqual([])
    expect(lingeringBoards(new Set(['b3']), [], [bd('b3', 0, 0)])).toEqual([])
  })
  it('accepts a plain array of previously-active ids', () => {
    expect(lingeringBoards(['b1'], [], [bd('b1', 2, 2)]).map((b) => b.id)).toEqual(['b1'])
  })
})

// rowCardEl mounts both in the triage lightbox (triageDeck open) and, since
// Task 11, inline in the Needs-you list (triageDeck null). Saving a blocked-row
// answer from the list must not throw just because there is no deck entry to
// remove — app.js has no DOM test harness in this repo (see test/shell.test.ts),
// so this is a source-level pin on the guard.
describe('rowCardEl never calls triageRemoveCurrent without a deck open', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = js.indexOf('function rowCardEl')
  const fn = js.slice(start, start + 800) // rowCardEl's whole body fits comfortably in this window

  it('rowCardEl exists and guards the onSaved callback on triageDeck', () => {
    expect(start, 'rowCardEl is missing').toBeGreaterThan(-1)
    expect(fn).toContain('if (triageDeck) triageRemoveCurrent()')
  })

  it('never passes the bare triageRemoveCurrent reference as onSaved — that throws when the deck is closed', () => {
    expect(js).not.toContain('rowAnswerEl(b, r, triageRemoveCurrent)')
  })
})
