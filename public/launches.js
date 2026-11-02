// Issue #412 step 3 — driven sessions on the page (design §3.6, §5.3, §7, §8).
// Pure: no DOM, no fetch, no clock (callers pass `nowMs`). app.js draws the
// Live drawer's "Started from Agent Inbox" section, the New session dialog and
// the transcript panel from what these return.
//
// Presence, not attention: nothing here is read by public/attention.js, a
// badge, a count, the rail, the dock or a notification. Main decides every
// launch; the page only names what the human chose.

export const LAUNCH_MODES = Object.freeze([
  {
    id: 'ask',
    label: 'Ask for everything',
    copy: 'Each tool call asks you first, except what your own Copilot settings already allow.',
  },
  {
    id: 'read-only',
    label: 'Read-only',
    copy: 'File-edit tools are denied; shell commands still ask. This does not make writes impossible.',
  },
  {
    id: 'plan',
    label: 'Plan first',
    copy: 'The agent writes a plan first; once you approve it, each tool call asks.',
  },
  {
    id: 'edits',
    label: 'Edits in the worktree',
    copy: 'File edits inside the project folder run without asking, never a .git folder or file; shell commands, network and anything outside the folder still ask. An edited file can change what a command you allow then runs.',
  },
])

export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export const SHELL_WARNING = 'Once any shell command is allowed, the session can run anything, in its folder and beyond. Answer each approval with that in mind.'
export const PROMPT_WARNING = 'Don’t paste secrets here: the task is stored with the session.'

const MODEL = /^[A-Za-z0-9._-]{1,64}$/
const MAX_PROMPT = 64 * 1024
// A running launch whose driver no session shows for this long reads as not responding.
const LOST_AFTER_MS = 2 * 60_000

/**
 * The New session dialog's values as the request main checks again
 * (launch-controller.cjs launchRequest), or why it cannot be sent.
 * @returns {{request: object} | {error: string}}
 */
export function newSessionRequest({ root, mode, model, reasoningEffort, activeHours, toolCalls, prompt }) {
  if (root !== null && (typeof root !== 'string' || !root.startsWith('/'))) return { error: 'Choose a project or a folder.' }
  if (!LAUNCH_MODES.some((m) => m.id === mode)) return { error: 'Choose a mode.' }
  const trimmedModel = typeof model === 'string' ? model.trim() : ''
  if (trimmedModel && !MODEL.test(trimmedModel)) return { error: 'A model id is letters, digits, dots, dashes or underscores.' }
  if (reasoningEffort && !REASONING_EFFORTS.includes(reasoningEffort)) return { error: 'Choose a reasoning effort from the list.' }
  const hours = Number(activeHours)
  if (!Number.isFinite(hours) || hours * 60 < 1 || hours > 8) return { error: 'Active time is between 1 minute and 8 hours.' }
  const calls = Number(toolCalls)
  if (!Number.isInteger(calls) || calls < 1 || calls > 2000) return { error: 'Tool calls are between 1 and 2000.' }
  if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'Describe the task.' }
  if (prompt.length > MAX_PROMPT) return { error: 'The task is longer than 65,536 characters.' }
  return {
    request: {
      root,
      mode,
      ...(trimmedModel ? { model: trimmedModel } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      budgets: { activeMs: Math.round(hours * 60) * 60_000, toolCalls: calls },
      prompt,
    },
  }
}

const END_REASONS = {
  stopped: 'Stopped',
  idle: 'Ended after being idle',
  child_exit: 'Copilot exited',
  lost: 'Closed: its driver had stopped',
  'budget:active_time': 'Ended: active-time budget used',
  'budget:tool_calls': 'Ended: tool-call budget used',
  'error:mode_escalation': 'Ended: its permissions changed outside what you allowed',
  'error:setup': 'Ended: Copilot could not start the session',
  'error:hub_unreachable': 'Ended: it could not read Agent Inbox',
  'error:lease_lost': 'Ended: another driver took over',
  'error:start': 'Did not start',
  'error:protocol': 'Ended: Copilot answered something unexpected',
}

/** A launch's driven sessions in /api/activity, live ones only. */
export function launchSessions(launch, activity) {
  return (activity ?? []).filter((row) => row?.driven === true && row.driven_launch === launch.id)
}

/**
 * What a launch is now, and what the human can do with it.
 * @returns {{state: 'starting'|'running'|'stopping'|'lost'|'parked'|'ended', text: string, actions: string[]}}
 */
