import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb, listItems, listBoards, getBoard, annotateBoardRow, markRowHandled, listPendingRows, replyItem, listActivity } from '../src/store.js'

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
    // issue #45 — the row exists with no tool call behind it, so there is
    // nothing to claim yet. `last_call_at` IS the alive-vs-working distinction:
    // only heartbeat() writes it, and heartbeat() runs on real calls only.
    expect(live[0]!.last_call_at).toBeNull()

    await client.callTool({ name: 'status', arguments: {
      doing: 'fan-out: migrating 3 modules',
      children: [{ name: 'mig-a', doing: 'store.ts', state: 'running' }, { name: 'mig-b', doing: 'viewer.ts', state: 'running' }],
    } })
    live = listActivity(openDb(dbPath))
    expect(live).toHaveLength(1) // same row, upgraded
    expect(live[0]!.idle).toBe(false)
    expect(live[0]!.doing).toBe('fan-out: migrating 3 modules')
    expect(live[0]!.children.map((c) => c.name)).toEqual(['mig-a', 'mig-b'])
    expect(live[0]!.last_call_at).not.toBeNull() // a real call — the claim is now backed by one

    await client.callTool({ name: 'status', arguments: { done: true } })
    live = listActivity(openDb(dbPath))
    expect(live).toHaveLength(1) // effort over, session alive → back to idle presence
    expect(live[0]!.idle).toBe(true)

    await client.close()
    await new Promise((r) => setTimeout(r, 500))
    expect(listActivity(openDb(dbPath))).toHaveLength(0) // process exit ends the row
  }, 20000)

  // src/mcp.ts registers presence twice — on the initialize notification, and
  // again on an unconditional `setTimeout(registerPresence, 2000)` fallback. The
  // second one used to CLOBBER: a status({doing}) made in a session's first two
  // seconds was silently reverted to `open` two seconds later. Measured on this
  // machine the claim lands at ~0.6s, so a fast agent reporting its first phase
  // hit it every time — while the `status` tool description promises the opposite
  // ("just say what you are doing at your next real phase change, and it
  // re-asserts instantly").
  //
  // Nothing here is timing-tolerant by accident. `t0` is taken BEFORE the child
  // process exists, so it over-estimates the child's own clock and the <2s guard
  // can only be conservative. And the fallback is not assumed to have run: after
  // the claim, registerPresence is the ONLY writer left in this process (no more
  // tool calls, and the liveness interval is five minutes out), so an `updated_at`
  // that moved is proof it fired. Without that assertion a claim that landed
  // AFTER the window would sail through.
  it('a status claim made inside the 2s handshake-fallback window survives the fallback', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-register-')), 'inbox.db')
    const t0 = Date.now()
    const transport = new StdioClientTransport({
      command: 'npx', args: ['tsx', 'src/mcp-server.ts'],
      env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)
    await client.callTool({ name: 'status', arguments: { doing: 'planning the migration', detail: 'reading store.ts' } })
    const elapsed = Date.now() - t0
    expect(elapsed, 'the claim must land inside the 2s window or this test proves nothing').toBeLessThan(2000)

    const claimed = listActivity(openDb(dbPath))[0]!
    expect(claimed.doing).toBe('planning the migration')

    await new Promise((r) => setTimeout(r, 3500 - elapsed))
    const after = listActivity(openDb(dbPath))[0]!
    expect(after.updated_at > claimed.updated_at, 'the fallback registration must have run for this to mean anything').toBe(true)
    expect(after.doing).toBe('planning the migration')
    expect(after.detail).toBe('reading store.ts')
    expect(after.idle).toBe(false)
    await client.close()
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
    expect(listPendingRows(store, project)).toHaveLength(2)

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
    expect(listPendingRows(openDb(dbPath), project).map((r) => r.annotation).sort())
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

  // ── issue #42: the payload the AGENT pays for ──────────────────────────────
  // `context` is written for the HUMAN (collapsed dropdown, "length is fine"),
  // and every agent read used to carry all of it: ~11,500 tokens for one
  // project's `board_get()`, ~7,050 of it context. These pin the shape at the
  // MCP boundary — the store still returns whole rows, and the viewer still
  // gets them (test/viewer.test.ts).
  it('board_get omits row context by default, returns it with full: true, and summarises with no title (#42)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-shape-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const call = async (c: Client, name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)
    const LONG = 'the backstory the human reads in the collapsed dropdown. '.repeat(10)

    const c1 = await conn()
    await call(c1, 'board_upsert', { title: 'rollout', rows: [
      { label: 'Merge', status: 'blocked', note: 'ready when you are', context: LONG },
      { label: 'QA', status: 'tracked' },
    ] })
    const project = listBoards(openDb(dbPath))[0]!.project
    annotateBoardRow(openDb(dbPath), getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!.id, 'merge it')

    // default: the size, not the text — and the human's note in full
    const trimmed = await call(c1, 'board_get', { title: 'rollout' })
    expect(trimmed.rows[0].context).toBeUndefined()
    expect(trimmed.rows[0].context_chars).toBe(LONG.length)
    expect(trimmed.rows[0].note).toBe('ready when you are')
    expect(trimmed.rows[0].annotation).toBe('merge it')
    expect(trimmed.rows[1].context_chars).toBeUndefined() // no context → no field at all

    // the escape hatch
    const full = await call(c1, 'board_get', { title: 'rollout', full: true })
    expect(full.rows[0].context).toBe(LONG)
    expect(full.rows[0].annotation).toBe('merge it')

    // no title = a summary: titles, labels, statuses, notes, annotations. No context.
    const all = await call(c1, 'board_get', {})
    expect(all.boards[0].title).toBe('rollout')
    expect(all.boards[0].rows.map((r: { label: string }) => r.label)).toEqual(['Merge', 'QA'])
    expect(all.boards[0].rows[0].note).toBe('ready when you are')
    expect(all.boards[0].rows[0].annotation).toBe('merge it')
    expect(all.boards[0].rows[0].context_chars).toBe(LONG.length)
    expect(JSON.stringify(all)).not.toContain('collapsed dropdown')

    // full without a title is refused rather than silently ignored — naming a board buys the rows
    const refused = await call(c1, 'board_get', { full: true })
    expect(refused.full_requires_title).toBe(true)
    expect(JSON.stringify(refused)).not.toContain('collapsed dropdown')
    await c1.close()
  }, 20000)

  // #37 made a blocked annotated row re-ship on EVERY poll — with its whole
  // context each time. The human's words must keep coming back; the agent's own
  // backstory must not.
  it('pending hands each context over once per process, then only its size (#42)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-once-')), 'inbox.db')
    const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c1 = new Client({ name: 'claude-code', version: '1.0.0' }); await c1.connect(t)
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c1.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)
    const ROW_CTX = 'why this row is blocked, at the length agents are told to write. '.repeat(8)
    const ITEM_CTX = 'the background a human returning cold would need. '.repeat(8)

    await call('board_upsert', { title: 'rollout', rows: [{ label: 'Merge', status: 'blocked', context: ROW_CTX }] })
    await call('flag', { kind: 'question', title: 'flags or branch?', context: ITEM_CTX })
    const project = listBoards(openDb(dbPath))[0]!.project
    annotateBoardRow(openDb(dbPath), getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!.id, 'merge it')

    const first = await call('pending', {})
    expect(first.rows[0].context).toBe(ROW_CTX)
    expect(first.items[0].context).toBe(ITEM_CTX)

    // …and every poll after it: the human's annotation still, the backstory never
    for (const _ of [1, 2, 3]) {
      const again = await call('pending', {})
      expect(again.rows[0].annotation).toBe('merge it')     // #37 at-least-once, untouched
      expect(again.rows[0].note).toBeDefined()
      expect(again.rows[0].context).toBeUndefined()
      expect(again.rows[0].context_chars).toBe(ROW_CTX.length)
      expect(again.items[0].context).toBeUndefined()
      expect(again.items[0].context_chars).toBe(ITEM_CTX.length)
    }

    // delivery semantics are untouched: still blocked, still stamped once
    const row = getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!
    expect(row.status).toBe('blocked')
    expect(row.annotation_seen_by).toBe('claude-code')
    await c1.close()
  }, 20000)

  // THE STARVATION GUARD, for the case a ledger CAN cover: two CLIs, two server
  // processes. The delivery stamp is per-ROW and `annotation_seen_by` is a CLIENT
  // NAME, not a session id — so "already delivered" says nothing about whether
  // THIS agent has ever seen the text. Deciding first-delivery from the stamp
  // would hand a context-less payload to the agent that raised the row because
  // someone else polled first: #37's fan-out hole, one level down.
  //
  // The case it CANNOT cover is a subagent, whose calls are served by its
  // parent's process and therefore its parent's ledger — see the recovery test
  // below, which is why that case is survivable rather than solved.
  it('an agent in a separate process gets the context on ITS first poll, however often others polled (#42)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-sibling-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const call = async (c: Client, name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)
    const ROW_CTX = 'the backstory the manager needs to act on this row. '.repeat(8)

    const manager = await conn()
    await call(manager, 'board_upsert', { title: 'rollout', rows: [{ label: 'Merge', status: 'blocked', context: ROW_CTX }] })
    const project = listBoards(openDb(dbPath))[0]!.project
    annotateBoardRow(openDb(dbPath), getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!.id, 'merge it')

    // a subagent — same client NAME, different process — polls twice and drains its own first delivery
    const subagent = await conn()
    expect((await call(subagent, 'pending', {})).rows[0].context).toBe(ROW_CTX)
    expect((await call(subagent, 'pending', {})).rows[0].context).toBeUndefined()

    // the manager has still never seen it, and the row is stamped delivered — it gets it anyway
    expect(getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!.annotation_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const managerRows = (await call(manager, 'pending', {})).rows
    expect(managerRows[0].annotation).toBe('merge it')
    expect(managerRows[0].context).toBe(ROW_CTX)

    await manager.close()
    await subagent.close()
  }, 25000)

  // #42 meets #37 F2. pending() DROPS a row the human rewrote between the read
  // and the stamp — the newer text stays queued for the next poll. Shaping runs
  // AFTER that filter for a reason: record a dropped row as "context delivered"
  // and the agent gets the human's new note next poll with the backstory it was
  // never actually handed. Same trigger technique as F2 — a deterministic stand-in
  // for the human's hand, firing from inside the handler.
  it('a row dropped mid-poll is not recorded as delivered — its context still ships next time (#42)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-cas-')), 'inbox.db')
    const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c1 = new Client({ name: 'claude-code', version: '1.0.0' }); await c1.connect(t)
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c1.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)
    const CTX = 'the backstory for the row the human changed their mind about. '.repeat(8)

    await call('board_upsert', { title: 'rollout', rows: [
      { label: 'first', status: 'blocked' }, { label: 'second', status: 'blocked', context: CTX },
    ] })
    const store = openDb(dbPath)
    const project = listBoards(store)[0]!.project
    const rows = getBoard(store, project, 'rollout')!.rows
    annotateBoardRow(store, rows.find((r) => r.label === 'first')!.id, 'ship it')
    annotateBoardRow(store, rows.find((r) => r.label === 'second')!.id, 'wait for CI')
    store.exec(`
      CREATE TRIGGER human_changes_mind AFTER UPDATE OF annotation_seen_at ON board_rows
      WHEN NEW.label = 'first'
      BEGIN
        UPDATE board_rows
           SET annotation = 'actually — do NOT merge', annotated_at = '2099-01-01T00:00:00.000Z',
               annotation_seen_at = NULL, annotation_seen_by = NULL
         WHERE label = 'second';
      END;`)

    const dropped = (await call('pending', {})).rows as Array<{ label: string }>
    expect(dropped.map((r) => r.label)).toEqual(['first'])

    store.exec(`DROP TRIGGER human_changes_mind`)
    const next = (await call('pending', {})).rows as Array<{ label: string; annotation: string; context?: string }>
    const second = next.find((r) => r.label === 'second')!
    expect(second.annotation).toBe('actually — do NOT merge')
    expect(second.context, 'never delivered, so the context must still come with it').toBe(CTX)
    await c1.close()
  }, 20000)

  // THE CASE NO LEDGER CAN GET RIGHT, and the reason it does not have to.
  // A Claude Code subagent does NOT get its own MCP server: its calls are served
  // by the parent CLI's long-lived process, so a manager and its subagents share
  // ONE ledger and the first of them to poll consumes the delivery — everyone
  // else is handed `context_chars` for text they have never seen. MCP exposes no
  // subagent identity to key on, so the loss is made RECOVERABLE instead of
  // prevented: asking is always allowed and always answered, for rows AND for
  // items, which is the only read path an item has. One process = one client
  // here, exactly the fan-out's sharing.
  it('pending({full:true}) recovers context another caller in the same process already drained (#42)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-recover-')), 'inbox.db')
    const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c1 = new Client({ name: 'claude-code', version: '1.0.0' }); await c1.connect(t)
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c1.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)
    const ROW_CTX = 'why this row is blocked, at the length agents are told to write. '.repeat(8)
    const ITEM_CTX = 'the background a human returning cold would need. '.repeat(8)

    await call('board_upsert', { title: 'rollout', rows: [{ label: 'Merge', status: 'blocked', context: ROW_CTX }] })
    await call('flag', { kind: 'question', title: 'flags or branch?', context: ITEM_CTX })
    const project = listBoards(openDb(dbPath))[0]!.project
    annotateBoardRow(openDb(dbPath), getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!.id, 'merge it')

    // whoever polled first drained both deliveries; the next caller sees only sizes
    await call('pending', {})
    const drained = await call('pending', {})
    expect(drained.rows[0].context).toBeUndefined()
    expect(drained.items[0].context).toBeUndefined()

    // …and can always get them back, as often as it needs to
    for (const _ of [1, 2]) {
      const recovered = await call('pending', { full: true })
      expect(recovered.rows[0].context).toBe(ROW_CTX)
      expect(recovered.items[0].context).toBe(ITEM_CTX)
      expect(recovered.rows[0].annotation).toBe('merge it') // the human's words, as always
    }

    // a full delivery is still a delivery — the ordinary poll stays cheap
    const after = await call('pending', {})
    expect(after.rows[0].context).toBeUndefined()
    expect(after.rows[0].context_chars).toBe(ROW_CTX.length)
    expect(after.items[0].context_chars).toBe(ITEM_CTX.length)
    await c1.close()
  }, 20000)

  // An escape hatch an agent cannot find is not an escape hatch. These are the
  // words the model actually reads before it calls anything, so they are pinned:
  // the hatch, on both tools, and how to CLEAR a context now that omitting it
  // keeps the stored text.
  it('the payload contract is discoverable at the call site — the tool definitions say it (#42)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-desc-')), 'inbox.db')
    const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c1 = new Client({ name: 'claude-code', version: '1.0.0' }); await c1.connect(t)
    const tools = new Map((await c1.listTools()).tools.map((x) => [x.name, x]))

    const pending = tools.get('pending')!
    expect(pending.description).toContain('pending({full:true})')
    expect(pending.description).toContain('board_get({title, full:true})')
    expect(pending.inputSchema.properties).toHaveProperty('full') // and the hatch is actually callable
    // it must not promise a per-session guarantee it cannot keep
    expect(pending.description).toContain('per SERVER PROCESS')
    expect(pending.description).toMatch(/UTF-16 code units/)

    expect(tools.get('board_get')!.description).toContain('full: true')
    expect(tools.get('board_get')!.description).toMatch(/UTF-16 code units/)
    // the write side: omission keeps, '' clears
    expect(tools.get('board_upsert')!.description).toMatch(/context:""/)
    await c1.close()
  }, 20000)

  // Issue #44 — `blocked` is the ONE row status that escalates to the human,
  // but in ordinary usage the word means "blocked BY something", so an agent
  // reaching for the obvious meaning escalates what no person can act on: a
  // real board row sat in the attention banner because a release candidate did
  // not exist yet. Nothing about the mechanism is wrong, so the fix is at the
  // call site — and in BOTH places an agent reads before writing a status: the
  // tool description, and the description on the `status` FIELD itself, which
  // is the text a model filling in an enum actually looks at.
  //
  // Asserted over a REAL tools/list rather than the source string, because that
  // is what the agent receives, and it is the only proof that the zod
  // .describe() survives into the JSON Schema — including through .optional()
  // on board_row and through the array-items wrapper on board_upsert.
  // #36 requirement 4 — the mark has to REACH the agent, through the one poll
  // they are told to make. A mark the agent cannot see is the same dead end the
  // issue is about, so this drives the real stdio server end to end.
  it('pending delivers a handled mark to an agent that never calls board_get (#36)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-handled-')), 'inbox.db')
    const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c1 = new Client({ name: 'claude-code', version: '1.0.0' }); await c1.connect(t)
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c1.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)

    await call('board_upsert', { title: 'wave 0', rows: [{ label: 'Paddle account', status: 'blocked', note: '~15 min KYC' }] })
    expect((await call('pending', {})).rows).toEqual([])

    // the human clicks "I've done my part" in the VIEWER — a different process
    const project = listBoards(openDb(dbPath))[0]!.project
    const rowId = getBoard(openDb(dbPath), project, 'wave 0')!.rows[0]!.id
    markRowHandled(openDb(dbPath), rowId)

    const delivered = (await call('pending', {})).rows
    expect(delivered).toHaveLength(1)
    expect(delivered[0].label).toBe('Paddle account')
    expect(delivered[0].handled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(delivered[0].annotation, 'the human wrote no words — only the mark').toBeNull()

    // …and it is stamped, so the human's card can stop saying "waiting for pickup"
    const row = getBoard(openDb(dbPath), project, 'wave 0')!.rows[0]!
    expect(row.handled_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.handled_seen_by).toBe('claude-code')
    expect(row.status, 'delivery is not acknowledgement').toBe('blocked')

    // at-least-once, exactly like an annotation: a second poll re-hands it,
    // labelled as already delivered, until the status flip acknowledges it
    const again = (await call('pending', {})).rows
    expect(again).toHaveLength(1)
    expect(again[0].handled_seen_at).toBe(row.handled_seen_at)

    await call('board_row', { title: 'wave 0', label: 'Paddle account', status: 'done' })
    expect((await call('pending', {})).rows).toEqual([])
    await c1.close()
  }, 20000)

  it('board_get delivers the handled mark too, and re-blocking clears it (#36)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-handled2-')), 'inbox.db')
    const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c1 = new Client({ name: 'claude-code', version: '1.0.0' }); await c1.connect(t)
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c1.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)

    await call('board_upsert', { title: 'wave 0', rows: [{ label: 'Notion integration', status: 'blocked' }] })
    const project = listBoards(openDb(dbPath))[0]!.project
    markRowHandled(openDb(dbPath), getBoard(openDb(dbPath), project, 'wave 0')!.rows[0]!.id)

    const read = await call('board_get', { title: 'wave 0' })
    expect(read.rows[0].handled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(getBoard(openDb(dbPath), project, 'wave 0')!.rows[0]!.handled_seen_by).toBe('claude-code')

    // a full-table re-send that leaves the row blocked must NOT wipe the mark
    await call('board_upsert', { title: 'wave 0', rows: [{ label: 'Notion integration', status: 'blocked', note: 'still waiting' }] })
    expect(getBoard(openDb(dbPath), project, 'wave 0')!.rows[0]!.handled_at).not.toBeNull()

    // acknowledging and then asking again IS a new request, and starts clean
    await call('board_row', { title: 'wave 0', label: 'Notion integration', status: 'partial' })
    await call('board_row', { title: 'wave 0', label: 'Notion integration', status: 'blocked', note: 'now the OAuth secret please' })
    expect(getBoard(openDb(dbPath), project, 'wave 0')!.rows[0]!.handled_at).toBeNull()
    await c1.close()
  }, 20000)

  it('the tool descriptions tell agents the mark can arrive and how to acknowledge it (#36)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-handleddesc-')), 'inbox.db')
    const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c1 = new Client({ name: 'claude-code', version: '1.0.0' }); await c1.connect(t)
    const tools = new Map((await c1.listTools()).tools.map((x) => [x.name, x]))

    // the poll is where the mark arrives, so that is where it must be described
    const pending = tools.get('pending')!.description ?? ''
    expect(pending).toMatch(/handled_at/)
    expect(pending, 'the acknowledgement is the status flip, not merely reading it').toMatch(/status/)

    // and the two write tools are where the acknowledgement is made
    for (const name of ['board_upsert', 'board_row']) {
      expect(tools.get(name)!.description ?? '', name).toMatch(/handled_at|did my part|I did my part/)
    }
    const rowStatusDesc = ((tools.get('board_row')!.inputSchema as unknown as { properties: Record<string, { description?: string }> })
      .properties['status']!).description ?? ''
    expect(rowStatusDesc, 'the reset rule rides on the FIELD an agent is filling in').toMatch(/NEW request|new request/)
    await c1.close()
  }, 20000)

  it('the board tools say who `blocked` waits on, and carry the negative example (#44)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-blocked-')), 'inbox.db')
    const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c1 = new Client({ name: 'claude-code', version: '1.0.0' }); await c1.connect(t)
    const tools = new Map((await c1.listTools()).tools.map((x) => [x.name, x]))

    for (const name of ['board_upsert', 'board_row']) {
      const d = tools.get(name)!.description ?? ''
      expect(d, name).toMatch(/waiting on the HUMAN|needs the HUMAN/)
      // the half that was missing: "stuck" is not "blocked"
      expect(d, name).toMatch(/failing test/)
      expect(d, name).toMatch(/\bpartial\b/)
    }

    interface JsonNode { enum?: string[]; description?: string; properties?: Record<string, JsonNode>; items?: JsonNode }
    const schemaOf = (name: string): JsonNode => tools.get(name)!.inputSchema as unknown as JsonNode
    const fields = [
      schemaOf('board_upsert').properties!['rows']!.items!.properties!['status']!,
      schemaOf('board_row').properties!['status']!,
    ]
    for (const f of fields) {
      // decision, pinned: option 1 only. No `needs-you` alias and no rename —
      // one stored value, the same six an existing DB already holds.
      expect(f.enum).toEqual(['done', 'partial', 'missing', 'tracked', 'na', 'blocked'])
      expect(f.description).toMatch(/HUMAN/)
      expect(f.description).toMatch(/failing test/)
      expect(f.description).toMatch(/\bpartial\b/)
    }
    await c1.close()
  }, 20000)

  // THE DOCUMENTED FLOW, end to end. board_get says "re-read a board before
  // updating it", board_upsert says "re-send the whole table", and the reporting
  // snippet tells agents to call board_get before updating a board. Since #42 the
  // payload an agent re-sends carries `context_chars`, not `context` — so this
  // exact loop is where a wiped board would come from.
  it('board_get → board_upsert keeps every row’s context (#42)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-rmw-')), 'inbox.db')
    const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c1 = new Client({ name: 'claude-code', version: '1.0.0' }); await c1.connect(t)
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await c1.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text)
    const CTX = 'the backstory the human reads in the collapsed dropdown. '.repeat(10)

    await call('board_upsert', { title: 'rollout', rows: [
      { label: 'Merge', status: 'blocked', note: 'ready when you are', context: CTX },
      { label: 'QA', status: 'tracked' },
    ] })
    const project = listBoards(openDb(dbPath))[0]!.project
    annotateBoardRow(openDb(dbPath), getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!.id, 'merge it')

    // re-read, flip a status, re-send EXACTLY what the read handed back
    const read = await call('board_get', { title: 'rollout' })
    expect(read.rows[0].context).toBeUndefined() // the read genuinely cannot give it back
    const rows = (read.rows as Array<{ label: string; status: string; note: string; context?: string }>).map((r) => ({
      label: r.label, status: r.label === 'QA' ? 'done' : r.status, note: r.note, context: r.context,
    }))
    await call('board_upsert', { title: 'rollout', rows })

    const stored = getBoard(openDb(dbPath), project, 'rollout')!
    expect(stored.rows[0]!.context, 'the round-trip must not wipe the human-facing backstory').toBe(CTX)
    expect(stored.rows[0]!.annotation).toBe('merge it')
    expect(stored.rows.find((r) => r.label === 'QA')!.status).toBe('done') // the update still applied

    // and a deliberate erasure still works
    await call('board_upsert', { title: 'rollout', rows: [
      { label: 'Merge', status: 'blocked', note: 'ready when you are', context: '' }, { label: 'QA', status: 'done' },
    ] })
    expect(getBoard(openDb(dbPath), project, 'rollout')!.rows[0]!.context).toBe('')
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
