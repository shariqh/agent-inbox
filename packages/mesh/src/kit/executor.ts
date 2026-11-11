// The executor every kit agent hands the SDK (web search design §3.2, §4): one `Run` per task,
// whose states are WORKING status messages and whose result is one artifact published only with
// COMPLETED, so nothing unchecked is ever streamed. It **never rejects**: the SDK would
// `console.error` the error and put its message in the FAILED status it returns, so a run that
// throws ends the task FAILED "internal" here instead. `log` gets one entry per task with fixed
// names, counts and timings only, never the input.
import { randomUUID } from 'node:crypto'
import { Role, TaskState } from '@a2a-js/sdk'
import type { Part } from '@a2a-js/sdk'
import { AgentEvent } from '@a2a-js/sdk/server'
import type { AgentExecutor, ExecutionEventBus } from '@a2a-js/sdk/server'

type Json = Record<string, unknown>
/** `log` holds fixed names, counts and timings only; the executor adds it to the task's log entry. A completed result without `data` has a text part alone. */
export type RunResult = ({ state: 'completed'; text: string; data?: Json } | { state: 'rejected' | 'failed'; reason: string; data?: Json }) & { log?: Json }
/** `options` is the request's metadata under the agent's extension, already checked by the front door's schema. */
export type Run = (input: string, options: Json, signal: AbortSignal, onState: (state: string) => void) => Promise<RunResult>
export type Executor = AgentExecutor & { open(): number; failAll(reason: string): void }
export type ExecutorOptions = {
  /** The artifact's name: usually the skill id. */
  artifact: string
  /** The extension URI the front door hands metadata under. */
  extension?: string
  /** Extra fixed fields for the log entry, from the checked options (never the input). */
  logFields?: (options: Json) => Json
}

const part = (value: string | Json): Part => typeof value === 'string'
  ? { content: { $case: 'text', value }, mediaType: 'text/plain', filename: '', metadata: undefined }
  : { content: { $case: 'data', value }, mediaType: 'application/json', filename: '', metadata: undefined }

export function createExecutor(run: Run, log: (entry: Json) => void, o: ExecutorOptions): Executor {
  const open = new Map<string, { bus: ExecutionEventBus; contextId: string; abort: AbortController; outcome?: string }>()
  const status = (bus: ExecutionEventBus, taskId: string, contextId: string, state: TaskState, parts?: Part[]): void => bus.publish(AgentEvent.statusUpdate({
    taskId, contextId, metadata: undefined,
    status: { state, timestamp: new Date().toISOString(), message: parts && { messageId: randomUUID(), taskId, contextId, role: Role.ROLE_AGENT, parts, metadata: undefined, extensions: [], referenceTaskIds: [] } },
  }))
  /** Ends a task that is still open with a fixed reason; the one place a non-completed terminal state is published. */
  const end = (id: string, state: TaskState, outcome: string, reason: string, data?: Json): void => {
    const t = open.get(id)
    if (!t) return
    open.delete(id)
    t.outcome = `${outcome}:${reason}`
    t.abort.abort()
    const code = state === TaskState.TASK_STATE_REJECTED ? 11 : 13
    status(t.bus, id, t.contextId, state, state === TaskState.TASK_STATE_CANCELED ? [part('cancelled')] : [part(`${outcome}: ${reason}`), part(data ?? { code, status: outcome, reason })])
  }
  return {
    open: () => open.size,
    failAll: (reason) => { for (const id of [...open.keys()]) end(id, TaskState.TASK_STATE_FAILED, 'failed', reason) },
    cancelTask: async (id) => end(id, TaskState.TASK_STATE_CANCELED, 'cancelled', 'cancelled'),
    execute: async (ctx, bus) => {
      const { taskId: id, contextId } = ctx
      const t = { bus, contextId, abort: new AbortController(), outcome: 'failed:internal' }
      open.set(id, t)
      const started = Date.now()
      const content = ctx.userMessage.parts[0]?.content
      const input = content?.$case === 'text' ? content.value : ''
      const options = ((o.extension && ctx.userMessage.metadata?.[o.extension]) ?? {}) as Json
      let extra: Json | undefined
      try {
        bus.publish(AgentEvent.task({ id, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() }, artifacts: [], history: [], metadata: undefined }))
        const r = await run(input, options, t.abort.signal, (state) => { if (open.has(id)) status(bus, id, contextId, TaskState.TASK_STATE_WORKING, [part(state)]) })
        extra = r.log
        if (!open.has(id)) return
        if (r.state !== 'completed') return end(id, r.state === 'rejected' ? TaskState.TASK_STATE_REJECTED : TaskState.TASK_STATE_FAILED, r.state, r.reason, r.data)
        open.delete(id)
        t.outcome = 'completed'
        bus.publish(AgentEvent.artifactUpdate({ taskId: id, contextId, artifact: { artifactId: randomUUID(), name: o.artifact, description: '', parts: [part(r.text), ...(r.data ? [part(r.data)] : [])], metadata: undefined, extensions: [] }, append: false, lastChunk: true, metadata: undefined }))
        status(bus, id, contextId, TaskState.TASK_STATE_COMPLETED)
      } catch {
        try {
          end(id, TaskState.TASK_STATE_FAILED, 'failed', 'internal')
        } catch {}
      } finally {
        try {
          log({ taskId: id, chars: input.length, words: input.split(/\s+/).filter(Boolean).length, ...o.logFields?.(options), outcome: t.outcome, ms: Date.now() - started, ...(extra ? { run: extra } : {}) })
        } catch {}
      }
    },
  }
}
