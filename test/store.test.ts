import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  openDb,
  insertItem,
  resolveItem,
  dismissItem,
  annotateItem,
  listItems,
  replyItem,
  answerItem,
  markReplySeen,
  listPending,
  upsertBoard,
  updateBoardRow,
  findBoard,
  archiveBoard,
  unarchiveBoard,
  annotateBoardRow,
  listBoards,
  computeProgress,
  getBoard,
  markBoardRead,
  upsertActivity,
  endActivity,
  listActivity,
  closeProject,
  reopenProject,
  listClosedProjects,
  closedProjects,
} from '../src/store.js'
import type { BoardRow } from '../src/store.js'

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
  return openDb(join(dir, 'inbox.db'))
}

describe('store', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('inserts an open item and reads it back', () => {
    const id = insertItem(db, { project: 'social-agent', stream: 'main', agent: 'claude-code', kind: 'question', title: 'double jump or wall climb?' })
    const items = listItems(db)
    expect(items).toHaveLength(1)
    const it0 = items[0]!
    expect(it0.id).toBe(id)
    expect(it0.status).toBe('open')
    expect(it0.kind).toBe('question')
    expect(it0.detail).toBe('')
    expect(it0.annotation).toBeNull()
    expect(it0.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(it0.resolved_at).toBeNull()
  })

  it('resolve sets status + resolved_at, and is idempotent', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'copilot', kind: 'note', title: 'assumed X' })
    resolveItem(db, id)
    resolveItem(db, id) // no throw
    const it0 = listItems(db)[0]!
    expect(it0.status).toBe('resolved')
    expect(it0.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('dismiss sets status dismissed', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'tech debt here' })
    dismissItem(db, id)
    expect(listItems(db)[0]!.status).toBe('dismissed')
  })

  it('annotate stores my private note', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'which db?' })
    annotateItem(db, id, 'use sqlite')
    expect(listItems(db)[0]!.annotation).toBe('use sqlite')
  })

  it('listItems filters by status and returns newest first', () => {
    const a = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'first' })
    const b = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'second' })
    resolveItem(db, a)
    expect(listItems(db).map((i) => i.title)).toEqual(['second', 'first'])
    expect(listItems(db, { status: 'open' }).map((i) => i.id)).toEqual([b])
    expect(listItems(db, { status: 'resolved' }).map((i) => i.id)).toEqual([a])
  })

  it('resolve on unknown id is a no-op', () => {
    resolveItem(db, 'nope') // must not throw
    expect(listItems(db)).toHaveLength(0)
  })

  it('open done-kind milestones dedupe by (project, title); other kinds never do', () => {
    const a = insertItem(db, { project: 'p', stream: '', agent: 'x', kind: 'done', title: 'shipped v2' })
    const b = insertItem(db, { project: 'p', stream: '', agent: 'x', kind: 'done', title: 'shipped v2' })
    expect(b).toBe(a)                       // same open milestone → same id
    expect(listItems(db)).toHaveLength(1)
    resolveItem(db, a)
    const c = insertItem(db, { project: 'p', stream: '', agent: 'x', kind: 'done', title: 'shipped v2' })
    expect(c).not.toBe(a)                   // resolved → a fresh announcement is fine
    const d = insertItem(db, { project: 'other', stream: '', agent: 'x', kind: 'done', title: 'shipped v2' })
    expect(d).not.toBe(c)                   // scoped by project
    const q1 = insertItem(db, { project: 'p', stream: '', agent: 'x', kind: 'question', title: 'same q' })
    const q2 = insertItem(db, { project: 'p', stream: '', agent: 'x', kind: 'question', title: 'same q' })
    expect(q2).not.toBe(q1)                 // questions never dedupe
  })
})

