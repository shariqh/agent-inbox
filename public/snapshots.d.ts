export interface SnapshotResponse {
  headers: Headers
  status: number
  /** Deeply frozen authoritative JSON; derive mutable projections separately. */
  json(): Promise<unknown>
}

export function createSnapshotReader(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
): (url: string) => Promise<SnapshotResponse>

/** The poll's 30-day activity-history URL, its start floored to the hour. */
export function activityHistoryUrl(nowMs: number): string
