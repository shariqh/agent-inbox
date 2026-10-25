// test/snapshot-probe.ts — reading the viewer's conditional snapshots the way
// its poll does, and telling a body rebuilt for a read from one served as it
// was published (issue #297). Deliberately NOT named *.test.ts: it is
// imported, never collected.
import { expect, vi } from 'vitest'
import type { SNAPSHOT_SOURCES } from '../src/viewer.js'

export type SnapshotName = keyof typeof SNAPSHOT_SOURCES

interface Viewer {
  request(input: string, init?: RequestInit): Response | Promise<Response>
}

// The route that serves each snapshot. Typed against the mapping, so a new
// snapshot cannot be registered without a route here.
export const SNAPSHOT_ROUTES = {
  items: '/api/items',
  'attention-items': '/api/items?scope=attention',
  'history-items': '/api/items/history',
  boards: '/api/boards',
  'attention-boards': '/api/boards?scope=attention',
  'archived-boards': '/api/boards/archived',
  'archived-summary': '/api/boards/archived/summary',
  links: '/api/links',
  issues: '/api/issues',
} as const satisfies Record<SnapshotName, string>

export const SNAPSHOT_NAMES = Object.keys(SNAPSHOT_ROUTES) as SnapshotName[]

// One conditional read, and whether it rebuilt its body: a rebuild serializes
// it, while a published body is served without serializing anything.
export async function probe(app: Viewer, name: SnapshotName, etag: string) {
  const stringify = vi.spyOn(JSON, 'stringify')
  try {
    const response = await app.request(SNAPSHOT_ROUTES[name], { headers: { 'If-None-Match': etag } })
    const rebuilt = stringify.mock.calls.length > 0
    return { rebuilt, status: response.status, etag: response.headers.get('etag'), text: await response.text() }
  } finally {
    stringify.mockRestore()
  }
}

// Every snapshot read once and then revalidated: a 304 that serialized nothing
// proves each body was published under its token.
export async function warm(app: Viewer): Promise<Record<SnapshotName, string>> {
  const tags = {} as Record<SnapshotName, string>
  for (const name of SNAPSHOT_NAMES) {
    const response = await app.request(SNAPSHOT_ROUTES[name])
    expect(response.status, name).toBe(200)
    tags[name] = response.headers.get('etag')!
    await response.text()
    expect((await probe(app, name, tags[name])).rebuilt, `${name} was not published`).toBe(false)
  }
  return tags
}

// The snapshots a write rebuilds, in SNAPSHOT_NAMES order. A write that returns
// false was refused, which would prove nothing, so it fails here.
export async function rebuiltBy(app: Viewer, write: () => unknown): Promise<SnapshotName[]> {
  const tags = await warm(app)
  expect(write()).not.toBe(false)
  const rebuilt: SnapshotName[] = []
  for (const name of SNAPSHOT_NAMES) {
    const read = await probe(app, name, tags[name])
    if (read.rebuilt) rebuilt.push(name)
    // a 304 carries the body's own tag, a 200 a new one
    expect(read.status === 304, name).toBe(read.etag === tags[name])
  }
  return rebuilt
}