describe('answer-back', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('items carry long-form context, defaulting to empty', () => {
    const id = insertItem(db, {
      project: 'p', stream: '', agent: 'a', kind: 'question', title: 'which db?',
      context: 'Migrating the auth service; hit this while wiring sessions. See PR #12. Current code assumes sqlite.',
    })
    expect(listItems(db).find((i) => i.id === id)!.context).toMatch(/auth service/)
    const bare = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'note', title: 'no ctx' })
    expect(listItems(db).find((i) => i.id === bare)!.context).toBe('')
  })

  it('question options round-trip as structured data; absent options are null', () => {
    const id = insertItem(db, {
      project: 'p', stream: '', agent: 'a', kind: 'question', title: 'which db?',
      options: [
        { label: 'sqlite', detail: 'zero-config, single file; fine for local write rates', recommended: true },
        { label: 'postgres', detail: 'needs a server; overkill until remote mode' },
      ],
    })
    const item = listItems(db).find((i) => i.id === id)!
    expect(item.options).toHaveLength(2)
    expect(item.options![0]!.label).toBe('sqlite')
    expect(item.options![0]!.recommended).toBe(true)
    expect(item.options![1]!.detail).toMatch(/needs a server/)
    const plain = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'note', title: 'no opts' })
    expect(listItems(db).find((i) => i.id === plain)!.options).toBeNull()
  })

  it('replyItem stores the answer + optional context, stamps replied_at, and resets pickup', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q' })
    replyItem(db, id, 'sqlite', 'prefer low ops for now')
    let item = listItems(db)[0]!
    expect(item.reply).toBe('sqlite')
    expect(item.reply_context).toBe('prefer low ops for now')
    expect(item.replied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(item.reply_seen_at).toBeNull()
    markReplySeen(db, id)
    expect(listItems(db)[0]!.reply_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    replyItem(db, id, 'actually postgres') // changing the answer resets pickup
    item = listItems(db)[0]!
    expect(item.reply).toBe('actually postgres')
    expect(item.reply_context).toBeNull()
    expect(item.reply_seen_at).toBeNull()
    replyItem(db, id, '') // clearing the answer reverts to unanswered (null, not '')
    expect(listItems(db)[0]!.reply).toBeNull()
    expect(listItems(db)[0]!.reply_context).toBeNull()
  })

  // fix round 1: a stale client (or an explicit "change answer") must never be able to
  // silently revert a reply the agent has already picked up — replyItem refuses the
  // blank-clear once reply_seen_at is set, and reports the refusal via its return value
  // instead of quietly no-op-ing.
  it('refuses to blank out an already-picked-up reply, but still allows clearing one that has not been seen', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q' })
    replyItem(db, id, 'go left')
    markReplySeen(db, id)
    expect(replyItem(db, id, '')).toBe(false) // refused — signaled via the return value
    const item = listItems(db).find((i) => i.id === id)!
    expect(item.reply).toBe('go left') // the reply survives
    expect(item.reply_seen_at).not.toBeNull() // pickup state survives too

    // control: clearing a reply the agent has NOT yet picked up still works as before
    const id2 = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q2' })
    replyItem(db, id2, 'go right')
    expect(replyItem(db, id2, '')).toBe(true)
    expect(listItems(db).find((i) => i.id === id2)!.reply).toBeNull()

    // a genuine new answer (not a blank clear) still resets pickup even after it was seen —
    // only the destructive blank-clear is refused, not legitimate re-answering
    replyItem(db, id, 'go right instead')
    const changed = listItems(db).find((i) => i.id === id)!
    expect(changed.reply).toBe('go right instead')
    expect(changed.reply_seen_at).toBeNull()
  })

  // fix round 1 (hardening): replyItem's blank-clear guard must be ONE atomic
  // conditioned statement, not a SELECT followed by an unconditional UPDATE — the two
  // statements run in the SAME OS process, but the MCP server's `pending` tool calls
  // markReplySeen from a genuinely SEPARATE process on the same WAL-mode db file. This
  // proves the guard is race-safe by literally exercising two connections and forcing
  // the interleaving a plain sequential call cannot reproduce (a write committed fully
  // before or after the call is already correctly handled either way — only a write
  // landing INSIDE the guard's own statement sequence is the exploit window).
  it('an atomic guard survives markReplySeen from a second connection racing the blank-clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-race-'))
    const path = join(dir, 'inbox.db')
    const db1 = openDb(path)
    const db2 = new Database(path)
    db2.pragma('journal_mode = WAL')
    db2.pragma('busy_timeout = 5000')

    const id = insertItem(db1, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q' })
    replyItem(db1, id, 'go left')

    // Force the interleaving: intercept the first statement replyItem() prepares on db1
    // that touches reply_seen_at, and land the agent's pickup (via db2, a separate
    // connection) inside replyItem's own call — after its read completes (the old
    // SELECT-then-unconditional-UPDATE shape) or before its write executes (the fixed
    // single conditioned UPDATE) — whichever the implementation actually uses.
    const realPrepare = db1.prepare.bind(db1)
    let injected = false
    db1.prepare = ((sql: string) => {
      const stmt = realPrepare(sql)
      if (!injected && /reply_seen_at/.test(sql)) {
        injected = true
        const realGet = stmt.get.bind(stmt)
        const realRun = stmt.run.bind(stmt)
        stmt.get = ((...args: unknown[]) => {
          const result = realGet(...(args as []))
          markReplySeen(db2, id) // race lands right after the (stale) read
          return result
        }) as typeof stmt.get
        stmt.run = ((...args: unknown[]) => {
          markReplySeen(db2, id) // race lands right before the conditioned write
          return realRun(...(args as []))
        }) as typeof stmt.run
      }
      return stmt
    }) as typeof db1.prepare

    const ok = replyItem(db1, id, '')
    db1.prepare = realPrepare

    expect(ok).toBe(false) // refused — the concurrent pickup must win
    const item = listItems(db1).find((i) => i.id === id)!
    expect(item.reply).toBe('go left') // the reply survives
    expect(item.reply_seen_at).not.toBeNull() // pickup state survives too

    db2.close()
  })

  // fix round 1: replyItem(id, '') on a nonexistent id now returns false (the old
  // unguarded SELECT found nothing, skipped the check, and the unconditional UPDATE
  // "succeeded" as a no-op returning true). The new atomic UPDATE's WHERE clause simply
  // matches zero rows, so info.changes is 0 — harmless, since ids always come from real
  // UI state, but noted so it doesn't read as a regression.
  it('replyItem blank-clear on a nonexistent id returns false (no matching row to update)', () => {
    expect(replyItem(db, 'does-not-exist', '')).toBe(false)
  })

  it('listPending returns open questions for a project, oldest first', () => {
    const a = insertItem(db, { project: 'p', stream: '', agent: 'x', kind: 'question', title: 'first?' })
    insertItem(db, { project: 'p', stream: '', agent: 'x', kind: 'note', title: 'a note' })
    insertItem(db, { project: 'other', stream: '', agent: 'x', kind: 'question', title: 'elsewhere?' })
    const b = insertItem(db, { project: 'p', stream: '', agent: 'x', kind: 'question', title: 'second?' })
    resolveItem(db, b)
    const answeredId = insertItem(db, { project: 'p', stream: '', agent: 'x', kind: 'question', title: 'third?' })
    replyItem(db, answeredId, 'go left')
    const pending = listPending(db, 'p')
    expect(pending.map((i) => i.id)).toEqual([a, answeredId]) // open questions only, oldest first
    expect(pending[1]!.reply).toBe('go left')
    expect(pending[1]!.reply_context).toBeNull()
  })

  it('openDb migrates a legacy items table missing the answer columns', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-legacy3-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', kind TEXT NOT NULL, title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
        annotation TEXT, created_at TEXT NOT NULL, resolved_at TEXT
      );
    `)
    legacy.close()
    const db2 = openDb(path)
    const id = insertItem(db2, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q', options: [{ label: 'x' }] })
    replyItem(db2, id, 'x', 'ship this today')
    expect(listItems(db2)[0]!.reply).toBe('x')
    expect(listItems(db2)[0]!.reply_context).toBe('ship this today')
    expect(listItems(db2)[0]!.options![0]!.label).toBe('x')
  })
})

// issue #29 — dual-channel answers. The human can answer in the inbox card OR say it
// out loud in chat, in which case the agent that heard it records it with answerItem.
// The conflict rule is NOT wall-clock last-write-wins (a skewed clock or a delayed
// flush would let a stale chat answer clobber a fresh inbox one): the INBOX ALWAYS
// WINS. An agent may only record while nothing unread is waiting for it, and the
// human's own reply overwrites unconditionally. Both orderings therefore converge on
// the inbox answer, with no clock comparison to get wrong.
describe('dual-channel answers (#29)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const ask = (title = 'q'): string => insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title })
  const row = (id: string) => listItems(db).find((i) => i.id === id)!

  it('replyItem stamps the inbox channel, and a blank clear drops the source with the answer', () => {
    const id = ask()
    replyItem(db, id, 'sqlite')
    expect(row(id).reply_source).toBe('inbox')
    expect(replyItem(db, id, '')).toBe(true) // not picked up yet, so the clear is allowed
    expect(row(id).reply).toBeNull()
    expect(row(id).reply_source).toBeNull() // no answer means no channel
  })

  it('a legacy items table migrates to carry reply_source, defaulting to null', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-legacy-source-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', kind TEXT NOT NULL, title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
        annotation TEXT, created_at TEXT NOT NULL, resolved_at TEXT
      );
      INSERT INTO items (id, project, kind, title, created_at) VALUES ('old', 'p', 'question', 'legacy?', '2026-01-01T00:00:00.000Z');
    `)
    legacy.close()
    const migrated = openDb(path)
    expect(listItems(migrated).find((i) => i.id === 'old')!.reply_source).toBeNull()
    const fresh = insertItem(migrated, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q' })
    expect(answerItem(migrated, fresh, 'from chat').ok).toBe(true)
    expect(listItems(migrated).find((i) => i.id === fresh)!.reply_source).toBe('agent')
  })

  it('answerItem records a chat answer as already picked up, sourced to the agent, item still open', () => {
    const id = ask()
    expect(answerItem(db, id, 'use postgres', 'ship behind a flag')).toEqual({ ok: true })
    const it = row(id)
    expect(it.reply).toBe('use postgres')
    expect(it.reply_context).toBe('ship behind a flag')
    expect(it.replied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // the agent IS the reader here — printing "waiting for agent pickup" for an
    // answer it authored itself would be a lie the card tells the human
    expect(it.reply_seen_at).toBe(it.replied_at)
    expect(it.reply_source).toBe('agent')
    expect(it.status).toBe('open') // recording an answer is not resolving; the agent still has to act
  })

  it('answerItem refuses an empty answer, an unknown id, a note and a resolved question, each with a reason', () => {
    const id = ask()
    expect(answerItem(db, id, '   ')).toEqual({ ok: false, reason: 'empty' })
    expect(row(id).reply).toBeNull() // an agent may RECORD an answer, never erase one
    expect(answerItem(db, 'does-not-exist', 'x')).toEqual({ ok: false, reason: 'not_found' })
    const note = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'note', title: 'fyi' })
    expect(answerItem(db, note, 'x')).toEqual({ ok: false, reason: 'not_a_question' })
    const closed = ask('closed?')
    resolveItem(db, closed)
    expect(answerItem(db, closed, 'x')).toEqual({ ok: false, reason: 'not_open' })
  })

  it('an unpicked-up inbox answer beats a chat answer — answerItem refuses and hands back what is waiting', () => {
    const id = ask()
    replyItem(db, id, 'from the inbox', 'and read the thread first')
    const out = answerItem(db, id, 'from chat')
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('unread_inbox_answer')
    expect(out.reply).toBe('from the inbox')
    expect(out.reply_context).toBe('and read the thread first')
    const it = row(id)
    expect(it.reply).toBe('from the inbox')
    expect(it.reply_source).toBe('inbox')
    expect(it.reply_seen_at).toBeNull() // still waiting to be picked up via pending()
  })

  it('a fresh inbox answer always supersedes a chat-recorded one, resetting pickup and source', () => {
    const id = ask()
    expect(answerItem(db, id, 'from chat').ok).toBe(true)
    replyItem(db, id, 'no, the other way', 'I changed my mind')
    const it = row(id)
    expect(it.reply).toBe('no, the other way')
    expect(it.reply_context).toBe('I changed my mind')
    expect(it.reply_seen_at).toBeNull()
    expect(it.reply_source).toBe('inbox')
  })

  it('once the agent has picked the inbox answer up, a newer chat answer overwrites it — reply AND context', () => {
    const id = ask()
    replyItem(db, id, 'inbox answer', 'inbox context')
    markReplySeen(db, id)
    expect(answerItem(db, id, 'chat overrides').ok).toBe(true)
    const it = row(id)
    expect(it.reply).toBe('chat overrides')
    // deliberate, pinned: an agent may OVERWRITE a picked-up human answer (the human
    // said something newer out loud) but may never BLANK one. The stale context goes
    // with the stale answer rather than being left attached to a different reply.
    expect(it.reply_context).toBeNull()
    expect(it.reply_source).toBe('agent')
  })

  it('an answer from either channel survives resolve, and the final state converges on resolved', () => {
    const chat = ask('chat?')
    answerItem(db, chat, 'chat answer')
    resolveItem(db, chat)
    expect(row(chat).status).toBe('resolved')
    expect(row(chat).reply).toBe('chat answer')

    const inbox = ask('inbox?')
    replyItem(db, inbox, 'inbox answer')
    markReplySeen(db, inbox)
    resolveItem(db, inbox)
    expect(row(inbox).status).toBe('resolved')
    expect(row(inbox).reply).toBe('inbox answer')
  })

  // The precedence guard has to be ONE conditioned UPDATE, not SELECT-then-UPDATE and
  // not two UPDATEs: the viewer (its own OS process, its own connection to the same WAL
  // file) can land a reply INSIDE a multi-statement answerItem. A two-statement version
  // would leave the human's newest answer flagged "✓ picked up" — a lie — and
  // un-clearable by their own "Change answer" (replyItem's blank-clear refuses once
  // reply_seen_at is set). Same interception shape as the replyItem race pin above.
  it('the precedence guard is one atomic statement: a viewer replyItem racing from a second connection still wins the whole record', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-answer-race-')), 'inbox.db')
    const db1 = openDb(path) // the MCP server's connection
    const db2 = new Database(path) // the viewer's
    db2.pragma('journal_mode = WAL')
    db2.pragma('busy_timeout = 5000')

    const id = insertItem(db1, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q' })

    const realPrepare = db1.prepare.bind(db1)
    let injected = false
    db1.prepare = ((sql: string) => {
      const stmt = realPrepare(sql)
      if (!injected && /reply_seen_at/.test(sql)) {
        injected = true
        const realGet = stmt.get.bind(stmt)
        const realRun = stmt.run.bind(stmt)
        stmt.get = ((...args: unknown[]) => {
          const result = realGet(...(args as []))
          replyItem(db2, id, 'from the inbox') // race lands right after a (stale) read
          return result
        }) as typeof stmt.get
        stmt.run = ((...args: unknown[]) => {
          replyItem(db2, id, 'from the inbox') // race lands right before the conditioned write
          return realRun(...(args as []))
        }) as typeof stmt.run
      }
      return stmt
    }) as typeof db1.prepare

    const out = answerItem(db1, id, 'from chat')
    db1.prepare = realPrepare

    expect(out.ok).toBe(false)
    expect(out.reason).toBe('unread_inbox_answer')
    const it = listItems(db1).find((i) => i.id === id)!
    expect(it.reply).toBe('from the inbox') // the whole record is the human's, not a blend
    expect(it.reply_context).toBeNull()
    expect(it.reply_seen_at).toBeNull()
    expect(it.reply_source).toBe('inbox')

    db2.close()
  })
})

