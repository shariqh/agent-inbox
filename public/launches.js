// Issue #412 step 3 — driven sessions on the page (design §3.6, §5.3, §7, §8).
// Pure: no DOM, no fetch, no clock (callers pass `nowMs`). app.js draws the
// launch cards and session panel (#454), the New session dialog and the
// transcript from what these return.
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
    copy: 'File edits inside the session’s folder (its worktree, when it has one) run without asking, never a .git folder or file; shell commands, network and anything outside the folder still ask. An edited file can change what a command you allow then runs.',
  },
])

export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export const SHELL_WARNING = 'Once any shell command is allowed, the session can run anything, in its folder and beyond. Answer each approval with that in mind.'
export const PROMPT_WARNING = 'Don’t paste secrets here: the task is stored with the session.'
// #432: what New worktree means; main's confirmation shows the worktree's path and branch
export const WORKTREE_COPY = 'The session works in a new git worktree on its own branch, made from your checkout’s last commit. Uncommitted changes stay in your checkout.'
export const NOT_REPOSITORY = 'Not a git repository: the session runs in this folder.'
// #432 PR 5: what a start is doing after the human confirmed, as main reports it
export const START_PHASES = Object.freeze({
  environment: 'Reading your shell environment…',
  runtime: 'Checking the runtime…',
  worktree: 'Creating the worktree…',
  copilot: 'Starting Copilot…',
})

const MODEL = /^[A-Za-z0-9._-]{1,64}$/
const MAX_PROMPT = 64 * 1024
// A running launch whose driver no session shows for this long reads as not responding.
const LOST_AFTER_MS = 2 * 60_000

/**
 * The New session dialog's values as the request main checks again
 * (launch-controller.cjs launchRequest), or why it cannot be sent.
 * @returns {{request: object} | {error: string}}
 */
export function newSessionRequest({ root, worktree, mode, model, reasoningEffort, activeHours, toolCalls, prompt }) {
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
      // only the wish: main plans the worktree's path and branch itself (#432)
      ...(worktree === true ? { worktree: true } : {}),
    },
  }
}

