import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  markAnnotationDelivered,
  listPendingAnnotations,
  listBoards,
  computeProgress,
  getBoard,
  markBoardRead,
  upsertActivity,
  endActivity,
  listActivity,
  touchActivity,
  recordActivityCall,
  CLAIM_COLD_MS,
  closeProject,
  reopenProject,
  listClosedProjects,
  closedProjects,
  upsertSourceLink,
  recordLinkFailure,
  listSourceLinks,
  listLinkTargets,
  pruneSourceLinks,
} from '../src/store.js'
import type { BoardRow } from '../src/store.js'

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
  return openDb(join(dir, 'inbox.db'))
}

// What an agent's `pending()` does: read the item, then stamp pickup against the
// exact `replied_at` it just read (issue #37's compare-and-swap). Fixtures that
// only mean "the agent has picked this up" go through here so none of them has to
// know the guard's shape.
function pickUp(d: Database.Database, id: string): boolean {
  return markReplySeen(d, id, listItems(d).find((i) => i.id === id)!.replied_at)
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
    pickUp(db, id)
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
    pickUp(db, id)
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
          pickUp(db2, id) // race lands right after the (stale) read
          return result
        }) as typeof stmt.get
        stmt.run = ((...args: unknown[]) => {
          pickUp(db2, id) // race lands right before the conditioned write
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

  // issue #37 (the item half of the same class of bug). markReplySeen used to be
  // an unconditional `UPDATE items SET reply_seen_at = ? WHERE id = ?`, while
  // replyItem resets reply_seen_at = NULL from the VIEWER's process. Same T1–T4
  // interleaving as the board-row race below: the agent reads 'go left', the human
  // changes their answer to 'go right', the agent's stamp lands — and 'go right' is
  // now marked picked up by an agent that never saw it, and no future pending()
  // returns it. Forced with two real connections rather than reasoned about.
  it('markReplySeen refuses to stamp an answer the human replaced under the agent', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-reply-race-')), 'inbox.db')
    const mcp = openDb(path)
    const viewer = new Database(path)
    viewer.pragma('journal_mode = WAL')
    viewer.pragma('busy_timeout = 5000')

    const id = insertItem(mcp, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'left or right?' })
    replyItem(viewer, id, 'go left')                                     // T1
    const read = listPending(mcp, 'p')[0]!                               // T2
    expect(read.reply).toBe('go left')
    await new Promise((r) => setTimeout(r, 5))
    replyItem(viewer, id, 'actually go right')                           // T3
    expect(markReplySeen(mcp, id, read.replied_at)).toBe(false)          // T4

    const item = listItems(mcp).find((i) => i.id === id)!
    expect(item.reply).toBe('actually go right')
    expect(item.reply_seen_at, 'the newest answer must stay deliverable').toBeNull()
    viewer.close()
    mcp.close()
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
    pickUp(db, id)
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
    pickUp(db, inbox)
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

// ── issue #45: the claim decays, the session does not ────────────────────────
//
// The 5-minute heartbeat bumps the SAME `updated_at` the 15-minute cutoff reads,
// so while a process lives the cutoff is unreachable and a `doing` claim outlives
// the work it describes — rows were observed advertising a 2-day-old effort.
// The ROW is honest (that CLI really is running); the CLAIM is not. So there are
// now two stamps: `updated_at` = liveness (heartbeat OR real call), `last_call_at`
// = real MCP calls only. Expiring the row was the wrong fix — it would hide a
// live agent, and `classifyLiveness` would demote that agent's open question from
// "waiting" to "parked", so the badge would lose a genuinely blocked session.
describe('live activity — the doing claim decays, the presence row does not (#45)', () => {
  let db: Database.Database
  const START = Date.parse('2026-07-25T09:00:00.000Z')

  beforeEach(() => {
    db = freshDb()
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => { vi.useRealTimers() })

  const claim = (session = 's1', doing = 'Executing Track B — 18-task viewer redesign'): void => {
    upsertActivity(db, { session, project: 'agent-inbox', stream: 'main', agent: 'claude-code', doing, detail: 'task 7 of 18', children: [{ name: 'kid', doing: 'grep' }] })
    recordActivityCall(db, session) // status() heartbeats like every other tool call
  }

  it('a heartbeat keeps the session listed but never renews the claim', () => {
    claim()
    vi.setSystemTime(Date.now() + CLAIM_COLD_MS + 60_000)
    touchActivity(db, 's1') // the 5-minute timer in src/mcp.ts, exactly as it fires
    const live = listActivity(db)
    expect(live).toHaveLength(1)          // NOT expired — the CLI really is running
    expect(live[0]!.doing).toBe('open')
    expect(live[0]!.idle).toBe(true)
    expect(live[0]!.detail).toBe('')      // detail and children belong to the claim
    expect(live[0]!.children).toEqual([])
  })

  it('a long silent stretch BELOW the threshold keeps the claim — a big test run is still working', () => {
    claim()
    vi.setSystemTime(Date.now() + CLAIM_COLD_MS - 60_000)
    touchActivity(db, 's1')
    const live = listActivity(db)
    expect(live[0]!.doing).toBe('Executing Track B — 18-task viewer redesign')
    expect(live[0]!.idle).toBe(false)
    expect(live[0]!.children).toHaveLength(1)
  })

  it('a claim 25 minutes old is still live — the threshold is a real duration, not just CLAIM_COLD_MS', () => {
    // Every other assertion in this file writes CLAIM_COLD_MS ± 60s, so all of
    // them MOVE with the constant: 30 min → 5 min ships green through the lot.
    // Below is the dangerous direction — a 5-minute threshold would erase a true
    // claim during any ordinary six-minute silence, which is exactly what the
    // THRESHOLD paragraph argues 30 minutes buys protection against. 25 real
    // minutes is the floor, written as a number so it cannot follow the constant.
    // (The ceiling is already absolute: 'the FIRST call after a silence' below
    // waits 3 real hours, so 30 min → 300 min dies there.)
    claim()
    vi.setSystemTime(START + 25 * 60_000)
    touchActivity(db, 's1')
    const live = listActivity(db)[0]!
    expect(live.doing).toBe('Executing Track B — 18-task viewer redesign')
    expect(live.idle).toBe(false)
  })

  it('the FIRST call after a silence clears the stale claim instead of resurrecting it', () => {
    // Read-side decay alone is not enough: the observed rows belonged to CLIs
    // that were still polling. Any later tool call would have re-listed a
    // days-old claim as live work.
    claim()
    vi.setSystemTime(Date.now() + 3 * 60 * 60_000)
    recordActivityCall(db, 's1') // a routine pending() poll, nothing else
    const live = listActivity(db)
    expect(live[0]!.doing).toBe('open')
    expect(live[0]!.idle).toBe(true)
    expect(live[0]!.children).toEqual([])
  })

  it('status({doing}) re-asserts immediately, however long the silence was', () => {
    claim()
    vi.setSystemTime(Date.now() + 8 * 60 * 60_000)
    recordActivityCall(db, 's1') // heartbeat() runs FIRST in the status handler
    upsertActivity(db, { session: 's1', project: 'agent-inbox', stream: 'main', agent: 'claude-code', doing: 'reviewing #45' })
    const live = listActivity(db)
    expect(live[0]!.doing).toBe('reviewing #45')
    expect(live[0]!.idle).toBe(false)
    expect(live[0]!.detail).toBe('') // the decayed claim's detail did not survive into the new one
  })

  it('only a real call writes last_call_at; the timer moves liveness alone', () => {
    claim()
    const called = listActivity(db)[0]!.last_call_at
    expect(called).toBe(new Date(START).toISOString())
    vi.setSystemTime(Date.now() + 10 * 60_000)
    touchActivity(db, 's1')
    const live = listActivity(db)[0]!
    expect(live.last_call_at).toBe(called)          // untouched — this is the whole distinction
    expect(live.updated_at > called!).toBe(true)    // liveness DID move
  })

  it('a session that has never called anything is not born cold', () => {
    // registerPresence writes the row before any tool call, so last_call_at is
    // NULL and started_at stands in for it
    upsertActivity(db, { session: 'fresh', project: 'p', stream: '', agent: 'a', doing: 'open', idle: true })
    const live = listActivity(db)
    expect(live).toHaveLength(1)
    expect(live[0]!.last_call_at).toBeNull()
    expect(live[0]!.doing).toBe('open')
  })

  it('long-idle sessions sink below recently active ones — the strip stays glanceable', () => {
    // DECIDED: a session idle for days keeps its row (removing it would hide a
    // live agent and demote its questions out of "waiting"), but it sorts last.
    //
    // The fixture is shaped so that EVERY order the query could hand back lists
    // `forgotten` FIRST — it is inserted first (rowid order) and its heartbeat
    // is the oldest of the three (the idx_activity_live index order). Only
    // sorting on the real-call stamp moves it to the bottom, so a comparator
    // that does nothing cannot pass by luck.
    upsertActivity(db, { session: 'forgotten', project: 'p', stream: '', agent: 'a', doing: 'open', idle: true })
    recordActivityCall(db, 'forgotten')
    vi.setSystemTime(Date.now() + 9 * 60 * 60_000)
    touchActivity(db, 'forgotten') // its CLI is alive, so the heartbeat keeps it listed
    vi.setSystemTime(Date.now() + 2 * 60_000)
    upsertActivity(db, { session: 'quiet', project: 'p', stream: '', agent: 'a', doing: 'open', idle: true })
    recordActivityCall(db, 'quiet')
    vi.setSystemTime(Date.now() + 2 * 60_000)
    upsertActivity(db, { session: 'busy', project: 'p', stream: '', agent: 'a', doing: 'shipping' })
    recordActivityCall(db, 'busy')
    expect(listActivity(db).map((x) => x.session)).toEqual(['busy', 'quiet', 'forgotten'])
  })

  it('a decayed session is still a LIVE session — the row, and its id, survive', () => {
    // public/attention.js classifies an item as "waiting" iff its session id is
    // in /api/activity. Expiring the row would silently downgrade a real
    // blocker; decaying the claim must not.
    claim()
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60_000)
    touchActivity(db, 's1')
    expect(listActivity(db).map((x) => x.session)).toEqual(['s1'])
  })
})

// ── registering presence is not claiming work ────────────────────────────────
//
// src/mcp.ts arms `setTimeout(registerPresence, 2000)` in case the initialize
// notification never arrives, and it fires UNCONDITIONALLY. Through a conflict
// clause that always wrote `doing`/`idle`, that silently wiped any claim made in
// a session's first two seconds — isolated with two real spawned servers
// differing only in when status() was called, and reproduced three times out of
// three (claim at ~0.6s, gone at ~2.4s). It also quietly contradicted the
// `status` description's "it re-asserts instantly": it does, unless you are a
// fast agent reporting your first phase immediately.
//
// So the write has two modes and the caller picks. CLAIMING is the default and is
// unchanged — `status({done:true})` legitimately reverts `doing` to 'open', so
// that path must keep clobbering. REGISTERING (`claim: false`) asserts only "this
// session is here": scope, liveness, not-ended. It never speaks for the agent.
describe('live activity — registering presence never overwrites a claim', () => {
  let db: Database.Database
  const START = Date.parse('2026-07-25T09:00:00.000Z')

  beforeEach(() => {
    db = freshDb()
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => { vi.useRealTimers() })

  // byte-for-byte what registerPresence sends
  const register = (session = 's1'): void => {
    upsertActivity(db, { session, project: 'agent-inbox', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false })
  }
  const workingOn = (doing: string): void => {
    upsertActivity(db, { session: 's1', project: 'agent-inbox', stream: 'main', agent: 'claude-code', doing, detail: 'reading store.ts', children: [{ name: 'kid', doing: 'grep' }] })
  }

  it('the registration write src/mcp.ts actually sends leaves doing, detail, children and idle untouched', () => {
    workingOn('planning the migration')
    vi.setSystemTime(START + 2000) // the handshake fallback, two seconds in
    register()
    const live = listActivity(db)[0]!
    expect(live.doing).toBe('planning the migration')
    expect(live.detail).toBe('reading store.ts')
    expect(live.children).toHaveLength(1)
    expect(live.idle).toBe(false)
  })

  it('claim: false ignores doing, detail, children and idle even when all four are supplied', () => {
    // The test above cannot see two of the four guards. registerPresence sends no
    // detail and no children, and `COALESCE(NULLIF(@detail,''), detail)` already
    // no-ops on an empty string — so dropping those guards passes it. The store's
    // contract is the stronger thing and this is what pins it: `claim: false`
    // means "I am not speaking for the agent", whatever the caller happens to
    // pass. A future registration path that starts sending a detail must not
    // become able to wipe one.
    workingOn('planning the migration')
    vi.setSystemTime(START + 2000)
    upsertActivity(db, {
      session: 's1', project: 'agent-inbox', stream: 'main', agent: 'claude-code',
      doing: 'open', detail: 'registered', children: [], idle: true, claim: false,
    })
    const live = listActivity(db)[0]!
    expect(live.doing).toBe('planning the migration')
    expect(live.detail).toBe('reading store.ts')
    expect(live.children).toHaveLength(1)
    expect(live.idle).toBe(false)
  })

  it('claim: false still refreshes scope and liveness, and un-ends the row', () => {
    // registration is not a no-op: it is how a session says where it is and that
    // it is still here. Only the CLAIM is off limits.
    upsertActivity(db, { session: 's1', project: 'stale-guess', stream: 'stale-branch', agent: 'stale-agent', doing: 'planning the migration' })
    const before = listActivity(db)[0]!
    endActivity(db, 's1')
    expect(listActivity(db)).toHaveLength(0)

    vi.setSystemTime(START + 2000)
    register()
    const after = listActivity(db)[0]!
    expect(after.project).toBe('agent-inbox')
    expect(after.stream).toBe('main')
    expect(after.agent).toBe('claude-code')
    expect(after.updated_at > before.updated_at).toBe(true)
    expect(after.doing).toBe('planning the migration')
  })

  it('claim: false on a session with no row yet writes the idle presence row', () => {
    register('fresh')
    const live = listActivity(db)
    expect(live).toHaveLength(1)
    expect(live[0]!.doing).toBe('open')
    expect(live[0]!.idle).toBe(true)
    expect(live[0]!.last_call_at).toBeNull() // registration is not a tool call
  })

  it('the default is still claiming — status({done:true}) reverts doing to open', () => {
    workingOn('planning the migration')
    vi.setSystemTime(START + 60_000)
    // the done:true branch of the status handler, verbatim
    upsertActivity(db, { session: 's1', project: 'agent-inbox', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, children: [] })
    const live = listActivity(db)[0]!
    expect(live.doing).toBe('open')
    expect(live.idle).toBe(true)
    expect(live.children).toEqual([])
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

  // Issue #42, the read-modify-write hole. Every document prescribes
  // board_get → board_upsert ("re-read the board before updating it",
  // "re-send the whole table"), and MCP reads no longer carry `context` at all —
  // they carry `context_chars`. So the table an agent faithfully re-sends has no
  // `context` field on any row. If an absent field meant DELETE, following the
  // documented flow would wipe every row's backstory. It means KEEP.
  it('a re-upsert that omits context keeps the stored text — omission is not deletion (#42)', () => {
    const backstory = 'tried A first; blocked on B — see PR #4'
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing', note: 'n1', context: backstory }] })
    annotateBoardRow(db, listBoards(db)[0]!.rows[0]!.id, 'human note')
    // exactly what an agent can rebuild from a shaped read: label, status, note — no context
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'partial', note: 'n2' }] })
    const row = listBoards(db)[0]!.rows[0]!
    expect(row.context).toBe(backstory) // survived the round-trip
    expect(row.status).toBe('partial')  // the fields it DID send still won
    expect(row.note).toBe('n2')
    expect(row.annotation).toBe('human note')
  })

  it('an explicit empty context clears it — deliberate erasure is still possible (#42)', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing', context: 'stale backstory' }] })
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing', context: '' }] })
    expect(listBoards(db)[0]!.rows[0]!.context).toBe('')
  })

  // The row rule is NOT softened by the field rule: a label left out of the
  // table is still gone, annotation and all. That is what makes labels the
  // stable identity agents are told to keep.
  it('a ROW absent from an upsert is still deleted — only the FIELD rule changed (#42)', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [
      { label: 'x', status: 'missing', context: 'keep me' }, { label: 'y', status: 'missing', context: 'drop me' },
    ] })
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing' }] })
    const rows = listBoards(db)[0]!.rows
    expect(rows.map((r) => r.label)).toEqual(['x'])
    expect(rows[0]!.context).toBe('keep me')
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

  // issue #37 turned this rule inside out, deliberately. `boards.last_read_at`
  // is BOARD-level: one board_get marked every row's annotation seen, including
  // rows the agent never looked at — and `board_get({})` (no title) did it to
  // every board in the project at once. That is how the wild "merge it" note
  // went quiet a day later with nobody having read it. Unseen is now per-ROW
  // (`board_rows.annotation_seen_at`, the honest model items already had), and
  // last_read_at keeps being written but has no semantic power left.
  it('markBoardRead no longer marks any row annotation seen — only a per-row delivery does', async () => {
    const { boardId, rowId } = seed()
    annotateBoardRow(db, rowId, 'first note')
    await new Promise((r) => setTimeout(r, 5)) // last_read_at will now be strictly LATER than annotated_at
    markBoardRead(db, boardId)
    const board = listBoards(db)[0]!
    expect(board.last_read_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(board.last_read_at! > board.rows[0]!.annotated_at!, 'the old rule would have called this seen').toBe(true)
    expect(board.rows[0]!.annotation_unseen).toBe(true)
    // …and the consequence that actually matters: it is still queued for delivery
    expect(listPendingAnnotations(db, 'p').map((r) => r.annotation)).toEqual(['first note'])

    // the per-row stamp is the only thing that clears it
    markAnnotationDelivered(db, rowId, board.rows[0]!.annotated_at, 'claude-code')
    expect(listBoards(db)[0]!.rows[0]!.annotation_unseen).toBe(false)

    await new Promise((r) => setTimeout(r, 5))
    annotateBoardRow(db, rowId, 'second note') // a re-annotation re-raises it
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
    upsertBoard(db2, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'partial' }] })
    const rowId = listBoards(db2)[0]!.rows[0]!.id
    annotateBoardRow(db2, rowId, 'note')
    expect(listBoards(db2)[0]!.rows[0]!.annotation_unseen).toBe(true)
    markAnnotationDelivered(db2, rowId, listBoards(db2)[0]!.rows[0]!.annotated_at, 'a')
    expect(listBoards(db2)[0]!.rows[0]!.annotation_unseen).toBe(false)
  })
})