describe('live activity', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('upsert creates then updates one entry per session, stamping times', () => {
    upsertActivity(db, { session: 's1', project: 'p', stream: 'main', agent: 'claude-code', doing: 'migrating tests' })
    let live = listActivity(db)
    expect(live).toHaveLength(1)
    expect(live[0]!.doing).toBe('migrating tests')
    expect(live[0]!.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    upsertActivity(db, { session: 's1', project: 'p', stream: 'main', agent: 'claude-code', doing: 'running suite', detail: 'vitest run' })
    live = listActivity(db)
    expect(live).toHaveLength(1) // same session → same entry
    expect(live[0]!.doing).toBe('running suite')
    expect(live[0]!.detail).toBe('vitest run')
    expect(live[0]!.updated_at >= live[0]!.started_at).toBe(true)
  })

  it('children round-trip as a full-replace list', () => {
    upsertActivity(db, {
      session: 's1', project: 'p', stream: '', agent: 'claude-code', doing: 'fan-out review',
      children: [
        { name: 'reviewer-bugs', doing: 'scanning store.ts', state: 'running' },
        { name: 'reviewer-perf', doing: 'profiling viewer', state: 'running' },
      ],
    })
    expect(listActivity(db)[0]!.children).toHaveLength(2)
    upsertActivity(db, { session: 's1', project: 'p', stream: '', agent: 'claude-code', doing: 'fan-out review', children: [{ name: 'reviewer-perf', doing: 'writing findings', state: 'finishing' }] })
    const kids = listActivity(db)[0]!.children
    expect(kids).toHaveLength(1) // full replace — finished child gone
    expect(kids[0]!.doing).toBe('writing findings')
    upsertActivity(db, { session: 's1', project: 'p', stream: '', agent: 'claude-code', doing: 'synthesizing' })
    expect(listActivity(db)[0]!.children).toHaveLength(1) // omitted children = unchanged
  })

  it('presence rows are idle until a real report upgrades them, and can revert', () => {
    upsertActivity(db, { session: 's1', project: 'p', stream: '', agent: 'claude-code', doing: 'session open', idle: true })
    expect(listActivity(db)[0]!.idle).toBe(true)
    upsertActivity(db, { session: 's1', project: 'p', stream: '', agent: 'claude-code', doing: 'migrating the store' })
    expect(listActivity(db)[0]!.idle).toBe(false)  // real report → active
    expect(listActivity(db)[0]!.doing).toBe('migrating the store')
    upsertActivity(db, { session: 's1', project: 'p', stream: '', agent: 'claude-code', doing: 'session open', idle: true })
    expect(listActivity(db)[0]!.idle).toBe(true)   // effort done → back to idle presence
  })

  it('active entries sort before idle ones', () => {
    upsertActivity(db, { session: 'idle-1', project: 'p', stream: '', agent: 'a', doing: 'session open', idle: true })
    upsertActivity(db, { session: 'busy-1', project: 'p', stream: '', agent: 'a', doing: 'working hard' })
    expect(listActivity(db).map((x) => x.session)).toEqual(['busy-1', 'idle-1'])
  })

  it('endActivity removes the entry from the live list', () => {
    upsertActivity(db, { session: 's1', project: 'p', stream: '', agent: 'a', doing: 'work' })
    endActivity(db, 's1')
    expect(listActivity(db)).toHaveLength(0)
    endActivity(db, 'never-existed') // no-op, no throw
  })

  it('stale entries drop out of the live list', () => {
    upsertActivity(db, { session: 'old', project: 'p', stream: '', agent: 'a', doing: 'ancient work' })
    // backdate the heartbeat well past the staleness window
    db.prepare(`UPDATE activity SET updated_at = ? WHERE session = ?`)
      .run(new Date(Date.now() - 60 * 60000).toISOString(), 'old')
    expect(listActivity(db)).toHaveLength(0)
    expect(listActivity(db, { staleMinutes: 90 })).toHaveLength(1) // window is configurable
  })
})