const minutes = (ms) => {
  const m = Math.round((Number.isFinite(ms) ? ms : 0) / 60_000)
  return m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`
}
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`
const isCount = (n) => Number.isSafeInteger(n) && n >= 0

// #432 §6: the driver's last summary of the worktree, in words; '' when there is none to read
export function worktreeSummaryText(summary, branch) {
  if (!summary || typeof summary !== 'object' || ![summary.ahead, summary.behind, summary.files, summary.dirty].every(isCount)) return ''
  const now = typeof summary.branch === 'string' ? summary.branch : branch
  return [
    `${count(summary.ahead, 'commit', 'commits')} ahead`,
    ...(summary.behind ? [`${summary.behind} behind`] : []),
    count(summary.files, 'file changed', 'files changed'),
    `${summary.dirty} uncommitted`,
    // the agent can switch branch, or detach HEAD
    ...(now === '' ? ['HEAD detached'] : now !== branch ? [`now on ${now}`] : []),
  ].join(', ')
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
  'error:start': 'Didn’t start',
  'error:protocol': 'Ended: Copilot answered something unexpected',
  handed_off: 'Handed off to a terminal: it goes on in Copilot there.',
}

/**
 * Step 5 (full resume): a launch the human stopped, with the session Copilot persisted and its
 * worktree (if any) still on disk, can be resumed or taken over as a parked one can. Main and the
 * store check the same again.
 */
function stoppedWithSession(launch) {
  return launch?.status === 'ended' && launch.end_reason === 'stopped' && launch.resumable === true
    && !(typeof launch.worktree_path === 'string' && launch.worktree_path && launch.worktree_removed_at)
}

/**
 * #451: a launch a budget ended, with its session and worktree (if any) kept, resumes only with
 * more budget, which main confirms in its own dialog. Main and the store check the same again.
 */
function budgetEnded(launch) {
  return launch?.status === 'ended' && (launch.end_reason === 'budget:active_time' || launch.end_reason === 'budget:tool_calls')
    && launch.resumable === true && !(typeof launch.worktree_path === 'string' && launch.worktree_path && launch.worktree_removed_at)
}

/**
 * #451: the allowance Resume with more budget… asks main to add, or why it cannot be sent: whole
 * minutes and calls, each up to what a new launch may have, and enough that it is not spent at once.
 * @returns {{add: {activeMs: number, toolCalls: number}} | {error: string}}
 */
export function budgetAllowance(launch, { activeHours, toolCalls }) {
  const hours = Number(activeHours)
  const calls = Number(toolCalls)
  if (!Number.isFinite(hours) || hours < 0 || hours > 8) return { error: 'Add between 0 and 8 hours of active time.' }
  if (!Number.isInteger(calls) || calls < 0 || calls > 2000) return { error: 'Add between 0 and 2000 tool calls.' }
  const add = { activeMs: Math.round(hours * 60) * 60_000, toolCalls: calls }
  if (launch.budget_active_ms + add.activeMs <= launch.active_ms) return { error: 'Add active time: it has used all of it.' }
  if (launch.budget_tool_calls + add.toolCalls <= launch.tool_calls) return { error: 'Add tool calls: it has used all of them.' }
  return { add }
}

/**
 * #478: an ended launch Forget… removes: its worktree removed, or it never had one. A kept worktree
 * goes first, through Remove worktree…. Main and the store check the same again.
 */
export function forgettable(launch) {
  return launch?.status === 'ended' && !(typeof launch.worktree_path === 'string' && launch.worktree_path && !launch.worktree_removed_at)
}

/** A launch's driven sessions in /api/activity, live ones only. */
export function launchSessions(launch, activity) {
  return (activity ?? []).filter((row) => row?.driven === true && row.driven_launch === launch.id)
}

/**
 * What a launch is now, and what the human can do with it. One that ended
 * before its session was ready is `failed`: "Didn't start", with why (#432 PR 5).
 * One taken over in Terminal (step 5) is `handed_off`: Terminal can be opened on it again.
 * One a budget ended (#451) offers `resume` with `budget: true`: Resume with more budget….
 * @returns {{state: 'starting'|'running'|'stopping'|'lost'|'parked'|'ended'|'failed'|'handed_off', text: string, actions: string[], budget?: true}}
 */
export function launchStatus(launch, activity, nowMs) {
  if (launch.status === 'ended' && (launch.end_detail || launch.end_reason === 'error:start')) {
    return { state: 'failed', text: `Didn’t start${launch.end_detail ? `: ${launch.end_detail}` : '.'}`, actions: ['transcript'] }
  }
  if (launch.status === 'ended' && launch.end_reason === 'handed_off') {
    return { state: 'handed_off', text: END_REASONS.handed_off, actions: ['terminal', 'transcript'] }
  }
  if (stoppedWithSession(launch)) {
    return { state: 'ended', text: 'Stopped: its session is kept, so it can be resumed.', actions: ['resume', 'takeover', 'transcript'] }
  }
  if (budgetEnded(launch)) {
    return { state: 'ended', text: `${END_REASONS[launch.end_reason]}. Its session is kept: add budget to resume it.`, actions: ['resume', 'transcript'], budget: true }
  }
  if (launch.status === 'ended') {
    return { state: 'ended', text: END_REASONS[launch.end_reason] ?? `Ended (${launch.end_reason ?? 'unknown'})`, actions: ['transcript'] }
  }
  if (launch.status === 'parked') {
    const why = launch.park_reason ? ` ${launch.park_reason}` : ''
    return {
      state: 'parked',
      text: `Parked: idle, its session kept.${why}`,
      actions: ['resume', ...(launch.resumable ? ['takeover'] : []), 'stop', 'transcript'],
    }
  }
  if (launch.stop_requested_at) return { state: 'stopping', text: 'Stopping…', actions: ['transcript'] }
  if (launchSessions(launch, activity).length) return { state: 'running', text: 'Running', actions: ['stop', 'park', 'takeover', 'transcript'] }
  const since = Date.parse(launch.updated_at ?? launch.created_at)
  if (Number.isFinite(since) && nowMs - since > LOST_AFTER_MS) {
    return { state: 'lost', text: 'Not responding: its driver may have stopped.', actions: ['close', 'stop', 'transcript'] }
  }
  return { state: 'starting', text: 'Starting…', actions: ['stop', 'transcript'] }
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
      case 'budget_raised':
        flush()
        lines.push({ kind: 'note', text: `You added budget: ${minutes(event.to?.activeMs)} of active time and ${event.to?.toolCalls ?? '?'} tool calls in all.` })
        break
      case 'handoff_requested':
        flush()
        lines.push({ kind: 'note', text: 'You took it over: Agent Inbox stopped driving it.' })
        break
      case 'effort_fallback':
        flush()
        lines.push({ kind: 'note', text: 'This model takes no reasoning effort, so Agent Inbox started it with none.' })
        break
      case 'ended':
        flush()
        // the first Copilot of an effort fallback: the session goes on with the second
        if (event.retry === 'effort') break
        lines.push({
          kind: 'note',
          text: event.reason === 'idle' || event.reason === 'park' ? 'Parked: Copilot stopped, its session kept to resume.'
            : event.reason === 'handed_off' ? 'Handed off to a terminal: copilot --resume goes on with it there.'
              : `Session ended (${event.reason ?? 'unknown'}).`,
        })
        break
      default:
        break
    }
  }
  flush()
  return lines
}
