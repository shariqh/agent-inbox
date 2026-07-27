import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb, listItems, listBoards, getBoard, annotateBoardRow, listPendingAnnotations, replyItem, listActivity } from '../src/store.js'

describe('mcp round-trip', () => {
  it('flag writes a row attributed to this session, and whoami reflects register', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcp-server.ts'],
      env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)

    const flagRes = await client.callTool({ name: 'flag', arguments: { kind: 'question', title: 'which storage?' } })
    const { id } = JSON.parse((flagRes.content as Array<{ text: string }>)[0]!.text)
    expect(id).toBeTruthy()

    // kind=done milestone round-trips too
    const doneRes = await client.callTool({ name: 'flag', arguments: { kind: 'done', title: 'shipped v2' } })
    expect(JSON.parse((doneRes.content as Array<{ text: string }>)[0]!.text).id).toBeTruthy()

    const who = await client.callTool({ name: 'register', arguments: { project: 'overridden', issue: 30 } })
    const whoBody = JSON.parse((who.content as Array<{ text: string }>)[0]!.text)
    expect(whoBody.project).toBe('overridden')
    expect(whoBody.issue).toBe(30)

    // issue #30 — a registered issue is an OVERRIDE, so it rides the next flag
    // even though this checkout's branch name carries no issue number
    await client.callTool({ name: 'flag', arguments: { kind: 'note', title: 'after register' } })

    await client.close()

    const db = openDb(dbPath)
    const items = listItems(db)
    expect(items).toHaveLength(3)
    const q = items.find((i) => i.title === 'which storage?')!
    expect(q.kind).toBe('question')
    expect(q.agent).toBe('claude-code')
    // the link identity is inferred locally from git, with no gh and no network:
    // asserted as a shape so a fork (different owner) does not break the suite
    expect(q.repo).toMatch(/^[\w.-]+\/agent-inbox$/)
    expect(items.find((i) => i.title === 'after register')!.issue_ref).toBe(30)
    const d = items.find((i) => i.kind === 'done')!
    expect(d.title).toBe('shipped v2')
    expect(d.status).toBe('open')
  })

  it('flag accepts options; pending returns the human reply and stamps pickup', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-pending-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const c1 = await conn()
    const flagRes = await c1.callTool({ name: 'flag', arguments: {
      kind: 'question', title: 'flags or branch?',
      context: 'Mid-rollout of the checkout revamp; hit this at the deploy step. See PR #42.',
      options: [{ label: 'flags', detail: 'safer rollback', recommended: true }, { label: 'branch' }],
    } })
    const { id } = JSON.parse((flagRes.content as Array<{ text: string }>)[0]!.text)

    // no reply yet — pending shows the open question unanswered
    const p1 = await c1.callTool({ name: 'pending', arguments: {} })
    const items1 = JSON.parse((p1.content as Array<{ text: string }>)[0]!.text).items
    expect(items1).toHaveLength(1)
    expect(items1[0].reply).toBeNull()
    expect(items1[0].options[0].label).toBe('flags')
    expect(items1[0].context).toMatch(/checkout revamp/)

    // human answers (viewer path)
    replyItem(openDb(dbPath), id, 'flags — but canary first', 'roll this to 10% first and report back')

    const p2 = await c1.callTool({ name: 'pending', arguments: {} })
    const items2 = JSON.parse((p2.content as Array<{ text: string }>)[0]!.text).items
    expect(items2[0].reply).toBe('flags — but canary first')
    expect(items2[0].reply_context).toBe('roll this to 10% first and report back')
    await c1.close()
    expect(listItems(openDb(dbPath))[0]!.reply_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/) // pickup stamped
  }, 20000)

  // issue #29 — the human answered in chat, so the agent records it onto the item.
  // Two real OS processes: the MCP server writes through `answer`, the viewer side
  // writes through replyItem on its own connection to the same WAL file.
  it('answer records a chat reply end-to-end, leaves pickup alone, and yields to a waiting inbox answer', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-answer-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)

    const { id } = await call('flag', { kind: 'question', title: 'sqlite or postgres?' })

    // a refusal is JSON the agent can branch on, never a thrown MCP error
    expect(await call('answer', { id, text: '   ' })).toEqual({ ok: false, reason: 'empty' })

    expect(await call('answer', { id, text: 'sqlite', context: 'stay local until remote mode' })).toEqual({ ok: true })
    let item = listItems(openDb(dbPath))[0]!
    expect(item.reply).toBe('sqlite')
    expect(item.reply_context).toBe('stay local until remote mode')
    expect(item.reply_source).toBe('agent')
    expect(item.reply_seen_at).toBe(item.replied_at) // the agent authored it, so it is already read
    expect(item.status).toBe('open') // recording is not resolving

    // pending only stamps pickup when an answer is unread — it must not restamp this one
    const seenBefore = item.reply_seen_at
    const p = await call('pending', {})
    expect(p.items[0].reply).toBe('sqlite')
    expect(listItems(openDb(dbPath))[0]!.reply_seen_at).toBe(seenBefore)

    // the human then answers in the inbox instead; that outranks the chat channel
    replyItem(openDb(dbPath), id, 'no — postgres', 'we need concurrent writers')
    const refused = await call('answer', { id, text: 'sticking with sqlite' })
    expect(refused).toEqual({
      ok: false, reason: 'unread_inbox_answer', reply: 'no — postgres', reply_context: 'we need concurrent writers',
    })
    item = listItems(openDb(dbPath))[0]!
    expect(item.reply).toBe('no — postgres')
    expect(item.reply_source).toBe('inbox')

    // and either channel's answer survives the agent resolving afterwards
    expect(await call('resolve', { id })).toEqual({ ok: true })
    await client.close()
    item = listItems(openDb(dbPath))[0]!
    expect(item.status).toBe('resolved')
    expect(item.reply).toBe('no — postgres')
  }, 20000)

  it('sessions auto-register presence; status upgrades it; done reverts; exit removes', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-status-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)
    await new Promise((r) => setTimeout(r, 500))

    // presence appears with NO tool calls at all — the session itself is the row
    let live = listActivity(openDb(dbPath))
    expect(live).toHaveLength(1)
    expect(live[0]!.idle).toBe(true)
    expect(live[0]!.agent).toBe('claude-code')

    await client.callTool({ name: 'status', arguments: {
      doing: 'fan-out: migrating 3 modules',
      children: [{ name: 'mig-a', doing: 'store.ts', state: 'running' }, { name: 'mig-b', doing: 'viewer.ts', state: 'running' }],
    } })
    live = listActivity(openDb(dbPath))
    expect(live).toHaveLength(1) // same row, upgraded
    expect(live[0]!.idle).toBe(false)
    expect(live[0]!.doing).toBe('fan-out: migrating 3 modules')
    expect(live[0]!.children.map((c) => c.name)).toEqual(['mig-a', 'mig-b'])

    await client.callTool({ name: 'status', arguments: { done: true } })
    live = listActivity(openDb(dbPath))
    expect(live).toHaveLength(1) // effort over, session alive → back to idle presence
    expect(live[0]!.idle).toBe(true)

    await client.close()
    await new Promise((r) => setTimeout(r, 500))
    expect(listActivity(openDb(dbPath))).toHaveLength(0) // process exit ends the row
  }, 20000)

  it('board tools upsert, update a row, and archive a board', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-board-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)

    const up = await client.callTool({ name: 'board_upsert', arguments: {
      title: 'coverage',
      rows: [{ label: 'theme', status: 'done', note: 'both modes', context: 'landed across three PRs' }, { label: 'stems', status: 'partial' }],
    } })
    const upOut = JSON.parse((up.content as Array<{ text: string }>)[0]!.text)
    expect(upOut.rowCount).toBe(2)

    await client.callTool({ name: 'board_row', arguments: { title: 'coverage', label: 'stems', status: 'partial', context: 'the long story' } })
    await client.close()

    const db = openDb(dbPath)
    const board = listBoards(db)[0]!
    expect(board.title).toBe('coverage')
    expect(board.rows.find((r) => r.label === 'theme')!.context).toBe('landed across three PRs')
    expect(board.rows.find((r) => r.label === 'stems')!.status).toBe('partial')
    expect(board.rows.find((r) => r.label === 'stems')!.context).toBe('the long story')

    // archive via a second short-lived client (same db path)
    const t2 = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c2 = new Client({ name: 'claude-code', version: '1.0.0' })
    await c2.connect(t2)
    const arch = await c2.callTool({ name: 'board_archive', arguments: { title: 'coverage' } })
    expect(JSON.parse((arch.content as Array<{ text: string }>)[0]!.text).ok).toBe(true)
    await c2.close()

    expect(listBoards(openDb(dbPath))).toHaveLength(0) // archived → not in active list
  }, 20000)

  it('board_get reads a board back including a human annotation', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-get-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const c1 = await conn()
    await c1.callTool({ name: 'board_upsert', arguments: { title: 'cov', rows: [{ label: 'x', status: 'missing' }] } })
    await c1.close()

    // Read the stored project (inference-derived), then annotate the row via the store (viewer path)
    const project = listBoards(openDb(dbPath))[0]!.project
    const rowId = getBoard(openDb(dbPath), project, 'cov')!.rows[0]!.id
    annotateBoardRow(openDb(dbPath), rowId, 'human note')

    const c2 = await conn()
    const got = await c2.callTool({ name: 'board_get', arguments: { title: 'cov' } })
    const board = JSON.parse((got.content as Array<{ text: string }>)[0]!.text)
    expect(board.rows[0].annotation).toBe('human note')
    expect(board.rows[0].annotation_unseen).toBe(true) // first read since the annotation

    // reading delivers the annotations in THAT payload, so a second read sees nothing new
    const again = await c2.callTool({ name: 'board_get', arguments: { title: 'cov' } })
    await c2.close()
    const board2 = JSON.parse((again.content as Array<{ text: string }>)[0]!.text)
    expect(board2.rows[0].annotation_unseen).toBe(false)
  }, 20000)

  // A TRADE TAKEN ON PURPOSE (#37), and one that F1 shrank to almost nothing.
  // board_get with no title returns every active board in the project, so one
  // incidental call ATTRIBUTES every annotation in the project to that reader.
  // That is TRUE — the payload genuinely contained them — and for a BLOCKED row
  // it now costs nothing at all: the queue is gated on the acknowledgement, so
  // the note keeps being handed to every polling session regardless. All the
  // incidental call can do is name the first reader. Exempting the title-less
  // form would be a third mark-seen rule nobody would remember.
  it('board_get with no title delivers every annotation in the project, and says so honestly', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-getall-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const c1 = await conn()
    await c1.callTool({ name: 'board_upsert', arguments: { title: 'one', rows: [{ label: 'a', status: 'blocked' }] } })
    await c1.callTool({ name: 'board_upsert', arguments: { title: 'two', rows: [{ label: 'b', status: 'blocked' }] } })
    await c1.close()

    const store = openDb(dbPath)
    const project = listBoards(store)[0]!.project
    for (const b of listBoards(store)) annotateBoardRow(store, b.rows[0]!.id, `note for ${b.title}`)
    expect(listPendingAnnotations(store, project)).toHaveLength(2)

    const c2 = await conn()
    const got = await c2.callTool({ name: 'board_get', arguments: {} })
    const { boards } = JSON.parse((got.content as Array<{ text: string }>)[0]!.text)
    // the payload it hands over still reports them as new to this reader
    expect(boards.flatMap((b: { rows: { annotation_unseen: boolean }[] }) => b.rows).every((r: { annotation_unseen: boolean }) => r.annotation_unseen)).toBe(true)
    await c2.close()

    // …and afterwards every row is attributed to it, because it genuinely read them
    for (const b of listBoards(openDb(dbPath))) {
      // delivery ≠ acknowledgement: every row is still blocked and still the
      // human's evidence that nothing has happened yet
      expect(b.rows[0]!.status).toBe('blocked')
      expect(b.rows[0]!.annotation_seen_by).toBe('claude-code')
      expect(b.rows[0]!.annotation_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
    // …and it consumed NOTHING: an unrelated session's incidental board_get must
    // not be able to take the human's note out of anyone else's pending() queue
    expect(listPendingAnnotations(openDb(dbPath), project).map((r) => r.annotation).sort())
      .toEqual(['note for one', 'note for two'])
  }, 20000)

  // ── issue #37: the delivery path for a board-row annotation ────────────────
  // THE HEADLINE. docs/reporting-snippet.md tells every agent that polling
  // `pending()` is how the human's input reaches them. Before this, `pending`
  // was `SELECT … FROM items` and nothing else, so an agent that followed the
  // contract perfectly still never saw a board annotation — the only thing that
  // surfaced one was independently choosing to call `board_get`. Observed in the
  // wild: a "merge it" note sat unread for a day while the agent polled throughout.
  it('pending delivers a board annotation to an agent that never calls board_get (#37)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-pending-rows-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const call = async (c: Client, name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)

    const c1 = await conn()
    await call(c1, 'board_upsert', { title: 'rollout', rows: [{ label: 'Merge', status: 'blocked', note: 'ready when you are' }] })

    // nothing from the human yet
    expect((await call(c1, 'pending', {})).rows).toEqual([])

    // the human annotates from the VIEWER — a different process, the store path
    const project = listBoards(openDb(dbPath))[0]!.project
    const rowId = getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!.id
    annotateBoardRow(openDb(dbPath), rowId, 'merge it')

    // the same session polls pending() — and only pending() — and receives it
    const delivered = (await call(c1, 'pending', {})).rows
    expect(delivered).toHaveLength(1)
    expect(delivered[0].annotation).toBe('merge it')
    expect(delivered[0].board_title).toBe('rollout')
    expect(delivered[0].label).toBe('Merge')
    expect(delivered[0].note).toBe('ready when you are')

    // …and it is stamped, so the human's card can say who has it
    const row = getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!
    expect(row.annotation_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.annotation_seen_by).toBe('claude-code')
    // DELIVERY IS NOT ACKNOWLEDGEMENT: the row stays blocked until the agent
    // flips its status, so the human keeps seeing it until something happened.
    expect(row.status).toBe('blocked')

    // …and so does the AGENT. A second poll re-hands it, labelled as already
    // delivered rather than as fresh news, until the agent acknowledges it.
    const again = (await call(c1, 'pending', {})).rows
    expect(again).toHaveLength(1)
    expect(again[0].annotation).toBe('merge it')
    expect(again[0].annotation_seen_at).toBe(row.annotation_seen_at)
    expect(again[0].annotation_seen_by).toBe('claude-code')

    // the status flip IS the acknowledgement, and it is the only thing that stops it
    await call(c1, 'board_row', { title: 'rollout', label: 'Merge', status: 'partial' })
    expect((await call(c1, 'pending', {})).rows).toEqual([])
    await c1.close()
  }, 20000)

  // F1 — THE FAN-OUT HOLE, the reason the above is at-least-once. The queue used
  // to be gated on `annotation_seen_at`, so the note went to exactly ONE poll from
  // ONE session. This repo fans out subagents constantly: the subagent's routine
  // poll ate the answer, the MANAGER that raised the row never got it, and the
  // human's screen then read "delivered to claude-code" — the exact signal that
  // tells them to stop chasing it. Two real server processes, one project.
  it('a sibling session’s poll cannot eat the answer the manager is waiting for (#37 F1)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-fanout-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const call = async (c: Client, name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)

    const manager = await conn()
    await call(manager, 'board_upsert', { title: 'rollout', rows: [{ label: 'Merge', status: 'blocked' }, { label: 'QA', status: 'partial' }] })
    const subagent = await conn()

    // the human answers from the VIEWER — a third process
    const project = listBoards(openDb(dbPath))[0]!.project
    const rowId = getBoard(openDb(dbPath), project, 'rollout')!.rows.find((r) => r.label === 'Merge')!.id
    annotateBoardRow(openDb(dbPath), rowId, 'merge it')

    // the subagent happens to poll first
    expect((await call(subagent, 'pending', {})).rows.map((r: { annotation: string }) => r.annotation)).toEqual(['merge it'])
    // …and the manager — the session that RAISED the row — still gets it
    const managerRows = (await call(manager, 'pending', {})).rows
    expect(managerRows.map((r: { annotation: string }) => r.annotation)).toEqual(['merge it'])

    // the human's screen is telling the truth the whole time: still blocked,
    // attributed to the first reader, nobody has acknowledged it
    const row = getBoard(openDb(dbPath), project, 'rollout')!.rows.find((r) => r.label === 'Merge')!
    expect(row.status).toBe('blocked')
    expect(row.annotation_seen_by).toBe('claude-code')

    await manager.close()
    await subagent.close()
  }, 20000)

  // F2 — pending()'s CAS filter, pinned at the MCP level. The store's version pin
  // is covered; mcp.ts CONSUMING that boolean was not, so
  // `.filter((r) => { markAnnotationDelivered(...); return true })` passed the whole
  // suite — and that mutant hands the agent text the human has already replaced.
  //
  // The interleave is real (the viewer writes from its own OS process, between the
  // handler's SELECT and its stamp) but unschedulable from outside. A TRIGGER on the
  // shared db file is a deterministic stand-in for the human's hand: it fires inside
  // the handler, on the first row's stamp, and rewrites the SECOND row exactly as a
  // change of mind would. Raw SQL is allowed here for the same reason store.test.ts
  // allows it — a test constructing a moment production cannot otherwise schedule.
  it('pending never hands over an annotation the human replaced mid-poll (#37 F2)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-midpoll-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const call = async (c: Client, name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)

    const c1 = await conn()
    await call(c1, 'board_upsert', { title: 'rollout', rows: [{ label: 'first', status: 'blocked' }, { label: 'second', status: 'blocked' }] })

    const store = openDb(dbPath)
    const project = listBoards(store)[0]!.project
    const rows = getBoard(store, project, 'rollout')!.rows
    annotateBoardRow(store, rows.find((r) => r.label === 'first')!.id, 'ship it')
    annotateBoardRow(store, rows.find((r) => r.label === 'second')!.id, 'wait for CI')

    // installed AFTER both annotations so it fires only from inside the handler
    store.exec(`
      CREATE TRIGGER human_changes_mind AFTER UPDATE OF annotation_seen_at ON board_rows
      WHEN NEW.label = 'first'
      BEGIN
        UPDATE board_rows
           SET annotation = 'actually — do NOT merge', annotated_at = '2099-01-01T00:00:00.000Z',
               annotation_seen_at = NULL, annotation_seen_by = NULL
         WHERE label = 'second';
      END;`)

    const delivered = (await call(c1, 'pending', {})).rows as Array<{ label: string; annotation: string }>
    expect(delivered.map((r) => r.label), 'the row rewritten under the reader must be dropped').toEqual(['first'])
    expect(JSON.stringify(delivered)).not.toContain('wait for CI')

    // and it is NOT lost: the newest text is still queued, undelivered, for the next poll
    store.exec(`DROP TRIGGER human_changes_mind`)
    const next = (await call(c1, 'pending', {})).rows as Array<{ label: string; annotation: string }>
    expect(next.find((r) => r.label === 'second')?.annotation).toBe('actually — do NOT merge')
    await c1.close()
  }, 20000)

  it('a flagged item records the asking session, matching its live activity row', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-session-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)
    await new Promise((r) => setTimeout(r, 500)) // presence registers on the initialized notification

    await client.callTool({ name: 'flag', arguments: { kind: 'question', title: 'which storage?' } })

    // read BEFORE closing — process exit ends the activity row
    const db = openDb(dbPath)
    const live = listActivity(db)
    expect(live).toHaveLength(1)
    const item = listItems(db).find((i) => i.title === 'which storage?')!
    expect(item.session).toBe(live[0]!.session)
    expect(item.session).toMatch(/^[0-9a-f-]{36}$/)

    await client.close()
  }, 20000)
})
