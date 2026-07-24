export interface StarOption {
  label: string
  detail?: string
  recommended?: boolean
}

export interface StarItem {
  options?: StarOption[] | null
  reply_seen_at?: string | null
}

export interface StagedSend<P> {
  /** schedule send(payload) after delayMs, replacing any pending payload for key */
  stage(key: string, payload: P): void
  /** cancel a still-pending send; false when it already fired or was never staged */
  undo(key: string): boolean
  /** send every pending payload now (tab blur/close) */
  flush(): void
  pending(key: string): boolean
}

export function starOption(item: StarItem): StarOption | null
export function createStagedSend<P>(opts: {
  delayMs: number
  setTimeoutFn: (fn: () => void, ms: number) => number
  clearTimeoutFn: (handle: number) => void
  send: (payload: P) => void
}): StagedSend<P>
export function canUndo(item: StarItem): boolean
