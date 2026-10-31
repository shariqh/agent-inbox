/** One message as GET /api/messages serves it (src/store.ts SessionMessage). */
export interface SessionMessage {
  id: string
  session: string
  project: string
  stream: string
  agent: string
  text: string
  created_at: string
  revision: number
  status: 'open' | 'acknowledged' | 'withdrawn' | string
  delivered_at: string | null
  delivered_by: string | null
  outcome: string
  closed_at: string | null
}

export interface MessagesSnapshot {
  open: SessionMessage[]
  closed: SessionMessage[]
}

export type DeliveryStateName = 'now' | 'next-check' | 'cannot' | 'gone'

export const MESSAGE_MAX_TEXT: number
export const MESSAGE_SHARED: string
export const MESSAGE_UNCONFIRMED: string
export function deliveryState(row: unknown, options?: { driven?: boolean }): { state: DeliveryStateName; text: string; canSend: boolean }
export function composerLabel(session: { agent?: string; project?: string; stream?: string }): string
export function messageStatus(message: SessionMessage, ago: (iso: string | null) => string): {
  tone: string
  text: string
  outcome: string | null
  withdrawable: boolean
}
export function sessionMessages(snapshot: MessagesSnapshot | null | undefined, session: string): { shown: SessionMessage[]; earlier: SessionMessage[] }
export function snapshotHolds(snapshot: MessagesSnapshot | null | undefined, id: string): boolean
export function undeliveredMessages(snapshot: MessagesSnapshot | null | undefined, activity: Array<{ session?: string } | null> | null | undefined): {
  total: number
  shown: SessionMessage[]
  more: SessionMessage[]
}
export function undeliveredReason(message: SessionMessage): string
export function refusalText(result: unknown, action?: 'send' | 'withdraw'): string
