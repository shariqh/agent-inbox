const { spawn } = require('node:child_process')
const path = require('node:path')

const DEFAULT_INITIAL_DELAY_MS = 60_000
const DEFAULT_REPEAT_MS = 15 * 60_000
const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000
const DEFAULT_NOTIFICATION_RETENTION_MS = 24 * 60 * 60_000

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function latestTimestamp(...values) {
  const valid = values
    .filter(nonEmpty)
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => b.time - a.time)
  return valid[0] ?? { value: new Date(0).toISOString(), time: 0 }
}

function createNotificationRetainer(options = {}) {
  const held = options.held ?? new Set()
  const retentionMs = options.retentionMs ?? DEFAULT_NOTIFICATION_RETENTION_MS
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout

  return {
    show(notification) {
      held.add(notification)
      let timer
      const release = () => {
        held.delete(notification)
        if (timer) clearTimeoutImpl(timer)
        timer = null
      }
      for (const event of ['action', 'click', 'close', 'reply']) {
        notification.once(event, release)
      }
      timer = setTimeoutImpl(release, retentionMs)
      timer.unref?.()
      notification.show()
    },
  }
}

function cannedResponseActions(options) {
  const responses = (options ?? [])
    .map((option) => option?.label)
    .filter(nonEmpty)
  return {
    actions: responses.map((text) => ({ type: 'button', text })),
    responses,
  }
}

function responseForNotificationAction(responses, details, legacyActionIndex) {
  const actionIndex = Number.isInteger(details?.actionIndex)
    ? details.actionIndex
    : legacyActionIndex
  return Number.isInteger(actionIndex) ? responses[actionIndex] ?? null : null
}

async function submitCannedResponse(urlBase, itemId, text, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${urlBase}api/items/${encodeURIComponent(itemId)}/reply`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    },
  )
  if (!response.ok) {
    throw new Error(`notification reply failed with HTTP ${response.status}`)
  }
  const result = await response.json()
  if (!result?.ok) {
    throw new Error('notification reply was refused')
  }
}

function responseTargets(grouped, boards) {
  const targets = []
  for (const group of grouped?.needsYou ?? []) {
    for (const item of group.items ?? []) {
      if (!nonEmpty(item.reply) || item.reply_seen_at !== null) continue
      const acted = latestTimestamp(item.replied_at)
      targets.push({
        key: `item:${item.id}`,
        version: `${item.replied_at ?? ''}\0${item.reply}\0${item.reply_context ?? ''}`,
        source: 'item',
        id: item.id,
        focusId: item.id,
        session: item.session ?? null,
        project: item.project,
        stream: item.stream,
        agent: item.agent,
        title: item.title,
        label: null,
        response: item.reply,
        responseContext: item.reply_context ?? null,
        humanMarkedDone: false,
        actedAt: acted.value,
        actedAtMs: acted.time,
      })
    }
  }

  for (const board of boards ?? []) {
    for (const row of board.rows ?? []) {
      const hasWords = nonEmpty(row.annotation)
      const humanMarkedDone = nonEmpty(row.handled_at)
      if (row.status !== 'blocked' || (!hasWords && !humanMarkedDone)) continue
      const acted = latestTimestamp(row.annotated_at, row.handled_at)
      targets.push({
        key: `row:${row.id}`,
        version: `${row.annotated_at ?? ''}\0${row.annotation ?? ''}\0${row.handled_at ?? ''}`,
        source: 'row',
        id: row.id,
        focusId: board.id,
        session: null,
        project: board.project,
        stream: board.stream,
        agent: board.agent,
        title: board.title,
        label: row.label,
        response: hasWords ? row.annotation : null,
        responseContext: null,
        humanMarkedDone,
        actedAt: acted.value,
        actedAtMs: acted.time,
      })
    }
  }
  return targets
}

function createResponseWatch(options = {}) {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const repeatMs = options.repeatMs ?? DEFAULT_REPEAT_MS
  const state = new Map()

  return {
    scan(grouped, boards, now = Date.now()) {
      const targets = responseTargets(grouped, boards)
      const current = new Set(targets.map((target) => target.key))
      const newTargets = []
      const reminders = []

      for (const target of targets) {
        const previous = state.get(target.key)
        const isNew = previous?.version !== target.version
        let lastReminderAt = isNew ? null : previous.lastReminderAt
        if (isNew) newTargets.push(target)
        if (
          now - target.actedAtMs >= initialDelayMs
          && (lastReminderAt === null || now - lastReminderAt >= repeatMs)
        ) {
          reminders.push(target)
          lastReminderAt = now
        }
        state.set(target.key, { version: target.version, lastReminderAt })
      }

      for (const key of state.keys()) {
        if (!current.has(key)) state.delete(key)
      }
      return { newTargets, reminders }
    },
  }
}

function wakeAdapterFromEnv(env, logger = console) {
  const command = env.AGENT_INBOX_WAKE_COMMAND?.trim()
  if (!command) return null
  if (!path.isAbsolute(command)) {
    logger.error('[agent-inbox] AGENT_INBOX_WAKE_COMMAND must be an absolute executable path; adapter disabled')
    return null
  }

  let args = []
  if (nonEmpty(env.AGENT_INBOX_WAKE_ARGS)) {
    try {
      args = JSON.parse(env.AGENT_INBOX_WAKE_ARGS)
    } catch (error) {
      logger.error(`[agent-inbox] AGENT_INBOX_WAKE_ARGS must be a JSON string array; adapter disabled (${error.message})`)
      return null
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      logger.error('[agent-inbox] AGENT_INBOX_WAKE_ARGS must be a JSON string array; adapter disabled')
      return null
    }
  }
  return { command, args }
}

function runWakeAdapter(adapter, payload, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawnImpl(adapter.command, adapter.args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let settled = false
    let stderr = ''
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`wake adapter timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()

    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length)
    })
    child.on('error', finish)
    child.on('exit', (code, signal) => {
      if (code === 0) finish()
      else finish(new Error(`wake adapter exited ${code ?? signal ?? 'without a status'}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
    child.stdin?.on?.('error', finish)
    child.stdin.end(`${JSON.stringify(payload)}\n`)
  })
}

function formatResponseReminder(targets) {
  const summaries = targets.slice(0, 3).map((target) => (
    target.source === 'row'
      ? `${target.project} · ${target.title} · ${target.label}`
      : `${target.project} · ${target.title}`
  ))
  return {
    title: targets.length === 1
      ? 'Agent Inbox — waiting for agent'
      : `Agent Inbox — ${targets.length} waiting for agent`,
    body: summaries.join('\n'),
  }
}

function wakeAdapterPayload(targets) {
  return {
    event: 'agent-inbox.response.waiting',
    targets: targets.map(({ version, actedAtMs, ...target }) => target),
  }
}

module.exports = {
  cannedResponseActions,
  createNotificationRetainer,
  createResponseWatch,
  formatResponseReminder,
  responseTargets,
  responseForNotificationAction,
  runWakeAdapter,
  submitCannedResponse,
  wakeAdapterPayload,
  wakeAdapterFromEnv,
}
