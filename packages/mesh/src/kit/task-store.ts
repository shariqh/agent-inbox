// The owner-scoped task store (web search design §3.2): a task belongs to the token that created
// it, so one caller's GetTask and CancelTask never reach another's; only the last 64 finished
// tasks are kept (the SDK's InMemoryTaskStore cannot evict), and none keeps `history` (the
// request and every status message), so the executor reads the request's own message and
// continuations have nothing to continue.
import { TaskState } from '@a2a-js/sdk'
import type { ListTasksResponse, Task } from '@a2a-js/sdk'
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server'

const KEEP = 64
const TERMINAL = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED])

export class OwnedTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>()
  private key = (id: string, context: ServerCallContext): string => `${context.user?.userName ?? ''}\n${id}`
  async load(id: string, context: ServerCallContext): Promise<Task | undefined> {
    const task = this.tasks.get(this.key(id, context))
    return task && structuredClone(task)
  }
  async save(task: Task, context: ServerCallContext): Promise<void> {
    const key = this.key(task.id, context)
    this.tasks.delete(key)
    this.tasks.set(key, structuredClone({ ...task, history: [] }))
    const done = [...this.tasks].filter(([, t]) => t.status && TERMINAL.has(t.status.state))
    for (const [old] of done.slice(0, Math.max(0, done.length - KEEP))) this.tasks.delete(old)
  }
  async list(): Promise<ListTasksResponse> {
    return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 }
  }
}