export function launchStatus(launch, activity, nowMs) {
  if (launch.status === 'ended') {
    return { state: 'ended', text: END_REASONS[launch.end_reason] ?? `Ended (${launch.end_reason ?? 'unknown'})`, actions: ['transcript'] }
  }
  if (launch.status === 'parked') {
    const why = launch.park_reason ? ` ${launch.park_reason}` : ''
    return {
      state: 'parked',
      text: `Parked: idle, its session kept.${why}`,
      actions: ['resume', 'stop', 'transcript'],
    }
  }
  if (launch.stop_requested_at) return { state: 'stopping', text: 'Stopping…', actions: ['transcript'] }
  if (launchSessions(launch, activity).length) return { state: 'running', text: 'Running', actions: ['stop', 'park', 'transcript'] }
  const since = Date.parse(launch.updated_at ?? launch.created_at)
  if (Number.isFinite(since) && nowMs - since > LOST_AFTER_MS) {
    return { state: 'lost', text: 'Not responding: its driver may have stopped.', actions: ['close', 'stop', 'transcript'] }
  }
  return { state: 'starting', text: 'Starting…', actions: ['stop', 'transcript'] }
}

/** "Copilot · Plan first · 12 of 500 tool calls" */
export function launchSummary(launch) {
  const mode = LAUNCH_MODES.find((m) => m.id === launch.mode)?.label ?? launch.mode
  return [
    'Copilot',
    mode,
    launch.model,
    `${launch.tool_calls ?? 0} of ${launch.budget_tool_calls} tool calls`,
  ].filter(Boolean).join(' · ')
}

/** The launch a session belongs to, from /api/launches, or null. */
export function launchOfSession(launches, session) {
  return (launches ?? []).find((launch) => Array.isArray(launch.sessions) && launch.sessions.includes(session)) ?? null
}

/**
 * The transcript's lines from the driver's event log: agent text joined per
 * turn; tool calls, asks, answers, mode changes and turn ends as plain lines.
 * Events it does not show (frames, scans) are skipped.
 * @returns {Array<{kind: 'text'|'tool'|'ask'|'answer'|'note', text: string}>}
 */
export function transcriptLines(events) {
  const lines = []
  // what each request's allow option was, to read its answer
  const allows = new Map()
  let text = null
  const flush = () => {
    if (text !== null && text.trim()) lines.push({ kind: 'text', text })
    text = null
  }
  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue
    switch (event.event) {
      case 'agent_text':
        text = (text ?? '') + (typeof event.text === 'string' ? event.text : '')
        break
      case 'prompt':
        flush()
        lines.push({ kind: 'note', text: event.kind === 'task' ? 'The task was sent.' : event.kind === 'messages' ? 'Your messages were pushed.' : event.kind === 'interrupt' ? 'Interrupted, then your messages were sent.' : event.kind === 'ping' ? 'Told the session you answered.' : 'Agent Inbox sent a control message.' })
        break
      case 'tool_call':
        flush()
        lines.push({ kind: 'tool', text: `${event.title || 'A tool'}${event.input ? `\n${String(event.input)}` : ''}` })
        break
      case 'permission_request':
        flush()
        allows.set(event.id, event.allow ?? null)
        lines.push({ kind: 'ask', text: `Asked to allow ${event.tool || 'a tool'}` })
        break
      case 'permission_answer': {
        const allowed = event.answer !== undefined && event.answer !== null && event.answer === allows.get(event.id)
        lines.push({ kind: 'answer', text: allowed ? 'Allowed once' : event.answer === 'cancelled' ? 'Cancelled' : event.why === 'ask closed' ? 'Declined: the approval was closed' : 'Declined' })
        break
      }
      case 'mode_escalation':
        flush()
        lines.push({ kind: 'note', text: 'Its permissions changed outside what you allowed: the session ended.' })
        break
      case 'turn_end':
        flush()
        lines.push({ kind: 'note', text: `Turn ended (${event.stopReason ?? 'unknown'}).` })
        break
      case 'park_requested':
        flush()
        lines.push({ kind: 'note', text: 'You asked it to park: it parks once its turn ends.' })
        break
      case 'ended':
        flush()
        lines.push({ kind: 'note', text: event.reason === 'idle' || event.reason === 'park' ? 'Parked: Copilot stopped, its session kept to resume.' : `Session ended (${event.reason ?? 'unknown'}).` })
        break
      default:
        break
    }
  }
  flush()
  return lines
}