// ── issue #37 ────────────────────────────────────────────────────────────────
// Delivery is not acknowledgement. `annotation_seen_at` records ONE fact — this
// text was handed to some agent — and it silences nothing: the row stays blocked
// and on screen until an agent flips its status. That split is what makes it safe
// for pending() to stamp on return: worst case the human sees "delivered to X, no
// status change since", which is the truth, instead of the alarm vanishing.
describe('per-row annotation delivery (#37)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  function seed(rows: { label: string; status: 'blocked' | 'tracked' | 'partial' }[] = [{ label: 'x', status: 'blocked' }], title = 'c', project = 'p') {
    const { boardId } = upsertBoard(db, { project, stream: 's', agent: 'a', title, rows: rows.map((r) => ({ ...r, note: `note ${r.label}` })) })
    return { boardId, board: () => listBoards(db).find((b) => b.title === title && b.project === project)! }
  }

  // ── F1: rows are AT-LEAST-ONCE, exactly like items ────────────────────────
  // The queue used to be gated on the DELIVERY stamp, so the human's note went to
  // exactly ONE poll from ONE session. This repo fans out subagents constantly:
  // a sibling's incidental poll silently ate the answer, the manager that RAISED
  // the row never got it, and the human's screen then read "delivered to
  // claude-code" — the very signal that tells them to stop chasing it. Items
  // never had that hole because listPending is gated on the ACKNOWLEDGEMENT
  // (status='open'), not on reply_seen_at. Rows now match: the gate is the row
  // still being `blocked`, which is precisely the state the human is still
  // looking at, so the agent's queue and the human's screen go quiet on the SAME
  // event — the agent flipping the status.
  it('keeps handing a blocked row over until an agent ACKNOWLEDGES it (the fan-out hole)', () => {
    const { board } = seed([{ label: 'Merge', status: 'blocked' }, { label: 'QA', status: 'partial' }])
    const rowId = board().rows[0]!.id
    annotateBoardRow(db, rowId, 'merge it')

    // a SUBAGENT polls first and is stamped as the one it went to
    const sub = listPendingAnnotations(db, 'p')
    expect(sub.map((r) => r.annotation)).toEqual(['merge it'])
    markAnnotationDelivered(db, rowId, sub[0]!.annotated_at, 'claude-code')

    // …and the MANAGER — the session that actually raised the row — still gets it
    const manager = listPendingAnnotations(db, 'p')
    expect(manager.map((r) => r.annotation), 'a sibling poll must not eat the human’s note').toEqual(['merge it'])

    // the ack — and only the ack — stops it. Not `done`: that would complete the
    // board and archive it, which would end the delivery for a second reason.
    updateBoardRow(db, { project: 'p', stream: 's', agent: 'a', title: 'c', label: 'Merge', status: 'partial' })
    expect(listPendingAnnotations(db, 'p')).toEqual([])
  })

  // Re-delivery must be SELF-LABELLING or it is a firehose: an agent polling every
  // few seconds has to be able to tell "new to me" from "I have already been handed
  // this and have not acted yet". The delivery stamp is the discriminator, so it
  // rides in the payload.
  it('a re-delivered row carries the delivery stamp, so a reader can tell it is not fresh news', () => {
    const { board } = seed([{ label: 'Merge', status: 'blocked' }])
    const rowId = board().rows[0]!.id
    annotateBoardRow(db, rowId, 'merge it')

    const first = listPendingAnnotations(db, 'p')[0]!
    expect(first.annotation_seen_at, 'nobody has been handed it yet').toBeNull()
    expect(first.annotation_seen_by).toBeNull()
    markAnnotationDelivered(db, rowId, first.annotated_at, 'claude-code')

    const again = listPendingAnnotations(db, 'p')[0]!
    expect(again.annotation_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(again.annotation_seen_by).toBe('claude-code')
  })

  // The human's chip reads "delivered to X 3h ago". That AGE is the evidence that
  // an agent has had the answer for three hours and done nothing — so a second
  // delivery must not refresh it, or the chip would read "delivered moments ago"
  // forever and hide exactly the failure it exists to show.
  it('a second delivery never re-dates or re-attributes the first one', async () => {
    const { board } = seed([{ label: 'Merge', status: 'blocked' }])
    const rowId = board().rows[0]!.id
    annotateBoardRow(db, rowId, 'merge it')
    const stamped = board().rows[0]!.annotated_at
    markAnnotationDelivered(db, rowId, stamped, 'claude-code')
    const first = board().rows[0]!.annotation_seen_at

    await new Promise((r) => setTimeout(r, 5))
    markAnnotationDelivered(db, rowId, stamped, 'codex')
    expect(board().rows[0]!.annotation_seen_at, 'the delivered chip must keep ageing').toBe(first)
    expect(board().rows[0]!.annotation_seen_by).toBe('claude-code')
  })

  // The other half of the rule, and the reason it is not simply "always
  // re-deliver": a row that is NOT blocked has nothing to acknowledge — the note
  // is an aside, not an answer — so it is handed over once and then stays put.
  it('a note on a row that is not blocked is handed over exactly once', () => {
    const { board } = seed([{ label: 'x', status: 'tracked' }])
    const rowId = board().rows[0]!.id
    annotateBoardRow(db, rowId, 'fyi, this one moved')
    const first = listPendingAnnotations(db, 'p')
    expect(first.map((r) => r.annotation)).toEqual(['fyi, this one moved'])
    markAnnotationDelivered(db, rowId, first[0]!.annotated_at, 'claude-code')
    expect(listPendingAnnotations(db, 'p')).toEqual([])
  })

  it('stamps the FIRST delivery only, recording WHO it went to', () => {
    const { board } = seed()
    const rowId = board().rows[0]!.id
    annotateBoardRow(db, rowId, 'merge it')
    let row = board().rows[0]!
    expect(row.annotation_seen_at).toBeNull()
    expect(row.annotation_seen_by).toBeNull()

    expect(markAnnotationDelivered(db, rowId, row.annotated_at, 'claude-code')).toBe(true)
    row = board().rows[0]!
    expect(row.annotation_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.annotation_seen_by).toBe('claude-code')

    // A second reader is NORMAL now that a blocked row is at-least-once, so the
    // return value cannot mean "you were first" — it means only "the text you
    // read is still the text that is there". It says true, and the attribution
    // of the FIRST delivery is what survives.
    expect(markAnnotationDelivered(db, rowId, row.annotated_at, 'codex')).toBe(true)
    expect(board().rows[0]!.annotation_seen_by).toBe('claude-code')
  })

  it('re-annotating resets delivery in the SAME statement that writes the text', async () => {
    const { board } = seed()
    const rowId = board().rows[0]!.id
    annotateBoardRow(db, rowId, 'wait for CI')
    markAnnotationDelivered(db, rowId, board().rows[0]!.annotated_at, 'claude-code')
    await new Promise((r) => setTimeout(r, 5))
    annotateBoardRow(db, rowId, 'merge it')
    const row = board().rows[0]!
    expect(row.annotation).toBe('merge it')
    expect(row.annotation_seen_at, 'a delivered stamp must never be inherited by newer text').toBeNull()
    expect(row.annotation_seen_by).toBeNull()
    expect(listPendingAnnotations(db, 'p').map((r) => r.annotation)).toEqual(['merge it'])
  })

  it('delivering one row does not mark another row seen', () => {
    const { board } = seed([{ label: 'x', status: 'blocked' }, { label: 'y', status: 'blocked' }])
    const [rx, ry] = [board().rows[0]!, board().rows[1]!]
    annotateBoardRow(db, rx.id, 'do x')
    annotateBoardRow(db, ry.id, 'do y')
    markAnnotationDelivered(db, rx.id, board().rows[0]!.annotated_at, 'claude-code')
    expect(board().rows[0]!.annotation_unseen).toBe(false)
    expect(board().rows[1]!.annotation_unseen, 'reading one row must not consume the other').toBe(true)
    // Both are still queued — they are both still blocked, i.e. unacknowledged —
    // but the per-row stamps stay independent, and the queue SHOWS that: the one
    // that was delivered says so, the one that was not says nothing.
    const queued = new Map(listPendingAnnotations(db, 'p').map((r) => [r.label, r.annotation_seen_by]))
    expect([...queued.keys()]).toEqual(['x', 'y'])
    expect(queued.get('x')).toBe('claude-code')
    expect(queued.get('y'), 'a delivery must not attribute a row nobody read').toBeNull()
  })

  // ── the T1–T4 interleaving, FORCED with two real connections ──────────────
  // T1 viewer annotates · T2 MCP SELECTs · T3 the human changes their mind ·
  // T4 MCP stamps. An unconditional stamp at T4 marks 'merge it' delivered to
  // nobody and no future poll ever returns it — the exact shape of the bug
  // replyItem's `AND reply_seen_at IS NULL` guard fixed for items.
  it('the delivery stamp refuses an annotation the human replaced under the reader', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-row-race-')), 'inbox.db')
    const mcp = openDb(path)                        // the MCP server's process
    const viewer = new Database(path)               // the viewer's own process
    viewer.pragma('journal_mode = WAL')
    viewer.pragma('busy_timeout = 5000')

    upsertBoard(mcp, { project: 'p', stream: 's', agent: 'a', title: 'c', rows: [{ label: 'Merge', status: 'blocked' }] })
    const rowId = listBoards(mcp)[0]!.rows[0]!.id
    annotateBoardRow(viewer, rowId, 'wait for CI')                 // T1
    const read = listPendingAnnotations(mcp, 'p')[0]!              // T2
    expect(read.annotation).toBe('wait for CI')
    await new Promise((r) => setTimeout(r, 5))
    annotateBoardRow(viewer, rowId, 'merge it')                    // T3
    expect(markAnnotationDelivered(mcp, rowId, read.annotated_at, 'claude-code')).toBe(false) // T4

    const row = listBoards(mcp)[0]!.rows[0]!
    expect(row.annotation).toBe('merge it')
    expect(row.annotation_seen_at, 'the newest instruction must stay undelivered').toBeNull()
    expect(listPendingAnnotations(mcp, 'p').map((r) => r.annotation)).toEqual(['merge it'])
    viewer.close()
    mcp.close()
  })

  it('listPendingAnnotations is scoped to the project and to ACTIVE boards only', () => {
    const a = seed([{ label: 'x', status: 'blocked' }], 'mine', 'p')
    const other = seed([{ label: 'x', status: 'blocked' }], 'theirs', 'q')
    const gone = seed([{ label: 'x', status: 'blocked' }], 'archived', 'p')
    annotateBoardRow(db, a.board().rows[0]!.id, 'for p')
    annotateBoardRow(db, other.board().rows[0]!.id, 'for q')
    annotateBoardRow(db, gone.board().rows[0]!.id, 'for nobody')
    archiveBoard(db, gone.boardId)

    expect(listPendingAnnotations(db, 'p').map((r) => r.annotation)).toEqual(['for p'])
    expect(listPendingAnnotations(db, 'q').map((r) => r.annotation)).toEqual(['for q'])
    // an archived board is out of board_get too — one rule, not two
    expect(getBoard(db, 'p', 'archived')).toBeUndefined()
  })

  it('carries everything an agent needs to act without a second call', () => {
    const { boardId, board } = seed([{ label: 'Merge', status: 'blocked' }])
    annotateBoardRow(db, board().rows[0]!.id, 'merge it')
    const [row] = listPendingAnnotations(db, 'p')
    expect(row).toMatchObject({
      board_id: boardId, board_title: 'c', project: 'p', stream: 's', agent: 'a',
      row_id: board().rows[0]!.id, label: 'Merge', status: 'blocked', note: 'note Merge', annotation: 'merge it',
    })
  })

  it('an empty annotation is not pending work', () => {
    const { board } = seed()
    annotateBoardRow(db, board().rows[0]!.id, '')
    expect(listPendingAnnotations(db, 'p')).toEqual([])
    expect(board().rows[0]!.annotation_unseen).toBe(false)
  })

  // upsertBoard's contract (CLAUDE.md): the human's per-row notes are sacred and
  // survive a full re-upsert. #37 adds two more columns that must survive with them
  // — a re-upsert that reset the stamp would re-attribute the note to whoever
  // polled next and reset the "delivered 3h ago" age the human reads as evidence.
  it('upsertBoard clobbers neither the annotation nor its delivery state', () => {
    const { board } = seed([{ label: 'Merge', status: 'blocked' }])
    const rowId = board().rows[0]!.id
    annotateBoardRow(db, rowId, 'merge it')
    markAnnotationDelivered(db, rowId, board().rows[0]!.annotated_at, 'claude-code')
    const before = board().rows[0]!

    upsertBoard(db, { project: 'p', stream: 's', agent: 'a', title: 'c', rows: [{ label: 'Merge', status: 'blocked', note: 'still stuck' }] })
    const after = board().rows[0]!
    expect(after.note).toBe('still stuck')
    expect(after.annotation).toBe('merge it')
    expect(after.annotated_at).toBe(before.annotated_at)
    expect(after.annotation_seen_at).toBe(before.annotation_seen_at)
    expect(after.annotation_seen_by).toBe('claude-code')
    // It is still queued — an agent re-upserting the board while leaving the row
    // blocked has not acknowledged anything — but it is queued as an ALREADY
    // DELIVERED row, carrying the original stamp rather than reading as new.
    expect(listPendingAnnotations(db, 'p').map((r) => r.annotation_seen_at)).toEqual([before.annotation_seen_at])

    // …and that surviving stamp is load-bearing: the moment the same upsert
    // acknowledges the row, the stamp is what keeps it from being re-delivered.
    upsertBoard(db, { project: 'p', stream: 's', agent: 'a', title: 'c', rows: [{ label: 'Merge', status: 'partial', note: 'merging' }] })
    expect(listPendingAnnotations(db, 'p'), 'an acknowledged row must not re-deliver').toEqual([])
  })

  // The backfill is the whole risk of this change. Without it every existing
  // annotation reads as undelivered on first open — the human's whole board
  // history lights up as "awaiting pickup" — and every already-read aside on a
  // non-blocked row is handed to a live agent that will act on it.
  //
  // What it no longer buys, since rows became at-least-once: a backfilled-as-seen
  // row that is STILL BLOCKED is delivered again, because a blocked row is by
  // definition unacknowledged. That is right, not a leak — such a row is also
  // still sitting in the human's Needs-you list right now. (There is exactly one
  // in the live DB: an unmerged "merge it".)
  it('openDb backfills annotation_seen_at from the OLD board-level rule, all four cases', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-seenat-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_read_at TEXT, UNIQUE(project, title)
      );
      CREATE TABLE board_rows (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '', annotation TEXT,
        annotated_at TEXT, position INTEGER NOT NULL, UNIQUE(board_id, label)
      );
      -- board 'read' was read at T2; board 'never' was never read at all
      INSERT INTO boards VALUES ('b-read','p','','a','read','active','T0','T0','2026-07-02T00:00:00.000Z');
      INSERT INTO boards VALUES ('b-never','p','','a','never','active','T0','T0',NULL);
      -- 1 · annotated BEFORE the read → was SEEN. Deliberately NOT blocked: this
      --     is the row that proves the backfill still keeps an old, already-read
      --     aside away from a live agent.
      INSERT INTO board_rows VALUES ('r-seen','b-read','seen','tracked','','','old note','2026-07-01T00:00:00.000Z',0);
      -- 2 · annotated AFTER the read → was UNSEEN
      INSERT INTO board_rows VALUES ('r-after','b-read','after','blocked','','','new note','2026-07-03T00:00:00.000Z',1);
      -- 3 · pre-annotated_at legacy row on a read board → was SEEN (the NULL branch of withUnseen)
      INSERT INTO board_rows VALUES ('r-null','b-read','nullstamp','blocked','','','do this next',NULL,2);
      -- 4 · no annotation at all → nothing to see
      INSERT INTO board_rows VALUES ('r-none','b-read','none','blocked','','',NULL,NULL,3);
      -- 5 · annotated on a board nobody ever read → was UNSEEN
      INSERT INTO board_rows VALUES ('r-unread','b-never','unread','blocked','','','sure make the PR','2026-07-01T00:00:00.000Z',0);
    `)
    legacy.close()

    const db2 = openDb(path)
    const byId = new Map(listBoards(db2).flatMap((b) => b.rows.map((r) => [r.id, r] as const)))
    // previously SEEN → an honest stamp equal to the board's last_read_at
    expect(byId.get('r-seen')!.annotation_seen_at).toBe('2026-07-02T00:00:00.000Z')
    expect(byId.get('r-null')!.annotation_seen_at).toBe('2026-07-02T00:00:00.000Z')
    // previously UNSEEN → still undelivered
    expect(byId.get('r-after')!.annotation_seen_at).toBeNull()
    expect(byId.get('r-unread')!.annotation_seen_at).toBeNull()
    expect(byId.get('r-none')!.annotation_seen_at).toBeNull()
    // and the derived flag lands exactly where the OLD rule put it
    expect([...byId.values()].filter((r) => r.annotation_unseen).map((r) => r.label).sort()).toEqual(['after', 'unread'])
    // The first poll gets the two genuinely-unread notes PLUS the backfilled-seen
    // row that is still blocked — and NOT 'old note', the already-read aside on a
    // non-blocked row, which is what the backfill is still there to hold back.
    expect(listPendingAnnotations(db2, 'p').map((r) => r.annotation).sort())
      .toEqual(['do this next', 'new note', 'sure make the PR'])

    // …and the legacy NULL annotated_at is still STAMPABLE: the version pin
    // compares with `IS`, not `=`, or that row could never earn a "delivered to"
    // attribution and the human's chip would read "awaiting pickup" forever.
    annotateBoardRowLegacyNull(db2)
    const legacyRow = listPendingAnnotations(db2, 'p').find((r) => r.row_id === 'r-null')!
    expect(legacyRow.annotated_at).toBeNull()
    expect(markAnnotationDelivered(db2, 'r-null', null, 'claude-code')).toBe(true)
    const stamped = listBoards(db2).flatMap((b) => b.rows).find((r) => r.id === 'r-null')!
    expect(stamped.annotation_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(stamped.annotation_seen_by).toBe('claude-code')
    db2.close()
  })
})

// Put the legacy row (annotated_at NULL) back into the undelivered state without
// touching its NULL stamp — annotateBoardRow would write one. Raw SQL is allowed
// HERE, in a test constructing a shape production can no longer produce; store.ts
// remains the only door for production code.
function annotateBoardRowLegacyNull(db: Database.Database): void {
  db.prepare(`UPDATE board_rows SET annotation_seen_at = NULL, annotation_seen_by = NULL WHERE id = 'r-null'`).run()
}

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
//
// Those sleeps AVOID the tie; the frozen-clock test below PINS it, in both
// directions, so the choice of `>` over `>=` is a decision on the record rather
// than an accident of wall-clock timing. (Executed: `>=` breaks the very first
// test in this block — insert, then close in the same millisecond, and the
// project never closes at all.)
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

  // The 1ms boundary, pinned rather than left to the wall clock. Ties resolve in
  // favour of the human's explicit act: `>=` would mean an agent writing in the
  // very millisecond of the click makes the × visibly do nothing, and repeat on
  // every retry while that agent keeps writing. `>` costs one missed un-close,
  // which the next write (any later millisecond) undoes on its own.
  it('an item created in the SAME millisecond as the close leaves it closed; one millisecond later reopens it', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'))
      closeProject(db, 'dead')
      insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'same tick' })
      // the stamps really are byte-identical — otherwise this asserts nothing
      expect(listItems(db)[0]!.created_at).toBe(listClosedProjects(db)[0]!.closed_at)
      expect(closedProjects(db)).toEqual(['dead'])
      vi.advanceTimersByTime(1)
      insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'one ms later' })
      expect(closedProjects(db)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
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

// ── issue #30: source links ──────────────────────────────────────────────────
// items/boards carry the LOCALLY inferred link identity (repo + issue_ref);
// source_links caches the live PR state the viewer process fetches with `gh`,
// ONE row per (repo, branch) rather than one per item.

describe('items and boards carry the link identity they were raised on', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('an item records repo and issue_ref, and defaults both to null', () => {
    insertItem(db, { project: 'agent-inbox', stream: '30-x', agent: 'a', kind: 'question', title: 'q', repo: 'shariqh/agent-inbox', issue_ref: 30 })
    insertItem(db, { project: 'agent-inbox', stream: '', agent: 'a', kind: 'note', title: 'n' })
    const withLink = listItems(db).find((i) => i.title === 'q')!
    expect(withLink.repo).toBe('shariqh/agent-inbox')
    expect(withLink.issue_ref).toBe(30)
    const without = listItems(db).find((i) => i.title === 'n')!
    expect(without.repo).toBeNull()
    expect(without.issue_ref).toBeNull()
  })

  // ensureBoard hits UPDATE for every re-upsert, so a board test that only
  // exercises the update path would pass while a FRESH board carries nulls
  it('a board created fresh carries the repo/issue_ref, not only one that was re-upserted', () => {
    upsertBoard(db, { project: 'agent-inbox', stream: '30-x', agent: 'a', title: 'cov', rows: [{ label: 'a', status: 'tracked' }], repo: 'shariqh/agent-inbox', issueRef: 30 })
    const fresh = listBoards(db)[0]!
    expect(fresh.repo).toBe('shariqh/agent-inbox')
    expect(fresh.issue_ref).toBe(30)
  })

  it('a re-upsert restamps the link identity, like stream and agent', () => {
    upsertBoard(db, { project: 'agent-inbox', stream: 'main', agent: 'a', title: 'cov', rows: [{ label: 'a', status: 'tracked' }] })
    expect(listBoards(db)[0]!.repo).toBeNull()
    upsertBoard(db, { project: 'agent-inbox', stream: '30-x', agent: 'a', title: 'cov', rows: [{ label: 'a', status: 'tracked' }], repo: 'shariqh/agent-inbox', issueRef: 30 })
    expect(listBoards(db)[0]!.repo).toBe('shariqh/agent-inbox')
    expect(listBoards(db)[0]!.issue_ref).toBe(30)
  })

  it('board_row\'s single-row path stamps it too, board_rows gains no columns', () => {
    updateBoardRow(db, { project: 'agent-inbox', stream: '30-x', agent: 'a', title: 'cov', label: 'a', status: 'tracked', repo: 'shariqh/agent-inbox', issueRef: 30 })
    const b = listBoards(db)[0]!
    expect(b.repo).toBe('shariqh/agent-inbox')
    expect(Object.keys(b.rows[0]!)).not.toContain('repo')
  })

  it('openDb migrates legacy items/boards tables missing repo/issue_ref', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-legacy30-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', kind TEXT NOT NULL, title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
        annotation TEXT, created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE boards (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project, title)
      );
      INSERT INTO items (id, project, kind, title, created_at) VALUES ('old', 'p', 'question', 'legacy?', '2026-01-01T00:00:00.000Z');
    `)
    legacy.close()
    const migrated = openDb(path)
    // every pre-#30 row reads back with null link identity — the honest answer,
    // and the reason the feature renders nothing for the existing inbox
    expect(listItems(migrated).find((i) => i.id === 'old')!.repo).toBeNull()
    expect(listItems(migrated).find((i) => i.id === 'old')!.issue_ref).toBeNull()
    insertItem(migrated, { project: 'p', stream: '30-x', agent: 'a', kind: 'question', title: 'new', repo: 'o/n', issue_ref: 30 })
    expect(listItems(migrated).find((i) => i.title === 'new')!.repo).toBe('o/n')
    upsertBoard(migrated, { project: 'p', stream: '30-x', agent: 'a', title: 't', rows: [], repo: 'o/n', issueRef: 30 })
    expect(findBoard(migrated, 'p', 't')!.repo).toBe('o/n')
  })
})

