import type { SnapshotResponse } from './snapshots.js'

/**
 * One read of the active plans list: `/api/boards/tags`, then `/api/boards/plans?ids=` for the
 * plans not held at their tag (at most 10 ids a request), assembled into the frozen array
 * `/api/boards` would send. Headers and status are the tags read's. An unchanged list resolves to
 * the same array as the last read; an unchanged plan keeps its object. A 404 on the tags falls
 * back to `/api/boards` for that read.
 */
export function createPlansReader(
  readSnapshot: (url: string) => Promise<SnapshotResponse>,
): () => Promise<SnapshotResponse>
