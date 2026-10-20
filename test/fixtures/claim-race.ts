// A second OS process for test/issue-claims.test.ts: claims one key at a time
// from the same queue as its sibling until nothing is left, then prints the
// numbers it won. argv: <db path> <owner> <queue JSON> <start ms>. Both
// processes spin until the same start time, so their claims interleave.
import { claimIssueRefresh, openDb } from '../../src/store.js'

const [path, owner, queueJson, startMs] = process.argv.slice(2)
const db = openDb(path)
const queue = JSON.parse(queueJson ?? '[]') as Array<{ repo: string; number: number; checked_at: string | null }>
const won: number[] = []
while (Date.now() < Number(startMs ?? 0)) { /* spin to the shared start */ }
for (;;) {
  const claimed = claimIssueRefresh(db, { owner: owner ?? 'x', queue, limit: 1, leaseMs: 3_600_000, nowMs: Date.now() })
  if (claimed.length === 0) break
  for (const k of claimed) won.push(k.number)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1) // let the sibling in
}
db.close()
process.stdout.write(JSON.stringify(won))
