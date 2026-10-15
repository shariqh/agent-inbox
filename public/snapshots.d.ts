export interface SnapshotResponse {
  headers: Headers
  status: number
  /** Deeply frozen authoritative JSON; derive mutable projections separately. */
  json(): Promise<unknown>
}

export function createSnapshotReader(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
): (url: string) => Promise<SnapshotResponse>