describe('boards', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const rows = [
    { label: 'theme', status: 'done' as const, note: 'both modes' },
    { label: 'stems', status: 'partial' as const },
    { label: 'mobile', status: 'tracked' as const, note: '#29' },
    { label: 'multi', status: 'missing' as const },
    { label: 'legacy', status: 'na' as const },
  ]

  it('upsert creates a board with rows, defaults note to empty', () => {
    const { boardId, rowCount } = upsertBoard(db, { project: 'p', stream: 'main', agent: 'claude-code', title: 'coverage', rows })
    expect(boardId).toBeTruthy()
    expect(rowCount).toBe(5)
    const board = listBoards(db)[0]!
    expect(board.title).toBe('coverage')
    expect(board.status).toBe('active')
    expect(board.rows.map((r) => r.label)).toEqual(['theme', 'stems', 'mobile', 'multi', 'legacy'])
    expect(board.rows[1]!.note).toBe('') // partial had no note
    expect(board.rows[0]!.annotation).toBeNull()
  })

  it('upsert is idempotent by (project, title) and reconciles rows by label', () => {
    const first = upsertBoard(db, { project: 'p', stream: 'main', agent: 'claude-code', title: 'coverage', rows })
    const second = upsertBoard(db, {
      project: 'p', stream: 'other', agent: 'claude-code', title: 'coverage',
      rows: [
        { label: 'theme', status: 'done', note: 'still good' }, // updated note
        { label: 'stems', status: 'done' },                     // partial → done
        { label: 'new', status: 'missing' },                    // added
      ],                                                          // 'mobile','multi','legacy' dropped
    })
    expect(second.boardId).toBe(first.boardId)          // same board
    expect(listBoards(db)).toHaveLength(1)
    const board = listBoards(db)[0]!
    expect(board.rows.map((r) => r.label)).toEqual(['theme', 'stems', 'new'])
    expect(board.rows[0]!.note).toBe('still good')
    expect(board.rows[1]!.status).toBe('done')
    expect(board.stream).toBe('other')                  // last writer recorded
  })

  it('upsert preserves a human annotation on a surviving row', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows })
    const themeId = listBoards(db)[0]!.rows.find((r) => r.label === 'theme')!.id
    annotateBoardRow(db, themeId, 'look here')
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'theme', status: 'partial' }] })
    const theme = listBoards(db)[0]!.rows.find((r) => r.label === 'theme')!
    expect(theme.status).toBe('partial')      // agent content updated
    expect(theme.annotation).toBe('look here') // human note preserved
  })

  it('updateBoardRow updates one row, and creates board+row when absent (default status tracked)', () => {
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'fresh', label: 'deploy', note: 'pending' })
    const board = listBoards(db)[0]!
    expect(board.title).toBe('fresh')
    expect(board.rows[0]!.status).toBe('tracked') // default for a new row with no status
    expect(board.rows[0]!.note).toBe('pending')
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'fresh', label: 'deploy', status: 'partial' })
    const after = listBoards(db)[0]!.rows[0]!
    expect(after.status).toBe('partial')
    expect(after.note).toBe('pending') // note untouched when omitted
  })

  it('rows carry an optional long-form context, defaulting to empty', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [
      { label: 'x', status: 'partial', context: 'tried A first; blocked on B — see PR #4' },
      { label: 'y', status: 'done' },
    ] })
    const b = listBoards(db)[0]!
    expect(b.rows[0]!.context).toBe('tried A first; blocked on B — see PR #4')
    expect(b.rows[1]!.context).toBe('')
  })

  it('upsert updates context like note, still preserving the human annotation', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing', context: 'v1' }] })
    const rowId = listBoards(db)[0]!.rows[0]!.id
    annotateBoardRow(db, rowId, 'human note')
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'partial', context: 'v2' }] })
    const row = listBoards(db)[0]!.rows[0]!
    expect(row.context).toBe('v2')            // agent-owned, last write wins
    expect(row.annotation).toBe('human note') // human-owned, preserved
  })

  it('updateBoardRow sets context, and leaves it when omitted', () => {
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'c', label: 'x', status: 'partial', context: 'long story' })
    expect(listBoards(db)[0]!.rows[0]!.context).toBe('long story')
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'c', label: 'x', status: 'missing' })
    const row = listBoards(db)[0]!.rows[0]!
    expect(row.status).toBe('missing')
    expect(row.context).toBe('long story') // untouched when omitted
  })

  it('openDb migrates a pre-context db by adding the column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-legacy-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE board_rows (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        annotation TEXT,
        position INTEGER NOT NULL,
        UNIQUE(board_id, label)
      );
    `)
    legacy.close()
    const db2 = openDb(path)
    upsertBoard(db2, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'partial', context: 'why' }] })
    expect(listBoards(db2)[0]!.rows[0]!.context).toBe('why')
  })

  it('a board reaching 100% auto-archives; a later agent write reactivates it', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'ship it', rows: [
      { label: 'a', status: 'done' }, { label: 'b', status: 'done' },
    ] })
    expect(listBoards(db)).toHaveLength(0) // complete → straight to archived
    expect(listBoards(db, { status: 'archived' })[0]!.title).toBe('ship it')
    // the flicker case: the agent keeps working — board comes back
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'ship it', label: 'c', status: 'tracked' })
    expect(listBoards(db)[0]!.title).toBe('ship it')
    expect(listBoards(db, { status: 'archived' })).toHaveLength(0)
  })

  it('all-na boards do not auto-archive (countable 0 is not complete)', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'n/a only', rows: [{ label: 'x', status: 'na' }] })
    expect(listBoards(db)).toHaveLength(1)
  })

  it('archive hides a board from the default (active) list', () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows })
    archiveBoard(db, boardId)
    expect(listBoards(db)).toHaveLength(0)
    expect(listBoards(db, { status: 'archived' })).toHaveLength(1)
  })

  it('unarchive restores a board to the active list and bumps updated_at', () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows })
    archiveBoard(db, boardId)
    const archived = listBoards(db, { status: 'archived' })[0]!
    unarchiveBoard(db, boardId)
    expect(listBoards(db, { status: 'archived' })).toHaveLength(0)
    const active = listBoards(db)
    expect(active).toHaveLength(1)
    expect(active[0]!.status).toBe('active')
    expect(active[0]!.updated_at >= archived.updated_at).toBe(true)
  })

  it('computeProgress weights done=1, partial=0.5, missing/tracked=0, excludes na', () => {
    const board = (() => { upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows }); return listBoards(db)[0]! })()
    const p = board.progress
    expect(p.total).toBe(5)
    expect(p.na).toBe(1)
    expect(p.countable).toBe(4)                 // 5 - 1 na
    expect(p.done).toBe(1); expect(p.partial).toBe(1); expect(p.missing).toBe(1); expect(p.tracked).toBe(1)
    expect(p.fraction).toBeCloseTo((1 + 0.5) / 4) // 0.375
  })

  it('computeProgress of an empty board is fraction 0, not NaN', () => {
    expect(computeProgress([] as BoardRow[]).fraction).toBe(0)
  })

  it('blocked rows are countable, earn no credit, and are tallied for escalation', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [
      { label: 'shipped', status: 'done' },
      { label: 'needs human call', status: 'blocked', note: 'pick a vendor' },
    ] })
    const p = listBoards(db)[0]!.progress
    expect(p.blocked).toBe(1)
    expect(p.countable).toBe(2)          // blocked is real work, not n/a
    expect(p.fraction).toBeCloseTo(0.5)  // and it earns nothing until unblocked
    expect(listBoards(db)[0]!.rows[1]!.status).toBe('blocked')
  })
})

describe('unseen annotations', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  function seed(): { boardId: string; rowId: string } {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing' }] })
    return { boardId, rowId: listBoards(db)[0]!.rows[0]!.id }
  }

  it('an annotation on a never-read board is unseen and stamped', () => {
    const { rowId } = seed()
    annotateBoardRow(db, rowId, 'look here')
    const row = listBoards(db)[0]!.rows[0]!
    expect(row.annotated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.annotation_unseen).toBe(true)
  })

  it('rows without an annotation are never unseen', () => {
    seed()
    expect(listBoards(db)[0]!.rows[0]!.annotation_unseen).toBe(false)
  })

  it('markBoardRead clears unseen; a later annotation re-raises it', async () => {
    const { boardId, rowId } = seed()
    annotateBoardRow(db, rowId, 'first note')
    markBoardRead(db, boardId)
    const board = listBoards(db)[0]!
    expect(board.last_read_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(board.rows[0]!.annotation_unseen).toBe(false)
    await new Promise((r) => setTimeout(r, 5)) // let the clock tick past last_read_at
    annotateBoardRow(db, rowId, 'second note')
    expect(listBoards(db)[0]!.rows[0]!.annotation_unseen).toBe(true)
  })

  it('getBoard derives the same unseen flag', () => {
    const { rowId } = seed()
    annotateBoardRow(db, rowId, 'psst')
    expect(getBoard(db, 'p', 'c')!.rows[0]!.annotation_unseen).toBe(true)
  })

  it('openDb migrates legacy tables missing last_read_at/annotated_at', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-legacy2-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project, title)
      );
      CREATE TABLE board_rows (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '', annotation TEXT,
        position INTEGER NOT NULL, UNIQUE(board_id, label)
      );
    `)
    legacy.close()
    const db2 = openDb(path)
    const { boardId } = upsertBoard(db2, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'partial' }] })
    annotateBoardRow(db2, listBoards(db2)[0]!.rows[0]!.id, 'note')
    markBoardRead(db2, boardId)
    expect(listBoards(db2)[0]!.rows[0]!.annotation_unseen).toBe(false)
  })
})