describe('source links', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const good = {
    repo: 'shariqh/agent-inbox', branch: '30-x', provider: 'github',
    pr_number: 41, pr_url: 'https://github.com/shariqh/agent-inbox/pull/41',
    pr_title: 'source + PR links', pr_state: 'OPEN', pr_draft: false,
    review_decision: 'APPROVED', checks: 'passing',
    issue_number: 30, issue_url: 'https://github.com/shariqh/agent-inbox/issues/30',
    issue_title: 'source + PR links', tldr: 'links the inbox to its PR',
  }

  it('upsertSourceLink is idempotent by (repo, branch) and stamps fetched_at', () => {
    upsertSourceLink(db, good)
    upsertSourceLink(db, { ...good, pr_state: 'MERGED', pr_title: 'source + PR links (merged)' })
    const links = listSourceLinks(db)
    expect(links).toHaveLength(1)
    expect(links[0]!.pr_state).toBe('MERGED')
    expect(links[0]!.pr_title).toBe('source + PR links (merged)')
    expect(links[0]!.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(links[0]!.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(links[0]!.error).toBeNull()
  })

  it('reads pr_draft back as a boolean, false when it was never written', () => {
    upsertSourceLink(db, { ...good, pr_draft: true })
    expect(listSourceLinks(db)[0]!.pr_draft).toBe(true)
    upsertSourceLink(db, { ...good, pr_draft: false })
    expect(listSourceLinks(db)[0]!.pr_draft).toBe(false)
    recordLinkFailure(db, { repo: 'a/b', branch: 'x', error: 'no-gh' })
    expect(listSourceLinks(db).find((l) => l.repo === 'a/b')!.pr_draft).toBe(false)
  })

  // the naive "upsert with nulls" implementation blanks a merged PR the moment
  // the laptop goes offline — that is the bug this test exists to prevent
  it('recordLinkFailure never blanks a previously good row — only checked_at and error move', () => {
    upsertSourceLink(db, good)
    const before = listSourceLinks(db)[0]!
    recordLinkFailure(db, { repo: good.repo, branch: good.branch, error: 'offline' })
    const after = listSourceLinks(db)[0]!
    expect(after.pr_number).toBe(41)
    expect(after.pr_title).toBe('source + PR links')
    expect(after.pr_state).toBe('OPEN')
    expect(after.tldr).toBe('links the inbox to its PR')
    expect(after.fetched_at).toBe(before.fetched_at)
    expect(after.error).toBe('offline')
    expect(after.checked_at >= before.checked_at).toBe(true)
    // and a later success clears the error again
    upsertSourceLink(db, good)
    expect(listSourceLinks(db)[0]!.error).toBeNull()
  })

  // recordLinkFailure runs inside the poller tick; a NOT NULL constraint on any
  // omitted column would make the very first failure for a new branch throw
  it('recordLinkFailure inserts a bare row for a branch it has never seen, without throwing', () => {
    expect(() => recordLinkFailure(db, { repo: 'a/b', branch: 'never-seen', error: 'no-gh' })).not.toThrow()
    const row = listSourceLinks(db)[0]!
    expect(row.error).toBe('no-gh')
    expect(row.pr_number).toBeNull()
    expect(row.fetched_at).toBeNull()
    expect(row.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('listLinkTargets returns distinct repo+branch pairs from OPEN items and ACTIVE boards, and skips rows with no repo', () => {
    insertItem(db, { project: 'p', stream: '30-x', agent: 'a', kind: 'question', title: 'q1', repo: 'o/n', issue_ref: 30 })
    insertItem(db, { project: 'p', stream: '30-x', agent: 'a', kind: 'note', title: 'q2', repo: 'o/n', issue_ref: 30 })
    insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'note', title: 'no branch', repo: 'o/n' })
    insertItem(db, { project: 'p', stream: 'b', agent: 'a', kind: 'note', title: 'no repo' })
    const resolved = insertItem(db, { project: 'p', stream: 'gone', agent: 'a', kind: 'question', title: 'old', repo: 'o/n', issue_ref: 1 })
    resolveItem(db, resolved)
    upsertBoard(db, { project: 'p', stream: 'board-branch', agent: 'a', title: 'cov', rows: [{ label: 'a', status: 'tracked' }], repo: 'o/n', issueRef: 2 })
    const targets = listLinkTargets(db)
    expect(targets).toContainEqual({ repo: 'o/n', branch: '30-x' })
    expect(targets).toContainEqual({ repo: 'o/n', branch: 'board-branch' })
    // two items on ONE branch is ONE target — that is the whole point of caching
    // per (repo, branch) instead of per item
    expect(targets.filter((t) => t.branch === '30-x')).toHaveLength(1)
    expect(targets.map((t) => t.branch)).not.toContain('')
    expect(targets.map((t) => t.branch)).not.toContain('b')
    expect(targets.map((t) => t.branch)).not.toContain('gone')
  })

  // #32 × #30: closing a project retires its branches from the poller. The closed
  // set is DERIVED, so this must go through closedProjects() — reading closed_at
  // directly would keep polling a project that has already un-closed itself.
  it('drops a CLOSED project\'s branches, and picks them up again on either kind of reopen', async () => {
    insertItem(db, { project: 'live', stream: 'a', agent: 'a', kind: 'question', title: 'q', repo: 'o/n' })
    insertItem(db, { project: 'dead', stream: 'b', agent: 'a', kind: 'question', title: 'q', repo: 'o/n' })
    expect(listLinkTargets(db).map((t) => t.branch)).toEqual(['a', 'b'])
    closeProject(db, 'dead')
    expect(listLinkTargets(db).map((t) => t.branch)).toEqual(['a'])
    // the explicit reopen …
    reopenProject(db, 'dead')
    expect(listLinkTargets(db).map((t) => t.branch)).toEqual(['a', 'b'])
    // … and the derived one: new content after closed_at
    closeProject(db, 'dead')
    expect(listLinkTargets(db).map((t) => t.branch)).toEqual(['a'])
    await new Promise((r) => setTimeout(r, 5))
    insertItem(db, { project: 'dead', stream: 'b', agent: 'a', kind: 'note', title: 'back', repo: 'o/n' })
    expect(listLinkTargets(db).map((t) => t.branch)).toEqual(['a', 'b'])
  })

  it('keeps a branch a closed project shares with a live one, and drops an ACTIVE board\'s branch too', () => {
    insertItem(db, { project: 'live', stream: 'shared', agent: 'a', kind: 'question', title: 'q', repo: 'o/n' })
    insertItem(db, { project: 'dead', stream: 'shared', agent: 'a', kind: 'question', title: 'q', repo: 'o/n' })
    upsertBoard(db, { project: 'dead', stream: 'board-br', agent: 'a', title: 'cov', rows: [{ label: 'a', status: 'tracked' }], repo: 'o/n' })
    closeProject(db, 'dead')
    expect(listLinkTargets(db)).toEqual([{ repo: 'o/n', branch: 'shared' }])
  })

  it('caps the target list so a huge inbox cannot turn into an unbounded gh fan-out', () => {
    for (let i = 0; i < 60; i++) {
      insertItem(db, { project: 'p', stream: `br-${i}`, agent: 'a', kind: 'question', title: `q${i}`, repo: 'o/n', issue_ref: 1 })
    }
    expect(listLinkTargets(db).length).toBe(50)
  })

  it('pruneSourceLinks keeps freshly-checked rows and drops ones unchecked for 30 days', () => {
    upsertSourceLink(db, good)
    recordLinkFailure(db, { repo: 'o/other', branch: 'x', error: 'no-gh' })
    pruneSourceLinks(db)
    expect(listSourceLinks(db)).toHaveLength(2) // nothing is a month old yet
    // the clock moves, never the row: checked_at is stamped inside the store
    pruneSourceLinks(db, { nowMs: Date.now() + 31 * 24 * 60 * 60000 })
    expect(listSourceLinks(db)).toHaveLength(0)
  })
})

