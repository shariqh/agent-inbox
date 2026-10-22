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
  responseKind: 'answer' | 'clarify' | 'decline' | null
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

export interface CannedResponseActions {
  actions: Array<{ type: 'button'; text: string }>
  responses: string[]
}

export type NotificationResponseTarget =
  | { source: 'item'; id: string }
  | { source: 'row'; boardId: string; rowId: string; revision: number; boardRevision: number }

export interface RetainableNotification {
  once(event: string, listener: (...args: unknown[]) => void): this
  show(): void
}

export function createNotificationRetainer(options?: {
  held?: Set<unknown>
  retentionMs?: number
  setTimeoutImpl?: (callback: () => void, delay: number) => {
    unref?(): void
  }
  clearTimeoutImpl?: (timer: unknown) => void
}): {
  show(notification: RetainableNotification): void
}

export function cannedResponseActions(
  options: Array<{
    label?: string
    detail?: string
    recommended?: boolean
  } | null> | null | undefined,
): CannedResponseActions

export function responseForNotificationAction(
  responses: string[],
  details: { actionIndex?: number } | null | undefined,
  legacyActionIndex?: number,
): string | null

export function submitCannedResponse(
  urlBase: string,
  itemId: string,
  text: string,
  fetchImpl?: (
    url: string,
    init: RequestInit,
  ) => Promise<{
    ok: boolean
    status: number
    json(): Promise<{ ok?: boolean }>
  }>,
): Promise<void>

export function submitNotificationResponse(
  urlBase: string,
  target: NotificationResponseTarget,
  text: string,
  fetchImpl?: (
    url: string,
    init: RequestInit,
  ) => Promise<{
    ok: boolean
    status: number
    json(): Promise<{ ok?: boolean }>
  }>,
): Promise<void>

export function refreshNotificationTarget(
  boards: unknown[],
  target: NotificationResponseTarget,
): NotificationResponseTarget | null

export interface AttentionNotification {
  id: string
  itemId: string
  text: string
  /** The question item or board row; its options become the native buttons. */
  item: unknown
  target: NotificationResponseTarget
}

export function attentionNotification(
  entry:
    | { kind: 'item'; item: { id: string; title?: string } }
    | {
        kind: 'row'
        row: { id: string; label?: string; revision?: number }
        board: { id: string; title?: string; revision?: number }
      },
): AttentionNotification

export function freshAttentionNotifications(
  known: ReadonlySet<string> | null,
  notifications: AttentionNotification[],
): AttentionNotification[]

type NotifiableEntry = Parameters<typeof attentionNotification>[0]

/** Issue #247 — the ids already announced: attention plus the asks pinned for later. */
export function knownNotificationIds(
  attention: NotifiableEntry[],
  later: Array<NotifiableEntry & { later: 'snoozed' | 'pinned' }> | null | undefined,
): Set<string>

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
