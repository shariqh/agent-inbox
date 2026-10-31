// Issue #411 (research preview) — push a session message into a running Claude
// Code session through Claude Code's channels extension, so an idle session
// takes a turn for it with no watcher and no time window.
//
// A channel is an MCP server that declares `experimental['claude/channel']` and
// sends `notifications/claude/channel` ({ content, meta }); Claude Code renders
// it as `<channel source="agent-inbox" message_id="…">content</channel>` and
// starts a turn. Claude Code listens only when the human launched it naming this
// server (`--dangerously-load-development-channels server:agent-inbox` during the
// preview) and says nothing back: no handshake field, no acknowledgement. So the
// push is a WAKE, never the delivery. The notice carries no message text, only
// the id; the agent reads the text through `pending()` and closes it through
// `ack_message`, which keep isolation, re-delivery and the record exactly as
// PR 1 left them. A notification Claude does not listen for is dropped silently.
//
// Lives in the stdio MCP graph: no network, no stdout of its own, and every read
// goes through store.ts.
import type Database from 'better-sqlite3'
import { listOpenMessages } from './store.js'

export const CHANNEL_CAPABILITY = 'claude/channel'
export const CHANNEL_METHOD = 'notifications/claude/channel'
// The name install-agents.sh registers. Claude Code tags each event with the
// name it loaded the server under and never tells the server, so a launch flag
// naming any other registration cannot be recognised in presence (§ push_wake).
export const CHANNEL_SERVER_NAME = 'agent-inbox'

// Delivered by Claude Code to the model as context when the server connects.
// Only Claude Code clients are sent it (see mcp.ts), so Copilot's context does
// not change.
export const CHANNEL_INSTRUCTIONS =
  'Agent Inbox may push <channel source="agent-inbox" message_id="..."> events into this session. ' +
  'Each one means the human sent THIS session a message from Agent Inbox; the event carries no text. ' +
  'Call the agent-inbox pending() tool now, act on each entry in `messages` as if the human typed it in this terminal, ' +
  'then call ack_message({id, outcome}). If you already handled that message, there is nothing more to do. ' +
  'A subagent never acts on or acks messages. Do not reply through the channel.'

export interface ChannelNotice {
  content: string
  meta: { message_id: string }
}

export function channelNotice(id: string): ChannelNotice {
  return {
    content: 'The human sent this session a message in Agent Inbox. Call pending() to read it, act on it, then ack_message({id, outcome}).',
    meta: { message_id: id },
  }
}

// How often the server looks for a new message: one indexed read of this
// session's open message ids. `AGENT_INBOX_CHANNEL_POLL_MS` exists for tests.
const DEFAULT_POLL_MS = 2000
export function channelPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const forced = Number(env.AGENT_INBOX_CHANNEL_POLL_MS)
  return Number.isInteger(forced) && forced >= 50 && forced <= 60000 ? forced : DEFAULT_POLL_MS
}

// Pushes one notice per open message of `session`, once. The pushed set lives in
// memory, so the hub schema is unchanged and a restarted server (a new session
// id, with no messages of its own) owes nothing. It keeps only ids that are still
// open, so it stays bounded by the store's 20-open-messages cap. A send that
// fails is retried on the next tick; a send that succeeds is never repeated,
// even if Claude Code dropped it, because the hooks and the next `pending()`
// still carry the message.
export function startChannelPush(opts: {
  db: Database.Database
  session: string
  send: (notice: ChannelNotice) => Promise<void>
  intervalMs?: number
}): () => void {
  let pushed = new Set<string>()
  let busy = false
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const open = listOpenMessages(opts.db, [opts.session]).map((m) => m.id)
      pushed = new Set(open.filter((id) => pushed.has(id)))
      for (const id of open) {
        if (pushed.has(id)) continue
        try {
          await opts.send(channelNotice(id))
          pushed.add(id)
        } catch { break }
      }
    } catch { /* a busy or closed database: try again next tick */ } finally {
      busy = false
    }
  }
  const timer = setInterval(() => { void tick() }, opts.intervalMs ?? channelPollMs())
  timer.unref()
  return () => clearInterval(timer)
}

// Whether the Claude Code process that started this server was launched with a
// channel flag naming `server:agent-inbox`. It is the closest local evidence the
// push is live: Claude Code reports nothing about it in the MCP handshake (its
// initialize request is byte-identical with and without the flag), and an org
// policy (`channelsEnabled`), a non-claude.ai auth or a refused registration
// still drops events silently. Only the development flag counts: during the
// research preview `--channels` registers allowlisted plugins only, never a
// bare `server:` entry. `-p`/`--print` sessions never register channels.
export function namesChannel(args: readonly string[], name: string = CHANNEL_SERVER_NAME): boolean {
  const DEV = '--dangerously-load-development-channels'
  const target = `server:${name}`
  let listening = false
  let named = false
  for (const arg of args) {
    if (arg === '-p' || arg === '--print') return false
    if (arg === DEV) { listening = true; continue }
    if (arg.startsWith(`${DEV}=`)) {
      listening = false
      if (arg.slice(DEV.length + 1).split(/[\s,]+/).includes(target)) named = true
      continue
    }
    if (arg.startsWith('-')) { listening = false; continue }
    if (listening && arg === target) named = true
  }
  return named
}