describe('getBoard (agent read)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('returns one board with rows + progress, scoped by project+title', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'cov', rows: [
      { label: 'x', status: 'done' }, { label: 'y', status: 'partial' },
    ] })
    upsertBoard(db, { project: 'other', stream: '', agent: 'a', title: 'cov', rows: [{ label: 'z', status: 'missing' }] })
    const b = getBoard(db, 'p', 'cov')!
    expect(b.title).toBe('cov')
    expect(b.rows.map((r) => r.label)).toEqual(['x', 'y'])   // project-scoped, not 'other's row
    expect(b.progress.fraction).toBeCloseTo((1 + 0.5) / 2)
  })

  it('surfaces a human annotation and the row context to the reader', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'cov', rows: [{ label: 'x', status: 'missing', context: 'backstory' }] })
    const rowId = getBoard(db, 'p', 'cov')!.rows[0]!.id
    annotateBoardRow(db, rowId, 'do this next')
    const row = getBoard(db, 'p', 'cov')!.rows[0]!
    expect(row.annotation).toBe('do this next')
    expect(row.context).toBe('backstory')
  })

  it('returns undefined for a missing or archived board', () => {
    expect(getBoard(db, 'p', 'nope')).toBeUndefined()
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'cov', rows: [{ label: 'x', status: 'done' }] })
    archiveBoard(db, boardId)
    expect(getBoard(db, 'p', 'cov')).toBeUndefined()
  })
})

