import type { Connection } from './remote-connect.cjs'

export interface WatchNotification {
  on(event: string, listener: (...args: never[]) => unknown): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
  show(): void
}

export interface WatchNotificationClass {
  new (options: { title: string; body: string; actions?: Array<{ type: 'button'; text: string }> }): WatchNotification
  isSupported(): boolean
}

export interface AttentionMods {
  attentionEntries: (...args: never[]) => unknown[]
  laterEntries: (...args: never[]) => unknown[]
  focusHashFor: (id: string) => string
  optionOrder: (options: never) => unknown[]
}

export type WatchFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface AttentionWatchOptions {
  /** The source's origin with a trailing slash: paths are joined to it with no slash. */
  base: string
  /** Every request of this source goes through it (the conditional reader included). */
  fetchImpl?: WatchFetch
  /** null for This Mac; for a hub, its stored label, or a function read at each notification. */
  label?: string | (() => string) | null
  /** Bring this source's view forward and land on the hash. */
  show: (hash: string | null) => void
  mods: Promise<AttentionMods>
  Notification: WatchNotificationClass
  retainer: { show(notification: WatchNotification): void }
  /** This source's visible attention count after each successful poll. */
  onCount?: (count: number) => void
  /** This Mac only: never called for a hub. */
  wake?: ((due: unknown[]) => Promise<unknown>) | null
  now?: () => number
  logger?: { log(...args: unknown[]): void; error(...args: unknown[]): void }
}

export interface AttentionWatch {
  /** One pass; never rejects; a call during a pass gets that pass. */
  poll(): Promise<void>
  /** Drops the source: a pass in flight announces and counts nothing. */
  stop(): void
}

export function createAttentionWatch(options: AttentionWatchOptions): AttentionWatch
export function sourceTitle(label: string | null, title: string): string
export function hubLive(connection: Connection | null, id: string | null | undefined, canShow: boolean): boolean
export function badgeTotal(input: {
  local: number
  hubs?: Array<{ id: string; count: number } | null>
  connection?: Connection | null
  canShow?: boolean
}): number

export const LOST_HUB_AFTER_MS: number
export function lostHubText(connection: Connection | null): { title: string; body: string }

export interface LostHubNotice {
  update(connection: Connection | null): void
  awake(): void
  stop(): void
}

export function createLostHubNotice(options: {
  Notification: WatchNotificationClass
  retainer: { show(notification: WatchNotification): void }
  show: (id: string) => void
  isOnline?: () => boolean
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  delayMs?: number
  logger?: { error(...args: unknown[]): void }
}): LostHubNotice
