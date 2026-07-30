export interface ResponseTarget {
  key: string
  version: string
  source: 'item' | 'row'
  id: string
  focusId: string
  session: string | null
  project: string
  stream: string
  agent: string
  title: string
  label: string | null
  response: string | null
  responseContext: string | null
  humanMarkedDone: boolean
  actedAt: string
  actedAtMs: number
}

export interface WakeAdapter {
  command: string
  args: string[]
}

export interface ResponseScan {
  newTargets: ResponseTarget[]
  reminders: ResponseTarget[]
}

export function responseTargets(grouped: unknown, boards: unknown[]): ResponseTarget[]

export function createResponseWatch(options?: {
  initialDelayMs?: number
  repeatMs?: number
}): {
  scan(grouped: unknown, boards: unknown[], now?: number): ResponseScan
}

export function wakeAdapterFromEnv(
  env: Record<string, string | undefined>,
  logger?: { error(message: string): void },
): WakeAdapter | null

export function runWakeAdapter(
  adapter: WakeAdapter,
  payload: unknown,
  options?: {
    spawnImpl?: (...args: any[]) => any
    timeoutMs?: number
  },
): Promise<void>

export function formatResponseReminder(targets: ResponseTarget[]): {
  title: string
  body: string
}

export function wakeAdapterPayload(targets: ResponseTarget[]): {
  event: 'agent-inbox.response.waiting'
  targets: Array<Omit<ResponseTarget, 'version' | 'actedAtMs'>>
}