describe('item session (liveness)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('items record the asking session; absent session is null', () => {
    const asked = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'which db?', session: 'sess-42' })
    const anon = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'note', title: 'no session' })
    const items = listItems(db)
    expect(items.find((i) => i.id === asked)!.session).toBe('sess-42')
    expect(items.find((i) => i.id === anon)!.session).toBeNull()
  })

  it('listPending surfaces the session on open questions', () => {
    insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q', session: 'sess-7' })
    expect(listPending(db, 'p')[0]!.session).toBe('sess-7')
  })

  it('openDb migrates a legacy items table missing the session column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-legacy4-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', kind TEXT NOT NULL, title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
        annotation TEXT, created_at TEXT NOT NULL, resolved_at TEXT
      );
    `)
    legacy.close()
    const db2 = openDb(path)
    insertItem(db2, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q', session: 'sess-legacy' })
    expect(listItems(db2)[0]!.session).toBe('sess-legacy')
  })
})

// ── issue #32: close / reopen a project ──────────────────────────────────────
// Closure is PRESENTATION state, stored sparsely (one row per project the human
// actually closed). Reopen is DERIVED, never written: a project stops being
// closed the moment new CONTENT is created in it. That keeps insertItem
// byte-identical — the fail-open flag path gains no new write and no new failure
// mode — and makes the reopen atomic with the very insert that raises the
// question.
//
// Timestamp note: created_at/closed_at are ISO-8601 UTC strings with millisecond
// resolution and the predicate is strict `>`. Any test that CLOSES and then
// writes must sleep ≥2ms between the two, or both stamps can land in the same
// millisecond and the write will not read as "after". Tests that write and THEN
// close need no sleep — equal stamps correctly leave the project closed.
describe('project close / reopen (issue #32)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const tick = () => new Promise((r) => setTimeout(r, 5))

  it('closeProject closes a project and closedProjects reports it', () => {
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'q' })
    closeProject(db, 'dead')
    expect(closedProjects(db)).toEqual(['dead'])
  })

  it('reopenProject clears the closure', () => {
    closeProject(db, 'dead')
    reopenProject(db, 'dead')
    expect(closedProjects(db)).toEqual([])
    expect(listClosedProjects(db)).toEqual([])
  })

  it('a new item created after closed_at implicitly reopens the project', async () => {
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'old' })
    closeProject(db, 'dead')
    expect(closedProjects(db)).toEqual(['dead'])
    await tick()
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'new' })
    expect(closedProjects(db)).toEqual([])
  })

  it('an item created BEFORE closed_at leaves the project closed', async () => {
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'old' })
    await tick()
    closeProject(db, 'dead')
    expect(closedProjects(db)).toEqual(['dead'])
  })

  it('a NEW board created after closed_at implicitly reopens the project', async () => {
    closeProject(db, 'dead')
    await tick()
    upsertBoard(db, { project: 'dead', stream: '', agent: 'a', title: 'rollout', rows: [{ label: 'x', status: 'tracked' }] })
    expect(closedProjects(db)).toEqual([])
  })

  it('a board merely re-upserted after closed_at does NOT reopen it (updated_at moves, created_at does not)', async () => {
    upsertBoard(db, { project: 'dead', stream: '', agent: 'a', title: 'rollout', rows: [{ label: 'x', status: 'tracked' }] })
    await tick()
    closeProject(db, 'dead')
    await tick()
    upsertBoard(db, { project: 'dead', stream: '', agent: 'a', title: 'rollout', rows: [{ label: 'x', status: 'done' }] })
    expect(closedProjects(db)).toEqual(['dead'])
  })

  it('a live session in a closed project does NOT reopen it — presence is not attention', async () => {
    closeProject(db, 'dead')
    await tick()
    upsertActivity(db, { session: 's1', project: 'dead', stream: '', agent: 'a', doing: 'poking around' })
    expect(closedProjects(db)).toEqual(['dead'])
  })

  it('closing again after an implicit reopen re-closes it', async () => {
    closeProject(db, 'dead')
    await tick()
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'new' })
    expect(closedProjects(db)).toEqual([])
    await tick()
    closeProject(db, 'dead')
    expect(closedProjects(db)).toEqual(['dead'])
  })

  it('closeProject is idempotent — one row per project, never a duplicate', () => {
    closeProject(db, 'dead')
    closeProject(db, 'dead')
    expect(listClosedProjects(db)).toHaveLength(1)
    expect(closedProjects(db)).toEqual(['dead'])
  })

  it('closing deletes nothing — items and boards survive intact', () => {
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'still here' })
    upsertBoard(db, { project: 'dead', stream: '', agent: 'a', title: 'board', rows: [{ label: 'x', status: 'tracked' }] })
    const itemsBefore = listItems(db)
    const boardsBefore = listBoards(db)
    closeProject(db, 'dead')
    expect(listItems(db)).toHaveLength(itemsBefore.length)
    expect(listBoards(db)).toHaveLength(boardsBefore.length)
    expect(listItems(db)[0]!.title).toBe('still here')
    expect(listBoards(db)[0]!.rows[0]!.label).toBe('x')
  })

  it('closedProjects is sorted and scopes per project — closing one leaves the others open', () => {
    closeProject(db, 'zed')
    closeProject(db, 'alpha')
    expect(closedProjects(db)).toEqual(['alpha', 'zed'])
    insertItem(db, { project: 'live', stream: '', agent: 'a', kind: 'question', title: 'q' })
    expect(closedProjects(db)).toEqual(['alpha', 'zed'])
  })

  it('listClosedProjects returns the raw rows, newest closure first, including implicitly-reopened ones', async () => {
    closeProject(db, 'alpha')
    await tick()
    closeProject(db, 'zed')
    await tick()
    insertItem(db, { project: 'alpha', stream: '', agent: 'a', kind: 'question', title: 'back' })
    expect(listClosedProjects(db).map((c) => c.project)).toEqual(['zed', 'alpha'])
    // …which is exactly why a consumer that wants the EFFECTIVE set must use
    // closedProjects(), not this raw list
    expect(closedProjects(db)).toEqual(['zed'])
    expect(listClosedProjects(db)[0]!.closed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
